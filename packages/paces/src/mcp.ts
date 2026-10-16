import { createInterface } from 'node:readline';

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns JSON-serializable data; throws an Error with an actionable message for bad input. */
  run(args: Record<string, unknown>): unknown;
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Handles one JSON-RPC message; returns the reply, or undefined for notifications. */
export function handleMcpMessage(msg: Rpc, tools: McpTool[]): object | undefined {
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
      return reply({
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${String(msg.params?.name)}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(text(tool.run(args)));
      } catch (e) {
        return reply({
          isError: true,
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        });
      }
    }
    default:
      return error(-32601, `Method not found: ${String(msg.method)}`);
  }
}

/** MCP over stdio: newline-delimited JSON-RPC. stdout carries protocol only; logs go to stderr. */
export function serveMcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  tools: McpTool[],
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
    const out = handleMcpMessage(msg, tools);
    if (out) write(out);
  });
  return new Promise((resolve) => rl.once('close', resolve));
}
