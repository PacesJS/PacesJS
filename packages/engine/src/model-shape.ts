// A structural fingerprint of an ExecutionModel: the names (and array types) of its columns.
// A cached model written before a column was added still carries the right engine version string
// but crashes the views that read the new column; comparing fingerprints catches that without
// anyone having to remember to bump a version.

import { analyze } from './analyze.js';
import type { ExecutionModel } from './model.js';
import type { RawCapture } from './raw.js';

type Bag = Record<string, unknown>;

function describe(prefix: string, value: unknown, depth: number, out: string[]): void {
  if (value === null || typeof value !== 'object') return;
  if (ArrayBuffer.isView(value)) return;
  for (const key of Object.keys(value).sort()) {
    const child = (value as Bag)[key];
    const kind = ArrayBuffer.isView(child)
      ? (child.constructor as { name: string }).name
      : Array.isArray(child)
        ? 'Array'
        : typeof child;
    out.push(`${prefix}${key}:${kind}`);
    if (depth > 0 && kind === 'object') describe(`${prefix}${key}.`, child, depth - 1, out);
  }
}

/** Column names and types of the model: top level, the function table, and the first track. */
export function modelShape(model: ExecutionModel): string {
  const out: string[] = [];
  describe('model.', model, 0, out);
  describe('functions.', model.functions, 0, out);
  const track = model.tracks[0];
  if (track) describe('track.', track, 2, out);
  return out.join(',');
}

/** True when every column the current engine needs is present (extras and optional keys are fine). */
export function shapeCovers(found: string | undefined, required: string): boolean {
  if (found === undefined) return false;
  const have = new Set(found.split(','));
  return required.split(',').every((column) => have.has(column));
}

// The smallest capture the engine accepts: one process, a root and one function, three samples.
const MINIMAL: RawCapture = {
  meta: {
    command: ['node', 'x.js'],
    cwd: '/p',
    nodeVersion: 'v0',
    platform: 'linux',
    mode: 'default',
    intervalUs: 1000,
    startedAt: 0,
    endedAt: 10,
    endedBy: 'exit',
    projectRoot: '/p',
  },
  tracks: [
    {
      info: { id: 'p1', kind: 'process', label: 'main', pid: 1, threadId: 0 },
      cpuProfile: {
        nodes: [
          {
            id: 1,
            callFrame: {
              functionName: '(root)',
              scriptId: '0',
              url: '',
              lineNumber: -1,
              columnNumber: -1,
            },
            children: [2],
          },
          {
            id: 2,
            callFrame: {
              functionName: 'work',
              scriptId: '1',
              url: 'file:///p/x.js',
              lineNumber: 0,
              columnNumber: 0,
            },
            hitCount: 3,
          },
        ],
        startTime: 0,
        endTime: 3000,
        samples: [2, 2, 2],
        timeDeltas: [1000, 1000, 1000],
      },
      scripts: [{ scriptId: '1', url: 'file:///p/x.js', sourceMapURL: '', hash: 'h' }],
      events: [],
    },
  ],
  sourceMaps: {},
};

let reference: string | undefined;

/** The shape `analyze` produces today. */
export function currentModelShape(): string {
  reference ??= modelShape(analyze(MINIMAL));
  return reference;
}
