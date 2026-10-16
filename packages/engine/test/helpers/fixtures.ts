import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { FIXTURES, loadCapture } from './capture.js';
import type { FixtureName } from './capture.js';

export { FIXTURES, loadCapture };
export type { FixtureName };

const models = new Map<string, ExecutionModel>();

export function loadModel(name: FixtureName): ExecutionModel {
  const cached = models.get(name);
  if (cached) return cached;
  const model = analyze(loadCapture(name));
  models.set(name, model);
  return model;
}
