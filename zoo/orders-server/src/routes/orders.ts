import { findOrders } from '../db/orders.js';
import { renderInvoice } from '../render/invoice.js';

export async function getOrders(): Promise<string> {
  const orders = await findOrders();
  const invoice = renderInvoice(orders);
  return JSON.stringify(invoice);
}
