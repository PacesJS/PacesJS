import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { memoryHostAdapter } from '../../src/host/memory';
import { nodeElk } from '../helpers/node-elk';
import {
  browserModel,
  browserModelWith,
  browserScreenshots,
  fixtureModel,
} from '../helpers/real-model';

beforeAll(() => {
  // jsdom has no object URLs; the strip only needs something to point an <img> at.
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:frame', revokeObjectURL: () => {} }),
  );
});
afterEach(cleanup);

function open(model: ExecutionModel, page?: string) {
  const host = memoryHostAdapter({
    model: serializeModel(model),
    meta: {},
    ...(page ? { screenshots: browserScreenshots(page) } : {}),
  });
  render(<App host={host} inProcess elk={nodeElk} />);
  return host;
}

const ready = () => screen.findByRole('heading', { name: 'Findings' });

describe('a Node session', () => {
  it('has none of the browser lanes', async () => {
    open(fixtureModel('hot-regex'));
    await ready();
    expect(screen.queryByRole('group', { name: 'Filmstrip' })).toBeNull();
    expect(screen.queryByText('Rendering')).toBeNull();
    expect(screen.queryByText('Interactions')).toBeNull();
  });
});

describe('a browser session: lanes', () => {
  it('shows the filmstrip, page, rendering and interaction lanes', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    expect(await screen.findByRole('group', { name: 'Filmstrip' })).toBeTruthy();
    for (const title of ['Milestones', 'Rendering', 'Interactions']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it('names the loading milestones in words, each with when it happened', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const labels = await screen.findAllByText(/^First contentful paint \d+\.\d\d s$/);
    expect(labels.length).toBe(1);
    expect(screen.getAllByText(/^Page loaded \d+\.\d\d s$/).length).toBe(1);
  });

  it('draws one line per milestone across all the lanes, in its own color', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    await screen.findAllByText(/^First contentful paint /);
    const lines = document.querySelectorAll('.milestone-lines .milestone-line');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(new Set([...lines].map((l) => l.className)).size).toBe(lines.length);
  });

  it('shows what the page was idle for, with the request it waited on', async () => {
    open(browserModel('slow-load'), 'slow-load');
    await ready();
    expect((await screen.findAllByText('Waiting')).length).toBeGreaterThan(0);
    const list = await screen.findByRole('list', { name: 'Idle stretches' });
    expect(within(list).getAllByText(/waiting on slow-hero\.svg/).length).toBeGreaterThan(0);
  });

  it('draws a block for each idle stretch and a bar for each request', async () => {
    open(browserModel('slow-load'), 'slow-load');
    await ready();
    await screen.findAllByText('Waiting');
    expect(document.querySelectorAll('.idle-block.cause-requests').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.idle-block.cause-nothing').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.request-bar').length).toBeGreaterThan(1);
  });

  it('shows frames as buttons that say when they were taken', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const frames = await screen.findAllByRole('button', { name: /^Frame at \d+\.\d\d s$/ });
    expect(frames.length).toBeGreaterThan(1);
  });

  it('loads the pictures through the host, not by any other route', async () => {
    const host = open(browserModel('slow-click'), 'slow-click');
    const read = vi.spyOn(host, 'readScreenshot');
    await screen.findAllByRole('button', { name: /^Frame at / });
    await waitFor(() => expect(read).toHaveBeenCalled());
  });

  it('sets the range for every view when a frame is chosen', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const [frame] = await screen.findAllByRole('button', { name: /^Frame at / });
    await userEvent.click(frame as HTMLElement);
    expect(await screen.findByRole('group', { name: /^Selected range / })).toBeTruthy();
  });

  it('moves between frames with the arrow keys', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const frames = await screen.findAllByRole('button', { name: /^Frame at / });
    frames[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(frames[1]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(frames[0]);
  });

  it('shows a large copy of a frame while it is hovered', async () => {
    open(browserModel('paused-resume'), 'paused-resume');
    await ready();
    const strip = await screen.findByRole('group', { name: 'Filmstrip' });
    const frames = await within(strip).findAllByRole('button');
    await waitFor(() => expect(strip.querySelector('img')).not.toBeNull());
    await userEvent.hover(frames[0] as HTMLElement);
    await waitFor(() => expect(document.querySelector('.filmstrip-zoom')).not.toBeNull());
    await userEvent.unhover(frames[0] as HTMLElement);
    await waitFor(() => expect(document.querySelector('.filmstrip-zoom')).toBeNull());
  });

  it('labels the gap of a pause in the strip instead of leaving it blank', async () => {
    open(browserModel('paused-resume'), 'paused-resume');
    await ready();
    const strip = await screen.findByRole('group', { name: 'Filmstrip' });
    expect(within(strip).getAllByText('paused').length).toBeGreaterThan(0);
  });

  it('says so when the run kept no screenshots', async () => {
    const m = browserModel('slow-click');
    const none: ExecutionModel = {
      ...m,
      page: m.page && {
        ...m.page,
        screenshots: { length: 0, time: new Float64Array(0), id: new Uint32Array(0) },
      },
    };
    open(none);
    await ready();
    expect(await screen.findByText('No screenshots were recorded')).toBeTruthy();
  });

  it('lists the loading milestones for a screen reader', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const list = await screen.findByRole('list', { name: 'Page milestones' });
    expect(within(list).getByText(/^First contentful paint at /)).toBeTruthy();
  });

  it('lists the layout shift with its score', async () => {
    open(browserModel('layout-shift'), 'layout-shift');
    await ready();
    const list = await screen.findByRole('list', { name: 'Page milestones' });
    expect(within(list).getByText(/^Layout shift 0\.\d\d at /)).toBeTruthy();
  });

  it('lists the click with how long the page took to show a result', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const list = await screen.findByRole('list', { name: 'Interactions' });
    const click = within(list).getByRole('button', { name: /^click button#save "Save" at / });
    expect(click.textContent).toMatch(/to show a result/);
  });

  it('selects the task that handled a click when the click is chosen', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    const list = await screen.findByRole('list', { name: 'Interactions' });
    await userEvent.click(within(list).getByRole('button', { name: /^click button#save/ }));
    await waitFor(() =>
      expect(screen.getAllByText(/click button#save "Save"/).length).toBeGreaterThan(1),
    );
  });

  it('keeps the page events out of the mark flags', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    expect(screen.queryByRole('button', { name: /^Mark 1/ })).toBeNull();
  });

  it('says in the legend which lanes are exact', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    expect(await screen.findByText('Exact: rendering, frames, input')).toBeTruthy();
  });
});

describe('a browser session: header', () => {
  it('shows the command as paces browser <url>, and how the run ended', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    expect(screen.getByText('$ paces')).toBeTruthy();
    expect(screen.getByText(/^browser http:\/\/127\.0\.0\.1:\d+\/slow-click\.html$/)).toBeTruthy();
    expect(screen.getByText('Duration limit')).toBeTruthy();
  });

  it('says the session contains screenshots', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    expect(screen.getByText('Contains screenshots')).toBeTruthy();
  });

  it('says how many times recording was paused', async () => {
    open(browserModel('paused-resume'), 'paused-resume');
    await ready();
    expect(screen.getByText('Paused 1×')).toBeTruthy();
  });

  it('says what changes every number: throttling and a cold cache', async () => {
    open(browserModelWith('slow-click', { throttle: 4, cacheCold: true }), 'slow-click');
    await ready();
    expect(screen.getByText('4× CPU throttle')).toBeTruthy();
    expect(screen.getByText('Cold cache')).toBeTruthy();
  });

  it('says the run ended because the window was closed', async () => {
    open(browserModelWith('slow-click', { endedBy: 'window-closed' }), 'slow-click');
    await ready();
    expect(screen.getByText('Window closed')).toBeTruthy();
  });

  it('labels the tracks page, iframe and worker', async () => {
    open(browserModel('worker-and-iframe'));
    await ready();
    const pick = screen.getByRole('combobox', { name: 'Tracks' });
    const labels = within(pick)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual([
      expect.stringMatching(/^Page · /),
      expect.stringMatching(/^iframe · /),
      expect.stringMatching(/^Worker · worker\.js$/),
    ]);
  });
});

describe('a browser session: findings', () => {
  it('shows the findings only a browser has', async () => {
    open(browserModel('slow-click'), 'slow-click');
    await ready();
    expect(await screen.findByText('Slow interaction')).toBeTruthy();
    expect(screen.getByText('Main thread blocked')).toBeTruthy();
  });

  it('shows the forced layout finding', async () => {
    open(browserModel('forced-layout'), 'forced-layout');
    await ready();
    expect(await screen.findByText('Forced layout')).toBeTruthy();
  });
});
