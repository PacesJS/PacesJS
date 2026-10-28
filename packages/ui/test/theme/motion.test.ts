import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Motion: a small set of tokens, used for the dock, popovers, tabs and chips, and switched off
// entirely when the user asks for reduced motion. Read from the stylesheets themselves, since the
// browser's computed style is what this checks and jsdom cannot compute it.

const src = resolve(import.meta.dirname, '../../src');
const read = (file: string): string => readFileSync(join(src, file), 'utf8');
const motion = read('styles/motion.css');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the one media query that holds all motion. */
function motionBlock(): string {
  const css = stripComments(motion);
  const open = css.indexOf('{', css.indexOf('@media'));
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('the motion media query is not closed');
}

/** The declarations of the rule for `selector` inside the motion block. */
function rule(selector: string): string {
  const block = motionBlock();
  const at = block.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector} in motion.css`);
  return block.slice(block.indexOf('{', at) + 1, block.indexOf('}', at));
}

describe('motion tokens', () => {
  const tokens = read('theme/tokens.css');
  const token = (name: string): string =>
    new RegExp(`${name}:${String.raw`\s*`}([^;]+);`).exec(tokens)?.[1]?.trim() ?? '';

  it('are defined once, in the theme', () => {
    expect([token('--dur-fast'), token('--dur-med'), token('--dur-slow')]).toEqual([
      '120ms',
      '200ms',
      '320ms',
    ]);
    expect(token('--ease-out')).toMatch(/^cubic-bezier/);
    expect(token('--ease-in-out')).toMatch(/^cubic-bezier/);
  });

  it('are the only durations a transition uses', () => {
    const declarations = motionBlock().match(/transition:[^;]+;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) expect(d).not.toMatch(/\d(ms|s)\b/);
  });

  it('are not redeclared by any other stylesheet, which may only switch motion off', () => {
    const others = readdirSync(join(src, 'styles')).filter((f) => f !== 'motion.css');
    for (const file of others) {
      const declared =
        stripComments(read(`styles/${file}`)).match(/\b(?:transition|animation)\s*:[^;]+;/g) ?? [];
      for (const d of declared) expect(d, file).toMatch(/:\s*none;/);
    }
  });
});

describe('with normal motion', () => {
  it('the dock slides: it has a transition', () => {
    expect(rule('.dock')).toMatch(/transition:[\s\S]*var\(--dur-med\)/);
  });
  it('a popover fades in', () => {
    expect(rule('.menu')).toMatch(/animation:\s*pop-in var\(--dur-fast\)/);
  });
  it('tabs ease between states', () => {
    expect(rule('.tab')).toMatch(/transition:[\s\S]*var\(--dur-fast\)/);
  });
  it('transform chips animate in', () => {
    expect(rule('.chip-item')).toMatch(/animation:\s*chip-in/);
  });
});

describe('with reduced motion', () => {
  it('keeps every transition and animation inside the no-preference query, so none apply otherwise', () => {
    const css = stripComments(motion);
    const open = css.indexOf('{', css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(open).toBeGreaterThan(0);
    expect(css.slice(0, css.indexOf('@media')).trim()).toBe('');
    expect(motionBlock().length + css.indexOf('@media')).toBeGreaterThan(css.length * 0.9);
  });

  it('switches everything off when reduced motion is asked for', () => {
    const base = stripComments(read('styles/base.css'));
    const reduced = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).toMatch(/transition:\s*none/);
  });

  it('opens no second block outside it', () => {
    expect(stripComments(motion).match(/@media/g)).toHaveLength(1);
  });
});
