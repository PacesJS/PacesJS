import { expect, openFixture, settled, test } from './fixtures';
import type { Page } from '@playwright/test';

// A page recorded in a real browser (engine/test/fixtures/browser), served by the dev host.
const PAGE = 'browser:slow-click';

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

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`browser session, ${scheme}, 1440 px`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });

    test('lanes and header', async ({ page, serve }) => {
      await openFixture(page, serve, PAGE);
      await settled(page);
      await picturesLoaded(page);
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`browser-lanes-${scheme}.png`, { fullPage: true });
    });
  });
}

test.describe('browser session, behaviour', () => {
  test('shows the filmstrip with real pictures and says the session has screenshots', async ({
    page,
    serve,
  }) => {
    await openFixture(page, serve, PAGE);
    await picturesLoaded(page);
    await expect(page.getByText('Contains screenshots')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Filmstrip' })).toBeVisible();
  });

  test('choosing a frame sets the range, and the keyboard moves between frames', async ({
    page,
    serve,
  }) => {
    await openFixture(page, serve, PAGE);
    await picturesLoaded(page);
    const frames = page.getByRole('button', { name: /^Frame at / });
    await frames.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(frames.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: /^Selected range / })).toBeVisible();
  });

  test('a paused run marks the pause as a small event, not a block', async ({ page, serve }) => {
    await openFixture(page, serve, 'browser:paused-resume');
    await expect(page.locator('.interaction-plot .pause-mark')).toHaveCount(2);
    await expect(page.getByRole('group', { name: 'Filmstrip' }).getByText('paused')).toHaveCount(0);
    await expect(page.locator('.paused-band')).toHaveCount(0);
    await expect(page.getByText('Paused 1×')).toBeVisible();
  });

  test('the click is on the interaction lane and opens its task', async ({ page, serve }) => {
    await openFixture(page, serve, PAGE);
    await page.locator('.input-block.kind-click').first().click();
    await expect(page.getByText(/click button#save "Save"/).first()).toBeVisible();
  });

  test('a page script shows its saved text, and offers no editor', async ({ page, serve }) => {
    await openFixture(page, serve, 'browser:forced-layout');
    await page.keyboard.press('4');
    await page
      .getByRole('row', { name: /thrash/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'Open in editor' })).toHaveCount(0);
  });
});
