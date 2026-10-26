// A tiny static server for the browser zoo: pages from ./pages on one origin, and the files named
// in `thirdParty` on a second origin (a different port, so the browser treats it as another site).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'application/javascript' };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serveFile(res, file) {
  try {
    const body = readFileSync(join(here, 'pages', file));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/** Starts the zoo. `%THIRD%` in a page is replaced by the second origin. */
export async function startZoo() {
  const second = await listen((req, res) => serveFile(res, req.url.split('?')[0].slice(1)));
  const secondOrigin = `http://localhost:${second.address().port}`;
  const first = await listen((req, res) => {
    const name = req.url.split('?')[0].slice(1) || 'index.html';
    if (name.endsWith('.html')) {
      try {
        const html = readFileSync(join(here, 'pages', name), 'utf8').replaceAll(
          '%THIRD%',
          secondOrigin,
        );
        res.writeHead(200, { 'content-type': 'text/html' }).end(html);
      } catch {
        res.writeHead(404).end('not found');
      }
    } else serveFile(res, name);
  });
  const origin = `http://127.0.0.1:${first.address().port}`;
  return {
    origin,
    secondOrigin,
    url: (page) => `${origin}/${page}.html`,
    close: () => Promise.all([first, second].map((s) => new Promise((r) => s.close(r)))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const zoo = await startZoo();
  console.log(
    `browser zoo on ${zoo.origin}/ (pages: forced-layout, slow-click, third-party, worker-and-iframe, layout-shift)`,
  );
}
