import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, openApp } from '../helpers/open-app';

describe('adding a transform', () => {
  it('adds one from the menu, shows it as a chip, and rewinding drops it again', async () => {
    openApp();
    await appReady();
    await userEvent.click(screen.getByRole('button', { name: 'Add transform' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Invert call tree' }));
    expect(await screen.findByRole('button', { name: 'Rewind to Invert' })).toBeTruthy();
    await waitFor(() => expect(decodeURIComponent(location.hash)).toContain('invert'));
    await userEvent.click(screen.getByRole('button', { name: 'Rewind to Collapse dependencies' }));
    expect(screen.queryByRole('button', { name: 'Rewind to Invert' })).toBeNull();
  });
});

describe('the call graph', () => {
  const positions = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.cg-node')).map(
      (node) => `${node.style.left},${node.style.top}`,
    );

  it('shows each function once and keeps positions when the selection changes', async () => {
    openApp();
    await appReady();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('3');
    await waitFor(() => expect(document.querySelectorAll('.cg-node').length).toBeGreaterThan(1));
    const before = positions();
    await userEvent.click(document.querySelectorAll('.cg-node')[1] as Element);
    expect(positions()).toEqual(before);
    const names = Array.from(document.querySelectorAll('.cg-node-name')).map((n) => n.textContent);
    expect(new Set(names).size).toBe(names.length);
  });
});
