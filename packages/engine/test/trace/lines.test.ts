import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';

interface WithSources {
  sources: Array<{ url: string; text: string }>;
}

function slowClick() {
  const input = cloneInput('slow-click');
  const capture = recordingToCapture(input);
  const profile = capture.tracks[0]?.cpuProfile;
  const busy = profile?.nodes.find((n) => n.callFrame.functionName === 'busy');
  const text =
    (input as unknown as WithSources).sources.find((s) => s.url.endsWith('/slow-click.html'))
      ?.text ?? '';
  return { capture, profile, busy, text };
}

describe('lines of a browser profile', () => {
  it('gives a function the source lines its samples landed on', () => {
    const { busy } = slowClick();
    expect(busy?.positionTicks?.length).toBeGreaterThan(0);
  });

  it('puts most of the time of the busy loop on the line of the loop', () => {
    const { busy, text } = slowClick();
    const loop = text.split('\n').findIndex((l) => l.includes('while (performance.now()')) + 1;
    const top = [...(busy?.positionTicks ?? [])].sort((a, b) => b.ticks - a.ticks)[0];
    expect(loop).toBeGreaterThan(0);
    expect(top?.line).toBe(loop);
  });

  it('counts one tick for each sample that landed on the function', () => {
    const { busy, profile } = slowClick();
    const samples = (profile?.samples ?? []).filter((s) => s === busy?.id).length;
    const ticks = (busy?.positionTicks ?? []).reduce((n, t) => n + t.ticks, 0);
    expect(ticks).toBe(samples);
  });

  it('reaches the model, so the source panel can show time on each line', () => {
    const model = analyze(slowClick().capture);
    const fn = [...Array(model.functions.length).keys()].find(
      (f) => model.strings[model.functions.name[f] ?? 0] === 'busy',
    );
    const track = model.tracks[0];
    const slot = track?.fnIds.indexOf(fn ?? -1) ?? -1;
    const a = track?.lines.offset[slot] ?? 0;
    const b = track?.lines.offset[slot + 1] ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it('puts a script that starts part-way down its page at the right line of the text', () => {
    const { busy, text } = slowClick();
    const defined = text.split('\n').findIndex((l) => l.includes('function busy')) + 1;
    expect((busy?.callFrame.lineNumber ?? -1) + 1).toBe(defined);
  });
});
