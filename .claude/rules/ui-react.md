---
paths:
  - 'packages/ui/**'
---

# UI rules (React 19, Vite, Canvas 2D, SVG)

**The designs are the source of truth:** screenshots `docs/*.png`, per-board markup with exact copy and styles in `design/boards/*.html`, Poppins fonts in `design/fonts/`. Match copy, spacing, radii and colors. When in doubt, compare a Playwright screenshot against the board.

- Tokens, not literals: colors, radii, shadows, spacing and type scale live in `src/theme/tokens.css` as CSS custom properties (light and dark via `prefers-color-scheme` and `[data-theme]`). No hex values in components. Font is Poppins, bundled locally (nothing loads from the network); mono is `ui-monospace`.
- The origin palette (you / dependency / framework / Node / native / GC) is one module (`src/theme/origin.ts`), colorblind-safe, shown in a legend on every view and always paired with a second cue (label, pattern or position).
- The orange gradient is the brand and selection accent. Red and amber are only for finding severity.
- Components are function components with hooks, one per file, props typed with an `interface`. No class components. No `useEffect` for derived state; compute it or `useMemo`. Keep render pure.
- State is one selection model (function, call node, span, task or range) plus the transform stack and view state, serialized to the URL hash. Views read the transformed model and never mutate it.
- Heavy work (transforms, aggregation, ELK layout) runs in a Web Worker using `@pacesjs/engine`. The main thread only renders. Targets: transform under 50 ms, pan and zoom at 60 fps.
- Bars, flames and the waterfall draw on Canvas 2D with level of detail (aggregate sub-pixel). The call graph is SVG. Canvas views need a DOM mirror (visible text or `aria-label`s) so they stay testable and screen-reader usable.
- Accessibility: interactive targets at least 44×44 px, visible `:focus-visible` ring, full keyboard operation (`1`–`4`, `/`, `f`, `m`, `c`, `i`, `p`, `?`, Alt+←/→), `aria-live` for status, `role="switch"` for toggles.
- The UI talks to its host only through `HostAdapter`. No absolute-URL `fetch`, no host-specific globals.
- Tests: Testing Library queries by role or label (test ids only when unavoidable) and user-event for input. Pure view-model logic (layout math, scales, label truncation) is unit-tested separately from components.
