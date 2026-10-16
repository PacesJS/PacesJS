import { createInterface } from 'node:readline';
import type { AgentSummary } from './engine.js';
import { findingsOf } from './summary.js';

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'summary',
    description:
      'The full agent summary of this paces profile: findings with evidence and the numbers behind them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'findings',
    description:
      'Only the findings of this paces profile, most important first. Optionally filter by severity.',
    inputSchema: {
      type: 'object',
      properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] } },
      additionalProperties: false,
    },
  },
];

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Handles one JSON-RPC message; returns the reply, or undefined for notifications. */
export function handleMcpMessage(msg: Rpc, summary: () => AgentSummary): object | undefined {
  const reply = (result: unknown): object => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const error = (code: number, message: string): object => ({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code, message },
  });
  if (msg.id === undefined) return undefined; // notification
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion:
          typeof asked === 'string' && SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'paces', version: '0.0.0' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as { severity?: string };
      try {
        if (name === 'summary') return reply(text(summary()));
        if (name === 'findings') {
          const all = findingsOf(summary());
          return reply(text(args.severity ? all.filter((f) => f.severity === args.severity) : all));
        }
      } catch (e) {
        return reply({
          isError: true,
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        });
      }
      return error(-32602, `Unknown tool: ${String(name)}`);
    }
    default:
      return error(-32601, `Method not found: ${String(msg.method)}`);
  }
}

/** MCP over stdio: newline-delimited JSON-RPC. stdout carries protocol only; logs go to stderr. */
export function serveMcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  summary: () => AgentSummary,
): Promise<void> {
  const rl = createInterface({ input });
  const write = (m: object): void => {
    output.write(`${JSON.stringify(m)}\n`);
  };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const out = handleMcpMessage(msg, summary);
    if (out) write(out);
  });
  return new Promise((resolve) => rl.once('close', resolve));
}
