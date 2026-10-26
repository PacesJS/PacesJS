import { describe, expect, it } from 'vitest';
import { createTargetManager } from '../src/targets.js';
import { FakeCdp } from './helpers/fake-cdp.js';

function setup(keepQuery = false) {
  const cdp = new FakeCdp();
  const bridge: Array<{ message: unknown; session: string }> = [];
  const manager = createTargetManager({
    cdp,
    injectSource: 'window.x = 1;',
    keepQuery,
    onBridge: (message, session) => bridge.push({ message, session }),
  });
  return { cdp, manager, bridge };
}

const attached = (cdp: FakeCdp, sessionId: string, type: string, waiting = true): void =>
  cdp.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      waitingForDebugger: waiting,
      targetInfo: { targetId: `t-${sessionId}`, type, url: '' },
    },
  });

const methodsOn = (cdp: FakeCdp, session: string): string[] =>
  cdp.calls.filter((c) => c.sessionId === session).map((c) => c.method);

describe('createTargetManager', () => {
  it('configures an auto-attached iframe, then resumes it last', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 's1', 'iframe');
    await manager.idle();
    const methods = methodsOn(cdp, 's1');
    expect(methods).toEqual(
      expect.arrayContaining([
        'Runtime.enable',
        'Runtime.addBinding',
        'Page.enable',
        'Page.addScriptToEvaluateOnNewDocument',
        'Debugger.enable',
        'Target.setAutoAttach',
      ]),
    );
    expect(methods[methods.length - 1]).toBe('Runtime.runIfWaitingForDebugger');
  });

  it('adds the binding before the script that will call it', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 's1', 'page');
    await manager.idle();
    const methods = methodsOn(cdp, 's1');
    expect(methods.indexOf('Runtime.addBinding')).toBeLessThan(
      methods.indexOf('Page.addScriptToEvaluateOnNewDocument'),
    );
  });

  it('enables the runtime before it adds the binding, since bindings deliver nothing otherwise', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 's1', 'page');
    await manager.idle();
    const methods = methodsOn(cdp, 's1');
    expect(methods.indexOf('Runtime.enable')).toBeLessThan(methods.indexOf('Runtime.addBinding'));
  });

  it('gives a worker the debugger and the runtime but no page domain or injected script', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 'w1', 'worker');
    await manager.idle();
    const methods = methodsOn(cdp, 'w1');
    expect(methods).toContain('Debugger.enable');
    expect(methods).not.toContain('Page.enable');
    expect(methods).not.toContain('Page.addScriptToEvaluateOnNewDocument');
  });

  it('only resumes a target that is waiting for the debugger', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 's1', 'page', false);
    await manager.idle();
    expect(methodsOn(cdp, 's1')).not.toContain('Runtime.runIfWaitingForDebugger');
  });

  it('resumes targets of types it ignores, so the page never stalls', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 'x1', 'other');
    await manager.idle();
    expect(methodsOn(cdp, 'x1')).toEqual(['Runtime.runIfWaitingForDebugger']);
  });

  it('records parsed scripts without their query strings, and skips the injected one', async () => {
    const { cdp, manager } = setup();
    cdp.emit({
      method: 'Debugger.scriptParsed',
      sessionId: 's1',
      params: {
        scriptId: '5',
        url: 'https://a.test/app.js?v=9',
        sourceMapURL: 'app.js.map',
        hash: 'h',
      },
    });
    cdp.emit({
      method: 'Debugger.scriptParsed',
      sessionId: 's1',
      params: {
        scriptId: '6',
        url: 'paces://instrumentation/inject.js',
        sourceMapURL: '',
        hash: 'i',
      },
    });
    expect(manager.scripts()).toMatchObject([
      {
        scriptId: '5',
        url: 'https://a.test/app.js',
        sourceMapURL: 'app.js.map',
        hash: 'h',
        session: 's1',
      },
    ]);
  });

  it('remembers which target parsed a script, so colliding script ids can be told apart', async () => {
    const { cdp, manager } = setup();
    attached(cdp, 's7', 'iframe');
    await manager.idle();
    cdp.emit({
      method: 'Debugger.scriptParsed',
      sessionId: 's7',
      params: { scriptId: '2', url: 'https://b.test/x.js', sourceMapURL: '', hash: 'h' },
    });
    expect(manager.scripts()[0]).toMatchObject({ targetType: 'iframe', targetId: 't-s7' });
  });

  it('keeps the query string when asked to', () => {
    const { cdp, manager } = setup(true);
    cdp.emit({
      method: 'Debugger.scriptParsed',
      sessionId: 's1',
      params: { scriptId: '5', url: 'https://a.test/app.js?v=9', sourceMapURL: '', hash: 'h' },
    });
    expect(manager.scripts()[0]?.url).toBe('https://a.test/app.js?v=9');
  });

  it('routes parsed bridge messages with the session they came from', () => {
    const { cdp, bridge } = setup();
    cdp.emit({
      method: 'Runtime.bindingCalled',
      sessionId: 's2',
      params: { name: '__pacesBridge', payload: '{"t":"hello","frame":"top"}' },
    });
    expect(bridge).toEqual([{ message: { t: 'hello', frame: 'top' }, session: 's2' }]);
  });

  it('ignores other bindings and malformed payloads', () => {
    const { cdp, bridge } = setup();
    cdp.emit({
      method: 'Runtime.bindingCalled',
      sessionId: 's',
      params: { name: 'other', payload: '{}' },
    });
    cdp.emit({
      method: 'Runtime.bindingCalled',
      sessionId: 's',
      params: { name: '__pacesBridge', payload: 'not json' },
    });
    expect(bridge).toEqual([]);
  });

  it('configures a page the recorder attached itself', async () => {
    const { cdp, manager } = setup();
    await manager.configure('top', 'page', false);
    expect(methodsOn(cdp, 'top')).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(methodsOn(cdp, 'top')).not.toContain('Runtime.runIfWaitingForDebugger');
  });

  it('survives a target that detaches while it is being configured', async () => {
    const { cdp, manager } = setup();
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params, session) =>
      method === 'Debugger.enable'
        ? Promise.reject(new Error('Session closed'))
        : send(method, params, session);
    attached(cdp, 's1', 'iframe');
    await expect(manager.idle()).resolves.toBeUndefined();
  });

  it('records where a script starts in its document, since an inline script is only part of it', () => {
    const { cdp, manager } = setup();
    cdp.emit({
      method: 'Debugger.scriptParsed',
      sessionId: 's1',
      params: {
        scriptId: '3',
        url: 'https://a.test/page.html',
        sourceMapURL: '',
        hash: 'h',
        startLine: 6,
        startColumn: 8,
        endLine: 20,
      },
    });
    expect(manager.scripts()[0]).toMatchObject({ startLine: 6, startColumn: 8, endLine: 20 });
  });

  it('tells the recorder about each script the moment it is parsed, not the injected one', () => {
    const cdp = new FakeCdp();
    const seen: string[] = [];
    createTargetManager({
      cdp,
      injectSource: '',
      keepQuery: false,
      onBridge: () => undefined,
      onScript: (script) => seen.push(script.url),
    });
    const parsed = (url: string, scriptId: string) =>
      cdp.emit({
        method: 'Debugger.scriptParsed',
        sessionId: 's1',
        params: { scriptId, url, sourceMapURL: '', hash: scriptId },
      });
    parsed('https://a.test/a.js', '1');
    parsed('paces://instrumentation/inject.js', '2');
    parsed('https://a.test/b.js?v=2', '3');
    expect(seen).toEqual(['https://a.test/a.js', 'https://a.test/b.js']);
  });
});
