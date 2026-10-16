// Pass 4: mark frames that only move control around. Marked, never deleted: the UI folds them
// with the "merge plumbing" transform and always lets the user unfold.

import { Origin } from '../model.js';
import type { Classification } from './classification.js';
import type { MappedFunctions } from './source-maps.js';
import type { PassContext } from './types.js';

/** Node internals that schedule or dispatch callbacks. */
const NODE_DISPATCH_FILES = new Set([
  'node:events',
  'node:internal/process/task_queues',
  'node:internal/timers',
  'node:internal/async_hooks',
  'node:diagnostics_channel',
  'node:internal/process/promises',
]);
const NODE_DISPATCH_NAMES = new Set([
  'processTicksAndRejections',
  'runMicrotasks',
  'runMicrotask',
  'listOnTimeout',
  'processTimers',
  'processImmediate',
  'processPromiseRejections',
  'runNextTicks',
  'tickCallback',
  'callbackTrampoline',
  'PromiseReactionJob',
  'PromiseResolveThenableJob',
  'AsyncFunctionAwaitResolveClosure',
  'emitListeningNT',
]);

/** Helpers emitted inline by TypeScript, Babel and bundlers; any file. */
const HELPER_NAME =
  /^(__(awaiter|generator|extends|assign|rest|spreadArray?|read|values|asyncGenerator|asyncValues|asyncDelegator|await|decorate|param|metadata|importStar|importDefault|createBinding|setModuleDefault|exportStar|makeTemplateObject|classPrivateField(Get|Set)|async|require|esm|commonJS|toESM|toCommonJS|export|copyProps|publicField|name|webpack_require__)|_asyncToGenerator|asyncGeneratorStep|_regeneratorRuntime|regeneratorRuntime|callInvokeWithMethodAndArg|adopt|fulfilled|rejected|webpackJsonpCallback)$/;
/** Control-flow functions that are only plumbing inside these libraries' files. */
const LIBRARY_FILE = /(node_modules\/(tslib|regenerator-runtime|@babel\/runtime)\/|regenerator)/;
/** RxJS machinery passes values between operators; the user's lambdas do the work. */
const RXJS_FILE = /node_modules\/rxjs\//;

/** CommonJS module wrapper: anonymous, at the very start of the file. It is module loading, not plumbing. */
function isModuleWrapper(name: string, line: number, col: number): boolean {
  return name === '' && line <= 1 && col === 0;
}

export function detectPlumbing(
  input: { functions: MappedFunctions; classification: Classification },
  ctx: PassContext,
): Uint8Array {
  const { functions, classification } = input;
  const strings = ctx.strings.strings;
  const user: RegExp[] = [];
  for (const source of ctx.options.plumbingPatterns ?? []) {
    try {
      user.push(new RegExp(source));
    } catch {
      ctx.warnings.push(`Ignored plumbing pattern ${source}: not a valid regular expression.`);
    }
  }
  const plumbing = new Uint8Array(functions.length);
  for (let f = 0; f < functions.length; f++) {
    const name = strings[functions.name[f] ?? 0] ?? '';
    const file = strings[functions.file[f] ?? 0] ?? '';
    const origin = classification.origin[f] ?? Origin.User;
    let mark = false;
    if (origin === Origin.Node)
      mark = NODE_DISPATCH_FILES.has(file) || NODE_DISPATCH_NAMES.has(name);
    else if (origin === Origin.Native) mark = NODE_DISPATCH_NAMES.has(name);
    else if (origin === Origin.Framework && file.includes('collector-node')) mark = true;
    else if (origin !== Origin.Idle && origin !== Origin.Gc) {
      mark =
        HELPER_NAME.test(name) ||
        LIBRARY_FILE.test(file) ||
        (RXJS_FILE.test(file) &&
          !isModuleWrapper(name, functions.line[f] ?? 0, functions.col[f] ?? 0));
    }
    if (!mark && user.length > 0) {
      const subject = `${file}#${name}`;
      mark = user.some((re) => re.test(subject));
    }
    plumbing[f] = mark ? 1 : 0;
  }
  return plumbing;
}
