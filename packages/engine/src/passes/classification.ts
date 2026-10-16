// Pass 3: tag each function's origin. Rules are URL patterns plus the caller's override map.

import type { OriginName } from '../config.js';
import { Origin } from '../model.js';
import type { OriginId } from '../model.js';
import { packageNameFromPath } from '../util/paths.js';
import type { MappedFunctions } from './source-maps.js';
import type { PassContext } from './types.js';

export interface Classification {
  origin: Uint8Array;
  /** npm package name (string id), 0 for user code and anything outside node_modules. */
  pkg: Uint32Array;
}

const FRAMEWORK_PACKAGES = new Set([
  'express',
  'koa',
  'fastify',
  'restify',
  'connect',
  'next',
  'nuxt',
  'react',
  'react-dom',
  'react-server-dom-webpack',
  'vue',
  'svelte',
  'solid-js',
  'preact',
]);
const FRAMEWORK_SCOPES = ['@angular/', '@nestjs/', '@hapi/', '@remix-run/', '@sveltejs/'];

const ORIGIN_BY_NAME: Record<OriginName, OriginId> = {
  user: Origin.User,
  dependency: Origin.Dependency,
  framework: Origin.Framework,
  node: Origin.Node,
  native: Origin.Native,
};

/** The collector's own wrappers run inside the target; they are infrastructure, not user code. */
const COLLECTOR_PATH = /(^|\/)(collector-node|@pacesjs\/collector-node)\/dist\//;

function isFramework(pkg: string): boolean {
  return FRAMEWORK_PACKAGES.has(pkg) || FRAMEWORK_SCOPES.some((s) => pkg.startsWith(s));
}

export function classify(functions: MappedFunctions, ctx: PassContext): Classification {
  const strings = ctx.strings.strings;
  const overrides: Array<[RegExp, OriginId]> = [];
  for (const [pattern, name] of Object.entries(ctx.options.classification ?? {})) {
    try {
      overrides.push([new RegExp(pattern), ORIGIN_BY_NAME[name]]);
    } catch {
      ctx.warnings.push(
        `Ignored classification pattern ${pattern}: not a valid regular expression.`,
      );
    }
  }
  const origin = new Uint8Array(functions.length);
  const pkg = new Uint32Array(functions.length);
  for (let f = 0; f < functions.length; f++) {
    const name = strings[functions.name[f] ?? 0] ?? '';
    const file = strings[functions.file[f] ?? 0] ?? '';
    const pkgName = packageNameFromPath(file);
    let o: OriginId = Origin.User;
    const override = overrides.find(([re]) => re.test(file));
    if (override) o = override[1];
    else if (name === '(idle)') o = Origin.Idle;
    else if (name === '(garbage collector)') o = Origin.Gc;
    else if (name === '(program)' || name === '(root)') o = Origin.Native;
    else if (file.startsWith('node:')) o = Origin.Node;
    else if (file === '' && (functions.line[f] ?? 0) === 0) o = Origin.Native;
    else if (COLLECTOR_PATH.test(file)) o = Origin.Framework;
    else if (pkgName) o = isFramework(pkgName) ? Origin.Framework : Origin.Dependency;
    origin[f] = o;
    pkg[f] = o === Origin.Dependency || o === Origin.Framework ? ctx.strings.intern(pkgName) : 0;
  }
  return { origin, pkg };
}
