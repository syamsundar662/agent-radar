#!/usr/bin/env node
// Agent Radar — local-only HTTP server. Streams agent snapshots over SSE.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR, snapshot } from './collector.mjs';
import { demoSnapshot } from './demo.mjs';
import { DATA_DIR, flushBuildings, trackBuildings } from './village.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = `Agent Radar ${VERSION}: a live dashboard of the AI agents running on this machine.

Usage: agent-radar [options]

  -p, --port <n>   port to listen on (default 4747, or $PORT)
  -o, --open       open the dashboard in your browser
      --demo       show made-up sessions, no Claude Code needed
  -h, --help       show this help
  -v, --version    print the version

Environment:
  PORT               same as --port
  CLAUDE_CONFIG_DIR  where Claude Code keeps its data (default ~/.claude)
  AGENT_RADAR_DATA   where the village's saved buildings go (default ~/.agent-radar)

Docs: https://github.com/syamsundar662/agent-radar`;

const options = parseArgs(process.argv.slice(2));

// Loopback only: the snapshot includes prompts and tool calls from your transcripts.
const HOST = '127.0.0.1';
const PORT = options.port;
const TICK_MS = 2000;
const IDLE_TICK_MS = 15_000; // keeps recording village buildings while no page is open
const PUBLIC_DIR = path.join(ROOT, 'public');
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
  inflight ??= (options.demo ? Promise.resolve(demoSnapshot()) : snapshot().then(trackBuildings))
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

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => flushBuildings().finally(() => process.exit(0)));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is Agent Radar already running? Otherwise try --port ${PORT + 1}`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Agent Radar ${VERSION}${options.demo ? ' (demo data)' : ''} → ${url}`);
  if (!options.demo) {
    console.log(`  reading Claude Code data from ${CLAUDE_DIR}`);
    console.log(`  saving village buildings to ${DATA_DIR}`);
    if (!existsSync(path.join(CLAUDE_DIR, 'sessions')))
      console.log(`  no Claude Code sessions found yet: start \`claude\` in a terminal, or run with --demo to look around`);
  }
  console.log('  press Ctrl+C to stop');
  if (options.open) openBrowser(url);
});

function parseArgs(argv) {
  const out = { port: Number(process.env.PORT) || 4747, open: false, demo: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '-h' || flag === '--help') exit(HELP);
    else if (flag === '-v' || flag === '--version') exit(VERSION);
    else if (flag === '-o' || flag === '--open') out.open = true;
    else if (flag === '--demo') out.demo = true;
    else if (flag === '-p' || flag === '--port') {
      out.port = Number(inline ?? argv[++i]);
      if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) exit(`Invalid port: ${inline ?? argv[i]}`, 1);
    } else exit(`Unknown option: ${argv[i]}\n\n${HELP}`, 1);
  }
  return out;
}

function exit(message, code = 0) {
  (code ? console.error : console.log)(message);
  process.exit(code);
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => console.log(`  open ${url} in your browser`)).unref();
}
