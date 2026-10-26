import type { CdpEvent, CdpLike } from './cdp-pipe.js';

export interface ScreencastDeps {
  cdp: CdpLike;
  /** Where frames go: `epochMs` is when the browser says the frame was shown. */
  addScreenshot: (epochMs: number, bytes: Uint8Array) => void;
}

export interface Screencast {
  /** Starts frames on these pages, and on any added later while running. */
  start(sessions: Iterable<string>): Promise<void>;
  /** Stops frames on every page. Nothing is kept until `start` is called again. */
  stop(): Promise<void>;
  /** A page that appeared: started at once if frames are running. */
  add(session: string): Promise<void>;
}

/**
 * The filmstrip. Frames come from `Page.startScreencast` and not from the trace: a trace started on
 * the browser (so that it outlives the page) records no screenshots, and a screencast can be turned
 * off while paused, so a login is never captured.
 */
export function createScreencast({ cdp, addScreenshot }: ScreencastDeps): Screencast {
  const sessions = new Set<string>();
  let running = false;

  const begin = async (session: string): Promise<void> => {
    sessions.add(session);
    await cdp
      .send(
        'Page.startScreencast',
        { format: 'jpeg', quality: 60, maxWidth: 500, maxHeight: 330, everyNthFrame: 1 },
        session,
      )
      .catch(() => undefined);
  };

  cdp.onEvent((e: CdpEvent) => {
    if (e.method !== 'Page.screencastFrame' || !e.sessionId) return;
    const params = (e.params ?? {}) as {
      data?: unknown;
      metadata?: { timestamp?: unknown };
      sessionId?: unknown;
    };
    // The page waits for an acknowledgement before it sends the next frame, running or not.
    if (typeof params.sessionId === 'number') {
      cdp
        .send('Page.screencastFrameAck', { sessionId: params.sessionId }, e.sessionId)
        .catch(() => undefined);
    }
    const seconds = params.metadata?.timestamp;
    if (!running || typeof params.data !== 'string' || typeof seconds !== 'number') return;
    addScreenshot(Math.round(seconds * 1000), Uint8Array.from(Buffer.from(params.data, 'base64')));
  });

  return {
    async start(list) {
      running = true;
      for (const session of list) await begin(session);
    },
    async stop() {
      running = false;
      for (const session of sessions) {
        await cdp.send('Page.stopScreencast', {}, session).catch(() => undefined);
      }
    },
    async add(session) {
      if (running) await begin(session);
    },
  };
}
