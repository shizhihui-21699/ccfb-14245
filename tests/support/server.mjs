/**
 * The test server.
 *
 * The lab needs more than static files to be a real adversary:
 *
 *  - a page that echoes the request headers it received, so the lab can compare
 *    the *wire* fingerprint against the page-side one;
 *  - two distinct origins, because cross-site separation is the whole point and
 *    a test that only ever visits one site proves nothing;
 *  - a page that records first-read values from an inline script in <head>, to
 *    prove the profile is in place before the page's first line runs.
 *
 * Usage:
 *   node tests/support/server.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'lab');
const port = Number(process.argv[2] ?? process.env.PORT ?? 5392);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Head-inserted probe page.
 *
 * The inline script runs before any deferred or module script, so whatever it
 * reads is what the page saw at its very first opportunity. If the extension is
 * late by even one microtask, the real fingerprint shows up here.
 */
function probePage(recordWireHeaders) {
  const headersJson = JSON.stringify(recordWireHeaders);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>first-read probe</title>
<script>
  // Runs before every other script on the page.
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
    canvas: (function(){
      try {
        var c = document.createElement('canvas');
        c.width = 200; c.height = 40;
        var x = c.getContext('2d');
        x.textBaseline = 'top';
        x.font = '14px Arial';
        x.fillStyle = '#f60'; x.fillRect(0, 0, 120, 20);
        x.fillStyle = '#069'; x.fillText('first-read 指纹', 2, 4);
        return c.toDataURL().slice(-24) + ':' + c.toDataURL().length;
      } catch (e) { return 'error:' + e.message; }
    })(),
    toDataURLSource: (function(){ try { return Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL); } catch (e) { return 'error'; } })(),
    wire: ${headersJson},
  };
</script>
</head>
<body>
  <p>Probe page. Values captured before the page's first line of script.</p>
  <script>
    window.__readyProbe = true;
  </script>
</body>
</html>`;
}

/** Page that reports what the server saw, then loads the real lab in an iframe. */
function wirePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>wire</title></head>
<body>
<pre id="out">loading</pre>
<script>
  fetch('/__headers').then(function (r) { return r.json(); }).then(function (j) {
    document.getElementById('out').textContent = JSON.stringify(j, null, 2);
    window.__wire = j;
  });
</script>
</body></html>`;
}

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
    res.end(wirePage());
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
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(port, () => {
  console.log(`lab server on http://127.0.0.1:${port}/`);
});

export { server };
