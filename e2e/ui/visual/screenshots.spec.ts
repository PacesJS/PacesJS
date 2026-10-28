import type { Page } from '@playwright/test';
import { expect, openFixture, settled, test } from '../fixtures';

// The visual suite: one screenshot per view, light and dark, 1440 px wide. These compare pixels to
// the boards and are not end-to-end tests of behavior.

// A page recorded in a real browser (engine/test/fixtures/browser), served by the dev host.
const BROWSER_PAGE = 'browser:slow-click';

async function picturesLoaded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const images = [...document.querySelectorAll<HTMLImageElement>('.filmstrip-frame img')];
        return images.length > 0 && images.every((i) => i.complete && i.naturalWidth > 0);
      }),
    )
    .toBe(true);
}

const VIEWS = [
  { key: '1', name: 'waterfall' },
  { key: '2', name: 'flame-graph' },
  { key: '3', name: 'call-graph' },
  { key: '4', name: 'functions' },
] as const;

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`screenshots, ${scheme}, 1440 px`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });

    test('source panel and details drawer with a function selected', async ({ app }) => {
      // The session opens on the top finding (a hot function), so its source is already docked.
      await expect(
        app.getByRole('region', { name: 'Source' }).getByRole('heading', { name: 'lineTotal' }),
      ).toBeVisible();
      await expect(app.getByRole('list', { name: 'Source lines with self time' })).toBeVisible();
      await settled(app);
      await app.mouse.move(0, 0);
      await expect(app).toHaveScreenshot(`source-panel-${scheme}.png`, { fullPage: true });
    });

    test('browser session: lanes and header', async ({ page, serve }) => {
      await openFixture(page, serve, BROWSER_PAGE);
      await settled(page);
      await picturesLoaded(page);
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`browser-lanes-${scheme}.png`, { fullPage: true });
    });

    for (const v of VIEWS) {
      test(`${v.name} view`, async ({ app }) => {
        await app.getByRole('button', { name: 'Show me: Event loop blocked' }).click();
        await app.keyboard.press(v.key);
        await settled(app);
        await app.mouse.move(0, 0);
        await expect(app).toHaveScreenshot(`${v.name}-${scheme}.png`, { fullPage: true });
      });
    }
  });
}
