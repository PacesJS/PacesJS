import type { Page } from '@playwright/test';
import { expect, openFixture, settled, test } from './fixtures';

// Clarity: which numbers cover one call and which cover every call, elapsed against CPU time, and
// rows whose callees are hidden by the minimum duration.

const rowsOf = (page: Page) => page.getByRole('table', { name: 'Waterfall rows' }).getByRole('row');
const dock = (page: Page) => page.getByRole('complementary', { name: 'Source dock' });

async function showView(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name }).click();
  await settled(page);
}

test.describe('rows with callees below the minimum duration', () => {
  test('keep a chevron and open to a summary row, while a true leaf has none', async ({
    page,
    serve,
  }) => {
    await openFixture(page, serve, 'eslint-cli');
    await showView(page, /^Waterfall/);
    await page.locator('#wf-min').selectOption('20000');
    await settled(page);
    const hiding = rowsOf(page).filter({ hasText: /./ });
    const withHidden = await hiding.evaluateAll((rows) =>
      rows
        .filter((r) => /callees? under .* hidden/.test(r.getAttribute('aria-description') ?? ''))
        .map((r) => ({
          expandable: r.hasAttribute('aria-expanded'),
          label: r.getAttribute('aria-label'),
        })),
    );
    expect(withHidden.length).toBeGreaterThan(0);
    expect(withHidden.every((r) => r.expandable)).toBe(true);

    const row = page
      .getByRole('table', { name: 'Waterfall rows' })
      .locator('[role="row"][aria-expanded="false"][aria-description*="under 20 ms hidden"]')
      .first();
    await row.scrollIntoViewIfNeeded();
    const level = Number(await row.getAttribute('aria-level'));
    await row.locator('.wf-twisty').click();
    // The summary row is a child of the row, at the level below it, where the first short call ran.
    await expect(
      page
        .getByRole('table', { name: 'Waterfall rows' })
        .locator(`[role="row"][aria-level="${level + 1}"][aria-label*="under 20 ms hidden"]`)
        .first(),
    ).toBeVisible();
  });
});

test.describe('elapsed time against CPU time', () => {
  test('a row that awaits says elapsed, CPU and awaiting; a plain row keeps the plain text', async ({
    page,
    serve,
  }) => {
    await openFixture(page, serve, 'eslint-cli');
    await showView(page, /^Waterfall/);
    const texts = await rowsOf(page).evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('aria-description') ?? ''),
    );
    expect(
      texts.some((t) => /^elapsed [\d.]+ ms \(CPU ~[\d.]+ ms, ~[\d.]+ ms awaiting\)/.test(t)),
    ).toBe(true);
    expect(texts.some((t) => /^~[\d.]+ ms · [\d.]+% of the run/.test(t))).toBe(true);
    // A merged row spans the clock from its first segment to its last; its CPU is a small part.
    await expect(
      rowsOf(page).filter({ hasText: 'loadConfigArrayForDirectory' }).first(),
    ).toHaveAttribute(
      'aria-description',
      /^elapsed 129\d\.\d ms \(CPU ~4\d\.\d ms, ~12\d\d ms awaiting\)/,
    );
  });

  test('the TIME column says it is elapsed time', async ({ page, serve }) => {
    await openFixture(page, serve, 'eslint-cli-wrapped');
    await showView(page, /^Waterfall/);
    await expect(page.locator('.wf-head-cell', { hasText: /^Time$/ })).toHaveAttribute(
      'title',
      'Elapsed time of the call (includes awaiting)',
    );
  });
});

test.describe('one call against all calls of its function', () => {
  test.beforeEach(async ({ app }) => {
    await settled(app);
    await showView(app, /^Waterfall/);
  });

  test('a selected call row shows its own numbers and defaults the dock to this call', async ({
    app,
  }) => {
    await rowsOf(app).filter({ hasText: 'getOrders' }).first().click();
    const d = dock(app);
    await expect(d).toContainText(/This call: .* total \(CPU\) · .* self/);
    await expect(d).toContainText(/All (~[\d,]+ )?calls of getOrders: .* total \(CPU\)/);
    await expect(d.getByRole('button', { name: 'This call' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await d.getByRole('button', { name: 'All calls' }).click();
    await expect(d.getByRole('button', { name: 'All calls' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('the drawer labels the scope and the kind of time', async ({ app }) => {
    await rowsOf(app).filter({ hasText: 'getOrders' }).first().click();
    const drawer = app.getByRole('region', { name: 'Selection details' });
    await expect(drawer).toContainText(/This call: /);
    await expect(drawer).toContainText(/All (~[\d,]+ )?calls of getOrders/);
    await expect(drawer).toContainText('Total time (CPU)');
  });

  test('a function chosen in the Functions table covers all calls and has no toggle', async ({
    app,
  }) => {
    await showView(app, /^Functions/);
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    const d = dock(app);
    await expect(d).toContainText(/All (~[\d,]+ )?calls of lineTotal/);
    await expect(d.getByRole('button', { name: 'This call' })).toHaveCount(0);
    await expect(d.locator('.source-totals.is-call')).toHaveCount(0);
  });

  test('line bars and chips say which calls they cover', async ({ app }) => {
    await showView(app, /^Functions/);
    await app
      .getByRole('row', { name: /renderInvoice/ })
      .first()
      .click();
    const d = dock(app);
    const gutters = await d
      .locator('.source-gutter')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? '').filter(Boolean));
    expect(gutters.length).toBeGreaterThan(0);
    expect(gutters.every((t) => /across all (~[\d,]+ )?calls/.test(t))).toBe(true);
    const chip = d.locator('.call-chip').first();
    await expect(chip).toHaveAttribute('title', /across all (~[\d,]+ )?calls/);
  });
});
