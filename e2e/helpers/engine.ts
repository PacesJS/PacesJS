import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './cli.js';

/** True once the built engine exposes everything the CLI pipeline needs. */
export async function engineReady(): Promise<boolean> {
  try {
    const mod = (await import(
      pathToFileURL(join(ROOT, 'packages', 'engine', 'dist', 'index.js')).href
    )) as Record<string, unknown>;
    return ['analyze', 'serializeModel', 'deserializeModel', 'buildAgentSummary'].every(
      (n) => typeof mod[n] === 'function',
    );
  } catch {
    return false;
  }
}
