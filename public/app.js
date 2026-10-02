// Agent Radar client: streams snapshots from /api/stream and renders the
// radar scope, the session deck and the wire (a merged live event feed).

const $ = (sel, root = document) => root.querySelector(sel);
const TAU = Math.PI * 2;

const STATUS = {
  busy: { label: 'Working', tone: 'busy' },
  shell: { label: 'Shell', tone: 'shell' },
  idle: { label: 'Idle', tone: 'idle' },
};
const statusOf = (s) => STATUS[s.status] ?? { label: s.status, tone: 'other' };

const state = {
  snap: null,
  filter: 'all',
  cards: new Map(), // pid → card element
  wireItems: new Map(), // event id → <li>
  wirePrimed: false, // first render shouldn't animate the whole backlog
  lastFrameAt: 0,
};

// ── Formatting ──────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const clip = (s, n) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function span(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ago = (ms) => {
  const sec = (Date.now() - ms) / 1000;
  return sec < 5 ? 'just now' : `${span(sec)} ago`;
};
const tokens = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const memory = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

// claude-opus-5-5 → Opus 5.5 · claude-sonnet-4-5-20250929 → Sonnet 4.5
function shortModel(id) {
  if (!id) return '—';
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
}

// mcp__claude_ai_Vercel__list_projects → Vercel · list_projects
function prettyTool(name = '') {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1].replace(/^claude_ai_|^plugin_[^_]+_/, '').replace(/_/g, ' ')} · ${m[2]}` : name;
}

const TOOL_GLYPH = { Bash: '$', Read: '◧', Write: '✎', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎', Grep: '⌕', Glob: '⌕', WebSearch: '⌕', WebFetch: '↓', Agent: '⑂', Task: '⑂', Skill: '✦', TodoWrite: '☰' };
const KIND_GLYPH = { prompt: '›', say: '“', done: '✓', err: '✕', cmd: '/', notify: '◆', interrupt: '‖' };

const glyph = (e) =>
  e.kind === 'tool' ? TOOL_GLYPH[e.tool] ?? (e.tool?.startsWith('mcp__') ? '⧉' : '▸') : KIND_GLYPH[e.kind] ?? '·';

function eventLine(e) {
  switch (e.kind) {
    case 'tool': return [prettyTool(e.tool), e.text];
    case 'prompt': return [e.sub ? 'Brief' : 'You', e.text];
    case 'say': return ['Claude', e.text];
    case 'done': return ['Turn complete', e.ms ? `in ${span(e.ms / 1000)}` : ''];
    case 'err': return ['Tool error', e.text];
    case 'cmd': return ['Command', e.text];
    case 'notify': return ['Notice', e.text];
    case 'interrupt': return ['Interrupted', ''];
    default: return [e.kind, e.text ?? ''];
  }
}

const toolLine = (e) => (e.text ? `${prettyTool(e.tool)} — ${e.text}` : prettyTool(e.tool));

// What is this agent doing this second? → [verb, detail]
function nowLine(s) {
  const last = s.transcript?.last;
  if (s.status === 'busy') {
    if (last?.kind === 'thinking') return ['Thinking', 'reasoning about the next step'];
    if (last?.kind === 'tool') return ['Running', toolLine(last)];
    if (last?.kind === 'say') return ['Writing', last.text];
    if (last?.kind === 'prompt') return ['Reading', last.text];
    return ['Working', last?.text ?? ''];
  }
  if (s.status === 'shell') return ['Shell', 'shell session in the foreground'];
  if (s.status === 'idle') return ['Waiting', 'for your next prompt'];
  return [statusOf(s).label, ''];
}

const lastSeen = (s) => s.transcript?.lastActivityAt ?? s.statusSince ?? s.startedAt;

// ── DOM helpers ─────────────────────────────────────────────────────────────

// Only touch the DOM when the markup actually changed (keeps hover, selection
// and scroll positions stable across 2-second refreshes).
function setHTML(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

// Relative times are filled in by the 1s ticker, so markup stays stable.
function refreshTimes(root = document) {
  for (const el of root.querySelectorAll('time[data-ago]')) el.textContent = ago(Number(el.dataset.ago));
  for (const el of root.querySelectorAll('time[data-since]')) el.textContent = span((Date.now() - Number(el.dataset.since)) / 1000);
}

// ── Readouts & other agents ─────────────────────────────────────────────────

function renderReadouts(snap) {
  const { sessions, totals } = snap;
  const busy = sessions.filter((s) => s.status === 'busy').length;
  const subs = sessions.flatMap((s) => s.subagents);
  const running = subs.filter((a) => a.state === 'running').length;
  const context = sessions.reduce((n, s) => n + (s.transcript?.contextTokens ?? 0), 0);

  setHTML(
    $('#readouts'),
    `<div class="readout"><span class="r-num">${sessions.length}</span><span class="r-label">Claude sessions live</span></div>
     <div class="readout hot"><span class="r-num">${busy}</span><span class="r-label">working right now</span></div>
     <div class="readout cool"><span class="r-num">${running}<small>/${subs.length}</small></span><span class="r-label">subagents running · 6h</span></div>
     <div class="readout"><span class="r-num">${tokens(context)}</span><span class="r-label">tokens held in context</span></div>
     <p class="r-sys">Agents are using <b>${totals.cpu.toFixed(0)}% cpu</b> and <b>${memory(totals.rssMB)}</b> across
       <b>${totals.processes}</b> processes · load ${snap.loadavg.map((n) => n.toFixed(2)).join(' ')} on ${snap.cores} cores</p>`,
  );
  document.title = busy ? `(${busy}) Agent Radar` : 'Agent Radar';
}

function renderOthers(others) {
  const order = ['claude-desktop', 'codex', 'claude-headless', 'cursor', 'chatgpt', 'windsurf', 'gemini', 'aider', 'ollama', 'copilot'];
  const sorted = [...others].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  setHTML(
    $('#others'),
    sorted.length
      ? `<span class="others-label">Also on this machine</span>` +
          sorted
            .map(
              (o) => `<div class="chip">
                <b>${esc(o.label)}${o.count > 1 ? `<i>×${o.count}</i>` : ''}</b>
                <span>${o.hosts.length ? `inside ${esc(o.hosts.join(', '))} · ` : ''}up ${span(o.uptimeSec)}</span>
                <span>${o.cpu.toFixed(1)}% cpu · ${memory(o.rssMB)}</span>
              </div>`,
            )
            .join('')
      : '',
  );
}

// ── Session cards ───────────────────────────────────────────────────────────

const RANK = { busy: 0, shell: 1 };
const bySignal = (a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2) || lastSeen(b) - lastSeen(a);

const matchesFilter = (s) =>
  state.filter === 'all' || (state.filter === 'busy' ? s.status === 'busy' : s.status !== 'busy');

function createCard(pid) {
  const el = document.createElement('article');
  el.className = 'card enter';
  el.dataset.pid = pid;
  el.addEventListener('animationend', (e) => e.target === el && el.classList.remove('enter'));
  el.innerHTML = `
    <header class="card-head"></header>
    <p class="card-title"></p>
    <p class="card-path"></p>
    <div class="card-now"></div>
    <dl class="gauges"></dl>
    <ul class="subs"></ul>
    <blockquote class="card-prompt sensitive"></blockquote>
    <details class="card-log"><summary></summary><ol class="log"></ol></details>`;
  return el;
}

function updateCard(el, s) {
  const st = statusOf(s);
  const t = s.transcript ?? {};
  const [verb, detail] = nowLine(s);

  const tone = `tone-${st.tone}`;
  if (el.dataset.tone !== tone) {
    if (el.dataset.tone) el.classList.remove(el.dataset.tone);
    el.classList.add(tone);
    el.dataset.tone = tone;
  }
  el.hidden = !matchesFilter(s);

  setHTML(
    $('.card-head', el),
    `<span class="lamp"></span><h3 title="${esc(s.name)}">${esc(s.name)}</h3><span class="tag">${esc(st.label)}</span><span class="pid">pid ${s.pid}</span>`,
  );
  setHTML($('.card-title', el), esc(t.title || 'Untitled session'));
  setHTML(
    $('.card-path', el),
    `${esc(s.cwdShort)}${t.gitBranch ? `<span class="branch">⎇ ${esc(t.gitBranch)}</span>` : ''}` +
      (s.version ? `<span class="branch">claude v${esc(s.version)}</span>` : ''),
  );
  setHTML(
    $('.card-now', el),
    `<span class="now-k">${esc(verb)}</span><span class="now-v sensitive" title="${esc(detail)}">${esc(detail)}</span>` +
      (s.status !== 'busy' && t.lastActivityAt ? `<time data-ago="${t.lastActivityAt}"></time>` : ''),
  );
  setHTML(
    $('.gauges', el),
    [
      ['model', esc(shortModel(t.model))],
      ['context', tokens(t.contextTokens)],
      ['uptime', `<time data-since="${s.startedAt}"></time>`],
      ['cpu', `${s.cpu.toFixed(1)}%`],
      ['memory', memory(s.rssMB)],
      ['procs', s.processCount],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join(''),
  );
  setHTML($('.subs', el), s.subagents.map(subagentHTML).join(''));
  setHTML($('.card-prompt', el), t.lastPrompt ? `› ${esc(clip(t.lastPrompt, 180))}` : '');

  const log = $('.card-log', el);
  setHTML($('summary', log), `Activity log · last ${s.events.length}`);
  setHTML($('.log', log), [...s.events].reverse().map(logItemHTML).join(''));
}

function subagentHTML(a) {
  const now =
    a.state === 'running' && a.last
      ? `${glyph(a.last)} ${a.last.kind === 'tool' ? toolLine(a.last) : eventLine(a.last)[1] || 'thinking'}`
      : '';
  return `<li class="sub sub-${a.state}" title="${esc(a.state)}${a.background ? ' · background' : ''}">
      <span class="sub-lamp"></span>
      <span class="sub-type">${esc(a.type)}</span>
      <span class="sub-desc">${esc(a.description || a.id)}</span>
      <time data-ago="${a.lastActivityAt}"></time>
      ${now ? `<span class="sub-now sensitive">${esc(now)}</span>` : ''}
    </li>`;
}

function logItemHTML(e) {
  const [label, text] = eventLine(e);
  return `<li class="k-${e.kind}">
      <time>${e.at ? clock(e.at) : ''}</time>
      <span class="g">${esc(glyph(e))}</span>
      <span><b>${esc(label)}</b> <span class="sensitive">${esc(text)}</span></span>
    </li>`;
}

function renderSessions(sessions) {
  const deck = $('#sessions');
  const live = new Set();
  sessions.forEach((s, i) => {
    live.add(s.pid);
    let el = state.cards.get(s.pid);
    if (!el) {
      el = createCard(s.pid);
      el.style.setProperty('--i', i);
      state.cards.set(s.pid, el);
    }
    updateCard(el, s);
    if (deck.children[i] !== el) deck.insertBefore(el, deck.children[i] ?? null);
  });
  for (const [pid, el] of state.cards) {
    if (!live.has(pid)) {
      el.remove();
      state.cards.delete(pid);
    }
  }
  $('#empty').hidden = sessions.length > 0;

  const busy = sessions.filter((s) => s.status === 'busy').length;
  const counts = { all: sessions.length, busy, idle: sessions.length - busy };
  for (const b of document.querySelectorAll('[data-count]')) b.textContent = counts[b.dataset.count];
}

// ── The wire ────────────────────────────────────────────────────────────────

function renderWire(feed) {
  const list = $('#wire');
  const keep = new Set();
  feed.forEach((e, i) => {
    keep.add(e.id);
    let li = state.wireItems.get(e.id);
    if (!li) {
      const [label, text] = eventLine(e);
      li = document.createElement('li');
      li.className = `wire-item k-${e.kind}${e.sub ? ' from-sub' : ''}${state.wirePrimed ? ' fresh' : ''}`;
      li.dataset.pid = e.pid;
      li.innerHTML = `<time>${clock(e.at)}</time>
        <span class="w-agent">${esc(e.agent)}</span>
        <span class="w-body"><span class="g">${esc(glyph(e))}</span><b>${esc(label)}</b> <span class="sensitive">${esc(text)}</span></span>`;
      state.wireItems.set(e.id, li);
    }
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  for (const [id, li] of state.wireItems) {
    if (!keep.has(id)) {
      li.remove();
      state.wireItems.delete(id);
    }
  }
  state.wirePrimed = true;
}

// ── Theme ───────────────────────────────────────────────────────────────────

const THEME_IDS = ['midnight', 'control', 'phosphor', 'daylight'];
const THEME_COLORS = ['bg', 'raised', 'text', 'muted', 'faint', 'hot', 'calm', 'sub', 'alert',
  'grass', 'grass-dark', 'path', 'path-edge', 'plaster', 'timber', 'stone', 'brick', 'window-lit', 'helmet', 'overalls', 'face',
  'glove', 'joint', 'metal', 'wood', 'leaf', 'trunk', 'rock', 'blueprint', 'hemi-sky', 'key-color',
  'roof-1', 'roof-2', 'roof-3', 'roof-4', 'roof-5', 'roof-6'];
const THEME_NUMBERS = ['window-glow', 'hemi-intensity', 'key-intensity', 'rim-intensity', 'exposure'];
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// The canvases read the same custom properties as the CSS, so one theme styles everything.
function readTheme() {
  const css = getComputedStyle(document.documentElement);
  const theme = {};
  for (const key of THEME_COLORS) theme[camel(key)] = css.getPropertyValue(`--${key}`).trim();
  for (const key of THEME_NUMBERS) theme[camel(key)] = parseFloat(css.getPropertyValue(`--${key}`));
  return theme;
}

// '#ffb547' → '255,181,71' for rgba() strings
function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${n >> 16},${(n >> 8) & 255},${n & 255}`;
}

// ── Radar scope ─────────────────────────────────────────────────────────────

const HORIZON_SEC = 6 * 3600;
// Log scale: working agents sit near the centre, long-idle ones at the rim.
const radiusFor = (ageSec) => 0.13 + 0.81 * Math.min(1, Math.log1p(Math.max(0, ageSec) / 10) / Math.log1p(HORIZON_SEC / 10));
const RINGS = [[60, '1m'], [600, '10m'], [3600, '1h'], [HORIZON_SEC, '6h+']];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

// Sessions in the same project share a bearing, fanned out slightly by name.
const bearingFor = (s) => hash(s.cwd ?? '') * TAU + (hash(s.name) - 0.5) * 0.6;

class Scope {
  constructor(canvas, tip, onPick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tip = tip;
    this.blips = new Map();
    this.hover = null;
    this.size = 0;
    this.t0 = performance.now();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.setTheme(readTheme());

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => this.pointer(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('click', () => this.hover && onPick(this.hover.pid));

    if (!this.reduced) {
      const loop = (t) => {
        this.draw(t);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  setTheme(theme) {
    const [hot, calm, text, muted, sub, raised, bg] = [theme.hot, theme.calm, theme.text, theme.muted, theme.sub, theme.raised, theme.bg].map(rgbOf);
    this.c = { hot, calm, text, muted, sub, raised, bg, status: { busy: hot, idle: calm, shell: text } };
    if (this.reduced) this.draw(performance.now());
  }

  resize() {
    const { width } = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(width * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = width;
    if (this.reduced) this.draw(performance.now());
  }

  update(sessions) {
    const now = Date.now();
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.pid);
      const tr = radiusFor(s.status === 'busy' ? 0 : (now - lastSeen(s)) / 1000);
      const ta = bearingFor(s);
      const b = this.blips.get(s.pid) ?? { pid: s.pid, r: tr, a: ta };
      Object.assign(b, {
        tr,
        ta,
        session: s,
        subs: s.subagents.filter((a) => a.state === 'running').length,
      });
      this.blips.set(s.pid, b);
    }
    for (const pid of this.blips.keys()) if (!seen.has(pid)) this.blips.delete(pid);
    if (this.hover && !this.blips.has(this.hover.pid)) this.setHover(null);
    if (this.reduced) this.draw(performance.now());
  }

  pointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = null;
    let bestD = 14;
    for (const b of this.blips.values()) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD) (best = b), (bestD = d);
    }
    this.setHover(best, x, y);
  }

  setHover(b, x = 0, y = 0) {
    this.hover = b;
    this.canvas.style.cursor = b ? 'pointer' : 'crosshair';
    this.tip.hidden = !b;
    if (b) {
      const s = b.session;
      const [verb, detail] = nowLine(s);
      this.tip.innerHTML = `<b>${esc(s.name)}</b><span>${esc(verb)} · ${esc(clip(detail, 90))}</span><br><span>${esc(s.cwdShort)}</span>`;
      this.tip.style.left = `${x}px`;
      this.tip.style.top = `${y}px`;
    }
    if (this.reduced) this.draw(performance.now());
  }

  draw(t) {
    const { ctx, size, c } = this;
    if (!size) return;
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 14;
    const secs = (t - this.t0) / 1000;
    ctx.clearRect(0, 0, size, size);

    // face
    const face = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    face.addColorStop(0, `rgba(${c.hot},0.07)`);
    face.addColorStop(0.7, `rgba(${c.raised},0.55)`);
    face.addColorStop(1, `rgba(${c.bg},0.2)`);
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();

    // crosshair
    ctx.strokeStyle = `rgba(${c.calm},0.09)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // range rings
    ctx.font = '400 9px "Martian Mono", ui-monospace, monospace';
    for (const [age, label] of RINGS) {
      const r = radiusFor(age) * R;
      ctx.strokeStyle = `rgba(${c.calm},0.16)`;
      ctx.setLineDash(age === HORIZON_SEC ? [] : [2, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(${c.muted},0.75)`;
      ctx.fillText(label, cx + 5, cy - r - 4);
    }

    // rim + bearing ticks
    ctx.strokeStyle = `rgba(${c.text},0.24)`;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU;
      const len = i % 6 === 0 ? 8 : 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len));
      ctx.stroke();
    }

    // sweep: one revolution every 4s, with a fading wake
    const sweep = this.reduced ? -Math.PI / 2 : ((secs * TAU) / 4) % TAU;
    if (!this.reduced && ctx.createConicGradient) {
      const wake = 1.2;
      const g = ctx.createConicGradient(sweep - wake, cx, cy);
      g.addColorStop(0, `rgba(${c.hot},0)`);
      g.addColorStop(wake / TAU, `rgba(${c.hot},0.2)`);
      g.addColorStop(Math.min(1, wake / TAU + 0.0005), `rgba(${c.hot},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweep - wake, sweep);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(${c.hot},0.65)`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
      ctx.stroke();
    }

    // blips
    for (const b of this.blips.values()) {
      const ease = this.reduced ? 1 : 0.07;
      b.r += (b.tr - b.r) * ease;
      b.a += Math.atan2(Math.sin(b.ta - b.a), Math.cos(b.ta - b.a)) * ease;
      const x = cx + Math.cos(b.a) * b.r * R;
      const y = cy + Math.sin(b.a) * b.r * R;
      b.x = x;
      b.y = y;

      const status = b.session.status;
      const rgb = c.status[status] ?? c.muted;
      const busy = status === 'busy';
      // phosphor persistence: brightest just after the sweep passes
      const behind = (((sweep - b.a) % TAU) + TAU) % TAU;
      const glow = this.reduced ? 1 : 0.4 + 0.6 * (1 - behind / TAU);

      if (busy && !this.reduced) {
        const p = (secs % 1.6) / 1.6;
        ctx.strokeStyle = `rgba(${rgb},${(1 - p) * 0.7})`;
        ctx.beginPath();
        ctx.arc(x, y, 5 + p * 20, 0, TAU);
        ctx.stroke();
      }

      ctx.shadowColor = `rgba(${rgb},0.9)`;
      ctx.shadowBlur = busy ? 18 : 8 * glow;
      ctx.fillStyle = `rgba(${rgb},${busy ? 1 : glow})`;
      ctx.beginPath();
      ctx.arc(x, y, busy ? 5 : 3.5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;

      for (let k = 0; k < b.subs; k++) {
        const sa = secs * 1.6 + (k * TAU) / b.subs;
        ctx.fillStyle = `rgba(${c.sub},0.95)`;
        ctx.beginPath();
        ctx.arc(x + Math.cos(sa) * 12, y + Math.sin(sa) * 12, 2, 0, TAU);
        ctx.fill();
      }

      if (busy || b === this.hover) {
        ctx.font = '500 10px "Martian Mono", ui-monospace, monospace';
        ctx.fillStyle = `rgba(${busy ? c.hot : c.text},0.95)`;
        const label = b.session.name;
        const w = ctx.measureText(label).width;
        const lx = x + 10 + w > size ? x - 10 - w : x + 10;
        ctx.fillText(label, lx, y - 8);
      }
    }
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function pick(pid) {
  const el = state.cards.get(pid);
  if (!el) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().then(() => pick(pid));
    return;
  }
  if (el.hidden) setFilter('all');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

const scope = new Scope($('#scope'), $('#scope-tip'), pick);

// The WebGL village loads separately so a missing GPU never takes the dashboard down.
let floor = null;
import('./floor.js')
  .then(({ Floor }) => {
    floor = new Floor($('#floor'), { onPick: pick, toolLabel: prettyTool, legend: $('#floor-modes'), theme: readTheme() });
    if (state.snap) floor.update([...state.snap.sessions].sort(bySignal), state.snap.saved);
  })
  .catch((err) => {
    console.warn('3D village unavailable:', err);
    $('#floor').classList.add('no-webgl');
    $('.floor-fallback').hidden = false;
    $('#floor-full').hidden = true;
  });

$('#floor-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#floor').requestFullscreen?.();
});

function render() {
  const snap = state.snap;
  if (!snap) return;
  const sessions = [...snap.sessions].sort(bySignal);
  $('#host').textContent = snap.host;
  renderReadouts(snap);
  renderOthers(snap.others);
  renderSessions(sessions);
  renderWire(snap.feed);
  scope.update(sessions);
  floor?.update(sessions, snap.saved);
  refreshTimes();
}

function setFilter(filter) {
  state.filter = filter;
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  render();
}

for (const b of document.querySelectorAll('[data-filter]')) b.addEventListener('click', () => setFilter(b.dataset.filter));

$('#wire').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-pid]');
  if (li) pick(Number(li.dataset.pid));
});

function setTheme(id) {
  if (!THEME_IDS.includes(id)) id = THEME_IDS[0];
  document.documentElement.dataset.theme = id;
  localStorage.setItem('agent-radar:theme', id);
  for (const b of document.querySelectorAll('[data-theme-id]')) b.setAttribute('aria-pressed', String(b.dataset.themeId === id));
  const theme = readTheme();
  scope.setTheme(theme);
  floor?.setTheme(theme);
}
setTheme(document.documentElement.dataset.theme);
for (const b of document.querySelectorAll('[data-theme-id]')) b.addEventListener('click', () => setTheme(b.dataset.themeId));

const privacy = $('#privacy');
function setPrivacy(on) {
  document.body.classList.toggle('private', on);
  privacy.setAttribute('aria-pressed', String(on));
  localStorage.setItem('agent-radar:private', on ? '1' : '');
}
setPrivacy(localStorage.getItem('agent-radar:private') === '1');
privacy.addEventListener('click', () => setPrivacy(!document.body.classList.contains('private')));

function setLink(mode, text) {
  const el = $('#link');
  el.dataset.state = mode;
  el.textContent = text;
}

const stream = new EventSource('/api/stream');
stream.onmessage = (e) => {
  state.snap = JSON.parse(e.data);
  state.lastFrameAt = Date.now();
  setLink('live', 'Live');
  render();
};
stream.onerror = () => setLink('lost', 'Reconnecting'); // EventSource retries on its own

setInterval(() => {
  $('#clock').textContent = clock(Date.now());
  if (state.lastFrameAt && Date.now() - state.lastFrameAt > 8000) setLink('lost', 'Stale');
  refreshTimes();
}, 1000);
