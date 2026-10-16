// Pass 4b: fold module loading. CommonJS and ESM loader frames are plumbing, and the top-level
// function of each loaded file is renamed `require ▸ <path>`, so a chain of nested requires reads as
// one row per module with its load time. Children stay expandable: nothing is removed.

import { Origin } from '../model.js';
import { displayPath } from '../util/paths.js';
import type { Classification } from './classification.js';
import type { MappedFunctions } from './source-maps.js';
import type { PassContext } from './types.js';

const LOADER_FILE = /^node:internal\/(modules\/|main\/run_main)/;
const LOADER_NAMES = new Set([
  'Module._load',
  'Module.require',
  'Module._compile',
  'Module._extensions..js',
  'Module._extensions..cjs',
  'Module._extensions..json',
  'Module._resolveFilename',
  'Module.load',
  'wrapModuleLoad',
  'wrapSafe',
  'compileFunction',
  'compileSourceTextModule',
  'require',
]);

/** A loaded file's top-level function: anonymous and at the very start of the file. */
function isModuleTopLevel(name: string, line: number, col: number): boolean {
  return name === '' && line <= 1 && col === 0;
}

export interface ModuleLoadingResult {
  /** 1 = loader frame or module top-level function. */
  loader: Uint8Array;
}

/** Marks loader frames as plumbing (in place) and renames module top-level functions (in place). */
export function foldModuleLoading(
  input: { functions: MappedFunctions; classification: Classification; plumbing: Uint8Array },
  ctx: PassContext,
): ModuleLoadingResult {
  const { functions, classification, plumbing } = input;
  const strings = ctx.strings.strings;
  const loader = new Uint8Array(functions.length);
  for (let f = 0; f < functions.length; f++) {
    const name = strings[functions.name[f] ?? 0] ?? '';
    const file = strings[functions.file[f] ?? 0] ?? '';
    const origin = classification.origin[f] ?? Origin.User;
    if (origin === Origin.Node || origin === Origin.Native) {
      const isLoader =
        LOADER_FILE.test(file) ||
        ((file.startsWith('node:') || origin === Origin.Native) && LOADER_NAMES.has(name));
      if (isLoader) {
        loader[f] = 1;
        plumbing[f] = 1;
      }
      continue;
    }
    if (origin === Origin.Idle || origin === Origin.Gc) continue;
    if (!isModuleTopLevel(name, functions.line[f] ?? 0, functions.col[f] ?? 0)) continue;
    loader[f] = 1;
    const verb = /\.m[jt]s$/.test(file) ? 'import' : 'require';
    functions.name[f] = ctx.strings.intern(`${verb} ▸ ${displayPath(file)}`);
  }
  return { loader };
}
