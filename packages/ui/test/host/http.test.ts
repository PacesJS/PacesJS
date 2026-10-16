import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { HostUnreachableError, httpHostAdapter, startHeartbeat } from '../../src/host/http';

type Call = [string, RequestInit | undefined];

function fakeFetch(body: unknown, bytes?: Uint8Array) {
  const calls: Call[] = [];
  const fn = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push([String(url), init]);
    return bytes ? new Response(bytes as BlobPart) : new Response(JSON.stringify(body));
  };
  return Object.assign(fn, { calls });
}

describe('httpHostAdapter', () => {
  it('sends the page token on every request with a relative URL', async () => {
    const f = fakeFetch({ meta: {}, hasBaseline: false });
    await httpHostAdapter({
      search: '?token=abc',
      fetchImpl: f as unknown as typeof fetch,
    }).loadSession();
    const [url, init] = f.calls[0] ?? [];
    expect(url).toBe('api/session');
    expect((init?.headers as Record<string, string>)['x-paces-token']).toBe('abc');
  });

  it('reads the baseline model with the which parameter', async () => {
    const f = fakeFetch(null, new Uint8Array([1, 2, 3]));
    const bytes = await httpHostAdapter({
      search: '?token=t',
      fetchImpl: f as unknown as typeof fetch,
    }).loadModel('baseline');
    expect(f.calls[0]?.[0]).toBe('api/model?which=baseline');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('encodes the source path', async () => {
    const f = fakeFetch({ exists: true, text: '', hash: '', changedSinceProfile: false });
    await httpHostAdapter({
      search: '?token=t',
      fetchImpl: f as unknown as typeof fetch,
    }).readSource('src/a b.ts');
    expect(f.calls[0]?.[0]).toBe('api/source?path=src%2Fa%20b.ts');
  });

  it('posts open-in-editor as JSON', async () => {
    const f = fakeFetch({});
    await httpHostAdapter({
      search: '?token=t',
      fetchImpl: f as unknown as typeof fetch,
    }).openInEditor('src/a.ts', 9);
    expect(f.calls[0]?.[1]?.method).toBe('POST');
    expect(f.calls[0]?.[1]?.body).toBe('{"file":"src/a.ts","line":9}');
  });

  it('turns a failed response into an actionable error', async () => {
    const f = async (): Promise<Response> => new Response('no', { status: 403 });
    await expect(
      httpHostAdapter({ search: '', fetchImpl: f as unknown as typeof fetch }).loadSession(),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe('losing the host', () => {
  it('reports an unreachable host as such, not as a refusal', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const host = httpHostAdapter({ search: '?token=t', fetchImpl: down });
    await expect(host.readSource('src/a.ts')).rejects.toBeInstanceOf(HostUnreachableError);
    await expect(host.readSource('src/a.ts')).rejects.toThrow(/lost connection/i);
  });

  it('still reports an HTTP error as an HTTP error', async () => {
    const bad = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const host = httpHostAdapter({ search: '?token=t', fetchImpl: bad });
    await expect(host.readSource('x')).rejects.not.toBeInstanceOf(HostUnreachableError);
  });
});

describe('startHeartbeat', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tells the host the page is going away, so a throttled window is not mistaken for a closed one', () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const stop = startHeartbeat('?token=abc', 60_000);
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(beacon).toHaveBeenCalledWith('api/goodbye?token=abc');
    vi.unstubAllGlobals();
  });

  it('stops listening once stopped', () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const stop = startHeartbeat('?token=abc', 60_000);
    stop();
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
