import type { HostAdapter, SessionInfo, Settings, SourceResult } from './adapter';

/** Message prefix of an unreachable host, so views can tell it from a refusal. */
const HOST_LOST = 'Lost connection to the paces host';

export function isHostLost(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(HOST_LOST);
}

/** The request never reached the host: it stopped, or the network call failed. */
export class HostUnreachableError extends Error {
  constructor(what: string) {
    super(
      `${HOST_LOST} while ${what}. It exits shortly after its window closes; ` +
        'reopen the session with `paces open <file>`.',
    );
    this.name = 'HostUnreachableError';
  }
}

export interface HttpHostOptions {
  /** Defaults to the page's query string. */
  search?: string;
  fetchImpl?: typeof fetch;
}

/** Talks to the paces CLI server with relative URLs and the page token on every request. */
export function httpHostAdapter(opts: HttpHostOptions = {}): HostAdapter {
  const search = opts.search ?? (typeof location === 'undefined' ? '' : location.search);
  const token = new URLSearchParams(search).get('token') ?? '';
  const rawFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    'x-paces-token': token,
    ...extra,
  });

  /** A failed `fetch` (rejected, not an HTTP error) means the host could not be reached. */
  async function send(what: string, url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await rawFetch(url, init);
    } catch (e) {
      if (e instanceof TypeError) throw new HostUnreachableError(what);
      throw e;
    }
    if (!res.ok) throw new Error(`paces host: ${what} failed with HTTP ${res.status}`);
    return res;
  }

  async function getJson<T>(url: string, what: string): Promise<T> {
    const res = await send(what, url, { headers: headers() });
    return (await res.json()) as T;
  }

  return {
    loadSession: () => getJson<SessionInfo>('api/session', 'loading the session'),
    async loadModel(which) {
      const url = which === 'baseline' ? 'api/model?which=baseline' : 'api/model';
      const res = await send('loading the model', url, { headers: headers() });
      return new Uint8Array(await res.arrayBuffer());
    },
    readSource: (path) =>
      getJson<SourceResult>(`api/source?path=${encodeURIComponent(path)}`, 'reading source'),
    async readScreenshot(id) {
      const res = await send('loading a screenshot', `api/screenshot/${id}`, {
        headers: headers(),
      });
      return new Uint8Array(await res.arrayBuffer());
    },
    async openInEditor(file, line) {
      await send('opening the editor', 'api/open-in-editor', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ file, line }),
      });
    },
    loadSettings: () => getJson<Settings>('api/settings', 'loading settings'),
    async saveSettings(settings) {
      await send('saving settings', 'api/settings', {
        method: 'PUT',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(settings),
      });
    },
  };
}

/**
 * Heartbeat so the CLI knows the window is open, plus a goodbye beacon when the page goes away.
 * Heartbeats alone cannot say "closed": a minimized or hidden window has its timers throttled, so
 * the host treats only the goodbye (or the browser process exiting) as the fast signal.
 */
export function startHeartbeat(search?: string, intervalMs = 3000): () => void {
  const token = new URLSearchParams(search ?? location.search).get('token') ?? '';
  const beat = (): void => {
    void fetch('api/heartbeat', { method: 'POST', headers: { 'x-paces-token': token } }).catch(
      () => undefined,
    );
  };
  // `sendBeacon` cannot set headers, so the goodbye carries the token in the URL.
  const goodbye = (): void => {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(`api/goodbye?token=${encodeURIComponent(token)}`);
    }
  };
  beat();
  const id = setInterval(beat, intervalMs);
  window.addEventListener('pagehide', goodbye);
  return () => {
    clearInterval(id);
    window.removeEventListener('pagehide', goodbye);
  };
}
