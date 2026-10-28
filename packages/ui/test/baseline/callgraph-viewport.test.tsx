import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { memoryHostAdapter } from '../../src/host/memory';
import { nodeElk } from '../helpers/node-elk';
import { ordersModel, preload } from '../helpers/real-model';

await preload('orders-server');

const orders = ordersModel();

async function openGraph(): Promise<HTMLElement> {
  history.replaceState(null, '', `#v=callgraph&tr=${orders.tracks[0]?.id}`);
  const host = memoryHostAdapter({ model: serializeModel(orders), meta: {} });
  render(<App host={host} inProcess elk={nodeElk} />);
  await screen.findByRole('heading', { name: 'Findings' }, { timeout: 15000 });
  const graph = await screen.findByRole('group', { name: /^Call graph with/ }, { timeout: 15000 });
  // The fit arrives with the layout; an action made before it is overwritten.
  let last = '';
  let same = 0;
  while (same < 5) {
    await new Promise((r) => setTimeout(r, 60));
    const now = layer().style.transform;
    same = now === last && document.querySelector('.cg-node') ? same + 1 : 0;
    last = now;
  }
  return graph;
}

const layer = (): HTMLElement => {
  const el = document.querySelector('.cg-layer');
  if (!(el instanceof HTMLElement)) throw new Error('no cg-layer');
  return el;
};

interface Placement {
  x: number;
  y: number;
  k: number;
}
const placement = (): Placement => {
  const m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\((-?[\d.e+-]+)\)/.exec(
    layer().style.transform,
  );
  if (!m) throw new Error(`unparsed transform: ${layer().style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
};

// The ELK layout is slow while the whole suite runs in parallel; wait generously, not forever.
describe('call graph viewport (baseline)', { timeout: 30000 }, () => {
  it('pans by 60px per arrow key, opposite to the arrow, without easing', async () => {
    const graph = await openGraph();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    graph.focus();
    const start = placement();
    await userEvent.keyboard('{ArrowLeft}');
    expect(placement()).toEqual({ ...start, x: start.x + 60 });
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(placement()).toEqual({ ...start, x: start.x - 60 });
    await userEvent.keyboard('{ArrowUp}');
    expect(placement().y).toBe(start.y + 60);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(placement().y).toBe(start.y - 60);
    expect(layer().className).not.toContain('is-easing');
  });

  it('eases the view for the buttons but not for keys that pan', async () => {
    const graph = await openGraph();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(layer().className).toContain('is-easing');
    graph.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(layer().className).not.toContain('is-easing');
    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(layer().className).toContain('is-easing');
  });

  it('zooms with the wheel by exp(-deltaY * 0.0015) and cancels the page scroll', async () => {
    const graph = await openGraph();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    const before = placement();
    const event = new WheelEvent('wheel', { deltaY: -200, cancelable: true, bubbles: true });
    graph.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await screen.findByLabelText('Zoom level');
    // A real browser keeps five decimals of a scale in style.transform.
    expect(placement().k).toBeCloseTo(before.k * Math.exp(0.3), 4);
    expect(layer().className).not.toContain('is-easing');
  });

  it('zooms faster for a pinch (ctrl + wheel)', async () => {
    const graph = await openGraph();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    const before = placement();
    graph.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, cancelable: true, bubbles: true }),
    );
    await screen.findByLabelText('Zoom level');
    expect(placement().k).toBeCloseTo(before.k * Math.exp(0.1), 4);
  });

  it('pans by the pointer distance once a drag passes the threshold, then swallows the click', async () => {
    const graph = await openGraph();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    graph.setPointerCapture = () => {};
    const start = placement();
    fireEvent.pointerDown(graph, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(graph, { clientX: 102, clientY: 100, pointerId: 1 });
    expect(placement()).toEqual(start);
    fireEvent.pointerMove(graph, { clientX: 130, clientY: 110, pointerId: 1 });
    expect(placement()).toEqual({ ...start, x: start.x + 30, y: start.y + 10 });
    fireEvent.pointerMove(graph, { clientX: 140, clientY: 110, pointerId: 1 });
    expect(placement()).toEqual({ ...start, x: start.x + 40, y: start.y + 10 });
    fireEvent.pointerUp(graph, { pointerId: 1 });
    let clicks = 0;
    graph.parentElement?.addEventListener('click', () => clicks++);
    fireEvent.click(graph);
    expect(clicks).toBe(0);
    fireEvent.click(graph);
    expect(clicks).toBe(1);
  });

  it('ignores a drag started with a secondary button', async () => {
    const graph = await openGraph();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    graph.setPointerCapture = () => {};
    const start = placement();
    fireEvent.pointerDown(graph, { button: 2, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(graph, { clientX: 50, clientY: 50, pointerId: 1 });
    expect(placement()).toEqual(start);
  });
});
