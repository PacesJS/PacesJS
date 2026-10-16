// Shared by the zoo apps: starts an HTTP server, sends `n` sequential requests, then exits.
const http = require('node:http');

function serve(handler, n, path = '/work') {
  const server = http.createServer(async (req, res) => {
    const out = await handler(req);
    res.end(String(out));
  });
  server.listen(0, async () => {
    const { port } = server.address();
    for (let i = 0; i < n; i++) {
      await new Promise((resolve, reject) => {
        http
          .get({ port, path }, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .on('error', reject);
      });
    }
    server.close();
  });
}

module.exports = { serve };
