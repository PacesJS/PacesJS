import type { Page } from '@playwright/test';
import { expect, openFixture, settled, test } from './fixtures';

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
    await expect(rows.first()).toHaveAttribute('aria-label', /^request · GET \/orders,/);
    await expect(rows.nth(1)).toHaveAttribute('aria-label', /server\.js,/);
    await expect(rows.nth(2)).toHaveAttribute('aria-label', /^getOrders,/);
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
    await expect(app).toHaveURL(
      /t=stitch%2Ccollapse-deps%2Cdrop-idle|t=stitch,collapse-deps,drop-idle/,
    );
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

  test('dropdowns close on a click away, on Escape and when another opens', async ({ app }) => {
    const add = app.getByRole('button', { name: 'Add transform' });
    await add.click();
    const menu = app.getByRole('menu', { name: 'Add transform' });
    await expect(menu).toBeVisible();
    await app.getByRole('heading', { name: 'Findings' }).click();
    await expect(menu).toHaveCount(0);
    await add.click();
    await expect(menu).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    await add.click();
    const enabled = app.locator('[role="menuitem"]:not([disabled])');
    await expect(enabled.first()).toBeFocused();
    await app.keyboard.press('ArrowDown');
    await expect(enabled.nth(1)).toBeFocused();
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

  test('the source dock resizes by dragging its handle and keeps the size after a reload', async ({
    app,
  }) => {
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

  test('the dock moves below the views and maximizes to show the whole file', async ({
    app,
    baseUrl,
  }) => {
    await settled(app);
    await app.getByRole('button', { name: 'Dock below' }).click();
    await expect(app.getByRole('separator', { name: 'Resize source dock' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    );
    await app.getByRole('button', { name: 'Maximize the source dock' }).click();
    const dialog = app.getByRole('dialog', { name: 'Source, maximized' });
    await expect(dialog.getByRole('navigation', { name: 'Functions in this file' })).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Source lines with self time' })).toBeVisible();
    // The dev host keeps settings for the whole run: put the dock back where later tests expect it.
    await app.keyboard.press('Escape');
    await app.getByRole('button', { name: 'Dock to the right' }).click();
    await expect
      .poll(async () => {
        const saved = (await (await app.request.get(`${baseUrl}/api/settings`)).json()) as {
          uiPrefs?: { dock?: { orientation?: string } };
        };
        return saved.uiPrefs?.dock?.orientation;
      })
      .toBe('right');
  });

  test('Show filter hides an origin and says what it hides', async ({ app }) => {
    await settled(app);
    await app.getByRole('button', { name: /Native/ }).click();
    await expect(app.getByRole('button', { name: /Native/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(app.getByRole('status').filter({ hasText: /hiding Native/ })).toBeVisible();
    await expect(app).toHaveURL(/hide%3A4|hide:4/);
    await app.getByRole('button', { name: 'Show all', exact: true }).click();
    await expect(app.getByRole('button', { name: /Native/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('eslint session: target and supporting tracks, notes', () => {
  test('opens on the target process, lists supporting ones and keeps notes in one chip', async ({
    page,
    serve,
  }) => {
    await openFixture(page, serve, 'eslint-cli-wrapped');
    await settled(page);
    const picker = page.getByLabel('Tracks');
    await expect(picker.locator('option:checked')).toHaveText(/^eslint · pid/);
    await expect(page.getByText('eslint/bin/eslint.js').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /note/ })).toHaveCount(1);
    await page.getByRole('button', { name: /note/ }).click();
    await expect(page.getByRole('dialog', { name: 'Notes about this profile' })).toBeVisible();
    await page.getByRole('heading', { name: 'Findings' }).click();
    await expect(page.getByRole('dialog', { name: 'Notes about this profile' })).toHaveCount(0);
  });

  test('groups the task picker with the program entry point first', async ({ page, serve }) => {
    await openFixture(page, serve, 'eslint-cli-wrapped');
    await page.keyboard.press('1');
    await settled(page);
    const groups = page.locator('#task-pick optgroup');
    await expect(groups.first()).toHaveAttribute('label', 'Whole run');
    await expect(groups.nth(1)).toHaveAttribute('label', 'Entry');
    await expect(page.locator('#task-pick option').first()).toContainText('Whole run');
    await expect(page.locator('#task-pick optgroup[label="Entry"] option')).toContainText(
      'program entry point',
    );
  });
});

test.describe('selection, source dock and call graph navigation', () => {
  test('clicking empty space in the waterfall clears the selection', async ({ app }) => {
    await app.getByRole('button', { name: 'Show me: Event loop blocked' }).click();
    await settled(app);
    await app.keyboard.press('p');
    await expect(app.locator('.wf-row.is-selected')).toHaveCount(1);
    await app.locator('.wf-axis').click({ position: { x: 4, y: 4 } });
    await expect(app.locator('.wf-row.is-selected')).toHaveCount(0);
    await expect(app).not.toHaveURL(/sel=/);
  });

  test('clicking empty space in the flame graph clears the selection', async ({ app }) => {
    await app.keyboard.press('2');
    await settled(app);
    await expect(app).toHaveURL(/sel=fn/);
    const plot = app.locator('.flame-plot');
    const box = await plot.boundingBox();
    if (!box) throw new Error('flame plot has no box');
    await plot.click({ position: { x: 6, y: box.height - 6 } });
    await expect(app).not.toHaveURL(/sel=/);
  });

  test('the source dock collapses with the selection and opens when something is selected', async ({
    app,
  }) => {
    await settled(app);
    const dock = app.getByRole('complementary', { name: 'Source dock' });
    await expect(dock.getByRole('button', { name: 'Collapse source panel' })).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(dock.getByRole('button', { name: 'Expand source panel' })).toBeVisible();
    await expect.poll(async () => (await dock.boundingBox())?.width ?? 999).toBeLessThan(120);
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    await expect(dock.getByRole('button', { name: 'Collapse source panel' })).toBeVisible();
  });

  test('the source dock has no Source tab and maximizes into an overlay', async ({ app }) => {
    await settled(app);
    await expect(view(app, /^Source/)).toHaveCount(0);
    await app.getByRole('button', { name: 'Maximize the source dock' }).click();
    const dialog = app.getByRole('dialog', { name: 'Source, maximized' });
    await expect(dialog.getByRole('navigation', { name: 'Functions in this file' })).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('selecting a function highlights its definition line, not its hottest line', async ({
    app,
  }) => {
    await settled(app);
    const marked = app.locator('.source-line.is-definition');
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText('lineTotal');
    await expect(app.getByRole('button', { name: /Jump to hottest line/ })).toBeVisible();
    await expect(app.locator('.source-bar').first()).toBeVisible();
  });

  test('the call graph opens fitted, zooms toward the cursor and pans by dragging', async ({
    app,
  }) => {
    await app.keyboard.press('Escape');
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
    const before = await level.textContent();
    await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.mouse.wheel(0, -400);
    await expect(level).not.toHaveText(before ?? '');

    const layer = scroll.locator('.cg-plot > div');
    const t0 = await layer.evaluate((el) => (el as HTMLElement).style.transform);
    await app.mouse.move(box.x + 40, box.y + box.height - 40);
    await app.mouse.down();
    await app.mouse.move(box.x + 140, box.y + box.height - 80, { steps: 5 });
    await app.mouse.up();
    const t1 = await layer.evaluate((el) => (el as HTMLElement).style.transform);
    expect(t1).not.toBe(t0);

    await app.getByRole('button', { name: 'Zoom in' }).click();
    await app.getByRole('button', { name: '100%' }).click();
    await expect(level).toHaveText('100%');
    await app.getByRole('button', { name: 'Zoom in' }).click();
    await app.getByRole('button', { name: 'Fit' }).click();
    await expect(level).toHaveText(before ?? '');
  });

  test('the call graph keeps node positions when a node is selected', async ({ app }) => {
    await app.keyboard.press('Escape');
    await app.keyboard.press('3');
    await settled(app);
    const nodes = app.locator('.cg-node');
    const before = await nodes.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.left + ',' + (e as HTMLElement).style.top),
    );
    await nodes.first().click();
    const after = await nodes.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.left + ',' + (e as HTMLElement).style.top),
    );
    expect(after).toEqual(before);
  });
});

test.describe('definition line on the eslint session', () => {
  test('selecting verify highlights the line that defines it', async ({ page, serve }) => {
    await openFixture(page, serve, 'eslint-cli-wrapped');
    await settled(page);
    await page.keyboard.press('4');
    await page.getByRole('searchbox', { name: /Filter functions/ }).fill('verify');
    await page
      .getByRole('row', { name: /^verify,? / })
      .first()
      .click();
    const marked = page.locator('.source-line.is-definition');
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText('verify');
  });
});

test.describe('whole run, stitching and the entry root', () => {
  test('the default transforms include a removable stitching chip', async ({ app }) => {
    const stack = app.getByRole('list', { name: 'Transform stack, oldest first' });
    await expect(
      stack.getByRole('button', { name: 'Rewind to Stitch continuations (inferred)' }),
    ).toBeVisible();
    await app.getByRole('button', { name: 'Remove Stitch continuations (inferred)' }).click();
    await expect(
      stack.getByRole('button', { name: 'Rewind to Stitch continuations (inferred)' }),
    ).toHaveCount(0);
  });

  test('the waterfall opens on the whole run, rooted at the entry script', async ({ app }) => {
    await app.keyboard.press('Escape');
    await app.keyboard.press('1');
    await settled(app);
    await expect(app.getByLabel('Task').locator('option:checked')).toContainText('Whole run');
    const rows = app.getByRole('table', { name: 'Waterfall rows' }).getByRole('row');
    await expect(rows.first()).toHaveAttribute('aria-label', /server\.js,/);
    await expect(app.getByRole('button', { name: /Show \d+ small tasks/ })).toBeVisible();
  });

  test('the call graph and the flame graph are rooted at the entry, never at an arbitrary function', async ({
    app,
  }) => {
    await app.keyboard.press('Escape');
    await app.keyboard.press('3');
    await settled(app);
    const entry = app.locator('.cg-node.is-entry');
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('entry point');
    const tops = await app
      .locator('.cg-node')
      .evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.top)));
    const entryTop = await entry.evaluate((e) => parseFloat((e as HTMLElement).style.top));
    expect(Math.min(...tops)).toBe(entryTop);
    await app.keyboard.press('2');
    await settled(app);
    const frames = app.getByRole('list', { name: 'Frames, widest first' }).getByRole('listitem');
    await expect(frames.first()).toHaveAttribute('aria-label', /server\.js/);
  });
});
