// Tiny synthetic captures for edge cases of a single pass. Behavior on real programs is tested
// against the recorded zoo fixtures instead.
import type {
  CdpProfileNode,
  RawCapture,
  RawTrack,
  RuntimeEvent,
  ScriptInfo,
} from '../../src/raw.js';

export interface FrameSpec {
  name: string;
  url?: string;
  line?: number;
  col?: number;
}
export type StackSpec = Array<string | FrameSpec>;

export type Step =
  | { stack: StackSpec; samples: number; ticks?: Array<{ line: number; ticks: number }> }
  | { idle: number };

export interface SynthOptions {
  intervalUs?: number;
  events?: RuntimeEvent[];
  scripts?: ScriptInfo[];
  sourceMaps?: Record<string, string>;
  projectRoot?: string;
  startedAt?: number;
  /** Extra tracks (e.g. a worker) built from their own steps. */
  extraTracks?: Array<{ id: string; steps: Step[] }>;
}

const DEFAULT_URL = 'file:///project/src/app.js';

function frameOf(spec: string | FrameSpec): Required<FrameSpec> {
  if (typeof spec === 'string') return { name: spec, url: DEFAULT_URL, line: 0, col: 0 };
  return {
    name: spec.name,
    url: spec.url ?? DEFAULT_URL,
    line: spec.line ?? 0,
    col: spec.col ?? 0,
  };
}

function buildTrack(
  id: string,
  steps: Step[],
  interval: number,
  events: RuntimeEvent[],
  scripts: ScriptInfo[],
) {
  const nodes: CdpProfileNode[] = [
    {
      id: 1,
      callFrame: {
        functionName: '(root)',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1,
      },
      children: [],
    },
  ];
  const byKey = new Map<string, number>();
  const samples: number[] = [];
  const startTime = 5_000_000;
  const nodeFor = (stack: StackSpec): number => {
    let parent = 1;
    for (const spec of stack) {
      const f = frameOf(spec);
      const key = `${parent}|${f.name}|${f.url}|${f.line}|${f.col}`;
      let id2 = byKey.get(key);
      if (id2 === undefined) {
        id2 = nodes.length + 1;
        nodes.push({
          id: id2,
          callFrame: {
            functionName: f.name,
            scriptId: '1',
            url: f.url,
            lineNumber: f.line,
            columnNumber: f.col,
          },
          children: [],
        });
        byKey.set(key, id2);
        nodes[parent - 1]?.children?.push(id2);
      }
      parent = id2;
    }
    return parent;
  };
  for (const step of steps) {
    if ('idle' in step) {
      const n = nodeFor(['(idle)']);
      for (let i = 0; i < step.idle; i++) samples.push(n);
    } else {
      const n = nodeFor(step.stack);
      if (step.ticks) {
        const node = nodes[n - 1];
        if (node) node.positionTicks = step.ticks;
      }
      for (let i = 0; i < step.samples; i++) samples.push(n);
    }
  }
  const timeDeltas = samples.map(() => interval);
  const raw: RawTrack = {
    info: { id, kind: 'process', label: id },
    cpuProfile: {
      nodes,
      startTime,
      endTime: startTime + samples.length * interval,
      samples,
      timeDeltas,
    },
    scripts,
    events,
  };
  return raw;
}

export function synthCapture(steps: Step[], options: SynthOptions = {}): RawCapture {
  const interval = options.intervalUs ?? 1000;
  const total = steps.reduce((n, s) => n + ('idle' in s ? s.idle : s.samples), 0) * interval;
  const startedAt = options.startedAt ?? 1_800_000_000_000;
  const main = buildTrack('p1', steps, interval, options.events ?? [], options.scripts ?? []);
  const extra = (options.extraTracks ?? []).map((t) => buildTrack(t.id, t.steps, interval, [], []));
  return {
    meta: {
      command: ['node', 'app.js'],
      cwd: options.projectRoot ?? '/project',
      nodeVersion: 'v24.0.0',
      platform: 'linux',
      mode: 'default',
      intervalUs: interval,
      startedAt,
      endedAt: startedAt + total / 1000,
      endedBy: 'exit',
      projectRoot: options.projectRoot ?? '/project',
    },
    tracks: [main, ...extra],
    sourceMaps: options.sourceMaps ?? {},
  };
}
