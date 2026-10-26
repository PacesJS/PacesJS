import { describe, expect, it } from 'vitest';
import { collectSources } from '../src/sources.js';
import type { ScriptRecord } from '../src/targets.js';
import { FakeCdp } from './helpers/fake-cdp.js';

const script = (
  scriptId: string,
  url: string,
  extra: Partial<ScriptRecord> = {},
): ScriptRecord => ({
  scriptId,
  url,
  sourceMapURL: '',
  hash: `h${scriptId}`,
  session: 's1',
  ...extra,
});

function cdpWith(sources: Record<string, string>, maps: Record<string, string> = {}): FakeCdp {
  const cdp = new FakeCdp();
  const send = cdp.send.bind(cdp);
  const streams = new Map<string, string>();
  cdp.send = (method, params, session) => {
    const p = params as Record<string, string>;
    if (method === 'Debugger.getScriptSource') {
      const text = sources[p.scriptId ?? ''];
      return text === undefined
        ? Promise.reject(new Error('No script'))
        : Promise.resolve({ scriptSource: text });
    }
    if (method === 'Page.getFrameTree')
      return Promise.resolve({ frameTree: { frame: { id: 'F' } } });
    if (method === 'Network.loadNetworkResource') {
      const body = maps[p.url ?? ''];
      if (body === undefined) return Promise.resolve({ resource: { success: false } });
      streams.set('stream-' + p.url, body);
      return Promise.resolve({ resource: { success: true, stream: 'stream-' + p.url } });
    }
    if (method === 'IO.read') {
      const body = streams.get(p.handle ?? '') ?? '';
      return Promise.resolve({ data: body, eof: true, base64Encoded: false });
    }
    return send(method, params, session);
  };
  return cdp;
}

const limits = { perSource: 100, perSession: 1000 };

describe('collectSources', () => {
  it('reads the text of each script', async () => {
    const cdp = cdpWith({ '1': 'var a = 1;' });
    const result = await collectSources(cdp, [script('1', 'https://a.test/app.js')], limits);
    expect(result.sources).toEqual([
      { url: 'https://a.test/app.js', hash: 'h1', text: 'var a = 1;' },
    ]);
  });

  it('reads two copies of the same script once', async () => {
    const cdp = cdpWith({ '1': 'x', '2': 'x' });
    const result = await collectSources(
      cdp,
      [
        script('1', 'https://a.test/a.js', { hash: 'same' }),
        script('2', 'https://a.test/a.js', { hash: 'same' }),
      ],
      limits,
    );
    expect(result.sources).toHaveLength(1);
  });

  it('skips a source over the per-source cap and reports it in one aggregated warning', async () => {
    const cdp = cdpWith({ '1': 'x'.repeat(200), '2': 'y'.repeat(300), '3': 'ok' });
    const result = await collectSources(
      cdp,
      [
        script('1', 'https://a.test/1.js'),
        script('2', 'https://a.test/2.js'),
        script('3', 'https://a.test/3.js'),
      ],
      limits,
    );
    expect(result.sources.map((s) => s.url)).toEqual(['https://a.test/3.js']);
    expect(result.warnings).toEqual([
      {
        kind: 'source-too-large',
        count: 2,
        details: ['https://a.test/1.js', 'https://a.test/2.js'],
      },
    ]);
  });

  it('stops at the per-session cap', async () => {
    const cdp = cdpWith({ '1': 'a'.repeat(60), '2': 'b'.repeat(60), '3': 'c'.repeat(60) });
    const result = await collectSources(
      cdp,
      [
        script('1', 'https://a.test/1.js'),
        script('2', 'https://a.test/2.js'),
        script('3', 'https://a.test/3.js'),
      ],
      { perSource: 100, perSession: 100 },
    );
    expect(result.sources).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe('sources-over-budget');
  });

  it('fetches a source map named by the script, resolved against the script URL', async () => {
    const cdp = cdpWith({ '1': 'code' }, { 'https://a.test/dist/app.js.map': '{"version":3}' });
    const result = await collectSources(
      cdp,
      [script('1', 'https://a.test/dist/app.js', { sourceMapURL: 'app.js.map' })],
      limits,
    );
    expect(result.sourceMaps).toEqual({ 'https://a.test/dist/app.js': '{"version":3}' });
  });

  it('leaves inline data: maps to the engine', async () => {
    const cdp = cdpWith({ '1': 'code' });
    const result = await collectSources(
      cdp,
      [script('1', 'https://a.test/app.js', { sourceMapURL: 'data:application/json;base64,e30=' })],
      limits,
    );
    expect(result.sourceMaps).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('warns once, aggregated, when maps cannot be fetched, and keeps going', async () => {
    const cdp = cdpWith({ '1': 'a', '2': 'b' });
    const result = await collectSources(
      cdp,
      [
        script('1', 'https://a.test/1.js', { sourceMapURL: '1.js.map' }),
        script('2', 'https://a.test/2.js', { sourceMapURL: '2.js.map' }),
      ],
      limits,
    );
    expect(result.sources).toHaveLength(2);
    expect(result.warnings).toEqual([
      {
        kind: 'source-map-unreadable',
        count: 2,
        details: ['https://a.test/1.js', 'https://a.test/2.js'],
      },
    ]);
  });

  it('skips a script whose target is gone without failing the run', async () => {
    const cdp = cdpWith({});
    const result = await collectSources(cdp, [script('9', 'https://a.test/gone.js')], limits);
    expect(result.sources).toEqual([]);
  });

  describe('inline scripts', () => {
    const inline = (scriptId: string, startLine: number, startColumn = 0): ScriptRecord =>
      script(scriptId, 'https://a.test/page.html', {
        hash: `h${scriptId}`,
        startLine,
        startColumn,
        endLine: startLine + 2,
      });

    it('puts a script at its line in the document, so the lines V8 reports match the text', async () => {
      const cdp = cdpWith({ '1': '\nfunction f() {}\nf();' });
      const { sources } = await collectSources(cdp, [inline('1', 6)], limits);
      const lines = sources[0]?.text.split('\n') ?? [];
      expect(lines[6 + 1]).toBe('function f() {}');
      expect(lines.slice(0, 6)).toEqual(['', '', '', '', '', '']);
    });

    it('keeps the first line where it was, indented to the column the script starts at', async () => {
      const cdp = cdpWith({ '1': 'f();' });
      const { sources } = await collectSources(cdp, [inline('1', 3, 8)], limits);
      expect(sources[0]?.text.split('\n')[3]).toBe('        f();');
    });

    it('lays two scripts of one page into one text, so neither hides the other', async () => {
      const cdp = cdpWith({ '1': 'a();', '2': 'b();' });
      const { sources } = await collectSources(cdp, [inline('1', 2), inline('2', 9)], limits);
      expect(sources).toHaveLength(1);
      const lines = sources[0]?.text.split('\n') ?? [];
      expect([lines[2], lines[9]]).toEqual(['a();', 'b();']);
    });

    it('leaves an external script, which starts at the top of its file, as it is', async () => {
      const cdp = cdpWith({ '1': 'var a;' });
      const { sources } = await collectSources(
        cdp,
        [script('1', 'https://a.test/app.js', { startLine: 0, startColumn: 0, endLine: 0 })],
        limits,
      );
      expect(sources[0]?.text).toBe('var a;');
    });
  });
});
