import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, hasSelection, openApp } from '../helpers/open-app';

// Click-off, through the whole app: with a call selected, a click on anything that is not
// interactive clears it. The rules themselves are tested in app/click-off.test.ts.

async function withSelection(view?: string): Promise<void> {
  openApp();
  await appReady();
  if (view) await userEvent.keyboard(view);
  await waitFor(() => expect(hasSelection()).toBe(true));
}

const details = (): HTMLElement => screen.getByRole('region', { name: 'Selection details' });
const cleared = async (): Promise<void> => {
  await waitFor(() => expect(hasSelection()).toBe(false));
  expect(within(details()).getByText(/Nothing selected/)).toBeTruthy();
};

describe.each([
  ['1', 'waterfall'],
  ['2', 'flame graph'],
  ['3', 'call graph'],
  ['4', 'functions'],
])('click-off in the %s view (%s)', (key) => {
  it('clears when the page background is clicked', async () => {
    await withSelection(key);
    await userEvent.click(document.body);
    await cleared();
  });

  it('clears when the panel padding is clicked', async () => {
    await withSelection(key);
    await userEvent.click(document.querySelector('.main-view') as Element);
    await cleared();
  });

  it('clears when a caption is clicked', async () => {
    await withSelection(key);
    const caption = document.querySelector('.axis-caption, .fn-status');
    await userEvent.click(caption as Element);
    await cleared();
  });

  it('Back restores the selection that click-off cleared', async () => {
    await withSelection(key);
    await userEvent.click(document.body);
    await cleared();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(hasSelection()).toBe(true));
  });
});

describe('click-off keeps the selection', () => {
  it('when a toolbar button is clicked', async () => {
    await withSelection('3');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(hasSelection()).toBe(true);
  });

  it('when a tab is clicked', async () => {
    await withSelection('1');
    const views = screen.getByRole('navigation', { name: 'Views' });
    await userEvent.click(within(views).getByRole('button', { name: /Flame/ }));
    expect(hasSelection()).toBe(true);
  });

  it('when a switch or a select is used', async () => {
    await withSelection('1');
    await userEvent.click(screen.getByRole('switch', { name: /Critical path$/ }));
    await userEvent.selectOptions(document.querySelector('#wf-sort') as Element, 'duration');
    expect(hasSelection()).toBe(true);
  });

  it('when the source dock or the details drawer is clicked', async () => {
    await withSelection('4');
    const dock = screen.getByRole('complementary', { name: 'Source dock' });
    await userEvent.click(dock.querySelector('.source-title') as Element);
    await userEvent.click(dock.querySelector('.source-head') as Element);
    await userEvent.click(details().querySelector('.stat-grid') as Element);
    expect(hasSelection()).toBe(true);
  });
});

describe('click-off and the escape routes', () => {
  it('Escape and the Clear selection chip still clear', async () => {
    await withSelection('4');
    await userEvent.keyboard('{Escape}');
    await cleared();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(hasSelection()).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /Clear selection/ }));
    await cleared();
  });

  it('closing a popover with a click does not also clear the selection', async () => {
    await withSelection('4');
    await userEvent.click(screen.getByRole('button', { name: 'Add transform' }));
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu', { name: 'Add transform' })).toBeNull();
    expect(hasSelection()).toBe(true);
  });
});
