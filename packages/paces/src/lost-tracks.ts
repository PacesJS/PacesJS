import { shouldProfile } from './glob.js';

export interface LostTrack {
  id: string;
  pid?: number;
  threadId?: number;
  label?: string;
  kind: 'process' | 'worker';
}

export interface RegisteredTrack {
  id: string;
  pid: number;
  threadId: number;
  argv: string[];
}

export interface LostInput {
  /** Every track that announced itself over the control socket. */
  registered: RegisteredTrack[];
  /** Tracks that wrote something (a profile or at least their info file). */
  delivered: Set<string>;
  include: string[];
  exclude: string[];
  /** False when profiling was deferred (`--start-on`) and never started: nothing could be lost. */
  started: boolean;
}

/**
 * Tracks that registered but were stopped before their `exit` handler wrote anything (killed
 * children, terminated workers). Processes the user filtered out do not count.
 */
export function detectLostTracks(input: LostInput): LostTrack[] {
  if (!input.started) return [];
  const lost: LostTrack[] = [];
  for (const r of input.registered) {
    if (input.delivered.has(r.id)) continue;
    if (!shouldProfile(r.argv, input.include, input.exclude)) continue;
    const worker = r.threadId > 0;
    lost.push({
      id: r.id,
      pid: r.pid,
      ...(worker ? { threadId: r.threadId } : {}),
      kind: worker ? 'worker' : 'process',
      label: worker ? `worker thread ${r.threadId} (pid ${r.pid})` : `process pid ${r.pid}`,
    });
  }
  return lost;
}

/** The terminal lines for a run: nothing when nothing was lost. */
export function lostTracksLines(lost: LostTrack[], total: number): string[] {
  if (lost.length === 0) return [];
  const names = lost.map((l) => l.label ?? l.id);
  const shown = names.slice(0, 5).join(', ');
  const rest = names.length > 5 ? `, and ${names.length - 5} more` : '';
  return [
    `paces: ${lost.length} of ${total} processes were stopped before they could write a profile (killed workers or children?): their time is not in this session.`,
    `  ${shown}${rest}`,
  ];
}
