// A launcher that does nothing but start another node script and wait for it.
const { spawn } = require('node:child_process');

spawn(process.execPath, process.argv.slice(2), { stdio: 'ignore' }).on('exit', (code) => {
  process.exitCode = code ?? 1;
});
