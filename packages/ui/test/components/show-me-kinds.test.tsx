import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, hashParams, openApp } from '../helpers/open-app';
import { fixtureModel } from '../helpers/real-model';

// The Show me contract for every kind of finding the zoo captures produce: it opens the view that
// proves the finding, selects the target, announces "Showing: ...", and can be cleared with Escape
// or by pressing the active finding again. Where the target lands is tested in state/showme*.test.ts.

interface Case {
  fixture: string;
  card: number;
  kind: string;
  tab: RegExp;
  /** What the URL must hold once the target is shown. */
  param: 'sel' | 'r' | 'plumbing-unmerged';
}

const CASES: Case[] = [
  { fixture: 'orders-server', card: 0, kind: 'hot-function', tab: /Functions/, param: 'sel' },
  { fixture: 'orders-server', card: 1, kind: 'event-loop-blocked', tab: /Waterfall/, param: 'sel' },
  { fixture: 'orders-server', card: 3, kind: 'sync-io', tab: /Waterfall/, param: 'sel' },
  { fixture: 'orders-server', card: 4, kind: 'event-loop-lag', tab: /Waterfall/, param: 'r' },
  { fixture: 'hot-regex', card: 0, kind: 'hot-function', tab: /Functions/, param: 'sel' },
  { fixture: 'sync-io', card: 0, kind: 'sync-io', tab: /Waterfall/, param: 'sel' },
  { fixture: 'late-require', card: 0, kind: 'late-module-loading', tab: /Waterfall/, param: 'sel' },
  { fixture: 'gc-heavy', card: 0, kind: 'gc-pressure', tab: /Flame graph/, param: 'r' },
  {
    fixture: 'eslint-cli-wrapped',
    card: 1,
    kind: 'hot-dependency',
    tab: /Call graph/,
    param: 'sel',
  },
  { fixture: 'eslint-cli-wrapped', card: 2, kind: 'hot-path', tab: /Flame graph/, param: 'sel' },
  {
    fixture: 'rxjs-chain',
    card: 0,
    kind: 'async-overhead',
    tab: /Flame graph/,
    param: 'plumbing-unmerged',
  },
];

const cards = (): HTMLElement[] => Array.from(document.querySelectorAll('.finding-card'));
const showMe = (n: number): HTMLElement =>
  cards()[n]?.querySelector('button[aria-pressed]') as HTMLElement;
const isActive = (n: number): boolean => cards()[n]?.getAttribute('aria-current') === 'true';
const announcements = (): number =>
  screen.queryAllByRole('status').filter((el) => /^Showing: /.test(el.textContent ?? '')).length;

async function opened(c: Case): Promise<void> {
  openApp(fixtureModel(c.fixture));
  await appReady();
  await waitFor(() => expect(cards().length).toBeGreaterThan(c.card));
  if (!isActive(c.card)) await userEvent.click(showMe(c.card));
  await waitFor(() => expect(isActive(c.card)).toBe(true));
}

describe.each(CASES)('Show me: $kind on $fixture', (c) => {
  it('opens the proving view, selects the target and announces it', async () => {
    await opened(c);
    const views = screen.getByRole('navigation', { name: 'Views' });
    const tab = Array.from(views.querySelectorAll('button')).find((b) =>
      c.tab.test(b.textContent ?? ''),
    );
    expect(tab?.getAttribute('aria-current')).toBe('page');
    expect(showMe(c.card).getAttribute('aria-pressed')).toBe('true');
    expect(announcements()).toBe(1);
    if (c.param === 'plumbing-unmerged') {
      expect(screen.queryByRole('button', { name: 'Rewind to Merge plumbing' })).toBeNull();
    } else expect(hashParams().has(c.param)).toBe(true);
  });

  it('is cleared with Escape', async () => {
    await opened(c);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(isActive(c.card)).toBe(false));
    expect(announcements()).toBe(0);
  });

  it('is cleared by pressing the active finding again, and shows again after', async () => {
    await opened(c);
    await userEvent.click(showMe(c.card));
    await waitFor(() => expect(isActive(c.card)).toBe(false));
    await userEvent.click(showMe(c.card));
    await waitFor(() => expect(isActive(c.card)).toBe(true));
  });
});

describe('Clear selection chip', () => {
  it('clears the selection from the details drawer and collapses the dock', async () => {
    openApp();
    await appReady();
    const drawer = await screen.findByRole('region', { name: 'Selection details' });
    await waitFor(() => expect(drawer.textContent).toContain('Showing: Hot function'));
    await userEvent.click(screen.getByRole('button', { name: /Clear selection/ }));
    await waitFor(() =>
      expect(document.querySelectorAll('.finding-card.is-active')).toHaveLength(0),
    );
    expect(screen.queryByRole('button', { name: /Clear selection/ })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Expand source panel' })).toBeTruthy();
  });
});
