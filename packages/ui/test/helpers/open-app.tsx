import { render, screen } from '@testing-library/react';
import { serializeModel } from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { App } from '../../src/app/App';
import type { Settings } from '../../src/host/adapter';
import { memoryHostAdapter } from '../../src/host/memory';
import { nodeElk } from './node-elk';
import { ordersModel, preload } from './real-model';

await preload('orders-server');

/** Renders the whole app over a model held in memory, the way the host serves it. */
export function openApp(
  model: ExecutionModel = ordersModel(),
  options: {
    baseline?: ExecutionModel;
    sources?: Record<string, { text: string }>;
    meta?: Record<string, unknown>;
    settings?: Settings;
  } = {},
) {
  const host = memoryHostAdapter({
    model: serializeModel(model),
    baseline: options.baseline ? serializeModel(options.baseline) : undefined,
    meta: options.meta ?? {},
    sources: options.sources,
    settings: options.settings,
  });
  render(<App host={host} inProcess elk={nodeElk} />);
  return host;
}

export async function appReady(): Promise<void> {
  await screen.findByRole('heading', { name: 'Findings' });
}

/** The URL hash as parameters: the app keeps its whole screen there. */
export const hashParams = (): URLSearchParams => new URLSearchParams(location.hash.slice(1));
export const hasSelection = (): boolean => hashParams().has('sel');
