---
paths:
  - '**/*.md'
  - '**/*.json'
  - '**/*.yaml'
  - '**/*.yml'
  - '**/*.css'
---

# Docs, config and CSS rules

- Markdown: sentence-case headings, one H1, short paragraphs, fenced code blocks with a language. Use `paces` (never "Trailmap") in anything new. Do not edit `docs/`: the original TDD and design boards are inputs, pending the owner's rename.
- JSON and YAML: 2-space indent, no comments in `.json`. `package.json` key order: name, version, description, license, type, exports, scripts, dependencies.
- `package.json`: workspace deps use `workspace:*`; `engines.node` stays `>=20.19`; library packages declare `files` and `exports` explicitly. Add a dependency to the package that uses it, not the root (except tooling).
- CSS: custom properties for every design token, flex and grid layout, no `!important`, no ids as selectors, respect `prefers-reduced-motion` and `prefers-color-scheme`. Class names are `kebab-case`, prefixed by component (`.waterfall-row`).
- `turbo.json` tasks declare `outputs`; never cache `dev`.
