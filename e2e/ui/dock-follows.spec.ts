import type { Page } from '@playwright/test';
import { expect, settled, test } from './fixtures';

// The source dock follows the selection: nothing selected, it is a slim rail; a selection that has
// code (a function, a call, a Show me target) extends it to the saved size; clearing collapses it.

const RAIL_MAX = 120;

const dock = (page: Page) => page.getByRole('complementary', { name: 'Source dock' });
const width = async (page: Page): Promise<number> => (await dock(page).boundingBox())?.width ?? 0;
const expectRail = (page: Page) =>
  expect.poll(() => width(page), { message: 'the dock is a rail' }).toBeLessThan(RAIL_MAX);
const expectExtended = (page: Page) =>
  expect.poll(() => width(page), { message: 'the dock is extended' }).toBeGreaterThan(400);

async function clearByClickOff(page: Page): Promise<void> {
  await page.mouse.click(8, 300);
  await expect(page).not.toHaveURL(/sel=/);
}

test.describe('the dock follows the selection', () => {
  test('is extended when the session opens on the top finding', async ({ app }) => {
    await settled(app);
    await expectExtended(app);
  });

  test('collapses when the selection is cleared with Esc, and extends when one is made again', async ({
    app,
  }) => {
    await settled(app);
    await app.keyboard.press('Escape');
    await expectRail(app);
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /formatCurrency/ })
      .first()
      .click();
    await expectExtended(app);
  });

  test('collapses on click-off and extends on the next selection', async ({ app }) => {
    await settled(app);
    await clearByClickOff(app);
    await expectRail(app);
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    await expectExtended(app);
  });

  test('collapses when the Clear selection chip is used', async ({ app }) => {
    await settled(app);
    await app.getByRole('button', { name: /Clear selection/ }).click();
    await expectRail(app);
  });

  test('a manual collapse holds only until the selection next changes from empty to something', async ({
    app,
  }) => {
    await settled(app);
    await app.getByRole('button', { name: 'Collapse source panel' }).click();
    await expectRail(app);
    await app.keyboard.press('Escape');
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    await expectExtended(app);
  });

  test('keeps the saved width after being collapsed and extended again', async ({ app }) => {
    await settled(app);
    const before = await width(app);
    await app.keyboard.press('Escape');
    await expectRail(app);
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    await expectExtended(app);
    await expect.poll(async () => Math.abs((await width(app)) - before)).toBeLessThan(4);
  });

  test('starts collapsed from a URL without a selection and extended from one with it', async ({
    app,
    baseUrl,
  }) => {
    await app.goto(`${baseUrl}/#v=functions`);
    await settled(app);
    await expectRail(app);
    await app.goto(`${baseUrl}/#v=functions&sel=fn%3A283`);
    await app.reload();
    await settled(app);
    await expectExtended(app);
  });

  test('extends for a Show me target that has code', async ({ app }) => {
    await settled(app);
    await app.keyboard.press('Escape');
    await expectRail(app);
    await app.getByRole('button', { name: 'Show me: Synchronous I/O on a hot path' }).click();
    await expectExtended(app);
  });

  test('follows Back and Forward through history', async ({ app }) => {
    await settled(app);
    await clearByClickOff(app);
    await expectRail(app);
    await app.goBack();
    await expect(app).toHaveURL(/sel=/);
    await expectExtended(app);
    await app.goForward();
    await expect(app).not.toHaveURL(/sel=/);
    await expectRail(app);
  });

  test('stays collapsed for a task selection, which has no source', async ({ app }) => {
    await settled(app);
    await app.getByRole('button', { name: 'Show me: Event loop blocked' }).click();
    await expect(app.locator('.finding-card.is-active')).toContainText('Event loop blocked');
    await expectRail(app);
    await expect(app.getByRole('region', { name: 'Selection details' })).toContainText(
      'GET /orders',
    );
  });
});
