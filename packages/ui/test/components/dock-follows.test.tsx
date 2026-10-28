import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, hasSelection, openApp } from '../helpers/open-app';

// The source dock follows the selection: nothing selected, it is a slim rail; a selection that has
// code (a function, a call, a Show me target) extends it; clearing collapses it. The rail offers
// "Expand source panel" and the extended dock offers "Collapse source panel".

const expectRail = () => screen.findByRole('button', { name: 'Expand source panel' });
const expectExtended = () => screen.findByRole('button', { name: 'Collapse source panel' });

async function selectInFunctions(name: RegExp): Promise<void> {
  await userEvent.keyboard('4');
  await userEvent.click((await screen.findAllByRole('row', { name }))[0] as Element);
}

async function opened(url = ''): Promise<void> {
  if (url) history.replaceState(null, '', url);
  openApp();
  await appReady();
}

describe('the dock follows the selection', () => {
  it('is extended when the session opens on the top finding', async () => {
    await opened();
    await expectExtended();
  });

  it('collapses when the selection is cleared with Escape, and extends when one is made again', async () => {
    await opened();
    await expectExtended();
    await userEvent.keyboard('{Escape}');
    await expectRail();
    await selectInFunctions(/formatCurrency/);
    await expectExtended();
  });

  it('collapses on click-off and extends on the next selection', async () => {
    await opened();
    await expectExtended();
    await userEvent.click(document.body);
    await expectRail();
    await selectInFunctions(/lineTotal/);
    await expectExtended();
  });

  it('collapses when the Clear selection chip is used', async () => {
    await opened();
    await expectExtended();
    await userEvent.click(screen.getByRole('button', { name: /Clear selection/ }));
    await expectRail();
  });

  it('a manual collapse holds only until the selection next changes from empty to something', async () => {
    await opened();
    const region = await screen.findByRole('region', { name: 'Source' });
    await within(region).findByRole('heading', { name: 'lineTotal' });
    await userEvent.click(await expectExtended());
    await expectRail();
    await userEvent.keyboard('{Escape}');
    await selectInFunctions(/lineTotal/);
    await expectExtended();
  });

  it('starts collapsed from a URL without a selection and extended from one with it', async () => {
    await opened('#v=functions');
    await expectRail();
    expect(hasSelection()).toBe(false);
  });

  it('starts extended from a URL that holds a selection', async () => {
    await opened();
    await expectExtended();
    const withSelection = location.hash;
    expect(withSelection).toContain('sel=');
    document.body.innerHTML = '';
    await opened(withSelection);
    await expectExtended();
  });

  it('extends for a Show me target that has code', async () => {
    await opened();
    await userEvent.keyboard('{Escape}');
    await expectRail();
    await userEvent.click(
      screen.getByRole('button', { name: 'Show me: Synchronous I/O on a hot path' }),
    );
    await expectExtended();
  });

  it('follows Back and Forward through history', async () => {
    await opened();
    await expectExtended();
    await userEvent.click(document.body);
    await expectRail();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(hasSelection()).toBe(true));
    await expectExtended();
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(hasSelection()).toBe(false));
    await expectRail();
  });

  it('stays collapsed for a task selection, which has no source', async () => {
    await opened();
    await userEvent.click(screen.getByRole('button', { name: 'Show me: Event loop blocked' }));
    await waitFor(() =>
      expect(document.querySelector('.finding-card.is-active')?.textContent).toContain(
        'Event loop blocked',
      ),
    );
    await expectRail();
    const drawer = screen.getByRole('region', { name: 'Selection details' });
    await waitFor(() =>
      expect(within(drawer).getAllByText(/GET \/orders/).length).toBeGreaterThan(0),
    );
  });
});
