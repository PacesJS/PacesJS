// Pass 7c (browser pages): the page's network requests as a table on the model clock.

import { REQUEST_FLAG, REQUEST_TYPE_NAMES } from '../model.js';
import type { RequestTable } from '../model.js';
import type { RawRequest } from '../raw.js';
import type { StringTable } from '../util/strings.js';

const TYPE_OF: Record<string, number> = Object.fromEntries(
  REQUEST_TYPE_NAMES.map((name, i) => [name, i]),
);

const flagsOf = (r: RawRequest): number =>
  (r.renderBlocking ? REQUEST_FLAG.renderBlocking : 0) |
  (r.fromCache ? REQUEST_FLAG.cached : 0) |
  (r.failed ? REQUEST_FLAG.failed : 0);

export function buildRequests(
  requests: readonly RawRequest[],
  monoAtStartUs: number,
  strings: StringTable,
): RequestTable {
  const rel = (ts: number | undefined): number => (ts === undefined ? -1 : ts - monoAtStartUs);
  const n = requests.length;
  const table: RequestTable = {
    length: n,
    start: new Float64Array(n),
    response: new Float64Array(n),
    end: new Float64Array(n),
    url: new Uint32Array(n),
    type: new Uint8Array(n),
    flags: new Uint8Array(n),
    encoded: new Float64Array(n),
    decoded: new Float64Array(n),
    status: new Uint16Array(n),
  };
  requests.forEach((r, i) => {
    table.start[i] = rel(r.startUs);
    table.response[i] = rel(r.responseUs);
    table.end[i] = rel(r.endUs);
    table.url[i] = strings.intern(r.url);
    table.type[i] = TYPE_OF[r.type] ?? 0;
    table.flags[i] = flagsOf(r);
    table.encoded[i] = r.encodedBytes ?? -1;
    table.decoded[i] = r.decodedBytes ?? -1;
    table.status[i] = r.status ?? 0;
  });
  return table;
}
