// Planted problem: a worker pool where one worker gets most of the jobs.
const { Worker, isMainThread, workerData } = require('node:worker_threads');

function crunch(rounds) {
  let x = 0;
  for (let i = 0; i < rounds; i++) x += Math.sqrt(i) % 3;
  return x;
}

if (isMainThread) {
  new Worker(__filename, { workerData: { jobs: 10 } });
  new Worker(__filename, { workerData: { jobs: 1 } });
} else {
  for (let j = 0; j < workerData.jobs; j++) crunch(3_000_000);
}
