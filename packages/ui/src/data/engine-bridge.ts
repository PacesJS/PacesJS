import * as engine from '@pacesjs/engine';
import type { ExecutionModel } from '@pacesjs/engine';
import { decodeDevModel, isDevModel } from './dev-codec';

interface EngineApi {
  deserializeModel?: (bytes: Uint8Array) => ExecutionModel;
}

/** Decode the host's binary model with the engine. Runs inside the worker. */
export function decodeModel(bytes: Uint8Array): ExecutionModel {
  if (isDevModel(bytes)) return decodeDevModel(bytes);
  const fn = (engine as unknown as EngineApi)['deserializeModel'];
  if (!fn) {
    throw new Error(
      'The installed @pacesjs/engine does not export deserializeModel; rebuild the workspace packages.',
    );
  }
  return fn(bytes);
}
