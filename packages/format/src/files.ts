import type {
  BrowserInfo,
  CdpProfile,
  PageEvent,
  RawCapture,
  RawRequest,
  RawTrack,
  RuntimeEvent,
  ScriptInfo,
  TimelineEvent,
} from '@pacesjs/engine';
import { strFromU8, strToU8 } from 'fflate';
import type { Manifest } from './manifest.js';
import { FORMAT_VERSION, SessionFormatError } from './manifest.js';

export type FileMap = Record<string, Uint8Array>;

const SOURCE_MAPS = 'raw/sourcemaps.json';
const PAGE_EVENTS = 'raw/page.events';
const REQUESTS = 'raw/requests.events';
const SCREENSHOT_INDEX = 'raw/screenshots.json';

const ndjson = (rows: unknown[]): Uint8Array =>
  strToU8(rows.map((r) => JSON.stringify(r)).join('\n'));

/** Splits a capture into the zip's raw files. Raw data is stored as collected, never rewritten. */
export function captureToFiles(
  capture: RawCapture,
  engineVersion = '',
): { manifest: Manifest; files: FileMap } {
  const files: FileMap = {};
  for (const track of capture.tracks) {
    const id = track.info.id;
    if (track.cpuProfile) files[`raw/${id}.cpuprofile`] = strToU8(JSON.stringify(track.cpuProfile));
    files[`raw/${id}.scripts`] = strToU8(JSON.stringify(track.scripts));
    files[`raw/${id}.events`] = strToU8(track.events.map((e) => JSON.stringify(e)).join('\n'));
    if (track.deoptTrace) files[`raw/${id}.deopt`] = strToU8(track.deoptTrace);
    if (track.timeline) files[`raw/${id}.timeline`] = ndjson(track.timeline);
  }
  // The spec layout has no slot for host-resolved maps; they are needed to rebuild the model.
  files[SOURCE_MAPS] = strToU8(JSON.stringify(capture.sourceMaps));
  const b = capture.browser;
  if (b) {
    files[PAGE_EVENTS] = ndjson(b.page);
    if (b.requests) files[REQUESTS] = ndjson(b.requests);
    files[SCREENSHOT_INDEX] = strToU8(JSON.stringify(b.screenshots));
  }
  const m = capture.meta;
  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION,
    engineVersion,
    command: m.command,
    cwd: m.cwd,
    nodeVersion: m.nodeVersion,
    platform: m.platform,
    mode: m.mode,
    intervalUs: m.intervalUs,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    endedBy: m.endedBy,
    projectRoot: m.projectRoot,
    tracks: capture.tracks.map((t) => t.info),
    sources: [],
    ...(m.lostTracks && m.lostTracks.length > 0 ? { lostTracks: m.lostTracks } : {}),
    ...(m.marks && m.marks.length > 0 ? { marks: m.marks } : {}),
    ...(b
      ? {
          kind: 'browser' as const,
          browser: {
            product: b.product,
            url: b.url,
            ...(b.firstParty.length > 0 ? { firstParty: b.firstParty } : {}),
            ...(b.cacheCold ? { cacheCold: true } : {}),
          },
          clock: b.clock,
          segments: b.segments,
          ...(b.traceFilter ? { traceFilter: b.traceFilter } : {}),
          ...(b.throttle ? { throttle: { cpu: b.throttle } } : {}),
        }
      : {}),
  };
  return { manifest, files };
}

function parse<T>(files: FileMap, name: string, fallback?: T): T {
  const bytes = files[name];
  if (!bytes) {
    if (fallback !== undefined) return fallback;
    throw new SessionFormatError(`The session is missing ${name}; it may be damaged.`);
  }
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    throw new SessionFormatError(`${name} in the session is not valid JSON; it may be damaged.`);
  }
}

function lines<T>(files: FileMap, name: string): T[] | undefined {
  const bytes = files[name];
  if (!bytes) return undefined;
  return strFromU8(bytes)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function filesToCapture(files: FileMap, manifest: Manifest): RawCapture {
  const tracks: RawTrack[] = manifest.tracks.map((info) => {
    const id = info.id;
    const profile = files[`raw/${id}.cpuprofile`];
    const deopt = files[`raw/${id}.deopt`];
    const timeline = lines<TimelineEvent>(files, `raw/${id}.timeline`);
    const events = strFromU8(files[`raw/${id}.events`] ?? new Uint8Array())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RuntimeEvent);
    return {
      info,
      ...(profile ? { cpuProfile: JSON.parse(strFromU8(profile)) as CdpProfile } : {}),
      scripts: parse<ScriptInfo[]>(files, `raw/${id}.scripts`, []),
      events,
      ...(deopt ? { deoptTrace: strFromU8(deopt) } : {}),
      ...(timeline ? { timeline } : {}),
    };
  });
  const browser: BrowserInfo | undefined =
    manifest.kind === 'browser' && manifest.browser && manifest.clock
      ? {
          product: manifest.browser.product,
          url: manifest.browser.url,
          firstParty: manifest.browser.firstParty ?? [],
          clock: manifest.clock,
          segments: manifest.segments ?? [],
          ...(manifest.throttle ? { throttle: manifest.throttle.cpu } : {}),
          ...(manifest.browser.cacheCold ? { cacheCold: true } : {}),
          page: lines<PageEvent>(files, PAGE_EVENTS) ?? [],
          ...(files[REQUESTS] ? { requests: lines<RawRequest>(files, REQUESTS) ?? [] } : {}),
          screenshots: parse<BrowserInfo['screenshots']>(files, SCREENSHOT_INDEX, []),
          ...(manifest.traceFilter ? { traceFilter: manifest.traceFilter } : {}),
        }
      : undefined;
  return {
    meta: {
      command: manifest.command,
      cwd: manifest.cwd,
      nodeVersion: manifest.nodeVersion,
      platform: manifest.platform,
      mode: manifest.mode,
      intervalUs: manifest.intervalUs,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      endedBy: manifest.endedBy,
      projectRoot: manifest.projectRoot,
      ...(manifest.lostTracks ? { lostTracks: manifest.lostTracks } : {}),
      ...(manifest.marks ? { marks: manifest.marks } : {}),
    },
    ...(browser ? { browser } : {}),
    tracks,
    sourceMaps: parse<Record<string, string>>(files, SOURCE_MAPS, {}),
  };
}
