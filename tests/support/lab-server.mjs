/**
 * In-process lab server for the test suite.
 *
 * Mirrors tests/support/server.mjs but binds an ephemeral port and exposes
 * `close()`, so tests can run in parallel and never collide with a developer's
 * `npm run serve`.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const labRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'dist', 'lab');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function probePage(headers) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>first-read</title>
<script>
window.__firstRead = {
  ua: navigator.userAgent,
  platform: navigator.platform,
  cores: navigator.hardwareConcurrency,
  mem: navigator.deviceMemory,
  languages: navigator.languages,
  tz: (function(){ try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })(),
  screenW: screen.width,
  screenH: screen.height,
  dpr: devicePixelRatio,
  toDataURLSource: (function(){ try { return Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL); } catch (e) { return 'error'; } })(),
  wire: ${JSON.stringify(headers)},
};
</script>
</head><body><script>window.__readyProbe = true;</script></body></html>`;
}

const wirePage = `<!doctype html><html><head><meta charset="utf-8"><title>wire</title></head>
<body><script>
fetch('/__headers').then(function(r){return r.json()}).then(function(j){ window.__wire = j; });
</script></body></html>`;

export async function startLabServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/__headers') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(req.headers, null, 2));
      return;
    }
    if (url.pathname === '/__probe') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(probePage(req.headers));
      return;
    }
    if (url.pathname === '/__wire') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(wirePage);
      return;
    }

    try {
      let path = decodeURIComponent(url.pathname);
      if (path === '/' || path === '') path = '/index.html';
      const full = resolve(join(labRoot, normalize(path)));
      if (!full.startsWith(labRoot + sep) && full !== labRoot) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
