import { expect, settled, test } from './fixtures';

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
      await app.getByRole('button', { name: 'Show me: Hot function' }).first().click();
      await expect(
        app.getByRole('region', { name: 'Source' }).getByRole('heading', { name: 'lineTotal' }),
      ).toBeVisible();
      await expect(app.getByRole('list', { name: 'Source lines with self time' })).toBeVisible();
      await settled(app);
      await app.mouse.move(0, 0);
      await expect(app).toHaveScreenshot(`source-panel-${scheme}.png`, { fullPage: true });
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
