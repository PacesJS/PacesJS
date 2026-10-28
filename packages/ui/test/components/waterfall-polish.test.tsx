import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, openApp } from '../helpers/open-app';
import { fixtureModel } from '../helpers/real-model';

// Waterfall polish: the bar says how long it took, in words and on hover, and very deep chains say
// how deep they are. What needs real layout (the highlight sitting behind the bars, the name column
// never overflowing, one horizontal scrollbar) is checked in e2e/ui/layout.spec.ts.

const rowsOf = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole('table', { name: 'Waterfall rows' })).getAllByRole('row');
const rowNamed = async (name: string): Promise<HTMLElement> =>
  (await rowsOf()).find((r) => r.textContent?.includes(name)) as HTMLElement;

async function showWaterfall(): Promise<void> {
  const views = screen.getByRole('navigation', { name: 'Views' });
  await userEvent.click(within(views).getByRole('button', { name: /^Waterfall/ }));
  await screen.findByRole('table', { name: 'Waterfall rows' });
}

describe('the duration tooltip', () => {
  const open = async (): Promise<void> => {
    openApp();
    await appReady();
    await showWaterfall();
  };

  it('shows the time, share and span after a short delay over the bar, and goes when the pointer does', async () => {
    await open();
    const row = await rowNamed('buildInvoiceRows');
    await userEvent.hover(row.querySelector('.wf-bar-hit') as Element);
    await waitFor(() =>
      expect(document.querySelector('.tooltip')?.textContent).toMatch(
        /~[\d.]+ ms · [\d.]+% of the (?:run|task) · [\d.]+–[\d.]+ ms/,
      ),
    );
    await userEvent.unhover(row.querySelector('.wf-bar-hit') as Element);
    await waitFor(() => expect(document.querySelector('.tooltip')).toBeNull());
  });

  it('is on the row for keyboard and screen reader users too', async () => {
    await open();
    expect((await rowNamed('buildInvoiceRows')).getAttribute('aria-description')).toMatch(
      /~[\d.]+ ms · [\d.]+% of the (?:run|task)/,
    );
  });

  it('says "below sampling precision" for a hatched bar', async () => {
    await open();
    expect((await rowNamed('formatCurrency')).getAttribute('aria-description')).toMatch(
      /below sampling precision/,
    );
  });

  it('explains the white stripes on a bar as its own time, apart from the precision hatching', async () => {
    await open();
    const footer = document.querySelector('.view-footer') as HTMLElement;
    expect(within(footer).getByText(/own time/i)).toBeTruthy();
    expect(within(footer).getByText(/below sampling precision/)).toBeTruthy();
    expect(footer.querySelector('.swatch-self')).not.toBeNull();
  });
});

describe('very deep call chains', () => {
  const levels = async (): Promise<number[]> =>
    (await rowsOf()).map((r) => Number(r.getAttribute('aria-level')));

  /** Show me on the hot-path finding selects a function at the end of a chain 17 levels deep. */
  const openDeep = async (): Promise<void> => {
    openApp(fixtureModel('eslint-cli-wrapped'));
    await appReady();
    const card = document.querySelectorAll('.finding-card')[2] as HTMLElement;
    if (card.getAttribute('aria-current') !== 'true') {
      await userEvent.click(within(card).getByRole('button', { name: /^Show me:/ }));
    }
    await showWaterfall();
    await waitFor(async () => expect(Math.max(...(await levels()))).toBeGreaterThan(12));
  };

  it('deep rows say how deep they are and offer to focus there', async () => {
    await openDeep();
    const rows = await rowsOf();
    expect(rows.find((r) => r.querySelector('span.wf-depth'))?.textContent).toMatch(/⋯ \d+/);
    const deep = rows.find((r) => within(r).queryByRole('button', { name: /Focus here/ }));
    expect(deep?.querySelector('.wf-depth')?.textContent).toMatch(/^⋯ \d+$/);
    const level = Number(deep?.getAttribute('aria-level'));
    const chips = document.querySelectorAll('.chip-item').length;
    await userEvent.click(within(deep as HTMLElement).getByRole('button', { name: /Focus here/ }));
    // The transform re-roots the waterfall: the chain restarts from the top.
    await waitFor(() => expect(document.querySelectorAll('.chip-item')).toHaveLength(chips + 1));
    await waitFor(async () => expect(Math.max(...(await levels()))).toBeLessThan(level));
  });

  it('shallow rows have no badge and no focus button', async () => {
    await openDeep();
    const top = (await rowsOf())[0] as HTMLElement;
    expect(top.querySelector('.wf-depth')).toBeNull();
    expect(within(top).queryByRole('button', { name: /Focus here/ })).toBeNull();
  });
});
