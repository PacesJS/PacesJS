// Characterization of what the canvas views draw: every 2D-context call and property write of the last paint
// of each canvas, with a fixed canvas size. Pins the drawing code (bars, hatching, lanes, flame) without
// pixels. See golden.ts.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { memoryHostAdapter } from '../../src/host/memory';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel, ordersModel, preload } from '../helpers/real-model';
import expected from './canvas-golden.json';
import { goldenFile } from './golden.browser';

await preload('orders-server', 'eslint-cli', 'async-chain');

const g = goldenFile('canvas-golden.json', expected);
const orders = ordersModel();
const eslint = fixtureModel('eslint-cli');
const asyncChain = fixtureModel('async-chain');
const mainOf = (m: ExecutionModel): string => m.tracks[m.primaryTrack]?.id ?? '';

const logs = new WeakMap<HTMLCanvasElement, unknown[]>();
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realRect = HTMLElement.prototype.getBoundingClientRect;

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const log: unknown[] = [];
  logs.set(canvas, log);
  const props: Record<string, unknown> = { canvas, font: '10px sans-serif' };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'measureText') {
          return (text: string) => ({ width: text.length * 6 });
        }
        if (prop === 'createLinearGradient' || prop === 'createPattern') {
          return (...a: unknown[]) => {
            log.push([prop, ...a]);
            return { addColorStop: (...s: unknown[]) => log.push(['stop', ...s]) };
          };
        }
        if (prop in props) return props[prop];
        return (...a: unknown[]) => {
          if (prop === 'clearRect') log.length = 0;
          log.push([prop, ...a]);
        };
      },
      set(_t, prop: string, value: unknown) {
        props[prop] = value;
        log.push(['set', prop, value]);
        return true;
      },
    },
  );
  return proxy as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return recordingContext(this);
  } as unknown as HTMLCanvasElement['getContext'];
  HTMLElement.prototype.getBoundingClientRect = function () {
    const tall = this.classList.contains('lane-plot') ? 40 : 360;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 900,
      bottom: tall,
      width: 900,
      height: tall,
      toJSON() {},
    };
  };
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

async function settle(): Promise<void> {
  let last = '';
  let same = 0;
  const deadline = Date.now() + 8000;
  while (same < 5 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
    const now = document.body.innerHTML + document.querySelectorAll('canvas').length;
    same = now === last && !/Loading /.test(now) ? same + 1 : 0;
    last = now;
  }
}

async function open(hash: string, model: ExecutionModel = orders) {
  cleanup();
  history.replaceState(null, '', hash);
  render(
    <App
      host={memoryHostAdapter({ model: serializeModel(model), meta: {} })}
      inProcess
      elk={nodeElk}
    />,
  );
  await screen.findByRole('heading', { name: 'Findings' });
  await settle();
}

function snap(key: string): void {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  expect(
    canvases.some((c) => (logs.get(c)?.length ?? 0) > 5),
    `${key} drew nothing`,
  ).toBe(true);
  g.check(
    key,
    canvases.map((c, i) => [i, c.className, c.width, c.height, logs.get(c) ?? null]),
  );
}

describe('canvas golden masters', () => {
  const m = mainOf(orders);

  it('waterfall of a task', async () => {
    await open(`#v=waterfall&tr=${m}&o=${encodeURIComponent('task:7')}`);
    snap('wf-task');
  });

  it('waterfall whole run, orders and eslint and async', async () => {
    await open(`#v=waterfall&tr=${m}`);
    snap('wf-run');
    await open(`#v=waterfall&tr=${mainOf(eslint)}`, eslint);
    snap('wf-eslint');
    await open(`#v=waterfall&tr=${mainOf(asyncChain)}`, asyncChain);
    snap('wf-async');
  });

  it('waterfall with a selected row and hover', async () => {
    await open(`#v=waterfall&tr=${m}&o=${encodeURIComponent('task:7')}`);
    const rows = screen.getAllByRole('row');
    await userEvent.click(rows[3] as HTMLElement);
    await settle();
    snap('wf-select');
    await userEvent.hover(rows[5] as HTMLElement);
    await settle();
    snap('wf-hover');
  });

  it('flame graph in both colors and layouts', async () => {
    await open(`#v=flame&tr=${m}`);
    snap('flame');
    await open(`#v=flame&tr=${mainOf(eslint)}`, eslint);
    snap('flame-eslint');
  });

  it('track lanes (overview) with several tracks', async () => {
    await open(`#v=functions&tr=${m}`);
    snap('lanes-functions');
    await open(`#v=callgraph&tr=${m}`);
    snap('lanes-callgraph');
  });

  it('finishes', async () => g.finish());
});
