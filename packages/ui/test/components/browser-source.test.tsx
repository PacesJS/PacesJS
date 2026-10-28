import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeModel } from '@pacesjs/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { memoryHostAdapter } from '../../src/host/memory';
import { nodeElk } from '../helpers/node-elk';
import { browserModel, preload } from '../helpers/real-model';

await preload('browser:slow-click', 'browser:big-script');

afterEach(cleanup);

const model = browserModel('slow-click');
const url = model.strings[model.functions.file[model.findings[0]?.evidence[0] ?? 0] ?? 0] ?? '';

function open(text: string | null) {
  const host = memoryHostAdapter({
    model: serializeModel(model),
    meta: {},
    ...(text === null ? {} : { sources: { [url]: { text } } }),
  });
  render(<App host={host} inProcess elk={nodeElk} />);
  return host;
}

async function showTheHotFunction(): Promise<void> {
  await screen.findByRole('heading', { name: 'Findings' });
  // The Functions view lists `busy`; choosing its row selects it and opens its source.
  await userEvent.keyboard('4');
  const rows = await screen.findAllByRole('row', { name: /busy/ });
  await userEvent.click(rows[0] as HTMLElement);
}

describe('the source of a script a page loaded', () => {
  it('shows the text that was saved with the session', async () => {
    open('function busy(ms) {\n  return ms;\n}\n');
    await showTheHotFunction();
    const source = await screen.findByRole('region', { name: 'Source' });
    await waitFor(() => expect(source.textContent).toContain('function busy(ms)'));
  });

  it('does not offer to open a page script in an editor: it is not a file', async () => {
    open('function busy(ms) {}\n');
    await showTheHotFunction();
    const source = await screen.findByRole('region', { name: 'Source' });
    await waitFor(() => expect(source.textContent).toContain('function busy'));
    expect(screen.queryByRole('button', { name: 'Open in editor' })).toBeNull();
  });

  it('says the script was not saved, rather than showing an empty panel', async () => {
    open(null);
    await showTheHotFunction();
    expect(await screen.findByText(/not saved with the session/i)).toBeTruthy();
  });
});

describe('what a script cost to fetch, in the source panel', () => {
  const big = browserModel('big-script');

  async function showVendorFunction(): Promise<HTMLElement> {
    render(
      <App
        host={memoryHostAdapter({ model: serializeModel(big), meta: {} })}
        inProcess
        elk={nodeElk}
      />,
    );
    await screen.findByRole('heading', { name: 'Findings' });
    await userEvent.keyboard('4');
    const rows = await screen.findAllByRole('row', { name: /vendorStep\d+/ });
    await userEvent.click(rows[0] as HTMLElement);
    return screen.findByRole('region', { name: 'Source' });
  }

  it('shows the size, the fetch time and the run time of the file beside its code', async () => {
    const source = await showVendorFunction();
    const note = await within(source).findByRole('note', { name: 'Fetch cost' });
    expect(note.textContent).toMatch(/\d+ KB/);
    expect(note.textContent).toMatch(/fetched in/);
    expect(note.textContent).toMatch(/to run/);
  });

  it('says the file held up rendering when it did', async () => {
    const source = await showVendorFunction();
    const note = await within(source).findByRole('note', { name: 'Fetch cost' });
    expect(note.textContent).toMatch(/render-blocking/i);
  });
});
