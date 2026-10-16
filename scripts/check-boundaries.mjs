// Dependency-boundary check (TDD: Packages). engine and format must stay free of Node and DOM
// imports so one engine serves Node, browser and every shell (R1).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FORBIDDEN_IMPORT = /from\s+['"](node:[^'"]+|fs|path|os|child_process|worker_threads|net|http|https|zlib|inspector|perf_hooks|async_hooks)['"]/;
const FORBIDDEN_GLOBAL = /\b(document|window|localStorage|self\.postMessage|process\.|Buffer\b)/;
const RULES = [
  { dir: 'packages/engine/src', imports: true, globals: true },
  { dir: 'packages/format/src', imports: true, globals: true },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

let failures = 0;
for (const rule of RULES) {
  const dir = join(ROOT, rule.dir);
  let files = [];
  try {
    files = [...walk(dir)];
  } catch {
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if ((rule.imports && FORBIDDEN_IMPORT.test(code)) || (rule.globals && FORBIDDEN_GLOBAL.test(code))) {
        console.error(`${file}:${i + 1}: forbidden Node/DOM reference: ${line.trim()}`);
        failures++;
      }
    });
  }
}
if (failures) process.exit(1);
console.log('boundaries ok');
