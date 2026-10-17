import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionModel } from '@pacesjs/engine';
import { loadModel, readSession, writeSession } from '@pacesjs/format';
import type { Session } from '@pacesjs/format';
import type { Flags, Parsed } from './args.js';
import { USAGE, UsageError, parseArgs } from './args.js';
import type { Engine } from './engine.js';
import { loadEngine } from './engine.js';
import { importProfile } from './import-profile.js';
import {
  appModeArgs,
  findBrowser,
  isHeadless,
  killTree,
  osOpen,
  planEditorOpen,
  removeQuietly,
  run,
} from './launch.js';
import { waitForWindowClose } from './lifecycle.js';
import { serveMcp } from './mcp.js';
import { buildTools } from './mcp-tools.js';
import { lostTracksLines } from './lost-tracks.js';
import { NoProcessesError, preloadPath, runProfile } from './profile.js';
import { startHost } from './server.js';
import type { HostSession } from './server.js';
import {
  collectSources,
  defaultSessionPath,
  findProjectRoot,
  writeSessionFile,
} from './session-files.js';
import { configDir } from './settings.js';
import { formatSummary } from './summary.js';
import { GUIDE } from './guide.js';
import { ReportError, renderReport } from './report/report.js';
import { createSourceResolver } from './source-resolver.js';

declare const __PACES_VERSION__: string | undefined;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const consoleIo: Io = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
};

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

function uiDir(): string | undefined {
  const bundled = join(here, 'ui');
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  try {
    const pkg = dirname(requireFromHere.resolve('@pacesjs/ui/package.json'));
    const dist = join(pkg, 'dist');
    return existsSync(join(dist, 'index.html')) ? dist : undefined;
  } catch {
    return undefined;
  }
}

function resolvePreload(): string {
  return preloadPath(import.meta.url, () =>
    requireFromHere.resolve('@pacesjs/collector-node/preload.cjs'),
  );
}

function readSessionFile(file: string, engineVersion?: string): Session {
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  return readSession(
    new Uint8Array(readFileSync(file)),
    engineVersion !== undefined ? { engineVersion } : {},
  );
}

/** Counts of warnings by code (structured warnings) or as plain messages (older engines). */
export function summarizeWarnings(warnings: unknown): {
  total: number;
  byCode: Record<string, number>;
} {
  const byCode: Record<string, number> = {};
  const list = Array.isArray(warnings) ? warnings : [];
  for (const w of list) {
    const code =
      w && typeof w === 'object' && typeof (w as { code?: unknown }).code === 'string'
        ? (w as { code: string }).code
        : 'warning';
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return { total: list.length, byCode };
}

function toHostSession(
  file: string,
  session: Session,
  model: ExecutionModel,
  engine: Engine,
): HostSession {
  const embedded = new Map<string, Uint8Array>();
  for (const s of session.manifest.sources) {
    const bytes = session.sources[s.hash];
    if (bytes) embedded.set(s.path, bytes);
  }
  const scriptUrls = new Set<string>();
  for (const t of session.capture.tracks) for (const sc of t.scripts) scriptUrls.add(sc.url);
  const m = model as unknown as {
    target?: unknown;
    primaryTrack?: unknown;
    meta?: { warnings?: unknown };
  };
  return {
    file,
    manifest: session.manifest,
    modelBytes: engine.serializeModel(model),
    embedded,
    scriptUrls: [...scriptUrls],
    sourceMaps: session.capture.sourceMaps,
    info: {
      target: m.target ?? null,
      primaryTrack: m.primaryTrack ?? null,
      warningsSummary: summarizeWarnings(m.meta?.warnings),
    },
  };
}

/** Starts the server, opens the window and waits until it closes (or Ctrl+C). */
async function present(session: HostSession, flags: Flags, io: Io): Promise<void> {
  const host = await startHost({
    session,
    configDir: configDir(),
    ...(uiDir() ? { uiDir: uiDir() as string } : {}),
    openInEditor: (file, line) => run(planEditorOpen(file, line)),
  });
  let browser: ChildProcess | undefined;
  let profileDir: string | undefined;
  let browserExited: Promise<void> | undefined;

  const exe = flags.noOpen || isHeadless() ? undefined : findBrowser();
  if (flags.noOpen || isHeadless()) {
    io.err(`paces: open this URL in your browser: ${host.url}`);
  } else if (exe) {
    profileDir = mkdtempSync(join(tmpdir(), 'paces-browser-'));
    browser = spawn(exe, appModeArgs(host.url, profileDir), {
      stdio: 'ignore',
      windowsHide: false,
    });
    browserExited = new Promise<void>((r) => {
      browser?.once('exit', () => r());
      browser?.once('error', () => r());
    });
    io.err(`paces: opened a window. UI at ${host.url}`);
  } else {
    run(osOpen(host.url));
    io.err(`paces: no Edge or Chrome found; opened your default browser. UI at ${host.url}`);
  }

  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once('SIGINT', onSigint);
  const grace = Number(process.env.PACES_GRACE_MS) || 10_000;
  const stale = Number(process.env.PACES_STALE_HEARTBEAT_MS) || undefined;
  await waitForWindowClose(host, {
    graceMs: grace,
    ...(stale ? { staleHeartbeatMs: stale } : {}),
    ...(browserExited ? { browserExited } : {}),
    signal: abort.signal,
  });
  process.off('SIGINT', onSigint);
  await host.close();
  if (browser && browser.exitCode === null) killTree(browser);
  if (profileDir) removeQuietly(profileDir);
}

function engineOrExplain(io: Io): Engine | undefined {
  try {
    return loadEngine();
  } catch (e) {
    io.err(`paces: ${(e as Error).message}`);
    return undefined;
  }
}

async function cmdProfile(p: Extract<Parsed, { kind: 'profile' }>, io: Io): Promise<number> {
  const cwd = process.cwd();
  io.err(`paces: profiling \`${p.command.join(' ')}\``);
  const result = await runProfile({
    command: p.command,
    flags: p.flags,
    cwd,
    preload: resolvePreload(),
    projectRoot: findProjectRoot(cwd),
    log: (l) => io.err(l),
  });
  const { capture } = result;
  const out = resolve(cwd, p.flags.out ?? defaultSessionPath(cwd));
  const engine = engineOrExplain(io);
  const engineVersion = engine?.engineVersion ?? '0.0.0';
  const sources = p.flags.embedSources ? collectSources(capture) : [];

  // The raw capture is the source of truth: persist it before any analysis can fail.
  writeSessionFile(out, writeSession(capture, { engineVersion, sources }));
  const tracks = capture.tracks.length;
  io.err(`paces: ${tracks} track${tracks === 1 ? '' : 's'} captured, session saved to ${out}`);
  const lost = capture.meta.lostTracks ?? [];
  for (const line of lostTracksLines(lost, tracks + lost.length)) io.err(line);

  let model: ExecutionModel | undefined;
  if (engine) {
    try {
      model = engine.analyze(capture, analyzeOptions(p.flags));
      const bytes = engine.serializeModel(model);
      writeSessionFile(out, writeSession(capture, { engineVersion, sources, model: bytes }));
      io.err(`paces: ${model.findings.length} finding${model.findings.length === 1 ? '' : 's'}`);
    } catch (e) {
      io.err(
        `paces: analysis failed (${(e as Error).message}). The raw session is saved; reopen it after updating paces.`,
      );
    }
  }

  if (model && engine && p.flags.report.runMode) {
    const session = readSessionFile(out, engineVersion);
    printReport(model, session, displayPath(out, cwd), p.flags, io);
    await result.child?.stop();
    return result.exitCode;
  }
  if (model && engine) {
    const session = readSessionFile(out, engineVersion);
    await present(toHostSession(out, session, model, engine), p.flags, io);
  }
  await result.child?.stop();
  return result.exitCode;
}

function analyzeOptions(flags: Flags): Record<string, unknown> | undefined {
  return flags.focus.length > 0 ? { focus: flags.focus } : undefined;
}

function displayPath(file: string, cwd: string): string {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
}

function colorEnabled(flags: Flags): boolean {
  return Boolean(process.stdout.isTTY) && !flags.report.noColor && !process.env.NO_COLOR;
}

function resolverFor(session: Session) {
  const embedded = new Map<string, Uint8Array>();
  for (const s of session.manifest.sources) {
    const bytes = session.sources[s.hash];
    if (bytes) embedded.set(s.path, bytes);
  }
  const scriptUrls = new Set<string>();
  for (const t of session.capture.tracks) for (const sc of t.scripts) scriptUrls.add(sc.url);
  return createSourceResolver({
    projectRoot: session.manifest.projectRoot,
    scriptUrls,
    sourceMaps: session.capture.sourceMaps,
    embedded,
    startedAt: session.manifest.startedAt,
  });
}

/** Prints one report view; returns false when the request was invalid (message goes to stderr). */
function printReport(
  model: ExecutionModel,
  session: Session | undefined,
  file: string,
  flags: Flags,
  io: Io,
): boolean {
  try {
    const out = renderReport(
      {
        model,
        file,
        ...(session ? { resolver: resolverFor(session) } : {}),
        color: colorEnabled(flags) && !flags.json,
      },
      flags,
    );
    io.out(flags.json ? JSON.stringify(out.json, null, 2) : out.text);
    return true;
  } catch (e) {
    if (e instanceof ReportError) {
      io.err(`paces: ${e.message}`);
      return false;
    }
    throw e;
  }
}

function cmdReport(file: string, flags: Flags, io: Io): number {
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  const engine = loadEngine();
  if (/\.(cpuprofile|json)$/i.test(file)) {
    const capture = importProfile(readFileSync(file, 'utf8'), {
      name: basename(file),
      cwd: process.cwd(),
      mtimeMs: statSync(file).mtimeMs,
    });
    const model = engine.analyze(capture, analyzeOptions(flags));
    return printReport(model, undefined, file, flags, io) ? 0 : 1;
  }
  const { session, model } = modelOf(file, engine, flags);
  return printReport(model, session, file, flags, io) ? 0 : 1;
}

function modelOf(
  file: string,
  engine: Engine,
  flags?: Flags,
): { session: Session; model: ExecutionModel } {
  const session = readSessionFile(file, engine.engineVersion);
  const options = flags ? analyzeOptions(flags) : undefined;
  return { session, model: loadModel(session, engine, options).model };
}

async function cmdOpen(file: string, flags: Flags, io: Io): Promise<number> {
  const engine = loadEngine();
  const { session, model } = modelOf(file, engine, flags);
  await present(toHostSession(resolve(file), session, model, engine), flags, io);
  return 0;
}

async function cmdDiff(a: string, b: string, flags: Flags, io: Io): Promise<number> {
  const engine = loadEngine();
  const base = modelOf(a, engine);
  const head = modelOf(b, engine);
  const session = toHostSession(resolve(b), head.session, head.model, engine);
  session.baseline = {
    file: resolve(a),
    manifest: base.session.manifest,
    modelBytes: engine.serializeModel(base.model),
  };
  await present(session, flags, io);
  return 0;
}

async function cmdImport(file: string, flags: Flags, io: Io): Promise<number> {
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  const cwd = process.cwd();
  const capture = importProfile(readFileSync(file, 'utf8'), {
    name: basename(file),
    cwd,
    mtimeMs: statSync(file).mtimeMs,
  });
  const engine = loadEngine();
  const out = resolve(cwd, flags.out ?? defaultSessionPath(cwd, new Date(), existsSync, '-import'));
  const model = engine.analyze(capture, analyzeOptions(flags));
  const bytes = writeSession(capture, {
    engineVersion: engine.engineVersion,
    model: engine.serializeModel(model),
  });
  writeSessionFile(out, bytes);
  io.err(`paces: imported ${file}, session saved to ${out}`);
  const session = readSession(bytes, { engineVersion: engine.engineVersion });
  await present(toHostSession(out, session, model, engine), flags, io);
  return 0;
}

function cmdSummary(file: string, flags: Flags, io: Io): number {
  const engine = loadEngine();
  const { session, model } = modelOf(file, engine, flags);
  const summary = engine.buildAgentSummary(model);
  if (flags.json) io.out(JSON.stringify(summary, null, 2));
  else io.out(formatSummary(summary, `${session.manifest.command.join(' ')}  (${basename(file)})`));
  return 0;
}

async function cmdMcp(file: string, flags: Flags): Promise<number> {
  const engine = loadEngine();
  const { model } = modelOf(file, engine, flags);
  const summary = engine.buildAgentSummary(model);
  await serveMcp(
    process.stdin,
    process.stdout,
    buildTools(model, () => summary),
  );
  return 0;
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`paces: ${e.message}`);
      return 2;
    }
    throw e;
  }
  try {
    switch (parsed.kind) {
      case 'help':
        io.out(USAGE);
        return 0;
      case 'version':
        io.out(typeof __PACES_VERSION__ === 'string' ? __PACES_VERSION__ : '0.0.0');
        return 0;
      case 'profile':
        return await cmdProfile(parsed, io);
      case 'open':
        return await cmdOpen(parsed.files[0], parsed.flags, io);
      case 'diff':
        return await cmdDiff(parsed.files[0], parsed.files[1], parsed.flags, io);
      case 'import':
        return await cmdImport(parsed.files[0], parsed.flags, io);
      case 'summary':
        return cmdSummary(parsed.files[0], parsed.flags, io);
      case 'mcp':
        return await cmdMcp(parsed.files[0], parsed.flags);
      case 'report':
        return cmdReport(parsed.files[0], parsed.flags, io);
      case 'guide':
        io.out(GUIDE);
        return 0;
    }
  } catch (e) {
    io.err(`paces: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof NoProcessesError && e.exitCode !== 0) return e.exitCode;
    return e instanceof UsageError ? 2 : 1;
  }
}
