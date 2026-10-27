// Network requests from a browser trace: the send, the response and the finish of each request are
// joined by request id. Only the fields named below are read, so response headers (cookies among
// them) never reach a capture.

import type { RawRequest, RawRequestInitiator } from '../raw.js';
import type { TraceEventIn } from './types.js';

export interface RequestCollector {
  add(e: TraceEventIn): void;
  /** Requests that were sent, in the order they were sent. */
  done(): RawRequest[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** The browser types a `fetch()` or XHR as `Other`; the initiator says which it was. */
function typeOf(data: Record<string, unknown>): string {
  const initiator = data.initiator as { fetchType?: unknown } | undefined;
  const fetchType = str(initiator?.fetchType);
  if (fetchType === 'fetch') return 'Fetch';
  if (fetchType === 'xmlhttprequest') return 'XHR';
  return str(data.resourceType) ?? 'Other';
}

/** Only requests sent from running script carry a stack; the innermost frame is who asked. */
function initiatorOf(data: Record<string, unknown>): RawRequestInitiator | undefined {
  const kind = str((data.initiator as { type?: unknown } | undefined)?.type);
  const top = Array.isArray(data.stackTrace)
    ? (data.stackTrace[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!kind || kind === 'other' || !top) return undefined;
  const fn = str(top.functionName);
  const script = str(top.url);
  const line = num(top.lineNumber);
  const column = num(top.columnNumber);
  return {
    kind,
    ...(fn ? { fn } : {}),
    ...(script ? { script } : {}),
    ...(line !== undefined ? { line: line + 1 } : {}),
    ...(column !== undefined ? { column: column + 1 } : {}),
  };
}

export function createRequestCollector(): RequestCollector {
  const byId = new Map<string, RawRequest>();
  // A response or finish can be seen before its send when the trace was cut in the middle.
  const early = new Map<string, TraceEventIn[]>();

  const apply = (r: RawRequest, e: TraceEventIn, data: Record<string, unknown>): void => {
    if (e.name === 'ResourceReceiveResponse') {
      r.responseUs = e.ts;
      const status = num(data.statusCode);
      const mime = str(data.mimeType);
      const protocol = str(data.protocol);
      if (status !== undefined) r.status = status;
      if (mime) r.mime = mime;
      if (protocol) r.protocol = protocol;
      r.fromCache = data.fromCache === true || data.fromServiceWorker === true;
    } else {
      r.endUs = e.ts;
      r.failed = data.didFail === true;
      const encoded = num(data.encodedDataLength);
      const decoded = num(data.decodedBodyLength);
      if (encoded !== undefined) r.encodedBytes = encoded;
      if (decoded !== undefined) r.decodedBytes = decoded;
    }
  };

  return {
    add(e) {
      const data = (e.args as { data?: Record<string, unknown> } | undefined)?.data;
      const id = str(data?.requestId);
      if (!data || !id) return;
      if (e.name === 'ResourceSendRequest') {
        const url = str(data.url);
        if (!url || byId.has(id)) return;
        const frame = str(data.frame);
        const initiator = initiatorOf(data);
        const r: RawRequest = {
          id,
          pid: e.pid,
          url,
          type: typeOf(data),
          priority: str(data.priority) ?? '',
          renderBlocking: data.renderBlocking === 'blocking',
          startUs: e.ts,
          fromCache: false,
          failed: false,
          ...(frame ? { frame } : {}),
          ...(initiator ? { initiator } : {}),
        };
        byId.set(id, r);
        for (const later of early.get(id) ?? []) {
          apply(r, later, (later.args as { data: Record<string, unknown> }).data);
        }
        early.delete(id);
      } else if (e.name === 'ResourceReceiveResponse' || e.name === 'ResourceFinish') {
        const r = byId.get(id);
        if (r) apply(r, e, data);
        else early.set(id, [...(early.get(id) ?? []), e]);
      }
    },
    done: () => [...byId.values()].sort((a, b) => a.startUs - b.startUs),
  };
}
