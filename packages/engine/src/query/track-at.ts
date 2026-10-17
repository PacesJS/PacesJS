import type { ExecutionModel, Track } from '../model.js';

export function trackAt(model: ExecutionModel, trackIndex: number): Track {
  const track = model.tracks[trackIndex];
  if (!track) {
    throw new Error(`No track at index ${trackIndex}; the model has ${model.tracks.length}.`);
  }
  return track;
}
