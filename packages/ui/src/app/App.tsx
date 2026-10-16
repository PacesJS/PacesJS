import { useEffect, useState } from 'react';
import { localClient, workerClient } from '../data/client';
import { decodeModel } from '../data/engine-bridge';
import type { QueryClient } from '../data/protocol';
import type { ModelSummary } from '../data/queries';
import type { HostAdapter } from '../host/adapter';
import { rankFindings } from '../components/Findings';
import { hashToSnapshot } from '../state/hash';
import { createState, reducer, snapshotOf } from '../state/reducer';
import { showMeAction } from '../state/showme';
import { initialSnapshot } from '../state/types';
import type { Snapshot } from '../state/types';
import { Shell } from './Shell';

interface AppProps {
  host: HostAdapter;
  /** Force the in-process query path (tests); the default uses a Web Worker when available. */
  inProcess?: boolean;
}

interface Ready {
  client: QueryClient;
  summary: ModelSummary;
  initial: Snapshot;
  sessionPath?: string;
  dismissed: string[];
  pinned: string[];
}

/** Open on the top finding; with no findings, open the flame graph. A hash in the URL wins. */
export function openingSnapshot(summary: ModelSummary, hash: string): Snapshot {
  if (hash.length > 1) return hashToSnapshot(hash);
  const base = initialSnapshot();
  const top = rankFindings(summary.findings)[0];
  if (!top) return { ...base, view: 'flame' };
  const primary = summary.tracks[0]?.id ?? 'main';
  return snapshotOf(reducer(createState(base), showMeAction(top.showMe, base, primary)));
}

async function boot(host: HostAdapter, inProcess: boolean): Promise<Ready> {
  const [session, bytes, settings] = await Promise.all([
    host.loadSession(),
    host.loadModel(),
    host.loadSettings(),
  ]);
  const baselineBytes = session.hasBaseline ? await host.loadModel('baseline') : null;
  let client: QueryClient;
  if (inProcess || typeof Worker === 'undefined') {
    client = localClient(decodeModel(bytes), baselineBytes ? decodeModel(baselineBytes) : null);
  } else {
    client = await workerClient(bytes, baselineBytes);
  }
  const summary = await client.summary();
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const pinnedSaved = strings(settings['pinnedTracks']);
  const sessionPath =
    typeof session.meta['sessionPath'] === 'string' ? session.meta['sessionPath'] : undefined;
  return {
    client,
    summary,
    initial: openingSnapshot(summary, location.hash),
    sessionPath,
    dismissed: strings(settings['dismissedHints']),
    pinned: pinnedSaved.length > 0 ? pinnedSaved : summary.tracks.slice(0, 1).map((t) => t.id),
  };
}

export function App({ host, inProcess = false }: AppProps) {
  const [state, setState] = useState<{ ready: Ready | null; error: string | null }>({
    ready: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    boot(host, inProcess).then(
      (ready) => {
        if (!cancelled) setState({ ready, error: null });
      },
      (e: unknown) => {
        if (!cancelled)
          setState({ ready: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host, inProcess]);

  if (state.error) {
    return (
      <div className="status-line" role="alert">
        <h1 className="section-title">paces could not open this session</h1>
        <p>{state.error}</p>
        <p className="muted">
          Restart paces, or reopen the session with paces open &lt;file.paces&gt;.
        </p>
      </div>
    );
  }
  if (!state.ready) {
    return (
      <div className="status-line" role="status">
        Loading profile…
      </div>
    );
  }
  const r = state.ready;
  return (
    <Shell
      host={host}
      client={r.client}
      summary={r.summary}
      initial={r.initial}
      sessionPath={r.sessionPath}
      initialDismissed={r.dismissed}
      initialPinned={r.pinned}
    />
  );
}
