import type { TraceEvent, TraceFilterStats } from './trace.js';

export const TRACE_FILTER_VERSION = 1;

/** Categories that carry only the browser's scheduling and IPC bookkeeping. */
export const EXCLUDED_CATEGORIES = ['toplevel', 'base', 'mojom'];

/**
 * Event names that survive the category filter and still carry no JavaScript information. Seeded
 * from the bytes per name in recorded zoo traces (`scripts/gen-browser-fixtures.mjs` prints what
 * each rule dropped); the browser's `toplevel` bookkeeping never appears because that category is
 * not requested.
 */
export const TRACE_NOISE_NAMES: readonly string[] = [
  'V8.BytecodeBudgetInterrupt',
  'V8.BytecodeBudgetInterruptWithStackCheck',
  'V8.GC_HEAP_ENSURE_SWEEPING_COMPLETED',
  'V8.GC_TIME_TO_SAFEPOINT',
  'V8.StackGuard',
  'V8.HandleInterrupts',
  'V8.InvokeApiInterruptCallbacks',
  'UpdateCounters',
  'ScheduleStyleRecalculation',
  'InvalidateLayout',
  'PipelineReporter',
  'BeginImplFrameToSendBeginMainFrame',
  'SendBeginMainFrameToCommit',
  'EndCommitToActivation',
  'Activation',
  'EndActivateToSubmitCompositorFrame',
  'SubmitCompositorFrameToPresentationCompositorFrame',
  'SubmitToReceiveCompositorFrame',
  'ReceiveCompositorFrameToStartDraw',
  'StartDrawToSwapStart',
  'Swap',
  'SwapEndToPresentationCompositorFrame',
  'HTMLDocumentParser::DocumentElementAvailable',
  'DecodedDataDocumentParser::AppendBytes',
];

/** Families of loader and cache bookkeeping events, dropped by prefix. */
export const TRACE_NOISE_PREFIXES: readonly string[] = [
  'FrameLoader:',
  'DocumentLoader::',
  'BackForwardCache',
  'PaintTimingVisualizer::',
];

/** A task shorter than this tells nothing about where time went. */
export const MIN_RUN_TASK_US = 100;

/** Events kept from processes that are not renderers: the frame pipeline and the filmstrip. */
const OTHER_PROCESS_ALLOWLIST = new Set([
  'Screenshot',
  'DrawFrame',
  'BeginFrame',
  'BeginMainThreadFrame',
  'DroppedFrame',
  'ActivateLayerTree',
  'TracingStartedInBrowser',
  'FrameCommittedInBrowser',
  'TimeStamp',
]);

const NOISE = new Set(TRACE_NOISE_NAMES);
const isNoise = (name: string): boolean =>
  NOISE.has(name) || TRACE_NOISE_PREFIXES.some((p) => name.startsWith(p));
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_SCRUB_DEPTH = 8;

/** A URL without its query string and fragment; anything that is not a URL comes back unchanged. */
export function scrubUrl(value: string): string {
  if (!URL_LIKE.test(value)) return value;
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubUrl(value);
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubValue(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) record[key] = scrubValue(record[key], depth + 1);
  return record;
}

export interface TraceFilterOptions {
  keepQuery: boolean;
  /** Keep everything: no category knowledge, no name list, no process rule. */
  full: boolean;
}

export interface TraceFilter {
  /** Filters a batch of events as they stream in; returns the ones to keep. */
  push(events: TraceEvent[]): TraceEvent[];
  stats(): TraceFilterStats;
}

export function createTraceFilter(options: TraceFilterOptions): TraceFilter {
  const renderer = new Map<number, boolean>();
  const droppedByName: Record<string, number> = {};
  let kept = 0;
  let dropped = 0;

  const drop = (name: string): void => {
    dropped++;
    droppedByName[name] = (droppedByName[name] ?? 0) + 1;
  };

  return {
    push(events) {
      const out: TraceEvent[] = [];
      for (const e of events) {
        if (e.ph === 'M') {
          if (e.name === 'process_name') {
            const name = String((e.args as { name?: unknown } | undefined)?.name ?? '');
            renderer.set(e.pid, /renderer/i.test(name));
          }
          kept++;
          out.push(e);
          continue;
        }
        if (!options.full) {
          if (isNoise(e.name) || (e.name === 'RunTask' && (e.dur ?? 0) < MIN_RUN_TASK_US)) {
            drop(e.name);
            continue;
          }
          if (renderer.get(e.pid) === false && !OTHER_PROCESS_ALLOWLIST.has(e.name)) {
            drop(e.name);
            continue;
          }
        }
        if (!options.keepQuery && e.args) scrubValue(e.args, 0);
        kept++;
        out.push(e);
      }
      return out;
    },
    stats: () => ({
      version: TRACE_FILTER_VERSION,
      excludedCategories: options.full ? [] : EXCLUDED_CATEGORIES,
      droppedByName: { ...droppedByName },
      keptEvents: kept,
      droppedEvents: dropped,
    }),
  };
}
