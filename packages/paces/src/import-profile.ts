import { traceToCapture } from '@pacesjs/engine';
import type { CaptureMeta, CdpProfile, RawCapture, RawTrack, TraceEventIn } from '@pacesjs/engine';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

function isCdpProfile(v: unknown): v is CdpProfile {
  const p = v as Partial<CdpProfile> | null;
  return Boolean(
    p && Array.isArray(p.nodes) && Array.isArray(p.samples) && Array.isArray(p.timeDeltas),
  );
}

function medianDelta(p: CdpProfile): number {
  const sorted = [...p.timeDeltas].filter((d) => d > 0).sort((a, b) => a - b);
  return sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length / 2)] as number) : 1000;
}

/** A single `.cpuprofile`, which is also what `node --cpu-prof` writes. */
function fromCpuProfile(
  profile: CdpProfile,
  options: { name: string; cwd: string; mtimeMs: number; nodeVersion?: string },
): RawCapture {
  if (profile.samples.length === 0) {
    throw new ImportError(`${options.name} has no samples; nothing to show.`);
  }
  const track: RawTrack = {
    info: { id: 'import-1', kind: 'process', label: options.name },
    cpuProfile: profile,
    scripts: [],
    events: [],
  };
  const durationMs = (profile.endTime - profile.startTime) / 1000 || 0;
  const meta: CaptureMeta = {
    command: ['import', options.name],
    cwd: options.cwd,
    nodeVersion: options.nodeVersion ?? 'unknown',
    platform: 'unknown',
    mode: 'default',
    intervalUs: medianDelta(profile),
    startedAt: Math.round(options.mtimeMs - durationMs),
    endedAt: Math.round(options.mtimeMs),
    endedBy: 'exit',
    projectRoot: options.cwd,
  };
  return { meta, tracks: [track], sourceMaps: {} };
}

/**
 * Turns a `.cpuprofile` or a trace JSON (from the DevTools Performance panel, or any Chrome trace)
 * into a capture, named after the file. A trace goes through the same converter as a live browser
 * run, so a page, its iframes and its workers keep their names; without a wall clock in the file,
 * the start time is the file's age.
 */
export function importProfile(
  text: string,
  options: { name: string; cwd: string; mtimeMs: number; nodeVersion?: string },
): RawCapture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError(
      `${options.name} is not valid JSON. paces import reads a .cpuprofile or a DevTools trace JSON file.`,
    );
  }
  if (isCdpProfile(parsed)) return fromCpuProfile(parsed, options);

  const events = Array.isArray(parsed)
    ? (parsed as TraceEventIn[])
    : ((parsed as { traceEvents?: TraceEventIn[] } | null)?.traceEvents ?? undefined);
  if (!events) {
    throw new ImportError(
      `${options.name} is neither a .cpuprofile nor a DevTools trace. Record one with node --cpu-prof or the Chrome Performance panel.`,
    );
  }
  const capture = traceToCapture(events, {
    name: options.name,
    cwd: options.cwd,
    mtimeMs: options.mtimeMs,
  });
  if (capture.tracks.length === 0) {
    throw new ImportError(
      `${options.name} contains no CPU profile samples. Record the trace with the "JavaScript Profiler" / V8 CPU profile enabled.`,
    );
  }
  return capture;
}
