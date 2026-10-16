// Planted problem: a large module loaded lazily inside a request, after startup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serve } = require('./_drive.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-'));
let source = 'module.exports = function pick(i) { switch (i) {\n';
for (let i = 0; i < 60000; i++) source += `case ${i}: return ${i * 3};\n`;
source += 'default: return 0; } };\n';

let n = 0;
serve(async () => {
  const file = path.join(dir, `big-${n++ % 1}.js`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, source);
  delete require.cache[file];
  return require(file)(7);
}, 6);
