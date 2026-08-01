/**
 * systems.js — Arena, Bienen-Geometrie, Input, Kamera, Physik, Projektile.
 * Alles prozedural. Keine Texturen, keine externen Assets.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/*  Konfiguration — zentral, damit Balancing an einer Stelle passiert   */
/* ------------------------------------------------------------------ */
export const CFG = {
  seed: 20260801,

  // Match
  matchTime: 300,          // Sekunden

  // Flug
  accel: 78,               // Einheiten/s^2
  maxSpeed: 34,
  boostMult: 2.15,
  drag: 2.6,               // exponentieller Luftwiderstand
  turnLerp: 9,             // wie schnell die Biene in Blickrichtung dreht

  // Boost
  boostMax: 100,
  boostDrain: 34,          // %/s  -> ~3s Dauerboost
  boostRefill: 100 / 15,   // %/s  -> volle Ladung in 15s

  // Stinger
  maxStingers: 10,
  stingerRegen: 1,         // pro Sekunde
  fireCooldown: 0.16,
  shotSpeed: 95,
  shotLife: 2.4,
  shotDamage: 14,
  homingCone: 0.987,       // Zielerfassung nur nah an der Blickachse
  homingRange: 140,
  homingTurn: 2.4,         // rad/s — bewusst mild

  // Entities
  maxHp: 100,
  beeRadius: 1.9,
  respawnDelay: 2.5,

  // Arena
  arenaR: 120,
  arenaSquash: 0.55,
  npcCount: 5,
};

export const TEAM_COLORS = [0xffd426, 0x3f7be0, 0xe03f4a, 0x46c46b, 0xb45fe0, 0xe0872f];

/* ------------------------------------------------------------------ */
/*  Deterministischer RNG — gleiche Seed => gleiche Arena auf allen     */
/*  Clients. Vorbereitung für Phase 7 (Multiplayer).                    */
/* ------------------------------------------------------------------ */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/*  Material-Helfer — flache Farben, flatShading                        */
/* ------------------------------------------------------------------ */
const matCache = new Map();
export function flatMat(color, opts = {}) {
  const key = color + '|' + JSON.stringify(opts);
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshLambertMaterial({
    color, flatShading: true, emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent, opacity: opts.opacity ?? 1,
  });
  matCache.set(key, m);
  return m;
}

/* ================================================================== */
/*  ARENA                                                              */
/* ================================================================== */

/** Achsenparallele Box als Collider. */
function aabb(cx, cy, cz, hx, hy, hz) {
  return { min: new THREE.Vector3(cx - hx, cy - hy, cz - hz), max: new THREE.Vector3(cx + hx, cy + hy, cz + hz) };
}

/** Sechseckiges Prisma (Radius = Umkreis). */
function hexPrism(r, h, color) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), flatMat(color));
}

export function buildArena(scene) {
  const rnd = mulberry32(CFG.seed);
  const R = CFG.arenaR;
  const root = new THREE.Group();
  const colliders = [];
  const spawns = [];
  const pickups = [];

  /* --- Höhlenschale: gestörtes Ikosaeder, von innen gerendert ----- */
  const shellGeo = new THREE.IcosahedronGeometry(R, 3);
  const p = shellGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    _v1.fromBufferAttribute(p, i);
    _v2.copy(_v1).normalize();
    const bump =
      1 +
      0.10 * Math.sin(_v2.x * 3.3 + 1.7) * Math.cos(_v2.z * 2.9) +
      0.07 * Math.sin(_v2.y * 4.1 + 0.6) +
      0.05 * (rnd() - 0.5);
    _v1.multiplyScalar(bump);
    if (_v1.y < -R * 0.34) _v1.y = -R * 0.34; // Boden plattdrücken
    p.setXYZ(i, _v1.x, _v1.y, _v1.z);
  }
  shellGeo.scale(1, CFG.arenaSquash, 1);
  shellGeo.computeVertexNormals();
  const shell = new THREE.Mesh(shellGeo, flatMat(0x8a5c23, { side: THREE.BackSide }));
  shell.position.y = R * 0.34 * CFG.arenaSquash; // Boden auf y = 0
  root.add(shell);
  const CEIL = shell.position.y + R * 1.05 * CFG.arenaSquash;

  /* --- Hex-Boden ------------------------------------------------- */
  const floor = hexPrism(R * 0.86, 8, 0x9c6a2a);
  floor.position.y = -4;
  root.add(floor);

  /* --- Verstreute Bodenplatten für Relief ------------------------ */
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, d = 12 + rnd() * (R * 0.72);
    const h = 1.5 + rnd() * 5;
    const r = 7 + rnd() * 9;
    const t = hexPrism(r, h, rnd() > 0.5 ? 0xa8742f : 0x926127);
    t.position.set(Math.cos(a) * d, h / 2 - 0.5, Math.sin(a) * d);
    t.rotation.y = rnd() * Math.PI;
    root.add(t);
  }

  /* --- Pillars ---------------------------------------------------- */
  const pillarCount = 11;
  for (let i = 0; i < pillarCount; i++) {
    const a = (i / pillarCount) * Math.PI * 2 + rnd() * 0.5;
    const d = 34 + rnd() * (R * 0.5);
    const r = 5 + rnd() * 5;
    const h = 30 + rnd() * (CEIL * 0.7);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const m = hexPrism(r, h, 0x7d5220);
    m.position.set(x, h / 2, z);
    m.rotation.y = rnd() * Math.PI;
    root.add(m);
    colliders.push(aabb(x, h / 2, z, r * 0.92, h / 2, r * 0.92));
  }

  /* --- Schwebende Plattformen (mit Stiel) ------------------------- */
  const platCount = 14;
  for (let i = 0; i < platCount; i++) {
    const a = (i / platCount) * Math.PI * 2 + rnd() * 0.7;
    const d = 20 + rnd() * (R * 0.62);
    const r = 8 + rnd() * 6;
    const y = 7 + rnd() * (CEIL * 0.6);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;

    const top = hexPrism(r, 3.2, 0xb07c33);
    top.position.set(x, y, z);
    top.rotation.y = rnd() * Math.PI;
    root.add(top);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.97, 0.55, 3, 6), flatMat(0xe8b23c));
    rim.rotation.set(Math.PI / 2, 0, top.rotation.y);
    rim.position.set(x, y + 1.7, z);
    root.add(rim);

    const stalk = hexPrism(r * 0.42, y, 0x6f4a1d);
    stalk.position.set(x, y / 2, z);
    root.add(stalk);

    colliders.push(aabb(x, y, z, r * 0.9, 2.0, r * 0.9));
    colliders.push(aabb(x, y / 2, z, r * 0.4, y / 2, r * 0.4));
    spawns.push(new THREE.Vector3(x, y + 9, z));
  }

  /* --- Hexagonale Tunnel-/Torringe (durchfliegbar) ---------------- */
  for (let i = 0; i < 6; i++) {
    const a = rnd() * Math.PI * 2, d = 30 + rnd() * (R * 0.55);
    const r = 10 + rnd() * 7;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.9, 3, 6), flatMat(0xf0bb3e));
    ring.position.set(Math.cos(a) * d, 12 + rnd() * 40, Math.sin(a) * d);
    ring.lookAt(0, ring.position.y, 0);
    ring.rotateZ(rnd() * 0.6 - 0.3);
    root.add(ring);
  }

  /* --- Hängende Laternen ------------------------------------------ */
  for (let i = 0; i < 4; i++) {
    const a = rnd() * Math.PI * 2, d = i === 0 ? 0 : 25 + rnd() * (R * 0.45);
    const x = Math.cos(a) * d, z = Math.sin(a) * d, y = CEIL * (0.55 + rnd() * 0.25);
    const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(3.2, 0), flatMat(0xffd76a, { emissive: 0xffb422 }));
    lamp.position.set(x, y, z);
    root.add(lamp);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, CEIL - y, 4), flatMat(0x5a3d16));
    cord.position.set(x, (CEIL + y) / 2, z);
    root.add(cord);
    const pl = new THREE.PointLight(0xffbe45, 1.35, 130, 2);
    pl.position.set(x, y, z);
    root.add(pl);
  }

  /* --- Kristall-Pickups ------------------------------------------- */
  const crystalColors = [0x46e07a, 0xffe24a, 0x4ac8ff];
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2, d = 15 + rnd() * (R * 0.68);
    const c = crystalColors[(i % crystalColors.length)];
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(1.7, 0), flatMat(c, { emissive: c, emissiveIntensity: 0.55 }));
    mesh.position.set(Math.cos(a) * d, 4 + rnd() * 45, Math.sin(a) * d);
    root.add(mesh);
    pickups.push({ mesh, home: mesh.position.clone(), active: true, cooldown: 0, kind: i % 3 });
  }

  /* --- Licht ------------------------------------------------------- */
  const sun = new THREE.DirectionalLight(0xfff0c4, 0.85);
  sun.position.set(40, 90, 25);
  root.add(sun);
  root.add(new THREE.AmbientLight(0xffb861, 0.62));
  root.add(new THREE.HemisphereLight(0xffd489, 0x6b4517, 0.5));

  scene.add(root);
  scene.fog = new THREE.Fog(0x6b4a1c, 90, 300);
  scene.background = new THREE.Color(0x6b4a1c);

  // Zentrale Freifläche als zusätzliche Spawns
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    spawns.push(new THREE.Vector3(Math.cos(a) * 45, 14 + i * 4, Math.sin(a) * 45));
  }

  const world = {
    root, colliders, spawns, pickups,
    ceiling: CEIL - 4,
    floorY: 2.2,
    bounds: R * 0.84,
    randomSpawn: (r = Math.random) => spawns[(r() * spawns.length) | 0].clone(),
  };

  /** Pickups rotieren + Respawn-Timer. */
  world.update = (dt) => {
    for (const pk of pickups) {
      pk.mesh.rotation.y += dt * 1.6;
      pk.mesh.rotation.x += dt * 0.7;
      if (!pk.active) {
        pk.cooldown -= dt;
        pk.mesh.scale.setScalar(Math.max(0.001, 1 - pk.cooldown / 8));
        if (pk.cooldown <= 0) { pk.active = true; pk.mesh.scale.setScalar(1); }
      }
    }
  };

  return world;
}

/* ================================================================== */
/*  PHYSIK — Sphere vs. AABB + Höhlenbegrenzung                        */
/* ================================================================== */
export function resolveCollision(pos, radius, world) {
  let hit = false;

  for (const c of world.colliders) {
    if (pos.x + radius < c.min.x || pos.x - radius > c.max.x) continue;
    if (pos.y + radius < c.min.y || pos.y - radius > c.max.y) continue;
    if (pos.z + radius < c.min.z || pos.z - radius > c.max.z) continue;

    // kleinste Eindringtiefe bestimmt die Ausschieberichtung
    const px = Math.min(c.max.x + radius - pos.x, pos.x - (c.min.x - radius));
    const py = Math.min(c.max.y + radius - pos.y, pos.y - (c.min.y - radius));
    const pz = Math.min(c.max.z + radius - pos.z, pos.z - (c.min.z - radius));

    if (py <= px && py <= pz) {
      pos.y += pos.y > (c.min.y + c.max.y) / 2 ? py : -py;
    } else if (px <= pz) {
      pos.x += pos.x > (c.min.x + c.max.x) / 2 ? px : -px;
    } else {
      pos.z += pos.z > (c.min.z + c.max.z) / 2 ? pz : -pz;
    }
    hit = true;
  }

  // Höhlenwand (zylindrisch angenähert) + Boden + Decke
  const dh = Math.hypot(pos.x, pos.z);
  if (dh > world.bounds - radius) {
    const s = (world.bounds - radius) / dh;
    pos.x *= s; pos.z *= s; hit = true;
  }
  if (pos.y < world.floorY + radius) { pos.y = world.floorY + radius; hit = true; }
  if (pos.y > world.ceiling - radius) { pos.y = world.ceiling - radius; hit = true; }

  return hit;
}

/** Grober Sichtlinien-Test für die KI (Segment vs. AABB, Slab-Methode). */
export function lineOfSight(from, to, world) {
  const dir = _v1.copy(to).sub(from);
  const len = dir.length();
  if (len < 0.001) return true;
  dir.divideScalar(len);
  const inv = { x: 1 / (dir.x || 1e-6), y: 1 / (dir.y || 1e-6), z: 1 / (dir.z || 1e-6) };

  for (const c of world.colliders) {
    let t0 = 0, t1 = len;
    let a = (c.min.x - from.x) * inv.x, b = (c.max.x - from.x) * inv.x;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) continue;
    a = (c.min.y - from.y) * inv.y; b = (c.max.y - from.y) * inv.y;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) continue;
    a = (c.min.z - from.z) * inv.z; b = (c.max.z - from.z) * inv.z;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) continue;
    return false;
  }
  return true;
}

/* ================================================================== */
/*  BIENEN-MESH                                                        */
/* ================================================================== */
export function makeBee(bodyColor = 0xffd426) {
  const g = new THREE.Group();
  const dark = flatMat(0x231a0d);

  // Hinterleib mit Streifen
  const abdomen = new THREE.Group();
  const segs = 4;
  for (let i = 0; i < segs; i++) {
    const r = 1.5 - i * 0.24;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(r, 1.5 - (i + 1) * 0.24, 0.62, 8),
      i % 2 === 0 ? flatMat(bodyColor) : dark
    );
    seg.rotation.x = Math.PI / 2;
    seg.position.z = -0.6 - i * 0.62;
    abdomen.add(seg);
  }
  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 5), dark);
  stinger.rotation.x = Math.PI / 2;
  stinger.position.z = -3.35;
  abdomen.add(stinger);
  g.add(abdomen);

  // Thorax + Kopf
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(1.55, 8, 6), flatMat(bodyColor));
  thorax.scale.set(1, 0.92, 1.05);
  g.add(thorax);

  const head = new THREE.Mesh(new THREE.SphereGeometry(1.05, 8, 6), dark);
  head.position.z = 1.75;
  g.add(head);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 4), flatMat(0xfff6d8));
    eye.position.set(sx * 0.55, 0.25, 2.4);
    g.add(eye);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 4), dark);
    ant.position.set(sx * 0.35, 1.1, 2.3);
    ant.rotation.set(-0.5, 0, sx * 0.4);
    g.add(ant);
  }

  // Flügel — flache Polygone
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.quadraticCurveTo(2.2, 1.0, 4.4, 0.35);
  wingShape.quadraticCurveTo(2.4, -0.5, 0, 0);
  const wingGeo = new THREE.ShapeGeometry(wingShape);
  const wingMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, transparent: true, opacity: 0.72, side: THREE.DoubleSide, flatShading: true,
  });
  const wings = [];
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo, wingMat);
    w.position.set(sx * 0.5, 1.0, 0.1);
    w.rotation.x = -Math.PI / 2;
    w.scale.x = sx;
    g.add(w);
    wings.push(w);
  }

  let phase = Math.random() * 10;
  g.userData.animate = (dt, speed01) => {
    phase += dt * (26 + speed01 * 22);
    const flap = Math.sin(phase);
    wings[0].rotation.y = 0.35 + flap * 0.75;
    wings[1].rotation.y = -0.35 - flap * 0.75;
    abdomen.rotation.x = flap * 0.03;
  };

  return g;
}

/* ================================================================== */
/*  TOUCH-INPUT — zwei Sticks + zwei Buttons, Multitouch-fest          */
/* ================================================================== */
export class TouchInput {
  constructor() {
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.shoot = false;
    this.boost = false;
    this._sticks = [];
    this._bind('stick-left', this.move);
    this._bind('stick-right', this.look);
    this._button('btn-shoot', 'shoot');
    this._button('btn-boost', 'boost');
    // Verhindert Scrollen/Zoomen während des Spiels
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  _bind(id, out) {
    const base = document.getElementById(id);
    if (!base) return;
    const knob = base.querySelector('.knob');
    const st = { base, knob, out, id: null, cx: 0, cy: 0, r: 1 };
    this._sticks.push(st);

    const start = (e) => {
      if (st.id !== null) return;
      st.id = e.pointerId;
      const b = base.getBoundingClientRect();
      st.cx = b.left + b.width / 2;
      st.cy = b.top + b.height / 2;
      st.r = b.width * 0.38;
      base.setPointerCapture(e.pointerId);
      move(e);
    };
    const move = (e) => {
      if (st.id !== e.pointerId) return;
      let dx = e.clientX - st.cx, dy = e.clientY - st.cy;
      const d = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(d, st.r);
      dx = (dx / d) * clamped; dy = (dy / d) * clamped;
      out.x = dx / st.r;
      out.y = -dy / st.r;                       // Bildschirm-Y ist invertiert
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      e.preventDefault();
    };
    const end = (e) => {
      if (st.id !== e.pointerId) return;
      st.id = null; out.x = 0; out.y = 0;
      knob.style.transform = 'translate(0px, 0px)';
    };

    base.addEventListener('pointerdown', start);
    base.addEventListener('pointermove', move);
    base.addEventListener('pointerup', end);
    base.addEventListener('pointercancel', end);
    base.addEventListener('lostpointercapture', end);
  }

  _button(id, prop) {
    const el = document.getElementById(id);
    if (!el) return;
    const down = (e) => { this[prop] = true; el.classList.add('active'); el.setPointerCapture(e.pointerId); e.preventDefault(); };
    const up = () => { this[prop] = false; el.classList.remove('active'); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
}

/* ================================================================== */
/*  KAMERA-RIG — Third Person hinter der Biene, weich nachziehend       */
/* ================================================================== */
export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.yaw = 0;
    this.pitch = -0.12;
    this.dist = 11.5;
    this.height = 3.4;
    this.sens = { yaw: 2.4, pitch: 1.7 };
    this._pos = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.shake = 0;
  }

  update(dt, look, target, world) {
    this.yaw -= look.x * this.sens.yaw * dt;
    this.pitch += look.y * this.sens.pitch * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.25, 1.25);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.forward.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp).multiplyScalar(-1);
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // Wunschposition hinter dem Ziel
    _v1.copy(target).addScaledVector(this.forward, -this.dist);
    _v1.y += this.height;

    // Kamera nicht in Geometrie schieben
    if (world) resolveCollision(_v1, 1.6, world);

    this._pos.lerp(_v1, 1 - Math.exp(-11 * dt));
    this.cam.position.copy(this._pos);

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.4);
      const s = this.shake * 0.5;
      this.cam.position.x += (Math.random() - 0.5) * s;
      this.cam.position.y += (Math.random() - 0.5) * s;
    }

    _v2.copy(target).addScaledVector(this.forward, 6);
    this.cam.lookAt(_v2);
  }

  kick(a = 0.5) { this.shake = Math.min(1.4, this.shake + a); }
}

/* ================================================================== */
/*  PROJEKTILE — gepoolt, mit mildem Homing                            */
/* ================================================================== */
export class ProjectileSystem {
  constructor(scene, world, size = 160) {
    this.world = world;
    this.pool = [];
    const geo = new THREE.ConeGeometry(0.22, 1.5, 5);
    geo.rotateX(Math.PI / 2);
    for (let i = 0; i < size; i++) {
      const mesh = new THREE.Mesh(geo, flatMat(0xfff0a0, { emissive: 0xffc020 }));
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, alive: false, vel: new THREE.Vector3(), life: 0, owner: null, target: null });
    }
    this.onHit = null; // (entity, damage, shooter) => void
  }

  /** @param entities Kandidaten für die Zielerfassung (Homing). */
  fire(origin, dir, owner, entities) {
    const p = this.pool.find((q) => !q.alive);
    if (!p) return null;
    p.alive = true;
    p.life = CFG.shotLife;
    p.owner = owner;
    p.mesh.visible = true;
    p.mesh.position.copy(origin);
    p.vel.copy(dir).normalize().multiplyScalar(CFG.shotSpeed);
    p.target = this._acquire(origin, dir, owner, entities);
    return p;
  }

  _acquire(origin, dir, owner, entities) {
    let best = null, bestDot = CFG.homingCone;
    for (const e of entities) {
      if (e === owner || !e.alive) continue;
      _v1.copy(e.position).sub(origin);
      const d = _v1.length();
      if (d > CFG.homingRange || d < 2) continue;
      const dot = _v1.divideScalar(d).dot(dir);
      if (dot > bestDot) { bestDot = dot; best = e; }
    }
    return best;
  }

  update(dt, entities) {
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { this._kill(p); continue; }

      // mildes Homing: begrenzte Richtungsänderung pro Sekunde
      if (p.target && p.target.alive) {
        _v1.copy(p.target.position).sub(p.mesh.position).normalize();
        _v2.copy(p.vel).normalize();
        const maxStep = CFG.homingTurn * dt;
        _v2.lerp(_v1, Math.min(1, maxStep)).normalize();
        p.vel.copy(_v2).multiplyScalar(CFG.shotSpeed);
      }

      p.mesh.position.addScaledVector(p.vel, dt);
      _v1.copy(p.mesh.position).add(p.vel);
      p.mesh.lookAt(_v1);

      // Treffer auf Entities
      let consumed = false;
      for (const e of entities) {
        if (e === p.owner || !e.alive) continue;
        if (p.mesh.position.distanceToSquared(e.position) < (e.radius + 0.6) ** 2) {
          if (this.onHit) this.onHit(e, CFG.shotDamage, p.owner);
          this._kill(p);
          consumed = true;
          break;
        }
      }
      if (consumed) continue;

      // Treffer auf Geometrie
      _v1.copy(p.mesh.position);
      if (resolveCollision(_v1, 0.3, this.world)) this._kill(p);
    }
  }

  _kill(p) { p.alive = false; p.mesh.visible = false; p.target = null; }
}
