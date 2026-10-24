// Planted problem: GET /report rebuilds and re-sorts a big list on every request (hot self time);
// GET /ping is cheap. A long-running server for trying marks and hotkeys: paces -- node zoo/apps/api-server.cjs
const http = require('node:http');

const PORT = Number(process.env.PORT) || 3100;

function buildReport() {
  const scores = new Float64Array(400000);
  for (let i = 0; i < scores.length; i++) scores[i] = Math.sin(i) * 1000;
  scores.sort();
  return { count: scores.length, lowest: scores[0], highest: scores[scores.length - 1] };
}

const routes = {
  '/ping': () => ({ ok: true }),
  '/report': buildReport,
};

const server = http.createServer((req, res) => {
  const handler = routes[new URL(req.url, 'http://localhost').pathname];
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(handler()));
});

server.listen(PORT, () => {
  console.log(`api-server on http://localhost:${PORT}  (GET /ping, GET /report)`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
