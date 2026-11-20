/**
 * Static server for the fingerprint lab.
 *
 * The lab is served over http from a non-loopback-looking origin so that it
 * behaves like a real third-party site: content scripts match it, DNR rules
 * apply, and the cookie/storage model is the one a tracker actually sees.
 *
 * Usage:
 *   npm run serve            # http://127.0.0.1:5391
 *   npm run serve -- 8080
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'lab');
const port = Number(process.argv[2] ?? process.env.PORT ?? 5391);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '') path = '/index.html';
    const full = resolve(join(root, normalize(path)));
    if (!full.startsWith(root + sep) && full !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      // A realistic header set so the wire-level checks in the lab have
      // something to compare the page-side values against.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(port, () => {
  console.log(`fingerprint lab: http://127.0.0.1:${port}/`);
});
