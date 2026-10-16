import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let templatePath = '';

export function prepareTemplate(): void {
  const dir = mkdtempSync(join(tmpdir(), 'orders-'));
  templatePath = join(dir, 'invoice.tpl');
  writeFileSync(templatePath, 'x'.repeat(24 * 1024 * 1024));
}

// Planted problem: a synchronous file read inside the request path, on every request.
export function loadTemplate(): string {
  return readFileSync(templatePath, 'utf8');
}
