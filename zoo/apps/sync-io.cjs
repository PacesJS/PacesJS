// Planted problem: a synchronous fs read inside a request handler.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serve } = require('./_drive.cjs');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-')), 'data.bin');
fs.writeFileSync(file, Buffer.alloc(12 * 1024 * 1024, 1));

serve(async () => fs.readFileSync(file).length, 30);
