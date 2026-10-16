// Planted problem: a backtracking-heavy regex that dominates self time, in many short tasks.
const { serve } = require('./_drive.cjs');

const input = 'a'.repeat(22) + '!';
function looksValid(text) {
  return /^(a+)+$/.test(text);
}

serve(async () => {
  let hits = 0;
  for (let i = 0; i < 3; i++) if (looksValid(input)) hits++;
  return hits;
}, 40);
