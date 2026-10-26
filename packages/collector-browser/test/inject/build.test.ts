import { describe, expect, it } from 'vitest';
import { INSTRUMENTATION_URL, buildInjectedSource } from '../../src/inject/entry.js';

const config = { overlay: true, eventMarks: true, eventText: true };

describe('buildInjectedSource', () => {
  it('ends with the paces://instrumentation/ source URL', () => {
    const source = buildInjectedSource(config);
    expect(source.trimEnd().split('\n').pop()).toBe(`//# sourceURL=${INSTRUMENTATION_URL}`);
    expect(INSTRUMENTATION_URL.startsWith('paces://instrumentation/')).toBe(true);
  });

  it('is plain script that parses on its own, with no module syntax', () => {
    const source = buildInjectedSource(config);
    expect(() => new Function(source)).not.toThrow();
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
  });

  it('carries no bundler helper that would not exist in the page', () => {
    expect(buildInjectedSource(config)).not.toMatch(/__name\(|__publicField|__defProp/);
  });

  it('embeds every page-side helper', () => {
    const source = buildInjectedSource(config);
    for (const name of ['describeElement', 'createCoalescer', 'reduceOverlay', 'overlayView']) {
      expect(source).toContain(`${name}:`);
    }
  });

  it('carries the configuration it was built with', () => {
    expect(buildInjectedSource({ ...config, eventText: false })).toContain('"eventText":false');
  });

  it('does nothing outside a page: running it with no window fails fast, not silently half-installed', () => {
    expect(() => new Function(buildInjectedSource(config))()).toThrow();
  });
});
