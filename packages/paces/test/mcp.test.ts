import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { handleMcpMessage, serveMcp } from '../src/mcp.js';

const summary = () => ({
  findings: [
    { severity: 'high', title: 'Event loop blocked', summary: 'a 120 ms task' },
    { severity: 'low', title: 'GC pressure', summary: '12% of wall time' },
  ],
});

function pipeTransport(): { transport: Transport; done: Promise<void> } {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const done = serveMcp(toServer, fromServer, summary);
  const transport: Transport = {
    start: async () => {
      createInterface({ input: fromServer }).on('line', (line) => {
        transport.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      });
    },
    send: async (m) => {
      toServer.write(`${JSON.stringify(m)}\n`);
    },
    close: async () => {
      toServer.end();
    },
  };
  return { transport, done };
}

describe('handleMcpMessage', () => {
  it('ignores notifications', () => {
    expect(
      handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, summary),
    ).toBeUndefined();
  });

  it('reports an unknown method as -32601', () => {
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'nope' }, summary)).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('turns a failing summary into a tool error rather than crashing', () => {
    const out = handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summary' } },
      () => {
        throw new Error('engine missing');
      },
    );
    expect(out).toMatchObject({ result: { isError: true } });
  });
});

describe('mcp server compatibility with the official client', () => {
  it('initializes, lists tools, and returns the summary and filtered findings', async () => {
    const { transport, done } = pipeTransport();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['summary', 'findings']);

    const all = (await client.callTool({ name: 'summary', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(all.content[0]?.text ?? '{}')).toEqual(summary());

    const high = (await client.callTool({ name: 'findings', arguments: { severity: 'high' } })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(high.content[0]?.text ?? '[]')).toHaveLength(1);
    await client.close();
    await done;
  });
});
