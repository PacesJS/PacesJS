import Ajv from 'ajv';
import type { Order } from '../db/orders.js';
import { formatCurrency, lineTotal } from '../util/money.js';
import { loadTemplate } from './template.js';

const ajv = new Ajv();
const validateRow = ajv.compile({
  type: 'object',
  required: ['id', 'lines'],
  properties: { id: { type: 'number' }, lines: { type: 'array' } },
});

export function buildInvoiceRows(orders: Order[]): Array<{ id: number; total: string }> {
  const rows: Array<{ id: number; total: string }> = [];
  for (const order of orders) {
    if (!validateRow(order)) throw new Error('invalid order');
    let cents = 0;
    for (const line of order.lines) cents += lineTotal(line.qty, line.unitCents);
    rows.push({ id: order.id, total: formatCurrency(cents) });
  }
  return rows;
}

export function renderInvoice(orders: Order[]): { template: number; rows: unknown[] } {
  const template = loadTemplate();
  const rows = buildInvoiceRows(orders);
  return { template: template.length, rows };
}
