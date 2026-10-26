// Runs inside the page; self-contained (see labels.ts).

export type OverlayPhase = 'ready' | 'recording' | 'pausing' | 'paused' | 'stopping';
export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface HostState {
  phase: OverlayPhase;
  elapsedMs: number;
  marks: number;
  position?: Corner;
}

export interface OverlayState {
  host: HostState;
  hover: boolean;
  toggled: boolean;
  markInput: boolean;
  corner: Corner;
}

export type OverlayAction =
  | { type: 'host'; state: HostState }
  | { type: 'hover'; on: boolean }
  | { type: 'toggle' }
  | { type: 'open-mark' }
  | { type: 'close-mark' }
  | { type: 'move'; corner: Corner };

export interface OverlayButton {
  id: 'start' | 'pause' | 'resume' | 'mark' | 'stop';
  label: string;
  disabled: boolean;
}

export interface OverlayView {
  expanded: boolean;
  dotLabel: string;
  status: string;
  buttons: OverlayButton[];
  markInput: boolean;
  corner: Corner;
}

export function initialOverlay(): OverlayState {
  return {
    host: { phase: 'recording', elapsedMs: 0, marks: 0 },
    hover: false,
    toggled: false,
    markInput: false,
    corner: 'bottom-right',
  };
}

export function reduceOverlay(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case 'host':
      return {
        ...state,
        host: action.state,
        corner: action.state.position ?? state.corner,
      };
    case 'hover':
      return { ...state, hover: action.on };
    case 'toggle':
      return { ...state, toggled: !state.toggled };
    case 'open-mark':
      return { ...state, markInput: true };
    case 'close-mark':
      return { ...state, markInput: false };
    case 'move':
      return { ...state, corner: action.corner };
  }
}

export function overlayView(state: OverlayState): OverlayView {
  const { phase, elapsedMs } = state.host;
  const busy = phase === 'pausing' || phase === 'stopping';
  const main: Pick<OverlayButton, 'id' | 'label'> =
    phase === 'paused'
      ? { id: 'resume', label: 'Resume' }
      : phase === 'ready'
        ? { id: 'start', label: 'Start' }
        : { id: 'pause', label: 'Pause' };
  const status =
    phase === 'recording'
      ? 'Recording ' + (elapsedMs / 1000).toFixed(1) + ' s'
      : phase === 'pausing'
        ? 'Pausing…'
        : phase === 'paused'
          ? 'Paused, not recording'
          : phase === 'ready'
            ? 'Ready to record'
            : 'Saving…';
  return {
    expanded: phase !== 'recording' || state.hover || state.toggled || state.markInput,
    dotLabel: 'paces: ' + phase,
    status,
    buttons: [
      { ...main, disabled: busy },
      { id: 'mark', label: 'Mark', disabled: busy },
      { id: 'stop', label: 'Stop', disabled: busy },
    ],
    markInput: state.markInput,
    corner: state.corner,
  };
}

export function shortcutFor(event: {
  altKey: boolean;
  shiftKey: boolean;
  code: string;
}): 'mark' | 'toggle-pause' | undefined {
  if (!event.altKey || !event.shiftKey) return undefined;
  if (event.code === 'KeyM') return 'mark';
  if (event.code === 'KeyP') return 'toggle-pause';
  return undefined;
}
