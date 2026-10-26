import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCdpClient } from '../src/cdp-pipe.js';

function setup(timeoutMs = 1000) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const written: string[] = [];
  toBrowser.on('data', (d: Buffer) => written.push(d.toString('utf8')));
  const client = createCdpClient({ input: fromBrowser, output: toBrowser, timeoutMs });
  const reply = (obj: unknown) => fromBrowser.write(JSON.stringify(obj) + '\0');
  return { client, fromBrowser, reply, written };
}

describe('createCdpClient', () => {
  it('writes each request as NUL-terminated JSON with an increasing id', async () => {
    const { client, written, reply } = setup();
    const first = client.send('Browser.getVersion');
    const second = client.send('Target.getTargets', { a: 1 }, 'sess');
    reply({ id: 1, result: {} });
    reply({ id: 2, result: {} });
    await Promise.all([first, second]);
    const messages = written
      .join('')
      .split('\0')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    expect(messages).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Target.getTargets', params: { a: 1 }, sessionId: 'sess' },
    ]);
  });

  it('resolves a request with the result of its reply', async () => {
    const { client, reply } = setup();
    const p = client.send('Browser.getVersion');
    reply({ id: 1, result: { product: 'Edg/155' } });
    expect(await p).toEqual({ product: 'Edg/155' });
  });

  it('rejects a request with the method name when the browser answers with an error', async () => {
    const { client, reply } = setup();
    const p = client.send('Page.enable');
    reply({ id: 1, error: { message: 'nope' } });
    await expect(p).rejects.toThrow('Page.enable: nope');
  });

  it('assembles a message split across chunks', async () => {
    const { client, fromBrowser } = setup();
    const p = client.send('Browser.getVersion');
    const text = JSON.stringify({ id: 1, result: { ok: true } }) + '\0';
    fromBrowser.write(text.slice(0, 7));
    fromBrowser.write(text.slice(7));
    expect(await p).toEqual({ ok: true });
  });

  it('assembles a multi-byte character split across chunks', async () => {
    const { client, fromBrowser } = setup();
    const p = client.send('Runtime.evaluate');
    const bytes = Buffer.from(JSON.stringify({ id: 1, result: { text: 'é→😀' } }) + '\0');
    const cut = bytes.indexOf(0xc3) + 1;
    fromBrowser.write(bytes.subarray(0, cut));
    fromBrowser.write(bytes.subarray(cut));
    expect(await p).toEqual({ text: 'é→😀' });
  });

  it('handles several messages in one chunk and routes events to listeners', async () => {
    const { client, fromBrowser } = setup();
    const events: unknown[] = [];
    client.onEvent((e) => events.push(e));
    const p = client.send('Browser.getVersion');
    fromBrowser.write(
      JSON.stringify({ method: 'Target.targetCreated', params: { x: 1 } }) +
        '\0' +
        JSON.stringify({ id: 1, result: 5 }) +
        '\0',
    );
    expect(await p).toBe(5);
    expect(events).toEqual([{ method: 'Target.targetCreated', params: { x: 1 } }]);
  });

  it('rejects a request that gets no reply within the timeout, naming the method', async () => {
    const { client } = setup(20);
    await expect(client.send('Tracing.end')).rejects.toThrow('Tracing.end');
  });

  it('rejects pending requests and resolves closed when the pipe ends', async () => {
    const { client, fromBrowser } = setup();
    const p = client.send('Page.navigate');
    const rejected = expect(p).rejects.toThrow('Page.navigate');
    fromBrowser.end();
    await rejected;
    await expect(client.closed).resolves.toBeUndefined();
  });

  it('rejects a new request once the pipe has closed', async () => {
    const { client, fromBrowser } = setup();
    fromBrowser.end();
    await client.closed;
    await expect(client.send('Page.enable')).rejects.toThrow('Page.enable');
  });
});
