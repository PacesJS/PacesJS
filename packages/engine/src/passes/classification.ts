// Pass 3: tag each function's origin. Rules are URL patterns plus the caller's override map.

import type { OriginName } from '../config.js';
import { Origin } from '../model.js';
import type { OriginId } from '../model.js';
import { isPacesInstrumentation, packageNameFromPath } from '../util/paths.js';
import { hostOfUrl, isFirstParty } from '../util/sites.js';
import type { MappedFunctions } from './source-maps.js';
import type { ClassifiedFunction, FrameFacts, PassContext, TargetSpec } from './types.js';

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

/** The program being profiled counts as first-party even when it lives in node_modules. */
function isTarget(target: TargetSpec | undefined, pkgName: string, file: string): boolean {
  if (!target) return false;
  if (pkgName !== '' && target.packages.has(pkgName)) return true;
  return target.globs.some((re) => re.test(file));
}

function isFramework(pkg: string): boolean {
  return FRAMEWORK_PACKAGES.has(pkg) || FRAMEWORK_SCOPES.some((s) => pkg.startsWith(s));
}

/** A Node function: runtime names first, then the target's own files, then packages by name. */
export function classifyNodeFunction(
  { name, file, line }: FrameFacts,
  target: TargetSpec | undefined,
  forced: OriginId | undefined,
): ClassifiedFunction {
  const pkgName = packageNameFromPath(file);
  let origin: OriginId = Origin.User;
  let inTarget = false;
  if (forced !== undefined) origin = forced;
  else if (name === '(idle)') origin = Origin.Idle;
  else if (name === '(garbage collector)') origin = Origin.Gc;
  else if (name === '(program)' || name === '(root)') origin = Origin.Native;
  else if (file.startsWith('node:')) origin = Origin.Node;
  else if (file === '' && line === 0) origin = Origin.Native;
  else if (isPacesInstrumentation(file)) origin = Origin.Node;
  else if (isTarget(target, pkgName, file)) {
    origin = Origin.User;
    inTarget = true;
  } else if (pkgName) origin = isFramework(pkgName) ? Origin.Framework : Origin.Dependency;
  // The target package keeps its name so views can still show where its functions live.
  const named = origin === Origin.Dependency || origin === Origin.Framework || inTarget;
  return { origin, pkg: named ? pkgName : '' };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/; //i;

/**
 * A browser function: first-party code is what the launched site (or the site that serves its app)
 * delivered; another site's script is a dependency named for its host; an extension is a dependency
 * named `extension:<id>`; a built-in has no script. A source-mapped path with no origin left cannot
 * be told apart, so it stays the program's, unless it lives in node_modules.
 */
export function classifyBrowserFunction(
  { name, file }: FrameFacts,
  target: TargetSpec | undefined,
  forced: OriginId | undefined,
): ClassifiedFunction {
  if (forced !== undefined) return { origin: forced, pkg: '' };
  const site = target?.browser;
  const pkgName = packageNameFromPath(file);
  if (name === '(idle)') return { origin: Origin.Idle, pkg: '' };
  if (name === '(garbage collector)') return { origin: Origin.Gc, pkg: '' };
  if (name === '(program)' || name === '(root)') return { origin: Origin.Native, pkg: '' };
  if (isPacesInstrumentation(file)) return { origin: Origin.Node, pkg: '' };
  if (file === '') return { origin: Origin.Native, pkg: '' };
  if (pkgName) {
    return { origin: isFramework(pkgName) ? Origin.Framework : Origin.Dependency, pkg: pkgName };
  }
  if (file.startsWith('chrome-extension://')) {
    return { origin: Origin.Dependency, pkg: `extension:${hostOfUrl(file)}` };
  }
  if (!SCHEME.test(file)) return { origin: Origin.User, pkg: '' };
  if (site && isFirstParty(file, site.launchedUrl, site.firstParty, site.appSites)) {
    return { origin: Origin.User, pkg: '' };
  }
  return { origin: Origin.Dependency, pkg: hostOfUrl(file) };
}

export function classify(functions: MappedFunctions, ctx: PassContext): Classification {
  const strings = ctx.strings.strings;
  const overrides: Array<[RegExp, OriginId]> = [];
  for (const [pattern, name] of Object.entries(ctx.options.classification ?? {})) {
    try {
      overrides.push([new RegExp(pattern), ORIGIN_BY_NAME[name]]);
    } catch {
      ctx.warnings.push({ kind: 'invalid-pattern', severity: 'warn', detail: pattern });
    }
  }
  const origin = new Uint8Array(functions.length);
  const pkg = new Uint32Array(functions.length);
  for (let f = 0; f < functions.length; f++) {
    const frame: FrameFacts = {
      name: strings[functions.name[f] ?? 0] ?? '',
      file: strings[functions.file[f] ?? 0] ?? '',
      line: functions.line[f] ?? 0,
    };
    const forced = overrides.find(([re]) => re.test(frame.file))?.[1];
    const verdict = ctx.run.classifyFunction(frame, ctx.target, forced);
    origin[f] = verdict.origin;
    pkg[f] = ctx.strings.intern(verdict.pkg);
  }
  return { origin, pkg };
}
