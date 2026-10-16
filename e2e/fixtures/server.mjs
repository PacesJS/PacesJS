// Long-running HTTP server used by the Ctrl+C tests.
// MODE=graceful installs a SIGINT handler that closes the server; MODE=plain installs none.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.end('ok');
});

if (process.env.MODE === 'graceful') {
  process.on('SIGINT', () => {
    console.log('server: SIGINT handler ran');
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

let sink = 0;

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`listening ${port}`);
  if (process.env.READY_FILE) writeFileSync(process.env.READY_FILE, String(port));
  // Keep the loop busy enough to collect samples without needing a client.
  setInterval(() => {
    for (let i = 0; i < 3e5; i++) sink += Math.sqrt(i);
    if (sink < 0) console.log(sink);
  }, 20);
});
