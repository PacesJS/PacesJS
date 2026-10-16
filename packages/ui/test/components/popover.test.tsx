import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Popover } from '../../src/components/Popover';

function Menu({ name, items = ['One', 'Two', 'Three'] }: { name: string; items?: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="menu"
      label={`${name} menu`}
      trigger={(p) => (
        <button type="button" {...p}>
          {name}
        </button>
      )}
    >
      {(close) =>
        items.map((i) => (
          <button key={i} type="button" role="menuitem" onClick={close}>
            {`${name} ${i}`}
          </button>
        ))
      }
    </Popover>
  );
}

const menu = (name: string) => screen.queryByRole('menu', { name: `${name} menu` });

describe('popover', () => {
  it('opens from its trigger and reports aria-expanded', async () => {
    render(<Menu name="Add" />);
    const trigger = screen.getByRole('button', { name: 'Add' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(menu('Add')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on a press outside', async () => {
    render(
      <>
        <Menu name="Add" />
        <p>elsewhere</p>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.click(screen.getByText('elsewhere'));
    expect(menu('Add')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    render(<Menu name="Add" />);
    const trigger = screen.getByRole('button', { name: 'Add' });
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(menu('Add')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when focus tabs out of it', async () => {
    render(
      <>
        <Menu name="Add" items={['Only']} />
        <button type="button">next</button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.tab();
    await userEvent.tab();
    expect(menu('Add')).toBeNull();
  });

  it('closes when an item is chosen', async () => {
    render(<Menu name="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add Two' }));
    expect(menu('Add')).toBeNull();
  });

  it('moves between items with the arrow keys, wrapping at the ends', async () => {
    render(<Menu name="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(document.activeElement?.textContent).toBe('Add One');
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Add Two');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('Add Three');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement?.textContent).toBe('Add One');
    await userEvent.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('Add Three');
  });

  it('keeps only one popover open at a time', async () => {
    render(
      <>
        <Menu name="First" />
        <Menu name="Second" />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'First' }));
    await userEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(menu('First')).toBeNull();
    expect(menu('Second')).toBeTruthy();
  });

  it('closes on a second press of its own trigger', async () => {
    render(<Menu name="Add" />);
    const trigger = screen.getByRole('button', { name: 'Add' });
    await userEvent.click(trigger);
    await userEvent.click(trigger);
    expect(menu('Add')).toBeNull();
  });
});
