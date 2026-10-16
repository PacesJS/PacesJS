// Planted problem: allocation churn that keeps the garbage collector busy.
const { serve } = require('./_drive.cjs');

let keep = [];
serve(async () => {
  for (let i = 0; i < 60000; i++) {
    keep.push({ id: i, tags: [String(i), String(i + 1)], payload: new Array(8).fill(i) });
    if (keep.length > 20000) keep = [];
  }
  return keep.length;
}, 40);
