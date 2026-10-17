import type { Page } from '@playwright/test';
import { expect, settled, test } from './fixtures';

// Click-off deselects, everywhere: with a call selected, a click on anything that is not
// interactive clears it. Clicks on controls, on what you are working with (the source dock, the
// details drawer), drags and text selections never do.

const VIEWS = [
  { key: '1', name: 'waterfall', caption: '.axis-caption', empty: '.wf-head .caps >> nth=0' },
  { key: '2', name: 'flame graph', caption: '.axis-caption', empty: '.flame-crumbs' },
  { key: '3', name: 'call graph', caption: '.axis-caption', empty: '.cg-encoding' },
  { key: '4', name: 'functions', caption: '.fn-status', empty: '.sandwich-head' },
] as const;

async function selectCall(page: Page, key: string): Promise<void> {
  await settled(page);
  await page.keyboard.press(key);
  await settled(page);
  await expect(page).toHaveURL(/sel=/);
}

async function expectCleared(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/sel=/);
  await expect(page.getByRole('region', { name: 'Selection details' })).toContainText(
    'Nothing selected',
  );
}

for (const v of VIEWS) {
  test.describe(`click-off in the ${v.name}`, () => {
    test('clears when the page background is clicked', async ({ app }) => {
      await selectCall(app, v.key);
      await app.mouse.click(8, 300);
      await expectCleared(app);
    });

    test('clears when the panel padding is clicked', async ({ app }) => {
      await selectCall(app, v.key);
      await app.locator('.main-view').click({ position: { x: 4, y: 4 } });
      await expectCleared(app);
    });

    test('clears when a caption is clicked', async ({ app }) => {
      await selectCall(app, v.key);
      await app.locator(v.caption).first().click();
      await expectCleared(app);
    });

    test('clears when empty space in the view is clicked', async ({ app }) => {
      await selectCall(app, v.key);
      await app.locator(v.empty).first().click();
      await expectCleared(app);
    });

    test('Back restores the selection that click-off cleared', async ({ app }) => {
      await selectCall(app, v.key);
      await app.mouse.click(8, 300);
      await expectCleared(app);
      await app.goBack();
      await expect(app).toHaveURL(/sel=/);
    });
  });
}

test.describe('click-off keeps the selection', () => {
  test('when a toolbar button is clicked', async ({ app }) => {
    await selectCall(app, '3');
    await app.getByRole('button', { name: 'Zoom in' }).click();
    await expect(app).toHaveURL(/sel=/);
  });

  test('when a tab is clicked', async ({ app }) => {
    await selectCall(app, '1');
    await app
      .getByRole('navigation', { name: 'Views' })
      .getByRole('button', { name: /Flame/ })
      .click();
    await expect(app).toHaveURL(/sel=/);
  });

  test('when a switch or a select is used', async ({ app }) => {
    await selectCall(app, '1');
    await app.getByRole('switch', { name: /Critical path$/ }).click();
    await app.locator('#wf-sort').selectOption('duration');
    await expect(app).toHaveURL(/sel=/);
  });

  test('when text in the source dock is clicked', async ({ app }) => {
    await selectCall(app, '4');
    await app.getByRole('complementary', { name: 'Source dock' }).locator('.source-title').click();
    await app
      .getByRole('complementary', { name: 'Source dock' })
      .locator('.source-head')
      .click({ position: { x: 4, y: 4 } });
    await expect(app).toHaveURL(/sel=/);
  });

  test('when the details drawer is clicked', async ({ app }) => {
    await selectCall(app, '4');
    await app.getByRole('region', { name: 'Selection details' }).locator('.stat-grid').click();
    await expect(app).toHaveURL(/sel=/);
  });

  test('when a lane is dragged', async ({ app }) => {
    await selectCall(app, '4');
    const plot = app.locator('.lane-plot').first();
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    if (!box) throw new Error('lane plot has no box');
    await app.mouse.move(box.x + box.width * 0.2, box.y + 30);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width * 0.5, box.y + 30, { steps: 6 });
    // Release over an empty area of the overview: the drag must not count as a click-off.
    await app.mouse.move(box.x + box.width * 0.5, box.y + box.height + 40, { steps: 3 });
    await app.mouse.up();
    await expect(app.locator('.chip-range')).toContainText('Range');
  });

  test('when text is selected by dragging', async ({ app }) => {
    await selectCall(app, '1');
    const caption = app.locator('.axis-caption').first();
    await caption.scrollIntoViewIfNeeded();
    const box = await caption.boundingBox();
    if (!box) throw new Error('caption has no box');
    await app.mouse.move(box.x + 2, box.y + box.height / 2);
    await app.mouse.down();
    await app.mouse.move(box.x + Math.min(box.width - 2, 160), box.y + box.height / 2, {
      steps: 5,
    });
    await app.mouse.up();
    expect(await app.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(
      0,
    );
    await expect(app).toHaveURL(/sel=/);
  });

  test('when a frame of the flame graph is clicked (it selects, never clears)', async ({ app }) => {
    await selectCall(app, '2');
    const frames = app.getByRole('list', { name: 'Frames, widest first' }).getByRole('listitem');
    await frames.nth(2).evaluate((el) => (el as HTMLElement).click());
    await expect(app).toHaveURL(/sel=/);
  });
});

test.describe('click-off and the escape routes', () => {
  test('Esc and the Clear selection chip still clear', async ({ app }) => {
    await selectCall(app, '4');
    await app.keyboard.press('Escape');
    await expectCleared(app);
    await app.goBack();
    await expect(app).toHaveURL(/sel=/);
    await app.getByRole('button', { name: /Clear selection/ }).click();
    await expectCleared(app);
  });

  test('closing a popover with a click does not also clear the selection', async ({ app }) => {
    await selectCall(app, '4');
    await app.getByRole('button', { name: 'Add transform' }).click();
    await app.mouse.click(8, 300);
    await expect(app.getByRole('menu', { name: 'Add transform' })).toHaveCount(0);
    await expect(app).toHaveURL(/sel=/);
  });
});
