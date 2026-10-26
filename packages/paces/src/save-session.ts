import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import { writeSession } from '@pacesjs/format';
import type { Engine } from './engine.js';
import { lostTracksLines } from './lost-tracks.js';
import { collectSources, writeSessionFile } from './session-files.js';

export interface SaveOptions {
  /** Where the session goes. */
  out: string;
  engine: Engine | undefined;
  focus: string[];
  embedSources: boolean;
  log: (line: string) => void;
}

/**
 * Persists a capture and analyzes it. The raw capture is the source of truth, so it is written
 * before any analysis can fail; the model is added to the file afterwards. Returns the model, or
 * undefined when the engine is missing or the analysis failed (both are logged).
 */
export function saveSession(capture: RawCapture, o: SaveOptions): ExecutionModel | undefined {
  const engineVersion = o.engine?.engineVersion ?? '0.0.0';
  const sources = o.embedSources ? collectSources(capture) : [];
  writeSessionFile(o.out, writeSession(capture, { engineVersion, sources }));
  const tracks = capture.tracks.length;
  o.log(`paces: ${tracks} track${tracks === 1 ? '' : 's'} captured, session saved to ${o.out}`);
  const lost = capture.meta.lostTracks ?? [];
  for (const line of lostTracksLines(lost, tracks + lost.length)) o.log(line);
  if (!o.engine) return undefined;
  try {
    const model = o.engine.analyze(capture, o.focus.length > 0 ? { focus: o.focus } : undefined);
    const bytes = o.engine.serializeModel(model);
    writeSessionFile(o.out, writeSession(capture, { engineVersion, sources, model: bytes }));
    o.log(`paces: ${model.findings.length} finding${model.findings.length === 1 ? '' : 's'}`);
    return model;
  } catch (e) {
    o.log(
      `paces: analysis failed (${(e as Error).message}). The raw session is saved; reopen it after updating paces.`,
    );
    return undefined;
  }
}
