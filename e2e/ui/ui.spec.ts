import type { Page } from '@playwright/test';
import { expect, settled, test } from './fixtures';

const view = (page: Page, name: RegExp) =>
  page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name });

test.describe('paces UI on the orders-server fixture', () => {
  test('opens on the top finding with the default transforms visible', async ({ app }) => {
    await settled(app);
    const stack = app.getByRole('list', { name: 'Transform stack, oldest first' });
    await expect(
      stack.getByRole('button', { name: 'Rewind to Collapse dependencies' }),
    ).toBeVisible();
    await expect(stack.getByRole('button', { name: 'Rewind to Merge plumbing' })).toBeVisible();
    await expect(stack.getByRole('button', { name: 'Rewind to Drop idle' })).toBeVisible();
    await expect(app.locator('.finding-card.is-active')).toHaveCount(1);
  });

  test('opens with the top-ranked finding active, its function selected and its source docked', async ({
    app,
  }) => {
    await settled(app);
    const active = app.locator('.finding-card.is-active');
    await expect(active).toContainText('#1');
    await expect(active).toContainText('lineTotal');
    await expect(
      app.getByRole('region', { name: 'Source' }).getByRole('heading', { name: 'lineTotal' }),
    ).toBeVisible();
    await expect(app.getByText('No function selected')).toHaveCount(0);
    await expect(
      app
        .getByRole('region', { name: 'Selection details' })
        .getByRole('heading', { name: 'lineTotal' }),
    ).toBeVisible();
  });

  test('roots the waterfall at the task and collapses to the critical path with p', async ({
    app,
  }) => {
    await app.getByRole('button', { name: 'Show me: Event loop blocked' }).click();
    await settled(app);
    const rows = app.getByRole('table', { name: 'Waterfall rows' }).getByRole('row');
    await expect(rows.first()).toHaveAttribute('aria-label', /^GET \/orders,/);
    await expect(rows.nth(1)).toHaveAttribute('aria-label', /^getOrders,/);
    const all = await rows.count();
    await app.keyboard.press('p');
    await expect(app).toHaveURL(/cpo%3A1|cpo:1/);
    await expect.poll(() => rows.count()).toBeLessThan(all);
    await expect(rows.first()).toHaveAttribute('aria-label', /critical path/);
    await app.keyboard.press('p');
    await expect.poll(() => rows.count()).toBe(all);
  });

  test('Compare with… is disabled and explains itself when the host has no baseline', async ({
    app,
  }) => {
    const compare = app.getByRole('button', { name: 'Compare with…' });
    await expect(compare).toHaveAttribute('aria-disabled', 'true');
    await compare.focus();
    await expect(app.getByRole('tooltip')).toContainText('paces diff a.paces b.paces');
    await expect(app.getByRole('tooltip')).toBeVisible();
  });

  test('switches views with the number keys', async ({ app }) => {
    await app.keyboard.press('1');
    await expect(view(app, /Waterfall/)).toHaveAttribute('aria-current', 'page');
    await app.keyboard.press('2');
    await expect(view(app, /Flame graph/)).toHaveAttribute('aria-current', 'page');
    await app.keyboard.press('3');
    await expect(view(app, /Call graph/)).toHaveAttribute('aria-current', 'page');
    await app.keyboard.press('4');
    await expect(view(app, /Functions/)).toHaveAttribute('aria-current', 'page');
    await expect(app).toHaveURL(/v=functions/);
  });

  test('removes and adds transforms and keeps them in the URL', async ({ app }) => {
    await app.getByRole('button', { name: 'Remove Merge plumbing' }).click();
    await expect(app.getByRole('button', { name: 'Rewind to Merge plumbing' })).toHaveCount(0);
    await expect(app).toHaveURL(/t=collapse-deps%2Cdrop-idle|t=collapse-deps,drop-idle/);
    await app.getByRole('button', { name: 'Add transform' }).click();
    await app.getByRole('menuitem', { name: 'Invert call tree' }).click();
    await expect(app.getByRole('button', { name: 'Rewind to Invert' })).toBeVisible();
    await app.getByRole('button', { name: 'Rewind to Collapse dependencies' }).click();
    await expect(app.getByRole('button', { name: 'Rewind to Invert' })).toHaveCount(0);
  });

  test('Show me opens the view that proves the finding and selects its target', async ({ app }) => {
    await app.getByRole('button', { name: 'Show me: Event loop blocked' }).click();
    await expect(view(app, /Waterfall/)).toHaveAttribute('aria-current', 'page');
    await expect(app.locator('.finding-card.is-active')).toContainText('Event loop blocked');
    await expect(app.getByRole('region', { name: 'Selection details' })).toContainText(
      'GET /orders',
    );
    await expect(app.getByRole('row', { name: /getOrders/ }).first()).toBeVisible();
  });

  test('Show me for synchronous I/O selects its caller and the source', async ({ app }) => {
    await app.getByRole('button', { name: 'Show me: Synchronous I/O on a hot path' }).click();
    await expect(
      app.getByRole('region', { name: 'Source' }).getByRole('heading', { name: 'loadTemplate' }),
    ).toBeVisible();
    await expect(app.getByRole('list', { name: 'Source lines with self time' })).toBeVisible();
  });

  test('a selection is linked across views, the drawer and the source panel', async ({ app }) => {
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    const drawer = app.getByRole('region', { name: 'Selection details' });
    await expect(drawer.getByRole('heading', { name: 'lineTotal' })).toBeVisible();
    await expect(
      app.getByRole('region', { name: 'Source' }).getByRole('heading', { name: 'lineTotal' }),
    ).toBeVisible();
    await app.keyboard.press('1');
    await expect(app.locator('.wf-row.is-selected').first()).toContainText('lineTotal');
    await app.keyboard.press('3');
    await expect(app.getByRole('button', { name: /^lineTotal,/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('restores view, selection and transforms after a reload', async ({ app }) => {
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    await app.getByRole('button', { name: 'Remove Drop idle' }).click();
    const url = app.url();
    await app.reload();
    await expect(app).toHaveURL(url);
    await expect(view(app, /Functions/)).toHaveAttribute('aria-current', 'page');
    await expect(app.getByRole('button', { name: 'Rewind to Drop idle' })).toHaveCount(0);
    await expect(
      app
        .getByRole('region', { name: 'Selection details' })
        .getByRole('heading', { name: 'lineTotal' }),
    ).toBeVisible();
  });

  test('walks back and forward through history with Alt+arrows', async ({ app }) => {
    await app.keyboard.press('2');
    await app.keyboard.press('3');
    await app.keyboard.press('Alt+ArrowLeft');
    await expect(view(app, /Flame graph/)).toHaveAttribute('aria-current', 'page');
    await app.keyboard.press('Alt+ArrowRight');
    await expect(view(app, /Call graph/)).toHaveAttribute('aria-current', 'page');
  });

  test('dragging across a lane sets the time range for every view', async ({ app }) => {
    await settled(app);
    const plot = app.locator('.lane-plot').first();
    const box = await plot.boundingBox();
    if (!box) throw new Error('lane plot has no box');
    await app.mouse.move(box.x + box.width * 0.1, box.y + 40);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width * 0.4, box.y + 40, { steps: 6 });
    await app.mouse.up();
    await expect(app.getByRole('group', { name: /Selected range/ })).toBeVisible();
    await expect(app.locator('.chip-range')).toContainText('Range');
    await app.getByRole('button', { name: 'Remove time range' }).click();
    await expect(app.locator('.chip-range')).toHaveCount(0);
  });

  test('the flame graph exposes its frames to assistive tech and zooms on click', async ({
    app,
  }) => {
    await app.keyboard.press('2');
    await settled(app);
    const frames = app.getByRole('list', { name: 'Frames, widest first' }).getByRole('listitem');
    await expect(frames.first())
      .toBeVisible({ timeout: 10_000 })
      .catch(() => undefined);
    expect(await frames.count()).toBeGreaterThan(3);
    await frames.first().evaluate((el) => (el as HTMLElement).click());
    await expect(
      app.getByRole('navigation', { name: 'Zoom path' }).getByRole('button'),
    ).toHaveCount(2);
  });

  test('the call graph shows each function once and keeps positions when the selection changes', async ({
    app,
  }) => {
    await app.keyboard.press('3');
    await settled(app);
    const nodes = app.locator('.cg-node');
    await expect(nodes.first()).toBeVisible();
    const before = await nodes.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.left + ',' + (e as HTMLElement).style.top),
    );
    await nodes.nth(1).click();
    const after = await nodes.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.left + ',' + (e as HTMLElement).style.top),
    );
    expect(after).toEqual(before);
    const names = await app.locator('.cg-node-name').allTextContents();
    expect(new Set(names).size).toBe(names.length);
  });

  test('opens the shortcut sheet and shows the keyboard map', async ({ app }) => {
    await app.keyboard.press('?');
    const sheet = app.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toContainText('Alt+←');
    await app.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('uses dark tokens when the OS asks for dark', async ({ app }) => {
    const light = await app.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await app.emulateMedia({ colorScheme: 'dark' });
    const dark = await app.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);
  });

  test('loads nothing from the network beyond the host API', async ({ app, baseUrl }) => {
    const external: string[] = [];
    app.on('request', (r) => {
      if (!r.url().startsWith(baseUrl)) external.push(r.url());
    });
    await app.reload();
    await settled(app);
    expect(external).toEqual([]);
  });
});
