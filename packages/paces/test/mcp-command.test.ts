import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readSession } from '@pacesjs/format';
import { main } from '../src/commands.js';
import { loadEngine } from '../src/engine.js';
import type { Io } from '../src/commands.js';

const BUSY = 'let x=0;const t=Date.now();while(Date.now()-t<60){x+=Math.sqrt(x+1)}';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-mcp-cmd-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

describe('paces mcp', () => {
  /** An MCP client over in-memory pipes: sends the requests, then closes, and returns every line the server wrote. */
  async function serve(argv: string[]): Promise<{ lines: string[]; err: string[]; code: number }> {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    createInterface({ input: output }).on('line', (l) => lines.push(l));
    const c = capture();
    const done = main(argv, { ...c.io, mcp: { input, output } });
    const send = (m: object) => input.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'summary' } });
    await vi.waitFor(() => expect(lines).toHaveLength(3), { timeout: 20_000 });
    input.end();
    return { lines, err: c.err, code: await done };
  }

  it('with nothing: serves with no session, until the profile tool starts one', async () => {
    const r = await serve(['mcp']);
    expect(r.code).toBe(0);
    const call = JSON.parse(r.lines[2] as string) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]?.text).toContain('No session yet');
  });

  it('hands the client the guide and its warning, in the instructions and as a resource', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Array<{ id: number; result: Record<string, unknown> }> = [];
    createInterface({ input: output }).on('line', (l) => lines.push(JSON.parse(l)));
    const done = main(['mcp'], { ...capture().io, mcp: { input, output } });
    const send = (m: object) => input.write(JSON.stringify(m) + String.fromCharCode(10));
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'paces://guide' } });
    await vi.waitFor(() => expect(lines).toHaveLength(3), { timeout: 20_000 });
    input.end();
    await done;
    const byId = (id: number) => lines.find((l) => l.id === id)?.result;
    expect(byId(1)).toMatchObject({
      capabilities: { resources: {} },
      instructions: expect.stringContaining('runs the command you give it'),
    });
    expect(byId(2)).toMatchObject({
      resources: [{ uri: 'paces://guide', mimeType: 'text/markdown' }],
    });
    expect(JSON.stringify(byId(3))).toContain('arbitrary code');
  });

  it('with a file: serves that session without profiling anything', async () => {
    const file = join(dir, 'a.paces');
    await serve(['mcp', '--out', file, '--', 'node', '-e', BUSY]);
    const r = await serve(['mcp', file]);
    expect(r.code).toBe(0);
    expect(r.lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3]);
    expect(r.err.join('\n')).not.toContain('profiling');
  });

  it('with -- and a command: profiles it first, saves the session, then serves it', async () => {
    const file = join(dir, 'mcp-run.paces');
    const r = await serve(['mcp', '--out', file, '--', 'node', '-e', BUSY]);
    expect(r.code).toBe(0);
    expect(r.err.join('\n')).toContain(`session saved to ${file}`);
    expect(
      readSession(new Uint8Array(readFileSync(file)), { engineVersion: loadEngine().engineVersion })
        .model,
    ).toBeDefined();
    const tools = JSON.parse(r.lines[1] as string) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(tools.result.tools.map((t) => t.name).slice(0, 4)).toEqual([
      'profile',
      'profile_browser',
      'open_session',
      'list_sessions',
    ]);
  });

  it('keeps the program output off the protocol: every line the server writes is JSON-RPC', async () => {
    const r = await serve([
      'mcp',
      '--out',
      join(dir, 'noisy.paces'),
      '--',
      'node',
      '-e',
      `${BUSY};console.log('PROGRAM '+'OUTPUT')`,
    ]);
    for (const line of r.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(r.lines.join('')).not.toContain('PROGRAM OUTPUT');
  });

  it('says what it is waiting for, and fails before serving when the command cannot run', async () => {
    const c = capture();
    const code = await main(['mcp', '--', 'definitely-not-a-command-xyz'], {
      ...c.io,
      mcp: { input: new PassThrough(), output: new PassThrough() },
    });
    expect(code).not.toBe(0);
    expect(c.err.join('\n')).toMatch(/paces: /);
  });
});
