// Pass 6 for browser pages: tasks are the browser's own `RunTask` events, so their edges are exact,
// and each is named for what ran inside it (a click, a timer, parsing, a script, rendering).

import { Origin, TaskKind } from '../model.js';
import type { TaskKindId, TaskTable } from '../model.js';
import { lowerBound } from '../util/search.js';
import { namesOf, subjectOf } from './tasks.js';
import type { TaskInput, TaskResult } from './tasks.js';
import type { PassContext } from './types.js';

/** An event of the main thread, in model time (microseconds from the start of the run). */
export interface ModelEvent {
  name: string;
  start: number;
  dur: number;
  arg?: string;
}

export interface BrowserTaskInput extends TaskInput {
  timeline: ModelEvent[];
  /** What the user did, in model time: used to name the task that handled it. */
  marks: Array<{ time: number; label: string; kind: string }>;
}

/** Events a person causes; their handler is the task. */
const INPUT_EVENTS = new Set([
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'keypress',
  'input',
  'beforeinput',
  'change',
  'submit',
  'wheel',
  'touchstart',
  'touchend',
  'dragstart',
  'drop',
]);
const MARK_KINDS = new Set(['click', 'submit', 'change', 'key', 'typing']);
const SCRIPT_EVENTS = new Set(['EvaluateScript', 'FunctionCall', 'RunMicrotasks', 'EventDispatch']);
const RENDER_EVENTS = new Set([
  'UpdateLayoutTree',
  'Layout',
  'PrePaint',
  'Paint',
  'Layerize',
  'Commit',
]);

interface Classified {
  kind: TaskKindId;
  /** The event type for an input, which the label starts with. */
  type: string;
}

/** The most specific thing that happened inside a task wins. */
function classifyTask(inner: ModelEvent[]): Classified {
  let input: string | undefined;
  let timer = false;
  let animation = false;
  let parse = false;
  let script = false;
  let render = false;
  for (const e of inner) {
    if (e.name === 'EventDispatch') {
      if (e.arg && INPUT_EVENTS.has(e.arg)) input ??= e.arg;
      else script = true;
    } else if (e.name === 'TimerFire') timer = true;
    else if (e.name === 'FireAnimationFrame') animation = true;
    else if (e.name === 'ParseHTML') parse = true;
    else if (SCRIPT_EVENTS.has(e.name)) script = true;
    else if (RENDER_EVENTS.has(e.name)) render = true;
  }
  if (input) return { kind: TaskKind.Input, type: input };
  if (timer) return { kind: TaskKind.Timer, type: '' };
  if (animation) return { kind: TaskKind.Animation, type: '' };
  if (parse) return { kind: TaskKind.Parse, type: '' };
  if (script) return { kind: TaskKind.Script, type: '' };
  if (render) return { kind: TaskKind.Render, type: '' };
  return { kind: TaskKind.Other, type: '' };
}

export function segmentBrowserTasks(input: BrowserTaskInput, ctx: PassContext): TaskResult {
  const { samples, spans, functions, tree, timeline, marks } = input;
  const names = namesOf(functions, ctx.strings.strings);
  const runTasks = timeline
    .filter((e) => e.name === 'RunTask' && e.dur > 0)
    .sort((x, y) => x.start - y.start);

  const startIdx: number[] = [];
  const endIdx: number[] = [];
  const kinds: TaskKindId[] = [];
  const labels: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const busyUs: number[] = [];

  let cursor = 0;
  for (const task of runTasks) {
    const a = lowerBound(samples.time, task.start);
    const b = lowerBound(samples.time, task.start + task.dur);
    if (b <= a) continue;
    let busy = 0;
    for (let i = a; i < b; i++) {
      const leaf = tree.fn[samples.node[i] ?? 0] ?? 0;
      if ((functions.origin[leaf] ?? 0) !== Origin.Idle) busy += samples.dur[i] ?? 0;
    }
    if (busy === 0) continue;

    // The timeline is ordered by start: advance to the first event that can be inside this task.
    while (cursor < timeline.length && (timeline[cursor]?.start ?? 0) < task.start) cursor++;
    const inner: ModelEvent[] = [];
    for (let k = cursor; k < timeline.length; k++) {
      const e = timeline[k] as ModelEvent;
      if (e.start >= task.start + task.dur) break;
      if (e !== task && e.name !== 'RunTask') inner.push(e);
    }
    const { kind, type } = classifyTask(inner);
    const subject = (): string =>
      names.display(subjectOf(input, a, b, tree.fn[samples.node[a] ?? 0] ?? 0));
    let label: string;
    if (kind === TaskKind.Input) {
      const mark = marks.find(
        (m) =>
          MARK_KINDS.has(m.kind) && m.time >= task.start - 1000 && m.time <= task.start + task.dur,
      );
      label = mark ? `${type} ${mark.label}` : type;
    } else if (kind === TaskKind.Timer) label = `timer · ${subject()}`;
    else if (kind === TaskKind.Animation) label = 'animation frame';
    else if (kind === TaskKind.Parse) label = 'parse HTML';
    else if (kind === TaskKind.Script) label = `script · ${subject()}`;
    else if (kind === TaskKind.Render) label = 'rendering';
    else label = `other · ${subject()}`;

    startIdx.push(a);
    endIdx.push(b);
    kinds.push(kind);
    labels.push(label);
    starts.push(task.start);
    ends.push(task.start + task.dur);
    busyUs.push(busy);
  }

  const length = startIdx.length;
  const spanStart = new Uint32Array(length);
  const spanEnd = new Uint32Array(length);
  for (let k = 0; k < length; k++) {
    spanStart[k] = lowerBound(spans.start, starts[k] ?? 0);
    spanEnd[k] = lowerBound(spans.start, ends[k] ?? 0);
  }
  const table: TaskTable = {
    length,
    start: Float64Array.from(starts),
    end: Float64Array.from(ends),
    kind: Uint8Array.from(kinds),
    label: Uint32Array.from(labels, (text) => ctx.strings.intern(text)),
    spanStart,
    spanEnd,
    busy: Float64Array.from(busyUs),
    parentSpan: new Int32Array(length).fill(-1),
    resumeOf: new Int32Array(length).fill(-1),
    waitUs: new Float64Array(length),
    stitch: new Uint8Array(length),
    resumedFn: new Int32Array(length).fill(-1),
    runtimeOnly: new Uint8Array(length),
  };
  return { table, sampleStart: Uint32Array.from(startIdx), sampleEnd: Uint32Array.from(endIdx) };
}
