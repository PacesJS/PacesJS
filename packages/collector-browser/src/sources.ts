import type { CdpLike } from './cdp-pipe.js';
import type { ScriptRecord } from './targets.js';

export interface SourceLimits {
  perSource: number;
  perSession: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  perSource: 5 * 1024 * 1024,
  perSession: 32 * 1024 * 1024,
};

export interface CollectedSource {
  url: string;
  hash: string;
  text: string;
}

export interface SourceWarning {
  kind: string;
  count: number;
  details: string[];
}

export interface CollectedSources {
  sources: CollectedSource[];
  /** Source map JSON text by the URL of the script it belongs to. */
  sourceMaps: Record<string, string>;
  warnings: SourceWarning[];
}

const MAX_DETAILS = 20;

interface InlinePiece {
  startLine: number;
  startColumn: number;
  text: string;
}

/**
 * V8 reports positions relative to the whole document, but the debugger hands back only the text of
 * an inline script. Laying each script at its own line (and column) makes the lines in a profile
 * match the lines of the text, and joins the scripts of one page into one document.
 */
function layOut(pieces: InlinePiece[]): string {
  const lines: string[] = [];
  for (const piece of [...pieces].sort((a, b) => a.startLine - b.startLine)) {
    piece.text.split('\n').forEach((line, i) => {
      const at = piece.startLine + i;
      while (lines.length <= at) lines.push('');
      lines[at] = (i === 0 ? ' '.repeat(piece.startColumn) : '') + line;
    });
  }
  return lines.join('\n');
}

export async function collectSources(
  cdp: CdpLike,
  scripts: ScriptRecord[],
  limits: SourceLimits,
): Promise<CollectedSources> {
  const sources: CollectedSource[] = [];
  const sourceMaps: Record<string, string> = {};
  const warned = new Map<string, string[]>();
  const warn = (kind: string, detail: string): void => {
    const list = warned.get(kind) ?? [];
    list.push(detail);
    warned.set(kind, list);
  };
  const frames = new Map<string, string | undefined>();
  const frameOf = async (session: string): Promise<string | undefined> => {
    if (!frames.has(session)) {
      try {
        const tree = (await cdp.send('Page.getFrameTree', {}, session)) as {
          frameTree?: { frame?: { id?: string } };
        };
        frames.set(session, tree.frameTree?.frame?.id);
      } catch {
        frames.set(session, undefined);
      }
    }
    return frames.get(session);
  };

  const fetchMap = async (script: ScriptRecord): Promise<void> => {
    if (script.sourceMapURL === '' || script.sourceMapURL.startsWith('data:')) return;
    let url: string;
    try {
      url = new URL(script.sourceMapURL, script.url).href;
    } catch {
      warn('source-map-unreadable', script.url);
      return;
    }
    try {
      const frameId = await frameOf(script.session);
      const loaded = (await cdp.send(
        'Network.loadNetworkResource',
        {
          ...(frameId ? { frameId } : {}),
          url,
          options: { disableCache: false, includeCredentials: true },
        },
        script.session,
      )) as { resource?: { success?: boolean; stream?: string } };
      const stream = loaded.resource?.stream;
      if (!loaded.resource?.success || !stream) throw new Error('not loaded');
      let text = '';
      for (;;) {
        const chunk = (await cdp.send('IO.read', { handle: stream }, script.session)) as {
          data?: string;
          eof?: boolean;
        };
        text += chunk.data ?? '';
        if (chunk.eof) break;
      }
      await cdp.send('IO.close', { handle: stream }, script.session).catch(() => undefined);
      sourceMaps[script.url] = text;
    } catch {
      warn('source-map-unreadable', script.url);
    }
  };

  const done = new Set<string>();
  const inline = new Map<string, { source: CollectedSource; pieces: InlinePiece[] }>();
  let total = 0;
  let overBudget = false;
  for (const script of scripts) {
    const key = `${script.url}\0${script.hash}`;
    if (done.has(key)) continue;
    done.add(key);
    if (overBudget) {
      warn('sources-over-budget', script.url);
      continue;
    }
    let text: string;
    try {
      const result = (await cdp.send(
        'Debugger.getScriptSource',
        { scriptId: script.scriptId },
        script.session,
      )) as {
        scriptSource?: string;
      };
      text = result.scriptSource ?? '';
    } catch {
      continue;
    }
    if (text.length > limits.perSource) {
      warn('source-too-large', script.url);
      continue;
    }
    if (total + text.length > limits.perSession) {
      overBudget = true;
      warn('sources-over-budget', script.url);
      continue;
    }
    total += text.length;
    if ((script.startLine ?? 0) > 0 || (script.startColumn ?? 0) > 0) {
      const piece = {
        startLine: script.startLine ?? 0,
        startColumn: script.startColumn ?? 0,
        text,
      };
      const held = inline.get(script.url);
      if (held) held.pieces.push(piece);
      else {
        const source = { url: script.url, hash: script.hash, text };
        sources.push(source);
        inline.set(script.url, { source, pieces: [piece] });
      }
    } else sources.push({ url: script.url, hash: script.hash, text });
    await fetchMap(script);
  }
  for (const { source, pieces } of inline.values()) source.text = layOut(pieces);
  return {
    sources,
    sourceMaps,
    warnings: [...warned].map(([kind, details]) => ({
      kind,
      count: details.length,
      details: details.slice(0, MAX_DETAILS),
    })),
  };
}
