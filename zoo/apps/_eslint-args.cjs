// Shared by the eslint zoo apps: the eslint command line and an async runner. Waiting without
// blocking keeps a supporting process idle, like a real launcher.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'zoo', 'orders-server', 'src');

function eslintArgs() {
  const pkg = fs.realpathSync(path.join(root, 'node_modules', 'eslint'));
  return [
    path.join(pkg, 'bin', 'eslint.js'),
    '--no-config-lookup',
    '-c',
    path.join(root, 'zoo', 'eslint-cli', 'eslint.config.mjs'),
    '--no-warn-ignored',
    // A few small files: startup dominates, but rule execution is visible.
    src,
    path.join(root, 'packages', 'engine', 'src', 'passes'),
  ];
}

function run(args) {
  spawn(process.execPath, args, { cwd: root, stdio: 'ignore' }).on('exit', (code) => {
    // eslint exits 1 when it reports problems, which is a normal outcome here.
    if (code !== 0 && code !== 1) throw new Error(`child exited with ${code}`);
    process.exitCode = 0;
  });
}

module.exports = { eslintArgs, run };
