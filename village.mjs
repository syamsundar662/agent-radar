// Saved buildings: every conversation the radar sees keeps its building in the
// village after its session closes (or /clear starts a fresh one), frozen at the
// level it reached. Kept in data/village.json next to this file.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalTranscript } from './collector.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'village.json');
const SAVE_DELAY_MS = 5000;

let buildings = null; // id → record
let primed = false; // false until the first pass after the server starts
let written = '';
let saveTimer = null;

async function load() {
  if (buildings) return;
  try {
    const list = JSON.parse(await readFile(FILE, 'utf8'));
    buildings = new Map(list.map((b) => [b.id, b]));
  } catch (err) {
    buildings = new Map();
    if (err.code === 'ENOENT') return;
    // Keep the unreadable file instead of overwriting it on the next save.
    console.error(`${FILE} is unreadable (${err.message}); moved aside to village.json.bad`);
    await rename(FILE, `${FILE}.bad`).catch(() => {});
  }
}

// Records every live conversation and freezes the ones that ended. Adds
// `buildingSince` to each live session and `saved` (the frozen buildings) to the snapshot.
export async function trackBuildings(snap) {
  await load();
  const now = snap.generatedAt;
  const live = new Set();
  for (const s of snap.sessions) {
    live.add(s.buildingId);
    const prev = buildings.get(s.buildingId);
    const t = s.transcript;
    buildings.set(s.buildingId, {
      id: s.buildingId,
      sessionId: s.sessionId ?? null,
      name: s.name,
      title: t?.title ?? prev?.title ?? null,
      project: s.project,
      cwd: s.cwd,
      model: t?.model ?? prev?.model ?? null,
      contextTokens: t?.contextTokens ?? prev?.contextTokens ?? 0,
      // Sessions already running when the server starts date from their launch.
      since: prev?.since ?? (primed ? now : s.startedAt),
      seenAt: now,
      closedAt: null,
    });
    s.buildingSince = buildings.get(s.buildingId).since;
  }

  for (const b of buildings.values()) {
    if (live.has(b.id) || b.closedAt) continue;
    // Ended since the last pass: read the transcript once more for the final level.
    const t = b.sessionId && b.cwd ? await finalTranscript(b.sessionId, b.cwd).catch(() => null) : null;
    if (t?.contextTokens) b.contextTokens = t.contextTokens;
    if (t?.title) b.title = t.title;
    if (!b.contextTokens) buildings.delete(b.id); // never built anything
    else b.closedAt = b.seenAt;
  }
  primed = true;
  scheduleSave();

  snap.saved = [...buildings.values()]
    .filter((b) => b.closedAt)
    .map(({ id, name, title, project, cwd, model, contextTokens, since, closedAt }) => ({ id, name, title, project, cwd, model, contextTokens, since, closedAt }));
  return snap;
}

// Context grows every turn, so writes are batched; a crash loses at most a few
// seconds, and the final transcript read above covers that for closed sessions.
function scheduleSave() {
  saveTimer ??= setTimeout(async () => {
    saveTimer = null;
    const json = JSON.stringify([...buildings.values()], null, 2);
    if (json === written) return;
    try {
      await mkdir(path.dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, json);
      await rename(`${FILE}.tmp`, FILE);
      written = json;
    } catch (err) {
      console.error('saving village failed:', err);
    }
  }, SAVE_DELAY_MS);
}
