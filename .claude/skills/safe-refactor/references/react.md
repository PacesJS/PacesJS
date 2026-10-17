# React components catalog

Goal: components that are isolated (understandable and testable on their own), reusable (no hidden dependencies on where they're rendered), and pure in render.

## Contents
1. Non-isolated, non-reusable components
2. Impure render and effect misuse
3. Oversized components and prop explosion
4. Hooks smells
5. Things that look like refactors but change behavior
6. Baseline tests for components

---

## 1. Non-isolated, non-reusable components

**Signals**
- Presentational components that reach outward: read a global store, router, `window`, `localStorage`, feature flags, or a specific context directly when the data could arrive as props.
- Data fetching inside leaf UI components.
- Hard-coded copy, IDs, URLs, dimensions, colors, or z-index inside a component that's used in more than one place.
- Styling that depends on where the component is rendered: parent descendant selectors (`.sidebar .card`), sibling selectors, global class names, `margin` on the component's root that only makes sense in one layout.
- Props drilled through 3+ layers that don't use them.
- A component file that can't be rendered in a test or story without mocking half the app.

**Fixes**
- Container/presentational split: a thin container connects to store/router/data; the presentational component takes plain props. Prefer extracting the logic into a custom hook (`useOrderSummary`) over a wrapper component when the project uses hooks.
- Composition over configuration: `children` and slot props (`header`, `footer`, `renderItem`) instead of boolean props that toggle sub-parts.
- Let the parent own outer spacing; the component styles only its own box.
- Context for genuinely cross-cutting values (theme, locale, current user) instead of drilling. Not for frequently changing values that many consumers don't need — that causes re-renders.

**Leave it when:** the component is a page/route-level container whose job *is* to connect to the app; it's used exactly once and isolation would add a layer with no reader benefit; the project's established pattern is connected components and it's applied consistently.

## 2. Impure render and effect misuse

**Signals**
- Side effects in the render body: mutating variables outside the component, mutating props or state objects, subscriptions, `console.log` that something consumes, reading `Date.now()`/`Math.random()` to produce output.
- Derived state stored in state and synced with `useEffect` (`useEffect(() => setFullName(first + ' ' + last), [first, last])`).
- State that duplicates a prop and is "kept in sync" by an effect.
- Effects that respond to user events (should live in the event handler).
- Effects that chain (`setA` in one effect triggers another effect that sets `B`).

**Fixes:** compute derived values during render (`useMemo` only if measurably expensive); move event-driven logic into handlers; replace prop-mirroring state with the prop itself, or with a `key` to reset when identity changes; lift state up when two components mirror each other.

**Behavior traps:** removing a "derived state via effect" pattern eliminates one render pass where the old value was visible. If anything observes that intermediate render (an effect that fires on it, an animation, analytics, a test), the change is visible. Check with a baseline test that records rendered values over time or the order of callback calls.

## 3. Oversized components and prop explosion

**Signals:** components over ~200 lines; more than ~8–10 props; several boolean props that combine into variants (`primary`, `small`, `outline`, `danger`); props passed through unchanged to a child; multiple unrelated `useState` groups in one component; JSX with deeply nested ternaries.

**Fixes:** split by responsibility into subcomponents; replace boolean combinations with a single `variant`/`size` prop *only when the combinations are mutually exclusive in practice* (verify all call sites); compound components (`<Tabs><Tabs.List/>...`) for components with many sub-parts; extract custom hooks for each state group; early returns or small subcomponents instead of nested ternaries.

**Behavior traps:** a variant prop can make previously reachable combinations impossible. If any call site passes `primary` and `danger` together, the new API must still render exactly what that produced, or the finding becomes an API change needing approval.

## 4. Hooks smells

| Smell | Note |
| --- | --- |
| `useCallback`/`useMemo` everywhere without memoized consumers | Speculative; removal is behavior-neutral unless an effect depends on referential identity. Check effect deps downstream. If the project uses React Compiler, manual memoization is usually redundant. |
| Missing effect dependencies | **Not a refactor.** Adding deps changes when the effect runs. Log as a potential bug. |
| `eslint-disable react-hooks/exhaustive-deps` | Same: log, don't "fix". |
| Custom hook that only wraps one built-in call | Speculative generality; inline it unless it's an established naming convention in the repo. |
| Logic duplicated across components | Extract a custom hook (same gate as duplication: three copies or one shared rule). |
| `useRef` used to stash values that should be state | Changing to state adds re-renders: behavior change. Log. |

## 5. Things that look like refactors but change behavior

These change observable behavior. Log them under "Bugs found" or as approval items; don't apply them silently.

- **Component defined inside another component.** It remounts on every parent render, resetting its state and DOM (focus, scroll, input contents). Moving it out stops the remounting. That's usually a fix, but it is a behavior change.
- **Index as `key` in lists that reorder.** Switching to a stable key changes which state goes with which item.
- **Adding `React.memo`** changes render counts; an effect or ref that counted renders, or a child relying on re-render to pick up a mutated prop, will behave differently. Usually safe, but check for mutation.
- **Converting class components to hooks.** `componentDidUpdate` ordering, `setState` callback timing, error boundaries (no hook equivalent), and `getDerivedStateFromProps` semantics differ. Only with thorough interaction tests.
- **Controlled ↔ uncontrolled input changes.**
- **Moving data fetching** up or down the tree changes when requests fire and what loading states appear.
- **List virtualization** removes off-screen DOM, which affects find-in-page, tests, and screen readers.

## 6. Baseline tests for components

Use the project's runner with React Testing Library (or what the project already uses):

- Render with representative props, including edge values (empty lists, long strings, missing optional props).
- Assert by role and accessible name (`getByRole('button', { name: /save/i })`). These survive internal restructuring.
- Snapshot the markup with `asFragment()` or an inline snapshot as a characterization net for pure markup refactors. Review the snapshot once when it's created; it records current output, warts included. Keep snapshots focused on the component, not whole pages.
- Drive interactions with `@testing-library/user-event` and assert the resulting DOM and callback calls, including arguments and order (`mock.calls`, `mock.invocationCallOrder`).
- For extracted custom hooks, also test via `renderHook` — but keep at least one test through the component, since that's the public surface.
- If the project has Storybook with the test runner or Playwright, add or reuse stories as visual baselines for components whose styles you touch.
