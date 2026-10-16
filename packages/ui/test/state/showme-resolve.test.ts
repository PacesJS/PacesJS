import { describe, expect, it } from 'vitest';
import { localClient } from '../../src/data/client';
import { withVisibleTarget } from '../../src/state/showme-resolve';
import { fixtureModel } from '../helpers/real-model';

describe('making a Show me target visible', () => {
  const late = fixtureModel('late-require');
  const client = localClient(late);
  const finding = late.findings[0];

  it('opens a plumbing target with plumbing unmerged, so a row exists to select', async () => {
    expect(finding?.showMe.view).toBe('waterfall');
    const target = await withVisibleTarget(client, finding?.showMe ?? { view: 'waterfall' });
    expect(target.options?.['unmergePlumbing']).toBe(true);
  });

  it('leaves a target in your own code alone', async () => {
    const sync = fixtureModel('sync-io');
    const showMe = sync.findings[0]?.showMe ?? { view: 'waterfall' as const };
    expect(await withVisibleTarget(localClient(sync), showMe)).toEqual(showMe);
  });

  it('leaves non-waterfall targets alone', async () => {
    const showMe = { view: 'functions' as const, fn: finding?.showMe.fn ?? 0 };
    expect(await withVisibleTarget(client, showMe)).toBe(showMe);
  });
});
