import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

it('renders React in jsdom', () => {
  render(<p>paces</p>);
  expect(screen.getByText('paces')).toBeTruthy();
});
