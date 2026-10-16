import type { ExecutionModel, Finding, Track } from '@pacesjs/engine';

/** Tiny declarative model builder for view-model tests. Times in milliseconds. */
export interface N {
  fn: string;
  origin?: 'user' | 'dep' | 'framework' | 'node' | 'native' | 'idle' | 'gc';
  pkg?: string;
  plumbing?: boolean;
  file?: string;
  line?: number;
  /** Self time in ms. */
  self?: number;
  kids?: N[];
}

export interface BuildOptions {
  /** Each root is one task (children of the synthetic root). */
  roots: N[];
  intervalUs?: number;
  findings?: Finding[];
  trackId?: string;
  projectRoot?: string;
}

const ORIGIN_ID = { user: 0, dep: 1, framework: 2, node: 3, native: 4, idle: 5, gc: 6 } as const;

export function buildModel(opts: BuildOptions): ExecutionModel {
  const intervalUs = opts.intervalUs ?? 1000;
  const strings: string[] = [''];
  const intern = (s: string): number => {
    const i = strings.indexOf(s);
    if (i >= 0) return i;
    strings.push(s);
    return strings.length - 1;
  };
  const fnKey = new Map<string, number>();
  const fns: Array<{
    name: number;
    file: number;
    line: number;
    origin: number;
    pkg: number;
    plumbing: number;
  }> = [];
  const fnId = (n: N): number => {
    const k = `${n.fn}|${n.file ?? ''}|${n.line ?? 0}|${n.pkg ?? ''}`;
    let id = fnKey.get(k);
    if (id === undefined) {
      id = fns.length;
      fnKey.set(k, id);
      fns.push({
        name: intern(n.fn),
        file: n.file ? intern(n.file) : 0,
        line: n.line ?? 0,
        origin: ORIGIN_ID[n.origin ?? 'user'],
        pkg: n.pkg ? intern(n.pkg) : 0,
        plumbing: n.plumbing ? 1 : 0,
      });
    }
    return id;
  };

  const parent: number[] = [];
  const nfn: number[] = [];
  const depth: number[] = [];
  const selfUs: number[] = [];
  const subtreeEnd: number[] = [];
  const sampleTime: number[] = [];
  const sampleNode: number[] = [];
  const spans: Array<{
    node: number;
    fn: number;
    start: number;
    end: number;
    depth: number;
    parent: number;
  }> = [];
  const tasks: Array<{
    start: number;
    end: number;
    label: number;
    spanStart: number;
    spanEnd: number;
    busy: number;
  }> = [];
  let clock = 0;

  const emit = (node: number, ms: number): void => {
    const count = Math.round((ms * 1000) / intervalUs);
    for (let i = 0; i < count; i++) {
      sampleTime.push(clock);
      sampleNode.push(node);
      clock += intervalUs;
    }
    selfUs[node] = (selfUs[node] ?? 0) + count * intervalUs;
  };

  const add = (n: N, par: number, d: number, spanParent: number): void => {
    const id = parent.length;
    parent.push(par);
    nfn.push(fnId(n));
    depth.push(d);
    selfUs.push(0);
    subtreeEnd.push(id + 1);
    const start = clock;
    const spanIndex = spans.length;
    spans.push({
      node: id,
      fn: nfn[id] as number,
      start,
      end: start,
      depth: d,
      parent: spanParent,
    });
    const self = n.self ?? 0;
    const pre = Math.floor(self / 2);
    emit(id, pre);
    for (const k of n.kids ?? []) add(k, id, d + 1, spanIndex);
    emit(id, self - pre);
    (spans[spanIndex] as { end: number }).end = clock;
    subtreeEnd[id] = parent.length;
  };

  add({ fn: '(root)', origin: 'native' }, -1, 0, -1);
  for (const r of opts.roots) {
    const spanStart = spans.length;
    const start = clock;
    add(r, 0, 1, -1);
    (spans[spanStart] as { parent: number }).parent = -1;
    tasks.push({
      start,
      end: clock,
      label: intern(r.fn),
      spanStart,
      spanEnd: spans.length,
      busy: clock - start,
    });
    clock += 2 * intervalUs;
  }
  subtreeEnd[0] = parent.length;
  const total = new Float64Array(parent.length);
  for (let i = parent.length - 1; i >= 0; i--) {
    total[i] = (total[i] ?? 0) + (selfUs[i] ?? 0);
    const p = parent[i] ?? -1;
    if (p >= 0) total[p] = (total[p] ?? 0) + (total[i] ?? 0);
  }

  const n = fns.length;
  const spanOrder = spans
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.start - b.s.start || a.s.depth - b.s.depth);
  const remap = new Map(spanOrder.map((x, newIndex) => [x.i, newIndex]));
  const orderedSpans = spanOrder.map((x) => ({
    ...x.s,
    parent: x.s.parent < 0 ? -1 : (remap.get(x.s.parent) ?? -1),
  }));
  const taskSpan = tasks.map((t) => ({
    ...t,
    spanStart: remap.get(t.spanStart) ?? 0,
    spanEnd: (remap.get(t.spanStart) ?? 0) + (t.spanEnd - t.spanStart),
  }));

  const track: Track = {
    id: opts.trackId ?? 'main',
    kind: 'process',
    label: 'main',
    callTree: {
      length: parent.length,
      parent: Int32Array.from(parent),
      fn: Uint32Array.from(nfn),
      depth: Uint16Array.from(depth),
      subtreeEnd: Uint32Array.from(subtreeEnd),
      self: Float64Array.from(selfUs),
      total,
    },
    samples: {
      length: sampleTime.length,
      time: Float64Array.from(sampleTime),
      node: Uint32Array.from(sampleNode),
      dur: new Float64Array(sampleTime.length).fill(intervalUs),
    },
    spans: {
      length: orderedSpans.length,
      node: Uint32Array.from(orderedSpans.map((s) => s.node)),
      fn: Uint32Array.from(orderedSpans.map((s) => s.fn)),
      start: Float64Array.from(orderedSpans.map((s) => s.start)),
      end: Float64Array.from(orderedSpans.map((s) => s.end)),
      depth: Uint16Array.from(orderedSpans.map((s) => s.depth)),
      parent: Int32Array.from(orderedSpans.map((s) => s.parent)),
    },
    tasks: {
      length: taskSpan.length,
      start: Float64Array.from(taskSpan.map((t) => t.start)),
      end: Float64Array.from(taskSpan.map((t) => t.end)),
      kind: Uint8Array.from(taskSpan.map(() => 1)),
      label: Uint32Array.from(taskSpan.map((t) => t.label)),
      spanStart: Uint32Array.from(taskSpan.map((t) => t.spanStart)),
      spanEnd: Uint32Array.from(taskSpan.map((t) => t.spanEnd)),
      busy: Float64Array.from(taskSpan.map((t) => t.busy)),
    },
    asyncEdges: {
      length: 0,
      from: new Uint32Array(0),
      to: new Uint32Array(0),
      waitUs: new Float64Array(0),
    },
    events: {
      gc: { time: new Float64Array(0), duration: new Float64Array(0), kind: new Uint8Array(0) },
      loop: {
        time: new Float64Array(0),
        p50: new Float64Array(0),
        p99: new Float64Array(0),
        max: new Float64Array(0),
      },
      requests: {
        time: new Float64Array(0),
        duration: new Float64Array(0),
        label: new Uint32Array(0),
        status: new Uint16Array(0),
      },
    },
    lines: { offset: new Uint32Array(n + 1), line: new Uint32Array(0), self: new Float64Array(0) },
    agg: {
      fnSelf: new Float64Array(n),
      fnTotal: new Float64Array(n),
      fnCalls: new Uint32Array(n),
      edges: {
        length: 0,
        caller: new Uint32Array(0),
        callee: new Uint32Array(0),
        weight: new Float64Array(0),
        count: new Uint32Array(0),
      },
    },
    fnIds: Uint32Array.from(fns.map((_, i) => i)),
    busyUs: clock,
    durationUs: clock,
  };

  return {
    meta: {
      command: ['node', 'server.js'],
      cwd: '/p',
      nodeVersion: 'v22',
      platform: 'linux',
      mode: 'default',
      intervalUs,
      startedAt: 0,
      endedAt: clock / 1000,
      endedBy: 'exit',
      projectRoot: opts.projectRoot ?? '/p',
      precisionUs: intervalUs,
      durationUs: clock,
      engineVersion: 'test',
      warnings: [],
    },
    strings,
    functions: {
      length: n,
      name: Uint32Array.from(fns.map((f) => f.name)),
      file: Uint32Array.from(fns.map((f) => f.file)),
      line: Uint32Array.from(fns.map((f) => f.line)),
      col: new Uint32Array(n),
      origin: Uint8Array.from(fns.map((f) => f.origin)),
      pkg: Uint32Array.from(fns.map((f) => f.pkg)),
      plumbing: Uint8Array.from(fns.map((f) => f.plumbing)),
      mapped: new Uint8Array(n),
      mapMissing: new Uint8Array(n),
    },
    tracks: [track],
    packages: {
      length: 0,
      name: new Uint32Array(0),
      self: new Float64Array(0),
      total: new Float64Array(0),
    },
    taskKinds: {
      count: new Uint32Array(7),
      busy: new Float64Array(7),
      plumbing: new Float64Array(7),
    },
    findings: opts.findings ?? [],
  };
}

/** The ORDERS-SERVER-shaped scenario in miniature: one GET /orders task. */
export const ORDERS: N[] = [
  {
    fn: 'GET /orders',
    origin: 'dep',
    pkg: 'express',
    self: 2,
    kids: [
      {
        fn: 'getOrders',
        file: 'src/routes/orders.ts',
        line: 18,
        self: 4,
        kids: [
          { fn: 'authenticate', file: 'src/middleware/auth.ts', line: 9, self: 3 },
          {
            fn: 'renderInvoice',
            file: 'src/render/invoice.ts',
            line: 24,
            self: 6,
            kids: [
              {
                fn: 'loadTemplate',
                file: 'src/render/template.ts',
                line: 38,
                self: 9,
                kids: [{ fn: 'fs.readFileSync', origin: 'node', self: 37 }],
              },
              {
                fn: 'buildInvoiceRows',
                file: 'src/render/invoice.ts',
                line: 71,
                self: 20,
                kids: [
                  { fn: 'validate', origin: 'dep', pkg: 'ajv', self: 10 },
                  { fn: 'validateStep', origin: 'dep', pkg: 'ajv', plumbing: false, self: 5 },
                  {
                    fn: 'lineTotal',
                    file: 'src/util/money.ts',
                    line: 30,
                    self: 8,
                    kids: [{ fn: 'Intl.NumberFormat', origin: 'native', self: 12 }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  { fn: 'flushMetrics', file: 'src/metrics.ts', line: 12, self: 5 },
];
