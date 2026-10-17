// Characterization of the flame graph's zoom to a call chain (hot paths): every hot path of every fixture, in
// several transform stacks, plus prefixes, a chain that begins mid-tree and chains with unknown functions.
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import type { Transform } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel } from '../helpers/real-model';
import { goldenFile } from './golden';

const g = goldenFile(resolve(process.cwd(), 'test/baseline/zoom-golden.json'));
const NAMES = [
  'orders-server',
  'eslint-cli',
  'eslint-cli-wrapped',
  'async-chain',
  'async-chain-hooks',
  'rxjs-chain',
  'worker-imbalance',
  'late-require',
  'hot-regex',
  'sync-io',
  'gc-heavy',
];
const stacks: Array<[string, Transform[]]> = [
  ['default', [...DEFAULT_TRANSFORMS]],
  ['raw', []],
  ['collapse', [{ k: 'collapse-deps' }]],
  ['collapse-plumbing', [{ k: 'collapse-deps' }, { k: 'merge-plumbing' }]],
];

describe('flame zoom to a chain, golden masters', () => {
  for (const name of NAMES) {
    it(
      name,
      () => {
        const model = fixtureModel(name);
        const q = createQueries(model, null, nodeElk);
        for (const t of model.tracks) {
          for (const [label, transforms] of stacks) {
            const scope = { track: t.id, transforms, range: null, hide: [] as number[] };
            const k = `${name}/${t.id}/${label}`;
            const opts = (zoomPath: number[]) => ({
              sort: 'heavy' as const,
              color: 'origin' as const,
              zoom: [],
              zoomPath,
            });
            q.hotPaths(scope, 12).forEach((p, i) => {
              g.check(`${k}/hot${i}`, q.flame(scope, opts(p.fns)));
              g.check(`${k}/hot${i}-prefix`, q.flame(scope, opts(p.fns.slice(0, 2))));
              g.check(`${k}/hot${i}-tail`, q.flame(scope, opts(p.fns.slice(1))));
              g.check(
                `${k}/hot${i}-skip`,
                q.flame(scope, opts(p.fns.filter((_, j) => j % 2 === 0))),
              );
              g.check(
                `${k}/hot${i}-unknown`,
                q.flame(scope, opts([...p.fns.slice(0, 1), 999_999])),
              );
            });
            g.check(`${k}/empty`, q.flame(scope, opts([])));
            g.check(`${k}/nonsense`, q.flame(scope, opts([999_999, 999_998])));
          }
        }
      },
      120_000,
    );
  }

  it('finishes', () => g.finish());
});
