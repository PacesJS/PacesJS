// Planted problem: a hot function whose argument types drift between requests (ints, doubles, numeric
// strings, differently shaped objects), so V8 optimizes it, deoptimizes it and starts over.
const { serve } = require('./_drive.cjs');

function price(item) {
  return item.qty * item.unit + item.tax;
}

function total(items) {
  let sum = 0;
  for (let round = 0; round < 700; round++) {
    for (let i = 0; i < items.length; i++) sum += price(items[i]);
  }
  return sum;
}

const batches = [
  (i) => ({ qty: i, unit: 3, tax: 1 }),
  (i) => ({ qty: i, unit: 2.5, tax: 0.25 }),
  (i) => ({ unit: 3, qty: String(i), tax: 1 }),
  (i) => ({ qty: i, unit: 3, tax: 1, note: 'gift' }),
  (i) => ({ qty: i, unit: 3, tax: 1, coupon: 'x' }),
];

let request = 0;
serve(async () => {
  const make = batches[request++ % batches.length];
  const items = Array.from({ length: 4000 }, (_, i) => make(i));
  return total(items);
}, 40);
