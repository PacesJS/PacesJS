import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../../src/theme/tokens.css'), 'utf8');
const value = (block: string, name: string): string | undefined =>
  new RegExp(`${name}:${String.raw`\s*`}([^;]+);`).exec(block)?.[1]?.trim();

/** The declarations of the first rule whose selector starts with `selector`. */
function block(selector: string, from = 0): string {
  const at = css.indexOf(selector, from);
  if (at < 0) throw new Error(`no ${selector}`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('colour tokens', () => {
  const light = block(':root {');
  const darkByOs = block(
    ":root:not([data-theme='light'])",
    css.indexOf('prefers-color-scheme: dark'),
  );
  const darkByChoice = block(":root[data-theme='dark']");

  it('use dark tokens when the OS asks for dark', () => {
    expect(value(darkByOs, '--c-bg')).toBeDefined();
    expect(value(darkByOs, '--c-bg')).not.toBe(value(light, '--c-bg'));
    expect(value(darkByOs, '--c-ink')).not.toBe(value(light, '--c-ink'));
  });

  it('give the same dark colours when dark is chosen by hand', () => {
    expect(value(darkByChoice, '--c-bg')).toBe(value(darkByOs, '--c-bg'));
    expect(value(darkByChoice, '--c-ink')).toBe(value(darkByOs, '--c-ink'));
  });

  it('let a hand-chosen light theme win over a dark OS', () => {
    expect(css).toContain(":root:not([data-theme='light'])");
  });
});
