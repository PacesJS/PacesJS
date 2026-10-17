import * as engineModule from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import type { EngineApi } from '@pacesjs/format';

declare const __ENGINE_VERSION__: string | undefined;

export type { AgentSummary } from '@pacesjs/engine';
import type { AgentSummary } from '@pacesjs/engine';

export interface Engine extends EngineApi {
  buildAgentSummary(model: ExecutionModel): AgentSummary;
}

export class EngineUnavailableError extends Error {
  constructor(missing: string[]) {
    super(
      `The analysis engine in this build is missing: ${missing.join(', ')}. Reinstall paces or rebuild with pnpm build.`,
    );
    this.name = 'EngineUnavailableError';
  }
}

const NAMES = ['analyze', 'serializeModel', 'deserializeModel', 'buildAgentSummary'] as const;

/** Binds the engine's public functions; fails with an actionable error instead of `undefined is not a function`. */
export function loadEngine(
  mod: Record<string, unknown> = engineModule as Record<string, unknown>,
): Engine {
  const missing = NAMES.filter((n) => typeof mod[n] !== 'function');
  if (missing.length > 0) throw new EngineUnavailableError([...missing]);
  const version =
    typeof mod.ENGINE_VERSION === 'string'
      ? mod.ENGINE_VERSION
      : typeof __ENGINE_VERSION__ === 'string'
        ? __ENGINE_VERSION__
        : '0.0.0';
  const fn = <T>(name: string): T => mod[name] as T;
  return {
    engineVersion: version,
    analyze: (capture: RawCapture, options?: Record<string, unknown>) =>
      fn<(c: RawCapture, o?: Record<string, unknown>) => ExecutionModel>('analyze')(
        capture,
        options,
      ),
    serializeModel: (m) => fn<(m: ExecutionModel) => Uint8Array>('serializeModel')(m),
    ensureCaptureWarnings: (m, meta) =>
      typeof mod.ensureCaptureWarnings === 'function'
        ? fn<(m: ExecutionModel, meta: unknown) => ExecutionModel>('ensureCaptureWarnings')(m, meta)
        : m,
    deserializeModel: (b) => fn<(b: Uint8Array) => ExecutionModel>('deserializeModel')(b),
    buildAgentSummary: (m) => fn<(m: ExecutionModel) => AgentSummary>('buildAgentSummary')(m),
  };
}
