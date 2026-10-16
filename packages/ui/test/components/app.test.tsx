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
    expect(within(drawer).queryByRole('button', { name: /Clear selection/ })).toBeNull();
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
    const first = within(rowsOf()[1] as HTMLElement).getAllByRole('cell')[0];
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

  it('collapses and expands', async () => {
    open();
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse source panel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand source panel' }));
    expect(await screen.findByRole('button', { name: 'Collapse source panel' })).toBeTruthy();
  });

  it('opens the full Source view with the whole file and an outline', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Open the full Source view' }));
    expect(current(/^Source/)).toBe('page');
    const outline = await screen.findByRole('navigation', { name: 'Functions in this file' });
    await waitFor(() =>
      expect(within(outline).getByRole('button', { name: /formatCurrency/ })).toBeTruthy(),
    );
    const lines = await screen.findByRole('list', { name: 'Source lines with self time' });
    expect(within(lines).getAllByRole('listitem').length).toBe(30);
    expect(screen.queryByRole('complementary', { name: 'Source dock' })).toBeNull();
  });

  it('opens the Source view with the 5 key', async () => {
    open();
    await ready();
    await userEvent.keyboard('5');
    expect(current(/^Source/)).toBe('page');
  });

  it('jumps to another function of the file from the outline', async () => {
    open(orders, undefined, { [MONEY]: { text: moneyText } });
    await ready();
    await userEvent.keyboard('5');
    const outline = await screen.findByRole('navigation', { name: 'Functions in this file' });
    await userEvent.click(await within(outline).findByRole('button', { name: /formatCurrency/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Source' })).getByRole('heading', {
          name: 'formatCurrency',
        }),
      ).toBeTruthy(),
    );
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
