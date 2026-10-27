import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { DEFAULT_THRESHOLDS } from '../../src/config.js';
import { BROWSER_RULES } from '../../src/passes/findings-browser.js';
import { ORIGIN_NAMES, TASK_KIND_NAMES } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { deserializeModel, serializeModel } from '../../src/serialize.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import type { BrowserFixtureName } from '../helpers/browser-fixtures.js';

const models = new Map<BrowserFixtureName, ExecutionModel>();
function model(name: BrowserFixtureName): ExecutionModel {
  let m = models.get(name);
  if (!m) {
    m = analyze(recordingToCapture(cloneInput(name)));
    models.set(name, m);
  }
  return m;
}

const str = (m: ExecutionModel, id: number | undefined): string => m.strings[id ?? 0] ?? '';

/** Origin, package and plumbing of the first function with this name. */
function describeFn(m: ExecutionModel, name: string) {
  for (let f = 0; f < m.functions.length; f++) {
    if (str(m, m.functions.name[f]) !== name) continue;
    return {
      origin: ORIGIN_NAMES[m.functions.origin[f] ?? 0],
      pkg: str(m, m.functions.pkg[f]),
      plumbing: m.functions.plumbing[f] === 1,
      file: str(m, m.functions.file[f]),
    };
  }
  return undefined;
}

describe('browser model: run and tracks', () => {
  it('is a page run whose primary track is the page', () => {
    const m = model('worker-and-iframe');
    expect(m.target.kind).toBe('page');
    expect(m.tracks[m.primaryTrack]?.kind).toBe('page');
  });

  it('labels tracks as page, iframe and worker without pids', () => {
    const labels = model('worker-and-iframe').tracks.map((t) => t.label.replace(/:\d+/, ':PORT'));
    expect(labels).toEqual([
      'Page · 127.0.0.1:PORT',
      'iframe · localhost:PORT',
      'Worker · worker.js',
    ]);
  });

  it('treats every track as part of the target, since a browser has no launcher process', () => {
    expect(model('worker-and-iframe').tracks.every((t) => t.role === 'target')).toBe(true);
  });

  it('uses the page URL as the entry of a page track', () => {
    expect(model('slow-click').tracks[0]?.entry).toMatch(/slow-click\.html$/);
  });
});

describe('browser model: classification', () => {
  it('counts a script of the launched site as the program', () => {
    expect(describeFn(model('slow-click'), 'busy')?.origin).toBe('user');
  });

  it('counts a script from another site as a dependency named for its host', () => {
    const fn = describeFn(model('third-party'), 'trackEverything');
    expect(fn?.origin).toBe('dependency');
    expect(fn?.pkg).toBe('localhost');
  });

  it('keeps the page own code first-party next to a third-party script', () => {
    expect(describeFn(model('third-party'), 'ownWork')?.origin).toBe('user');
  });

  it('counts code in a cross-site iframe as third-party', () => {
    expect(describeFn(model('worker-and-iframe'), 'frameWork')?.origin).toBe('dependency');
  });

  it('counts a worker served by the page as first-party', () => {
    expect(describeFn(model('worker-and-iframe'), 'workerWork')?.origin).toBe('user');
  });

  it('marks the injected script as paces own code, never the program', () => {
    const fn = describeFn(model('slow-click'), 'injectedMain');
    expect(fn?.origin).toBe('node');
    expect(fn?.plumbing).toBe(true);
  });

  it('never lists a function of the injected script as user code, on any fixture', () => {
    for (const name of [
      'slow-click',
      'forced-layout',
      'third-party',
      'worker-and-iframe',
    ] as const) {
      const m = model(name);
      for (let f = 0; f < m.functions.length; f++) {
        if (!str(m, m.functions.file[f]).startsWith('paces://')) continue;
        expect(ORIGIN_NAMES[m.functions.origin[f] ?? 0]).not.toBe('user');
      }
    }
  });

  it('marks a built-in with no script as native, not the user code', () => {
    const m = model('forced-layout');
    const natives = [...Array(m.functions.length).keys()].filter(
      (f) => str(m, m.functions.file[f]) === '' && m.functions.origin[f] === 0,
    );
    const names = natives.map((f) => str(m, m.functions.name[f]));
    expect(names.filter((n) => n && !n.startsWith('('))).toEqual([]);
  });
});

describe('browser model: tasks', () => {
  const tasksOf = (name: BrowserFixtureName) => {
    const m = model(name);
    const t = m.tracks[0]?.tasks;
    return [...Array(t?.length ?? 0).keys()].map((k) => ({
      label: str(m, t?.label[k]),
      kind: TASK_KIND_NAMES[t?.kind[k] ?? 0],
      busyMs: (t?.busy[k] ?? 0) / 1000,
      startUs: t?.start[k] ?? 0,
      endUs: t?.end[k] ?? 0,
    }));
  };

  it('names the task that ran the click handler after the click', () => {
    const click = tasksOf('slow-click').find((t) => t.kind === 'input');
    expect(click?.label).toBe('click button#save "Save"');
    expect(click?.busyMs).toBeGreaterThan(150);
  });

  it('names the task that ran the timer', () => {
    const timer = tasksOf('forced-layout').find((t) => t.kind === 'timer');
    expect(timer?.label).toMatch(/^timer/);
    expect(timer?.busyMs).toBeGreaterThan(50);
  });

  it('names the task that parsed the document', () => {
    expect(tasksOf('slow-click').some((t) => t.kind === 'parse')).toBe(true);
  });

  it('gives every task a non-empty range inside the run', () => {
    for (const t of tasksOf('slow-click')) {
      expect(t.endUs).toBeGreaterThan(t.startUs);
      expect(t.startUs).toBeGreaterThanOrEqual(-50_000);
    }
  });
});

describe('browser model: timeline tables', () => {
  it('finds the click and the delay before the page showed a result', () => {
    const track = model('slow-click').tracks[0];
    const inputs = track?.inputs;
    expect(inputs?.length).toBeGreaterThan(0);
    const clicks = [...Array(inputs?.length ?? 0).keys()].filter((i) => inputs?.kind[i] === 0);
    expect(clicks).toHaveLength(1);
    expect(inputs?.latency[clicks[0] ?? 0]).toBeGreaterThan(200_000);
  });

  it('records the loading milestones', () => {
    const m = model('slow-click');
    const kinds = [...(m.page?.vitals.kind ?? [])];
    expect(kinds).toEqual(expect.arrayContaining([0, 3, 4]));
  });

  it('records the layout shift with its score', () => {
    const vitals = model('layout-shift').page?.vitals;
    const at = [...(vitals?.kind ?? [])].indexOf(5);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(vitals?.value[at]).toBeGreaterThan(0.1);
  });

  it('marks layout and style work run from script as forced', () => {
    const render = model('forced-layout').tracks[0]?.render;
    const forced = [...(render?.forced ?? [])].filter((x) => x === 1).length;
    expect(forced).toBeGreaterThan(100);
  });

  it('does not mark the ordinary rendering after a task as forced', () => {
    const render = model('layout-shift').tracks[0]?.render;
    expect([...(render?.forced ?? [])].filter((x) => x === 1)).toHaveLength(0);
  });

  it('keeps the frame pipeline as frames', () => {
    expect(model('slow-click').page?.frames.length).toBeGreaterThan(0);
  });

  it('holds the pause as a band between the two recorded segments', () => {
    const page = model('paused-resume').page;
    expect(page?.paused.length).toBe(1);
    const duration = ((page?.paused.end[0] ?? 0) - (page?.paused.start[0] ?? 0)) / 1000;
    expect(duration).toBeGreaterThan(500);
  });

  it('lists the filmstrip frames by time without their bytes', () => {
    const m = model('slow-click');
    expect(m.page?.screenshots.length).toBe(cloneInput('slow-click').screenshots?.length);
  });

  it('keeps the manual mark the user added', () => {
    const marks = model('paused-resume').meta.marks ?? [];
    expect(marks.map((x) => x.label)).toContain('after login');
  });

  it('keeps the user events as interactions of the page', () => {
    const track = model('slow-click').tracks[0];
    const labels = [...Array(track?.inputs?.length ?? 0).keys()].map((i) =>
      str(model('slow-click'), track?.inputs?.label[i]),
    );
    expect(labels.some((l) => l.includes('Save'))).toBe(true);
  });
});

describe('browser model: meta', () => {
  it('carries the browser, the clock accuracy and the run options', () => {
    const b = model('slow-click').meta.browser;
    expect(b?.product).toMatch(/^Edg\/|^Chrome\//);
    expect(b?.anchored).toBe(true);
    expect(b?.clockErrorUs).toBeLessThan(1000);
  });

  it('times the whole run from the recorded stretches', () => {
    const m = model('slow-click');
    expect(m.meta.durationUs).toBeGreaterThan(2_000_000);
  });

  it('survives a round trip through the cached form', () => {
    const m = model('slow-click');
    const back = deserializeModel(serializeModel(m));
    expect(back.page?.vitals.length).toBe(m.page?.vitals.length);
    expect(back.tracks[0]?.render?.length).toBe(m.tracks[0]?.render?.length);
  });
});

describe('browser model: findings', () => {
  const kinds = (name: BrowserFixtureName): string[] => model(name).findings.map((f) => f.kind);

  it('reports the click that took long to show a result, naming it', () => {
    const f = model('slow-click').findings.find((x) => x.kind === 'slow-interaction');
    expect(f?.summary).toMatch(/button#save "Save"/);
    expect(f?.summary).toMatch(/\d+ ms/);
  });

  it('reports the forced layout with its count', () => {
    const f = model('forced-layout').findings.find((x) => x.kind === 'forced-layout');
    expect(f?.summary).toMatch(/forced layout \d+ times/);
  });

  it('reports the third party that used a large share of the main thread', () => {
    const f = model('third-party').findings.find((x) => x.kind === 'third-party-cost');
    expect(f?.summary).toMatch(/localhost/);
    expect(f?.summary).toMatch(/\d+%/);
  });

  it('reports the layout shift with its score', () => {
    const f = model('layout-shift').findings.find((x) => x.kind === 'layout-shift');
    expect(f?.summary).toMatch(/shifted 0\.\d+/);
  });

  it('reports a task that blocked the page', () => {
    expect(kinds('slow-click')).toContain('main-thread-blocked');
  });

  it('echoes the threshold inside the finding rule', () => {
    const f = model('slow-click').findings.find((x) => x.kind === 'slow-interaction');
    expect(f?.rule).toMatch(/200 ms/);
  });

  it('never reports a finding that only makes sense for Node', () => {
    for (const name of [
      'slow-click',
      'forced-layout',
      'third-party',
      'worker-and-iframe',
    ] as const) {
      for (const bad of [
        'event-loop-blocked',
        'event-loop-lag',
        'sync-io',
        'late-module-loading',
      ]) {
        expect(kinds(name)).not.toContain(bad);
      }
    }
  });

  it('does not report a forced layout on a page that lays out only after its tasks', () => {
    expect(kinds('layout-shift')).not.toContain('forced-layout');
  });

  it('does not report a third party on a page with none', () => {
    expect(kinds('slow-click')).not.toContain('third-party-cost');
  });
});

describe('a long task that was mostly not sampled', () => {
  const blocked = (m: ExecutionModel) =>
    BROWSER_RULES[0]?.(m, DEFAULT_THRESHOLDS).filter((f) => f.kind === 'main-thread-blocked') ?? [];

  it('is not reported as blocking the page: its time cannot be attributed to anything', () => {
    const m = deserializeModel(serializeModel(model('slow-click')));
    const track = m.tracks[m.primaryTrack];
    expect(blocked(m)).toHaveLength(1);
    for (let k = 0; k < (track?.tasks.length ?? 0); k++) {
      if (track) track.tasks.busy[k] = 0;
    }
    expect(blocked(m)).toEqual([]);
  });
});
