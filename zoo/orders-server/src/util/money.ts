export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

// Planted hot path: builds a fresh Intl.NumberFormat per line item.
export function lineTotal(qty: number, unitCents: number): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const text = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      (qty * unitCents) / 100,
    );
    total = Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);
  }
  return total;
}
