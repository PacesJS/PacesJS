import { createServer, get } from 'node:http';
import { Worker } from 'node:worker_threads';
import { authenticate } from './middleware/auth.js';
import { getOrders } from './routes/orders.js';
import { flushMetrics } from './util/metrics.js';
import { prepareTemplate } from './render/template.js';

const REQUESTS = Number(process.env.ORDERS_REQUESTS ?? 14);

prepareTemplate();

const server = createServer(async (req, res) => {
  try {
    authenticate(req.headers.authorization);
    if (req.method === 'GET' && req.url === '/orders') {
      const body = await getOrders();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

const metrics = setInterval(flushMetrics, 250);

function request(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    get({ port, path: '/orders', headers: { authorization: 'Bearer demo' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
}

server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const workers = [9, 2].map((jobs) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { jobs } });
    return new Promise((resolve) => worker.on('exit', resolve));
  });
  for (let i = 0; i < REQUESTS; i++) await request(port);
  clearInterval(metrics);
  await Promise.all(workers);
  server.close();
});
