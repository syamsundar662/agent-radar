// Builds a point-in-time snapshot of the AI agents running on this machine:
// Claude Code CLI sessions (from ~/.claude), their subagents, and other agent
// processes found in the process table (Codex, Cursor, Claude Desktop, ...).
// Works on macOS and Linux (via `ps`); Windows support (via PowerShell) is experimental.
import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const MAIN_TAIL_BYTES = 512 * 1024;
const SUB_TAIL_BYTES = 128 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const EVENTS_PER_SESSION = 24;
const EVENTS_PER_SUBAGENT = 10;
const MAX_SUBAGENTS = 12;
const SUBAGENT_WINDOW_MS = 6 * 3600_000; // hide subagents untouched for longer than this
const SUBAGENT_STALL_MS = 10 * 60_000; // unfinished + no writes for this long → stalled
const FEED_SIZE = 80;

// `app` matches the full command of a macOS desktop app's main process;
// `bin` matches the executable name (or the script run by node/bun/python).
const OTHER_AGENTS = [
  { id: 'claude-desktop', label: 'Claude Desktop', app: /\/Claude\.app\/Contents\/MacOS\/Claude$/ },
  { id: 'chatgpt', label: 'ChatGPT', app: /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT$/ },
  { id: 'cursor', label: 'Cursor', app: /\/Cursor\.app\/Contents\/MacOS\/Cursor$/, bin: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', app: /\/Windsurf\.app\/Contents\/MacOS\/(Windsurf|Electron)$/, bin: 'windsurf' },
  { id: 'codex', label: 'Codex', bin: 'codex' },
  { id: 'claude-headless', label: 'Claude Code · headless', bin: 'claude' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini' },
  { id: 'aider', label: 'Aider', bin: 'aider' },
  { id: 'ollama', label: 'Ollama', bin: 'ollama' },
  { id: 'copilot', label: 'GitHub Copilot', bin: 'copilot-language-server' },
];

export async function snapshot() {
  const now = Date.now();
  const procs = await processTable();
  const children = childrenOf(procs);

  const sessions = await collectSessions(procs, children, now);
  const others = collectOthers(procs, children, new Set(sessions.map((s) => s.pid)));

  const roots = [...sessions.map((s) => s.pid), ...others.flatMap((o) => o.pids)];
  const counted = new Set(roots.flatMap((pid) => [...walk(children, pid)]));
  let cpu = 0;
  let rssKB = 0;
  for (const pid of counted) {
    const p = procs.get(pid);
    if (p) (cpu += p.cpu), (rssKB += p.rssKB);
  }

  return {
    generatedAt: now,
    host: os.hostname().replace(/\.local$/, ''),
    cores: os.cpus().length,
    loadavg: os.loadavg(),
    totals: { cpu, rssMB: rssKB / 1024, processes: counted.size },
    sessions,
    others,
    feed: buildFeed(sessions),
  };
}

// ── Claude Code sessions ────────────────────────────────────────────────────

async function collectSessions(procs, children, now) {
  const files = (await readdir(SESSIONS_DIR).catch(() => [])).filter((f) => /^\d+\.json$/.test(f));
  const sessions = await Promise.all(files.map((f) => loadSession(path.join(SESSIONS_DIR, f), procs, children, now)));
  return sessions.filter(Boolean);
}

async function loadSession(file, procs, children, now) {
  const meta = await readJson(file);
  if (!meta?.pid) return null;
  // Session files outlive crashed processes, and pids get reused.
  const proc = procs.size ? procs.get(meta.pid) : bareProcess(meta.pid);
  if (!proc || !/claude/i.test(proc.command)) return null;

  const transcriptPath = meta.sessionId && meta.cwd ? await findTranscript(meta.sessionId, meta.cwd) : null;
  const transcript = transcriptPath ? await readTranscript(transcriptPath, MAIN_TAIL_BYTES, EVENTS_PER_SESSION) : null;
  const subagents = transcriptPath ? await collectSubagents(transcriptPath, now) : [];
  const startedAt = meta.startedAt ?? now - proc.uptimeSec * 1000;

  return {
    pid: meta.pid,
    sessionId: meta.sessionId,
    // One building per conversation: /clear starts a new session id, so a new building.
    buildingId: meta.sessionId ?? `${meta.pid}-${startedAt}`,
    name: meta.name || `claude-${meta.pid}`,
    cwd: meta.cwd,
    cwdShort: tildify(meta.cwd),
    project: path.basename(meta.cwd || ''),
    status: meta.status || 'unknown',
    statusSince: meta.statusUpdatedAt ?? null,
    kind: meta.kind ?? null,
    entrypoint: meta.entrypoint ?? null,
    version: meta.version ?? null,
    startedAt,
    tty: proc.tty,
    ...treeStats(procs, children, meta.pid),
    transcript: transcript && { ...transcript, events: undefined },
    events: transcript?.events ?? [],
    subagents,
  };
}

const transcriptPaths = new Map();

async function findTranscript(sessionId, cwd) {
  const direct = path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (await exists(direct)) return direct;
  if (transcriptPaths.has(sessionId)) return transcriptPaths.get(sessionId);
  // Very long cwds get a hashed project dir name — fall back to a scan.
  for (const dir of await readdir(PROJECTS_DIR).catch(() => [])) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (await exists(candidate)) {
      transcriptPaths.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

// Final state of a conversation that just ended (its session file is gone by now).
export async function finalTranscript(sessionId, cwd) {
  const file = await findTranscript(sessionId, cwd);
  return file ? readTranscript(file, MAIN_TAIL_BYTES, EVENTS_PER_SESSION) : null;
}

async function collectSubagents(transcriptPath, now) {
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
  const agents = await Promise.all(
    files.map(async (f) => {
      const file = path.join(dir, f);
      const st = await stat(file).catch(() => null);
      if (!st || now - st.mtimeMs > SUBAGENT_WINDOW_MS) return null;
      const d = await readTranscript(file, SUB_TAIL_BYTES, EVENTS_PER_SUBAGENT);
      if (!d) return null;
      const meta = (await readJson(file.replace(/\.jsonl$/, '.meta.json'))) ?? {};
      return {
        id: f.replace(/\.jsonl$/, ''),
        type: meta.agentType ?? 'subagent',
        description: meta.description ?? '',
        background: meta.requestShape === 'background',
        state: d.finished ? 'done' : now - st.mtimeMs < SUBAGENT_STALL_MS ? 'running' : 'stalled',
        startedAt: st.birthtimeMs,
        lastActivityAt: d.lastActivityAt ?? st.mtimeMs,
        model: d.model,
        last: d.last,
        events: d.events,
      };
    }),
  );
  const rank = { running: 0, stalled: 1, done: 2 };
  return agents
    .filter(Boolean)
    .sort((a, b) => rank[a.state] - rank[b.state] || b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_SUBAGENTS);
}

function buildFeed(sessions) {
  const feed = [];
  for (const s of sessions) {
    for (const e of s.events) feed.push({ ...e, agent: s.name, pid: s.pid });
    for (const a of s.subagents) {
      for (const e of a.events) feed.push({ ...e, agent: `${s.name} › ${a.type}`, pid: s.pid, sub: true });
    }
  }
  return feed
    .filter((e) => e.at)
    .sort((a, b) => b.at - a.at)
    .slice(0, FEED_SIZE);
}

// ── Transcripts ─────────────────────────────────────────────────────────────

const transcriptCache = new Map();

async function readTranscript(file, tailBytes, eventLimit) {
  const st = await stat(file).catch(() => null);
  if (!st) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = transcriptCache.get(file);
  if (hit?.key === key) return hit.value;
  const value = digest(await readTailRecords(file, tailBytes, eventLimit), eventLimit);
  transcriptCache.set(file, { key, value });
  return value;
}

// Transcripts can be hundreds of MB; only the tail matters. Widen the window
// while huge records (screenshots, big tool results) crowd out the turns we want.
async function readTailRecords(file, bytes, wantAssistant) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    for (let want = bytes; ; want *= 4) {
      const start = Math.max(0, size - want);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // first line is partial
      const records = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // partially-written last line
        }
      }
      const assistant = records.filter((r) => r.type === 'assistant').length;
      if (start === 0 || want >= MAX_TAIL_BYTES || assistant >= wantAssistant) return records;
    }
  } finally {
    await fh.close();
  }
}

function digest(records, eventLimit) {
  const d = {
    title: null,
    lastPrompt: null,
    model: null,
    contextTokens: null,
    gitBranch: null,
    lastActivityAt: null,
    finished: false,
    last: null,
    events: [],
  };
  const push = (r, i, kind, fields) => {
    const e = { id: `${r.uuid}:${i}`, at: Date.parse(r.timestamp) || null, kind, ...fields };
    d.events.push(e);
    d.last = e;
  };
  const userText = (r, i, text = '') => {
    const t = text.trim();
    if (t.startsWith('<command-name>')) push(r, i, 'cmd', { text: t.match(/<command-name>\s*([^<]*)/)?.[1] ?? '' });
    else if (t.startsWith('<task-notification>'))
      push(r, i, 'notify', { text: clean(t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? 'Background task update', 200) });
    else if (t.startsWith('[Request interrupted')) push(r, i, 'interrupt', { text: '' });
    else if (t && !t.startsWith('<')) {
      push(r, i, 'prompt', { text: clean(t, 280) });
      d.lastPrompt = clean(t, 400);
    }
  };

  for (const r of records) {
    if (r.timestamp) d.lastActivityAt = Date.parse(r.timestamp) || d.lastActivityAt;
    if (r.gitBranch) d.gitBranch = r.gitBranch;

    if (r.type === 'ai-title') d.title = r.aiTitle;
    else if (r.type === 'last-prompt' && r.lastPrompt) d.lastPrompt = clean(r.lastPrompt, 400);
    else if (r.type === 'assistant') {
      const m = r.message ?? {};
      if (m.model && !m.model.startsWith('<')) d.model = m.model;
      if (m.usage) {
        const u = m.usage;
        d.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
      (Array.isArray(m.content) ? m.content : []).forEach((c, i) => {
        if (c.type === 'tool_use') push(r, i, 'tool', { tool: c.name, text: describeToolInput(c.name, c.input) });
        else if (c.type === 'text' && c.text?.trim()) push(r, i, 'say', { text: clean(unmarkdown(c.text), 240) });
        else if (c.type === 'thinking' || c.type === 'redacted_thinking')
          d.last = { kind: 'thinking', at: Date.parse(r.timestamp) || null };
      });
      d.finished = m.stop_reason === 'end_turn';
    } else if (r.type === 'user' && !r.isMeta) {
      d.finished = false;
      const content = r.message?.content;
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      parts.forEach((c, i) => {
        if (c.type === 'text') userText(r, i, c.text);
        else if (c.type === 'tool_result' && c.is_error) push(r, i, 'err', { text: clean(resultText(c.content), 200) });
      });
    } else if (r.type === 'system' && r.subtype === 'turn_duration') {
      push(r, 0, 'done', { ms: r.durationMs ?? null });
    }
  }
  d.events = d.events.slice(-eventLimit);
  return d;
}

function describeToolInput(name, input = {}) {
  const text = (() => {
    switch (name) {
      case 'Bash':
        return input.description || firstLine(input.command);
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
        return tildify(input.file_path);
      case 'NotebookEdit':
        return tildify(input.notebook_path);
      case 'Grep':
        return `${input.pattern ?? ''}${input.path ? ` in ${tildify(input.path)}` : ''}`;
      case 'Glob':
        return input.pattern;
      case 'Agent':
      case 'Task':
        return input.description || input.prompt;
      case 'WebFetch':
        return input.url;
      case 'WebSearch':
        return input.query;
      case 'Skill':
        return input.skill;
      case 'TodoWrite':
        return `${input.todos?.length ?? 0} todos`;
      default:
        return Object.values(input ?? {}).find((v) => typeof v === 'string');
    }
  })();
  return clean(text ?? '', 180);
}

const resultText = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text ?? '').join(' ') : '';

const unmarkdown = (s) => s.replace(/\*\*|__|`/g, '').replace(/^\s*#+\s*/gm, '');

const firstLine = (s = '') => String(s).split('\n').find((l) => l.trim()) ?? '';

// Transcripts can contain credentials; mask the obvious shapes before they reach the page.
function redact(s) {
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1•••@')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|xox[abpr]-[A-Za-z0-9-]{8,})/g, '•••')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)["']?[^\s"']+/gi, '$1$2•••');
}

function clean(s, max) {
  const flat = redact(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Processes ───────────────────────────────────────────────────────────────

let processWarning = null;

// pid → { pid, ppid, cpu, rssKB, uptimeSec, tty, command }. Empty when the process
// list can't be read; sessions are then checked one by one (see bareProcess).
async function processTable() {
  try {
    return process.platform === 'win32' ? await windowsProcesses() : await unixProcesses();
  } catch (err) {
    if (processWarning !== err.message) console.warn(`Can't list processes (${err.message}); CPU and memory will show 0.`);
    processWarning = err.message;
    return new Map();
  }
}

// Liveness without a process list: signal 0 checks the pid exists without touching it.
function bareProcess(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return null;
  }
  return { pid, ppid: 0, cpu: 0, rssKB: 0, uptimeSec: 0, tty: '?', command: 'claude' };
}

async function unixProcesses() {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,tty=,command='], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const procs = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.set(+m[1], {
      pid: +m[1],
      ppid: +m[2],
      cpu: +m[3],
      rssKB: +m[4],
      uptimeSec: parseEtime(m[5]),
      tty: m[6],
      command: m[7],
    });
  }
  return procs;
}

// Windows has no `ps`; CIM gives everything but a cheap CPU %, which stays 0.
async function windowsProcesses() {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { $age = 0; if ($_.CreationDate) { $age = [int]((Get-Date) - $_.CreationDate).TotalSeconds }; ' +
    '$cmd = $_.CommandLine; if (-not $cmd) { $cmd = $_.Name }; "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$age`t$cmd" }';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const procs = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ppid, bytes, age, ...command] = line.split('\t');
    if (!/^\d+$/.test(pid ?? '')) continue;
    procs.set(+pid, { pid: +pid, ppid: +ppid, cpu: 0, rssKB: Number(bytes) / 1024 || 0, uptimeSec: +age || 0, tty: '?', command: command.join('\t') });
  }
  return procs;
}

// ps etime: [[dd-]hh:]mm:ss
function parseEtime(s) {
  const [days, clock] = s.includes('-') ? s.split('-') : ['0', s];
  const parts = clock.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function childrenOf(procs) {
  const children = new Map();
  for (const p of procs.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  return children;
}

function* walk(children, root) {
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    yield pid;
    stack.push(...(children.get(pid) ?? []));
  }
}

function treeStats(procs, children, root) {
  let cpu = 0;
  let rssKB = 0;
  let processCount = 0;
  for (const pid of walk(children, root)) {
    const p = procs.get(pid);
    if (!p) continue;
    cpu += p.cpu;
    rssKB += p.rssKB;
    processCount++;
  }
  return { cpu, rssMB: rssKB / 1024, processCount, uptimeSec: procs.get(root)?.uptimeSec ?? 0 };
}

function binaryOf(command) {
  const [first = '', second = ''] = command.split(/\s+/, 2);
  const name = (p) => path.basename(p.replace(/^"|"$/g, '')).replace(/\.(exe|cmd)$/i, '');
  const base = name(first);
  return /^(node|bun|python[\d.]*)$/.test(base) && second ? name(second) : base;
}

const hostApp = (command) =>
  /\/\.cursor\//.test(command) ? 'Cursor' : /\/\.vscode\//.test(command) ? 'VS Code' : /\/\.windsurf\//.test(command) ? 'Windsurf' : null;

function collectOthers(procs, children, sessionPids) {
  const groups = new Map();
  for (const p of procs.values()) {
    if (sessionPids.has(p.pid)) continue;
    const bin = binaryOf(p.command);
    const def = OTHER_AGENTS.find((d) => d.app?.test(p.command) || bin === d.bin);
    if (!def) continue;
    // Count each tree once: skip workers forked by a process of the same kind.
    const parent = procs.get(p.ppid);
    if (def.bin && parent && binaryOf(parent.command) === def.bin) continue;

    const g = groups.get(def.id) ?? { id: def.id, label: def.label, instances: [] };
    g.instances.push({ pid: p.pid, host: hostApp(p.command), ...treeStats(procs, children, p.pid) });
    groups.set(def.id, g);
  }
  return [...groups.values()].map((g) => ({
    id: g.id,
    label: g.label,
    count: g.instances.length,
    pids: g.instances.map((i) => i.pid),
    hosts: [...new Set(g.instances.map((i) => i.host).filter(Boolean))],
    cpu: g.instances.reduce((n, i) => n + i.cpu, 0),
    rssMB: g.instances.reduce((n, i) => n + i.rssMB, 0),
    uptimeSec: Math.max(...g.instances.map((i) => i.uptimeSec)),
  }));
}

// ── Utilities ───────────────────────────────────────────────────────────────

const lastGoodJson = new Map();

// Session files are rewritten in place; keep the last parse that succeeded.
async function readJson(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    lastGoodJson.set(file, value);
    return value;
  } catch {
    return lastGoodJson.get(file) ?? null;
  }
}

const exists = (file) => stat(file).then(() => true, () => false);

const tildify = (p) => (typeof p === 'string' && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
