import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgDir = join(import.meta.dirname, '..');
const dist = join(pkgDir, 'dist');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe('published package', () => {
  it('declares no runtime dependencies of any kind', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it('has no install-time scripts', () => {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(scripts[name]).toBeUndefined();
    }
  });

  it('requires Node 20.19 or newer and exposes the paces bin', () => {
    expect((pkg.engines as { node: string }).node).toBe('>=20.19');
    expect(pkg.bin).toEqual({ paces: './dist/cli.js' });
  });
});

describe.skipIf(!existsSync(join(dist, 'cli.js')))('built bundle (dist)', () => {
  const cli = existsSync(join(dist, 'cli.js')) ? readFileSync(join(dist, 'cli.js'), 'utf8') : '';

  it('starts with a node shebang', () => {
    expect(cli.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('imports only Node built-ins: every other dependency is bundled in', () => {
    const specifiers = new Set<string>();
    const patterns = [
      /^import\s[^;'"`]*?from\s*["']([^"']+)["']/gm,
      /^import\s*["']([^"']+)["']/gm,
      /require\(\s*["']([^"']+)["']\s*\)/g,
      /import\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const re of patterns) for (const m of cli.matchAll(re)) specifiers.add(m[1] as string);
    const builtins = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
    const external = [...specifiers].filter((s) => !builtins.has(s) && !s.startsWith('./'));
    expect(external).toEqual([]);
  });

  it('does not pull in the MCP SDK or other dev-only packages', () => {
    expect(cli).not.toContain('@modelcontextprotocol');
    expect(cli).not.toContain('from "react');
  });

  it('ships no native binaries', () => {
    const native = walk(dist).filter((f) => /\.(node|dll|so|dylib|exe)$/i.test(f));
    expect(native).toEqual([]);
  });

  it('ships the preload next to the CLI', () => {
    expect(existsSync(join(dist, 'preload.cjs'))).toBe(true);
  });
});
