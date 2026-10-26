import type { CdpProfile, RawCapture, RawTrack, RuntimeEvent, ScriptInfo } from '@pacesjs/engine';
import { strFromU8, strToU8 } from 'fflate';
import type { Manifest } from './manifest.js';
import { FORMAT_VERSION, SessionFormatError } from './manifest.js';

export type FileMap = Record<string, Uint8Array>;

const SOURCE_MAPS = 'raw/sourcemaps.json';

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
  }
  // The spec layout has no slot for host-resolved maps; they are needed to rebuild the model.
  files[SOURCE_MAPS] = strToU8(JSON.stringify(capture.sourceMaps));
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

export function filesToCapture(files: FileMap, manifest: Manifest): RawCapture {
  const tracks: RawTrack[] = manifest.tracks.map((info) => {
    const id = info.id;
    const profile = files[`raw/${id}.cpuprofile`];
    const deopt = files[`raw/${id}.deopt`];
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
    };
  });
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
    tracks,
    sourceMaps: parse<Record<string, string>>(files, SOURCE_MAPS, {}),
  };
}
