import { expect, settled, test } from './fixtures';

// A worker option: the dev host serves this capture as the baseline session.
test.use({ baselineFixture: 'sync-io' });

test.describe('differential mode with a baseline session', () => {
  test('enables Compare with… and colors the flame graph by change from the baseline', async ({
    app,
  }) => {
    const compare = app.getByRole('button', { name: 'Compare with…' });
    await expect(compare).not.toHaveAttribute('aria-disabled', 'true');
    await compare.click();
    await expect(app.getByRole('dialog', { name: 'Compare with another session' })).toContainText(
      'flame graph shows the difference',
    );
    await app.keyboard.press('2');
    await settled(app);
    await expect(app.getByRole('list', { name: 'Difference colors' })).toContainText(
      'Slower than baseline',
    );
  });

  test('describes a frame that is new in this run as slower than the baseline', async ({ app }) => {
    await app.keyboard.press('2');
    await settled(app);
    const frame = app.getByRole('list', { name: 'Frames, widest first' }).getByRole('listitem', {
      name: /^lineTotal, .*slower than baseline/,
    });
    await expect(frame).toHaveCount(1);
  });
});
