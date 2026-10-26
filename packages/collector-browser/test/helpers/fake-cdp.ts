import type { CdpEvent, CdpLike } from '../../src/cdp-pipe.js';
import type { TraceEvent } from '../../src/trace.js';

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | undefined;
}

/**
 * A stand-in for the browser end of the CDP pipe. `Tracing.end` answers the way Chromium does: the
 * queued trace events arrive as `dataCollected`, then `tracingComplete`.
 */
export class FakeCdp implements CdpLike {
  readonly calls: FakeCall[] = [];
  readonly closed: Promise<void>;
  /** Trace events (and the screenshots among them) the next `Tracing.end` will deliver. */
  nextTrace: TraceEvent[] = [];
  /** Replies by method; anything else resolves with `{}`. */
  replies: Record<string, unknown> = {};
  private handlers: Array<(event: CdpEvent) => void> = [];
  private markClosed: () => void = () => {};

  constructor() {
    this.closed = new Promise<void>((resolve) => {
      this.markClosed = resolve;
    });
  }

  onEvent(handler: (event: CdpEvent) => void): void {
    this.handlers.push(handler);
  }

  emit(event: CdpEvent): void {
    for (const h of this.handlers) h(event);
  }

  close(): void {
    this.markClosed();
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params: params as Record<string, unknown>, sessionId });
    if (method === 'Tracing.end') {
      const events = this.nextTrace;
      this.nextTrace = [];
      queueMicrotask(() => {
        this.emit({ method: 'Tracing.dataCollected', params: { value: events }, sessionId });
        this.emit({ method: 'Tracing.tracingComplete', params: {}, sessionId });
      });
    }
    return Promise.resolve(this.replies[method] ?? {});
  }
}
