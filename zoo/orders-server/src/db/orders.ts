export interface Order {
  id: number;
  customer: string;
  lines: Array<{ sku: string; qty: number; unitCents: number }>;
}

// Stands in for a database round trip: an await on an I/O-like wait.
function query(): Promise<Order[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(makeRows()), 8);
  });
}

function makeRows(): Order[] {
  const rows: Order[] = [];
  for (let i = 0; i < 140; i++) {
    rows.push({
      id: i,
      customer: `customer-${i % 17}`,
      lines: Array.from({ length: 6 }, (_, j) => ({
        sku: `sku-${i}-${j}`,
        qty: (i + j) % 5,
        unitCents: 995 + ((i * 31 + j * 7) % 4000),
      })),
    });
  }
  return rows;
}

function mapRows(rows: Order[]): Order[] {
  return rows.map((row) => ({ ...row, customer: row.customer.toUpperCase() }));
}

export async function findOrders(): Promise<Order[]> {
  const rows = await query();
  return mapRows(rows);
}
