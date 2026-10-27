import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDetached } from '@pacesjs/shared';
import { connectCdp, discoverBrowserSocket } from './attach.js';
import type { CdpClient, CdpEvent, CdpLike } from './cdp-pipe.js';
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
import { createScreencast } from './screencast.js';
import { DEFAULT_SOURCE_LIMITS, createSourceCollector } from './sources.js';
import type { CollectedSource, SourceWarning } from './sources.js';
import { createTargetManager } from './targets.js';
import type { ScriptRecord } from './targets.js';
import { scrubUrl } from './trace-filter.js';

export type EndedBy = 'stop' | 'sigint' | 'duration' | 'window-closed';

export interface RecordOptions extends ControllerOptions {
  url: string;
  /** Chromium executable. Not used when joining a running browser. */
  exe: string;
  /** Join a browser started with `--remote-debugging-port` instead of launching one. */
  attach?: { port: number };
  overlay: boolean;
  eventMarks: boolean;
  eventText: boolean;
  /** Stop after this many milliseconds. */
  durationMs?: number;
  /** Stop shortly after the page has loaded, or after the network has gone quiet. */
  until?: 'load' | 'idle';
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
  /** The pages and out-of-process iframes that were recorded (their ids are frame ids). */
  targets: Array<{ id: string; type: string; url: string }>;
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
  /** The debugging session of the first page, for tests that need to act on it. */
  pageSession: string;
  /** The browser's debugging pipe, for tests that need to do what a user does (close the window). */
  cdp: CdpLike;
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

/** After the load event, a moment for the last work to show up in the trace. */
const SETTLE_MS = 500;
/** A page that never loads or never goes quiet must not hold the run open for ever. */
const UNTIL_LIMIT_MS = 60_000;

const CHROMIUM_PRODUCT = /Chrome|Edg|Brave|Chromium|OPR|Opera|Vivaldi/i;

/** `Browser.getVersion` is the check that matters: a registry entry can name any executable. */
export function isChromiumProduct(product: string): boolean {
  return CHROMIUM_PRODUCT.test(product);
}

interface BridgeMessage {
  t?: string;
  frame?: string;
  seq?: string;
  at?: number;
  kind?: string;
  label?: string;
  action?: string;
}

interface Host {
  cdp: CdpClient;
  exited: Promise<unknown>;
  /** True when paces started the browser, and so closes it; false for one the user started. */
  owned: boolean;
  dispose(): void;
}

function launchHost(options: RecordOptions): Host {
  const profileDir = mkdtempSync(join(tmpdir(), 'paces-browser-'));
  const browser: LaunchedBrowser = launchBrowser({
    exe: options.exe,
    profileDir,
    ...(options.windowSize ? { windowSize: options.windowSize } : {}),
  });
  return {
    cdp: browser.client,
    exited: browser.exited,
    owned: true,
    dispose: () => {
      browser.kill();
      removeDetached(profileDir);
    },
  };
}

/** A browser the user started with a debugging port: joined, never closed. */
async function joinHost(port: number): Promise<Host> {
  const cdp = await connectCdp(await discoverBrowserSocket(port));
  return { cdp, exited: cdp.closed, owned: false, dispose: () => cdp.disconnect() };
}

/** Pages worth profiling: not the browser's own pages, DevTools or extensions. */
const OWN_PAGE = /^(devtools|chrome|edge|chrome-extension|chrome-untrusted):/i;

/** The page of a joined browser: a new tab for a URL, else the first ordinary tab the user has open. */
async function pageToJoin(
  cdp: CdpClient,
  wantsUrl: boolean,
): Promise<{ id: string; created: boolean }> {
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos?: Array<{ type: string; targetId: string; url: string }>;
  };
  const usable = (targetInfos ?? []).find((t) => t.type === 'page' && !OWN_PAGE.test(t.url));
  if (usable && !wantsUrl) return { id: usable.targetId, created: false };
  const made = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  return { id: made.targetId, created: true };
}

/** The first page of a browser paces launched, by event rather than a single read of the target list. */
function waitForFirstPage(cdp: CdpClient): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
}

export async function startRecording(options: RecordOptions): Promise<BrowserRun> {
  const host = options.attach ? await joinHost(options.attach.port) : launchHost(options);
  const { cdp } = host;
  const cleanup = (): void => host.dispose();

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

    // Scripts are read as they are parsed: when the user closes the window, their pages are gone.
    const collector = createSourceCollector(cdp, DEFAULT_SOURCE_LIMITS);
    const pageSessions = new Set<string>();
    // What was recorded: the frames whose processes are kept when the trace is cut down.
    const targets = new Map<string, { type: string; url: string }>();
    const ownFrames = new Set<string>();
    const noteTarget = (
      info: { targetId?: string; type?: string; url?: string } | undefined,
    ): void => {
      if (!info?.targetId || (info.type !== 'page' && info.type !== 'iframe')) return;
      targets.set(info.targetId, { type: info.type, url: info.url ?? '' });
      ownFrames.add(info.targetId);
    };
    cdp.onEvent((e: CdpEvent) => {
      const info = (
        e.params as { targetInfo?: { targetId?: string; type?: string; url?: string } } | undefined
      )?.targetInfo;
      if (e.method === 'Target.attachedToTarget') noteTarget(info);
      else if (
        e.method === 'Target.targetInfoChanged' &&
        info?.targetId &&
        targets.has(info.targetId)
      ) {
        noteTarget(info);
      }
    });
    const screencast = createScreencast({
      cdp,
      addScreenshot: (epochMs, bytes) => live.controller?.addScreenshot(epochMs, bytes),
    });

    const manager = createTargetManager({
      cdp,
      injectSource,
      keepQuery: options.keepQuery,
      onScript: (script) => collector.add(script),
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

    // The first page: a new one for a launched browser (wait for it by event rather than reading the
    // target list once), or the user's own tab in one that was joined.
    let createdTab: string | undefined;
    let pageTarget: string;
    if (host.owned) pageTarget = await waitForFirstPage(cdp);
    else {
      const joined = await pageToJoin(cdp, options.url !== '');
      pageTarget = joined.id;
      if (joined.created) createdTab = joined.id;
    }
    const attachedPages = new Set<string>([pageTarget]);
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId: pageTarget,
      flatten: true,
    })) as { sessionId: string };
    topSessions.add(sessionId);
    pageSessions.add(sessionId);
    noteTarget({ targetId: pageTarget, type: 'page', url: '' });
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
            .then(async (r) => {
              const session = (r as { sessionId: string }).sessionId;
              pageSessions.add(session);
              noteTarget({ targetId: info.targetId, type: 'page', url: '' });
              await manager.configure(session, 'page', false, info.targetId);
              await screencast.add(session);
            })
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
      } else if (
        options.until === 'load' &&
        e.method === 'Page.loadEventFired' &&
        e.sessionId === sessionId
      ) {
        setTimeout(() => stopRequested('duration'), SETTLE_MS).unref();
      } else if (
        options.until === 'idle' &&
        e.method === 'Page.lifecycleEvent' &&
        e.sessionId === sessionId &&
        (e.params as { name?: string } | undefined)?.name === 'networkIdle'
      ) {
        setTimeout(() => stopRequested('duration'), SETTLE_MS).unref();
      } else if (e.method === 'Page.navigatedWithinDocument' && options.eventMarks) {
        const url = (e.params as { url?: string } | undefined)?.url;
        if (url && live.controller?.state().phase === 'recording') {
          live.controller.mark(scrubUrl(url), 'navigate');
        }
      }
    });

    if (options.until === 'idle') {
      await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
    }
    if (options.throttle && options.throttle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.throttle }, sessionId);
    }
    if (options.cacheCold) {
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    }

    let capturing = false;
    const controller = createSessionController({
      cdp,
      options,
      ownFrames: () => ownFrames,
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
        // Frames are taken only while recording: a pause stops them, so a login is never captured.
        if (!options.screenshots) return;
        const recordingNow = state.phase === 'recording';
        if (recordingNow && !capturing) {
          capturing = true;
          void screencast.start([...pageSessions]);
        } else if (!recordingNow && capturing) {
          capturing = false;
          void screencast.stop();
        }
      },
    });
    live.controller = controller;
    await controller.start();
    // Every time in the model counts from here. Starting the trace can take seconds on a busy
    // machine, and none of that time was recorded: counting from before it leaves a blank start.
    const startedAt = Date.now();
    if (options.url) await cdp.send('Page.navigate', { url: options.url }, sessionId);

    const finish = async (by: EndedBy): Promise<BrowserRecording> => {
      // The run ends when it was asked to; collecting the trace afterwards is not part of it.
      const stoppedAt = Date.now();
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
            'The browser did not hand over its last trace segment: it was closed or crashed.',
          ],
        });
      }
      const { sources, sourceMaps, warnings: sourceWarnings } = await collector.finish();
      warnings.push(...sourceWarnings);
      if (host.owned) {
        await cdp.send('Browser.close').catch(() => undefined);
        await Promise.race([
          host.exited,
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      } else {
        // The user's browser stays open, as it was: no slowdown left on the tab, no tab of ours.
        if (options.throttle) {
          await cdp
            .send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId)
            .catch(() => undefined);
        }
        if (options.cacheCold) {
          await cdp
            .send('Network.setCacheDisabled', { cacheDisabled: false }, sessionId)
            .catch(() => undefined);
        }
        if (createdTab)
          await cdp.send('Target.closeTarget', { targetId: createdTab }).catch(() => undefined);
      }
      cleanup();
      return {
        ...recording,
        product,
        url: scrubUrl(options.url),
        scripts: manager.scripts(),
        targets: [...targets].map(([id, t]) => ({
          id,
          type: t.type,
          url: options.keepQuery ? t.url : scrubUrl(t.url),
        })),
        sources,
        sourceMaps,
        warnings,
        endedBy: by,
        startedAt,
        endedAt: stoppedAt,
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
    const limit = options.durationMs ?? (options.until ? UNTIL_LIMIT_MS : undefined);
    if (limit !== undefined) setTimeout(() => stopRequested('duration'), limit).unref();
    return { controller, cdp, pageSession: sessionId, stop, done, kill: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
