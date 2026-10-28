/* eslint-disable @typescript-eslint/no-require-imports */
// Starts a forked child, a spawned process and a worker thread, then kills all three, the way test
// runners and dev servers do. Killed processes never run their exit handlers, so their profiles are lost.
const { fork, spawn } = require('node:child_process');
const { Worker, isMainThread } = require('node:worker_threads');

const busy = 'let x=0;setInterval(()=>{for(let i=0;i<2e5;i++)x+=Math.sqrt(i)},10);';

if (process.argv[2] === 'child') {
  eval(busy);
} else if (isMainThread) {
  const forked = fork(__filename, ['child'], { stdio: 'ignore' });
  const spawned = spawn(process.execPath, ['-e', busy], { stdio: 'ignore' });
  const worker = new Worker(busy, { eval: true });
  setTimeout(() => {
    forked.kill();
    spawned.kill();
    void worker.terminate().then(() => process.exit(0));
  }, 1500);
}
