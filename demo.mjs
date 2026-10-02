// Made-up sessions for `agent-radar --demo`: lets anyone try the dashboard
// without Claude Code running, and keeps real prompts out of screenshots.
// Same snapshot shape as collector.mjs + village.mjs produce.

const T0 = Date.now();
const STEP_MS = 3500; // one script step every few seconds while a session works
const MAX_TOKENS = 870_000;
const MODEL = 'claude-opus-5-5';
const HOME = '/home/you';

// What each demo session does, step by step, on a loop.
// [kind, tool or text, text]: kinds as in the real transcript digest.
const SCRIPTS = {
  checkout: [
    ['prompt', 'Redesign the checkout page: one column, sticky order summary'],
    ['tool', 'Glob', 'src/checkout/**/*.tsx'],
    ['tool', 'Read', '~/code/storefront/src/checkout/Checkout.tsx'],
    ['thinking'],
    ['tool', 'Agent', 'Find every place cart totals are computed'],
    ['tool', 'Edit', '~/code/storefront/src/checkout/Checkout.tsx'],
    ['tool', 'Write', '~/code/storefront/src/checkout/OrderSummary.tsx'],
    ['tool', 'Bash', 'Run the checkout tests'],
    ['say', 'The summary now sticks below the header and totals match the cart.'],
    ['done', 48_000],
  ],
  limits: [
    ['prompt', 'Add rate limiting to the public API'],
    ['tool', 'Grep', 'rateLimit in src'],
    ['tool', 'Read', '~/code/payments-api/src/middleware/index.ts'],
    ['thinking'],
    ['tool', 'Write', '~/code/payments-api/src/middleware/limit.ts'],
    ['tool', 'Bash', 'Run the middleware tests'],
    ['err', 'Expected 429, received 200 (limit.test.ts:42)'],
    ['tool', 'Edit', '~/code/payments-api/src/middleware/limit.ts'],
    ['tool', 'Bash', 'Run the middleware tests'],
    ['say', 'Requests over 100 a minute now get a 429 with a Retry-After header.'],
    ['done', 61_000],
  ],
  search: [
    ['prompt', 'Product search should match typos'],
    ['tool', 'WebSearch', 'fuzzy search postgres trigram'],
    ['tool', 'Read', '~/code/storefront/src/search/query.ts'],
    ['thinking'],
    ['tool', 'Edit', '~/code/storefront/db/migrations/0042_trigram.sql'],
    ['tool', 'Bash', 'Apply the migration locally'],
    ['say', 'Searching "snekers" now finds sneakers.'],
    ['done', 37_000],
  ],
  webhook: [
    ['prompt', 'The webhook retry test fails about once in ten runs'],
    ['tool', 'Read', '~/code/payments-api/test/webhooks.test.ts'],
    ['tool', 'Bash', 'Run the webhook test 50 times'],
    ['say', 'The test raced the retry timer; it now waits for the queue to drain.'],
    ['done', 92_000],
  ],
  handbook: [
    ['prompt', 'Rewrite the onboarding guide for new engineers'],
    ['tool', 'Read', '~/code/handbook/onboarding.md'],
    ['tool', 'Write', '~/code/handbook/onboarding.md'],
    ['say', 'Rewritten as a day-one checklist plus a week-one reading list.'],
    ['done', 140_000],
  ],
  darkmode: [
    ['prompt', 'Dark mode for the settings screens'],
    ['tool', 'Edit', '~/code/mobile-app/src/theme/colors.ts'],
    ['tool', 'Bash', 'Build the iOS app'],
    ['say', 'Settings follow the system theme now.'],
    ['done', 75_000],
  ],
};

// cycle: [seconds working, seconds idle] on a loop · idleFor: fixed idle time
const SESSIONS = [
  { id: 'demo-checkout', pid: 41021, name: 'storefront-a1', dir: 'storefront', branch: 'feat/checkout', title: 'Checkout page redesign', script: 'checkout', tokens: 240_000, rate: 2600, cycle: [70, 15], offset: 5, helpers: true },
  { id: 'demo-search', pid: 41388, name: 'storefront-d4', dir: 'storefront', branch: 'feat/search', title: 'Typo-tolerant product search', script: 'search', tokens: 60_000, rate: 3200, cycle: [40, 30], offset: 22 },
  { id: 'demo-limits', pid: 40211, name: 'payments-api-7f', dir: 'payments-api', branch: 'main', title: 'API rate limiting', script: 'limits', tokens: 130_000, rate: 2100, cycle: [45, 25], offset: 50 },
  { id: 'demo-webhook', pid: 39876, name: 'payments-api-c2', dir: 'payments-api', branch: 'fix/webhook-retry', title: 'Fix flaky webhook test', script: 'webhook', tokens: 410_000, idleFor: 4 * 60 },
  { id: 'demo-handbook', pid: 38554, name: 'handbook-e9', dir: 'handbook', branch: 'main', title: 'Onboarding guide rewrite', script: 'handbook', tokens: 90_000, idleFor: 2.5 * 3600 },
  { id: 'demo-darkmode', pid: 37702, name: 'mobile-app-3b', dir: 'mobile-app', branch: 'feat/dark-mode', title: 'Dark mode for settings', script: 'darkmode', tokens: 560_000, idleFor: 9 * 60, shell: true },
];

const SAVED = [
  { id: 'demo-saved-1', name: 'storefront-91', dir: 'storefront', title: 'Cart rounding bug', contextTokens: 610_000, age: 26 * 3600 },
  { id: 'demo-saved-2', name: 'payments-api-4a', dir: 'payments-api', title: 'Stripe SDK upgrade', contextTokens: 330_000, age: 3 * 3600 },
  { id: 'demo-saved-3', name: 'handbook-02', dir: 'handbook', title: 'API reference pages', contextTokens: 180_000, age: 50 * 3600 },
];

export function demoSnapshot() {
  const now = Date.now();
  const sessions = SESSIONS.map((spec) => session(spec, now));
  const feed = sessions
    .flatMap((s) => s.events.map((e) => ({ ...e, agent: s.name, pid: s.pid })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 80);
  const busy = sessions.filter((s) => s.status === 'busy').length;
  return {
    generatedAt: now,
    host: 'demo-machine',
    cores: 10,
    loadavg: [1.2 + busy * 0.4, 1.6, 1.9],
    totals: {
      cpu: sessions.reduce((n, s) => n + s.cpu, 0) + 4,
      rssMB: sessions.reduce((n, s) => n + s.rssMB, 0) + 700,
      processes: sessions.reduce((n, s) => n + s.processCount, 0) + 9,
    },
    sessions,
    others: [
      { id: 'codex', label: 'Codex', count: 1, pids: [], hosts: [], cpu: 1.4, rssMB: 120, uptimeSec: 3 * 3600 },
      { id: 'cursor', label: 'Cursor', count: 1, pids: [], hosts: [], cpu: 2.6, rssMB: 540, uptimeSec: 7 * 3600 },
    ],
    feed,
    saved: SAVED.map(({ id, name, dir, title, contextTokens, age }) => ({
      id,
      name,
      title,
      project: dir,
      cwd: `${HOME}/code/${dir}`,
      model: MODEL,
      contextTokens,
      since: T0 - (age + 3 * 3600) * 1000,
      closedAt: T0 - age * 1000,
    })),
  };
}

function session(spec, now) {
  const elapsed = (now - T0) / 1000 + (spec.offset ?? 0);
  let busy = false;
  let workedSec; // total time spent working, drives tokens and script position
  let lastActivityAt;
  let statusSince;
  let stepAt; // when script step k happened; fixed, like real transcript timestamps
  if (spec.cycle) {
    const [work, rest] = spec.cycle;
    const phase = elapsed % (work + rest);
    busy = phase < work;
    workedSec = Math.floor(elapsed / (work + rest)) * work + Math.min(phase, work);
    lastActivityAt = busy ? now : now - (phase - work) * 1000;
    statusSince = busy ? now - phase * 1000 : lastActivityAt;
    stepAt = (k) => {
      const w = (k * STEP_MS) / 1000;
      return T0 + (Math.floor(w / work) * (work + rest) + (w % work) - (spec.offset ?? 0)) * 1000;
    };
  } else {
    workedSec = (SCRIPTS[spec.script].length - 1) * (STEP_MS / 1000);
    lastActivityAt = T0 - spec.idleFor * 1000;
    statusSince = lastActivityAt;
    stepAt = (k) => lastActivityAt - (SCRIPTS[spec.script].length - 1 - k) * STEP_MS;
  }

  const script = SCRIPTS[spec.script];
  const step = Math.floor((workedSec * 1000) / STEP_MS);
  const events = [];
  let last = null;
  let lastPrompt = null;
  for (let k = Math.max(0, step - 14); k <= step; k++) {
    const [kind, a, b] = script[k % script.length];
    const at = stepAt(k);
    if (kind === 'thinking') {
      last = { kind, at };
      continue;
    }
    const e = { id: `${spec.id}:${k}`, at, kind };
    if (kind === 'tool') Object.assign(e, { tool: a, text: b });
    else if (kind === 'done') e.ms = a;
    else e.text = a;
    if (kind === 'prompt') lastPrompt = a;
    events.push(e);
    last = e;
  }

  const startedAt = T0 - (3600 + spec.tokens / 400) * 1000;
  const wobble = Math.sin(now / 1500 + spec.pid);
  return {
    pid: spec.pid,
    sessionId: spec.id,
    buildingId: spec.id,
    buildingSince: startedAt,
    name: spec.name,
    cwd: `${HOME}/code/${spec.dir}`,
    cwdShort: `~/code/${spec.dir}`,
    project: spec.dir,
    status: busy ? 'busy' : spec.shell ? 'shell' : 'idle',
    statusSince,
    kind: 'interactive',
    entrypoint: 'cli',
    version: '2.1.0',
    startedAt,
    tty: 'ttys00' + (spec.pid % 9),
    cpu: busy ? 18 + 9 * wobble : 0.2,
    rssMB: 240 + (spec.tokens / 4000) + (busy ? 60 : 0),
    processCount: busy ? 7 : 4,
    uptimeSec: (now - startedAt) / 1000,
    transcript: {
      title: spec.title,
      lastPrompt,
      model: MODEL,
      contextTokens: Math.min(MAX_TOKENS, Math.round(spec.tokens + (spec.rate ?? 0) * workedSec)),
      gitBranch: spec.branch,
      lastActivityAt,
      finished: !busy,
      last,
    },
    events: events.slice(-24),
    subagents: spec.helpers ? helpers(busy, now) : [],
  };
}

// A delegating session's subagents: one exploring while it works, one finished reviewer.
function helpers(busy, now) {
  return [
    {
      id: 'agent-explore',
      type: 'Explore',
      description: 'Find every place cart totals are computed',
      background: false,
      state: busy ? 'running' : 'done',
      startedAt: now - 90_000,
      lastActivityAt: busy ? now : now - 30_000,
      model: MODEL,
      last: { kind: 'tool', tool: 'Grep', text: 'cartTotal in src', at: now },
      events: [],
    },
    {
      id: 'agent-review',
      type: 'code-reviewer',
      description: 'Review the order summary component',
      background: true,
      state: 'done',
      startedAt: now - 40 * 60_000,
      lastActivityAt: now - 25 * 60_000,
      model: MODEL,
      last: null,
      events: [],
    },
  ];
}
