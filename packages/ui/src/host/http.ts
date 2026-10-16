import type { HostAdapter, SessionInfo, Settings, SourceResult } from './adapter';

export interface HttpHostOptions {
  /** Defaults to the page's query string. */
  search?: string;
  fetchImpl?: typeof fetch;
}

/** Talks to the paces CLI server with relative URLs and the page token on every request. */
export function httpHostAdapter(opts: HttpHostOptions = {}): HostAdapter {
  const search = opts.search ?? (typeof location === 'undefined' ? '' : location.search);
  const token = new URLSearchParams(search).get('token') ?? '';
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    'x-paces-token': token,
    ...extra,
  });

  async function ok(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new Error(`paces host: ${what} failed with HTTP ${res.status}`);
    return res;
  }

  async function getJson<T>(url: string, what: string): Promise<T> {
    const res = await ok(await doFetch(url, { headers: headers() }), what);
    return (await res.json()) as T;
  }

  return {
    loadSession: () => getJson<SessionInfo>('api/session', 'loading the session'),
    async loadModel(which) {
      const url = which === 'baseline' ? 'api/model?which=baseline' : 'api/model';
      const res = await ok(await doFetch(url, { headers: headers() }), 'loading the model');
      return new Uint8Array(await res.arrayBuffer());
    },
    readSource: (path) =>
      getJson<SourceResult>(`api/source?path=${encodeURIComponent(path)}`, 'reading source'),
    async openInEditor(file, line) {
      await ok(
        await doFetch('api/open-in-editor', {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ file, line }),
        }),
        'opening the editor',
      );
    },
    loadSettings: () => getJson<Settings>('api/settings', 'loading settings'),
    async saveSettings(settings) {
      await ok(
        await doFetch('api/settings', {
          method: 'PUT',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(settings),
        }),
        'saving settings',
      );
    },
  };
}

/** Heartbeat so the CLI knows the window is open. Fire and forget. */
export function startHeartbeat(search?: string, intervalMs = 3000): () => void {
  const token = new URLSearchParams(search ?? location.search).get('token') ?? '';
  const beat = (): void => {
    void fetch('api/heartbeat', { method: 'POST', headers: { 'x-paces-token': token } }).catch(
      () => undefined,
    );
  };
  beat();
  const id = setInterval(beat, intervalMs);
  return () => clearInterval(id);
}
