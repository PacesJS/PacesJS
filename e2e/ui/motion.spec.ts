import type { Page } from '@playwright/test';
import { expect, settled, test } from './fixtures';

// Motion: a small set of tokens, used for the dock, popovers, tabs and chips, and switched off
// entirely when the user asks for reduced motion.

async function css(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
}

const seconds = (value: string): number[] =>
  value.split(',').map((v) => (v.trim().endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v)));

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add transform' }).click();
  await expect(page.getByRole('menu', { name: 'Add transform' })).toBeVisible();
}

test.describe('motion tokens', () => {
  test('are defined once, in the theme', async ({ app }) => {
    const tokens = await app.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return ['--dur-fast', '--dur-med', '--dur-slow', '--ease-out', '--ease-in-out'].map((t) =>
        s.getPropertyValue(t).trim(),
      );
    });
    // The build may write 120ms as .12s; compare in seconds.
    expect(seconds(tokens.slice(0, 3).join(','))).toEqual([0.12, 0.2, 0.32]);
    expect(tokens[3]).toMatch(/cubic-bezier/);
    expect(tokens[4]).toMatch(/cubic-bezier/);
  });
});

test.describe('with normal motion', () => {
  test('the dock slides: it has a non-zero transition', async ({ app }) => {
    await settled(app);
    await expect
      .poll(async () => Math.max(...seconds(await css(app, 'aside.dock', 'transition-duration'))))
      .toBeGreaterThan(0);
  });

  test('a popover fades in', async ({ app }) => {
    await settled(app);
    await openMenu(app);
    expect(await css(app, '.menu[role="menu"]', 'animation-name')).not.toBe('none');
    expect(
      Math.max(...seconds(await css(app, '.menu[role="menu"]', 'animation-duration'))),
    ).toBeGreaterThan(0);
  });

  test('tabs ease between states', async ({ app }) => {
    await settled(app);
    expect(Math.max(...seconds(await css(app, '.tab', 'transition-duration')))).toBeGreaterThan(0);
  });

  test('transform chips animate in', async ({ app }) => {
    await settled(app);
    expect(await css(app, '.chip-item', 'animation-name')).not.toBe('none');
  });

  test('the dock extends over time, not in one frame', async ({ app }) => {
    await settled(app);
    await app.keyboard.press('Escape');
    await expect
      .poll(
        async () =>
          (await app.getByRole('complementary', { name: 'Source dock' }).boundingBox())?.width ?? 0,
      )
      .toBeLessThan(120);
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    const widths: number[] = [];
    const dock = app.getByRole('complementary', { name: 'Source dock' });
    for (let i = 0; i < 8; i++) {
      widths.push((await dock.boundingBox())?.width ?? 0);
      await app.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    }
    // The transition hands the layout over once: widths never overshoot the final width.
    const final = widths.at(-1) ?? 0;
    expect(widths.every((w) => w <= final + 1)).toBe(true);
  });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the dock does not transition', async ({ app }) => {
    await settled(app);
    expect(seconds(await css(app, 'aside.dock', 'transition-duration')).every((s) => s === 0)).toBe(
      true,
    );
  });

  test('a popover appears without animation', async ({ app }) => {
    await settled(app);
    await openMenu(app);
    expect(await css(app, '.menu[role="menu"]', 'animation-name')).toBe('none');
  });

  test('tabs switch without a transition', async ({ app }) => {
    await settled(app);
    expect(seconds(await css(app, '.tab', 'transition-duration')).every((s) => s === 0)).toBe(true);
  });

  test('chips appear without animation', async ({ app }) => {
    await settled(app);
    expect(await css(app, '.chip-item', 'animation-name')).toBe('none');
  });

  test('nothing slides when the selection changes', async ({ app }) => {
    await settled(app);
    await app.keyboard.press('Escape');
    await app.keyboard.press('4');
    await app
      .getByRole('row', { name: /lineTotal/ })
      .first()
      .click();
    const w =
      (await app.getByRole('complementary', { name: 'Source dock' }).boundingBox())?.width ?? 0;
    const next = await app.evaluate(
      () =>
        new Promise<number>((done) =>
          requestAnimationFrame(() =>
            done(document.querySelector('aside.dock')?.getBoundingClientRect().width ?? 0),
          ),
        ),
    );
    expect(Math.abs(next - w)).toBeLessThan(2);
  });
});
