import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no layout, canvas, matchMedia or ResizeObserver: provide inert stand-ins.
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = InertResizeObserver as unknown as typeof ResizeObserver;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
Element.prototype.scrollIntoView = () => undefined;
Element.prototype.scrollTo = (() => undefined) as unknown as Element['scrollTo'];
Element.prototype.setPointerCapture = () => undefined;

beforeEach(() => {
  history.replaceState(null, '', '#');
});

afterEach(() => cleanup());
