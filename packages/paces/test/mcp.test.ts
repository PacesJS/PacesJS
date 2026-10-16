import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
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
  it('ignores notifications and reports unknown methods as -32601', () => {
    expect(
      handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, []),
    ).toBeUndefined();
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'nope' }, [])).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('turns a throwing tool into a tool error instead of crashing', () => {
    const tool = {
      name: 't',
      description: '',
      inputSchema: {},
      run: () => {
        throw new Error('bad input');
      },
    };
    expect(
      handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } }, [
        tool,
      ]),
    ).toMatchObject({ result: { isError: true } });
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
