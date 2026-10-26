// Runs inside the page: every function in src/inject is stringified into the injected script, so
// each one must be self-contained (no imports, no outer helpers).

export interface ElementLike {
  tagName: string;
  id: string;
  className: string;
  textContent: string | null;
  isContentEditable: boolean;
  parentElement: ElementLike | null;
  getAttribute(name: string): string | null;
}

export interface DescribeOptions {
  /** Include text-derived names (aria-label, title, text content). */
  text: boolean;
}

/**
 * A description built from structure and names, never from values: tag, type, name, role, test id
 * and id, then a short ancestor path when there is no id, then the accessible name of buttons and
 * links. The text of inputs, textareas and editable content is never read.
 */
export function describeElement(el: ElementLike, options: DescribeOptions): string {
  const MAX_TOTAL = 60;
  const MAX_NAME = 40;
  const lower = (s: string): string => s.toLowerCase();

  const own = (node: ElementLike, detailed: boolean): string => {
    const tag = lower(node.tagName);
    let out = tag;
    if (detailed) {
      if (tag === 'input') {
        const type = node.getAttribute('type');
        const name = node.getAttribute('name');
        if (type) out += '[type=' + type + ']';
        if (name) out += '[name=' + name + ']';
      }
      const role = node.getAttribute('role');
      const testId = node.getAttribute('data-testid');
      if (role) out += '[role=' + role + ']';
      if (testId) out += '[data-testid=' + testId + ']';
    }
    if (node.id) return out + '#' + node.id;
    const cls = (node.className || '').trim().split(/\s+/)[0];
    return cls ? out + '.' + cls : out;
  };

  const tag = lower(el.tagName);
  const role = el.getAttribute('role') || '';
  const namesItself =
    tag === 'button' ||
    tag === 'a' ||
    tag === 'summary' ||
    tag === 'label' ||
    role === 'button' ||
    role === 'link' ||
    role === 'tab' ||
    role === 'menuitem';
  const readsContent =
    tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;

  let described = own(el, true);
  if (!el.id) {
    const path: string[] = [];
    let node = el.parentElement;
    for (let i = 0; node && i < 3; i++) {
      path.unshift(own(node, false));
      if (node.id) break;
      node = node.parentElement;
    }
    if (path.length > 0) described = path.join(' > ') + ' > ' + described;
  }
  if (options.text && namesItself && !readsContent) {
    const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name) {
      const shown = name.length > MAX_NAME ? name.slice(0, MAX_NAME - 1) + '…' : name;
      described += ' "' + shown + '"';
    }
  }
  return described.length > MAX_TOTAL ? described.slice(0, MAX_TOTAL - 1) + '…' : described;
}
