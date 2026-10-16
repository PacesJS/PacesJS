let counter = 0;

export function flushMetrics(): number {
  let x = 0;
  for (let i = 0; i < 40000; i++) x += i % 7;
  counter += x;
  return counter;
}
