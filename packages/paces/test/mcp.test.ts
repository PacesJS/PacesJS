import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { analyze, buildAgentSummary } from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import { handleMcpMessage, serveMcp } from '../src/mcp.js';
import { buildTools } from '../src/mcp-tools.js';

function load(name: string): ExecutionModel {
  const url = new URL(`../../engine/test/fixtures/${name}.capture.json.gz`, import.meta.url);
  return analyze(JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as RawCapture);
}

function connect(model: ExecutionModel): { client: Client; done: Promise<void> } {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const done = serveMcp(
    toServer,
    fromServer,
    buildTools(model, () => buildAgentSummary(model)),
  );
  const transport: Transport = {
    start: async () => {
      createInterface({ input: fromServer }).on('line', (line) => {
        transport.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      });
    },
    send: async (m) => {
      toServer.write(`${JSON.stringify(m)}\n`);
    },
    close: async () => {
      toServer.end();
    },
  };
  const client = new Client({ name: 'test', version: '0.0.0' });
  void client.connect(transport);
  return { client, done };
}

interface Ref {
  name: string;
  package: string;
  file: string;
  line: number;
  origin: string;
  selfMs: number;
  totalMs: number;
  share: number;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return {
    isError: Boolean(r.isError),
    data: (r.isError ? null : JSON.parse(r.content[0]?.text ?? 'null')) as unknown,
    raw: r.content[0]?.text ?? '',
  };
}

describe('handleMcpMessage', () => {
  it('ignores notifications and reports unknown methods as -32601', async () => {
    expect(
      await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, []),
    ).toBeUndefined();
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'nope' }, [])).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('turns a throwing tool into a tool error instead of crashing', async () => {
    const tool = {
      name: 't',
      description: '',
      inputSchema: {},
      run: () => {
        throw new Error('bad input');
      },
    };
    expect(
      await handleMcpMessage(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } },
        [tool],
      ),
    ).toMatchObject({ result: { isError: true } });
  });

  it('waits for a tool that returns a promise, and turns its rejection into a tool error', async () => {
    const ok = {
      name: 'ok',
      description: '',
      inputSchema: {},
      run: () => Promise.resolve({ a: 1 }),
    };
    const bad = {
      name: 'bad',
      description: '',
      inputSchema: {},
      run: () => Promise.reject(new Error('nope')),
    };
    const call = (name: string) =>
      handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }, [
        ok,
        bad,
      ]);
    expect(await call('ok')).toMatchObject({
      result: { content: [{ text: JSON.stringify({ a: 1 }, null, 2) }] },
    });
    expect(await call('bad')).toMatchObject({
      result: { isError: true, content: [{ text: 'nope' }] },
    });
  });

  it('lists the annotations of a tool, and reports the version it is given', async () => {
    const tool = {
      name: 't',
      description: 'd',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      run: () => 1,
    };
    expect(
      await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, [tool]),
    ).toMatchObject({
      result: { tools: [{ name: 't', annotations: { readOnlyHint: true } }] },
    });
    expect(
      await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize' }, [], {
        version: '1.2.3',
      }),
    ).toMatchObject({ result: { serverInfo: { name: 'paces', version: '1.2.3' } } });
  });

  it('gives the tool its progress reporter only when the client asked for progress', async () => {
    const seen: unknown[] = [];
    const tool = {
      name: 't',
      description: '',
      inputSchema: {},
      run: (_args: Record<string, unknown>, ctx: { progress?: (m: string) => void }) => {
        ctx.progress?.('halfway');
        return 1;
      },
    };
    const send = (m: object) => void seen.push(m);
    const params = { name: 't', _meta: { progressToken: 'p1' } };
    await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, [tool], {
      send,
    });
    expect(seen).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'p1', progress: 1, message: 'halfway' },
      },
    ]);
    seen.length = 0;
    await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't' } },
      [tool],
      { send },
    );
    expect(seen).toEqual([]);
  });
});

describe('resources', () => {
  const guide = {
    uri: 'paces://guide',
    name: 'guide',
    title: 'How to use paces',
    description: 'd',
    mimeType: 'text/markdown',
    text: '# the guide',
  };

  it('are not advertised, listed or readable unless the server has some', async () => {
    const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, []);
    expect(init).toMatchObject({ result: { capabilities: { tools: {} } } });
    expect((init as { result: { capabilities: object } }).result.capabilities).not.toHaveProperty(
      'resources',
    );
    expect(
      await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, []),
    ).toMatchObject({
      result: { resources: [] },
    });
  });

  it('are advertised with the instructions the client may show the model', async () => {
    const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, [], {
      resources: [guide],
      instructions: 'read paces://guide first',
    });
    expect(init).toMatchObject({
      result: {
        capabilities: { tools: {}, resources: {} },
        instructions: 'read paces://guide first',
      },
    });
  });

  it('are listed without their text, and read by uri', async () => {
    const env = { resources: [guide] };
    const list = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'resources/list' },
      [],
      env,
    );
    expect(list).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resources: [
          {
            uri: 'paces://guide',
            name: 'guide',
            title: 'How to use paces',
            description: 'd',
            mimeType: 'text/markdown',
          },
        ],
      },
    });
    const read = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'paces://guide' } },
      [],
      env,
    );
    expect(read).toMatchObject({
      result: {
        contents: [{ uri: 'paces://guide', mimeType: 'text/markdown', text: '# the guide' }],
      },
    });
  });

  it('report an unknown uri as not found', async () => {
    const read = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'paces://nope' } },
      [],
      { resources: [guide] },
    );
    expect(read).toMatchObject({
      error: { code: -32002, message: expect.stringContaining('paces://nope') },
    });
  });
});

describe('serveMcp while a tool is running', () => {
  function pipes() {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Array<{ id?: number; result?: unknown }> = [];
    createInterface({ input: output }).on('line', (l) => lines.push(JSON.parse(l)));
    const send = (m: object) => void input.write(`${JSON.stringify(m)}\n`);
    return { input, output, lines, send };
  }

  it('answers other requests before a slow call finishes', async () => {
    const { input, output, lines, send } = pipes();
    let finish: (v: unknown) => void = () => undefined;
    const slow = {
      name: 'slow',
      description: '',
      inputSchema: {},
      run: () => new Promise((resolve) => (finish = resolve)),
    };
    const done = serveMcp(input, output, [slow]);
    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } });
    send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await vi.waitFor(() => expect(lines.map((l) => l.id)).toEqual([2]));
    finish('done');
    await vi.waitFor(() => expect(lines.map((l) => l.id)).toEqual([2, 1]));
    input.end();
    await done;
  });

  it('aborts the signal of a running tool when the client goes away, and waits for it to wind down', async () => {
    const { input, output, send } = pipes();
    let aborted = false;
    let windDown: () => void = () => undefined;
    const tool = {
      name: 'long',
      description: '',
      inputSchema: {},
      run: (_a: Record<string, unknown>, ctx: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            windDown = () => resolve('stopped');
          });
        }),
    };
    let closed = false;
    const done = serveMcp(input, output, [tool]).then(() => (closed = true));
    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'long' } });
    input.end();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(closed).toBe(false);
    windDown();
    await done;
    expect(closed).toBe(true);
  });
});

describe('mcp tools on a real session (orders-server)', () => {
  let model: ExecutionModel;
  let client: Client;
  let done: Promise<void>;
  beforeAll(async () => {
    model = load('orders-server');
    ({ client, done } = connect(model));
    await client.listTools();
  });

  it('lists the documented tools with input schemas', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'summary',
      'findings',
      'hot_paths',
      'top_functions',
      'package_breakdown',
      'callers',
      'phases',
    ]);
    expect(tools.every((t) => t.description && t.inputSchema.type === 'object')).toBe(true);
  });

  it('summary is the extended agent summary', async () => {
    const { data } = await call(client, 'summary');
    expect(data).toMatchObject({ schemaVersion: 2 });
    expect(data).toHaveProperty('target');
    expect(data).toHaveProperty('primaryTrack');
  });

  it('top_functions ranks by self time and every row carries the full reference', async () => {
    const { data } = await call(client, 'top_functions', { limit: 5 });
    const rows = data as Ref[];
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.selfMs)).toEqual([...rows.map((r) => r.selfMs)].sort((a, b) => b - a));
    expect(Object.keys(rows[0] as Ref).sort()).toEqual(
      ['file', 'line', 'name', 'origin', 'package', 'selfMs', 'share', 'totalMs'].sort(),
    );
  });

  it('top_functions filters by origin', async () => {
    const rows = (await call(client, 'top_functions', { origin: 'dependency', limit: 10 }))
      .data as Ref[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.origin === 'dependency')).toBe(true);
  });

  it('top_functions sorts by total when asked', async () => {
    const rows = (await call(client, 'top_functions', { sort: 'total', limit: 6 })).data as Ref[];
    expect(rows.map((r) => r.totalMs)).toEqual(
      [...rows.map((r) => r.totalMs)].sort((a, b) => b - a),
    );
  });

  it('hot_paths returns chains of fully described frames, limited as asked', async () => {
    const paths = (await call(client, 'hot_paths', { limit: 2 })).data as Array<{
      path: Ref[];
      totalMs: number;
      share: number;
    }>;
    expect(paths.length).toBeLessThanOrEqual(2);
    expect(paths[0]?.path.length).toBeGreaterThan(0);
    expect(paths[0]?.path[0]).toHaveProperty('file');
    expect(paths[0]?.share).toBeGreaterThan(0);
  });

  it('hot_paths with origin user keeps only user frames on the path', async () => {
    const paths = (await call(client, 'hot_paths', { origin: 'user' })).data as Array<{
      path: Ref[];
    }>;
    expect(paths.flatMap((p) => p.path).every((f) => f.origin === 'user')).toBe(true);
  });

  it('package_breakdown lists the hot functions of one package', async () => {
    const top = (await call(client, 'top_functions', { origin: 'dependency', limit: 1 }))
      .data as Ref[];
    const pkg = top[0]?.package as string;
    const rows = (await call(client, 'package_breakdown', { package: pkg })).data as Ref[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.package === pkg)).toBe(true);
  });

  it('callers walks up from a function and names the alternatives when the name is shared', async () => {
    const top = (await call(client, 'top_functions', { limit: 1 })).data as Ref[];
    const { data } = await call(client, 'callers', { function: top[0]?.name, depth: 3 });
    const result = data as { function: Ref; callers: unknown[]; alternatives: unknown[] };
    expect(result.function.name).toBe(top[0]?.name);
    expect(Array.isArray(result.callers)).toBe(true);
    expect(Array.isArray(result.alternatives)).toBe(true);
  });

  it('phases returns the time-ordered phases', async () => {
    const { data } = await call(client, 'phases');
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBeGreaterThan(0);
  });

  it.each([
    ['top_functions', { sort: 'sideways' }],
    ['top_functions', { limit: 0 }],
    ['hot_paths', { origin: 'martian' }],
    ['package_breakdown', {}],
    ['callers', { function: 'definitelyNotAFunction' }],
  ])('rejects bad input to %s with an explanation', async (name, args) => {
    const r = await call(client, name, args as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(r.raw.length).toBeGreaterThan(10);
  });

  it('closes cleanly', async () => {
    await client.close();
    await done;
  });
});

describe('the findings tool and fixes', () => {
  it('hands an agent the fix of a finding that has one', async () => {
    const model = load('deopt-loop');
    const tool = buildTools(model, () => buildAgentSummary(model)).find(
      (t) => t.name === 'findings',
    );
    const found = (await tool?.run({}, { signal: new AbortController().signal })) as Array<{
      kind: string;
      hint?: string;
    }>;
    expect(found.find((f) => f.kind === 'v8-deopt')?.hint).toContain(
      'same properties in the same order',
    );
  });
});
