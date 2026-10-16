import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAsync } from '../../src/app/hooks';

describe('useAsync', () => {
  it('keeps the previous result visible while the next one loads', async () => {
    let release: (v: string) => void = () => undefined;
    const { result, rerender } = renderHook(
      ({ key }) =>
        useAsync(
          () =>
            key === 'a'
              ? Promise.resolve('first')
              : new Promise<string>((resolve) => (release = resolve)),
          key,
        ),
      { initialProps: { key: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('first'));
    rerender({ key: 'b' });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe('first');
    await act(async () => release('second'));
    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('drops the previous result when the next request fails, so stale data is never shown as current', async () => {
    const { result, rerender } = renderHook(
      ({ key }) =>
        useAsync(
          () => (key === 'a' ? Promise.resolve('file A text') : Promise.reject(new Error('boom'))),
          key,
        ),
      { initialProps: { key: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('file A text'));
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.data).toBeUndefined();
  });
});
