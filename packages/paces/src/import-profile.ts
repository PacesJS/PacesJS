import type {
  CaptureMeta,
  CdpProfile,
  CdpProfileNode,
  RawCapture,
  RawTrack,
} from '@pacesjs/engine';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

interface TraceNode extends CdpProfileNode {
  parent?: number;
}

interface TraceEvent {
  name?: string;
  pid?: number;
  tid?: number;
  id?: string;
  id2?: { local?: string };
  args?: {
    data?: {
      startTime?: number;
      endTime?: number;
      cpuProfile?: {
        nodes?: TraceNode[];
        samples?: number[];
        startTime?: number;
        endTime?: number;
      };
      timeDeltas?: number[];
    };
  };
}

function withChildren(nodes: TraceNode[]): CdpProfileNode[] {
  const byId = new Map<number, CdpProfileNode>();
  const out: CdpProfileNode[] = nodes.map((n) => {
    const node: TraceNode = { ...n, ...(n.children ? { children: [...n.children] } : {}) };
    delete node.parent;
    byId.set(n.id, node);
    return node;
  });
  for (const n of nodes) {
    if (n.parent === undefined) continue;
    const p = byId.get(n.parent);
    if (!p) continue;
    const kids = p.children ?? (p.children = []);
    if (!kids.includes(n.id)) kids.push(n.id);
  }
  return out;
}

function isCdpProfile(v: unknown): v is CdpProfile {
  const p = v as Partial<CdpProfile> | null;
  return Boolean(
    p && Array.isArray(p.nodes) && Array.isArray(p.samples) && Array.isArray(p.timeDeltas),
  );
}

function fromTrace(
  events: TraceEvent[],
): Array<{ key: string; pid: number; tid: number; profile: CdpProfile }> {
  const groups = new Map<
    string,
    {
      pid: number;
      tid: number;
      nodes: TraceNode[];
      samples: number[];
      deltas: number[];
      start?: number;
      end?: number;
    }
  >();
  for (const e of events) {
    const data = e.args?.data;
    if (!data) continue;
    if (e.name !== 'Profile' && e.name !== 'ProfileChunk' && e.name !== 'CpuProfile') continue;
    const key = `${e.pid ?? 0}:${e.tid ?? 0}:${e.id ?? e.id2?.local ?? ''}`;
    const g = groups.get(key) ?? {
      pid: e.pid ?? 0,
      tid: e.tid ?? 0,
      nodes: [],
      samples: [],
      deltas: [],
    };
    groups.set(key, g);
    if (e.name === 'Profile' && data.startTime !== undefined) g.start = data.startTime;
    const cp = data.cpuProfile;
    if (cp) {
      if (cp.nodes) g.nodes.push(...cp.nodes);
      if (cp.samples) g.samples.push(...cp.samples);
      if (cp.startTime !== undefined) g.start = cp.startTime;
      if (cp.endTime !== undefined) g.end = cp.endTime;
    }
    if (data.timeDeltas) g.deltas.push(...data.timeDeltas);
  }
  const out = [];
  for (const [key, g] of groups) {
    if (g.nodes.length === 0 || g.samples.length === 0) continue;
    const start = g.start ?? 0;
    const total = g.deltas.reduce((a, b) => a + b, 0);
    out.push({
      key,
      pid: g.pid,
      tid: g.tid,
      profile: {
        nodes: withChildren(g.nodes),
        startTime: start,
        endTime: g.end ?? start + total,
        samples: g.samples,
        timeDeltas: g.deltas,
      },
    });
  }
  return out;
}

function medianDelta(p: CdpProfile): number {
  const sorted = [...p.timeDeltas].filter((d) => d > 0).sort((a, b) => a - b);
  return sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length / 2)] as number) : 1000;
}

/**
 * Turns a `.cpuprofile` (also what `node --cpu-prof` writes) or a DevTools trace JSON into a capture.
 * Only the CPU samples exist in these files, so the capture has no GC, loop or request events.
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
  const profiles: Array<{ id: string; label: string; pid: number; profile: CdpProfile }> = [];
  if (isCdpProfile(parsed)) {
    profiles.push({ id: 'import-1', label: options.name, pid: 0, profile: parsed });
  } else {
    const events = Array.isArray(parsed)
      ? (parsed as TraceEvent[])
      : ((parsed as { traceEvents?: TraceEvent[] } | null)?.traceEvents ?? undefined);
    if (!events) {
      throw new ImportError(
        `${options.name} is neither a .cpuprofile nor a DevTools trace. Record one with node --cpu-prof or the Chrome Performance panel.`,
      );
    }
    const found = fromTrace(events);
    if (found.length === 0) {
      throw new ImportError(
        `${options.name} contains no CPU profile samples. Record the trace with the "JavaScript Profiler" / V8 CPU profile enabled.`,
      );
    }
    found.forEach((f, i) =>
      profiles.push({
        id: `import-${i + 1}`,
        label: `${options.name} · pid ${f.pid} tid ${f.tid}`,
        pid: f.pid,
        profile: f.profile,
      }),
    );
  }
  for (const p of profiles) {
    if (!isCdpProfile(p.profile) || p.profile.samples.length === 0) {
      throw new ImportError(`${options.name} has no samples; nothing to show.`);
    }
  }

  const tracks: RawTrack[] = profiles.map((p) => ({
    info: { id: p.id, kind: 'process', label: p.label, ...(p.pid ? { pid: p.pid } : {}) },
    cpuProfile: p.profile,
    scripts: [],
    events: [],
  }));
  const durationMs =
    Math.max(...profiles.map((p) => (p.profile.endTime - p.profile.startTime) / 1000)) || 0;
  const meta: CaptureMeta = {
    command: ['import', options.name],
    cwd: options.cwd,
    nodeVersion: options.nodeVersion ?? 'unknown',
    platform: 'unknown',
    mode: 'default',
    intervalUs: medianDelta((profiles[0] as { profile: CdpProfile }).profile),
    startedAt: Math.round(options.mtimeMs - durationMs),
    endedAt: Math.round(options.mtimeMs),
    endedBy: 'exit',
    projectRoot: options.cwd,
  };
  return { meta, tracks, sourceMaps: {} };
}
