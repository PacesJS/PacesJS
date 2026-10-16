// Planted problem: allocation churn that keeps the garbage collector busy.
const { serve } = require('./_drive.cjs');

// The churn happens inside the native structured clone, so the time shows up as GC rather than
// as a hot user function.
const template = Array.from({ length: 5000 }, (_, i) => ({
  id: i,
  tags: [String(i), String(i + 1)],
  payload: new Array(8).fill(i),
}));

let keep = [];
serve(async () => {
  keep.push(structuredClone(template));
  if (keep.length > 120) keep = [];
  return keep.length;
}, 150);
