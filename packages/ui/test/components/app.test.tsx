import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { createQueries } from '../../src/data/queries';
import { memoryHostAdapter } from '../../src/host/memory';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel, ordersModel } from '../helpers/real-model';

const orders = ordersModel();
const [top] = orders.findings;
/** The Show me button of the n-th finding card (titles repeat, e.g. two hot functions). */
const showMe = (n: number): HTMLElement =>
  screen.getAllByRole('button', { name: /^Show me:/ })[n] as HTMLElement;

function open(
  model: ExecutionModel = orders,
  baseline?: ExecutionModel,
  sources?: Record<string, { text: string }>,
) {
  const host = memoryHostAdapter({
    model: serializeModel(model),
    baseline: baseline ? serializeModel(baseline) : undefined,
    meta: {},
    sources,
  });
  render(<App host={host} inProcess elk={nodeElk} />);
  return host;
}

async function ready(): Promise<void> {
  await screen.findByRole('heading', { name: 'Findings' });
}

const current = (name: RegExp) => screen.getByRole('button', { name }).getAttribute('aria-current');

describe('marks', () => {
  const at = (ms: number): number => orders.meta.startedAt + ms;
  const marked: ExecutionModel = {
    ...orders,
    meta: {
      ...orders.meta,
      marks: [
        { at: at(300), label: 'Mark 1' },
        { at: at(800), label: 'Mark 2' },
      ],
    },
  };
  const hashRange = (): string => new URLSearchParams(location.hash.slice(1)).get('r') ?? '';

  it('shows nothing about marks for a run without any', async () => {
    open();
    await ready();
    expect(screen.queryByRole('button', { name: /^Mark \d/ })).toBeNull();
  });

  it('says a run ended with the stop key, in words', async () => {
    open({ ...orders, meta: { ...orders.meta, endedBy: 'stop' } });
    await ready();
    expect(screen.getByText('Stop key')).toBeTruthy();
  });

  it('puts each mark on the timeline as a button with its time', async () => {
    open(marked);
    await ready();
    expect(await screen.findByRole('button', { name: 'Mark 1, at 0.30 s' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark 2, at 0.80 s' })).toBeTruthy();
  });

  it.each([
    ['Focus before Mark 2', '0..800000'],
    ['Focus after Mark 1', `300000..${orders.meta.durationUs}`],
    ['Focus between Mark 1 and Mark 2', '300000..800000'],
  ])('%s sets the range %s', async (item, range) => {
    open(marked);
    await ready();
    const name = item.includes('Mark 2') && !item.includes('Mark 1') ? 'Mark 2' : 'Mark 1';
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name},`) }));
    await userEvent.click(screen.getByRole('menuitem', { name: item }));
    await waitFor(() => expect(hashRange()).toBe(range));
  });
});

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
    expect(decodeURIComponent(location.hash)).toContain('t=stitch,collapse-deps,drop-idle');
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
    await userEvent.click(screen.getByRole('button', { name: /notes?/ }));
    expect(screen.getByText(/statistically noisy/)).toBeTruthy();
  });

  it('does not warn about noise on a long profile', async () => {
    open();
    await ready();
    expect(screen.queryByRole('button', { name: /notes?/ })).toBeNull();
    expect(screen.queryByText(/statistically noisy/)).toBeNull();
  });

  it('keeps a dismissed first-run hint dismissed', async () => {
    open();
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByRole('button', { name: 'Dismiss tip' })).toBeNull();
  });
});

describe('Show me contract', () => {
  const announced = () =>
    screen.getAllByRole('status').find((el) => /^Showing: /.test(el.textContent ?? ''));

  it('announces what it is showing', async () => {
    open();
    await ready();
    await waitFor(() =>
      expect(announced()?.textContent).toMatch(/^Showing: Hot function · lineTotal/),
    );
  });

  it('clears with Escape and stops announcing', async () => {
    open();
    await ready();
    await waitFor(() => expect(announced()).toBeTruthy());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(announced()).toBeUndefined());
    expect(showMe(0).closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(decodeURIComponent(location.hash)).not.toContain('sel=');
  });

  it('clears with the visible Clear selection chip', async () => {
    open();
    await ready();
    const drawer = await screen.findByRole('region', { name: 'Selection details' });
    await userEvent.click(await within(drawer).findByRole('button', { name: /Clear selection/ }));
    await waitFor(() => expect(announced()).toBeUndefined());
    // The drawer remounts for a new selection, so look it up again.
    const after = await screen.findByRole('region', { name: 'Selection details' });
    expect(within(after).queryByRole('button', { name: /Clear selection/ })).toBeNull();
  });

  it('toggles off when the active finding is pressed again', async () => {
    open();
    await ready();
    expect(showMe(0).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(showMe(0));
    expect(showMe(0).getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(showMe(0));
    expect(showMe(0).getAttribute('aria-pressed')).toBe('true');
  });

  it('puts the hot dependency package in the call graph, selected and revealed', async () => {
    open(fixtureModel('eslint-cli'));
    await ready();
    const index = fixtureModel('eslint-cli')
      .findings.map((f) => f.kind)
      .lastIndexOf('hot-dependency');
    if (showMe(index).getAttribute('aria-pressed') !== 'true') await userEvent.click(showMe(index));
    expect(current(/Call graph/)).toBe('page');
    expect(decodeURIComponent(location.hash)).toMatch(/sel=fn:\d+/);
    expect(decodeURIComponent(location.hash)).toMatch(/rev:\d+/);
  });
});

describe('target and supporting tracks', () => {
  const eslint = fixtureModel('eslint-cli-wrapped');
  const select = () => screen.getByLabelText('Tracks') as HTMLSelectElement;

  it('opens on the target process, not on the first (supporting) track', async () => {
    open(eslint);
    await ready();
    expect(eslint.tracks[eslint.primaryTrack]?.role).toBe('target');
    expect(select().value).toBe(eslint.tracks[eslint.primaryTrack]?.id);
  });

  it('lists the target first and the supporting processes after it, labelled', async () => {
    open(eslint);
    await ready();
    const labels = Array.from(select().options).map((o) => o.textContent ?? '');
    expect(labels[0]).toMatch(/^eslint · pid/);
    expect(labels.slice(1).every((l) => /supporting/.test(l))).toBe(true);
  });

  it('explains a supporting track with a tooltip when one is selected', async () => {
    open(eslint);
    await ready();
    const support = eslint.tracks.find((t) => t.role === 'support');
    await userEvent.selectOptions(select(), support?.id ?? '');
    const notes = screen.getAllByTitle(/npx\/npm wrapper/);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('shows the program entry point in the header', async () => {
    open(eslint);
    await ready();
    const entry = screen.getByText('eslint/bin/eslint.js');
    expect(entry.getAttribute('title')).toContain('eslint/bin/eslint.js');
  });
});

describe('profile notes', () => {
  const cli = fixtureModel('eslint-cli');

  it('collapses the engine warnings into one chip, not a wall of text', async () => {
    open(cli);
    await ready();
    expect(screen.getByRole('button', { name: /1 note/ })).toBeTruthy();
    expect(screen.queryByText(/source map/i)).toBeNull();
  });

  it('lists the note with expandable details in a popover', async () => {
    open(cli);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /1 note/ }));
    const dialog = screen.getByRole('dialog', { name: 'Notes about this profile' });
    expect(within(dialog).getByText(/source map/i)).toBeTruthy();
    expect(within(dialog).getByText('Show details')).toBeTruthy();
  });

  it('closes on a click away and can be dismissed for the session', async () => {
    open(cli);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /1 note/ }));
    await userEvent.click(screen.getByRole('heading', { name: 'Findings' }));
    expect(screen.queryByRole('dialog', { name: 'Notes about this profile' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /1 note/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notes' }));
    expect(screen.queryByRole('button', { name: /note/ })).toBeNull();
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
    expect(labels[0]).toMatch(/^request · GET \/orders,/);
    expect(labels[1]).toMatch(/server\.js,/);
    expect(labels[2]).toMatch(/^getOrders,/);
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

describe('waterfall rows and columns', () => {
  const wfHash = `#v=waterfall&tr=${orders.tracks[0]?.id}&o=${encodeURIComponent('task:7')}`;
  const table = () => screen.getByRole('table', { name: 'Waterfall rows' });
  const rowsOf = () => within(table()).getAllByRole('row');
  const openWaterfall = async () => {
    history.replaceState(null, '', wfHash);
    open();
    await ready();
    await screen.findByRole('table', { name: 'Waterfall rows' });
    await waitFor(() => expect(rowsOf().length).toBeGreaterThan(5));
  };

  it('hovering one row marks only that row, even when the function repeats', async () => {
    await openWaterfall();
    const repeated = await waitFor(() => {
      const lines = rowsOf().filter((r) => /^lineTotal,/.test(r.getAttribute('aria-label') ?? ''));
      expect(lines.length).toBeGreaterThan(1);
      return lines;
    });
    await userEvent.hover(repeated[0] as HTMLElement);
    expect(rowsOf().filter((r) => r.classList.contains('is-hover'))).toHaveLength(1);
    expect(repeated[1]?.classList.contains('is-hover')).toBe(false);
  });

  it('selects the one clicked row and records its row id, not every call of the function', async () => {
    await openWaterfall();
    const lines = rowsOf().filter((r) => /^lineTotal,/.test(r.getAttribute('aria-label') ?? ''));
    await userEvent.click(lines[1] as HTMLElement);
    const selected = rowsOf().filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(lines[1]);
    expect(decodeURIComponent(location.hash)).toMatch(/sel=node:[^:&]+:[\d.]+:\d+/);
  });

  it('gives every name cell a title with the full text, so truncated text is still readable', async () => {
    await openWaterfall();
    const first = within(rowsOf()[2] as HTMLElement).getAllByRole('cell')[0];
    expect(first?.getAttribute('title')).toContain('getOrders');
  });

  it('exposes column resize handles that nudge with the arrow keys and persist', async () => {
    const host = open();
    history.replaceState(null, '', wfHash);
    await ready();
    const handle = await screen.findByRole('separator', { name: 'Resize Call column' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(
        screen.getByRole('separator', { name: 'Resize Call column' }).getAttribute('aria-valuenow'),
      ).toBe('328'),
    );
    await waitFor(async () =>
      expect(
        ((await host.loadSettings())['uiPrefs'] as { wfCols: { call: number } }).wfCols.call,
      ).toBe(328),
    );
  });

  it('auto-fits a column on Enter', async () => {
    await openWaterfall();
    const handle = screen.getByRole('separator', { name: 'Resize Time column' });
    handle.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(
        Number(
          screen
            .getByRole('separator', { name: 'Resize Time column' })
            .getAttribute('aria-valuenow'),
        ),
      ).toBeGreaterThanOrEqual(72),
    );
  });

  it('sorts siblings by duration and keeps the choice in the URL', async () => {
    await openWaterfall();
    await userEvent.selectOptions(screen.getByLabelText('Order'), 'duration');
    expect(decodeURIComponent(location.hash)).toContain('wsort:duration');
    expect(rowsOf()[0]?.getAttribute('aria-label')).toMatch(/^request · GET \/orders,/);
  });

  it('hides calls under the minimum duration', async () => {
    await openWaterfall();
    const before = rowsOf().length;
    await userEvent.selectOptions(screen.getByLabelText('Min duration'), String(20_000));
    await waitFor(() => expect(rowsOf().length).toBeLessThan(before));
    expect(decodeURIComponent(location.hash)).toContain('mind:20000');
  });
});

const MONEY = 'zoo/orders-server/src/util/money.ts';
const moneyText = Array.from({ length: 30 }, (_, i) =>
  i === 5 ? 'export function lineTotal(qty: number) {' : `  // line ${i + 1}`,
).join('\n');
const nativeFn = (): number =>
  Array.from({ length: orders.functions.length }, (_, i) => i).find(
    (i) =>
      orders.strings[orders.functions.name[i] ?? 0] === 'readFileUtf8' &&
      !orders.strings[orders.functions.file[i] ?? 0],
  ) ?? -1;

describe('source dock', () => {
  const dock = () => screen.getByRole('complementary', { name: 'Source dock' });
  /** Wait until the top finding's function is loaded in the dock: its tools then stay mounted. */
  const loaded = async (): Promise<HTMLElement> => {
    const region = await screen.findByRole('region', { name: 'Source' });
    await within(region).findByRole('heading', { name: 'lineTotal' });
    return region;
  };

  it('says why when the file is not on disk, and names it', async () => {
    open();
    await ready();
    const source = await screen.findByRole('region', { name: 'Source' });
    const note = await within(source).findByText('File not found on disk');
    expect(note.closest('[role="note"]')?.textContent).toContain(MONEY);
  });

  it('explains a native function without a file', async () => {
    history.replaceState(null, '', `#v=functions&tr=${orders.tracks[0]?.id}&sel=fn:${nativeFn()}`);
    open();
    await ready();
    const source = await screen.findByRole('region', { name: 'Source' });
    expect(await within(source).findByText('No source file')).toBeTruthy();
    expect(within(source).getByText(/native or runtime code/)).toBeTruthy();
  });

  it('shows the code with a breadcrumb path and Open in editor when the host has the file', async () => {
    const host = open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    const source = await screen.findByRole('region', { name: 'Source' });
    expect(
      await within(source).findByRole('list', { name: 'Source lines with self time' }),
    ).toBeTruthy();
    expect(within(source).getByRole('navigation', { name: 'File path' }).textContent).toContain(
      'money.ts',
    );
    await userEvent.click(within(source).getByRole('button', { name: 'Open in editor' }));
    expect(host.opened[0]?.[0]).toBe(MONEY);
  });

  it('docks to the right with a resize handle that keeps its size', async () => {
    const host = open();
    await ready();
    const handle = await screen.findByRole('separator', { name: 'Resize source dock' });
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('46');
    handle.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() =>
      expect(
        screen.getByRole('separator', { name: 'Resize source dock' }).getAttribute('aria-valuenow'),
      ).toBe('48'),
    );
    await waitFor(async () =>
      expect(
        ((await host.loadSettings())['uiPrefs'] as { dock: { widthFraction: number } }).dock
          .widthFraction,
      ).toBeCloseTo(0.48),
    );
  });

  it('moves below the views and back', async () => {
    open();
    await ready();
    await loaded();
    expect(dock().className).toContain('is-right');
    await userEvent.click(await screen.findByRole('button', { name: 'Dock below' }));
    expect(dock().className).toContain('is-bottom');
    expect(
      screen
        .getByRole('separator', { name: 'Resize source dock' })
        .getAttribute('aria-orientation'),
    ).toBe('horizontal');
    await userEvent.click(screen.getByRole('button', { name: 'Dock to the right' }));
    expect(dock().className).toContain('is-right');
  });

  it('wraps long lines on request', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await loaded();
    const toggle = await screen.findByRole('button', { name: 'Wrap long lines' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Wrap long lines' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('collapses by hand and expands again from the rail', async () => {
    open();
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse source panel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand source panel' }));
    expect(await screen.findByRole('button', { name: 'Collapse source panel' })).toBeTruthy();
  });

  it('collapses when nothing is selected and opens when a function is selected', async () => {
    open();
    await ready();
    await loaded();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Expand source panel' })).toBeTruthy();
    expect(screen.queryByRole('separator', { name: 'Resize source dock' })).toBeNull();
    await userEvent.keyboard('4');
    await userEvent.click(await screen.findByRole('row', { name: /formatCurrency/ }));
    expect(await screen.findByRole('button', { name: 'Collapse source panel' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize source dock' })).toBeTruthy();
  });

  it('keeps a manual collapse when another function is selected', async () => {
    open();
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse source panel' }));
    await userEvent.keyboard('4');
    await userEvent.click(await screen.findByRole('row', { name: /formatCurrency/ }));
    expect(screen.getByRole('button', { name: 'Expand source panel' })).toBeTruthy();
  });

  it('does not save whether the dock was open, only its size and side', async () => {
    const host = open();
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse source panel' }));
    await userEvent.click(
      await screen
        .findByRole('button', { name: 'Dock below' })
        .catch(() => screen.getByRole('button', { name: 'Expand source panel' })),
    );
    const saved = (await host.loadSettings())['uiPrefs'] as
      { dock?: Record<string, unknown> } | undefined;
    expect(Object.keys(saved?.dock ?? {})).not.toContain('mode');
  });

  it('extends again on the next selection after a manual collapse and a clear', async () => {
    open();
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse source panel' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('4');
    await userEvent.click(await screen.findByRole('row', { name: /formatCurrency/ }));
    expect(await screen.findByRole('button', { name: 'Collapse source panel' })).toBeTruthy();
  });

  it('has no Source tab and ignores the 5 key', async () => {
    open();
    await ready();
    expect(screen.queryByRole('button', { name: /^Source/ })).toBeNull();
    await userEvent.keyboard('5');
    expect(current(/Functions/)).toBe('page');
  });

  it('maximizes the dock into the whole file with an outline, and Escape closes it', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Maximize the source dock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Source, maximized' });
    const outline = await within(dialog).findByRole('navigation', {
      name: 'Functions in this file',
    });
    await waitFor(() =>
      expect(within(outline).getByRole('button', { name: /formatCurrency/ })).toBeTruthy(),
    );
    const lines = await within(dialog).findByRole('list', { name: 'Source lines with self time' });
    expect(within(lines).getAllByRole('listitem').length).toBe(30);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Source, maximized' })).toBeNull();
    expect(decodeURIComponent(location.hash)).toContain('sel=fn');
  });

  it('jumps to another function of the file from the maximized outline', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Maximize the source dock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Source, maximized' });
    const outline = await within(dialog).findByRole('navigation', {
      name: 'Functions in this file',
    });
    await userEvent.click(await within(outline).findByRole('button', { name: /formatCurrency/ }));
    await waitFor(() =>
      expect(
        within(within(dialog).getByRole('region', { name: 'Source' })).getByRole('heading', {
          name: 'formatCurrency',
        }),
      ).toBeTruthy(),
    );
  });
});

describe('selection line in the source', () => {
  const lines = async () =>
    within(await screen.findByRole('list', { name: 'Source lines with self time' }));
  const flagged = (list: ReturnType<typeof within>) =>
    list
      .getAllByRole('listitem')
      .filter((li: HTMLElement) => li.getAttribute('aria-current') === 'location');

  it('highlights the definition line, whose text names the function', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await waitFor(async () => expect(flagged(await lines())).toHaveLength(1));
    expect(flagged(await lines())[0]?.textContent).toContain('lineTotal');
  });

  it('shows the hottest line only as a gutter bar, never as the highlight', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await waitFor(async () => expect(flagged(await lines())).toHaveLength(1));
    const list = await lines();
    const hottest = list
      .getAllByRole('listitem')
      .find(
        (li: HTMLElement) =>
          /self/.test(li.getAttribute('aria-label') ?? '') &&
          li.getAttribute('aria-current') !== 'location',
      );
    expect(hottest).toBeTruthy();
    expect(hottest?.className).not.toContain('is-definition');
  });

  it('jumps to the hottest line on request without moving the highlight', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await lines();
    await waitFor(async () => expect(flagged(await lines())).toHaveLength(1));
    await userEvent.click(await screen.findByRole('button', { name: /Jump to hottest line/ }));
    expect(decodeURIComponent(location.hash)).toMatch(/line:\d+/);
    expect(flagged(await lines())[0]?.textContent).toContain('lineTotal');
  });
});

const BUNDLE = Array.from({ length: 8000 }, () => 'x').join('\n');

describe('functions without line time', () => {
  const q = createQueries(orders);
  const scope = {
    track: orders.tracks[0]?.id ?? '',
    transforms: [...DEFAULT_TRANSFORMS],
    range: null,
    hide: [] as number[],
  };
  const wrapper = q
    .functions(scope, '')
    .rows.find(
      (r) =>
        q.source(scope, r.fn)?.lineSelf.length === 0 &&
        (q.details(scope, r.fn)?.callees.length ?? 0) > 1,
    );

  it('says the function itself ran only briefly and lists where its time went', async () => {
    expect(wrapper).toBeTruthy();
    history.replaceState(null, '', `#v=functions&tr=${orders.tracks[0]?.id}&sel=fn:${wrapper?.fn}`);
    open(orders, undefined, { 'zoo/orders-server/dist/server.js': { text: BUNDLE } });
    await ready();
    const region = await screen.findByRole('region', { name: 'Source' });
    expect(await within(region).findByText('Its time is in its callees')).toBeTruthy();
    expect(
      within(region).getByText(q.source(scope, wrapper?.fn ?? -1)?.lineReason ?? 'missing', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(within(region).getByRole('list', { name: 'Time in callees' })).toBeTruthy();
    expect(within(region).queryByText(/No line-level time recorded/)).toBeNull();
  });

  it('follows a callee when it is clicked', async () => {
    history.replaceState(null, '', `#v=functions&tr=${orders.tracks[0]?.id}&sel=fn:${wrapper?.fn}`);
    open(orders, undefined, { 'zoo/orders-server/dist/server.js': { text: BUNDLE } });
    await ready();
    const list = await screen.findByRole('list', { name: 'Time in callees' });
    await userEvent.click(within(list).getAllByRole('button')[0] as HTMLElement);
    expect(decodeURIComponent(location.hash)).not.toContain(`sel=fn:${wrapper?.fn}`);
  });
});

describe('call graph navigation', () => {
  const openGraph = async () => {
    history.replaceState(null, '', `#v=callgraph&tr=${orders.tracks[0]?.id}`);
    open();
    await ready();
    await screen.findByRole('group', { name: /^Call graph with/ });
  };
  const level = () => screen.getByLabelText('Zoom level').textContent;

  it('shows the zoom level and steps it with the buttons', async () => {
    await openGraph();
    const start = level();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(level()).not.toBe(start);
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(level()).toBe('100%');
  });

  it('zooms with the plus and minus keys and resets with 0 when the graph has focus', async () => {
    await openGraph();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    const graph = screen.getByRole('group', { name: /^Call graph with/ });
    graph.focus();
    await userEvent.keyboard('+');
    expect(level()).toBe('125%');
    await userEvent.keyboard('-');
    await userEvent.keyboard('-');
    expect(level()).toBe('80%');
    await userEvent.keyboard('0');
    expect(level()).toBe('100%');
  });

  it('says how to navigate', async () => {
    await openGraph();
    expect(screen.getByText(/scroll to zoom, drag to pan/)).toBeTruthy();
  });

  it('offers Fit', async () => {
    await openGraph();
    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(level()).toMatch(/^\d+%$/);
  });
});

describe('task picker', () => {
  const openWaterfall = async () => {
    history.replaceState(null, '', `#v=waterfall&tr=${orders.tracks[0]?.id}`);
    open();
    await ready();
    return screen.findByLabelText('Task') as Promise<HTMLSelectElement>;
  };

  it('opens on the whole run', async () => {
    const picker = await openWaterfall();
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toMatch(/^Whole run · /));
    expect(picker.querySelector('optgroup')?.getAttribute('label')).toBe('Whole run');
  });

  it('keeps the small tasks folded away behind a count, until asked for', async () => {
    const picker = await openWaterfall();
    await waitFor(() => expect(picker.options.length).toBeGreaterThan(2));
    const label = (): string[] =>
      Array.from(picker.querySelectorAll('optgroup')).map((g) => g.getAttribute('label') ?? '');
    expect(label().some((l) => l.startsWith('Small tasks'))).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: /Show \d+ small tasks/ }));
    expect(label().some((l) => /^Small tasks \(\d+\)$/.test(l))).toBe(true);
  });

  it('labels the entry point and groups requests', async () => {
    const picker = await openWaterfall();
    await waitFor(() => expect(picker.options.length).toBeGreaterThan(2));
    const labels = Array.from(picker.querySelectorAll('optgroup')).map((g) =>
      g.getAttribute('label'),
    );
    expect(labels.slice(0, 3)).toEqual(['Whole run', 'Entry', 'Requests']);
    expect(picker.textContent).toContain('program entry point');
  });

  it('picking a task opens that task, and picking the whole run returns to it', async () => {
    const picker = await openWaterfall();
    await waitFor(() => expect(picker.options.length).toBeGreaterThan(2));
    const request = Array.from(picker.options).find((o) =>
      /GET \/orders/.test(o.textContent ?? ''),
    );
    await userEvent.selectOptions(picker, request?.value ?? '');
    expect(decodeURIComponent(location.hash)).toMatch(/task:\d+/);
    await userEvent.selectOptions(picker, '-1');
    expect(decodeURIComponent(location.hash)).not.toMatch(/task:\d+/);
  });
});

describe('whole-run waterfall noise', () => {
  const eslint = fixtureModel('eslint-cli');
  const openRun = async () => {
    history.replaceState(null, '', `#v=waterfall&tr=${eslint.tracks[eslint.primaryTrack]?.id}`);
    open(eslint);
    await ready();
    return screen.findByRole('table', { name: 'Waterfall rows' });
  };
  const rowsOf = (table: HTMLElement) => within(table).getAllByRole('row');

  it('hides tiny rows by default and says what it is hiding', async () => {
    await openRun();
    expect(await screen.findByText(/Hiding rows under/)).toBeTruthy();
    const min = screen.getByLabelText('Min duration') as HTMLSelectElement;
    expect(min.selectedOptions[0]?.textContent).toMatch(/^Auto · hide under/);
  });

  it('folds node bootstrap into one collapsed row', async () => {
    const table = await openRun();
    await waitFor(() => expect(rowsOf(table).length).toBeGreaterThan(3));
    const boot = rowsOf(table).find((r) =>
      /^node bootstrap,/.test(r.getAttribute('aria-label') ?? ''),
    );
    expect(boot?.getAttribute('aria-expanded')).toBe('false');
    expect(
      rowsOf(table).some((r) =>
        /^prepareMainThreadExecution,/.test(r.getAttribute('aria-label') ?? ''),
      ),
    ).toBe(false);
  });

  it('opens a fold when its row is clicked', async () => {
    const table = await openRun();
    await waitFor(() => expect(rowsOf(table).length).toBeGreaterThan(3));
    const fold = rowsOf(table).find((r) =>
      /rows? under .* hidden,/.test(r.getAttribute('aria-label') ?? ''),
    );
    expect(fold?.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(fold as HTMLElement);
    await waitFor(() => {
      const again = rowsOf(table).find(
        (r) => r.getAttribute('aria-label') === fold?.getAttribute('aria-label'),
      );
      expect(again?.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('walks the arrow keys down onto a fold and past it, with nothing focused', async () => {
    const table = await openRun();
    await waitFor(() => expect(rowsOf(table).length).toBeGreaterThan(3));
    const isFold = (r: HTMLElement): boolean =>
      /^node bootstrap,|rows? under .* hidden,/.test(r.getAttribute('aria-label') ?? '');
    const at = rowsOf(table).findIndex(isFold);
    expect(at).toBeGreaterThan(0);
    await userEvent.click(rowsOf(table)[at - 1] as HTMLElement);
    (document.activeElement as HTMLElement).blur();

    await userEvent.keyboard('{ArrowDown}');
    const onFold = rowsOf(table)[at] as HTMLElement;
    expect(onFold.getAttribute('aria-selected')).toBe('true');
    expect(onFold.getAttribute('aria-expanded')).toBe('false');

    await userEvent.keyboard('{ArrowDown}');
    expect((rowsOf(table)[at] as HTMLElement).getAttribute('aria-selected')).toBe('false');
    expect((rowsOf(table)[at + 1] as HTMLElement).getAttribute('aria-selected')).toBe('true');

    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect((rowsOf(table)[at] as HTMLElement).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows every row when Any is chosen, and the chip goes away', async () => {
    await openRun();
    await userEvent.selectOptions(screen.getByLabelText('Min duration'), '0');
    expect(screen.queryByText(/Hiding rows under/)).toBeNull();
    expect(decodeURIComponent(location.hash)).toContain('mind:0');
  });

  it('shows everything from the chip', async () => {
    await openRun();
    await userEvent.click(await screen.findByRole('button', { name: 'show' }));
    expect(screen.queryByText(/Hiding rows under/)).toBeNull();
  });
});

describe('click-off deselects', () => {
  it('clears the selection when empty space in the waterfall is clicked', async () => {
    history.replaceState(null, '', `#v=waterfall&tr=${orders.tracks[0]?.id}&sel=fn:283`);
    open();
    await ready();
    const table = await screen.findByRole('table', { name: 'Waterfall rows' });
    await waitFor(() => expect(decodeURIComponent(location.hash)).toContain('sel=fn:283'));
    await userEvent.click(table);
    await waitFor(() => expect(decodeURIComponent(location.hash)).not.toContain('sel='));
  });

  it('does not clear when a waterfall row is clicked', async () => {
    history.replaceState(null, '', `#v=waterfall&tr=${orders.tracks[0]?.id}&sel=fn:283`);
    open();
    await ready();
    const table = await screen.findByRole('table', { name: 'Waterfall rows' });
    const row = (await within(table).findAllByRole('row'))[0] as HTMLElement;
    await userEvent.click(row);
    expect(decodeURIComponent(location.hash)).toContain('sel=node');
  });

  it('clears the selection when empty space in the flame graph is clicked', async () => {
    history.replaceState(null, '', `#v=flame&tr=${orders.tracks[0]?.id}&sel=fn:283`);
    open();
    await ready();
    const plot = await screen.findByRole('img', { name: /Icicle graph/ });
    await userEvent.click(plot);
    await waitFor(() => expect(decodeURIComponent(location.hash)).not.toContain('sel='));
  });
});

describe('Show filter', () => {
  const chip = (name: RegExp) => screen.getByRole('button', { name });

  it('shows every origin by default, each chip pressed', async () => {
    open();
    await ready();
    const bar = await screen.findByRole('group', { name: 'Show' });
    expect(
      within(bar)
        .getAllByRole('button')
        .every((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toBe(true);
    expect(within(bar).getAllByRole('button')).toHaveLength(6);
  });

  it('hides an origin, records it in the URL and says what is hidden and for how long', async () => {
    open();
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: /Native/ }));
    expect(chip(/Native/).getAttribute('aria-pressed')).toBe('false');
    expect(decodeURIComponent(location.hash)).toContain('hide:4');
    expect(await screen.findByText(/hiding Native: ~?[\d.]+ (ms|s)/)).toBeTruthy();
  });

  it('shows everything again from the summary', async () => {
    open();
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: /Native/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show all' }));
    expect(chip(/Native/).getAttribute('aria-pressed')).toBe('true');
    expect(decodeURIComponent(location.hash)).not.toContain('hide:');
  });

  it('restores a hidden origin from the URL', async () => {
    history.replaceState(null, '', '#v=flame&o=hide%3A4.5.6');
    open();
    await ready();
    expect(
      (await screen.findByRole('button', { name: /GC & idle/ })).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(chip(/Native/).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('functions filters and hot paths', () => {
  const openFunctions = async () => {
    history.replaceState(null, '', `#v=functions&tr=${orders.tracks[0]?.id}`);
    open();
    await ready();
    await screen.findByRole('table', { name: /^Functions/ });
  };

  it('filters to the target only', async () => {
    await openFunctions();
    await screen.findByRole('row', { name: /readFileUtf8/ });
    await userEvent.click(screen.getByRole('switch', { name: /Target only/ }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /readFileUtf8/ })).toBeNull());
    expect(decodeURIComponent(location.hash)).toContain('tonly:1');
    expect(screen.getByRole('row', { name: /lineTotal/ })).toBeTruthy();
  });

  it('filters to one package', async () => {
    await openFunctions();
    await screen.findByRole('row', { name: /lineTotal/ });
    await userEvent.selectOptions(screen.getByLabelText('Package'), 'ajv');
    await waitFor(() => expect(screen.queryByRole('row', { name: /lineTotal/ })).toBeNull());
    expect(decodeURIComponent(location.hash)).toContain('fpkg:ajv');
  });

  it('lists hot paths and opens one zoomed in the flame graph', async () => {
    await openFunctions();
    const panel = await screen.findByRole('region', { name: 'Hot paths' });
    const first = await within(panel).findAllByRole('button');
    await userEvent.click(first[0] as HTMLElement);
    expect(current(/Flame graph/)).toBe('page');
    expect(decodeURIComponent(location.hash)).toMatch(/zp:\d+(\.\d+)+/);
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

describe('finding fixes', () => {
  it('shows what to change on a finding that knows, and nothing extra on one that does not', async () => {
    open(fixtureModel('deopt-loop'));
    await ready();
    expect(
      screen.getByText(/Fix: Objects of different shapes reach the same property access/),
    ).toBeTruthy();
    expect(screen.queryAllByText(/^Fix:/)).toHaveLength(1);
  });

  it('shows no fix line for a run without a V8 finding', async () => {
    open();
    await ready();
    expect(screen.queryByText(/^Fix:/)).toBeNull();
  });
});

describe('deopt marks in the source panel', () => {
  const loop = fixtureModel('deopt-loop');
  const loopFile = 'zoo/apps/deopt-loop.cjs';
  const loopText = readFileSync(resolve(process.cwd(), '../../', loopFile), 'utf8');
  const fnNamed = (name: string): number =>
    Array.from({ length: loop.functions.length }, (_, f) => f).find(
      (f) => loop.strings[loop.functions.name[f] ?? 0] === name,
    ) ?? -1;

  it('marks the line where V8 threw away optimized code, with the reason and count', async () => {
    history.replaceState(
      null,
      '',
      `#v=functions&tr=${loop.tracks[0]?.id}&sel=fn:${fnNamed('price')}`,
    );
    open(loop, undefined, { [loopFile]: { text: loopText } });
    await ready();
    const source = await screen.findByRole('region', { name: 'Source' });
    const lines = await within(source).findByRole('list', { name: 'Source lines with self time' });
    const mark = await within(lines).findByRole('img', {
      name: 'V8 threw away optimized code here 10 times: wrong map ×10',
    });
    expect(mark.closest('li')?.querySelector('.source-n')?.textContent).toBe('6');
  });

  const ordersFn = (name: string): number =>
    Array.from({ length: orders.functions.length }, (_, f) => f).find(
      (f) => orders.strings[orders.functions.name[f] ?? 0] === name,
    ) ?? -1;

  it('marks no line of a function V8 never deoptimized', async () => {
    history.replaceState(
      null,
      '',
      `#v=functions&tr=${orders.tracks[0]?.id}&sel=fn:${ordersFn('lineTotal')}`,
    );
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    const source = await screen.findByRole('region', { name: 'Source' });
    await within(source).findByRole('list', { name: 'Source lines with self time' });
    expect(within(source).queryByRole('img', { name: /V8 threw away/ })).toBeNull();
  });
});

describe('deopt legend', () => {
  const loop = fixtureModel('deopt-loop');
  const LEGEND = /V8 threw away this function's optimized code/;

  it.each(['waterfall', 'flame'])('explains the mark on the %s of a --v8 run', async (view) => {
    history.replaceState(null, '', `#v=${view}&tr=${loop.tracks[0]?.id}`);
    open(loop);
    await ready();
    expect(await screen.findByText(LEGEND)).toBeTruthy();
  });

  it.each(['waterfall', 'flame'])('does not mention it on the %s of other runs', async (view) => {
    history.replaceState(null, '', `#v=${view}&tr=${orders.tracks[0]?.id}`);
    open();
    await ready();
    await screen.findByRole('list', { name: 'Origin colors' });
    expect(screen.queryByText(LEGEND)).toBeNull();
  });
});
