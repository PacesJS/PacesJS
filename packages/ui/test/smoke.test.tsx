import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

it('renders React in a real browser', () => {
  render(<p>paces</p>);
  expect(screen.getByText('paces')).toBeTruthy();
});
