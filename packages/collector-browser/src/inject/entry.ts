// The script paces installs in every page and iframe. `injectedMain` is stringified, so it may only
// use its two parameters, its own locals and browser globals.

import { createCoalescer } from './coalesce.js';
import { describeElement } from './labels.js';
import type { ElementLike } from './labels.js';
import { initialOverlay, overlayView, reduceOverlay, shortcutFor } from './overlay-state.js';
import type { Corner, HostState, OverlayAction, OverlayState } from './overlay-state.js';

export interface InjectConfig {
  overlay: boolean;
  eventMarks: boolean;
  eventText: boolean;
}

export interface InjectHelpers {
  describeElement: typeof describeElement;
  createCoalescer: typeof createCoalescer;
  initialOverlay: typeof initialOverlay;
  reduceOverlay: typeof reduceOverlay;
  overlayView: typeof overlayView;
  shortcutFor: typeof shortcutFor;
}

/** The URL V8 reports for the script, which is how the engine knows it is paces' own code. */
export const INSTRUMENTATION_URL = 'paces://instrumentation/inject.js';
export const BRIDGE_NAME = '__pacesBridge';

export function injectedMain(config: InjectConfig, helpers: InjectHelpers): void {
  const g = window as unknown as Record<string, unknown>;
  if (g.__paces__) return;
  const isTop = window === window.top;
  const frame = isTop ? 'top' : 'sub';

  const bridge = (message: Record<string, unknown>): void => {
    try {
      const send = g.__pacesBridge;
      if (typeof send === 'function') (send as (s: string) => void)(JSON.stringify(message));
    } catch {
      // The page keeps working when the host is not listening.
    }
  };
  const stamp = (label: string): void => {
    try {
      // This is the one console call paces needs: it puts a mark on the trace clock.
      // eslint-disable-next-line no-console
      console.timeStamp(label);
    } catch {
      // Older engines have no console.timeStamp.
    }
  };
  const epochNow = (): number => performance.timeOrigin + performance.now();

  // Unique across documents: a navigation restarts the counter, and the trace stamp is the join key.
  const docTag = Math.floor(performance.timeOrigin).toString(36);
  let count = 0;
  let overlayHost: Element | null = null;

  const coalescer = helpers.createCoalescer({
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    emit: (kind, label) => {
      if (!config.eventMarks) return;
      count++;
      const seq = docTag + '.' + count;
      stamp('paces:' + seq);
      bridge({ t: 'event', seq, at: epochNow(), kind, label, frame });
    },
  });

  const inOverlay = (e: Event): boolean => {
    if (!overlayHost) return false;
    const path = e.composedPath();
    return path.indexOf(overlayHost) >= 0;
  };
  const targetOf = (e: Event): ElementLike | null => {
    const first = e.composedPath()[0] ?? e.target;
    const node = first as Node | null;
    if (!node) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return element as unknown as ElementLike | null;
  };
  const describe = (e: Event): string => {
    const target = targetOf(e);
    return target ? helpers.describeElement(target, { text: config.eventText }) : 'unknown';
  };

  if (config.eventMarks) {
    const listen = (type: string, handler: (e: Event) => void): void => {
      window.addEventListener(
        type,
        (e) => {
          try {
            if (!inOverlay(e)) handler(e);
          } catch {
            // Never let our listener break the page.
          }
        },
        { capture: true, passive: true },
      );
    };
    listen('click', (e) => coalescer.event('click', describe(e)));
    listen('dblclick', (e) => coalescer.event('click', describe(e)));
    listen('submit', (e) => coalescer.event('submit', describe(e)));
    listen('change', (e) => {
      const t = e.target as { type?: string; tagName?: string } | null;
      const kind = (t?.type ?? '').toLowerCase();
      if (t?.tagName === 'SELECT' || kind === 'checkbox' || kind === 'radio') {
        coalescer.event('change', describe(e));
      }
    });
    listen('input', (e) => coalescer.typing(describe(e)));
    listen('keydown', (e) => {
      const k = e as KeyboardEvent;
      let cls = '';
      if (k.ctrlKey || k.metaKey || (k.altKey && k.key.length === 1)) cls = 'Shortcut';
      else if (k.key === 'Enter' || k.key === 'Escape' || k.key === 'Tab') cls = k.key;
      else if (k.key.indexOf('Arrow') === 0) cls = 'Arrow';
      if (cls) coalescer.event('key', cls);
    });
    listen('scroll', () => coalescer.scroll());
    document.addEventListener(
      'visibilitychange',
      () => coalescer.event('visibility', document.visibilityState),
      { passive: true },
    );
    window.addEventListener('pagehide', () => coalescer.flush(), { passive: true });
  }

  let renderOverlay: (state: HostState) => void = () => {};

  if (config.overlay && isTop) {
    let state: OverlayState = helpers.initialOverlay();
    let receivedAt = performance.now();
    const control = (action: string, label?: string): void =>
      bridge({ t: 'control', action, ...(label !== undefined ? { label } : {}) });

    const css = `
      :host { all: initial; }
      .root { position: fixed; z-index: 2147483647; font: 13px/1.3 system-ui, sans-serif;
        color: var(--fg); --fg: #1b2433; --bg: #eef3fb; --line: #8fa3c4; --accent: #2b59c3; }
      @media (prefers-color-scheme: dark) {
        .root { --fg: #e6ecf7; --bg: #1c2434; --line: #4a5b7a; --accent: #7aa2f7; }
      }
      .bottom-right { right: 12px; bottom: 12px; } .bottom-left { left: 12px; bottom: 12px; }
      .top-right { right: 12px; top: 12px; } .top-left { left: 12px; top: 12px; }
      .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent);
        border: 2px solid var(--bg); box-sizing: content-box; padding: 0; cursor: pointer; }
      .pill { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg);
        border: 1px solid var(--line); border-radius: 999px; cursor: grab; }
      .status { white-space: nowrap; }
      button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line);
        border-radius: 999px; padding: 3px 10px; cursor: pointer; }
      button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button:disabled { opacity: 0.5; cursor: default; }
      input { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
        border-radius: 6px; padding: 3px 6px; width: 160px; }`;

    const host = document.createElement('div');
    overlayHost = host;
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      // Without constructable stylesheets the overlay is unstyled but still works.
    }
    const root = document.createElement('div');
    shadow.appendChild(root);

    const draw = (): void => {
      const adjusted: OverlayState = {
        ...state,
        host: {
          ...state.host,
          elapsedMs:
            state.host.phase === 'recording'
              ? state.host.elapsedMs + (performance.now() - receivedAt)
              : state.host.elapsedMs,
        },
      };
      const view = helpers.overlayView(adjusted);
      root.replaceChildren();
      root.className = 'root ' + view.corner;
      if (!view.expanded) {
        const dot = document.createElement('button');
        dot.className = 'dot';
        dot.setAttribute('aria-label', view.dotLabel);
        dot.addEventListener('click', () => dispatch({ type: 'toggle' }));
        root.appendChild(dot);
        return;
      }
      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.setAttribute('role', 'toolbar');
      pill.setAttribute('aria-label', 'paces recording controls');
      const status = document.createElement('span');
      status.className = 'status';
      status.setAttribute('aria-live', 'polite');
      status.textContent = view.status;
      pill.appendChild(status);
      for (const b of view.buttons) {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        btn.disabled = b.disabled;
        btn.addEventListener('click', () => {
          if (b.id === 'mark') dispatch({ type: 'open-mark' });
          else control(b.id);
        });
        pill.appendChild(btn);
      }
      if (view.markInput) {
        const field = document.createElement('input');
        field.setAttribute('aria-label', 'Mark label');
        field.setAttribute('placeholder', 'Label, then Enter');
        field.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            control('mark', field.value);
            dispatch({ type: 'close-mark' });
          } else if (e.key === 'Escape') dispatch({ type: 'close-mark' });
        });
        pill.appendChild(field);
        setTimeout(() => field.focus(), 0);
      }
      pill.addEventListener('pointerup', (e) => {
        if (
          (e.target as Element | null)?.tagName === 'BUTTON' ||
          (e.target as Element | null)?.tagName === 'INPUT'
        )
          return;
        const right = e.clientX > window.innerWidth / 2;
        const bottom = e.clientY > window.innerHeight / 2;
        const corner = ((bottom ? 'bottom' : 'top') + '-' + (right ? 'right' : 'left')) as Corner;
        if (corner !== state.corner) {
          dispatch({ type: 'move', corner });
          control('position:' + corner);
        }
      });
      root.appendChild(pill);
    };
    // Redrawing replaces the buttons. A press that moves focus or the pointer (focusin, mouseenter)
    // must not do that between mouse-down and mouse-up, or the click is lost: only redraw when
    // what is shown has changed.
    const shown = (s: OverlayState): string =>
      JSON.stringify(helpers.overlayView({ ...s, host: { ...s.host, elapsedMs: 0 } }));
    const dispatch = (action: OverlayAction): void => {
      const before = shown(state);
      state = helpers.reduceOverlay(state, action);
      if (shown(state) !== before) draw();
    };
    renderOverlay = (host) => {
      receivedAt = performance.now();
      dispatch({ type: 'host', state: host });
    };

    root.addEventListener('mouseenter', () => dispatch({ type: 'hover', on: true }));
    root.addEventListener('mouseleave', () => dispatch({ type: 'hover', on: false }));
    shadow.addEventListener('focusin', () => dispatch({ type: 'hover', on: true }));
    shadow.addEventListener('focusout', () => dispatch({ type: 'hover', on: false }));
    window.addEventListener(
      'keydown',
      (e) => {
        const action = helpers.shortcutFor(e);
        if (!action) return;
        e.preventDefault();
        if (action === 'mark') dispatch({ type: 'open-mark' });
        else
          control(
            state.host.phase === 'paused' || state.host.phase === 'ready' ? 'resume' : 'pause',
          );
      },
      true,
    );
    // Appending before the parser has made <html> and <body> would make the overlay the document
    // root and stop the page from parsing, so wait for the body.
    const attach = (): boolean => {
      const root = document.documentElement;
      if (!root || !document.body) return false;
      if (!host.isConnected) root.appendChild(host);
      return true;
    };
    if (!attach()) {
      const watcher = new MutationObserver(() => {
        if (attach()) watcher.disconnect();
      });
      watcher.observe(document, { childList: true, subtree: true });
    }
    draw();
  }

  const api = {
    state(next: HostState): void {
      renderOverlay(next);
    },
    sync(n: number): number {
      stamp('paces:sync:' + n);
      return epochNow();
    },
  };
  Object.defineProperty(window, '__paces__', {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  bridge({ t: 'hello', frame, url: location.origin + location.pathname });
}

const HELPER_NAMES = [
  'describeElement',
  'createCoalescer',
  'initialOverlay',
  'reduceOverlay',
  'overlayView',
  'shortcutFor',
] as const;

const HELPER_FUNCTIONS: InjectHelpers = {
  describeElement,
  createCoalescer,
  initialOverlay,
  reduceOverlay,
  overlayView,
  shortcutFor,
};

/** The complete script text, ending with the source URL that marks it as paces' own code. */
export function buildInjectedSource(config: InjectConfig): string {
  const helpers = HELPER_NAMES.map((n) => `${n}: ${HELPER_FUNCTIONS[n].toString()}`).join(',\n');
  return (
    `(${injectedMain.toString()})(${JSON.stringify(config)}, {\n${helpers}\n});\n` +
    `//# sourceURL=${INSTRUMENTATION_URL}\n`
  );
}
