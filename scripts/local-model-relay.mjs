import {
  localHosts,
  localModelAddress,
  localModelRoute,
  localPaths,
  localReplyLimit,
} from '../src/agent/providers/localModel.ts';
import { temporaryApiKeyFormat } from '../src/agent/modelCatalog.ts';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function localModelRelay() {
  const install = (server) => {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== localModelRoute) return next();
      const reject = (status) => {
        if (!res.headersSent && !res.destroyed) res.writeHead(status).end();
      };
      const site = req.headers['sec-fetch-site'];
      const origins = localHosts.map((host) => `${host}:${req.socket.localPort}`);
      if (
        !loopback.has(req.socket.remoteAddress) ||
        !loopback.has(req.socket.localAddress) ||
        !origins.includes(req.headers.host) ||
        (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) ||
        (site && site !== 'same-origin')
      )
        return reject(403);
      if (req.method === 'GET') {
        res.writeHead(204, { 'X-Local-Model-Relay': 'available', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.headers.origin !== `http://${req.headers.host}`) return reject(403);
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json')
        return reject(405);

      const controller = new AbortController();
      const stop = () => controller.abort();
      res.once('close', stop);
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 300_000) return reject(413);
          chunks.push(chunk);
        }
        const { address, path, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!localPaths.includes(path)) return reject(400);
        const origin = localModelAddress(address, path.startsWith('/v1/'));
        const read = path === '/api/tags' || path === '/v1/models';
        if (read ? body !== undefined : !body || typeof body !== 'object' || Array.isArray(body))
          return reject(400);
        const authorization = req.headers.authorization;
        if (
          authorization &&
          (!path.startsWith('/v1/') ||
            !authorization.startsWith('Bearer ') ||
            !temporaryApiKeyFormat.test(authorization.slice(7)))
        )
          return reject(400);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(read ? 7000 : 120_000),
        ]);
        const response = await fetch(origin + path, {
          signal,
          redirect: 'error',
          method: read ? 'GET' : 'POST',
          headers: {
            ...(read ? {} : { 'Content-Type': 'application/json' }),
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: read ? undefined : JSON.stringify(body),
        });
        const result = [];
        let length = 0;
        for await (const chunk of response.body ?? []) {
          length += chunk.byteLength;
          if (length > localReplyLimit) return reject(502);
          result.push(chunk);
        }
        if (!res.destroyed) {
          res.writeHead(response.status, {
            'Content-Type': 'application/json',
            'X-Local-Model-Relay': 'upstream',
            'Cache-Control': 'no-store',
          });
          res.end(Buffer.concat(result));
        }
      } catch (error) {
        reject(error instanceof SyntaxError ? 400 : 502);
      } finally {
        res.off('close', stop);
      }
    });
  };
  return { name: 'local-model-relay', configureServer: install, configurePreviewServer: install };
}
