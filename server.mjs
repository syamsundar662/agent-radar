// Agent Radar — local-only HTTP server. Streams agent snapshots over SSE.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './collector.mjs';
import { trackBuildings } from './village.mjs';

// Loopback only: the snapshot includes prompts and tool calls from your transcripts.
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4747;
const TICK_MS = 2000;
const IDLE_TICK_MS = 15_000; // keeps recording village buildings while no page is open
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const clients = new Set();
let inflight = null;
let lastTick = 0;

// Concurrent callers share one in-progress snapshot.
function refresh() {
  inflight ??= snapshot()
    .then(trackBuildings)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

setInterval(async () => {
  if (!clients.size && Date.now() - lastTick < IDLE_TICK_MS) return;
  lastTick = Date.now();
  try {
    const snap = await refresh();
    if (!clients.size) return;
    const frame = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(frame);
  } catch (err) {
    console.error('snapshot failed:', err);
  }
}, TICK_MS);

const server = http.createServer(async (req, res) => {
  // DNS-rebinding guard: a remote page resolving to 127.0.0.1 still sends its own Host.
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK_NAMES.has(hostname)) return send(res, 403, 'Forbidden');

  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  if (pathname === '/api/stream') return stream(req, res);
  if (pathname === '/api/snapshot') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(await refresh()));
    } catch (err) {
      console.error('snapshot failed:', err);
      return send(res, 500, 'Snapshot failed');
    }
  }
  return serveStatic(pathname, res);
});

async function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
  try {
    res.write(`data: ${JSON.stringify(await refresh())}\n\n`);
  } catch (err) {
    console.error('snapshot failed:', err);
  }
}

async function serveStatic(pathname, res) {
  const file = path.join(PUBLIC_DIR, path.normalize(pathname === '/' ? 'index.html' : pathname.slice(1)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy — try PORT=4848 npm start`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Radar → http://localhost:${PORT}`);
});
