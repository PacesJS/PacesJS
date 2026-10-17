import type { Page } from '@playwright/test';
import { expect, openFixture, settled, test } from './fixtures';

// Waterfall polish: the hover highlight sits behind the bars, the bar says how long it took, very
// deep chains keep a readable name column, and there is one horizontal scrollbar, not two.

const rowsOf = (page: Page) => page.getByRole('table', { name: 'Waterfall rows' }).getByRole('row');

async function showWaterfall(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: /^Waterfall/ })
    .click();
  await settled(page);
  await expect(page.locator('.wf-scroll')).toBeVisible();
}

interface Saved {
  uiPrefs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Run with saved prefs patched (the dev host keeps settings for the whole run), then put them back. */
async function withPrefs(
  page: Page,
  baseUrl: string,
  patch: Record<string, unknown>,
  body: () => Promise<void>,
): Promise<void> {
  const original = (await (await page.request.get(`${baseUrl}/api/settings`)).json()) as Saved;
  const next: Saved = { ...original, uiPrefs: { ...original.uiPrefs, ...patch } };
  await page.request.put(`${baseUrl}/api/settings`, { data: next });
  try {
    await page.reload();
    await settled(page);
    await body();
  } finally {
    await page.request.put(`${baseUrl}/api/settings`, { data: original });
  }
}

test.describe('hovering a row', () => {
  test.beforeEach(async ({ app }) => {
    await settled(app);
    await showWaterfall(app);
  });

  test('keeps the bar and the time and share cells visible and in place', async ({ app }) => {
    const row = rowsOf(app).filter({ hasText: 'buildInvoiceRows' }).first();
    await row.scrollIntoViewIfNeeded();
    const time = row.locator('.wf-time');
    const share = row.locator('.wf-share');
    const before = { time: await time.boundingBox(), share: await share.boundingBox() };
    const hitBox = (await row.locator('.wf-bar-hit').boundingBox())!;
    // The inside of the bar: the highlight may change the background around it, never the bar.
    const clip = {
      x: hitBox.x + 2,
      y: hitBox.y + 2,
      width: Math.max(1, hitBox.width - 4),
      height: Math.max(1, hitBox.height - 4),
    };
    const still = await app.screenshot({ clip });
    await app.mouse.move(0, 0);
    await row.locator('.wf-name').hover();
    await expect(row).toHaveClass(/is-hover/);
    await expect(time).toBeVisible();
    expect(await time.boundingBox()).toEqual(before.time);
    expect(await share.boundingBox()).toEqual(before.share);
    // The pixels of the bar column do not change when the highlight appears.
    expect((await app.screenshot({ clip })).equals(still)).toBe(true);
  });

  test('puts the bar, not the highlight, under the pointer over the bar', async ({ app }) => {
    const row = rowsOf(app).filter({ hasText: 'buildInvoiceRows' }).first();
    const hit = row.locator('.wf-bar-hit');
    await expect(hit).toBeVisible();
    const b = (await hit.boundingBox())!;
    const topIsBar = await app.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('.wf-bar-hit') !== null,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    );
    expect(topIsBar).toBe(true);
  });
});

test.describe('the duration tooltip', () => {
  test.beforeEach(async ({ app }) => {
    await settled(app);
    await showWaterfall(app);
  });

  test('shows the time, share and span after a short delay over the bar', async ({ app }) => {
    const row = rowsOf(app).filter({ hasText: 'buildInvoiceRows' }).first();
    await row.locator('.wf-bar-hit').hover();
    const tip = app.locator('.tooltip');
    await expect(tip).toContainText(/~[\d.]+ ms · [\d.]+% of the (?:run|task) · [\d.]+–[\d.]+ ms/);
    const t = (await tip.boundingBox())!;
    const vp = app.viewportSize()!;
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x + t.width).toBeLessThanOrEqual(vp.width);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.y + t.height).toBeLessThanOrEqual(vp.height);
    await app.mouse.move(0, 0);
    await expect(app.locator('.tooltip')).toHaveCount(0);
  });

  test('is on the row for keyboard and screen reader users too', async ({ app }) => {
    const row = rowsOf(app).filter({ hasText: 'buildInvoiceRows' }).first();
    await expect(row).toHaveAttribute(
      'aria-description',
      /~[\d.]+ ms · [\d.]+% of the (?:run|task)/,
    );
  });

  test('says "below sampling precision" for a hatched bar ', async ({ app }) => {
    const small = rowsOf(app).filter({ hasText: 'formatCurrency' }).first();
    await expect(small).toHaveAttribute('aria-description', /below sampling precision/);
  });
});

/** Show me on the hot-path finding selects a function at the end of a chain 17 levels deep. */
async function openDeep(page: Page): Promise<void> {
  await page
    .locator('.finding-card')
    .nth(2)
    .getByRole('button', { name: /^Show me:/ })
    .click();
  await showWaterfall(page);
}

test.describe('very deep call chains', () => {
  test.beforeEach(async ({ page, serve }) => {
    await openFixture(page, serve, 'eslint-cli-wrapped');
    await settled(page);
    await openDeep(page);
  });

  test('never overflow the name column, even at the widest, and keep a readable name', async ({
    page,
    baseUrl,
  }) => {
    await withPrefs(page, baseUrl, { wfCols: { call: 640, time: 88, share: 72 } }, async () => {
      await openDeep(page);
      const cells = await rowsOf(page).evaluateAll((rows) =>
        rows.map((r) => {
          const cell = r.querySelector<HTMLElement>('.wf-name')!;
          const label = r.querySelector<HTMLElement>('.wf-label')!;
          return {
            overflow: cell.scrollWidth - cell.clientWidth,
            label: label.textContent ?? '',
            full: r.getAttribute('aria-label')?.split(', ')[0] ?? '',
            depth: Number(r.getAttribute('aria-level')),
          };
        }),
      );
      expect(cells.length).toBeGreaterThan(10);
      expect(Math.max(...cells.map((c) => c.depth))).toBeGreaterThan(14);
      expect(cells.filter((c) => c.overflow > 0)).toEqual([]);
      expect(cells.filter((c) => c.label.length < 8 && c.label !== c.full)).toEqual([]);
    });
  });

  test('deep rows say how deep they are and offer to focus there', async ({ page }) => {
    const deep = rowsOf(page)
      .filter({ has: page.locator('.wf-depth') })
      .last();
    await expect(deep.locator('.wf-depth')).toHaveText(/^⋯ \d+$/);
    const focus = deep.getByRole('button', { name: /Focus here/ });
    await expect(focus).toBeVisible();
    await deep.hover();
    await expect(focus).toHaveText('Focus');
    const level = Number(await deep.getAttribute('aria-level'));
    const chips = await page.locator('.chip-item').count();
    await focus.click();
    // The transform re-roots the waterfall: the chain restarts from the top.
    await expect(page.locator('.chip-item')).toHaveCount(chips + 1);
    await expect
      .poll(async () =>
        Math.max(
          ...(await rowsOf(page).evaluateAll((rows) =>
            rows.map((r) => Number(r.getAttribute('aria-level'))),
          )),
        ),
      )
      .toBeLessThan(level);
  });

  test('shallow rows have no badge and no focus button', async ({ page }) => {
    const top = rowsOf(page).first();
    await expect(top.locator('.wf-depth')).toHaveCount(0);
    await top.hover();
    await expect(top.getByRole('button', { name: /Focus here/ })).toHaveCount(0);
  });
});

test.describe('horizontal scrolling', () => {
  /** Horizontally scrollable elements of the waterfall: its own parts and the wrappers around it. */
  const scrollers = (page: Page) =>
    page.evaluate(() => {
      const scroll = document.querySelector('.wf-scroll');
      if (!scroll) return ['no waterfall'];
      const found = new Set<HTMLElement>(Array.from(scroll.querySelectorAll<HTMLElement>('*')));
      found.add(scroll as HTMLElement);
      for (let el = scroll.parentElement; el && !el.matches('main, body'); el = el.parentElement) {
        found.add(el);
      }
      return Array.from(found)
        .filter((el) => {
          const ox = getComputedStyle(el).overflowX;
          return (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth;
        })
        .map((el) => `${el.tagName}.${el.className || '-'} ${el.scrollWidth}>${el.clientWidth}`);
    });

  for (const [name, fraction] of [
    ['default', null],
    ['minimum', 0.25],
    ['maximum', 0.75],
  ] as const) {
    test(`with the dock at its ${name} width there is at most one scrollbar`, async ({
      app,
      baseUrl,
    }) => {
      const patch =
        fraction === null
          ? {}
          : { dock: { orientation: 'right', widthFraction: fraction, heightPx: 420, wrap: false } };
      await withPrefs(app, baseUrl, patch, async () => {
        await showWaterfall(app);
        await app.getByRole('row').filter({ hasText: 'getOrders' }).first().click();
        await settled(app);
        const list = await scrollers(app);
        expect(list.length, list.join(' | ')).toBeLessThanOrEqual(1);
      });
    });
  }

  for (const fraction of [0.25, 0.46, 0.75]) {
    test(`on a very deep chain with the dock at ${fraction} there is at most one scrollbar`, async ({
      page,
      serve,
      baseUrl,
    }) => {
      await openFixture(page, serve, 'eslint-cli-wrapped');
      const patch = {
        dock: { orientation: 'right', widthFraction: fraction, heightPx: 420, wrap: false },
      };
      await withPrefs(page, baseUrl, patch, async () => {
        await openDeep(page);
        const list = await scrollers(page);
        expect(list.length, list.join(' | ')).toBeLessThanOrEqual(1);
      });
    });
  }

  test('the one scrollbar moves the header and the rows together', async ({ app, baseUrl }) => {
    const patch = {
      dock: { orientation: 'right', widthFraction: 0.75, heightPx: 420, wrap: false },
    };
    await withPrefs(app, baseUrl, patch, async () => {
      await showWaterfall(app);
      await app.getByRole('row').filter({ hasText: 'getOrders' }).first().click();
      const scroller = app.locator('.wf-scroll');
      const head = app.locator('.wf-head .caps').first();
      const row = rowsOf(app).first().locator('.wf-name');
      await scroller.evaluate((el) => el.scrollTo({ left: 0 }));
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(0);
      const h0 = (await head.boundingBox())!.x;
      const r0 = (await row.boundingBox())!.x;
      await scroller.evaluate((el) => el.scrollTo({ left: 80 }));
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(80);
      const h1 = (await head.boundingBox())!.x;
      const r1 = (await row.boundingBox())!.x;
      expect(Math.round(h0 - h1)).toBe(80);
      expect(Math.round(h0 - h1)).toBe(Math.round(r0 - r1));
    });
  });
});
