// The village: a Clash-of-Clans-style WebGL village where every Claude Code
// session is a little builder, and its building rises as the agent actually
// works — one level per 100k tokens the session holds in context, with the
// bricks of the level under construction filling in as that number grows.
// A builder's pose follows what its session is doing right now: hammering
// while it runs tools, studying plans while it reads, directing apprentices
// (its running subagents) while it delegates, napping on a crate when idle.
// Each project is a paved district with its own roof colour and signpost.
import * as THREE from 'three';

const TAU = Math.PI * 2;

// ── Theme ───────────────────────────────────────────────────────────────────

// Active theme: '#rrggbb' colours and light numbers read from the page's CSS
// variables (see readTheme in app.js), plus `dark` for choosing glow blending.
let P = null;

function usePalette(theme) {
  const n = parseInt(theme.bg.slice(1), 16);
  const luminance = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  P = { ...theme, dark: luminance < 0.4, roofs: [theme.roof1, theme.roof2, theme.roof3, theme.roof4, theme.roof5, theme.roof6] };
}

const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

const toneOf = (status, mode) =>
  mode === 'error' ? P.alert : mode === 'delegate' ? P.sub : { busy: P.hot, idle: P.calm, shell: P.text }[status] ?? P.muted;

// Additive glow reads as light on dark ground but vanishes on a light one.
function setGlowBlend(material) {
  const blending = P.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  if (material.blending === blending) return;
  material.blending = blending;
  material.needsUpdate = true;
}

// ── Scale & timing ──────────────────────────────────────────────────────────

const TOKENS_PER_LEVEL = 100_000;
const MAX_LEVELS = 8;
const LEVEL_H = 0.4;
const FOUND_H = 0.1;
const WALL = 1.24; // building width
const ROOF_H = 0.6;
const PLOT_W = 2.3;
const PLOT_D = 2.7;
const BUILDING_Z = -0.35; // building centre within its plot
const BUILDER_Z = BUILDING_Z + 1.02;
const BUILDER_SCALE = 0.62;
const APPRENTICE_SCALE = 0.44;
const DISTRICT_GAP = 1.6;
const COURSES = 5;
const PER_SIDE = 6;
const BRICKS = COURSES * PER_SIDE * 4;
const BRICK_STEP = (WALL - 0.14) / PER_SIDE;
const HIP_Y = 0.34;
const SLEEP_AFTER_MS = 10 * 60_000;
const ERROR_WINDOW_MS = 20_000;
const MAX_APPRENTICES = 3;
const HOME_VIEW = { az: Math.PI / 4, el: 0.72, zoom: 1 };
const FOLLOW_DIST = 5.2;

// Apprentices (running subagents) work the building's other walls: [x, z, facing].
const APPRENTICE_SPOTS = [
  [-1.02, BUILDING_Z + 0.1, -Math.PI / 2],
  [1.02, BUILDING_Z + 0.1, Math.PI / 2],
  [0, BUILDING_Z - 1.02, Math.PI],
];

// Target joint angles (radians) per activity; the animator eases between them
// and layers motion on top.
//   lean: torso forward · pitch: head down · yaw/roll: head turn/tilt
//   *S: shoulder swing forward · *E: elbow bend · *Z: arm inward
//   hip*/knee*: leg swing · crouch/sit: hip drop · eyes: open amount
const BASE_POSE = { lean: 0, pitch: 0, yaw: 0, roll: 0, lS: 0.1, lE: 0.25, lZ: 0.12, rS: 0.1, rE: 0.25, rZ: -0.12, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, crouch: 0, sit: 0, eyes: 1 };
const POSES = Object.fromEntries(
  Object.entries({
    type: { lean: 0.14, pitch: 0.1, lS: 0.9, lE: 0.5, lZ: 0.2, rS: 0.35, rE: 0.1, rZ: -0.1, hipL: 0.25, kneeL: -0.35, hipR: -0.12, kneeR: -0.05, crouch: 0.03 },
    read: { lean: 0.04, pitch: 0.4, lS: 0.95, lE: 1.1, lZ: 0.35, rS: 0.95, rE: 1.1, rZ: -0.35 },
    think: { lean: -0.08, pitch: -0.45, yaw: 0.2, roll: 0.12, lS: 0.5, lE: 1.3, lZ: 0.4, rS: 1.5, rE: 2.2, rZ: -0.3, hipL: 0.05, kneeL: -0.05 },
    delegate: { lean: -0.04, pitch: -0.35, yaw: 0.35, lS: 0.15, lE: 0.3, lZ: 0.15, rS: 2.8, rE: 0.2, rZ: 0.3, hipL: 0.1, kneeL: -0.1 },
    error: { lean: 0.08, pitch: 0.2, lS: 2.7, lE: 1.9, lZ: 0.5, rS: 2.7, rE: 1.9, rZ: -0.5, hipL: 0.1, kneeL: -0.2, hipR: 0.1, kneeR: -0.2, crouch: 0.04, eyes: 0.55 },
    wait: { lean: -0.03, rS: 0.25, rE: 0.5 },
    shell: { lS: 1.2, lE: 2.0, lZ: 0.6, rS: 1.2, rE: 2.0, rZ: -0.6, hipL: 0.04, hipR: -0.04 },
    sleep: { lean: -0.15, pitch: 0.55, roll: 0.12, lS: 0.15, lE: 0.4, lZ: 0.15, rS: 0.15, rE: 0.4, rZ: -0.15, hipL: 1.45, kneeL: -1.45, hipR: 1.45, kneeR: -1.45, sit: 1, eyes: 0.08 },
  }).map(([mode, pose]) => [mode, { ...BASE_POSE, ...pose }]),
);

// Builders face their wall while working on it and turn to the viewer otherwise.
const FACES_WALL = new Set(['type', 'think', 'delegate']);

// Props per activity: [mallet, plans, crate]
const PROPS = {
  type: [1, 0, 0],
  read: [0, 1, 0],
  think: [0, 0, 0],
  delegate: [1, 0, 0],
  error: [0, 0, 0],
  wait: [1, 0, 0],
  shell: [0, 0, 0],
  sleep: [0, 0, 1],
};

const MODE_LABEL = {
  type: 'Building',
  read: 'Reading plans',
  think: 'Planning',
  delegate: 'Directing apprentices',
  error: 'Hit a snag',
  wait: 'Standing by',
  shell: 'Shell',
  sleep: 'Napping',
  saved: 'Saved',
};

const READ_TOOLS = /^(Read|Grep|Glob|WebFetch|WebSearch|ToolSearch|LS|NotebookRead)$/;

function activityOf(s, now) {
  const last = s.transcript?.last;
  if (s.status === 'busy') {
    if (last?.kind === 'err' && now - last.at < ERROR_WINDOW_MS) return 'error';
    if (last?.kind === 'thinking') return 'think';
    if (last?.kind === 'prompt') return 'read';
    if (last?.kind === 'tool') {
      if (last.tool === 'Agent' || last.tool === 'Task') return 'delegate';
      if (READ_TOOLS.test(last.tool)) return 'read';
    }
    return 'type';
  }
  if (s.status === 'shell') return 'shell';
  const lastAt = s.transcript?.lastActivityAt ?? s.startedAt;
  return now - lastAt > SLEEP_AFTER_MS ? 'sleep' : 'wait';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const rand = (n, seed) => {
  const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

const angleDelta = (to, from) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const smooth = (x) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

function part(geometry, material, x, y, z, parent, shadow = true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  parent.add(m);
  return m;
}

function canvasTexture(width, height, draw, repeat = false) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (draw) draw(canvas.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Static boxes (scaffolding) merged into one geometry: one draw call per building.
function mergeBoxes(specs) {
  const pos = [];
  const nor = [];
  const uv = [];
  for (const [w, h, d, x, y, z] of specs) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x, y, z);
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    uv.push(...g.attributes.uv.array);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

function scaffoldSpecs() {
  const o = WALL / 2 + 0.11; // scaffold ring
  const f = WALL / 2 - 0.035; // timber frame posts holding the roof
  const h = LEVEL_H;
  const specs = [];
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      specs.push([0.05, h + 0.14, 0.05, x * o, (h + 0.14) / 2, z * o]);
      specs.push([0.07, h, 0.07, x * f, h / 2, z * f]);
    }
  }
  for (const y of [h * 0.45, h + 0.06]) {
    specs.push([2 * o + 0.06, 0.03, 0.09, 0, y, o], [2 * o + 0.06, 0.03, 0.09, 0, y, -o]);
    specs.push([0.09, 0.03, 2 * o + 0.06, o, y, 0], [0.09, 0.03, 2 * o + 0.06, -o, y, 0]);
  }
  return specs;
}

// Brick positions for one level, course by course around the perimeter.
function brickLayout() {
  const out = [];
  const inset = WALL / 2 - 0.045;
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const flat = new THREE.Quaternion();
  for (let c = 0; c < COURSES; c++) {
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < PER_SIDE; i++) {
        const along = (i - (PER_SIDE - 1) / 2) * BRICK_STEP + (c % 2 ? 0.045 : -0.045);
        const y = 0.04 + c * ((LEVEL_H - 0.02) / COURSES);
        const [x, z, q] = [
          [along, inset, flat],
          [inset, -along, turned],
          [-along, -inset, flat],
          [-inset, along, turned],
        ][side];
        out.push({ p: new THREE.Vector3(x, y, z), q });
      }
    }
  }
  return out;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fitText(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

// ── Shared resources ────────────────────────────────────────────────────────

let shared = null;

function resources() {
  if (shared) return shared;
  const capsule = (r, len, radial = 12) => new THREE.CapsuleGeometry(r, len, 4, radial);
  const tex = {
    glow: canvasTexture(128, 128, (g, s) => {
      const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.22, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }),
    star: canvasTexture(64, 64, (g, s) => {
      const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.3, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
      g.fillStyle = '#fff';
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const r = i % 2 ? 6 : 30;
        const a = (i * Math.PI) / 4;
        g.lineTo(s / 2 + Math.sin(a) * r, s / 2 - Math.cos(a) * r);
      }
      g.fill();
    }),
    letterZ: canvasTexture(64, 64, (g, s) => {
      g.fillStyle = '#fff';
      g.font = '800 52px "Big Shoulders Display", Impact, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('Z', s / 2, s / 2 + 2);
    }),
    grass: canvasTexture(128, 128, null, true),
    tiles: canvasTexture(128, 128, null, true),
    facades: [0, 1].map(() => canvasTexture(128, 64)),
    darkFacades: [0, 1].map(() => canvasTexture(128, 64)), // saved buildings: lights out
    lit: [0, 1].map((variant) =>
      canvasTexture(128, 64, (g, w, h) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff';
        for (const [x, y, ww, hh] of windowRects(variant)) g.fillRect(x, y, ww, hh);
      }),
    ),
    blueprint: canvasTexture(128, 88),
  };
  tex.grass.repeat.set(150, 150);
  tex.grass.anisotropy = 8;

  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  const mat = {
    face: std(P.face, { roughness: 0.6 }),
    overalls: std(P.overalls),
    helmet: std(P.helmet, { roughness: 0.4 }),
    helmetSub: std(P.sub, { roughness: 0.4 }),
    glove: std(P.glove),
    joint: std(P.joint),
    metal: std(P.metal, { metalness: 0.4, roughness: 0.4 }),
    eye: std(P.plaster, { roughness: 0.3 }),
    timber: std(P.timber),
    wood: std(P.wood, { roughness: 0.85 }),
    stone: std(P.stone, { roughness: 0.95, flatShading: true }),
    brick: std(P.brick, { roughness: 0.9 }),
    plasterTop: std(P.plaster),
    facades: tex.facades.map(
      (map, i) => new THREE.MeshStandardMaterial({ map, emissiveMap: tex.lit[i], emissive: P.windowLit, emissiveIntensity: P.windowGlow, roughness: 0.85 }),
    ),
    plans: new THREE.MeshStandardMaterial({ map: tex.blueprint, side: THREE.DoubleSide, roughness: 0.8 }),
    subAccent: new THREE.MeshBasicMaterial({ color: P.sub, toneMapped: false }),
    leaf: std(P.leaf, { flatShading: true }),
    trunk: std(P.trunk),
    rock: std(P.rock, { flatShading: true, roughness: 0.95 }),
    grass: new THREE.MeshStandardMaterial({ map: tex.grass, roughness: 1 }),
    hit: new THREE.MeshBasicMaterial({ visible: false }),
  };
  mat.levelSkins = mat.facades.map((f) => [f, f, mat.plasterTop, mat.plasterTop, f, f]);
  mat.darkSkins = tex.darkFacades
    .map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.85 }))
    .map((f) => [f, f, mat.plasterTop, mat.plasterTop, f, f]);

  const geo = {
    // builder
    belly: new THREE.SphereGeometry(0.24, 20, 16),
    button: new THREE.SphereGeometry(0.022, 8, 6),
    belt: new THREE.TorusGeometry(0.2, 0.028, 6, 24),
    head: new THREE.SphereGeometry(0.24, 24, 18),
    nose: new THREE.SphereGeometry(0.07, 14, 10),
    eye: new THREE.SphereGeometry(0.048, 12, 10),
    pupil: new THREE.SphereGeometry(0.024, 10, 8),
    mustache: capsule(0.035, 0.1, 8),
    dome: new THREE.SphereGeometry(0.26, 22, 10, 0, TAU, 0, Math.PI / 2),
    brim: new THREE.CylinderGeometry(0.3, 0.3, 0.025, 24),
    lamp: new THREE.SphereGeometry(0.045, 12, 10),
    dot: new THREE.SphereGeometry(0.03, 10, 8),
    upper: capsule(0.06, 0.06),
    fore: capsule(0.055, 0.05),
    glove: new THREE.SphereGeometry(0.085, 14, 10),
    thigh: capsule(0.07, 0.04),
    shin: capsule(0.065, 0.04),
    boot: new THREE.BoxGeometry(0.13, 0.08, 0.19),
    handle: new THREE.CylinderGeometry(0.022, 0.022, 0.42, 8),
    mallet: new THREE.CylinderGeometry(0.075, 0.075, 0.2, 14),
    plans: new THREE.PlaneGeometry(0.42, 0.3),
    crate: new THREE.BoxGeometry(0.34, 0.2, 0.3),
    // building
    foundation: new THREE.BoxGeometry(WALL + 0.3, FOUND_H, WALL + 0.3),
    levelBody: new THREE.BoxGeometry(WALL - 0.02, LEVEL_H - 0.05, WALL - 0.02),
    trim: new THREE.BoxGeometry(WALL + 0.06, 0.05, WALL + 0.06),
    brick: new THREE.BoxGeometry(BRICK_STEP - 0.012, (LEVEL_H - 0.02) / COURSES - 0.006, 0.09),
    scaffold: mergeBoxes(scaffoldSpecs()),
    roof: new THREE.ConeGeometry((WALL / 2 + 0.12) * Math.SQRT2, ROOF_H, 4, 1),
    chimney: new THREE.BoxGeometry(0.13, 0.26, 0.13),
    pole: new THREE.CylinderGeometry(0.012, 0.012, 0.36, 6),
    flag: new THREE.PlaneGeometry(0.22, 0.13),
    // plot
    pool: new THREE.PlaneGeometry(1.4, 1.4),
    ring: new THREE.RingGeometry(0.34, 0.39, 40),
    hit: new THREE.BoxGeometry(1.5, 1.4, 2.3),
    // district
    unitPlane: new THREE.PlaneGeometry(1, 1),
    signPost: new THREE.BoxGeometry(0.07, 0.8, 0.07),
    signBoard: new THREE.BoxGeometry(1.04, 0.36, 0.05),
    signFace: new THREE.PlaneGeometry(0.98, 0.31),
    // scenery
    trunk: new THREE.CylinderGeometry(0.07, 0.09, 0.4, 6),
    crown: new THREE.ConeGeometry(0.42, 0.7, 7),
    crownTop: new THREE.ConeGeometry(0.3, 0.5, 7),
    rock: new THREE.DodecahedronGeometry(0.28, 0),
  };

  shared = { geo, mat, tex, bricks: brickLayout() };
  paintThemed();
  return shared;
}

// Window rectangles on one facade face (128×64 canvas) for each variant.
function windowRects(variant) {
  return variant === 0 ? [[46, 18, 36, 30]] : [[22, 18, 28, 28], [78, 18, 28, 28]];
}

// Canvases whose colours come from the theme.
function paintThemed() {
  const { tex } = shared;

  let g = tex.grass.image.getContext('2d');
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      g.fillStyle = (x + y) % 2 ? P.grassDark : P.grass;
      g.fillRect(x * 64, y * 64, 64, 64);
    }
  }
  for (let i = 0; i < 260; i++) {
    g.fillStyle = alpha(i % 3 ? P.leaf : P.plaster, i % 3 ? 0.22 : 0.05);
    g.fillRect(rand(i, 1) * 128, rand(i, 2) * 128, 2, 4);
  }

  g = tex.tiles.image.getContext('2d');
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      g.fillStyle = P.path;
      g.fillRect(x * 64, y * 64, 64, 64);
      g.fillStyle = alpha(rand(x + y * 2, 5) > 0.5 ? P.plaster : P.joint, 0.06);
      g.fillRect(x * 64 + 3, y * 64 + 3, 58, 58);
    }
  }
  g.strokeStyle = P.pathEdge;
  g.lineWidth = 3;
  for (const v of [0, 64, 128]) {
    g.beginPath();
    g.moveTo(v, 0);
    g.lineTo(v, 128);
    g.moveTo(0, v);
    g.lineTo(128, v);
    g.stroke();
  }

  const paintFacade = (t, variant, glass) => {
    const f = t.image.getContext('2d');
    f.fillStyle = P.plaster;
    f.fillRect(0, 0, 128, 64);
    f.fillStyle = P.timber;
    f.fillRect(0, 0, 8, 64);
    f.fillRect(120, 0, 8, 64);
    f.fillRect(0, 58, 128, 6);
    f.fillRect(0, 0, 128, 5);
    for (const [x, y, w, h] of windowRects(variant)) {
      f.fillStyle = P.timber;
      f.fillRect(x - 4, y - 4, w + 8, h + 8);
      f.fillStyle = glass;
      f.fillRect(x, y, w, h);
      f.fillStyle = P.timber;
      f.fillRect(x + w / 2 - 1.5, y, 3, h);
      f.fillRect(x, y + h / 2 - 1.5, w, 3);
    }
  };
  tex.facades.forEach((t, variant) => paintFacade(t, variant, P.windowLit));
  tex.darkFacades.forEach((t, variant) => paintFacade(t, variant, P.joint));

  g = tex.blueprint.image.getContext('2d');
  g.fillStyle = P.blueprint;
  g.fillRect(0, 0, 128, 88);
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  g.lineWidth = 1;
  for (let x = 8; x < 128; x += 12) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 88);
    g.stroke();
  }
  for (let y = 8; y < 88; y += 12) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(128, y);
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 2;
  g.strokeRect(34, 26, 60, 48);
  g.beginPath();
  g.moveTo(30, 28);
  g.lineTo(64, 10);
  g.lineTo(98, 28);
  g.stroke();

  for (const t of [tex.grass, tex.tiles, ...tex.facades, ...tex.darkFacades, tex.blueprint]) t.needsUpdate = true;
}

// ── A builder (main builder or apprentice) ─────────────────────────────────

class Rig {
  constructor({ accent, helmet, glow = null, seed, scale }) {
    const { geo, mat } = resources();
    this.phase = rand(seed, 3) * TAU;
    this.mode = 'wait';
    this.pose = { ...POSES.wait };
    this.props = { mallet: 1, plans: 0, crate: 0 };
    this.thinking = 0;
    this.hop = 0;
    this.nextBlink = 0;
    this.blinkAt = -1;
    this.lastSwing = 0;
    this.root = new THREE.Group();
    this.root.scale.setScalar(scale);

    // Faces -z; origin between the boots.
    const body = (this.body = new THREE.Group());
    body.position.y = HIP_Y;
    this.root.add(body);
    this.legs = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.position.x = side * 0.11;
      body.add(hip);
      part(geo.thigh, mat.overalls, 0, -0.09, 0, hip);
      const knee = new THREE.Group();
      knee.position.y = -0.15;
      hip.add(knee);
      part(geo.shin, mat.overalls, 0, -0.07, 0, knee);
      part(geo.boot, mat.joint, 0, -0.15, -0.03, knee);
      return { hip, knee };
    });

    const torso = (this.torso = new THREE.Group());
    body.add(torso);
    part(geo.belly, mat.overalls, 0, 0.2, 0, torso).scale.set(1, 0.92, 0.85);
    const belt = part(geo.belt, mat.timber, 0, 0.07, 0, torso);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(1, 0.85, 1);
    for (const side of [-1, 1]) part(geo.button, helmet, side * 0.09, 0.33, -0.19, torso, false);

    const neck = (this.neck = new THREE.Group());
    neck.position.y = 0.4;
    torso.add(neck);
    part(geo.head, mat.face, 0, 0.2, 0, neck);
    part(geo.nose, mat.face, 0, 0.16, -0.24, neck);
    this.eyes = [-1, 1].map((side) => {
      const eye = new THREE.Group();
      eye.position.set(side * 0.09, 0.245, -0.2);
      neck.add(eye);
      part(geo.eye, mat.eye, 0, 0, 0, eye, false).scale.set(1, 1.25, 0.6);
      part(geo.pupil, mat.joint, 0, -0.005, -0.026, eye, false);
      return eye;
    });
    for (const side of [-1, 1]) {
      const m = part(geo.mustache, mat.timber, side * 0.075, 0.105, -0.215, neck, false);
      m.rotation.z = side * 1.25;
    }
    part(geo.dome, helmet, 0, 0.27, 0, neck);
    part(geo.brim, helmet, 0, 0.27, -0.03, neck);
    this.tip = part(geo.lamp, accent, 0, 0.4, -0.22, neck, false);
    if (glow) {
      const sprite = new THREE.Sprite(glow);
      sprite.scale.setScalar(0.34);
      this.tip.add(sprite);
    }
    this.thought = new THREE.Group();
    this.thought.position.y = 0.72;
    this.thought.scale.setScalar(0.001);
    neck.add(this.thought);
    for (let i = 0; i < 3; i++) {
      const dot = part(geo.dot, accent, Math.cos((i * TAU) / 3) * 0.2, i * 0.03, Math.sin((i * TAU) / 3) * 0.2, this.thought, false);
      dot.scale.setScalar(0.8 + i * 0.3);
    }

    const arm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.26, 0.3, 0);
      torso.add(shoulder);
      part(geo.upper, mat.overalls, 0, -0.09, 0, shoulder);
      const elbow = new THREE.Group();
      elbow.position.y = -0.17;
      shoulder.add(elbow);
      part(geo.fore, mat.face, 0, -0.07, 0, elbow);
      part(geo.glove, mat.glove, 0, -0.15, 0, elbow);
      return { shoulder, elbow };
    };
    this.armL = arm(-1);
    this.armR = arm(1);

    this.mallet = new THREE.Group();
    this.mallet.position.y = -0.15;
    this.armR.elbow.add(this.mallet);
    part(geo.handle, mat.wood, 0, 0, -0.19, this.mallet).rotation.x = Math.PI / 2;
    part(geo.mallet, mat.metal, 0, 0, -0.39, this.mallet).rotation.z = Math.PI / 2;
    this.plans = part(geo.plans, mat.plans, 0, 0.3, -0.36, torso);
    this.plans.rotation.x = -1.0;
    this.crate = part(geo.crate, mat.wood, 0, 0.1, 0.2, this.root);
  }

  // Returns true on the frame the mallet lands.
  animate(t, dt, motion) {
    const k = 1 - Math.exp(-dt * 6);
    const target = POSES[this.mode];
    for (const key in target) this.pose[key] += (target[key] - this.pose[key]) * k;
    const p = { ...this.pose };
    const ph = this.phase;
    const m = motion;
    let struck = false;
    switch (this.mode) {
      case 'type': {
        const s = (t * 1.7 + ph) % 1;
        const raise = (s < 0.72 ? smooth(s / 0.72) : 1 - ((s - 0.72) / 0.28) ** 2) * m;
        p.rS += 1.95 * raise;
        p.rE += 0.65 * raise;
        p.lean += 0.06 - 0.1 * raise;
        p.pitch -= 0.12 * raise;
        if (m && s < this.lastSwing) struck = true;
        this.lastSwing = s;
        break;
      }
      case 'read':
        p.yaw += Math.sin(t * 1.5 + ph) * 0.3 * m;
        p.pitch += Math.sin(t * 0.6 + ph) * 0.05 * m;
        break;
      case 'think':
        p.yaw += Math.sin(t * 0.7 + ph) * 0.2 * m;
        p.rE += Math.max(0, Math.sin(t * 5)) * 0.08 * m;
        break;
      case 'delegate':
        p.rZ += Math.sin(t * 7 + ph) * 0.35 * m;
        p.rE += Math.sin(t * 7 + ph + 1) * 0.2 * m;
        break;
      case 'error':
        p.yaw += Math.sin(t * 13) * 0.3 * m;
        break;
      case 'wait':
        p.yaw += Math.sin(t * 0.45 + ph) * 0.55 * m;
        p.hipL += Math.sin(t * 0.8 + ph) * 0.05 * m;
        p.hipR -= Math.sin(t * 0.8 + ph) * 0.05 * m;
        break;
      case 'shell':
        p.yaw += Math.sin(t * 0.5 + ph) * 0.25 * m;
        p.kneeR -= Math.max(0, Math.sin(t * 5 + ph)) * 0.15 * m; // impatient foot tap
        break;
      case 'sleep':
        p.pitch += Math.sin(t * 0.5 + ph) * 0.06 * m;
        p.roll += Math.sin(t * 0.35 + ph) * 0.05 * m;
        break;
    }

    this.hop *= Math.exp(-dt * 4);
    const sleeping = this.mode === 'sleep';
    this.body.position.y =
      HIP_Y - p.crouch - p.sit * 0.08 + Math.sin(t * (sleeping ? 1.2 : 2.1) + ph) * (sleeping ? 0.01 : 0.006) * m + Math.sin(this.hop * Math.PI) * 0.2;
    this.body.position.z = p.sit * 0.2;
    this.torso.rotation.x = -p.lean;
    this.neck.rotation.set(-p.pitch, p.yaw, p.roll);
    this.armL.shoulder.rotation.set(p.lS, 0, p.lZ);
    this.armL.elbow.rotation.x = p.lE;
    this.armR.shoulder.rotation.set(p.rS, 0, p.rZ);
    this.armR.elbow.rotation.x = p.rE;
    this.legs[0].hip.rotation.x = p.hipL;
    this.legs[0].knee.rotation.x = p.kneeL;
    this.legs[1].hip.rotation.x = p.hipR;
    this.legs[1].knee.rotation.x = p.kneeR;

    if (t > this.nextBlink) {
      this.blinkAt = t;
      this.nextBlink = t + 2.2 + Math.random() * 4;
    }
    const open = Math.max(0.08, p.eyes * (t - this.blinkAt < 0.12 ? 0.1 : 1));
    for (const eye of this.eyes) eye.scale.y = open;

    const [mallet, plans, crate] = PROPS[this.mode];
    this.props.mallet += (mallet - this.props.mallet) * k;
    this.props.plans += (plans - this.props.plans) * k;
    this.props.crate += (crate - this.props.crate) * k;
    this.mallet.scale.setScalar(Math.max(0.001, this.props.mallet));
    this.plans.scale.setScalar(Math.max(0.001, this.props.plans));
    this.crate.scale.setScalar(Math.max(0.001, this.props.crate));
    this.thinking += ((this.mode === 'think' ? 1 : 0) - this.thinking) * k;
    this.thought.scale.setScalar(Math.max(0.001, this.thinking));
    this.thought.rotation.y = t * 2.4 * m;
    return struck;
  }
}

// ── A building that rises with its builder's session ───────────────────────

class Building {
  constructor(worker) {
    const { geo, mat, tex, bricks } = resources();
    this.worker = worker;
    this.group = new THREE.Group();
    this.group.position.z = BUILDING_Z;
    worker.root.add(this.group);
    part(geo.foundation, mat.stone, 0, FOUND_H / 2, 0, this.group);

    this.levels = [];
    this.falling = [];
    this.lit = true;
    this.target = 0;
    this.targetFill = 0;
    this.fill = 0;
    this.nextStep = 0;
    this.shownBricks = 0;
    this.popping = [];
    this.smokeLevel = 0;
    this.m4 = new THREE.Matrix4();
    this.scale3 = new THREE.Vector3();

    // the level under construction: timber frame, scaffold, bricks, roof
    this.top = new THREE.Group();
    this.top.position.y = FOUND_H;
    this.group.add(this.top);
    this.scaffold = part(geo.scaffold, mat.wood, 0, 0, 0, this.top);
    this.bricks = new THREE.InstancedMesh(geo.brick, mat.brick, BRICKS);
    this.bricks.castShadow = this.bricks.receiveShadow = true;
    bricks.forEach(({ p, q }, i) => this.bricks.setMatrixAt(i, this.m4.compose(p, q, this.scale3.set(1, 1, 1))));
    this.bricks.count = 0;
    this.top.add(this.bricks);

    this.roofMat = new THREE.MeshStandardMaterial({ color: P.roofs[0], roughness: 0.55, flatShading: true });
    this.roof = new THREE.Group();
    this.roof.position.y = LEVEL_H;
    this.top.add(this.roof);
    part(geo.roof, this.roofMat, 0, ROOF_H / 2, 0, this.roof).rotation.y = Math.PI / 4;
    part(geo.chimney, mat.stone, 0.26, ROOF_H * 0.42, 0.14, this.roof);
    part(geo.pole, mat.wood, 0, ROOF_H + 0.16, 0, this.roof);
    this.flag = new THREE.Group();
    this.flag.position.y = ROOF_H + 0.27;
    this.roof.add(this.flag);
    part(geo.flag, worker.accent, 0.11, 0, 0, this.flag, false);

    this.smoke = [0, 1, 2].map(() => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.glow, color: P.plaster, transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false;
      this.roof.add(s);
      return s;
    });
  }

  setTarget(tokens) {
    const exact = tokens / TOKENS_PER_LEVEL;
    this.target = Math.min(MAX_LEVELS, Math.floor(exact));
    this.targetFill = this.target >= MAX_LEVELS ? 1 : exact - Math.floor(exact);
  }

  setRoofColor(hex) {
    this.roofMat.color.set(hex);
  }

  applyTheme() {
    for (const s of this.smoke) s.material.color.set(P.plaster);
    if (this.worker.district) this.setRoofColor(this.worker.district.roofColor);
  }

  skin(i) {
    const { mat } = resources();
    const skins = this.lit ? mat.levelSkins : mat.darkSkins;
    return skins[i % skins.length];
  }

  // Windows go dark once the session has ended.
  setLit(on) {
    if (on === this.lit) return;
    this.lit = on;
    this.levels.forEach((level, i) => (level.userData.body.material = this.skin(i)));
  }

  addLevel() {
    const { geo, mat } = resources();
    const i = this.levels.length;
    const level = new THREE.Group();
    level.position.y = FOUND_H + i * LEVEL_H;
    level.scale.y = 0.01;
    level.userData.body = part(geo.levelBody, this.skin(i), 0, (LEVEL_H - 0.05) / 2, 0, level);
    part(geo.trim, mat.timber, 0, LEVEL_H - 0.025, 0, level);
    this.group.add(level);
    this.levels.push(level);
  }

  setBricks(n, t) {
    const { bricks } = resources();
    if (n > this.shownBricks) for (let i = this.shownBricks; i < n; i++) this.popping.push({ i, t0: t });
    this.shownBricks = n;
    this.bricks.count = n;
    if (!this.popping.length) return;
    this.popping = this.popping.filter(({ i, t0 }) => {
      if (i >= n) return false;
      const k = Math.min(1, (t - t0) / 0.35);
      const s = k < 1 ? 0.2 + 0.8 * smooth(k) + Math.sin(k * Math.PI) * 0.25 : 1;
      this.bricks.setMatrixAt(i, this.m4.compose(bricks[i].p, bricks[i].q, this.scale3.set(s, s, s)));
      return k < 1;
    });
    this.bricks.instanceMatrix.needsUpdate = true;
  }

  // Returns true when a level completes.
  animate(t, dt, motion, busy) {
    const n = this.levels.length;
    let goal = this.targetFill;
    if (n < this.target) goal = 1;
    else if (n > this.target) {
      goal = 1;
      if (t >= this.nextStep) {
        this.falling.push(this.levels.pop());
        this.fill = 1;
        this.nextStep = t + 0.12;
      }
    }
    // catching up (first load, big jumps) is quick; live growth tracks the tokens
    const rate = this.levels.length === this.target ? 1.2 : 7;
    this.fill += (goal - this.fill) * Math.min(1, dt * rate);
    let leveled = false;
    if (this.levels.length < this.target && this.fill > 0.97) {
      this.addLevel();
      this.fill = 0;
      leveled = true;
    }
    this.setBricks(Math.round(this.fill * BRICKS), t);

    const topGoal = FOUND_H + this.levels.length * LEVEL_H;
    this.top.position.y += (topGoal - this.top.position.y) * Math.min(1, dt * 6);
    for (const level of this.levels) if (level.scale.y < 1) level.scale.y = Math.min(1, level.scale.y + dt * 4);
    this.falling = this.falling.filter((level) => {
      level.scale.y -= dt * 5;
      if (level.scale.y > 0.02) return true;
      level.removeFromParent();
      return false;
    });
    this.scaffold.visible = !(this.levels.length >= MAX_LEVELS && this.fill > 0.99);

    // chimney smoke while the builder works; the flag always flutters
    this.smokeLevel += ((busy ? 1 : 0) - this.smokeLevel) * Math.min(1, dt * 2);
    this.smoke.forEach((s, i) => {
      s.visible = this.smokeLevel > 0.01;
      if (!s.visible) return;
      const p = (t * 0.45 + i / 3) % 1;
      s.position.set(0.26 + Math.sin(p * 5 + i) * 0.05, ROOF_H * 0.42 + 0.18 + p * 0.7, 0.14);
      s.scale.setScalar(0.14 + p * 0.3);
      s.material.opacity = (1 - p) * 0.55 * this.smokeLevel;
    });
    this.flag.rotation.y = Math.sin(t * 4 + this.worker.phase) * 0.35 * motion;
    return leveled;
  }

  // Top of the roof, in the worker's plot coordinates.
  roofTop() {
    return this.top.position.y + LEVEL_H + ROOF_H;
  }

  targetRoofTop() {
    return FOUND_H + (this.target + 1) * LEVEL_H + ROOF_H;
  }

  dispose() {
    this.roofMat.dispose();
    this.bricks.dispose();
    for (const s of this.smoke) s.material.dispose();
  }
}

// ── One Claude conversation: builder + building + apprentices ───────────────
// When the session ends the builder packs up and the building stays as it was.

class Worker {
  constructor(village, id) {
    const { geo, mat, tex } = resources();
    this.village = village;
    this.id = id;
    this.pid = null;
    this.seed = Math.floor(hash(id) * 997) + 1;
    this.phase = rand(this.seed, 3) * TAU;
    this.district = null;
    this.slot = { x: 0, z: 0 };
    this.placed = false;
    this.appear = 0;
    this.leaving = false;
    this.saved = false; // session ended, building kept
    this.crew = 0; // builder presence, eased
    this.poofPending = false;
    this.mode = null;
    this.hovered = false;
    this.pct = -1;
    this.lv = '';
    this.tone = new THREE.Color(P.calm);
    this.targetTone = new THREE.Color(P.calm);
    this.scratch = new THREE.Vector3();

    this.accent = new THREE.MeshBasicMaterial({ color: P.calm, toneMapped: false, side: THREE.DoubleSide });
    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false };
    this.glowMat = new THREE.SpriteMaterial({ map: tex.glow, color: P.calm, ...additive });
    this.poolMat = new THREE.MeshBasicMaterial({ map: tex.glow, color: P.calm, opacity: 0.1, ...additive });
    this.ringMat = new THREE.MeshBasicMaterial({ color: P.text, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });

    this.root = new THREE.Group();
    this.root.scale.setScalar(0.001);
    this.building = new Building(this);
    this.rig = new Rig({ accent: this.accent, helmet: mat.helmet, glow: this.glowMat, seed: this.seed, scale: BUILDER_SCALE });
    this.rig.root.position.z = BUILDER_Z;
    this.root.add(this.rig.root);
    this.apprentices = [];
    this.apprenticeTarget = 0;

    const pool = part(geo.pool, this.poolMat, 0, 0.006, BUILDER_Z, this.root, false);
    pool.rotation.x = -Math.PI / 2;
    const ring = part(geo.ring, this.ringMat, 0, 0.008, BUILDER_Z, this.root, false);
    ring.rotation.x = -Math.PI / 2;

    const sprite = (map, color, glowing) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, opacity: 0, depthWrite: false, toneMapped: !glowing }));
      s.visible = false;
      this.root.add(s);
      return s;
    };
    this.sparks = Array.from({ length: 7 }, () => ({ sprite: sprite(tex.glow, P.hot, true), v: new THREE.Vector3(), life: 0 }));
    this.stars = Array.from({ length: 18 }, () => ({ sprite: sprite(tex.star, P.helmet, true), v: new THREE.Vector3(), life: 0 }));
    this.zs = Array.from({ length: 3 }, () => sprite(tex.letterZ, P.calm, false));
    this.puffs = Array.from({ length: 6 }, () => sprite(tex.glow, P.plaster, false));
    this.poofAt = null;

    this.hit = part(geo.hit, mat.hit, 0, 0.7, 0, this.root, false);
    this.hit.userData.station = this;

    this.label = document.createElement('button');
    this.label.type = 'button';
    this.label.className = 'floor-label';
    this.label.innerHTML = '<span class="fl-top"><i class="fl-lv"></i><b></b></span><span class="fl-line sensitive"></span><span class="fl-bar"><i></i></span>';
    this.el = {
      lv: this.label.querySelector('.fl-lv'),
      name: this.label.querySelector('b'),
      line: this.label.querySelector('.fl-line'),
      bar: this.label.querySelector('.fl-bar i'),
    };
    this.label.addEventListener('click', () => (this.saved ? village.follow(this) : village.onPick(this.pid)));
    village.labels.appendChild(this.label);

    this.applyBlends();
  }

  applyBlends() {
    for (const m of [this.glowMat, this.poolMat, ...this.sparks.map((s) => s.sprite.material), ...this.stars.map((s) => s.sprite.material)]) setGlowBlend(m);
  }

  applyTheme() {
    this.applyBlends();
    for (const s of this.sparks) s.sprite.material.color.set(P.hot);
    for (const s of this.stars) s.sprite.material.color.set(P.helmet);
    for (const z of this.zs) z.material.color.set(P.calm);
    for (const p of this.puffs) p.material.color.set(P.plaster);
    this.building.applyTheme();
    if (this.saved) this.setSaved(this.record);
    else this.setSession(this.session, Date.now());
    this.tone.copy(this.targetTone);
  }

  assign(district, index) {
    if (this.district !== district) {
      this.root.removeFromParent();
      district.group.add(this.root);
      this.district = district;
      this.placed = false;
      this.building.setRoofColor(district.roofColor);
    }
    const [x, z] = district.slotFor(index);
    this.slot = { x, z };
    if (!this.placed) {
      this.root.position.set(x, 0, z);
      this.placed = true;
    }
  }

  setSession(s, now) {
    this.session = s;
    this.pid = s.pid;
    if (this.saved) {
      // a resumed conversation: its builder comes back to the same building
      this.saved = false;
      this.poofPending = true;
      this.building.setLit(true);
      this.label.removeAttribute('title');
    }
    const mode = activityOf(s, now);
    if (mode !== this.mode) {
      // a little hop when a builder springs back to work
      if (this.mode && s.status === 'busy' && (this.mode === 'wait' || this.mode === 'sleep')) this.rig.hop = 1;
      this.mode = mode;
      this.rig.mode = mode;
    }
    this.apprenticeTarget = Math.min(MAX_APPRENTICES, s.subagents.filter((a) => a.state === 'running').length);
    this.targetTone.set(toneOf(s.status, mode));
    this.building.setTarget(s.transcript?.contextTokens ?? 0);

    const last = s.transcript?.last;
    const line = s.status === 'busy' && last?.kind === 'tool' ? `${MODE_LABEL[mode]} · ${this.village.toolLabel(last.tool)}` : MODE_LABEL[mode];
    if (this.el.name.textContent !== s.name) this.el.name.textContent = s.name;
    if (this.el.line.textContent !== line) this.el.line.textContent = line;
    const cls = `floor-label tone-${['busy', 'idle', 'shell'].includes(s.status) ? s.status : 'other'} m-${mode}${this.hovered ? ' is-hover' : ''}${
      this.label.classList.contains('levelup') ? ' levelup' : ''
    }`;
    if (this.label.className !== cls) this.label.className = cls;
  }

  // b: { name, title, project, contextTokens, closedAt } from the server's saved list
  setSaved(b) {
    this.record = b;
    if (!this.saved) {
      this.saved = true;
      this.session = null;
      this.poofPending = this.mode !== null; // only when a live builder leaves, not on page load
      this.building.setLit(false);
    }
    this.mode = 'saved';
    this.apprenticeTarget = 0;
    this.targetTone.set(P.muted);
    this.building.setTarget(b.contextTokens ?? 0);

    const line = clip(b.title || 'Saved', 34);
    if (this.el.name.textContent !== b.name) this.el.name.textContent = b.name;
    if (this.el.line.textContent !== line) this.el.line.textContent = line;
    const tip = `${b.title || b.name}\n${b.project} · closed ${new Date(b.closedAt).toLocaleString()}`;
    if (this.label.title !== tip) this.label.title = tip;
    const cls = `floor-label tone-saved m-saved${this.hovered ? ' is-hover' : ''}`;
    if (this.label.className !== cls) this.label.className = cls;
  }

  setHovered(on) {
    this.hovered = on;
    this.label.classList.toggle('is-hover', on);
  }

  setCutaway(on) {
    this.cut = on;
    this.building.group.visible = !on;
  }

  animate(t, dt) {
    const m = this.village.motion;
    const k = 1 - Math.exp(-dt * 6);
    this.appear += ((this.leaving ? 0 : 1) - this.appear) * (1 - Math.exp(-dt * 5));
    this.root.scale.setScalar(Math.max(0.001, this.appear));
    this.root.position.x += (this.slot.x - this.root.position.x) * k;
    this.root.position.z += (this.slot.z - this.root.position.z) * k;

    if (this.poofPending) {
      this.poofPending = false;
      this.poof(0, BUILDER_Z, t);
    }
    this.crew += ((this.saved ? 0 : 1) - this.crew) * Math.min(1, dt * 5);
    this.rig.root.visible = this.crew > 0.01;
    this.rig.root.scale.setScalar(Math.max(0.001, this.crew) * BUILDER_SCALE);
    const facing = FACES_WALL.has(this.mode) ? 0 : Math.PI;
    this.rig.root.rotation.y += angleDelta(facing, this.rig.root.rotation.y) * Math.min(1, dt * 5);
    if (this.rig.root.visible && this.rig.animate(t, dt, m) && !this.saved) this.strike();
    const busy = !this.saved && this.session.status === 'busy';
    if (this.building.animate(t, dt, m, busy) && this.village.ready && !this.saved) this.levelUp();

    this.tone.lerp(this.targetTone, k);
    for (const mat of [this.accent, this.glowMat, this.poolMat, this.ringMat]) mat.color.copy(this.tone);
    this.glowMat.opacity = busy ? 0.55 + 0.45 * Math.max(0, Math.sin(t * 6 + this.phase)) * m : 0.3;
    const pool = this.saved ? 0 : busy ? 0.5 : this.mode === 'sleep' ? 0.05 : 0.14;
    this.poolMat.opacity += (pool - this.poolMat.opacity) * k;
    const marked = this.hovered || this.village.followed === this;
    this.ringMat.opacity += ((marked ? 0.85 : 0) - this.ringMat.opacity) * Math.min(1, k * 2);

    this.animateApprentices(t, dt, m);
    this.animateParticles(t, dt, m);
  }

  animateApprentices(t, dt, m) {
    const { mat } = resources();
    const n = this.apprenticeTarget;
    while (this.apprentices.length < n) {
      const i = this.apprentices.length;
      const rig = new Rig({ accent: mat.subAccent, helmet: mat.helmetSub, seed: this.seed * 7 + i, scale: APPRENTICE_SCALE });
      rig.mode = 'type';
      const [x, z, rot] = APPRENTICE_SPOTS[i];
      rig.root.position.set(x, 0, z);
      rig.root.rotation.y = rot;
      rig.root.scale.setScalar(0.001);
      this.root.add(rig.root);
      this.apprentices.push({ rig, s: 0, present: false });
    }
    this.apprentices.forEach((a, i) => {
      const want = i < n;
      if (want !== a.present) {
        a.present = want;
        this.poof(a.rig.root.position.x, a.rig.root.position.z, t);
      }
      a.s += ((want ? 1 : 0) - a.s) * Math.min(1, dt * 5);
      a.rig.root.visible = a.s > 0.01;
      a.rig.root.scale.setScalar(Math.max(0.001, a.s * APPRENTICE_SCALE));
      if (a.rig.root.visible) a.rig.animate(t, dt, m);
    });
  }

  poof(x, z, t) {
    this.poofAt = { x, z, t0: t };
  }

  strike() {
    // mallet meets the front wall
    const x = 0.2 * BUILDER_SCALE;
    const y = 0.5 * BUILDER_SCALE;
    const z = BUILDER_Z - 0.6 * BUILDER_SCALE;
    for (const s of this.sparks) {
      s.sprite.position.set(x, y, z);
      s.v.set((Math.random() - 0.5) * 1.1, 0.6 + Math.random() * 1.1, 0.3 + Math.random() * 0.7);
      s.life = 0.35 + Math.random() * 0.2;
    }
  }

  levelUp() {
    const y = this.building.roofTop() - ROOF_H * 0.4;
    for (const s of this.stars) {
      const a = Math.random() * TAU;
      s.sprite.position.set(0, y, BUILDING_Z);
      s.v.set(Math.cos(a) * (0.6 + Math.random() * 0.8), 1.2 + Math.random() * 1.2, Math.sin(a) * (0.6 + Math.random() * 0.8));
      s.life = 0.9 + Math.random() * 0.4;
    }
    this.rig.hop = 1;
    this.label.classList.remove('levelup');
    void this.label.offsetWidth; // restart the animation
    this.label.classList.add('levelup');
    clearTimeout(this.levelUpTimer);
    this.levelUpTimer = setTimeout(() => this.label.classList.remove('levelup'), 1700);
  }

  animateParticles(t, dt, m) {
    const burst = (list, gravity, size) => {
      for (const s of list) {
        s.life -= dt;
        s.sprite.visible = s.life > 0;
        if (!s.sprite.visible) continue;
        s.sprite.position.addScaledVector(s.v, dt);
        s.v.y -= gravity * dt;
        s.sprite.material.opacity = Math.min(1, s.life * 3);
        s.sprite.scale.setScalar(size * (0.4 + s.life));
      }
    };
    burst(this.sparks, 4, 0.08);
    burst(this.stars, 1.5, 0.34);

    const sleep = this.mode === 'sleep' && m > 0;
    const headY = (this.rig.body.position.y + 0.6) * BUILDER_SCALE;
    this.zs.forEach((z, i) => {
      z.visible = sleep;
      if (!sleep) return;
      const p = (t * 0.28 + i / 3 + this.phase) % 1;
      z.position.set(0.08 + p * 0.25 + Math.sin(p * 6) * 0.03, headY + 0.25 + p * 0.6, BUILDER_Z - 0.12);
      z.scale.setScalar(0.09 + p * 0.12);
      z.material.opacity = Math.sin(p * Math.PI) * 0.9;
    });

    const poof = this.poofAt;
    const age = poof ? (t - poof.t0) / 0.7 : 1;
    this.puffs.forEach((puff, i) => {
      puff.visible = age < 1;
      if (!puff.visible) return;
      const a = (i * TAU) / this.puffs.length;
      const r = 0.1 + age * 0.3;
      puff.position.set(poof.x + Math.cos(a) * r, 0.12 + age * 0.25, poof.z + Math.sin(a) * r);
      puff.scale.setScalar(0.15 + age * 0.25);
      puff.material.opacity = (1 - age) * 0.85;
    });
  }

  placeLabel(camera, width, height) {
    const v = this.scratch.set(0, this.building.roofTop() + 0.45, BUILDING_Z);
    this.root.localToWorld(v);
    v.project(camera);
    const hidden = v.z > 1 || this.appear < 0.4 || this.cut;
    this.label.hidden = hidden;
    if (hidden) return;
    this.label.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -100%)`;
    this.label.style.zIndex = String(Math.round((1 - v.z) * 10000));

    const b = this.building;
    const maxed = b.levels.length >= MAX_LEVELS && b.fill > 0.99;
    const lv = maxed ? 'MAX' : String(b.levels.length + 1);
    if (lv !== this.lv) this.el.lv.textContent = this.lv = lv;
    const pct = Math.round(b.fill * 100);
    if (pct !== this.pct) {
      this.pct = pct;
      this.el.bar.style.width = `${pct}%`;
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.label.remove();
    clearTimeout(this.levelUpTimer);
    this.building.dispose();
    for (const mat of [this.accent, this.glowMat, this.poolMat, this.ringMat]) mat.dispose();
    for (const s of [...this.sparks, ...this.stars]) s.sprite.material.dispose();
    for (const s of [...this.zs, ...this.puffs]) s.material.dispose();
  }
}

// ── A project: paved district with a signpost ──────────────────────────────

class District {
  constructor(village, cwd, name) {
    const { geo, mat, tex } = resources();
    this.village = village;
    this.cwd = cwd;
    this.name = name;
    this.roofIndex = Math.floor(hash(cwd) * 6);
    this.group = new THREE.Group();
    this.group.scale.setScalar(0.001);
    this.appear = 0;
    this.leaving = false;
    this.placed = false;
    this.slot = { x: 0, z: 0 };
    this.count = 0;
    this.cols = 1;
    this.rows = 1;
    this.savedCount = 0;
    this.w = PLOT_W;
    this.d = PLOT_D;

    this.edgeMat = new THREE.MeshStandardMaterial({ color: P.pathEdge, roughness: 1 });
    this.edge = part(geo.unitPlane, this.edgeMat, 0, 0.003, 0, this.group, false);
    this.edge.rotation.x = -Math.PI / 2;
    this.edge.receiveShadow = true;
    this.padTex = tex.tiles.clone();
    this.padTex.needsUpdate = true;
    this.padMat = new THREE.MeshStandardMaterial({ map: this.padTex, roughness: 1 });
    this.pad = part(geo.unitPlane, this.padMat, 0, 0.005, 0, this.group, false);
    this.pad.rotation.x = -Math.PI / 2;
    this.pad.receiveShadow = true;

    this.sign = new THREE.Group();
    this.sign.rotation.y = HOME_VIEW.az; // face the default camera
    this.group.add(this.sign);
    part(geo.signPost, mat.wood, 0, 0.4, 0, this.sign);
    part(geo.signBoard, mat.wood, 0, 0.74, 0, this.sign);
    this.signTex = canvasTexture(512, 160);
    this.signTex.anisotropy = 8;
    this.signMat = new THREE.MeshStandardMaterial({ map: this.signTex, roughness: 0.8 });
    part(geo.signFace, this.signMat, 0, 0.74, 0.026, this.sign, false);
  }

  get roofColor() {
    return P.roofs[this.roofIndex];
  }

  setCount(n, saved) {
    if (n === this.count && saved === this.savedCount) return;
    this.count = n;
    this.savedCount = saved;
    this.cols = n <= 2 ? n : Math.ceil(Math.sqrt(n * 1.3));
    this.rows = Math.ceil(n / this.cols);
    this.w = this.cols * PLOT_W + 0.5;
    this.d = this.rows * PLOT_D + 0.4;
    this.pad.scale.set(this.w, this.d, 1);
    this.edge.scale.set(this.w + 0.16, this.d + 0.16, 1);
    this.padTex.repeat.set(this.w, this.d);
    this.sign.position.set(-this.w / 2 + 0.55, 0, this.d / 2 + 0.3);
    this.paintSign();
  }

  slotFor(i) {
    const c = i % this.cols;
    const r = Math.floor(i / this.cols);
    const inRow = Math.min(this.cols, this.count - r * this.cols);
    return [(c - (inRow - 1) / 2) * PLOT_W, (r - (this.rows - 1) / 2) * PLOT_D];
  }

  paintSign() {
    const g = this.signTex.image.getContext('2d');
    g.fillStyle = P.wood;
    g.fillRect(0, 0, 512, 160);
    g.strokeStyle = alpha(P.joint, 0.5);
    g.lineWidth = 8;
    g.strokeRect(4, 4, 504, 152);
    g.fillStyle = P.plaster;
    g.font = '800 62px "Big Shoulders Display", Impact, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(fitText(g, String(this.name).toUpperCase(), 470), 22, 64);
    g.font = '400 22px "Martian Mono", ui-monospace, monospace';
    g.fillStyle = alpha(P.plaster, 0.75);
    const live = this.count - this.savedCount;
    const tally = [live && `${live} ${live === 1 ? 'builder' : 'builders'}`, this.savedCount && `${this.savedCount} saved`];
    g.fillText(tally.filter(Boolean).join(' · '), 24, 122);
    this.signTex.needsUpdate = true;
  }

  applyTheme() {
    this.edgeMat.color.set(P.pathEdge);
    this.padTex.needsUpdate = true;
    this.paintSign();
  }

  animate(dt) {
    const k = 1 - Math.exp(-dt * 4);
    this.appear += ((this.leaving ? 0 : 1) - this.appear) * (1 - Math.exp(-dt * 4));
    this.group.scale.setScalar(Math.max(0.001, this.appear));
    this.group.position.x += (this.slot.x - this.group.position.x) * k;
    this.group.position.z += (this.slot.z - this.group.position.z) * k;
  }

  dispose() {
    this.group.removeFromParent();
    for (const d of [this.edgeMat, this.padMat, this.signMat, this.padTex, this.signTex]) d.dispose();
  }
}

// ── The village ─────────────────────────────────────────────────────────────

export class Floor {
  constructor(container, { onPick, toolLabel, legend, theme }) {
    usePalette(theme);
    this.container = container;
    this.onPick = onPick;
    this.toolLabel = toolLabel;
    this.legend = legend;
    this.labels = container.querySelector('.floor-labels');
    this.motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
    this.stations = new Map(); // pid → Worker
    this.districts = new Map(); // cwd → District
    this.layoutKey = '';
    this.ready = false; // level-up fanfare only after the opening build-up
    this.fitPoints = [];
    this.dist = 0;
    this.view = { ...HOME_VIEW };
    this.cam = { az: HOME_VIEW.az, el: HOME_VIEW.el }; // eased toward view
    this.followed = null;
    this.goal = new THREE.Vector3(0, 0.8, 0);
    this.home = new THREE.Vector3(0, 0.8, 0);
    this.pointer = null;
    this.drag = null;
    this.hovered = null;
    this.visible = true;
    this.target = new THREE.Vector3(0, 0.8, 0);
    this.raycaster = new THREE.Raycaster();
    this.v = { dir: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), p: new THREE.Vector3() };
    this.sight = { ray: new THREE.Ray(), box: new THREE.Box3(), hit: new THREE.Vector3(), at: new THREE.Vector3() };

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping; // keeps the toy colours saturated
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.prepend(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color();
    scene.fog = new THREE.Fog(0x000000, 18, 40);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 300);

    this.hemi = new THREE.HemisphereLight();
    scene.add(this.hemi);
    const key = new THREE.DirectionalLight();
    key.position.set(-6, 14, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    this.key = key;
    this.rim = new THREE.DirectionalLight();
    this.rim.position.set(5, 6, -10);
    scene.add(this.rim);

    const { geo, mat } = resources();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), mat.grass);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.scenery = {
      trunks: new THREE.InstancedMesh(geo.trunk, mat.trunk, 70),
      crowns: new THREE.InstancedMesh(geo.crown, mat.leaf, 70),
      tops: new THREE.InstancedMesh(geo.crownTop, mat.leaf, 70),
      rocks: new THREE.InstancedMesh(geo.rock, mat.rock, 36),
    };
    for (const m of Object.values(this.scenery)) {
      m.castShadow = m.receiveShadow = true;
      m.count = 0;
      scene.add(m);
    }
    this.applySceneTheme();

    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    new IntersectionObserver(([entry]) => (this.visible = entry.isIntersecting)).observe(container);
    // Signs are painted onto canvases; repaint whenever web fonts arrive.
    const repaint = () => {
      for (const d of this.districts.values()) d.paintSign();
    };
    document.fonts?.ready.then(repaint);
    document.fonts?.addEventListener('loadingdone', repaint);

    const loop = (now) => {
      requestAnimationFrame(loop);
      if (this.visible && !document.hidden) this.frame(now / 1000);
    };
    requestAnimationFrame(loop);
  }

  setTheme(theme) {
    usePalette(theme);
    const { mat } = resources();
    const colors = {
      face: P.face, overalls: P.overalls, helmet: P.helmet, helmetSub: P.sub, glove: P.glove, joint: P.joint, metal: P.metal, eye: P.plaster,
      timber: P.timber, wood: P.wood, stone: P.stone, brick: P.brick, plasterTop: P.plaster, leaf: P.leaf, trunk: P.trunk, rock: P.rock, subAccent: P.sub,
    };
    for (const [name, color] of Object.entries(colors)) mat[name].color.set(color);
    for (const f of mat.facades) {
      f.emissive.set(P.windowLit);
      f.emissiveIntensity = P.windowGlow;
    }
    paintThemed();
    this.applySceneTheme();
    for (const d of this.districts.values()) d.applyTheme();
    for (const w of this.stations.values()) w.applyTheme();
  }

  applySceneTheme() {
    this.scene.background.set(P.bg);
    this.scene.fog.color.set(P.bg);
    this.hemi.color.set(P.hemiSky);
    this.hemi.groundColor.set(P.grass);
    this.hemi.intensity = P.hemiIntensity;
    this.key.color.set(P.keyColor);
    this.key.intensity = P.keyIntensity;
    this.rim.color.set(P.hot);
    this.rim.intensity = P.rimIntensity;
    this.renderer.toneMappingExposure = P.exposure;
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.drag = { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.pointer = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
      const d = this.drag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
        d.moved = true;
        c.classList.add('dragging');
      }
      if (d.moved) {
        this.view.az -= (e.clientX - d.x) * 0.006;
        this.view.el = THREE.MathUtils.clamp(this.view.el + (e.clientY - d.y) * 0.005, 0.28, 1.35);
      }
      d.x = e.clientX;
      d.y = e.clientY;
    });
    // First click follows a builder; clicking the followed builder opens its card.
    c.addEventListener('pointerup', () => {
      const clicked = this.drag && !this.drag.moved ? this.hovered : null;
      this.drag = null;
      c.classList.remove('dragging');
      if (!clicked) return;
      if (clicked === this.followed) {
        if (!clicked.saved) this.onPick(clicked.pid);
      }
      else this.follow(clicked);
    });
    c.addEventListener('pointerleave', () => {
      if (!this.drag) this.pointer = null;
    });
    // Zoom only on pinch / ⌘-scroll (or in fullscreen) so the page still scrolls normally.
    c.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey || document.fullscreenElement)) return;
        e.preventDefault();
        this.view.zoom = THREE.MathUtils.clamp(this.view.zoom * Math.exp(e.deltaY * 0.0015), 0.35, 1.8);
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => this.follow(null));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.followed) this.follow(null);
    });
  }

  follow(worker) {
    this.followed = worker;
    this.container.classList.toggle('following', Boolean(worker));
    // high enough to look over a max-height neighbour on the diagonal
    this.view = worker ? { az: HOME_VIEW.az, el: 0.82, zoom: 1 } : { ...HOME_VIEW };
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // sessions: live Claude sessions · saved: buildings of conversations that ended
  update(sessions, saved = []) {
    this.sessions = sessions;
    const now = Date.now();
    const byProject = new Map();
    const add = (cwd, entry) => {
      const key = cwd ?? '?';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(entry);
    };
    for (const s of sessions) add(s.cwd, { id: s.buildingId ?? String(s.pid), project: s.project, since: s.buildingSince ?? s.startedAt, session: s });
    for (const b of saved) add(b.cwd, { id: b.id, project: b.project, since: b.since, saved: b });

    const present = new Set();
    for (const [cwd, list] of byProject) {
      let district = this.districts.get(cwd);
      if (!district) {
        district = new District(this, cwd, list[0].project || cwd);
        this.districts.set(cwd, district);
        this.scene.add(district.group);
      }
      district.leaving = false;
      district.setCount(list.length, list.filter((e) => e.saved).length);
      // oldest first, so each new conversation builds on the next plot
      list.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1));
      list.forEach((e, i) => {
        present.add(e.id);
        let worker = this.stations.get(e.id);
        if (!worker) {
          worker = new Worker(this, e.id);
          this.stations.set(e.id, worker);
        }
        worker.leaving = false;
        worker.assign(district, i);
        if (e.saved) worker.setSaved(e.saved);
        else worker.setSession(e.session, now);
      });
    }
    for (const d of this.districts.values()) if (!byProject.has(d.cwd)) d.leaving = true;
    for (const w of this.stations.values()) if (!present.has(w.id)) w.leaving = true;

    this.layout();
    this.renderLegend();
    this.readyTimer ??= setTimeout(() => (this.ready = true), 4000);
  }

  // Districts are shelf-packed into rows with grass paths between them.
  layout() {
    const districts = [...this.districts.values()].filter((d) => !d.leaving).sort((a, b) => a.cwd.localeCompare(b.cwd));
    const key = districts.map((d) => `${d.cwd}:${d.count}`).join('|');
    if (key === this.layoutKey) return;
    this.layoutKey = key;

    const area = districts.reduce((sum, d) => sum + (d.w + DISTRICT_GAP) * (d.d + DISTRICT_GAP), 0);
    const maxRow = Math.max(...districts.map((d) => d.w), Math.sqrt(area * 1.8));
    const rows = [];
    let row = null;
    for (const d of districts) {
      if (!row || row.w + DISTRICT_GAP + d.w > maxRow) rows.push((row = { items: [], w: -DISTRICT_GAP, d: 0 }));
      row.items.push(d);
      row.w += d.w + DISTRICT_GAP;
      row.d = Math.max(row.d, d.d);
    }
    const depth = rows.reduce((sum, r) => sum + r.d, 0) + DISTRICT_GAP * Math.max(0, rows.length - 1);
    let z = -depth / 2;
    for (const r of rows) {
      let x = -r.w / 2;
      for (const d of r.items) {
        d.slot = { x: x + d.w / 2, z: z + r.d / 2 };
        if (!d.placed) {
          d.group.position.set(d.slot.x, 0, d.slot.z);
          d.placed = true;
        }
        x += d.w + DISTRICT_GAP;
      }
      z += r.d + DISTRICT_GAP;
    }

    const widest = Math.max(0, ...rows.map((r) => r.w));
    const reach = Math.hypot(widest / 2, depth / 2) + 3;
    Object.assign(this.key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 70 });
    this.key.shadow.camera.updateProjectionMatrix();
    this.scatterScenery(districts, widest / 2 + 3.5, depth / 2 + 3.5);
  }

  // Trees and rocks on the grass around the districts (deterministic).
  scatterScenery(districts, hx, hz) {
    const { trunks, crowns, tops, rocks } = this.scenery;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const placed = [];
    let seed = 1;
    const rnd = () => rand(seed++, 42);
    const free = (x, z, margin) =>
      districts.every((d) => Math.abs(x - d.slot.x) > d.w / 2 + margin || Math.abs(z - d.slot.z) > d.d / 2 + margin) &&
      placed.every(([px, pz]) => Math.hypot(px - x, pz - z) > 0.9);

    let trees = 0;
    for (let i = 0; i < 700 && trees < trunks.instanceMatrix.count; i++) {
      const x = (rnd() * 2 - 1) * hx;
      const z = (rnd() * 2 - 1) * hz;
      if (!free(x, z, 0.8)) continue;
      placed.push([x, z]);
      const k = 0.7 + rnd() * 0.6;
      q.setFromAxisAngle(up, rnd() * TAU);
      trunks.setMatrixAt(trees, m4.compose(p.set(x, 0.2 * k, z), q, s.set(k, k, k)));
      crowns.setMatrixAt(trees, m4.compose(p.set(x, 0.72 * k, z), q, s.set(k, k, k)));
      tops.setMatrixAt(trees, m4.compose(p.set(x, 1.12 * k, z), q, s.set(k, k, k)));
      trees++;
    }
    let stones = 0;
    for (let i = 0; i < 500 && stones < rocks.instanceMatrix.count; i++) {
      const x = (rnd() * 2 - 1) * hx;
      const z = (rnd() * 2 - 1) * hz;
      if (!free(x, z, 0.4)) continue;
      placed.push([x, z]);
      const k = 0.5 + rnd() * 0.7;
      q.setFromAxisAngle(up, rnd() * TAU);
      rocks.setMatrixAt(stones, m4.compose(p.set(x, 0.08 * k, z), q, s.set(k, k * 0.6, k)));
      stones++;
    }
    trunks.count = crowns.count = tops.count = trees;
    rocks.count = stones;
    for (const m of [trunks, crowns, tops, rocks]) m.instanceMatrix.needsUpdate = true;
  }

  renderLegend() {
    if (!this.legend) return;
    const counts = {};
    for (const w of this.stations.values()) if (!w.leaving) counts[w.mode] = (counts[w.mode] ?? 0) + 1;
    const html = Object.keys(MODE_LABEL)
      .filter((mode) => counts[mode])
      .map((mode) => `<span class="fm fm-${mode}"><i></i>${MODE_LABEL[mode]} <b>${counts[mode]}</b></span>`)
      .join('');
    if (this.legend._html !== html) {
      this.legend._html = html;
      this.legend.innerHTML = html;
    }
  }

  // Everything that must stay in frame: district corners (with label height)
  // and each building's final roof, in world space.
  collectFitPoints() {
    const pts = this.fitPoints;
    let n = 0;
    const push = (x, y, z) => (pts[n++] ??= new THREE.Vector3()).set(x, y, z);
    for (const d of this.districts.values()) {
      if (d.leaving) continue;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 1.2]) push(d.slot.x + (sx * d.w) / 2, y, d.slot.z + (sz * d.d) / 2);
    }
    for (const w of this.stations.values()) {
      if (w.leaving || !w.district) continue;
      push(w.district.slot.x + w.slot.x, w.building.targetRoofTop() + 0.9, w.district.slot.z + w.slot.z + BUILDING_Z);
    }
    pts.length = n;
  }

  fitDistance(az, el) {
    const { dir, right, up, p } = this.v;
    dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    right.set(Math.cos(az), 0, -Math.sin(az));
    up.crossVectors(dir, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 0.9;
    const tanH = tanV * this.camera.aspect;
    let need = 4;
    for (const point of this.fitPoints) {
      p.subVectors(point, this.home);
      const along = p.dot(dir);
      need = Math.max(need, along + Math.abs(p.dot(right)) / tanH, along + Math.abs(p.dot(up)) / tanV);
    }
    return need;
  }

  frame(t) {
    const dt = Math.min(0.05, t - (this.lastT ?? t));
    this.lastT = t;
    if (this.followed && (this.followed.leaving || !this.stations.has(this.followed.id))) this.follow(null);

    // slow idle drift: ±0.5 rad around wherever the user left the view
    this.view.az += Math.cos(t * 0.05) * 0.025 * dt * this.motion;
    const turn = Math.min(1, dt * 4);
    this.cam.az += angleDelta(this.view.az, this.cam.az) * turn;
    this.cam.el += (this.view.el - this.cam.el) * turn;
    const { az, el } = this.cam;
    this.collectFitPoints();
    if (this.followed) this.followed.root.localToWorld(this.goal.set(0, 0.75, BUILDER_Z - 0.3));
    else this.goal.copy(this.home);
    const ease = Math.min(1, dt * 2.5);
    this.target.lerp(this.goal, this.dist ? ease : 1);
    const want = (this.followed ? FOLLOW_DIST : this.fitDistance(az, el)) * this.view.zoom;
    this.dist = this.dist ? this.dist + (want - this.dist) * ease : want;
    this.camera.position.set(
      this.target.x + Math.sin(az) * Math.cos(el) * this.dist,
      this.target.y + Math.sin(el) * this.dist,
      this.target.z + Math.cos(az) * Math.cos(el) * this.dist,
    );
    this.camera.lookAt(this.target);
    this.scene.fog.near = this.dist * 0.9;
    this.scene.fog.far = this.dist * 2.2;

    this.cutaway();
    this.pick();
    for (const d of this.districts.values()) {
      d.animate(dt);
      if (d.leaving && d.appear < 0.02) {
        d.dispose();
        this.districts.delete(d.cwd);
      }
    }
    for (const w of this.stations.values()) {
      w.animate(t, dt);
      if (w.leaving && w.appear < 0.02) {
        w.dispose();
        this.stations.delete(w.id);
      }
    }

    this.renderer.render(this.scene, this.camera);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    for (const worker of this.stations.values()) worker.placeLabel(this.camera, w, h);
  }

  // While following a builder, hide buildings standing between it and the camera.
  cutaway() {
    const { ray, box, hit, at } = this.sight;
    const f = this.followed;
    ray.origin.copy(this.camera.position);
    ray.direction.subVectors(this.target, this.camera.position);
    const reach = ray.direction.length();
    ray.direction.divideScalar(reach || 1);
    for (const w of this.stations.values()) {
      let blocks = false;
      if (f && w !== f) {
        w.root.localToWorld(at.set(0, 0, BUILDING_Z));
        box.min.set(at.x - 0.85, 0, at.z - 0.85);
        box.max.set(at.x + 0.85, w.building.roofTop() + 0.3, at.z + 0.85);
        blocks = box.containsPoint(ray.origin) || (ray.intersectBox(box, hit) !== null && hit.distanceTo(ray.origin) < reach);
      }
      w.setCutaway(blocks);
    }
  }

  pick() {
    let hit = null;
    if (this.pointer && !this.drag?.moved) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const targets = [...this.stations.values()].filter((w) => !w.leaving).map((w) => w.hit);
      hit = this.raycaster.intersectObjects(targets, false)[0]?.object.userData.station ?? null;
    }
    if (hit === this.hovered) return;
    this.hovered?.setHovered(false);
    hit?.setHovered(true);
    this.hovered = hit;
    this.canvas.classList.toggle('pointing', Boolean(hit));
  }
}
