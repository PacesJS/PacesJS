import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDetached } from '@pacesjs/shared';
import type { CdpEvent } from './cdp-pipe.js';
import { buildInjectedSource } from './inject/entry.js';
import type { Corner } from './inject/overlay-state.js';
import { launchBrowser } from './launch.js';
import type { LaunchedBrowser } from './launch.js';
import { createSessionController } from './session-controller.js';
import type {
  ControllerOptions,
  ControllerState,
  Recording,
  SessionController,
} from './session-controller.js';
import { DEFAULT_SOURCE_LIMITS, collectSources } from './sources.js';
import type { CollectedSource, SourceWarning } from './sources.js';
import { createTargetManager } from './targets.js';
import type { ScriptRecord } from './targets.js';
import { scrubUrl } from './trace-filter.js';

export type EndedBy = 'stop' | 'sigint' | 'duration' | 'window-closed';

export interface RecordOptions extends ControllerOptions {
  url: string;
  /** Chromium executable. */
  exe: string;
  overlay: boolean;
  eventMarks: boolean;
  eventText: boolean;
  /** Stop after this many milliseconds. */
  durationMs?: number;
  /** CPU slowdown factor, e.g. 4. */
  throttle?: number;
  /** Disable the HTTP cache for the run. */
  cacheCold: boolean;
  windowSize?: string;
  onState?: (state: ControllerState) => void;
}

export interface BrowserRecording extends Recording {
  product: string;
  url: string;
  scripts: ScriptRecord[];
  sources: CollectedSource[];
  sourceMaps: Record<string, string>;
  warnings: SourceWarning[];
  endedBy: EndedBy;
  startedAt: number;
  endedAt: number;
  throttle?: number;
  cacheCold: boolean;
}

export interface BrowserRun {
  controller: SessionController;
  /** Ends the run as the user asked; resolves with the recording once the browser is closed. */
  stop(by?: EndedBy): Promise<BrowserRecording>;
  done: Promise<BrowserRecording>;
  /** Ends the browser at once, without waiting for a trace. */
  kill(): void;
}

export class BrowserNotSupportedError extends Error {
  constructor(product: string) {
    super(
      `${product || 'This browser'} is not Chromium-based, so paces cannot drive it. Use Chrome, Edge, Brave, Vivaldi, Opera or Chromium, or pass --browser <path>.`,
    );
    this.name = 'BrowserNotSupportedError';
  }
}

const CHROMIUM_PRODUCT = /Chrome|Edg|Brave|Chromium|OPR|Opera|Vivaldi/i;

/** `Browser.getVersion` is the check that matters: a registry entry can name any executable. */
export function isChromiumProduct(product: string): boolean {
  return CHROMIUM_PRODUCT.test(product);
}

interface BridgeMessage {
  t?: string;
  frame?: string;
  seq?: number;
  at?: number;
  kind?: string;
  label?: string;
  action?: string;
}

export async function startRecording(options: RecordOptions): Promise<BrowserRun> {
  const profileDir = mkdtempSync(join(tmpdir(), 'paces-browser-'));
  const browser: LaunchedBrowser = launchBrowser({
    exe: options.exe,
    profileDir,
    ...(options.windowSize ? { windowSize: options.windowSize } : {}),
  });
  const { client: cdp } = browser;
  const cleanup = (): void => {
    browser.kill();
    removeDetached(profileDir);
  };

  try {
    const version = (await cdp.send('Browser.getVersion')) as { product?: string };
    const product = version.product ?? '';
    if (!isChromiumProduct(product)) throw new BrowserNotSupportedError(product);

    const topSessions = new Set<string>();
    let corner: Corner = 'bottom-right';
    // Created after the callbacks that use it are registered, so it lives in a holder.
    const live: { controller?: SessionController } = {};
    let ended: EndedBy | undefined;
    let stopRequested: (by: EndedBy) => void = () => {};

    const injectSource = buildInjectedSource({
      overlay: options.overlay,
      eventMarks: options.eventMarks,
      eventText: options.eventText,
    });

    const pushState = (): void => {
      if (!live.controller || !options.overlay) return;
      const state = live.controller.state();
      const phase = state.phase === 'done' ? 'stopping' : state.phase;
      const expression = `window.__paces__&&window.__paces__.state(${JSON.stringify({
        phase,
        elapsedMs: state.elapsedMs,
        marks: state.marks,
        position: corner,
      })})`;
      for (const session of topSessions) {
        cdp
          .send('Runtime.evaluate', { expression }, session)
          .catch(() => topSessions.delete(session));
      }
    };

    const manager = createTargetManager({
      cdp,
      injectSource,
      keepQuery: options.keepQuery,
      onBridge: (raw, session) => {
        const m = raw as BridgeMessage;
        if (m.t === 'hello') {
          if (m.frame === 'top') topSessions.add(session);
          pushState();
        } else if (
          m.t === 'event' &&
          live.controller &&
          live.controller.state().phase === 'recording'
        ) {
          live.controller.mark(m.label ?? '', m.kind ?? 'event', {
            ...(m.at !== undefined ? { at: m.at } : {}),
            ...(m.seq !== undefined ? { seq: m.seq } : {}),
            ...(m.frame !== undefined ? { frame: m.frame } : {}),
          });
        } else if (m.t === 'control') {
          const action = m.action ?? '';
          if (action === 'pause') void live.controller?.pause();
          else if (action === 'resume' || action === 'start') void live.controller?.resume();
          else if (action === 'mark') live.controller?.mark(m.label ?? '');
          else if (action === 'stop') stopRequested('stop');
          else if (action.startsWith('position:')) corner = action.slice(9) as Corner;
          pushState();
        }
      },
    });

    // The first page: wait for it by event rather than reading the target list once.
    const pageTarget = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The browser opened no page to profile within 20 s.')),
        20_000,
      );
      const found = (id: string): void => {
        clearTimeout(timer);
        resolve(id);
      };
      cdp.onEvent((e: CdpEvent) => {
        const info = (e.params as { targetInfo?: { type?: string; targetId?: string } } | undefined)
          ?.targetInfo;
        if (e.method === 'Target.targetCreated' && info?.type === 'page' && info.targetId) {
          found(info.targetId);
        }
      });
      void cdp
        .send('Target.setDiscoverTargets', { discover: true })
        .then(() => cdp.send('Target.getTargets'))
        .then((r) => {
          const first = (
            r as { targetInfos?: Array<{ type: string; targetId: string }> }
          ).targetInfos?.find((t) => t.type === 'page');
          if (first) found(first.targetId);
        })
        .catch(reject);
    });
    const attachedPages = new Set<string>([pageTarget]);
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId: pageTarget,
      flatten: true,
    })) as { sessionId: string };
    topSessions.add(sessionId);
    await manager.configure(sessionId, 'page', false, pageTarget);
    await manager.idle();

    // Tabs and popups the user opens later get the same treatment.
    let livePages = 1;
    cdp.onEvent((e: CdpEvent) => {
      const info = (e.params as { targetInfo?: { type?: string; targetId?: string } } | undefined)
        ?.targetInfo;
      if (e.method === 'Target.targetCreated' && info?.type === 'page' && info.targetId) {
        if (!attachedPages.has(info.targetId)) {
          attachedPages.add(info.targetId);
          livePages++;
          void cdp
            .send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
            .then((r) =>
              manager.configure(
                (r as { sessionId: string }).sessionId,
                'page',
                false,
                info.targetId,
              ),
            )
            .catch(() => undefined);
        }
      } else if (e.method === 'Target.targetDestroyed') {
        const id = (e.params as { targetId?: string } | undefined)?.targetId;
        if (id && attachedPages.delete(id)) {
          livePages--;
          if (livePages <= 0) stopRequested('window-closed');
        }
      } else if (
        e.method === 'Page.frameNavigated' &&
        options.eventMarks &&
        live.controller?.state().phase === 'recording'
      ) {
        const frame = (e.params as { frame?: { parentId?: string; url?: string } } | undefined)
          ?.frame;
        if (frame && !frame.parentId && frame.url && !frame.url.startsWith('about:')) {
          live.controller.mark(scrubUrl(frame.url), 'navigate');
        }
      } else if (e.method === 'Page.navigatedWithinDocument' && options.eventMarks) {
        const url = (e.params as { url?: string } | undefined)?.url;
        if (url && live.controller?.state().phase === 'recording') {
          live.controller.mark(scrubUrl(url), 'navigate');
        }
      }
    });

    if (options.throttle && options.throttle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.throttle }, sessionId);
    }
    if (options.cacheCold) {
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    }

    const controller = createSessionController({
      cdp,
      session: sessionId,
      options,
      syncClock: async (n) => {
        const r = (await cdp.send(
          'Runtime.evaluate',
          { expression: `window.__paces__&&window.__paces__.sync(${n})`, returnByValue: true },
          sessionId,
        )) as { result?: { value?: unknown } };
        return typeof r.result?.value === 'number' ? r.result.value : undefined;
      },
      onChange: (state) => {
        options.onState?.(state);
        pushState();
      },
    });
    live.controller = controller;
    const startedAt = Date.now();
    await controller.start();
    await cdp.send('Page.navigate', { url: options.url }, sessionId);

    const finish = async (by: EndedBy): Promise<BrowserRecording> => {
      let recording: Recording;
      const warnings: SourceWarning[] = [];
      try {
        recording = await controller.stop();
      } catch {
        recording = controller.partial();
        warnings.push({
          kind: 'trace-incomplete',
          count: 1,
          details: [
            by === 'window-closed'
              ? 'The window was closed while recording, so the last stretch could not be collected. Use Stop in the overlay or press s in the terminal to end a run.'
              : 'The browser did not hand over its last trace segment.',
          ],
        });
      }
      let sources: CollectedSource[] = [];
      let sourceMaps: Record<string, string> = {};
      if (by !== 'window-closed') {
        const collected = await collectSources(cdp, manager.scripts(), DEFAULT_SOURCE_LIMITS);
        sources = collected.sources;
        sourceMaps = collected.sourceMaps;
        warnings.push(...collected.warnings);
        await cdp.send('Browser.close').catch(() => undefined);
      }
      await Promise.race([
        browser.exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      cleanup();
      return {
        ...recording,
        product,
        url: scrubUrl(options.url),
        scripts: manager.scripts(),
        sources,
        sourceMaps,
        warnings,
        endedBy: by,
        startedAt,
        endedAt: Date.now(),
        ...(options.throttle ? { throttle: options.throttle } : {}),
        cacheCold: options.cacheCold,
      };
    };

    let result: Promise<BrowserRecording> | undefined;
    let resolveDone: (r: BrowserRecording) => void = () => {};
    let rejectDone: (e: unknown) => void = () => {};
    const done = new Promise<BrowserRecording>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const stop = (by: EndedBy = 'stop'): Promise<BrowserRecording> => {
      if (!result) {
        ended = by;
        result = finish(by);
        result.then(resolveDone, rejectDone);
      }
      return result;
    };
    stopRequested = (by) => void stop(by).catch(() => undefined);
    void cdp.closed.then(() => {
      if (!ended) stopRequested('window-closed');
    });
    if (options.durationMs !== undefined) {
      setTimeout(() => stopRequested('duration'), options.durationMs).unref();
    }
    return { controller, stop, done, kill: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
