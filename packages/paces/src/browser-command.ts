import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectDefaultBrowser } from '@pacesjs/collector-browser';
import type {
  BrowserRecording,
  ControllerState,
  DefaultBrowser,
  RecordOptions,
} from '@pacesjs/collector-browser';
import { recordingToCapture } from '@pacesjs/engine';
import type { BrowserRecordingInput, RawCapture } from '@pacesjs/engine';
import { isHeadless } from '@pacesjs/shared';
import type { Flags } from './args.js';
import type { ProfileControls } from './profile.js';
import type { ProgressState } from './progress.js';

export interface BrowserDeps {
  detect(): Promise<DefaultBrowser>;
  exists(path: string): boolean;
  headless(): boolean;
}

export const realBrowserDeps: BrowserDeps = {
  detect: () => detectDefaultBrowser(),
  exists: existsSync,
  headless: () => isHeadless(),
};

export type ChosenBrowser = { exe: string; name: string } | { exitCode: 2; message: string };

const NOT_CHROMIUM =
  'paces can profile Chrome, Edge, Brave, Vivaldi, Opera and Chromium. Install one, or pass --browser <path>.';

/** Decides which browser to launch, or why none can be: everything that can be known before launching. */
export async function chooseBrowser(flags: Flags, deps: BrowserDeps): Promise<ChosenBrowser> {
  if (deps.headless()) {
    return {
      exitCode: 2,
      message:
        'paces: no display found, so there is no browser window to profile. Run this on a desktop session, or use --attach with a browser started elsewhere.',
    };
  }
  const given = flags.browser.path;
  if (given !== undefined) {
    if (!deps.exists(given)) {
      return {
        exitCode: 2,
        message: `paces: --browser ${given} does not exist. Pass the path to a Chromium browser.`,
      };
    }
    return { exe: given, name: 'the browser you chose' };
  }
  const found = await deps.detect();
  if (found.kind === 'chromium') return { exe: found.exe, name: found.name };
  if (found.kind === 'unsupported') {
    return {
      exitCode: 2,
      message: `paces: the default browser (${found.name}) is not Chromium-based. ${NOT_CHROMIUM}`,
    };
  }
  return {
    exitCode: 2,
    message:
      'paces: could not tell which browser is the default. Pass --browser <path> to a Chromium browser.',
  };
}

const HAS_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const LOCAL_HOST = /^(localhost|\d+\.\d+\.\d+\.\d+|\[[^\]]*\])(:\d+)?(\/|$)/i;
const HOST_PORT = /^[^/:\s]+:\d+(\/|$)/;

/**
 * What the user typed becomes a URL: a full URL stays, `localhost:3000` gets http, a bare host gets
 * https, and a path to a file that exists becomes a file URL.
 */
export function normalizeTarget(input: string, exists: (path: string) => boolean): string {
  if (HAS_SCHEME.test(input) || /^(about|data|chrome):/i.test(input)) return input;
  if (exists(input)) return pathToFileURL(isAbsolute(input) ? input : resolve(input)).href;
  const scheme = LOCAL_HOST.test(input) || HOST_PORT.test(input) ? 'http' : 'https';
  const url = `${scheme}://${input}`;
  return /^[a-z]+:\/\/[^/]+$/i.test(url) ? `${url}/` : url;
}

/** The capture host's options from the command line. */
export function recordOptionsFor(flags: Flags, url: string, exe: string): RecordOptions {
  const b = flags.browser;
  return {
    url,
    exe,
    startPaused: b.paused,
    screenshots: !b.noScreenshots,
    overlay: !b.noOverlay,
    eventMarks: !b.noEventMarks,
    eventText: !b.noEventText,
    keepQuery: b.keepQuery,
    fullTrace: b.fullTrace,
    hiRes: flags.interval !== undefined && flags.interval <= 200,
    cacheCold: b.cache === 'cold',
    ...(b.throttle ? { throttle: b.throttle } : {}),
    ...(flags.duration ? { durationMs: flags.duration * 1000 } : {}),
  };
}

/** The recording as the engine takes it, with where it ran. */
export function toEngineInput(
  recording: BrowserRecording,
  flags: Flags,
  where: { cwd: string; platform: string },
): BrowserRecordingInput {
  return {
    product: recording.product,
    url: recording.url,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    endedBy: recording.endedBy,
    events: recording.events,
    segments: recording.segments,
    marks: recording.marks,
    screenshots: recording.screenshots.frames.map((f) => ({ id: f.id, tsUs: f.tsUs })),
    scripts: recording.scripts,
    sourceMaps: recording.sourceMaps,
    filter: recording.filter,
    firstParty: flags.browser.firstParty,
    platform: where.platform,
    cwd: where.cwd,
    ...(recording.throttle ? { throttle: recording.throttle } : {}),
    ...(recording.cacheCold ? { cacheCold: true } : {}),
  };
}

export function recordingToRawCapture(
  recording: BrowserRecording,
  flags: Flags,
  where: { cwd: string; platform: string },
): RawCapture {
  return recordingToCapture(toEngineInput(recording, flags, where));
}

/** Sources and filmstrip of a recording, as the session writer takes them. */
export function sessionExtras(recording: BrowserRecording): {
  sources: Array<{ path: string; content: Uint8Array }>;
  screenshots: {
    frames: Array<{ id: number; bytes: Uint8Array }>;
    deduplicated: number;
    cap: number;
  };
} {
  return {
    sources: recording.sources.map((s) => ({
      path: s.url,
      content: new TextEncoder().encode(s.text),
    })),
    screenshots: {
      frames: recording.screenshots.frames.map((f) => ({ id: f.id, bytes: f.bytes })),
      deduplicated: recording.screenshots.deduplicated,
      cap: recording.screenshots.cap,
    },
  };
}

/** What the status panel shows for the controller's state. */
export function panelPhase(state: ControllerState): Pick<ProgressState, 'phase' | 'collecting'> {
  switch (state.phase) {
    case 'recording':
      return { phase: 'recording' };
    case 'ready':
      return { phase: 'ready' };
    case 'pausing':
    case 'paused':
      return { phase: 'paused' };
    default: {
      const c = state.collecting;
      const percent = c && c.total > 0 ? Math.min(99, Math.round((c.read / c.total) * 100)) : 0;
      return { phase: 'collecting', collecting: percent };
    }
  }
}

export interface BrowserRunLike {
  controller: {
    mark(label: string, kind?: string): void;
    pause(): Promise<void>;
    resume(): Promise<void>;
    state(): ControllerState;
  };
  stop(by?: 'stop' | 'sigint'): Promise<unknown>;
}

/** The terminal's view of a browser run: the same hotkeys as a Node run, plus pause. */
export function browserControls(
  run: BrowserRunLike,
  now: () => number = Date.now,
): ProfileControls {
  return {
    mark: () => {
      const label = `Mark ${run.controller.state().marks + 1}`;
      run.controller.mark(label);
      return { at: now(), label };
    },
    stop: () => void run.stop('stop'),
    interrupt: () => void run.stop('sigint'),
    togglePause: () => {
      const phase = run.controller.state().phase;
      if (phase === 'recording') void run.controller.pause();
      else if (phase === 'paused' || phase === 'ready') void run.controller.resume();
    },
    browserState: () => panelPhase(run.controller.state()),
    state: () => ({ processes: 0, marks: run.controller.state().marks }),
    stdinUsed: () => false,
    onStdinUsed: () => {},
  };
}
