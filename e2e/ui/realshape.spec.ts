import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { expect, openFixture, settled, test } from './fixtures';

// Real-shape sessions: the eslint captures are a CLI run of a large dependency tree, nothing like
// the zoo servers. These tests load them through the dev host and check that no view fails, and
// that the first screen of the waterfall shows the target's own functions.

const ENGINE = pathToFileURL(
  resolve(import.meta.dirname, '../../packages/engine/dist/index.js'),
).href;
/** The slice of the engine this test uses, loaded from its build output. */
interface EngineSlice {
  analyze(capture: unknown): unknown;
  serializeModel(model: unknown): Uint8Array;
}

const FIXTURES = resolve(import.meta.dirname, '../../packages/engine/test/fixtures');

const FAILURE =
  /TypeError|ReferenceError|RangeError|is not a function|Cannot read|undefined is not|could not open|Error:|NaN/;

async function expectNoFailure(page: Page, where: string): Promise<void> {
  await expect(page.locator('[role="alert"]'), `${where}: an alert is showing`).toHaveCount(0);
  const text = await page.locator('body').innerText();
  expect(text.match(FAILURE)?.[0] ?? null, `${where}: error text on the page`).toBeNull();
}

const VIEWS = [
  { key: '1', name: 'Waterfall' },
  { key: '2', name: 'Flame graph' },
  { key: '3', name: 'Call graph' },
  { key: '4', name: 'Functions' },
] as const;

for (const fixture of ['eslint-cli', 'eslint-cli-wrapped']) {
  test.describe(`real-shape session: ${fixture}`, () => {
    test.beforeEach(async ({ page, serve }) => {
      await openFixture(page, serve, fixture);
      await settled(page);
    });

    for (const v of VIEWS) {
      test(`the ${v.name} view shows no error`, async ({ page }) => {
        await page.keyboard.press('Escape');
        await page.keyboard.press(v.key);
        await settled(page);
        await page.waitForTimeout(300);
        await expectNoFailure(page, v.name);
      });
    }

    test('the source dock, details and notes show no error for the top finding', async ({
      page,
    }) => {
      await expectNoFailure(page, 'opening view');
      await page.getByRole('button', { name: /note/ }).click();
      await expectNoFailure(page, 'notes');
    });

    test('the whole-run waterfall opens on the target own functions, not on bootstrap noise', async ({
      page,
    }) => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('1');
      await settled(page);
      const rows = page.getByRole('table', { name: 'Waterfall rows' }).getByRole('row');
      await expect(rows.first()).toBeVisible();
      const names = await rows.evaluateAll((els) =>
        els.map((e) => e.getAttribute('aria-label') ?? ''),
      );
      expect(
        names.some((n) =>
          /^(verify|runRules|verifyText|readAndVerifyFile|lintFiles|verifyAndFix),/.test(n),
        ),
      ).toBe(true);
      // Node's pre-execution frames are folded away, not listed one by one.
      expect(names.some((n) => /^prepareMainThreadExecution,/.test(n))).toBe(false);
    });

    test('rows under measurement precision are folded, with a chip that shows them again', async ({
      page,
    }) => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('1');
      await settled(page);
      await expect(page.getByText(/Hiding rows under/)).toBeVisible();
      await page.getByRole('button', { name: 'show', exact: true }).click();
      await expect(page.getByText(/Hiding rows under/)).toHaveCount(0);
      await expect(page.getByLabel('Min duration').locator('option:checked')).toHaveText('Any');
    });
  });
}

test.describe('a model that was serialized before', () => {
  test('the dev host serves a cached model and every view still renders', async ({
    page,
    serve,
  }) => {
    const engine = (await import(ENGINE)) as EngineSlice;
    const raw: unknown = JSON.parse(
      gunzipSync(readFileSync(join(FIXTURES, 'eslint-cli.capture.json.gz'))).toString('utf8'),
    );
    const dir = mkdtempSync(join(tmpdir(), 'paces-model-'));
    const file = join(dir, 'model.bin');
    try {
      writeFileSync(file, engine.serializeModel(engine.analyze(raw)));
      await openFixture(page, serve, 'eslint-cli', file);
      await settled(page);
      for (const v of VIEWS) {
        await page.keyboard.press('Escape');
        await page.keyboard.press(v.key);
        await settled(page);
        await page.waitForTimeout(300);
        await expectNoFailure(page, `cached model, ${v.name}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
