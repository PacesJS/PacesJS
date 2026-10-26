import { createInterface } from 'node:readline';

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** What a tool run may use besides its arguments. */
export interface McpToolContext {
  /** Aborted when the client goes away; a tool that runs a long time stops what it started. */
  signal: AbortSignal;
  /** Set only when the client asked for progress on this call. */
  progress?: (message: string) => void;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hints clients use to decide whether to ask the user first. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Returns JSON-serializable data; throws an Error with an actionable message for bad input. */
  run(args: Record<string, unknown>, ctx: McpToolContext): unknown;
}

/** A document the client can read, such as the guide to the server. */
export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  text: string;
}

/** What the server knows about itself and its connection. */
export interface McpEnv {
  version?: string;
  /** Shown to the model by clients that support it, when the connection starts. */
  instructions?: string;
  resources?: McpResource[];
  signal?: AbortSignal;
  /** Writes a message that is not a reply, such as a progress notification. */
  send?: (message: object) => void;
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Handles one JSON-RPC message; resolves to the reply, or undefined for notifications. */
export async function handleMcpMessage(
  msg: Rpc,
  tools: McpTool[],
  env: McpEnv = {},
): Promise<object | undefined> {
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
        capabilities: { tools: {}, ...(env.resources?.length ? { resources: {} } : {}) },
        serverInfo: { name: 'paces', version: env.version ?? '0.0.0' },
        ...(env.instructions ? { instructions: env.instructions } : {}),
      });
    }
    case 'resources/list':
      return reply({
        resources: (env.resources ?? []).map(({ uri, name, title, description, mimeType }) => ({
          uri,
          name,
          title,
          description,
          mimeType,
        })),
      });
    case 'resources/read': {
      const uri = msg.params?.uri;
      const found = env.resources?.find((r) => r.uri === uri);
      if (!found) return error(-32002, `Resource not found: ${String(uri)}`);
      return reply({
        contents: [{ uri: found.uri, mimeType: found.mimeType, text: found.text }],
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${String(msg.params?.name)}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const meta = msg.params?._meta as { progressToken?: string | number } | undefined;
      const token = meta?.progressToken;
      let step = 0;
      const send = env.send;
      const ctx: McpToolContext = {
        signal: env.signal ?? new AbortController().signal,
        ...(token !== undefined && send
          ? {
              progress: (message: string) =>
                send({
                  jsonrpc: '2.0',
                  method: 'notifications/progress',
                  params: { progressToken: token, progress: ++step, message },
                }),
            }
          : {}),
      };
      try {
        return reply(text(await tool.run(args, ctx)));
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

/**
 * MCP over stdio: newline-delimited JSON-RPC. stdout carries protocol only; logs go to stderr.
 * Requests run side by side, so a long tool call does not hold up `ping` or the next request. When
 * the client closes the pipe the running tools are told to stop and the server waits for them.
 */
export function serveMcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  tools: McpTool[],
  options: { version?: string; instructions?: string; resources?: McpResource[] } = {},
): Promise<void> {
  const rl = createInterface({ input });
  const abort = new AbortController();
  const pending = new Set<Promise<void>>();
  const write = (m: object): void => {
    output.write(`${JSON.stringify(m)}\n`);
  };
  const env: McpEnv = {
    version: options.version,
    instructions: options.instructions,
    resources: options.resources,
    signal: abort.signal,
    send: write,
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
    const job = handleMcpMessage(msg, tools, env).then((out) => {
      if (out) write(out);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return new Promise((resolve) =>
    rl.once('close', () => {
      abort.abort();
      void Promise.allSettled([...pending]).then(() => resolve());
    }),
  );
}
