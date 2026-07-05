// BALLTBALL server entrypoint: one HTTP server that also carries the '/ws'
// websocket endpoint. Dev: vite proxies /ws here. Prod: this process serves
// the built client from dist/ on the same origin.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { decodeClient } from '../shared/protocol';
import { Lobby } from './rooms';

const MAX_MSG_BYTES = 4096;
const MAX_MSGS_PER_SEC = 130;
const HEARTBEAT_MS = 30_000;
const MAX_CONNS = 400; // global socket cap (event-loop protection)
const MAX_CONNS_PER_IP = 8; // one source can't hog the server

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
};

export interface RunningServer {
  close(): Promise<void>;
  port: number;
}

export function startServer(port: number): RunningServer {
  const lobby = new Lobby();
  const aliveMap = new WeakMap<WebSocket, boolean>();
  const perIp = new Map<string, number>();
  let totalConns = 0;

  function clientIp(req: IncomingMessage): string {
    // Only trust remoteAddress here — we don't run behind a trusted proxy, so
    // x-forwarded-for would be client-spoofable. (Add XFF parsing if deployed
    // behind a known reverse proxy.)
    return req.socket.remoteAddress ?? '';
  }

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      console.error('[http] handler error', err);
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('server error');
      } catch {
        /* socket already gone */
      }
    });
  });

  // ws rejects frames over maxPayload at the framing layer (1009), so oversized
  // floods can't slip past the per-socket rate limiter buffered as 64KB each.
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MSG_BYTES });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req);
    const ipCount = perIp.get(ip) ?? 0;
    if (totalConns >= MAX_CONNS || ipCount >= MAX_CONNS_PER_IP) {
      try {
        ws.close(1013, 'busy');
      } catch {
        /* already closing */
      }
      return;
    }
    totalConns++;
    perIp.set(ip, ipCount + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      totalConns--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };

    const client = lobby.connect(ws);
    aliveMap.set(ws, true);
    let windowStart = Date.now();
    let windowCount = 0;

    ws.on('pong', () => aliveMap.set(ws, true));

    ws.on('message', (data: RawData) => {
      try {
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          windowCount = 0;
        }
        // count every delivered frame against the budget, before the size check
        if (++windowCount > MAX_MSGS_PER_SEC) return;
        if (byteLen(data) > MAX_MSG_BYTES) return;
        const msg = decodeClient(rawToString(data));
        if (!msg) return;
        lobby.handle(client, msg);
      } catch (err) {
        console.error('[ws] message error', err);
      }
    });

    ws.on('close', () => {
      release();
      try {
        lobby.disconnect(client);
      } catch (err) {
        console.error('[ws] close error', err);
      }
    });

    ws.on('error', () => {
      /* 'close' follows; nothing to do */
    });
  });

  // terminate sockets that missed a full ping cycle
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (aliveMap.get(ws) === false) {
        ws.terminate();
        continue;
      }
      aliveMap.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* already closing */
      }
    }
  }, HEARTBEAT_MS);

  httpServer.listen(port);

  return {
    port,
    close(): Promise<void> {
      clearInterval(heartbeat);
      lobby.shutdown();
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}

// ── HTTP ────────────────────────────────────────────────────

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('BALLTBALL server');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }

  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (urlPath.includes('\0')) {
    res.writeHead(400);
    res.end();
    return;
  }

  const rel = urlPath.replace(/^\/+/, '') || 'index.html';
  let filePath = path.normalize(path.join(DIST_DIR, rel));
  // path-traversal guard: resolved path must stay inside dist/
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }

  let st = await statOrNull(filePath);
  if (st?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    st = await statOrNull(filePath);
  }
  if (!st?.isFile() && path.extname(rel) === '') {
    // SPA fallback: unknown extensionless routes get the app shell
    filePath = path.join(DIST_DIR, 'index.html');
    st = await statOrNull(filePath);
  }
  if (!st?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const isHashedAsset = /[\\/]assets[\\/]/.test(path.relative(DIST_DIR, filePath));
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(await fs.readFile(filePath));
}

async function statOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

// ── ws payload helpers ──────────────────────────────────────

function byteLen(d: RawData): number {
  if (Array.isArray(d)) return d.reduce((n, b) => n + b.length, 0);
  if (d instanceof ArrayBuffer) return d.byteLength;
  return d.length;
}

function rawToString(d: RawData): string {
  if (Array.isArray(d)) return Buffer.concat(d).toString('utf8');
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  return d.toString('utf8');
}

// ── auto-start when run directly (Windows-safe) ─────────────

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const port = Number(process.env.PORT) || 3001;
  const server = startServer(port);
  console.log(`[BALLTBALL] 서버 실행 중 — 포트 ${server.port} (ws: /ws)`);
}
