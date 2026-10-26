import { describe, expect, it } from 'vitest';
import {
  initialOverlay,
  overlayView,
  reduceOverlay,
  shortcutFor,
} from '../../src/inject/overlay-state.js';
import type { OverlayState } from '../../src/inject/overlay-state.js';

const host = (phase: string, extra: Partial<OverlayState> = {}): OverlayState =>
  reduceOverlay(initialOverlay(), {
    type: 'host',
    state: { phase, elapsedMs: 4200, marks: 2, ...extra } as never,
  });

describe('overlayView', () => {
  it('is a small dot while recording and nobody is pointing at it', () => {
    const view = overlayView(host('recording'));
    expect(view.expanded).toBe(false);
    expect(view.dotLabel).toBe('paces: recording');
  });

  it('expands on hover or focus, and on the toggle', () => {
    const hovered = reduceOverlay(host('recording'), { type: 'hover', on: true });
    expect(overlayView(hovered).expanded).toBe(true);
    const toggled = reduceOverlay(host('recording'), { type: 'toggle' });
    expect(overlayView(toggled).expanded).toBe(true);
  });

  it('offers Pause, Mark and Stop while recording', () => {
    const view = overlayView(reduceOverlay(host('recording'), { type: 'toggle' }));
    expect(view.buttons.map((b) => [b.id, b.label, b.disabled])).toEqual([
      ['pause', 'Pause', false],
      ['mark', 'Mark', false],
      ['stop', 'Stop', false],
    ]);
    expect(view.status).toBe('Recording 4.2 s');
  });

  it('shows Pausing… with every button disabled', () => {
    const view = overlayView(host('pausing'));
    expect(view.expanded).toBe(true);
    expect(view.status).toBe('Pausing…');
    expect(view.buttons.every((b) => b.disabled)).toBe(true);
  });

  it('is always expanded when paused, with Resume', () => {
    const view = overlayView(host('paused'));
    expect(view.expanded).toBe(true);
    expect(view.status).toBe('Paused, not recording');
    expect(view.buttons.map((b) => b.label)).toEqual(['Resume', 'Mark', 'Stop']);
  });

  it('offers Start before the first recording', () => {
    const view = overlayView(host('ready'));
    expect(view.status).toBe('Ready to record');
    expect(view.buttons.map((b) => b.label)).toEqual(['Start', 'Mark', 'Stop']);
  });

  it('says Saving… while stopping', () => {
    const view = overlayView(host('stopping'));
    expect(view.status).toBe('Saving…');
    expect(view.buttons.every((b) => b.disabled)).toBe(true);
  });

  it('keeps the mark input open until it is submitted or cancelled', () => {
    const open = reduceOverlay(host('paused'), { type: 'open-mark' });
    expect(overlayView(open).markInput).toBe(true);
    expect(overlayView(reduceOverlay(open, { type: 'close-mark' })).markInput).toBe(false);
  });

  it('remembers where the user dragged it', () => {
    const moved = reduceOverlay(host('paused'), { type: 'move', corner: 'bottom-left' });
    expect(overlayView(moved).corner).toBe('bottom-left');
  });
});

describe('shortcutFor', () => {
  it('maps Alt+Shift+M to mark and Alt+Shift+P to pause or resume', () => {
    expect(shortcutFor({ altKey: true, shiftKey: true, code: 'KeyM' })).toBe('mark');
    expect(shortcutFor({ altKey: true, shiftKey: true, code: 'KeyP' })).toBe('toggle-pause');
  });

  it('ignores a plain key and a different modifier combination', () => {
    expect(shortcutFor({ altKey: false, shiftKey: false, code: 'KeyM' })).toBeUndefined();
    expect(shortcutFor({ altKey: true, shiftKey: false, code: 'KeyP' })).toBeUndefined();
  });
});
