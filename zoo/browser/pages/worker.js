function workerWork() {
  let x = 0;
  for (let i = 0; i < 2e7; i++) x += Math.sqrt(i);
  return x;
}
self.onmessage = () => {
  workerWork();
  self.postMessage('done');
};
