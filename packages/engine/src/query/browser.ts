// What the browser lanes of the UI draw, as plain data: the filmstrip, the loading milestones, the
// rendering work, the user's input and the pauses. A pure function of the model.

import { INPUT_KIND_NAMES, RENDER_PHASE_NAMES, VITAL_KIND_NAMES } from '../model.js';
import type { ExecutionModel } from '../model.js';
import type { TrackId } from '../raw.js';

export interface BrowserVital {
  timeUs: number;
  name: (typeof VITAL_KIND_NAMES)[number];
  /** Layout shift score or largest paint size; 0 for the rest. */
  value: number;
}

export interface BrowserInput {
  startUs: number;
  endUs: number;
  kind: (typeof INPUT_KIND_NAMES)[number];
  label: string;
  /** Index into the page track's tasks, -1 = none. */
  task: number;
  /** Microseconds to the next paint; -1 when it does not apply. */
  latencyUs: number;
}

export interface BrowserRender {
  startUs: number;
  durUs: number;
  phase: (typeof RENDER_PHASE_NAMES)[number];
  forced: boolean;
}

export interface BrowserTimeline {
  /** The page track the render and input lanes belong to. */
  track: TrackId;
  durationUs: number;
  product: string;
  url: string;
  anchored: boolean;
  clockErrorUs: number;
  throttle: number | null;
  cacheCold: boolean;
  screenshotCount: number;
  screenshots: { time: Float64Array; id: Uint32Array };
  frames: { start: Float64Array; end: Float64Array; dropped: Uint8Array };
  vitals: BrowserVital[];
  inputs: BrowserInput[];
  render: BrowserRender[];
  /** Main-thread tasks over the long-task limit: ticks on the page lane. */
  longTasks: Array<{ startUs: number; durationUs: number; task: number }>;
  recorded: Array<{ startUs: number; endUs: number }>;
  paused: Array<{ startUs: number; endUs: number }>;
}

/** Tasks longer than this are long tasks (the same limit as the main-thread-blocked finding). */
const LONG_TASK_US = 50_000;

export function browserTimeline(model: ExecutionModel): BrowserTimeline | null {
  const page = model.page;
  const track = model.tracks[model.primaryTrack];
  const info = model.meta.browser;
  if (!page || !track || !info) return null;

  const vitals: BrowserVital[] = [];
  for (let i = 0; i < page.vitals.length; i++) {
    vitals.push({
      timeUs: page.vitals.time[i] ?? 0,
      name: VITAL_KIND_NAMES[page.vitals.kind[i] ?? 0] ?? 'navigation',
      value: page.vitals.value[i] ?? 0,
    });
  }

  const inputs: BrowserInput[] = [];
  const table = track.inputs;
  for (let i = 0; i < (table?.length ?? 0); i++) {
    inputs.push({
      startUs: table?.start[i] ?? 0,
      endUs: table?.end[i] ?? 0,
      kind: INPUT_KIND_NAMES[table?.kind[i] ?? 0] ?? 'click',
      label: model.strings[table?.label[i] ?? 0] ?? '',
      task: table?.task[i] ?? -1,
      latencyUs: table?.latency[i] ?? -1,
    });
  }

  const render: BrowserRender[] = [];
  const r = track.render;
  for (let i = 0; i < (r?.length ?? 0); i++) {
    render.push({
      startUs: r?.start[i] ?? 0,
      durUs: r?.dur[i] ?? 0,
      phase: RENDER_PHASE_NAMES[r?.phase[i] ?? 0] ?? 'script',
      forced: r?.forced[i] === 1,
    });
  }

  const longTasks: BrowserTimeline['longTasks'] = [];
  for (let k = 0; k < track.tasks.length; k++) {
    const durationUs = (track.tasks.end[k] ?? 0) - (track.tasks.start[k] ?? 0);
    if (durationUs > LONG_TASK_US) {
      longTasks.push({ startUs: track.tasks.start[k] ?? 0, durationUs, task: k });
    }
  }

  const ranges = (t: { length: number; start: Float64Array; end: Float64Array }) =>
    Array.from({ length: t.length }, (_, i) => ({
      startUs: t.start[i] ?? 0,
      endUs: t.end[i] ?? 0,
    }));

  return {
    track: track.id,
    durationUs: model.meta.durationUs,
    product: info.product,
    url: info.url,
    anchored: info.anchored,
    clockErrorUs: info.clockErrorUs,
    throttle: info.throttle ?? null,
    cacheCold: info.cacheCold === true,
    screenshotCount: page.screenshots.length,
    screenshots: { time: page.screenshots.time, id: page.screenshots.id },
    frames: { start: page.frames.start, end: page.frames.end, dropped: page.frames.dropped },
    vitals,
    inputs,
    render,
    longTasks,
    recorded: ranges(page.recorded),
    paused: ranges(page.paused),
  };
}
