import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, openApp } from '../helpers/open-app';
import { fixtureModel } from '../helpers/real-model';

// Real-shape sessions: the eslint captures are a CLI run of a large dependency tree, nothing like
// the zoo servers. Every view must open on them without failing, and the first screen of the
// waterfall must show the target's own functions. The model goes through serializeModel, as a
// cached one does when the host serves it.

const FAILURE =
  /TypeError|ReferenceError|RangeError|is not a function|Cannot read|undefined is not|could not open|Error:|NaN/;

const noFailure = (where: string): void => {
  expect(screen.queryAllByRole('alert'), `${where}: an alert is showing`).toHaveLength(0);
  expect(document.body.textContent?.match(FAILURE)?.[0] ?? null, `${where}: error text`).toBeNull();
};

const VIEWS = [
  { key: '1', name: 'Waterfall' },
  { key: '2', name: 'Flame graph' },
  { key: '3', name: 'Call graph' },
  { key: '4', name: 'Functions' },
] as const;

describe.each(['eslint-cli', 'eslint-cli-wrapped'])('real-shape session: %s', (fixture) => {
  const open = async (): Promise<void> => {
    openApp(fixtureModel(fixture));
    await appReady();
  };

  it.each(VIEWS)('the $name view shows no error', async ({ key, name }) => {
    await open();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard(key);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Views' }))
          .getByRole('button', { name: new RegExp(name) })
          .getAttribute('aria-current'),
      ).toBe('page'),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    noFailure(name);
  });

  it('the source dock, details and notes show no error for the top finding', async () => {
    await open();
    noFailure('opening view');
    await userEvent.click(screen.getByRole('button', { name: /note/ }));
    noFailure('notes');
  });

  it('the whole-run waterfall opens on the target own functions, not on bootstrap noise', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('1');
    const rows = await within(
      await screen.findByRole('table', { name: 'Waterfall rows' }),
    ).findAllByRole('row');
    const names = rows.map((row) => row.getAttribute('aria-label') ?? '');
    expect(
      names.some((n) =>
        /^(verify|runRules|verifyText|readAndVerifyFile|lintFiles|verifyAndFix),/.test(n),
      ),
    ).toBe(true);
    expect(names.some((n) => /^prepareMainThreadExecution,/.test(n))).toBe(false);
  });

  it('rows under measurement precision are folded, with a chip that shows them again', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('1');
    expect(await screen.findByText(/Hiding rows under/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'show' }));
    await waitFor(() => expect(screen.queryByText(/Hiding rows under/)).toBeNull());
    const select = screen.getByLabelText('Min duration') as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe('Any');
  });
});
