// A tiny static server for the browser zoo: pages from ./pages on one origin, and the files named
// in `thirdParty` on a second origin (a different port, so the browser treats it as another site).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'application/javascript' };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** A large, repetitive script: `vendor.js` goes out as plain text, `vendor-gz.js` compressed. */
function vendorScript(prefix) {
  let text = '';
  for (let i = 0; i < 1500; i++) {
    text += `function ${prefix}${i}(a, b) { var total = 0; for (var k = 0; k < 10; k++) total += (a + b + k) % 7; return total; }
`;
  }
  return text;
}

/** An image busy enough to count as content: the browser ignores flat pictures as largest paint. */
function heroSvg() {
  let shapes = '';
  for (let i = 0; i < 400; i++) {
    const x = (i * 97) % 780;
    const y = (i * 61) % 480;
    const hue = (i * 47) % 360;
    shapes += `<rect x="${x}" y="${y}" width="${20 + (i % 5) * 6}" height="${20 + (i % 7) * 4}" fill="hsl(${hue},60%,55%)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">${shapes}</svg>`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serveFile(res, file) {
  if (file === 'slow-hero.svg') {
    // The one slow request of slow-load.html.
    void sleep(2800).then(() => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(heroSvg());
    });
    return;
  }
  if (file === 'vendor.js' || file === 'vendor-gz.js') {
    const plain = file === 'vendor.js';
    const body = Buffer.from(vendorScript(plain ? 'vendorStep' : 'vendorStepGz'));
    res.writeHead(200, {
      'content-type': 'application/javascript',
      // Response headers must never reach a session: the privacy test looks for this value.
      'set-cookie': 'paces_probe=cookie-secret-4d2a; Path=/',
      ...(plain ? {} : { 'content-encoding': 'gzip' }),
    });
    res.end(plain ? body : gzipSync(body));
    return;
  }
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
      // The server takes its time answering for this page (slow-doc.html).
      const wait = name === 'slow-doc.html' ? sleep(1300) : Promise.resolve();
      void wait.then(() => {
        try {
          const html = readFileSync(join(here, 'pages', name), 'utf8').replaceAll(
            '%THIRD%',
            secondOrigin,
          );
          res.writeHead(200, { 'content-type': 'text/html' }).end(html);
        } catch {
          res.writeHead(404).end('not found');
        }
      });
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
    `browser zoo on ${zoo.origin}/ (pages: forced-layout, slow-click, third-party, worker-and-iframe, layout-shift, big-script, slow-load, slow-doc, late-hero, icon-dialog)`,
  );
}
