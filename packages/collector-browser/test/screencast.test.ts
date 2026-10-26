import { describe, expect, it } from 'vitest';
import { createScreencast } from '../src/screencast.js';
import { FakeCdp } from './helpers/fake-cdp.js';

const frame = (cdp: FakeCdp, session: string, ackId: number, seconds: number, byte = 1): void =>
  cdp.emit({
    method: 'Page.screencastFrame',
    sessionId: session,
    params: {
      data: Buffer.from([0xff, 0xd8, byte, 0xff, 0xd9]).toString('base64'),
      metadata: { timestamp: seconds },
      sessionId: ackId,
    },
  });

function setup() {
  const cdp = new FakeCdp();
  const shots: Array<{ epochMs: number; bytes: number[] }> = [];
  const screencast = createScreencast({
    cdp,
    addScreenshot: (epochMs, bytes) => shots.push({ epochMs, bytes: [...bytes] }),
  });
  return { cdp, screencast, shots };
}

const called = (cdp: FakeCdp, method: string) => cdp.calls.filter((c) => c.method === method);

describe('createScreencast', () => {
  it('asks each page for small JPEG frames', async () => {
    const { cdp, screencast } = setup();
    await screencast.start(['s1', 's2']);
    const starts = called(cdp, 'Page.startScreencast');
    expect(starts.map((c) => c.sessionId)).toEqual(['s1', 's2']);
    expect(starts[0]?.params).toMatchObject({ format: 'jpeg', maxWidth: 500, maxHeight: 330 });
  });

  it('takes a frame at the wall-clock time the browser gave it, and acknowledges it', async () => {
    const { cdp, screencast, shots } = setup();
    await screencast.start(['s1']);
    frame(cdp, 's1', 7, 1_700_000_000.5, 9);
    expect(shots).toEqual([{ epochMs: 1_700_000_000_500, bytes: [0xff, 0xd8, 9, 0xff, 0xd9] }]);
    const acks = called(cdp, 'Page.screencastFrameAck');
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ sessionId: 's1', params: { sessionId: 7 } });
  });

  it('stops asking, and keeps nothing, once stopped', async () => {
    const { cdp, screencast, shots } = setup();
    await screencast.start(['s1']);
    await screencast.stop();
    expect(called(cdp, 'Page.stopScreencast').map((c) => c.sessionId)).toEqual(['s1']);
    frame(cdp, 's1', 8, 5);
    expect(shots).toEqual([]);
  });

  it('still acknowledges a frame that was in flight when it stopped, so the page is not left waiting', async () => {
    const { cdp, screencast } = setup();
    await screencast.start(['s1']);
    await screencast.stop();
    frame(cdp, 's1', 9, 5);
    expect(called(cdp, 'Page.screencastFrameAck')).toHaveLength(1);
  });

  it('starts again after a stop', async () => {
    const { cdp, screencast, shots } = setup();
    await screencast.start(['s1']);
    await screencast.stop();
    await screencast.start(['s1']);
    frame(cdp, 's1', 10, 6);
    expect(called(cdp, 'Page.startScreencast')).toHaveLength(2);
    expect(shots).toHaveLength(1);
  });

  it('starts a page that appears while it is running', async () => {
    const { cdp, screencast } = setup();
    await screencast.start(['s1']);
    await screencast.add('s2');
    expect(called(cdp, 'Page.startScreencast').map((c) => c.sessionId)).toEqual(['s1', 's2']);
  });

  it('does not start a page that appears while it is stopped', async () => {
    const { cdp, screencast } = setup();
    await screencast.add('s2');
    expect(called(cdp, 'Page.startScreencast')).toEqual([]);
  });

  it('survives a page that has gone', async () => {
    const { cdp, screencast } = setup();
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params, session) =>
      method === 'Page.startScreencast'
        ? Promise.reject(new Error('closed'))
        : send(method, params, session);
    await expect(screencast.start(['s1'])).resolves.toBeUndefined();
  });

  it('ignores a frame with no usable data', async () => {
    const { cdp, screencast, shots } = setup();
    await screencast.start(['s1']);
    cdp.emit({ method: 'Page.screencastFrame', sessionId: 's1', params: { sessionId: 1 } });
    expect(shots).toEqual([]);
  });
});
