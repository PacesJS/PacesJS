// Characterization of every Queries method on real fixtures, in several scopes. See golden.ts.
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import type { Transform } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel } from '../helpers/real-model';
import { goldenFile } from './golden';

const g = goldenFile(resolve(process.cwd(), 'test/baseline/queries-golden.json'));
const NAMES = ['orders-server', 'eslint-cli', 'async-chain', 'rxjs-chain', 'worker-imbalance'];

const stacks: Array<[string, Transform[]]> = [
  ['default', [...DEFAULT_TRANSFORMS]],
  ['raw', []],
  ['collapse', [{ k: 'collapse-deps' }]],
  ['invert', [...DEFAULT_TRANSFORMS, { k: 'invert' }]],
];

const SORTS = [
  ['time', 'time'],
  ['dur', 'duration'],
  ['share', 'share'],
] as const;

describe('queries golden masters', () => {
  for (const name of NAMES) {
    it(`${name}`, async () => {
      const model = fixtureModel(name);
      const q = createQueries(model, null, nodeElk);
      g.check(`${name}/summary`, q.summary());
      g.check(`${name}/overview`, q.overview());
      for (const t of model.tracks) {
        for (const [label, transforms] of stacks) {
          const k = `${name}/${t.id}/${label}`;
          const scope = { track: t.id, transforms, range: null, hide: [] as number[] };
          g.check(`${k}/tasks`, q.tasks(scope));
          for (const [sl, sort] of SORTS) {
            for (const task of [-1, 0]) {
              for (const minDurUs of [-1, 0, 2000]) {
                g.check(
                  `${k}/wf/${sl}/${task}/${minDurUs}`,
                  q.waterfall(scope, task, { sort, minDurUs }),
                );
              }
            }
          }
          const dur = t.durationUs;
          const ranged = { ...scope, range: [dur * 0.2, dur * 0.7] as const };
          g.check(`${k}/wf-range`, q.waterfall(ranged, -1, { sort: 'time', minDurUs: -1 }));
          const hidden = { ...scope, hide: [3, 1] };
          g.check(`${k}/wf-hide`, q.waterfall(hidden, -1, { sort: 'time', minDurUs: 0 }));
          g.check(`${k}/hidden`, q.hidden(hidden));
          for (const sort of ['heavy', 'alpha'] as const) {
            for (const color of ['origin', 'self'] as const) {
              g.check(
                `${k}/flame/${sort}/${color}`,
                q.flame(scope, { sort, color, zoom: [], zoomPath: [] }),
              );
            }
          }
          const flame = q.flame(scope, { sort: 'heavy', color: 'origin', zoom: [], zoomPath: [] });
          const nodes = Array.from(flame.node).filter((n) => n > 0);
          g.check(
            `${k}/flame-zoom`,
            q.flame(scope, {
              sort: 'heavy',
              color: 'origin',
              zoom: nodes.slice(0, 2),
              zoomPath: [],
            }),
          );
          const fns = Array.from(flame.fn).slice(0, 6);
          g.check(
            `${k}/flame-zoompath`,
            q.flame(scope, { sort: 'heavy', color: 'self', zoom: [], zoomPath: fns.slice(0, 3) }),
          );
          g.check(
            `${k}/flame-range`,
            q.flame(ranged, { sort: 'alpha', color: 'origin', zoom: [], zoomPath: [] }),
          );
          g.check(`${k}/functions`, q.functions(scope, ''));
          g.check(`${k}/functions-search`, q.functions(scope, 'a'));
          g.check(`${k}/functions-hide`, q.functions(hidden, ''));
          g.check(`${k}/hot`, q.hotPaths(scope, 5));
          const rows = q.functions(scope, '').rows.slice(0, 5);
          for (const r of rows) {
            const f = `${k}/fn${r.fn}`;
            g.check(`${f}/details`, q.details(scope, r.fn));
            g.check(`${f}/sandwich`, q.sandwich(scope, r.fn));
            g.check(`${f}/source`, q.source(scope, r.fn));
            g.check(`${f}/outline`, q.outline(scope, r.fn));
            g.check(`${f}/describe`, q.describe(scope, { kind: 'fn', fn: r.fn }));
            g.check(`${f}/pkg`, q.packageOf(r.fn));
            const ego = await q.callGraph(scope, { all: false, revealed: [], ego: r.fn }, []);
            g.check(`${f}/graph-ego`, [ego.graph, ego.near]);
          }
          g.check(`${k}/callat`, q.callAt(scope, fns.slice(1, 3)));
          g.check(
            `${k}/describe-node`,
            q.describe(scope, { kind: 'node', track: t.id, path: fns.slice(1, 3) }),
          );
          g.check(`${k}/describe-task`, q.describe(scope, { kind: 'task', track: t.id, task: 0 }));
          g.check(
            `${k}/describe-range`,
            q.describe(scope, { kind: 'range', from: 0, to: dur / 2 }),
          );
          g.check(`${k}/describe-none`, q.describe(scope, { kind: 'none' }));
          const graph = await q.callGraph(scope, { all: false, revealed: [], ego: null }, []);
          g.check(`${k}/graph`, graph.graph);
          g.check(`${k}/graph-layout`, graph.layout);
          const all = await q.callGraph(scope, { all: true, revealed: [], ego: null }, []);
          g.check(`${k}/graph-all`, all.graph);
          const pkg = model.strings[model.functions.pkg[fns[1] ?? 0] ?? 0] ?? '';
          const exp = await q.callGraph(
            scope,
            { all: false, revealed: fns.slice(0, 2), ego: null },
            [pkg],
          );
          g.check(`${k}/graph-pkg`, exp.graph);
        }
      }
    }, 240_000);
  }

  it('finishes', () => g.finish());
});
