// Realistic CLI target: the profiled program is an npm package (eslint) living in node_modules.
// This app spawns `node eslint/bin/eslint.js` on a few small files; the child inherits
// NODE_OPTIONS, so the preload attaches to it. This process only waits (a supporting track).
const { eslintArgs, run } = require('./_eslint-args.cjs');

run(eslintArgs());
