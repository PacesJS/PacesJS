import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserRecording, BrowserRun, RecordOptions } from '@pacesjs/collector-browser';
import { loadEngine } from '../src/engine.js';
import { createPacesServer } from '../src/mcp-server.js';
import type { BrowserHooks, PacesServer } from '../src/mcp-server.js';
import { MCP_GUIDE, MCP_INSTRUCTIONS } from '../src/mcp-guide.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-mcp-browser-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A real recording, taken from the committed slow-click fixture. */
function recording(): BrowserRecording {
  const url = new URL(
    '../../engine/test/fixtures/browser/slow-click.browser.json.gz',
    import.meta.url,
  );
  const { input } = JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as {
    input: Record<string, unknown>;
  };
  return {
    ...(input as unknown as BrowserRecording),
    screenshots: { frames: [], deduplicated: 0, cap: 600 },
    warnings: [],
    cacheCold: false,
  };
}

interface Seen {
  options?: RecordOptions;
  stopped: number;
}

function hooks(over: Partial<BrowserHooks> = {}, seen: Seen = { stopped: 0 }): BrowserHooks {
  return {
    choose: () => Promise.resolve({ exe: 'C:\\edge.exe', name: 'Edge' }),
    record: (options) => {
      seen.options = options;
      const done = Promise.resolve(recording());
      const run = {
        done,
        stop: () => {
          seen.stopped++;
          return done;
        },
        kill: () => undefined,
        controller: {},
      } as unknown as BrowserRun;
      return Promise.resolve(run);
    },
    ...over,
  };
}

const server = (h: BrowserHooks, cwd = dir): PacesServer =>
  createPacesServer({ engine: loadEngine(), cwd, preload: 'unused', browser: h });

const tool = (s: PacesServer, name: string) => {
  const t = s.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const ctx = () => ({ signal: new AbortController().signal });

describe('profile_browser', () => {
  it('is listed beside profile, and the list does not change after a profile', async () => {
    const s = server(hooks());
    const before = s.tools.map((t) => t.name);
    await tool(s, 'profile_browser').run({ url: 'http://x.test/' }, ctx());
    expect(before).toContain('profile_browser');
    expect(before).toContain('profile');
    expect(s.tools.map((t) => t.name)).toEqual(before);
  });

  it('records the page, saves a session and answers with the digest', async () => {
    const cwd = mkdtempSync(join(dir, 'run-'));
    const s = server(hooks(), cwd);
    const out = (await tool(s, 'profile_browser').run({ url: 'http://x.test/' }, ctx())) as {
      session: string;
      summary: { findings: Array<{ kind: string }> };
    };
    expect(existsSync(out.session)).toBe(true);
    expect(out.session.startsWith(join(cwd, '.paces'))).toBe(true);
    expect(out.summary.findings.map((f) => f.kind)).toContain('slow-interaction');
  });

  it('makes the analysis tools answer about the page it recorded', async () => {
    const s = server(hooks());
    await tool(s, 'profile_browser').run({ url: 'http://x.test/' }, ctx());
    const findings = (await tool(s, 'findings').run({}, ctx())) as Array<{ kind: string }>;
    expect(JSON.stringify(findings)).toContain('slow-interaction');
  });

  it('waits for the load by default, and for a number of seconds when given one', async () => {
    const seen: Seen = { stopped: 0 };
    const s = server(hooks({}, seen));
    await tool(s, 'profile_browser').run({ url: 'http://x.test/' }, ctx());
    expect(seen.options).toMatchObject({ until: 'load' });
    await tool(s, 'profile_browser').run({ url: 'http://x.test/', until: 8 }, ctx());
    expect(seen.options).toMatchObject({ durationMs: 8000 });
    expect(seen.options?.until).toBeUndefined();
  });

  it('passes throttling and first-party hosts to the recording', async () => {
    const seen: Seen = { stopped: 0 };
    const s = server(hooks({}, seen));
    await tool(s, 'profile_browser').run(
      { url: 'http://x.test/', until: 'idle', throttle: 4, firstParty: ['https://cdn.x.test/**'] },
      ctx(),
    );
    expect(seen.options).toMatchObject({ until: 'idle', throttle: 4 });
  });

  it('is refused, with what to do, when there is no display to open a window on', async () => {
    const s = server(
      hooks({
        choose: () =>
          Promise.resolve({
            exitCode: 2 as const,
            message: 'paces: no display found, so there is no browser window to profile.',
          }),
      }),
    );
    await expect(tool(s, 'profile_browser').run({ url: 'http://x.test/' }, ctx())).rejects.toThrow(
      /no display found/,
    );
  });

  it('needs a URL, and rejects an until it does not know', async () => {
    const s = server(hooks());
    await expect(tool(s, 'profile_browser').run({}, ctx())).rejects.toThrow(/url is required/);
    await expect(
      tool(s, 'profile_browser').run({ url: 'http://x.test/', until: 'soon' }, ctx()),
    ).rejects.toThrow(/until/);
    await expect(
      tool(s, 'profile_browser').run({ url: 'http://x.test/', until: 100_000 }, ctx()),
    ).rejects.toThrow(/until/);
  });

  it('refuses a second profile while one is running, of either kind', async () => {
    let release: (r: BrowserRecording) => void = () => undefined;
    const pending = new Promise<BrowserRecording>((resolve) => {
      release = resolve;
    });
    const s = server(
      hooks({
        record: () =>
          Promise.resolve({
            done: pending,
            stop: () => pending,
            kill: () => undefined,
            controller: {},
          } as unknown as BrowserRun),
      }),
    );
    const first = tool(s, 'profile_browser').run({ url: 'http://x.test/' }, ctx());
    await expect(tool(s, 'profile_browser').run({ url: 'http://y.test/' }, ctx())).rejects.toThrow(
      /already profiling/,
    );
    await expect(tool(s, 'profile').run({ command: ['node', '-v'] }, ctx())).rejects.toThrow(
      /already profiling/,
    );
    release(recording());
    await first;
  });

  it('stops the recording when the client goes away', async () => {
    const seen: Seen = { stopped: 0 };
    let release: (r: BrowserRecording) => void = () => undefined;
    const pending = new Promise<BrowserRecording>((resolve) => {
      release = resolve;
    });
    const s = server(
      hooks(
        {
          record: () =>
            Promise.resolve({
              done: pending,
              stop: () => {
                seen.stopped++;
                release(recording());
                return pending;
              },
              kill: () => undefined,
              controller: {},
            } as unknown as BrowserRun),
        },
        seen,
      ),
    );
    const abort = new AbortController();
    const running = tool(s, 'profile_browser').run(
      { url: 'http://x.test/' },
      { signal: abort.signal },
    );
    abort.abort();
    await running;
    expect(seen.stopped).toBe(1);
  });
});

describe('the guide names profile_browser and warns that a page runs code', () => {
  it('names the tool and says a page runs its own JavaScript on the user machine', () => {
    expect(MCP_GUIDE).toContain('profile_browser');
    expect(MCP_GUIDE).toMatch(/page.s own JavaScript/i);
    expect(MCP_GUIDE).toMatch(/visible (browser )?window/i);
  });

  it('repeats the warning in the connect-time instructions', () => {
    expect(MCP_INSTRUCTIONS).toContain('profile_browser');
    expect(MCP_INSTRUCTIONS).toMatch(/runs/i);
    expect(MCP_INSTRUCTIONS.split(/\r?\n/).length).toBeLessThanOrEqual(6);
  });
});
