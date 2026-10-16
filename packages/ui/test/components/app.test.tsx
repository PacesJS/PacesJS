import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { memoryHostAdapter } from '../../src/host/memory';
import { fixtureModel, ordersModel } from '../helpers/real-model';

const orders = ordersModel();
const [top] = orders.findings;
/** The Show me button of the n-th finding card (titles repeat, e.g. two hot functions). */
const showMe = (n: number): HTMLElement =>
  screen.getAllByRole('button', { name: /^Show me:/ })[n] as HTMLElement;

function open(model: ExecutionModel = orders, baseline?: ExecutionModel) {
  const host = memoryHostAdapter({
    model: serializeModel(model),
    baseline: baseline ? serializeModel(baseline) : undefined,
    meta: {},
  });
  render(<App host={host} inProcess />);
  return host;
}

async function ready(): Promise<void> {
  await screen.findByRole('heading', { name: 'Findings' });
}

const current = (name: RegExp) => screen.getByRole('button', { name }).getAttribute('aria-current');

describe('paces screen', () => {
  it('shows the brand, the command and the default transforms in the header', async () => {
    open();
    await ready();
    expect(screen.getByText('paces')).toBeTruthy();
    expect(screen.getByText(orders.meta.command.join(' '))).toBeTruthy();
    const stack = screen.getByRole('list', { name: 'Transform stack, oldest first' });
    expect(
      within(stack).getByRole('button', { name: 'Rewind to Collapse dependencies' }),
    ).toBeTruthy();
    expect(within(stack).getByRole('button', { name: 'Rewind to Merge plumbing' })).toBeTruthy();
    expect(within(stack).getByRole('button', { name: 'Rewind to Drop idle' })).toBeTruthy();
  });

  it('labels the sampling precision honestly', async () => {
    open();
    await ready();
    expect(screen.getByText(/Sampled · .* ms · ±.* ms/)).toBeTruthy();
  });

  it('opens on the top finding: card #1 is current, in the view its showMe names', async () => {
    open();
    await ready();
    const card = showMe(0).closest('li');
    expect(card?.getAttribute('aria-current')).toBe('true');
    expect(card?.textContent).toContain('#1');
    expect(card?.textContent).toContain(top?.title);
    expect(current(/Functions/)).toBe('page');
  });

  it('opens with the top finding selected: the source panel and details show its function', async () => {
    open();
    await ready();
    const source = await screen.findByRole('region', { name: 'Source' });
    await waitFor(() =>
      expect(within(source).getByRole('heading', { name: 'lineTotal' })).toBeTruthy(),
    );
    const drawer = screen.getByRole('region', { name: 'Selection details' });
    await waitFor(() =>
      expect(within(drawer).getByRole('heading', { name: 'lineTotal' })).toBeTruthy(),
    );
    expect(screen.queryByText('No function selected')).toBeNull();
  });

  it('switches views with the number keys', async () => {
    open();
    await ready();
    await userEvent.keyboard('2');
    expect(current(/Flame graph/)).toBe('page');
    await userEvent.keyboard('4');
    expect(current(/Functions/)).toBe('page');
  });

  it('removes a transform with its x button and records it in the URL hash', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Merge plumbing' }));
    expect(screen.queryByRole('button', { name: 'Rewind to Merge plumbing' })).toBeNull();
    expect(decodeURIComponent(location.hash)).toContain('t=collapse-deps,drop-idle');
  });

  it('rewinds the stack when a chip is clicked', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Rewind to Collapse dependencies' }));
    expect(screen.queryByRole('button', { name: 'Rewind to Drop idle' })).toBeNull();
  });

  it('applies Show me for another finding and goes back with Alt+Left', async () => {
    open();
    await ready();
    await userEvent.click(showMe(1));
    expect(current(/Waterfall/)).toBe('page');
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(current(/Functions/)).toBe('page'));
  });

  it('switches to the track a finding names', async () => {
    open();
    await ready();
    const index = orders.findings.findIndex((f) => f.showMe.track === orders.tracks[1]?.id);
    await userEvent.click(showMe(index));
    expect(decodeURIComponent(location.hash)).toContain(`tr=${orders.tracks[1]?.id}`);
  });

  it('opens the shortcut sheet with ? and closes it with Escape', async () => {
    open();
    await ready();
    await userEvent.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('documents p as collapsing the waterfall to the critical path', async () => {
    open();
    await ready();
    await userEvent.keyboard('?');
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getByText(/Collapse the waterfall to the critical path/)).toBeTruthy();
  });

  it('does not switch views while typing in the search field', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('searchbox', { name: /Search functions/ }));
    await userEvent.keyboard('3');
    expect(current(/Functions/)).toBe('page');
  });

  it('warns that a profile under 200 samples is statistically noisy', async () => {
    open(fixtureModel('sync-io'));
    await ready();
    expect(screen.getByText(/statistically noisy/)).toBeTruthy();
  });

  it('does not warn about noise on a long profile', async () => {
    open();
    await ready();
    expect(screen.queryByText(/statistically noisy/)).toBeNull();
  });

  it('keeps a dismissed first-run hint dismissed', async () => {
    open();
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByRole('button', { name: 'Dismiss tip' })).toBeNull();
  });
});

describe('compare with another session', () => {
  it('is disabled without a baseline and explains how to get one in its tooltip', async () => {
    open();
    await ready();
    const button = screen.getByRole('button', { name: 'Compare with…' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const tip = screen.getByRole('tooltip', { name: /paces diff/ });
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.textContent).toContain('paces diff a.paces b.paces');
  });

  it('does nothing when clicked without a baseline', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Compare with…' }));
    expect(screen.queryByRole('dialog', { name: 'Compare with another session' })).toBeNull();
  });

  it('is enabled with a baseline and explains the difference colors', async () => {
    open(orders, fixtureModel('sync-io'));
    await ready();
    const button = screen.getByRole('button', { name: 'Compare with…' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(button);
    expect(screen.getByText(/flame graph shows the difference/)).toBeTruthy();
  });
});

describe('waterfall', () => {
  const wfHash = `#v=waterfall&tr=${orders.tracks[0]?.id}&o=${encodeURIComponent('task:7')}`;
  const rowsOf = () =>
    within(screen.getByRole('table', { name: 'Waterfall rows' })).getAllByRole('row');

  it('roots the rows at the task itself with its first user frame beneath', async () => {
    history.replaceState(null, '', wfHash);
    open();
    await ready();
    await screen.findByRole('table', { name: 'Waterfall rows' });
    const labels = await waitFor(() => rowsOf().map((r) => r.getAttribute('aria-label') ?? ''));
    expect(labels[0]).toMatch(/^GET \/orders,/);
    expect(labels[1]).toMatch(/^getOrders,/);
  });

  it('collapses every row but the critical chain when p is pressed, and expands on a second p', async () => {
    history.replaceState(null, '', wfHash);
    open();
    await ready();
    await screen.findByRole('table', { name: 'Waterfall rows' });
    const before = await waitFor(() => rowsOf().length);
    await userEvent.keyboard('p');
    await waitFor(() => expect(rowsOf().length).toBeLessThan(before));
    expect(decodeURIComponent(location.hash)).toContain('cpo:1');
    expect(rowsOf().every((r) => /critical path/.test(r.getAttribute('aria-label') ?? ''))).toBe(
      true,
    );
    await userEvent.keyboard('p');
    await waitFor(() => expect(rowsOf().length).toBe(before));
  });

  it('leaves the rows alone when only the critical-path outline switch is toggled', async () => {
    history.replaceState(null, '', wfHash);
    open();
    await ready();
    await screen.findByRole('table', { name: 'Waterfall rows' });
    const before = await waitFor(() => rowsOf().length);
    await userEvent.click(screen.getByRole('switch', { name: /^Critical path$/ }));
    expect(rowsOf().length).toBe(before);
  });
});

describe('linked selection', () => {
  it('selecting a function row shows it in the details drawer', async () => {
    open();
    await ready();
    await userEvent.keyboard('4');
    await userEvent.click(await screen.findByRole('row', { name: /formatCurrency/ }));
    const drawer = await screen.findByRole('region', { name: 'Selection details' });
    await waitFor(() =>
      expect(within(drawer).getByRole('heading', { name: 'formatCurrency' })).toBeTruthy(),
    );
  });

  it('restores the exact screen from a pasted URL hash', async () => {
    history.replaceState(null, '', '#v=flame&t=drop-idle');
    open();
    await ready();
    expect(current(/Flame graph/)).toBe('page');
    expect(screen.queryByRole('button', { name: 'Rewind to Merge plumbing' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rewind to Drop idle' })).toBeTruthy();
  });
});
