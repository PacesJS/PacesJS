// Served from the second origin: stands in for an analytics or ad script that does a lot of work.
function trackEverything() {
  let x = 0;
  for (let i = 0; i < 4e7; i++) x += Math.sqrt(i);
  return x;
}
trackEverything();
