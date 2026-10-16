import { workerData } from 'node:worker_threads';

function crunch(rounds: number): number {
  let x = 0;
  for (let i = 0; i < rounds; i++) x += Math.sqrt(i) % 3;
  return x;
}

// The pool is imbalanced on purpose: worker 1 gets 9 jobs, worker 2 gets 2.
for (let job = 0; job < workerData.jobs; job++) crunch(20_000_000);
