/* eslint-disable @typescript-eslint/no-require-imports */
// Starts a forked child, a spawned process and a worker thread, then kills all three, the way test
// runners and dev servers do. Killed processes never run their exit handlers, so their profiles are lost.
// Each one says when it is running, so none is killed before the profiler has seen it start.
const { fork, spawn } = require('node:child_process');
const { Worker, isMainThread } = require('node:worker_threads');

const busy = 'let x=0;setInterval(()=>{for(let i=0;i<2e5;i++)x+=Math.sqrt(i)},10);';

if (process.argv[2] === 'child') {
  process.send('ready');
  eval(busy);
} else if (isMainThread) {
  const forked = fork(__filename, ['child'], { stdio: 'ignore' });
  const spawned = spawn(process.execPath, ['-e', `process.stdout.write('ready');${busy}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const worker = new Worker(
    `require('node:worker_threads').parentPort.postMessage('ready');${busy}`,
    { eval: true },
  );
  const running = [
    new Promise((resolve) => forked.once('message', resolve)),
    new Promise((resolve) => spawned.stdout.once('data', resolve)),
    new Promise((resolve) => worker.once('message', resolve)),
  ];
  // Let each get a few busy rounds, so its profile is under way when it is killed.
  void Promise.all(running).then(() =>
    setTimeout(() => {
      forked.kill();
      spawned.kill();
      void worker.terminate().then(() => process.exit(0));
    }, 1500),
  );
}
