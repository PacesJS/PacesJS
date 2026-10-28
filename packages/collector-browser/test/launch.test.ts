import { describe, expect, it } from 'vitest';
import { browserArgs } from '../src/launch.js';

describe('browserArgs', () => {
  it('uses the private pipe, a throwaway profile and a single about:blank tab', () => {
    const args = browserArgs('/tmp/p');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--user-data-dir=/tmp/p');
    expect(args.filter((a) => a === 'about:blank')).toHaveLength(1);
  });

  it('keeps the browser alive after the last window closes, so the trace can still be collected', () => {
    expect(browserArgs('/tmp/p')).toContain('--keep-alive-for-test');
  });

  it('stops Edge from relaunching itself, which would leave paces holding a closed pipe', () => {
    expect(browserArgs('/tmp/p')).toContain('--edge-skip-compat-layer-relaunch');
  });

  it('keeps a covered or background window painting and running timers, so the profile is of the page', () => {
    const args = browserArgs('/tmp/p');
    expect(args).toContain('--disable-features=CalculateNativeWinOcclusion');
    expect(args).toContain('--disable-backgrounding-occluded-windows');
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
  });

  it('never opens a TCP debugging port', () => {
    expect(browserArgs('/tmp/p').some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });
});
