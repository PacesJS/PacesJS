import { Origin } from '@pacesjs/engine';
import type { FunctionInfo } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { cgLocation, cgSubtitle } from '../../src/data/call-graph-label';

const info = (over: Partial<FunctionInfo>): FunctionInfo =>
  ({
    name: 'f',
    file: 'src/a/b.ts',
    line: 3,
    origin: Origin.User,
    synthetic: false,
    ...over,
  }) as FunctionInfo;

describe('call graph node subtitle', () => {
  it.each([
    ['the entry point', info({}), true, 'entry point'],
    ['a collapsed package', info({ synthetic: true }), false, 'package'],
    ['user code: the file name and line', info({}), false, 'b.ts:3'],
    ['node runtime code', info({ origin: Origin.Node, file: '' }), false, 'node'],
    ['native code', info({ origin: Origin.Native, file: '' }), false, 'native'],
    ['the garbage collector', info({ origin: Origin.Gc, file: '' }), false, 'V8'],
    ['framework code without a file', info({ origin: Origin.Framework, file: '' }), false, ''],
  ])('names %s', (_what, fn, isEntry, expected) => {
    expect(cgSubtitle(fn, isEntry, cgLocation(fn))).toBe(expected);
  });

  it('shows a location only for user and dependency code', () => {
    expect(cgLocation(info({}))).toBe('src/a/b.ts:3');
    expect(cgLocation(info({ origin: Origin.Node }))).toBe('');
    expect(cgLocation(info({ synthetic: true }))).toBe('');
  });
});
