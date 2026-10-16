import { describe, expect, it } from 'vitest';
import { loadCapture } from '../helpers/capture.js';
import { runPasses } from '../helpers/run-passes.js';
import { synthCapture } from '../helpers/synth.js';

describe('plumbing detection on real fixtures', () => {
  const orders = runPasses(loadCapture('orders-server')).functions;
  const rx = runPasses(loadCapture('rxjs-chain')).functions;
  const plumbingNames = (fns: typeof orders) =>
    new Set(fns.filter((f) => f.plumbing).map((f) => f.name));

  it('marks event emitter dispatch and the async scheduler entry frames', () => {
    const names = plumbingNames(orders);
    expect(names.has('emit')).toBe(true);
    expect(names.has('wrapper')).toBe(true);
    expect(names.has('processTicksAndRejections')).toBe(true);
  });

  it('marks the bundler module wrappers but never the planted hot code', () => {
    expect(plumbingNames(orders).has('__require')).toBe(true);
    const hot = orders.filter((f) => ['lineTotal', 'getOrders', 'loadTemplate'].includes(f.name));
    expect(hot.length).toBe(3);
    expect(hot.some((f) => f.plumbing)).toBe(false);
  });

  it('marks RxJS subscriber plumbing but not its module loading code', () => {
    const names = plumbingNames(rx);
    expect(names.has('OperatorSubscriber')).toBe(true);
    expect(names.has('arrRemove')).toBe(true);
    const moduleTopLevel = rx.filter(
      (f) => f.file.includes('rxjs@') && f.name === '' && f.line === 1 && f.col === 0,
    );
    expect(moduleTopLevel.length).toBeGreaterThan(5);
    expect(moduleTopLevel.some((f) => f.plumbing)).toBe(false);
  });

  it('does not mark file system or native work as plumbing', () => {
    expect(orders.find((f) => f.name === 'readFileSync')?.plumbing).toBe(false);
    expect(orders.find((f) => f.name === 'readFileUtf8')?.plumbing).toBe(false);
  });
});

describe('plumbing detection of inline helpers', () => {
  it.each(['__awaiter', '__generator', '_asyncToGenerator', 'asyncGeneratorStep'])(
    'marks %s in user files',
    (name) => {
      const { functions } = runPasses(synthCapture([{ stack: [name, 'userWork'], samples: 2 }]));
      expect(functions.find((f) => f.name === name)?.plumbing).toBe(true);
      expect(functions.find((f) => f.name === 'userWork')?.plumbing).toBe(false);
    },
  );

  it('marks everything in tslib', () => {
    const { functions } = runPasses(
      synthCapture([
        {
          stack: [{ name: 'anything', url: 'file:///project/node_modules/tslib/tslib.js' }],
          samples: 1,
        },
      ]),
    );
    expect(functions.find((f) => f.name === 'anything')?.plumbing).toBe(true);
  });

  it('applies user patterns to file and function name', () => {
    const capture = synthCapture([{ stack: ['dispatchAction', 'handler'], samples: 2 }]);
    const { functions } = runPasses(capture, { plumbingPatterns: ['#dispatch', '['] });
    expect(functions.find((f) => f.name === 'dispatchAction')?.plumbing).toBe(true);
    expect(functions.find((f) => f.name === 'handler')?.plumbing).toBe(false);
  });
});
