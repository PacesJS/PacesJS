import { describe, expect, it } from 'vitest';
import { describeElement } from '../../src/inject/labels.js';
import type { ElementLike } from '../../src/inject/labels.js';

interface Spec {
  tag: string;
  id?: string;
  className?: string;
  attrs?: Record<string, string>;
  text?: string;
  editable?: boolean;
  parent?: ElementLike;
}

function el(spec: Spec): ElementLike {
  const attrs = spec.attrs ?? {};
  return {
    tagName: spec.tag.toUpperCase(),
    id: spec.id ?? '',
    textContent: spec.text ?? '',
    isContentEditable: spec.editable ?? false,
    parentElement: spec.parent ?? null,
    getAttribute: (name) => (name === 'class' ? (spec.className ?? null) : (attrs[name] ?? null)),
  };
}

const withText = { text: true };
const structureOnly = { text: false };

describe('describeElement', () => {
  it('describes an SVG icon, whose className is an object and not a string', () => {
    const icon = Object.assign(el({ tag: 'svg', className: 'icon-close' }), {
      className: { baseVal: 'icon-close' },
    });
    expect(describeElement(icon, withText)).toBe('svg.icon-close');
  });

  it('names an input by tag, type and id', () => {
    const input = el({ tag: 'input', id: 'signup-email', attrs: { type: 'email' } });
    expect(describeElement(input, withText)).toBe('input[type=email]#signup-email');
  });

  it('adds the accessible name of a button, from its text', () => {
    const button = el({ tag: 'button', id: 'save', text: ' Save  changes ' });
    expect(describeElement(button, withText)).toBe('button#save "Save changes"');
  });

  it('prefers aria-label, then title, then text', () => {
    const labelled = el({ tag: 'button', attrs: { 'aria-label': 'Close', title: 'x' }, text: 'X' });
    expect(describeElement(labelled, withText)).toBe('button "Close"');
    const titled = el({ tag: 'a', attrs: { title: 'Home' }, text: 'x' });
    expect(describeElement(titled, withText)).toBe('a "Home"');
  });

  it('truncates a name to 40 characters', () => {
    const long = el({ tag: 'button', id: 'b', text: 'x'.repeat(100) });
    expect(describeElement(long, withText)).toBe(`button#b "${'x'.repeat(39)}…"`);
  });

  it('leaves out every name when text is switched off', () => {
    const button = el({ tag: 'button', id: 'save', text: 'Save' });
    expect(describeElement(button, structureOnly)).toBe('button#save');
  });

  it('adds up to three ancestors when the element has no id, stopping at one with an id', () => {
    const form = el({ tag: 'form', id: 'login' });
    const row = el({ tag: 'div', parent: form });
    const button = el({ tag: 'button', className: 'primary btn', parent: row });
    expect(describeElement(button, structureOnly)).toBe('form#login > div > button.primary');
  });

  it('keeps only the three nearest ancestors', () => {
    let node = el({ tag: 'span' });
    for (const tag of ['b', 'section', 'article', 'main']) node = el({ tag, parent: node });
    const leaf = el({ tag: 'i', parent: node });
    expect(describeElement(leaf, structureOnly)).toBe('section > article > main > i');
  });

  it('never puts the value, placeholder or text of an input in the description', () => {
    const input = el({
      tag: 'input',
      attrs: { type: 'text', value: 'hunter2', placeholder: 'Your secret', name: 'q' },
      text: 'hunter2',
    });
    const described = describeElement(input, withText);
    expect(described).toBe('input[type=text][name=q]');
    expect(described).not.toMatch(/hunter2|secret/);
  });

  it('never names a textarea or a contenteditable element from its content', () => {
    const area = el({ tag: 'textarea', text: 'my private note' });
    const editable = el({ tag: 'div', editable: true, text: 'my private note', id: 'ed' });
    expect(describeElement(area, withText)).toBe('textarea');
    expect(describeElement(editable, withText)).toBe('div#ed');
  });

  it('describes a password field by structure only', () => {
    const input = el({ tag: 'input', attrs: { type: 'password', value: 'abc' } });
    expect(describeElement(input, withText)).toBe('input[type=password]');
  });

  it('adds role and data-testid', () => {
    const tab = el({ tag: 'div', attrs: { role: 'tab', 'data-testid': 'tab-2' }, text: 'Two' });
    expect(describeElement(tab, withText)).toBe('div[role=tab][data-testid=tab-2] "Two"');
  });

  it('caps the whole description at 60 characters', () => {
    const wide = el({ tag: 'button', id: 'i'.repeat(80) });
    expect(describeElement(wide, structureOnly).length).toBeLessThanOrEqual(60);
  });
});
