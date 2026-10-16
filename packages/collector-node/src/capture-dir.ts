import type {
  CaptureMeta,
  CdpProfile,
  RawCapture,
  RawTrack,
  RuntimeEvent,
  ScriptInfo,
  TrackInfo,
} from '@pacesjs/engine';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface InfoFile {
  pid: number;
  threadId: number;
  parent?: string;
  argv: string[];
  cwd: string;
}

/** Reads a session directory written by the preload into a RawCapture. */
export function readCaptureDir(dir: string, meta: CaptureMeta): RawCapture {
  const raw = join(dir, 'raw');
  const names = existsSync(raw) ? readdirSync(raw) : [];
  const ids = [...new Set(names.map((n) => n.slice(0, n.lastIndexOf('.'))))].sort();
  const tracks: RawTrack[] = [];
  const sourceMaps: Record<string, string> = {};

  for (const id of ids) {
    const read = (ext: string): string | undefined => {
      const file = join(raw, `${id}.${ext}`);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    };
    const infoText = read('info');
    const info: InfoFile = infoText
      ? JSON.parse(infoText)
      : { pid: 0, threadId: 0, argv: [], cwd: meta.cwd };
    const isWorker = info.threadId > 0;
    const trackInfo: TrackInfo = {
      id: id,
      kind: isWorker ? 'worker' : 'process',
      label: isWorker
        ? `worker ${info.threadId} · thread ${info.threadId}`
        : `main · pid ${info.pid}`,
      pid: info.pid,
      threadId: info.threadId,
      ...(info.parent ? { parent: info.parent } : {}),
      ...(info.argv.length > 0 ? { argv: info.argv, cwd: info.cwd } : {}),
    };
    const profileText = read('cpuprofile');
    const scripts: ScriptInfo[] = JSON.parse(read('scripts') ?? '[]');
    const events: RuntimeEvent[] = (read('events') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RuntimeEvent);
    tracks.push({
      info: trackInfo,
      ...(profileText ? { cpuProfile: JSON.parse(profileText) as CdpProfile } : {}),
      scripts,
      events,
    });
    for (const s of scripts) resolveSourceMap(s, sourceMaps);
  }
  return { meta, tracks, sourceMaps };
}

function resolveSourceMap(script: ScriptInfo, out: Record<string, string>): void {
  const ref = script.sourceMapURL;
  if (!ref || ref.startsWith('data:') || out[script.url] !== undefined) return;
  try {
    const file = ref.startsWith('file:')
      ? fileURLToPath(ref)
      : isAbsolute(ref)
        ? ref
        : resolve(
            dirname(script.url.startsWith('file:') ? fileURLToPath(script.url) : script.url),
            ref,
          );
    if (existsSync(file)) out[script.url] = readFileSync(file, 'utf8');
  } catch {
    // An unreadable or malformed map degrades to generated names; the engine reports it.
  }
}
