import type { CdpEvent, CdpLike } from './cdp-pipe.js';
import { BRIDGE_NAME, INSTRUMENTATION_URL } from './inject/entry.js';
import { scrubUrl } from './trace-filter.js';

export interface ScriptRecord {
  scriptId: string;
  url: string;
  sourceMapURL: string;
  hash: string;
  /** CDP session that parsed it: where its source can be read from. */
  session: string;
  /** Kind of target that parsed it (`page`, `iframe`, `worker`...) and its id, when known. For pages and out-of-process iframes the id is also the frame id. */
  targetType?: string;
  targetId?: string;
}

export interface TargetManagerDeps {
  cdp: CdpLike;
  injectSource: string;
  keepQuery: boolean;
  onBridge: (message: unknown, session: string) => void;
}

export interface TargetManager {
  /** Sets a session up: runtime, binding, injected script, debugger and auto-attach. */
  configure(session: string, type: string, waiting: boolean, targetId?: string): Promise<void>;
  scripts(): ScriptRecord[];
  /** Resolves once every target seen so far has been configured. */
  idle(): Promise<void>;
}

const WORKER_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);
const FRAME_TYPES = new Set(['page', 'iframe']);

export function createTargetManager(deps: TargetManagerDeps): TargetManager {
  const { cdp } = deps;
  const parsed: ScriptRecord[] = [];
  const seen = new Set<string>();
  const pending = new Set<Promise<void>>();
  const targets = new Map<string, { type: string; targetId?: string }>();

  // A target can vanish while it is configured; the only thing that matters then is not to hang.
  const attempt = async (method: string, params: object, session: string): Promise<void> => {
    try {
      await cdp.send(method, params, session);
    } catch {
      // Detached or closed.
    }
  };

  async function configure(
    session: string,
    type: string,
    waiting: boolean,
    targetId?: string,
  ): Promise<void> {
    targets.set(session, { type, ...(targetId ? { targetId } : {}) });
    const isFrame = FRAME_TYPES.has(type);
    if (isFrame || WORKER_TYPES.has(type)) {
      await attempt('Runtime.enable', {}, session);
      if (isFrame) {
        await attempt('Runtime.addBinding', { name: BRIDGE_NAME }, session);
        await attempt('Page.enable', {}, session);
        await attempt(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: deps.injectSource, runImmediately: true },
          session,
        );
      }
      await attempt('Debugger.enable', {}, session);
      await attempt(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        session,
      );
    }
    if (waiting) await attempt('Runtime.runIfWaitingForDebugger', {}, session);
  }

  cdp.onEvent((e: CdpEvent) => {
    const params = (e.params ?? {}) as Record<string, unknown>;
    if (e.method === 'Target.attachedToTarget') {
      const info = (params.targetInfo ?? {}) as { type?: string; targetId?: string };
      const task = configure(
        String(params.sessionId),
        info.type ?? 'other',
        params.waitingForDebugger === true,
        info.targetId,
      ).finally(() => pending.delete(task));
      pending.add(task);
    } else if (e.method === 'Debugger.scriptParsed' && e.sessionId) {
      const url = String(params.url ?? '');
      if (url === '' || url === INSTRUMENTATION_URL) return;
      const key = `${e.sessionId}:${String(params.scriptId)}`;
      if (seen.has(key)) return;
      seen.add(key);
      parsed.push({
        scriptId: String(params.scriptId),
        url: deps.keepQuery ? url : scrubUrl(url),
        sourceMapURL: String(params.sourceMapURL ?? ''),
        hash: String(params.hash ?? ''),
        session: e.sessionId,
        ...(targets.get(e.sessionId)
          ? {
              targetType: targets.get(e.sessionId)?.type,
              ...(targets.get(e.sessionId)?.targetId
                ? { targetId: targets.get(e.sessionId)?.targetId }
                : {}),
            }
          : {}),
      });
    } else if (e.method === 'Runtime.bindingCalled' && params.name === BRIDGE_NAME) {
      try {
        deps.onBridge(JSON.parse(String(params.payload)), e.sessionId ?? '');
      } catch {
        // A page that calls the binding with garbage is not ours to answer.
      }
    }
  });

  return {
    configure,
    scripts: () => parsed,
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
