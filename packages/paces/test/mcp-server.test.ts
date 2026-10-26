import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { loadEngine } from '../src/engine.js';
import { serveMcp } from '../src/mcp.js';
import { createPacesServer } from '../src/mcp-server.js';

const preload = createRequire(import.meta.url).resolve('@pacesjs/collector-node/preload.cjs');
const BUSY = 'let x=0;const t=Date.now();while(Date.now()-t<80){x+=Math.sqrt(x+1)}';
const ANALYSIS = [
  'summary',
  'findings',
  'hot_paths',
  'top_functions',
  'package_breakdown',
  'callers',
  'phases',
];

const VALID: Record<string, Record<string, unknown>> = {
  package_breakdown: { package: 'x' },
  callers: { function: 'x' },
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-mcp-server-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(cwd: string): Promise<{ client: Client; stop: () => Promise<void> }> {
  const server = createPacesServer({ engine: loadEngine(), cwd, preload });
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const done = serveMcp(toServer, fromServer, server.tools);
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
  await client.connect(transport);
  return {
    client,
    stop: async () => {
      toServer.end();
      await done;
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: unknown; text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  const text = r.content[0]?.text ?? '';
  return { isError: Boolean(r.isError), text, data: r.isError ? null : JSON.parse(text) };
}

interface ProfileData {
  session: string;
  exitCode: number;
  endedBy: string;
  tracks: number;
  summary: { command: string[] };
}

const node = (code: string): string[] => ['node', '-e', code];

describe('the generic paces MCP server', () => {
  it('lists the same tools before and after a session is loaded', async () => {
    const cwd = mkdtempSync(join(dir, 'list-'));
    const { client, stop } = await connect(cwd);
    const before = (await client.listTools()).tools.map((t) => t.name);
    await call(client, 'profile', { command: node(BUSY) });
    const after = (await client.listTools()).tools.map((t) => t.name);
    expect(before).toEqual(['profile', 'open_session', 'list_sessions', ...ANALYSIS]);
    expect(after).toEqual(before);
    await stop();
  });

  it('marks the analysis tools read-only and profile as one that runs programs', async () => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'hints-')));
    const tools = (await client.listTools()).tools;
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    expect(hints('summary')).toMatchObject({ readOnlyHint: true });
    expect(hints('callers')).toMatchObject({ readOnlyHint: true });
    expect(hints('profile')).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    await stop();
  });

  it('tells the agent what to do first when no session is loaded', async () => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'empty-')));
    for (const name of ANALYSIS) {
      const r = await call(client, name, VALID[name] ?? {});
      expect(r.isError).toBe(true);
      expect(r.text).toBe('No session yet: call profile or open_session first.');
    }
    await stop();
  });

  it('profiles a command, saves the session under the working directory, and answers about it', async () => {
    const cwd = mkdtempSync(join(dir, 'one-'));
    const { client, stop } = await connect(cwd);
    const run = await call(client, 'profile', { command: node(BUSY) });
    const data = run.data as ProfileData;
    expect(run.isError).toBe(false);
    expect(data).toMatchObject({ exitCode: 0, endedBy: 'exit', tracks: 1 });
    expect(data.session.startsWith(join(cwd, '.paces'))).toBe(true);
    expect(data.session.endsWith('.paces')).toBe(true);
    const summary = (await call(client, 'summary')).data as { command: string[] };
    expect(summary.command).toEqual(node(BUSY));
    expect(data.summary.command).toEqual(node(BUSY));
    await stop();
  });

  it('profiles twice in one server, and the tools follow the latest run', async () => {
    const cwd = mkdtempSync(join(dir, 'two-'));
    const { client, stop } = await connect(cwd);
    const first = (await call(client, 'profile', { command: node(`${BUSY};//first`) }))
      .data as ProfileData;
    const second = (await call(client, 'profile', { command: node(`${BUSY};//second`) }))
      .data as ProfileData;
    expect(second.session).not.toBe(first.session);
    const summary = (await call(client, 'summary')).data as { command: string[] };
    expect(summary.command[2]).toContain('//second');
    await stop();
  });

  it('reports a non-zero exit code of the program as data, not as a tool error', async () => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'exit-')));
    const run = await call(client, 'profile', { command: node(`${BUSY};process.exit(3)`) });
    expect(run.isError).toBe(false);
    expect((run.data as ProfileData).exitCode).toBe(3);
    await stop();
  });

  it('fails with an actionable message for a command that cannot run, and keeps the previous session', async () => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'bad-')));
    await call(client, 'profile', { command: node(`${BUSY};//kept`) });
    const bad = await call(client, 'profile', { command: ['definitely-not-a-command-xyz'] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/definitely-not-a-command-xyz/);
    const summary = (await call(client, 'summary')).data as { command: string[] };
    expect(summary.command[2]).toContain('//kept');
    await stop();
  });

  it('rejects a second profile while one is running, and accepts one after it ends', async () => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'busy-')));
    const first = call(client, 'profile', { command: node('setTimeout(()=>{},1500)') });
    const second = await call(client, 'profile', { command: node(BUSY) });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/already profiling/);
    expect((await first).isError).toBe(false);
    expect((await call(client, 'profile', { command: node(BUSY) })).isError).toBe(false);
    await stop();
  });

  it('profiles in the directory the agent names, and keeps its sessions there', async () => {
    const root = mkdtempSync(join(dir, 'cwd-'));
    const project = join(root, 'project');
    mkdirSync(project);
    const { client, stop } = await connect(root);
    const run = await call(client, 'profile', { command: node(BUSY), cwd: 'project' });
    expect(run.isError).toBe(false);
    const listed = (await call(client, 'list_sessions', { cwd: 'project' })).data as Array<{
      path: string;
    }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe((run.data as ProfileData).session);
    expect(((await call(client, 'list_sessions')).data as unknown[]).length).toBe(0);
    await stop();
  });

  it.each([
    [{}, /command/],
    [{ command: [] }, /command/],
    [{ command: 'node app.js' }, /array/],
    [{ command: ['node'], duration: 0 }, /duration/],
    [{ command: ['node'], interval: 'fast' }, /interval/],
  ])('rejects the profile arguments %j', async (args, message) => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'args-')));
    const r = await call(client, 'profile', args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    await stop();
  });

  it('stops a program that never ends when the client goes away', async () => {
    const server = createPacesServer({
      engine: loadEngine(),
      cwd: mkdtempSync(join(dir, 'gone-')),
      preload,
    });
    const abort = new AbortController();
    const tool = server.tools.find((t) => t.name === 'profile');
    abort.abort();
    // The program would run for the whole default window; settling at all shows it was stopped.
    const settled = await Promise.allSettled([
      Promise.resolve(
        tool?.run({ command: node('setInterval(()=>{},1000)') }, { signal: abort.signal }),
      ),
    ]);
    expect(settled).toHaveLength(1);
  });
});

describe('the guide the server gives the model', () => {
  const server = () => createPacesServer({ engine: loadEngine(), cwd: dir, preload });

  it('is a markdown resource that names every tool, so it cannot drift from the tool list', () => {
    const { resources, tools } = server();
    const guide = resources.find((r) => r.uri === 'paces://guide');
    expect(guide?.mimeType).toBe('text/markdown');
    for (const tool of tools) expect(guide?.text).toContain(tool.name);
  });

  it('warns that profile runs arbitrary code, and says what not to run', () => {
    const text = server().resources[0]?.text ?? '';
    expect(text).toMatch(/runs the command/i);
    expect(text).toMatch(/arbitrary code/i);
    expect(text).toMatch(/untrusted/i);
    expect(text).toMatch(/not a shell string|argument array/i);
  });

  it('points the instructions at the resource and repeats the warning in one line', () => {
    const { instructions } = server();
    expect(instructions).toContain('paces://guide');
    expect(instructions).toMatch(/runs the command you give it/i);
    expect(instructions.split(/\r?\n/).length).toBeLessThanOrEqual(6);
  });
});

describe('open_session and list_sessions', () => {
  it('lists sessions newest first with what was run, and opens an older one', async () => {
    const cwd = mkdtempSync(join(dir, 'sessions-'));
    const { client, stop } = await connect(cwd);
    const a = (await call(client, 'profile', { command: node(`${BUSY};//a`) })).data as ProfileData;
    const b = (await call(client, 'profile', { command: node(`${BUSY};//b`) })).data as ProfileData;
    const listed = (await call(client, 'list_sessions')).data as Array<{
      path: string;
      command: string[];
    }>;
    expect(listed.map((s) => s.path)).toEqual([b.session, a.session]);
    expect(listed[0]?.command[2]).toContain('//b');

    const opened = await call(client, 'open_session', { path: a.session });
    expect(opened.isError).toBe(false);
    const summary = (await call(client, 'summary')).data as { command: string[] };
    expect(summary.command[2]).toContain('//a');
    await stop();
  });

  it('says so when the file does not exist, and when no sessions exist yet', async () => {
    const { client, stop } = await connect(mkdtempSync(join(dir, 'none-')));
    const missing = await call(client, 'open_session', { path: 'nope.paces' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No such file/);
    expect((await call(client, 'list_sessions')).data).toEqual([]);
    await stop();
  });
});
