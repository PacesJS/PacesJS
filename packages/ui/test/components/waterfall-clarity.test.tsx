import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, openApp } from '../helpers/open-app';
import { fixtureModel, preload } from '../helpers/real-model';

await preload('orders-server', 'eslint-cli', 'eslint-cli-wrapped');

// Clarity: which numbers cover one call and which cover every call, elapsed against CPU time, and
// rows whose callees are hidden by the minimum duration.

const table = () => screen.findByRole('table', { name: 'Waterfall rows' });
const rowsOf = async (): Promise<HTMLElement[]> => within(await table()).getAllByRole('row');
const dock = () => screen.getByRole('complementary', { name: 'Source dock' });

async function showView(name: RegExp): Promise<void> {
  const views = screen.getByRole('navigation', { name: 'Views' });
  await userEvent.click(within(views).getByRole('button', { name }));
}

async function openWaterfall(fixture?: string): Promise<void> {
  openApp(fixture ? fixtureModel(fixture) : undefined);
  await appReady();
  await showView(/^Waterfall/);
  await table();
}

describe('rows with callees below the minimum duration', () => {
  it('keep a chevron and open to a summary row, while a true leaf has none', async () => {
    await openWaterfall('eslint-cli');
    await userEvent.selectOptions(document.querySelector('#wf-min') as Element, '20000');
    const hiding = (await rowsOf()).filter((r) =>
      /callees? under .* hidden/.test(r.getAttribute('aria-description') ?? ''),
    );
    expect(hiding.length).toBeGreaterThan(0);
    expect(hiding.every((r) => r.hasAttribute('aria-expanded'))).toBe(true);

    const row = (await rowsOf()).find(
      (r) =>
        r.getAttribute('aria-expanded') === 'false' &&
        (r.getAttribute('aria-description') ?? '').includes('under 20 ms hidden'),
    ) as HTMLElement;
    const level = Number(row.getAttribute('aria-level'));
    await userEvent.click(row.querySelector('.wf-twisty') as Element);
    await waitFor(async () =>
      expect(
        (await rowsOf()).some(
          (r) =>
            r.getAttribute('aria-level') === String(level + 1) &&
            (r.getAttribute('aria-label') ?? '').includes('under 20 ms hidden'),
        ),
      ).toBe(true),
    );
  });
});

describe('elapsed time against CPU time', () => {
  it('a row that awaits says elapsed, CPU and awaiting; a plain row keeps the plain text', async () => {
    await openWaterfall('eslint-cli');
    const rows = await rowsOf();
    const texts = rows.map((r) => r.getAttribute('aria-description') ?? '');
    expect(
      texts.some((t) => /^elapsed [\d.]+ ms \(CPU ~[\d.]+ ms, ~[\d.]+ ms awaiting\)/.test(t)),
    ).toBe(true);
    expect(texts.some((t) => /^~[\d.]+ ms · [\d.]+% of the run/.test(t))).toBe(true);
    // A merged row spans the clock from its first segment to its last; its CPU is a small part.
    const merged = rows.find((r) => r.textContent?.includes('loadConfigArrayForDirectory'));
    expect(merged?.getAttribute('aria-description')).toMatch(
      /^elapsed 129\d\.\d ms \(CPU ~4\d\.\d ms, ~12\d\d ms awaiting\)/,
    );
  });

  it('the TIME column says it is elapsed time', async () => {
    await openWaterfall('eslint-cli-wrapped');
    const head = Array.from(document.querySelectorAll('.wf-head-cell')).find(
      (el) => el.textContent === 'Time',
    );
    expect(head?.getAttribute('title')).toBe('Elapsed time of the call (includes awaiting)');
  });
});

describe('one call against all calls of its function', () => {
  const clickRow = async (name: RegExp): Promise<void> => {
    const row = (await screen.findAllByRole('row', { name }))[0] as Element;
    await userEvent.click(row);
  };

  it('a selected call row shows its own numbers and defaults the dock to this call', async () => {
    await openWaterfall();
    await clickRow(/getOrders/);
    await waitFor(() =>
      expect(dock().textContent).toMatch(/This call: .* total \(CPU\) · .* self/),
    );
    expect(dock().textContent).toMatch(/All (~[\d,]+ )?calls of getOrders: .* total \(CPU\)/);
    expect(
      within(dock()).getByRole('button', { name: 'This call' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await userEvent.click(within(dock()).getByRole('button', { name: 'All calls' }));
    expect(
      within(dock()).getByRole('button', { name: 'All calls' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('the drawer labels the scope and the kind of time', async () => {
    await openWaterfall();
    await clickRow(/getOrders/);
    const drawer = screen.getByRole('region', { name: 'Selection details' });
    await waitFor(() => expect(drawer.textContent).toMatch(/This call: /));
    expect(drawer.textContent).toMatch(/All (~[\d,]+ )?calls of getOrders/);
    expect(drawer.textContent).toContain('Total time (CPU)');
  });

  it('a function chosen in the Functions table covers all calls and has no toggle', async () => {
    await openWaterfall();
    await showView(/^Functions/);
    await clickRow(/lineTotal/);
    await waitFor(() => expect(dock().textContent).toMatch(/All (~[\d,]+ )?calls of lineTotal/));
    expect(within(dock()).queryByRole('button', { name: 'This call' })).toBeNull();
    expect(dock().querySelector('.source-totals.is-call')).toBeNull();
  });

  it('line bars say which calls they cover', async () => {
    await openWaterfall();
    await showView(/^Functions/);
    await clickRow(/renderInvoice/);
    await waitFor(() =>
      expect(dock().querySelectorAll('.source-gutter').length).toBeGreaterThan(0),
    );
    const titles = Array.from(dock().querySelectorAll('.source-gutter'))
      .map((el) => el.getAttribute('title') ?? '')
      .filter(Boolean);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => /across all (~[\d,]+ )?calls/.test(t))).toBe(true);
  });
});
