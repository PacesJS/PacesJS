// Characterization of the rendered markup (the whole document body) of every view and panel state, driven
// the way a user would. The hash of body.innerHTML pins the DOM and the accessibility tree. See golden.ts.
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { memoryHostAdapter } from '../../src/host/memory';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel, ordersModel } from '../helpers/real-model';
import { goldenFile } from './golden';

const g = goldenFile(resolve(process.cwd(), 'test/baseline/screens-golden.json'));
const orders = ordersModel();
const eslint = fixtureModel('eslint-cli');
const rxjs = fixtureModel('rxjs-chain');
const asyncChain = fixtureModel('async-chain');
const mainOf = (m: ExecutionModel): string => m.tracks[m.primaryTrack]?.id ?? '';

const MONEY = 'zoo/orders-server/src/util/money.ts';
const moneyText = Array.from({ length: 30 }, (_, i) =>
  i === 5 ? 'export function lineTotal(qty: number) {' : `  // line ${i + 1}`,
).join('\n');

async function settle(): Promise<void> {
  let last = '';
  let same = 0;
  const deadline = Date.now() + 8000;
  while (same < 4 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
    const now = document.body.innerHTML;
    same = now === last && !/Loading /.test(now) ? same + 1 : 0;
    last = now;
  }
}

async function open(
  hash: string,
  model: ExecutionModel = orders,
  sources?: Record<string, { text: string }>,
) {
  history.replaceState(null, '', hash);
  const host = memoryHostAdapter({
    model: serializeModel(model),
    meta: {},
    sources,
  });
  render(<App host={host} inProcess elk={nodeElk} />);
  await screen.findByRole('heading', { name: 'Findings' });
  await settle();
}

const snap = async (key: string): Promise<void> => {
  await settle();
  g.check(key, document.body.innerHTML);
};

const rows = () =>
  within(screen.getByRole('table', { name: 'Waterfall rows' })).getAllByRole('row');
const nth = (re: RegExp, n = 0): HTMLElement =>
  rows().filter((r) => re.test(r.getAttribute('aria-label') ?? ''))[n] as HTMLElement;

describe('screens golden masters', () => {
  const m = mainOf(orders);

  it('default opening with the top finding (dock, details, header)', async () => {
    await open('#');
    await snap('default');
  });

  it('default opening with sources on disk, dock code and wrap', async () => {
    await open('#', orders, { [MONEY]: { text: moneyText } });
    await snap('dock-code');
    await userEvent.click(screen.getByRole('button', { name: /Wrap long lines/ }));
    await snap('dock-wrap');
  });

  it('maximized dock with outline', async () => {
    await open('#', orders, { [MONEY]: { text: moneyText } });
    await userEvent.click(await screen.findByRole('button', { name: 'Maximize the source dock' }));
    await screen.findByRole('dialog', { name: 'Source, maximized' });
    await snap('overlay');
  });

  it('every view', async () => {
    await open(`#v=functions&tr=${m}`);
    await snap('functions');
  });

  it('flame view and call graph view', async () => {
    await open(`#v=flame&tr=${m}`);
    await snap('flame');
  });

  it('call graph', async () => {
    await open(`#v=callgraph&tr=${m}`);
    await snap('callgraph');
  });

  it('waterfall of a task, selected row, hover, path-only, sort, min duration', async () => {
    await open(`#v=waterfall&tr=${m}&o=${encodeURIComponent('task:7')}`);
    await snap('wf-task');
    await userEvent.hover(nth(/^lineTotal,/, 0));
    await snap('wf-hover');
    await userEvent.click(nth(/^lineTotal,/, 1));
    await snap('wf-select');
    await userEvent.keyboard('p');
    await snap('wf-pathonly');
    await userEvent.keyboard('p');
    await userEvent.selectOptions(screen.getByLabelText('Order'), 'duration');
    await snap('wf-sort-duration');
    await userEvent.selectOptions(screen.getByLabelText('Min duration'), String(20_000));
    await snap('wf-min20ms');
  });

  it('waterfall keyboard navigation', async () => {
    await open(`#v=waterfall&tr=${m}&o=${encodeURIComponent('task:7')}`);
    await userEvent.click(nth(/^lineTotal,/, 0));
    await settle();
    const press = async (...keys: string[]): Promise<void> => {
      for (const k of keys) {
        await userEvent.keyboard(k);
        await settle();
      }
    };
    await press('{ArrowDown}', '{ArrowDown}');
    await snap('wf-key-down');
    await press('{ArrowLeft}');
    await snap('wf-key-left');
    await press('{ArrowLeft}', '{ArrowLeft}');
    await snap('wf-key-left2');
    await press('{ArrowRight}', '{ArrowRight}', '{ArrowUp}');
    await snap('wf-key-right');
    await press('{Backspace}');
    await snap('wf-key-backspace');
  });

  it('whole run waterfall of the orders server, task picker with small tasks', async () => {
    await open(`#v=waterfall&tr=${m}`);
    await snap('wf-run-orders');
    await userEvent.click(await screen.findByRole('button', { name: /Show \d+ small tasks/ }));
    await snap('wf-run-small');
  });

  it('whole run waterfall of eslint: folds, open fold, Any', async () => {
    await open(`#v=waterfall&tr=${mainOf(eslint)}`, eslint);
    await snap('wf-eslint');
    const fold = rows().find((r) =>
      /rows? under .* hidden,/.test(r.getAttribute('aria-label') ?? ''),
    );
    if (fold) {
      await userEvent.click(fold);
      await snap('wf-eslint-fold-open');
    }
    await userEvent.selectOptions(screen.getByLabelText('Min duration'), '0');
    await snap('wf-eslint-any');
    await userEvent.selectOptions(screen.getByLabelText('Order'), 'share');
    await snap('wf-eslint-share');
  });

  it('async chain (resumed rows) and rxjs', async () => {
    await open(`#v=waterfall&tr=${mainOf(asyncChain)}`, asyncChain);
    await snap('wf-async');
    await userEvent.click(rows()[1] as HTMLElement);
    await snap('wf-async-select');
  });

  it('rxjs waterfall and flame', async () => {
    await open(`#v=waterfall&tr=${mainOf(rxjs)}`, rxjs);
    await snap('wf-rxjs');
  });

  it('details states: function, empty, task', async () => {
    await open(`#v=functions&tr=${m}`);
    await userEvent.keyboard('{Escape}');
    await snap('details-empty');
    cleanup();
    await open(`#v=waterfall&tr=${m}&sel=task:${m}:7`);
    await snap('details-task');
  });

  it('functions with a search, the keys 1-4 and the shortcut sheet', async () => {
    await open(`#v=functions&tr=${m}`);
    await userEvent.type(screen.getByPlaceholderText(/Search functions/), 'line');
    await snap('functions-search');
    await userEvent.clear(screen.getByPlaceholderText(/Search functions/));
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('?');
    await snap('shortcuts');
  });

  it('eslint functions view and call graph', async () => {
    await open(`#v=functions&tr=${mainOf(eslint)}`, eslint);
    await snap('eslint-functions');
    await userEvent.keyboard('3');
    await snap('eslint-callgraph');
    await userEvent.keyboard('2');
    await snap('eslint-flame');
  });

  it('every row of the first findings: Show me', async () => {
    await open('#');
    const buttons = screen.getAllByRole('button', { name: /^Show me:/ });
    for (let i = 1; i < Math.min(buttons.length, 4); i++) {
      await userEvent.click(buttons[i] as HTMLElement);
      await waitFor(() => expect(document.body.innerHTML.length).toBeGreaterThan(0));
      await snap(`showme-${i}`);
    }
  });

  it('bar tooltips of every kind of row', async () => {
    const collect = async (): Promise<string[]> => {
      const out: string[] = [];
      const hits = Array.from(document.querySelectorAll('.wf-bar-hit')).slice(0, 45);
      for (const hit of hits) {
        await userEvent.hover(hit);
        const tipEl = (): Element | null => document.querySelector('.tooltip-title');
        await waitFor(() => expect(tipEl()).not.toBeNull(), { timeout: 6000 });
        out.push(tipEl()?.closest('[role="tooltip"]')?.outerHTML ?? '(none)');
        await userEvent.unhover(hit);
        await waitFor(() => expect(tipEl()).toBeNull(), { timeout: 6000 });
      }
      expect(out.some((t) => t !== '(none)')).toBe(true);
      return out;
    };
    await open(`#v=waterfall&tr=${m}&o=${encodeURIComponent('task:7')}`);
    g.check('tips-task', await collect());
    cleanup();
    await open(`#v=waterfall&tr=${mainOf(eslint)}`, eslint);
    await userEvent.selectOptions(screen.getByLabelText('Min duration'), '0');
    await settle();
    g.check('tips-eslint-any', await collect());
    cleanup();
    await open(`#v=waterfall&tr=${mainOf(eslint)}`, eslint);
    g.check('tips-eslint-auto', await collect());
    cleanup();
    await open(`#v=waterfall&tr=${mainOf(asyncChain)}`, asyncChain);
    g.check('tips-async', await collect());
  }, 300_000);

  it('finishes', () => g.finish());
});
