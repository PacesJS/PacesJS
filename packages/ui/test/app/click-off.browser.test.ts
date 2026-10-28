import { describe, expect, it } from 'vitest';
import { clicksOff, keepsSelection, onScrollbar } from '../../src/app/click-off';
import type { PointerStart } from '../../src/app/click-off';

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const q = (root: HTMLElement, selector: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
};

const none = { selectedText: '', popoverOpen: false, modalOpen: false };
const press = (el: Element, x = 10, y = 10): PointerStart => ({ x, y, target: el, blocked: false });

describe('what keeps the selection', () => {
  const root = dom(`
    <p class="caption">text</p>
    <button class="btn">go</button>
    <a href="#x" class="link">link</a>
    <label class="lab">name</label><input class="field" /><select class="pick"></select>
    <div role="tab" class="tab">tab</div>
    <div role="row" class="row"><span class="cell">cell</span></div>
    <div role="dialog" class="dlg"><p class="inside">inside</p></div>
    <div role="menu" class="menu"><span class="item">item</span></div>
    <div role="separator" class="resize"></div>
    <aside data-keeps-selection class="dock"><p class="code">code</p></aside>
    <div class="lane" data-keeps-selection><canvas class="plot"></canvas></div>
    <section class="empty"><h2 class="title">Title</h2></section>
  `);

  it.each([
    '.btn',
    '.link',
    '.lab',
    '.field',
    '.pick',
    '.tab',
    '.cell',
    '.inside',
    '.item',
    '.resize',
    '.code',
    '.plot',
  ])('keeps for %s', (selector) => {
    expect(keepsSelection(q(root, selector))).toBe(true);
  });

  it.each(['.caption', '.title', '.empty'])('does not keep for %s', (selector) => {
    expect(keepsSelection(q(root, selector))).toBe(false);
  });

  it('does not keep for nothing', () => {
    expect(keepsSelection(null)).toBe(false);
  });
});

describe('a click that clears the selection', () => {
  const root = dom('<p class="caption">text</p><button class="btn">go</button>');
  const caption = q(root, '.caption');
  const button = q(root, '.btn');

  it('is a plain click on a non-interactive area', () => {
    expect(clicksOff(press(caption), { x: 10, y: 10, target: caption }, none)).toBe(true);
  });

  it('is not a click on a control', () => {
    expect(clicksOff(press(button), { x: 10, y: 10, target: button }, none)).toBe(false);
  });

  it('is not a press that began on a control and ended on empty space', () => {
    expect(clicksOff(press(button), { x: 10, y: 10, target: caption }, none)).toBe(false);
  });

  it('is not a drag', () => {
    expect(clicksOff(press(caption, 10, 10), { x: 60, y: 10, target: caption }, none)).toBe(false);
  });

  it('is not the end of a text selection', () => {
    expect(
      clicksOff(
        press(caption),
        { x: 10, y: 10, target: caption },
        { ...none, selectedText: 'tex' },
      ),
    ).toBe(false);
  });

  it('is not the click that closes a popover', () => {
    expect(
      clicksOff(press(caption), { x: 10, y: 10, target: caption }, { ...none, popoverOpen: true }),
    ).toBe(false);
  });

  it('is not a click behind a modal dialog', () => {
    expect(
      clicksOff(press(caption), { x: 10, y: 10, target: caption }, { ...none, modalOpen: true }),
    ).toBe(false);
  });

  it('is not a press that was blocked when it started (a scrollbar)', () => {
    expect(
      clicksOff({ ...press(caption), blocked: true }, { x: 10, y: 10, target: caption }, none),
    ).toBe(false);
  });

  it('works without a recorded press, as for a click made by script', () => {
    expect(clicksOff(null, { x: 0, y: 0, target: caption }, none)).toBe(true);
    expect(clicksOff(null, { x: 0, y: 0, target: button }, none)).toBe(false);
  });
});

describe('scrollbars', () => {
  /** A real scroll container at a known place: its gutters are the browser's own. */
  function scroller(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:100px;top:50px;width:300px;height:200px;overflow:scroll;';
    const content = document.createElement('div');
    content.style.cssText = 'width:1000px;height:1000px;';
    el.append(content);
    document.body.append(el);
    return el;
  }

  it('recognizes a press in the vertical scrollbar gutter', () => {
    const el = scroller();
    expect(el.offsetWidth, 'this browser draws classic scrollbars').toBeGreaterThan(el.clientWidth);
    expect(onScrollbar(el, 100 + el.clientWidth + 2, 120)).toBe(true);
  });

  it('recognizes a press in the horizontal scrollbar gutter', () => {
    const el = scroller();
    expect(onScrollbar(el, 200, 50 + el.clientHeight + 2)).toBe(true);
  });

  it('does not mistake a press in the content', () => {
    expect(onScrollbar(scroller(), 200, 120)).toBe(false);
  });

  it('knows an element without scrollbars has none', () => {
    const plain = document.createElement('div');
    document.body.append(plain);
    expect(onScrollbar(plain, 1, 1)).toBe(false);
  });

  it('knows a block that only looks wider than its client box has none, since it does not scroll', () => {
    const el = document.createElement('div');
    el.style.cssText = 'width:300px;height:100px;border:10px solid;overflow:visible;';
    document.body.append(el);
    expect(el.offsetWidth).toBeGreaterThan(el.clientWidth);
    expect(onScrollbar(el, el.getBoundingClientRect().right - 2, 20)).toBe(false);
  });

  it('does not take inline text for a scrollbar: its client box is empty', () => {
    const text = document.createElement('span');
    text.textContent = 'sorted by self time, high to low';
    document.body.append(text);
    const box = text.getBoundingClientRect();
    expect(text.clientWidth).toBe(0);
    expect(onScrollbar(text, box.left + box.width / 2, box.top + box.height / 2)).toBe(false);
  });
});
