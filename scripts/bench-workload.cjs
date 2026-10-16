// Benchmark workloads, timed inside the process so tool start-up and exit-flush are reported separately.
// Usage: node bench-workload.cjs <cpu|promise>   -> prints {"workMs": n}
const kind = process.argv[2];

function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function cpuBound() {
  let acc = 0;
  for (let i = 0; i < 6; i++) acc += fib(33);
  const arr = [];
  for (let i = 0; i < 3000000; i++) arr.push({ id: i, v: Math.sqrt(i) });
  acc += arr.filter((o) => o.id % 3 === 0).reduce((s, o) => s + o.v, 0);
  return acc;
}

async function step(i) {
  await null;
  return i & 7;
}

async function promiseHeavy() {
  let acc = 0;
  for (let i = 0; i < 4000000; i++) acc += await step(i);
  const batch = [];
  for (let i = 0; i < 500000; i++) batch.push(step(i));
  for (const v of await Promise.all(batch)) acc += v;
  return acc;
}

(async () => {
  const start = performance.now();
  if (kind === 'cpu') cpuBound();
  else if (kind === 'promise') await promiseHeavy();
  else throw new Error('usage: bench-workload.cjs <cpu|promise>');
  const workMs = performance.now() - start;
  process.stdout.write(`${JSON.stringify({ workMs })}\n`);
})();
