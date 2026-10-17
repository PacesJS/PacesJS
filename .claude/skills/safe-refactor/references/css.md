# CSS catalog

CSS behavior is what the user sees. Every change here needs visual-equivalence evidence (see "Verifying CSS changes" at the end). Applies to plain CSS, SCSS/Less, CSS Modules, and CSS-in-JS (styled-components, Emotion, style objects).

## Contents
1. Excessive absolute positioning
2. Excessive z-index
3. `!important`
4. Repeated literal values (font sizes, spacing, borders, radii, colors...)
5. Other CSS smells
6. Verifying CSS changes

---

## 1. Excessive absolute positioning

**Signals**
- Several siblings with `position: absolute` and hand-tuned `top`/`left` laying out what is really a row, column, or grid of normal content.
- Absolute elements with fixed pixel widths/heights paired with magic offsets (`top: 37px`).
- `position: absolute` used to escape overflow or to "fix" alignment.
- Many absolute declarations in one file (`scan_css.py` reports counts per file).

**Legitimate uses (leave):** overlays, modals, drawers; tooltips, popovers, dropdown menus positioned relative to an anchor (consider a positioning library or CSS anchor positioning if the project already uses one); badges and corner adornments; decorative pseudo-elements; stacked/cross-faded media; visually-hidden utilities.

**Fix:** flexbox or grid for flow layout; `gap` instead of offsets; `margin-inline-start: auto` / `justify-content` / `place-self` for alignment; `aspect-ratio` instead of padding hacks; `inset` shorthand where absolute is legitimate.

**Behavior:** layout-affecting. Requires screenshot comparison at the project's breakpoints. Without visual tooling, defer.

## 2. Excessive z-index

z-index should be rare: a handful of named layers for the whole app.

**Signals:** many distinct values (`scan_css.py` lists them); escalation values (`999`, `9999`, `2147483647`); several z-index declarations per component; z-index on elements that aren't positioned and aren't flex/grid items (no effect); z-index used to fix problems that a stacking context (`isolation: isolate`) or DOM order would solve.

**Fix**
- Remove z-index where elements never overlap, or where DOM order already gives the same stacking.
- Remove z-index that has no effect: the element is `position: static` **and** is not a flex or grid item. (Flex and grid items *do* honor z-index without positioning — don't remove those as dead.)
- Use `isolation: isolate` on a component root to contain its internal stacking instead of competing globally.
- Consolidate the rest into one named scale (tokens such as `--z-dropdown`, `--z-sticky`, `--z-modal`, `--z-toast`), using the project's token mechanism.
- Render overlays through a portal at the end of `body` when the project has a portal convention.

**Behavior trap:** mapping arbitrary values onto a scale must preserve the relative order of every pair of elements that can overlap, including across stacking contexts. Build a mapping table (old value → new layer) and check that no two previously ordered elements swap or become equal. Equal z-index falls back to DOM order, which can flip the result.

## 3. `!important`

Should be extremely rare.

**Legitimate uses (leave):** utility classes designed to always win (`.sr-only`, `.hidden`, Tailwind's important modifier); overriding inline styles injected by third-party code you can't change; user-preference resets like `@media (prefers-reduced-motion: reduce)`; print styles.

**Fix:** find the rule it's beating and resolve the conflict at the source — lower the competing selector's specificity, co-locate the rules, use `:where()` to zero out specificity of base styles, or use cascade layers (`@layer reset, vendor, base, components, utilities`) to order third-party CSS below app CSS.

**Behavior:** removing `!important` changes the cascade wherever another rule matches the same element and property. Enumerate the competing rules (search for the property on selectors that could match), and verify visually. Without that evidence, defer.

## 4. Repeated literal values

Hard-coded values for font-size, line-height, font-weight, margin, padding, gap, border width/style/color, border-radius, colors, shadows, transition durations, and breakpoints, repeated across files, should come from design tokens.

**Process**
1. **Find existing tokens first:** CSS custom properties (`--space-4: 16px`), SCSS/Less variables, a Tailwind theme, a JS theme object, a tokens JSON. `detect_project.py` lists likely token files, and `scan_css.py` reports literals that equal an existing token's value — the cheapest, highest-value fixes.
2. **Only then introduce new tokens**, following the repo's naming convention (scale-based like `--space-2`, or semantic like `--radius-card`). Add them where the existing tokens live.
3. **Replace exact matches only.** `16px` may be replaced by a token that resolves to exactly `16px`. Never snap near-misses (`15px` → `16px`, `#333` → `#323232`); that's a visual change. List near-misses in the report as a design-cleanup decision for a human.

**Behavior traps**
- Don't convert units: `1rem` equals `16px` only at the default root font size, and users can change it.
- Custom properties don't work inside media query conditions. Breakpoints need preprocessor variables or stay literal.
- `var(--x)` resolves at computed-value time and inherits; a token redefined in a nested scope could change the value for some elements. Check that the token isn't overridden anywhere the replaced literal lives.
- An invalid `var()` makes the whole declaration invalid at computed-value time (falls back to inherited/initial), whereas a typo'd literal is dropped at parse time and the previous declaration wins. Make sure every new `var()` resolves.
- Shorthands: replacing parts of `margin: 8px 16px` is fine as long as each part resolves to the same value.

## 5. Other CSS smells

| Smell | Signal | Fix | Note |
| --- | --- | --- | --- |
| Deep nesting | Selectors deeper than 3 levels (SCSS nesting makes this easy) | Flatten, use a class on the target | Specificity changes: verify |
| ID selectors for styling | `#header .nav` | Classes | Specificity drops: verify |
| Overqualified selectors | `div.button`, `ul.list li.item` | Drop the type | Specificity drops: verify |
| Duplicate rule blocks | Same declarations under different selectors | Shared class or mixin | Exact duplicates only |
| Duplicate properties in one block | Second declaration silently wins | Remove the overridden one | Keep intentional fallbacks (`display: flex; display: grid` for old browsers) |
| Unused selectors | Class never referenced | Delete | Search for dynamically built class names first |
| Inline static styles in JSX | `style={{ marginTop: 8 }}` everywhere | Class or styled component | Inline styles beat stylesheet rules: verify |
| Manual vendor prefixes | `-webkit-` everywhere | Rely on Autoprefixer if the build has it | Confirm the build runs it and browserslist covers the targets |
| `px` font sizes | Accessibility concern | **Report only** | Changing units changes behavior |

## 6. Verifying CSS changes

Choose the strongest method available:

1. **Compiled-CSS equivalence** (pure substitutions, dead rule removal): build the CSS before and after (use `git worktree add` for the "before"), normalize (format, sort declarations within a rule only if order doesn't matter for that rule), and diff. For CSS custom properties, resolved values aren't in compiled output, so pair this with a check that each token resolves to the same literal and isn't overridden in scope.
2. **Screenshot comparison:** Playwright `toHaveScreenshot`, Storybook test-runner, Chromatic, or Percy if the project has them. Capture the affected pages/components at each breakpoint and in each theme, before the change, then compare after.
3. **Computed-style snapshots:** in a real browser (Playwright), select the affected elements and record `getComputedStyle` for the properties in question plus `getBoundingClientRect()`. jsdom does not compute layout, so it can't verify positioning changes.

If none is available for a layout-affecting change, mark the finding `defer: needs visual verification`, and suggest in the report what minimal visual-test setup would unlock it. Adding Playwright to the project requires user approval (new dependency).
