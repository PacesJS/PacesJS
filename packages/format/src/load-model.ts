import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import type { Session } from './session.js';

/** The slice of `@pacesjs/engine` the format needs; injected so the format stays engine-agnostic. */
export interface EngineApi {
  engineVersion: string;
  analyze(capture: RawCapture): ExecutionModel;
  serializeModel(model: ExecutionModel): Uint8Array;
  deserializeModel(bytes: Uint8Array): ExecutionModel;
}

export interface LoadedModel {
  model: ExecutionModel;
  fromCache: boolean;
  /** Serialized bytes to write back as the cache; present only after a rebuild. */
  modelBytes?: Uint8Array;
}

/** Cache hit: deserialize. Miss, wrong engine version or damaged cache: rebuild from the raw capture. */
export function loadModel(session: Session, engine: EngineApi): LoadedModel {
  if (session.model) {
    try {
      return { model: engine.deserializeModel(session.model), fromCache: true };
    } catch {
      // The cache is disposable; fall through to a rebuild.
    }
  }
  const model = engine.analyze(session.capture);
  return { model, fromCache: false, modelBytes: engine.serializeModel(model) };
}
