// A large synthetic capture for the performance benchmarks: 60 s at 1 ms, a few thousand call
// nodes, deep stacks, idle gaps. Deterministic (seeded generator).
import type { RawCapture } from '../../src/raw.js';
import { synthCapture } from './synth.js';
import type { Step } from './synth.js';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** `shared: false` gives every run an unrelated random stack: the worst case for tree size. */
export function largeCapture(samples = 60_000, shared = true): RawCapture {
  const rand = lcg(42);
  const pool = Array.from({ length: 400 }, (_, i) => ({
    name: `fn${i}`,
    url: `file:///project/src/mod${i % 40}.js`,
    line: (i * 7) % 300,
  }));
  // A random call tree (about 3000 nodes, up to 25 deep); every stack is a root-to-node path, so
  // stacks share prefixes the way real profiles do.
  const parents: number[] = [-1];
  const fns: number[] = [0];
  const depths: number[] = [0];
  while (parents.length < 3000) {
    const parent = Math.floor(rand() * parents.length);
    if ((depths[parent] ?? 0) >= 25) continue;
    parents.push(parent);
    fns.push(Math.floor(rand() * pool.length));
    depths.push((depths[parent] ?? 0) + 1);
  }
  const randomStacks = Array.from({ length: 3000 }, () => {
    const depth = 6 + Math.floor(rand() * 20);
    return Array.from({ length: depth }, () => pool[Math.floor(rand() * pool.length)] ?? pool[0]!);
  });
  const sharedStacks = parents.map((_, node) => {
    const path: Array<(typeof pool)[number]> = [];
    for (let n = node; n >= 0; n = parents[n] ?? -1) path.push(pool[fns[n] ?? 0] ?? pool[0]!);
    return path.reverse();
  });
  const stacks = shared ? sharedStacks : randomStacks;
  const steps: Step[] = [];
  let produced = 0;
  while (produced < samples) {
    if (rand() < 0.08) {
      const idle = 1 + Math.floor(rand() * 15);
      steps.push({ idle });
      produced += idle;
    } else {
      const run = 1 + Math.floor(rand() * 12);
      const stack = stacks[Math.floor(rand() * stacks.length)] ?? [];
      steps.push({ stack: stack.map((f) => ({ ...f })), samples: run });
      produced += run;
    }
  }
  return synthCapture(steps);
}
