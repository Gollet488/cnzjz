import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const base = '/cnzjz/';
const dist = resolve(process.argv[2] ?? 'dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

await stat(resolve(dist, 'index.html'));
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.startsWith(base)) {
      const file = resolve(dist, path.slice(base.length) || 'index.html');
      if (file.startsWith(dist + sep)) {
        const info = await stat(file);
        if (info.isFile()) {
          res.writeHead(200, {
            'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
            'Content-Length': info.size,
          });
          if (req.method === 'HEAD') res.end();
          else
            createReadStream(file)
              .on('error', () => res.destroy())
              .pipe(res);
          return;
        }
      }
    }
  } catch {
    // Missing and malformed paths are not rewritten to the app entry.
  }
  res.writeHead(404).end();
}).listen(5188, '127.0.0.1');
