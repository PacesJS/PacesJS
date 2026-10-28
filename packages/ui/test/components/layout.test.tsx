import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, hasSelection, openApp } from '../helpers/open-app';
import { fixtureModel, preload } from '../helpers/real-model';

// What only real layout can answer: geometry, scrollbars, hit testing and drags. These ran as the
// one live UI test; in browser mode they get the same Chromium without a server or a built bundle.

await preload('orders-server', 'eslint-cli-wrapped');

const views = () => screen.getByRole('navigation', { name: 'Views' });
const rowsOf = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole('table', { name: 'Waterfall rows' })).getAllByRole('row');
const rowNamed = async (name: string): Promise<HTMLElement> =>
  (await rowsOf()).find((r) => r.textContent?.includes(name)) as HTMLElement;
const rect = (node: Element): DOMRect => node.getBoundingClientRect();
const el = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
};

/** A real press-move-release at viewport coordinates, as a mouse makes it. */
async function drag(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = target.getBoundingClientRect();
  const at = (p: { x: number; y: number }) => ({ clientX: box.left + p.x, clientY: box.top + p.y });
  await userEvent.pointer([
    { keys: '[MouseLeft>]', target, coords: at(from) },
    { target, coords: at({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }) },
    { target, coords: at(to) },
    { keys: '[/MouseLeft]', target, coords: at(to) },
  ]);
}

async function showView(name: RegExp): Promise<void> {
  await userEvent.click(within(views()).getByRole('button', { name }));
}

const dockPrefs = (widthFraction: number) => ({
  uiPrefs: { dock: { orientation: 'right', widthFraction, heightPx: 420, wrap: false } },
});

describe('the lanes', () => {
  it('dragging across a lane sets the time range for every view, and it can be removed', async () => {
    openApp();
    await appReady();
    const plot = await waitFor(() => el('.lane-plot'));
    const box = rect(plot);
    await drag(plot, { x: box.width * 0.1, y: 20 }, { x: box.width * 0.4, y: 20 });
    expect(await screen.findByRole('group', { name: /Selected range/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove time range' }));
    await waitFor(() => expect(document.querySelectorAll('.chip-range')).toHaveLength(0));
  });
});

describe('the flame graph', () => {
  it('lists its frames and zooms when one is clicked', async () => {
    openApp();
    await appReady();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('2');
    const list = await screen.findByRole('list', { name: 'Frames, widest first' });
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(3));
    await userEvent.click(within(list).getAllByRole('listitem')[0] as Element);
    const crumbs = screen.getByRole('navigation', { name: 'Zoom path' });
    await waitFor(() => expect(within(crumbs).getAllByRole('button')).toHaveLength(2));
  });

  it('a click on a frame selects it and never clears the selection', async () => {
    openApp();
    await appReady();
    await userEvent.keyboard('2');
    const list = await screen.findByRole('list', { name: 'Frames, widest first' });
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(2));
    await userEvent.click(within(list).getAllByRole('listitem')[2] as Element);
    await waitFor(() => expect(hasSelection()).toBe(true));
  });
});

describe('the call graph', () => {
  const open = async (): Promise<void> => {
    openApp();
    await appReady();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('3');
    await waitFor(() => expect(document.querySelectorAll('.cg-node').length).toBeGreaterThan(1));
  };
  const level = () => screen.getByLabelText('Zoom level');
  const positions = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.cg-node')).map(
      (node) => `${node.style.left},${node.style.top}`,
    );

  it('opens fitted: every node is inside the graph area', async () => {
    await open();
    const area = rect(el('.cg-scroll'));
    for (const node of document.querySelectorAll('.cg-node')) {
      const box = rect(node);
      expect(box.left).toBeGreaterThanOrEqual(area.left - 2);
      expect(box.right).toBeLessThanOrEqual(area.right + 2);
    }
  });

  it('zooms toward the cursor, pans by dragging and returns with Fit', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    const fitted = level().textContent;
    const area = el('.cg-scroll');
    const box = rect(area);
    area.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -400,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        cancelable: true,
        bubbles: true,
      }),
    );
    await waitFor(() => expect(level().textContent).not.toBe(fitted), { timeout: 5000 });

    const layer = el('.cg-plot > div');
    const before = layer.style.transform;
    await drag(area, { x: 40, y: box.height - 40 }, { x: 140, y: box.height - 80 });
    await waitFor(() => expect(layer.style.transform).not.toBe(before), { timeout: 5000 });

    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    await waitFor(() => expect(level().textContent).toBe(fitted), { timeout: 5000 });
  });

  it('shows each function once and keeps node positions when a node is selected', async () => {
    await open();
    const before = positions();
    await userEvent.click(document.querySelectorAll('.cg-node')[1] as Element);
    expect(positions()).toEqual(before);
    const names = Array.from(document.querySelectorAll('.cg-node-name')).map((n) => n.textContent);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the source dock', () => {
  it('resizes by dragging its handle, and the size is saved for the next session', async () => {
    const host = openApp();
    await appReady();
    const dock = await screen.findByRole('complementary', { name: 'Source dock' });
    await waitFor(() => expect(rect(dock).width).toBeGreaterThan(300));
    const before = rect(dock).width;
    const handle = screen.getByRole('separator', { name: 'Resize source dock' });
    await drag(handle, { x: 2, y: 40 }, { x: -198, y: 40 });
    await waitFor(() => expect(rect(dock).width).toBeGreaterThan(before + 100));
    const after = rect(dock).width;
    await waitFor(async () => {
      const saved = (await host.loadSettings())['uiPrefs'] as { dock?: unknown } | undefined;
      expect(saved?.dock).toBeDefined();
    });

    cleanup();
    openApp(undefined, { settings: await host.loadSettings() });
    await appReady();
    const again = await screen.findByRole('complementary', { name: 'Source dock' });
    await waitFor(() => expect(Math.abs(rect(again).width - after)).toBeLessThan(4));
  });

  it('puts every gutter bar and its value on the middle of its line, with the labels inside the gutter', async () => {
    openApp();
    await appReady();
    await showView(/^Functions/);
    await userEvent.click(
      (await screen.findAllByRole('row', { name: /^lineTotal/ }))[0] as Element,
    );
    const withBar = await waitFor(() => {
      const lines = Array.from(document.querySelectorAll('.source-line')).filter((line) =>
        line.querySelector('.source-bar'),
      );
      expect(lines.length).toBeGreaterThan(1);
      return lines;
    });
    expect(document.querySelectorAll('.source-val')).toHaveLength(withBar.length);
    const middle = (box: DOMRect): number => box.top + box.height / 2;
    for (const line of withBar) {
      const row = rect(line);
      const gutter = rect(line.querySelector('.source-gutter') as Element);
      const bar = rect(line.querySelector('.source-bar') as Element);
      const value = rect(line.querySelector('.source-val') as Element);
      const code = rect(line.querySelector('.source-code') as Element);
      expect(Math.abs(middle(bar) - middle(row))).toBeLessThanOrEqual(1.5);
      expect(Math.abs(middle(value) - middle(row))).toBeLessThanOrEqual(1.5);
      expect(value.left - gutter.left).toBeGreaterThanOrEqual(-1);
      expect(code.left - value.right).toBeGreaterThan(0);
    }
  });
});

describe('the waterfall', () => {
  /** Horizontally scrollable elements of the waterfall: its own parts and the wrappers around it. */
  function scrollers(): string[] {
    const scroll = document.querySelector('.wf-scroll');
    if (!scroll) return ['no waterfall'];
    const found = new Set<HTMLElement>(Array.from(scroll.querySelectorAll<HTMLElement>('*')));
    found.add(scroll as HTMLElement);
    for (let node = scroll.parentElement; node && !node.matches('main, body');) {
      found.add(node);
      node = node.parentElement;
    }
    return Array.from(found)
      .filter((node) => {
        const overflow = getComputedStyle(node).overflowX;
        return (
          (overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth
        );
      })
      .map(
        (node) =>
          `${node.tagName}.${node.className || '-'} ${node.scrollWidth}>${node.clientWidth}`,
      );
  }

  async function openWaterfall(fixture?: string, settings = {}): Promise<void> {
    openApp(fixture ? fixtureModel(fixture) : undefined, { settings });
    await appReady();
    await showView(/^Waterfall/);
    await waitFor(() => expect(document.querySelector('.wf-scroll')).not.toBeNull());
  }

  it.each([
    ['default', {}],
    ['minimum', dockPrefs(0.25)],
    ['maximum', dockPrefs(0.75)],
  ])('has at most one horizontal scrollbar with the dock at its %s width', async (_name, prefs) => {
    await openWaterfall(undefined, prefs);
    await userEvent.click(await rowNamed('getOrders'));
    await waitFor(() => expect(scrollers().length).toBeLessThanOrEqual(1));
  });

  it('moves the header and the rows together with its one scrollbar', async () => {
    await openWaterfall(undefined, dockPrefs(0.75));
    await userEvent.click(await rowNamed('getOrders'));
    const scroller = el('.wf-scroll');
    const head = el('.wf-head .caps');
    const name = (await rowsOf())[0]?.querySelector('.wf-name') as Element;
    await waitFor(() => expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth + 80));
    scroller.scrollTo({ left: 0 });
    const h0 = rect(head).x;
    const r0 = rect(name).x;
    scroller.scrollTo({ left: 80 });
    await waitFor(() => expect(scroller.scrollLeft).toBe(80));
    expect(Math.round(h0 - rect(head).x)).toBe(80);
    expect(Math.round(h0 - rect(head).x)).toBe(Math.round(r0 - rect(name).x));
  });

  it.each([0.25, 0.46, 0.75])(
    'keeps a very deep chain readable with one scrollbar at dock width %s',
    async (fraction) => {
      openApp(fixtureModel('eslint-cli-wrapped'), { settings: dockPrefs(fraction) });
      await appReady();
      const card = document.querySelectorAll('.finding-card')[2] as HTMLElement;
      if (card.getAttribute('aria-current') !== 'true') {
        await userEvent.click(within(card).getByRole('button', { name: /^Show me:/ }));
      }
      await showView(/^Waterfall/);
      await waitFor(async () =>
        expect(
          Math.max(...(await rowsOf()).map((r) => Number(r.getAttribute('aria-level')))),
        ).toBeGreaterThan(12),
      );
      const cells = (await rowsOf()).map((row) => {
        const cell = row.querySelector<HTMLElement>('.wf-name') as HTMLElement;
        const label = row.querySelector<HTMLElement>('.wf-label') as HTMLElement;
        return {
          overflow: cell.scrollWidth - cell.clientWidth,
          label: label.textContent ?? '',
          full: row.getAttribute('aria-label')?.split(', ')[0] ?? '',
        };
      });
      expect(cells.filter((c) => c.overflow > 0)).toEqual([]);
      expect(cells.filter((c) => c.label.length < 8 && c.label !== c.full)).toEqual([]);
      expect(scrollers().length).toBeLessThanOrEqual(1);
    },
  );

  it('keeps the time and the share where they were when a row is hovered', async () => {
    await openWaterfall();
    const row = await rowNamed('buildInvoiceRows');
    row.scrollIntoView();
    const before = {
      time: rect(row.querySelector('.wf-time') as Element),
      share: rect(row.querySelector('.wf-share') as Element),
    };
    await userEvent.hover(row.querySelector('.wf-name') as Element);
    await waitFor(() => expect(row.className).toMatch(/is-hover/));
    expect(rect(row.querySelector('.wf-time') as Element)).toEqual(before.time);
    expect(rect(row.querySelector('.wf-share') as Element)).toEqual(before.share);
  });

  it('puts the bar, not the highlight, under the pointer over the bar', async () => {
    await openWaterfall();
    const row = await rowNamed('buildInvoiceRows');
    row.scrollIntoView();
    const box = rect(row.querySelector('.wf-bar-hit') as Element);
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    expect(top?.closest('.wf-bar-hit')).not.toBeNull();
  });

  it('keeps the duration tooltip inside the window', async () => {
    await openWaterfall();
    const row = await rowNamed('buildInvoiceRows');
    row.scrollIntoView({ block: 'center' });
    await userEvent.hover(row.querySelector('.wf-bar-hit') as Element);
    const tip = await waitFor(() => el('.tooltip'));
    const box = rect(tip);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
  });
});
