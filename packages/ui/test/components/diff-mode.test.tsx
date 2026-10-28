import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appReady, openApp } from '../helpers/open-app';
import { fixtureModel } from '../helpers/real-model';

describe('differential mode with a baseline session', () => {
  it('enables Compare with… and colors the flame graph by change from the baseline', async () => {
    openApp(undefined, { baseline: fixtureModel('sync-io') });
    await appReady();
    const compare = screen.getByRole('button', { name: 'Compare with…' });
    expect(compare.getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.click(compare);
    const dialog = await screen.findByRole('dialog', { name: 'Compare with another session' });
    expect(dialog.textContent).toContain('flame graph shows the difference');
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('2');
    const legend = await screen.findByRole('list', { name: 'Difference colors' });
    await waitFor(() => expect(legend.textContent).toContain('Slower than baseline'));
  });

  it('has no difference colors without a baseline', async () => {
    openApp();
    await appReady();
    await userEvent.keyboard('2');
    await screen.findByRole('navigation', { name: 'Views' });
    expect(screen.queryByRole('list', { name: 'Difference colors' })).toBeNull();
  });
});
