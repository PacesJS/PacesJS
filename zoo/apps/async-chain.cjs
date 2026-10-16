// Planted problem: a CPU-heavy verify() that runs after each await. In a sampled profile every
// continuation after an await is a separate stack rooted in the runtime, not under main().
// One logical run: main() awaits run(), run() awaits readAndVerify() per file, then reports.
const fs = require('node:fs/promises');
const path = require('node:path');

const src = path.join(__dirname, '..', 'orders-server', 'src');
const files = ['db/orders.ts', 'routes/orders.ts', 'render/invoice.ts', 'render/template.ts'].map(
  (f) => path.join(src, f),
);

function checksum(text, rounds) {
  let hash = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

// Work that runs before the first await, so the call is visible in the samples.
function prepare(file) {
  return checksum(file.repeat(40), 450);
}

function verify(text) {
  return checksum(text, 22000);
}

async function readAndVerify(file) {
  const key = prepare(file);
  const text = await fs.readFile(file, 'utf8');
  return { key, sum: verify(text) };
}

function reporter(results) {
  let total = 0;
  for (let i = 0; i < 6_000_000; i++)
    total = (total * 33 + results[i % results.length].sum + i) | 0;
  return total;
}

async function run() {
  const results = [];
  for (const file of files) results.push(await readAndVerify(file));
  return reporter(results);
}

async function main() {
  await run();
}

main();
