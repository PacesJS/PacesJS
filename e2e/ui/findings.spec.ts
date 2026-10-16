import type { Locator, Page } from '@playwright/test';
import { expect, openFixture, settled, test } from './fixtures';

// The Show me contract, for every kind of finding the zoo captures produce: it opens the view that
// proves the finding, selects and highlights the target, announces "Showing: ...", and can be
// cleared with Esc, the Clear selection chip, or by pressing the active finding again.

const view = (page: Page, name: RegExp) =>
  page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name });
const card = (page: Page, n: number): Locator => page.locator('.finding-card').nth(n);
const showMe = (page: Page, n: number): Locator =>
  card(page, n).getByRole('button', { name: /^Show me:/ });
const announced = (page: Page, text: RegExp | string): Locator =>
  page.getByRole('status').filter({ hasText: text });

interface Case {
  /** Which capture to open. */
  fixture: string;
  /** Index of the finding card to press. */
  card: number;
  kind: string;
  /** The tab that proves it. */
  tab: RegExp;
  /** What must be visibly selected in that view. */
  target(page: Page): Promise<void>;
}

const selectedRow = (page: Page, text: string | RegExp) =>
  expect(page.locator('.wf-row.is-selected, .fn-row.is-selected').first()).toContainText(text);

const CASES: Case[] = [
  {
    fixture: 'orders-server',
    card: 0,
    kind: 'hot-function',
    tab: /Functions/,
    target: (p) => selectedRow(p, 'lineTotal'),
  },
  {
    fixture: 'orders-server',
    card: 1,
    kind: 'event-loop-blocked',
    tab: /Waterfall/,
    target: async (p) => {
      await selectedRow(p, 'GET /orders');
      await expect(p.getByRole('region', { name: 'Selection details' })).toContainText(
        'GET /orders',
      );
    },
  },
  {
    fixture: 'orders-server',
    card: 3,
    kind: 'sync-io',
    tab: /Waterfall/,
    target: (p) => selectedRow(p, 'loadTemplate'),
  },
  {
    fixture: 'orders-server',
    card: 4,
    kind: 'event-loop-lag',
    tab: /Waterfall/,
    target: async (p) => {
      await expect(p.getByRole('group', { name: /Selected range/ })).toBeVisible();
      await expect(p.locator('.chip-range')).toContainText('Range');
      await expect(p.getByRole('row', { name: /^Range / })).toBeVisible();
    },
  },
  {
    fixture: 'hot-regex',
    card: 0,
    kind: 'hot-function',
    tab: /Functions/,
    target: (p) => selectedRow(p, 'looksValid'),
  },
  {
    fixture: 'sync-io',
    card: 0,
    kind: 'sync-io',
    tab: /Waterfall/,
    target: async (p) => {
      await expect(p.locator('.wf-row.is-selected').first()).toBeVisible();
    },
  },
  {
    fixture: 'late-require',
    card: 0,
    kind: 'late-module-loading',
    tab: /Waterfall/,
    target: async (p) => {
      await expect(p.locator('.wf-row.is-selected').first()).toBeVisible();
    },
  },
  {
    fixture: 'gc-heavy',
    card: 0,
    kind: 'gc-pressure',
    tab: /Flame graph/,
    target: async (p) => {
      await expect(p.getByRole('group', { name: /Selected range/ })).toBeVisible();
      await expect(p.locator('.chip-range')).toContainText('Range');
    },
  },
  {
    fixture: 'eslint-cli-wrapped',
    card: 1,
    kind: 'hot-dependency',
    tab: /Call graph/,
    target: async (p) => {
      await expect(p.locator('.cg-node.is-selected')).toHaveCount(1);
      await expect(p.locator('.cg-node.is-selected')).toBeInViewport();
      await expect(p.getByRole('region', { name: 'Selection details' })).toContainText(
        'Dependency',
      );
    },
  },
  {
    fixture: 'eslint-cli-wrapped',
    card: 2,
    kind: 'hot-path',
    tab: /Flame graph/,
    target: async (p) => {
      const crumbs = p.getByRole('navigation', { name: 'Zoom path' }).getByRole('button');
      expect(await crumbs.count()).toBeGreaterThan(1);
    },
  },
  {
    fixture: 'rxjs-chain',
    card: 0,
    kind: 'async-overhead',
    tab: /Flame graph/,
    target: async (p) => {
      await expect(p.getByRole('button', { name: 'Rewind to Merge plumbing' })).toHaveCount(0);
    },
  },
];

for (const c of CASES) {
  test.describe(`Show me: ${c.kind} on ${c.fixture}`, () => {
    test.beforeEach(async ({ page, serve }) => {
      await openFixture(page, serve, c.fixture);
      await settled(page);
    });

    test('opens the proving view, selects the target and announces it', async ({ page }) => {
      if ((await card(page, c.card).getAttribute('aria-current')) !== 'true') {
        await showMe(page, c.card).click();
      }
      await expect(view(page, c.tab)).toHaveAttribute('aria-current', 'page');
      await expect(card(page, c.card)).toHaveAttribute('aria-current', 'true');
      await expect(showMe(page, c.card)).toHaveAttribute('aria-pressed', 'true');
      await expect(announced(page, /^Showing: /)).toHaveCount(1);
      await settled(page);
      await c.target(page);
    });

    test('is cleared with Escape', async ({ page }) => {
      if ((await card(page, c.card).getAttribute('aria-current')) !== 'true') {
        await showMe(page, c.card).click();
        await settled(page);
      }
      await page.keyboard.press('Escape');
      await expect(card(page, c.card)).not.toHaveAttribute('aria-current', 'true');
      await expect(announced(page, /^Showing: /)).toHaveCount(0);
    });

    test('is cleared by pressing the active finding again, and shows again after', async ({
      page,
    }) => {
      if ((await card(page, c.card).getAttribute('aria-current')) !== 'true') {
        await showMe(page, c.card).click();
        await settled(page);
      }
      await showMe(page, c.card).click();
      await expect(card(page, c.card)).not.toHaveAttribute('aria-current', 'true');
      await showMe(page, c.card).click();
      await expect(card(page, c.card)).toHaveAttribute('aria-current', 'true');
    });
  });
}

test.describe('Clear selection chip', () => {
  test('clears the selection from the details drawer', async ({ app }) => {
    await settled(app);
    const drawer = app.getByRole('region', { name: 'Selection details' });
    await expect(drawer).toContainText('Showing: Hot function');
    await drawer.getByRole('button', { name: /Clear selection/ }).click();
    await expect(app.locator('.finding-card.is-active')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: /Clear selection/ })).toHaveCount(0);
    await expect(app.getByText('No function selected')).toBeVisible();
  });
});
