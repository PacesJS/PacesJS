import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExecutionModel, Finding } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { encodeDevModel } from '../../src/data/dev-codec';
import { memoryHostAdapter } from '../../src/host/memory';
import { ORDERS, buildModel } from '../helpers/model-builder';

const findings: Finding[] = [
  {
    id: 'f1',
    kind: 'event-loop-blocked',
    severity: 'high',
    title: 'Event loop blocked',
    summary: '1 task ran over 50 ms.',
    rule: 'any task over 50 ms',
    impact: 0.9,
    showMe: { view: 'waterfall', track: 'main', task: 0, options: { criticalPath: true } },
    evidence: [],
  },
  {
    id: 'f2',
    kind: 'hot-function',
    severity: 'medium',
    title: 'Hot function',
    summary: 'lineTotal holds most self time.',
    rule: 'a user function over 10% self',
    impact: 0.5,
    showMe: { view: 'functions', track: 'main', fn: 1 },
    evidence: [],
  },
];

function open(model: ExecutionModel = buildModel({ roots: ORDERS, findings })) {
  const host = memoryHostAdapter({ model: encodeDevModel(model), meta: {} });
  render(<App host={host} inProcess />);
  return host;
}

async function ready(): Promise<void> {
  await screen.findByRole('heading', { name: 'Findings' });
}

describe('paces screen', () => {
  it('shows the brand, the command and the default transforms in the header', async () => {
    open();
    await ready();
    expect(screen.getByText('paces')).toBeTruthy();
    expect(screen.getByText('node server.js')).toBeTruthy();
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
    expect(screen.getByText(/Sampled · 1 ms · ±1 ms/)).toBeTruthy();
  });

  it('opens on the top finding, selected, in its view', async () => {
    open();
    await ready();
    const card = screen.getByRole('button', { name: 'Show me: Event loop blocked' }).closest('li');
    expect(card?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /Waterfall/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('switches views with the number keys', async () => {
    open();
    await ready();
    await userEvent.keyboard('2');
    expect(screen.getByRole('button', { name: /Flame graph/ }).getAttribute('aria-current')).toBe(
      'page',
    );
    await userEvent.keyboard('4');
    expect(screen.getByRole('button', { name: /Functions/ }).getAttribute('aria-current')).toBe(
      'page',
    );
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
    await userEvent.click(screen.getByRole('button', { name: 'Show me: Hot function' }));
    expect(screen.getByRole('button', { name: /Functions/ }).getAttribute('aria-current')).toBe(
      'page',
    );
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Waterfall/ }).getAttribute('aria-current')).toBe(
        'page',
      ),
    );
  });

  it('opens the shortcut sheet with ? and closes it with Escape', async () => {
    open();
    await ready();
    await userEvent.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('does not switch views while typing in the search field', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('searchbox', { name: /Search functions/ }));
    await userEvent.keyboard('3');
    expect(screen.getByRole('button', { name: /Waterfall/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('warns that a profile under 200 samples is statistically noisy', async () => {
    open();
    await ready();
    expect(screen.getByText(/statistically noisy/)).toBeTruthy();
  });

  it('keeps a dismissed first-run hint dismissed', async () => {
    open();
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByRole('button', { name: 'Dismiss tip' })).toBeNull();
  });

  it('explains how to compare sessions when no baseline is loaded', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Compare with…' }));
    expect(screen.getByText(/paces diff a.paces b.paces/)).toBeTruthy();
  });
});

describe('linked selection', () => {
  it('selecting a function row shows it in the details drawer', async () => {
    open();
    await ready();
    await userEvent.keyboard('4');
    await userEvent.click(await screen.findByRole('row', { name: /lineTotal/ }));
    const drawer = await screen.findByRole('region', { name: 'Selection details' });
    await waitFor(() =>
      expect(within(drawer).getByRole('heading', { name: 'lineTotal' })).toBeTruthy(),
    );
  });

  it('restores the exact screen from a pasted URL hash', async () => {
    history.replaceState(null, '', '#v=flame&t=drop-idle');
    open();
    await ready();
    expect(screen.getByRole('button', { name: /Flame graph/ }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('button', { name: 'Rewind to Merge plumbing' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rewind to Drop idle' })).toBeTruthy();
  });
});
