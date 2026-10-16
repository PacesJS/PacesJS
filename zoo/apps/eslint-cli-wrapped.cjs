// Same target as eslint-cli, started through a launcher process (like `npx eslint` or a package
// script runner): three processes, two of them only supporting.
const path = require('node:path');
const { eslintArgs, run } = require('./_eslint-args.cjs');

run([path.join(__dirname, '_launcher.cjs'), ...eslintArgs()]);
