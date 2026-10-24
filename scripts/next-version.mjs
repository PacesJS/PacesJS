// Prints the version CI should publish for `paces`: package.json's version while npm has nothing on
// that major.minor line, otherwise the next patch of whichever is higher. Bump package.json's minor
// to start a new line.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version) {
  const m = PLAIN.exec(version);
  if (!m) throw new Error(`Version "${version}" is not a plain major.minor.patch number.`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** @param {string} local package.json version  @param {string | undefined} published latest on npm */
export function nextVersion(local, published) {
  const [lma, lmi, lpa] = parse(local);
  if (published === undefined) return local;
  const [pma, pmi, ppa] = parse(published);
  const ahead =
    pma > lma || (pma === lma && pmi > lmi) || (pma === lma && pmi === lmi && ppa >= lpa);
  if (!ahead) return local;
  return `${pma}.${pmi}.${ppa + 1}`;
}

function publishedVersion(name) {
  try {
    const out = execSync(`npm view ${name} version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() || undefined;
  } catch (e) {
    const text = `${e.stderr ?? ''}${e.stdout ?? ''}`;
    if (/E404|404 /.test(text)) return undefined;
    throw new Error(`Could not ask npm for the published version of ${name}: ${text || e.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(
    readFileSync(new URL('../packages/paces/package.json', import.meta.url), 'utf8'),
  );
  process.stdout.write(`${nextVersion(pkg.version, publishedVersion(pkg.name))}\n`);
}
