import type { Page } from '@playwright/test';
import { expect, openFixture, settled, test } from './fixtures';

// The one UI test that needs a real browser: everything here depends on layout, hit testing or
// computed geometry, which jsdom does not have. Behavior (selection, history, dock, Show me, text,
// motion rules) is tested in packages/ui/test. Screenshots are the visual suite (visual/).

const rowsOf = (page: Page) => page.getByRole('table', { name: 'Waterfall rows' }).getByRole('row');

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
  await page.request.put(`${baseUrl}/api/settings`, {
    data: { ...original, uiPrefs: { ...original.uiPrefs, ...patch } },
  });
  try {
    await page.reload();
    await settled(page);
    await body();
  } finally {
    await page.request.put(`${baseUrl}/api/settings`, { data: original });
  }
}

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

async function showWaterfall(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: /^Waterfall/ })
    .click();
  await settled(page);
  await expect(page.locator('.wf-scroll')).toBeVisible();
}

test('lays the views out in a real browser: lanes, graphs, dock, source gutter, waterfall scrolling', async ({
  app,
  page,
  serve,
  baseUrl,
}) => {
  const external: string[] = [];
  app.on('request', (r) => {
    if (!r.url().startsWith(baseUrl)) external.push(r.url());
  });
  await app.reload();
  await settled(app);

  await test.step('loads nothing from the network beyond the host API', () => {
    expect(external).toEqual([]);
  });

  await test.step('dragging across a lane sets the time range for every view', async () => {
    const plot = app.locator('.lane-plot').first();
    const box = await plot.boundingBox();
    if (!box) throw new Error('lane plot has no box');
    await app.mouse.move(box.x + box.width * 0.1, box.y + 40);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width * 0.4, box.y + 40, { steps: 6 });
    await app.mouse.up();
    await expect(app.getByRole('group', { name: /Selected range/ })).toBeVisible();
    await app.getByRole('button', { name: 'Remove time range' }).click();
    await expect(app.locator('.chip-range')).toHaveCount(0);
  });

  await test.step('the flame graph lists its frames and zooms on click', async () => {
    await app.keyboard.press('2');
    await settled(app);
    const frames = app.getByRole('list', { name: 'Frames, widest first' }).getByRole('listitem');
    await expect.poll(() => frames.count(), { timeout: 10_000 }).toBeGreaterThan(3);
    await frames.first().evaluate((el) => (el as HTMLElement).click());
    await expect(
      app.getByRole('navigation', { name: 'Zoom path' }).getByRole('button'),
    ).toHaveCount(2);
    await app.keyboard.press('Escape');
  });

  await test.step('the call graph opens fitted, zooms toward the cursor, pans by dragging and keeps positions', async () => {
    await app.keyboard.press('3');
    await settled(app);
    const scroll = app.locator('.cg-scroll');
    await scroll.scrollIntoViewIfNeeded();
    const box = await scroll.boundingBox();
    if (!box) throw new Error('call graph has no box');
    const nodes = app.locator('.cg-node');
    await expect(nodes.first()).toBeVisible();
    const inside = await nodes.evaluateAll(
      (els, b) =>
        els.every((e) => {
          const r = e.getBoundingClientRect();
          return r.left >= b.x - 2 && r.right <= b.x + b.width + 2;
        }),
      box,
    );
    expect(inside).toBe(true);

    const level = app.getByLabel('Zoom level');
    const fitted = await level.textContent();
    await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.mouse.wheel(0, -400);
    await expect(level).not.toHaveText(fitted ?? '');

    const layer = scroll.locator('.cg-plot > div');
    const t0 = await layer.evaluate((el) => (el as HTMLElement).style.transform);
    await app.mouse.move(box.x + 40, box.y + box.height - 40);
    await app.mouse.down();
    await app.mouse.move(box.x + 140, box.y + box.height - 80, { steps: 5 });
    await app.mouse.up();
    expect(await layer.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(t0);

    await app.getByRole('button', { name: 'Fit' }).click();
    await expect(level).toHaveText(fitted ?? '');
    const positions = () =>
      nodes.evaluateAll((els) =>
        els.map((e) => (e as HTMLElement).style.left + ',' + (e as HTMLElement).style.top),
      );
    const before = await positions();
    await nodes.nth(1).click();
    expect(await positions()).toEqual(before);
  });

  await test.step('the source dock resizes by dragging its handle and keeps the size after a reload', async () => {
    await app.getByRole('button', { name: 'Show me: Hot function' }).first().click();
    await settled(app);
    const handle = app.getByRole('separator', { name: 'Resize source dock' });
    const dock = app.getByRole('complementary', { name: 'Source dock' });
    const before = (await dock.boundingBox())?.width ?? 0;
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) throw new Error('dock handle has no box');
    const y = Math.max(box.y, 0) + 40;
    await app.mouse.move(box.x + box.width / 2, y);
    await app.mouse.down();
    await app.mouse.move(box.x - 200, y, { steps: 6 });
    await app.mouse.up();
    await expect
      .poll(async () => (await dock.boundingBox())?.width ?? 0)
      .toBeGreaterThan(before + 100);
    const after = (await dock.boundingBox())?.width ?? 0;
    await app.reload();
    await settled(app);
    await expect
      .poll(async () => Math.abs(((await dock.boundingBox())?.width ?? 0) - after))
      .toBeLessThan(4);
  });

  await test.step('the source gutter: bars and values sit on the middle of their line, labels stay inside it', async () => {
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /^lineTotal/ })
      .first()
      .click();
    const lines = app.locator('.source-line');
    await expect(lines.first()).toBeVisible();
    const withBar = app.locator('.source-line', { has: app.locator('.source-bar') });
    const barCount = await withBar.count();
    expect(barCount).toBeGreaterThan(1);
    await expect(app.locator('.source-val')).toHaveCount(barCount);
    const geometry = await withBar.evaluateAll((rows) =>
      rows.map((r) => {
        const row = r.getBoundingClientRect();
        const gutter = r.querySelector('.source-gutter')!.getBoundingClientRect();
        const bar = r.querySelector('.source-bar')!.getBoundingClientRect();
        const val = r.querySelector('.source-val')!.getBoundingClientRect();
        const code = r.querySelector('.source-code')!.getBoundingClientRect();
        const middle = (b: DOMRect) => b.top + b.height / 2;
        return {
          barOff: Math.abs(middle(bar) - middle(row)),
          valOff: Math.abs(middle(val) - middle(row)),
          left: val.left - gutter.left,
          gap: code.left - val.right,
        };
      }),
    );
    for (const g of geometry) {
      expect(g.barOff).toBeLessThanOrEqual(1.5);
      expect(g.valOff).toBeLessThanOrEqual(1.5);
      expect(g.left).toBeGreaterThanOrEqual(-1);
      expect(g.gap).toBeGreaterThan(0);
    }
  });

  await test.step('the waterfall has at most one horizontal scrollbar at every dock width, and it moves header and rows together', async () => {
    for (const fraction of [null, 0.25, 0.75]) {
      const patch =
        fraction === null
          ? {}
          : { dock: { orientation: 'right', widthFraction: fraction, heightPx: 420, wrap: false } };
      await withPrefs(app, baseUrl, patch, async () => {
        await showWaterfall(app);
        await app.getByRole('row').filter({ hasText: 'getOrders' }).first().click();
        await settled(app);
        const list = await scrollers(app);
        expect(list.length, `dock ${fraction}: ${list.join(' | ')}`).toBeLessThanOrEqual(1);
      });
    }
    await withPrefs(
      app,
      baseUrl,
      { dock: { orientation: 'right', widthFraction: 0.75, heightPx: 420, wrap: false } },
      async () => {
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
      },
    );
  });

  await test.step('a very deep chain never overflows the name column and keeps a readable name', async () => {
    await openFixture(page, serve, 'eslint-cli-wrapped');
    await settled(page);
    const card = page.locator('.finding-card').nth(2);
    if ((await card.getAttribute('aria-current')) !== 'true') {
      await card.getByRole('button', { name: /^Show me:/ }).click();
    }
    await showWaterfall(page);
    await expect
      .poll(async () =>
        Math.max(
          0,
          ...(await rowsOf(page).evaluateAll((rows) =>
            rows.map((r) => Number(r.getAttribute('aria-level'))),
          )),
        ),
      )
      .toBeGreaterThan(14);
    const cells = await rowsOf(page).evaluateAll((rows) =>
      rows.map((r) => {
        const cell = r.querySelector<HTMLElement>('.wf-name')!;
        const label = r.querySelector<HTMLElement>('.wf-label')!;
        return {
          overflow: cell.scrollWidth - cell.clientWidth,
          label: label.textContent ?? '',
          full: r.getAttribute('aria-label')?.split(', ')[0] ?? '',
        };
      }),
    );
    expect(cells.filter((c) => c.overflow > 0)).toEqual([]);
    expect(cells.filter((c) => c.label.length < 8 && c.label !== c.full)).toEqual([]);
    const list = await scrollers(page);
    expect(list.length, list.join(' | ')).toBeLessThanOrEqual(1);
  });
});
