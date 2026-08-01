/**
 * game.js — Bootstrap, Match-Loop und HUD-Anbindung.
 */
import * as THREE from 'three';
import {
  CFG, TEAM_COLORS, buildArena, TouchInput, CameraRig, ProjectileSystem,
} from './systems.js';
import { Actor, makeNPC } from './npc.js';

/* ------------------------------------------------------------------ */
/*  Renderer / Szene                                                   */
/* ------------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 600);

const world = buildArena(scene);
const rig = new CameraRig(camera);
const input = new TouchInput();
const shots = new ProjectileSystem(scene, world);

/* ------------------------------------------------------------------ */
/*  Actors                                                             */
/* ------------------------------------------------------------------ */
const player = new Actor(scene, { color: TEAM_COLORS[0], name: 'DU', isPlayer: true });
player.respawn(world);

// `bots` und `actors` werden nur MUTIERT, nie neu zugewiesen — die Closures
// unten (onHit, fireFrom) halten die Referenz.
const bots = [];
const actors = [player];

/** Bot-Anzahl zur Laufzeit ändern. */
function setBotCount(n) {
  n = Math.max(CFG.npcMin, Math.min(CFG.npcMax, n | 0));
  CFG.npcCount = n;
  while (bots.length > n) {
    const b = bots.pop();
    actors.splice(actors.indexOf(b), 1);
    b.dispose(scene);
  }
  while (bots.length < n) {
    const b = makeNPC(scene, world, bots.length, TEAM_COLORS);
    bots.push(b);
    actors.push(b);
  }
  return n;
}

shots.onHit = (victim, dmg, shooter) => {
  const killed = victim.damage(dmg, shooter);
  if (victim === player) {
    hurt.style.opacity = '0.85';
    setTimeout(() => (hurt.style.opacity = '0'), 130);
    rig.kick(0.45);
  }
  if (killed) {
    feed(`${shooter ? shooter.name : '???'} ⚡ ${victim.name}`);
    if (victim === player) rig.kick(1.2);
  }
};

const fireFrom = (actor, dir) => {
  if (!actor.canFire()) return;
  actor.consumeShot();
  shots.fire(actor.muzzle(), dir, actor, actors);
  if (actor === player) rig.kick(0.11);
};

/* ------------------------------------------------------------------ */
/*  HUD                                                                */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const ui = {
  ammo: $('ammo-count'), pips: $('pips'), clock: $('clock'),
  boostPct: $('boost-pct'), boostFill: $('boost-fill'), boostBox: $('hud-boost'),
  hp: $('hp-fill'), feed: $('feed'), respawn: $('respawn'), respawnT: $('respawn-t'),
  shootBtn: $('btn-shoot'), board: $('board'),
};
const hurt = $('hurt');

const pips = [];
for (let i = 0; i < CFG.maxStingers; i++) {
  const d = document.createElement('div');
  d.className = 'pip';
  ui.pips.appendChild(d);
  pips.push(d);
}

function feed(text) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.textContent = text;
  ui.feed.appendChild(el);
  setTimeout(() => el.remove(), 4000);
  while (ui.feed.children.length > 5) ui.feed.firstChild.remove();
}

let lastAmmo = -1, lastHp = -1, lastClock = '';
function updateHUD(timeLeft) {
  if (player.ammo !== lastAmmo) {
    lastAmmo = player.ammo;
    ui.ammo.innerHTML = `<b>${player.ammo}</b> <span>/ ${CFG.maxStingers}</span>`;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('off', i >= player.ammo);
    ui.shootBtn.classList.toggle('empty', player.ammo === 0);
  }

  const b = Math.round(player.boost);
  ui.boostPct.textContent = b + '%';
  ui.boostFill.style.width = b + '%';
  ui.boostBox.classList.toggle('low', b < 25);

  if (player.hp !== lastHp) {
    lastHp = player.hp;
    ui.hp.style.width = (player.hp / CFG.maxHp) * 100 + '%';
  }

  const t = Math.max(0, Math.ceil(timeLeft));
  const str = `${String((t / 60) | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  if (str !== lastClock) {
    lastClock = str;
    ui.clock.textContent = str;
    ui.clock.classList.toggle('urgent', t <= 30);
  }

  if (!player.alive) {
    ui.respawn.classList.remove('hidden');
    ui.respawnT.textContent = Math.max(0, Math.ceil(player.respawnTimer));
  } else {
    ui.respawn.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ */
/*  Match-Zustand                                                      */
/* ------------------------------------------------------------------ */
let running = false;
let timeLeft = CFG.matchTime;
const tmp = new THREE.Vector3();

function startMatch() {
  timeLeft = CFG.matchTime;
  for (const a of actors) { a.kills = 0; a.deaths = 0; a.respawn(world); }
  for (const pk of world.pickups) { pk.active = true; pk.mesh.scale.setScalar(1); }
  ui.feed.innerHTML = '';
  running = true;
}

function endMatch() {
  running = false;
  const rank = [...actors].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  ui.board.innerHTML =
    '<tr><th>#</th><th>Biene</th><th>Kills</th><th>Tode</th></tr>' +
    rank.map((a, i) =>
      `<tr class="${a.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${a.name}</td><td>${a.kills}</td><td>${a.deaths}</td></tr>`
    ).join('');
  $('end').classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/*  Spieler-Steuerung                                                  */
/* ------------------------------------------------------------------ */
function drivePlayer(dt) {
  // Zielrichtung = Kamera-Blickrichtung (inkl. Pitch) -> echter 360°-Flug
  player.aim.copy(rig.forward);

  tmp.set(0, 0, 0)
    .addScaledVector(rig.forward, input.move.y)
    .addScaledVector(rig.right, input.move.x);
  player.drive(tmp, input.boost);

  if (input.shoot && player.canFire()) fireFrom(player, rig.forward);
}

/* ------------------------------------------------------------------ */
/*  Pickups                                                            */
/* ------------------------------------------------------------------ */
function checkPickups() {
  for (const pk of world.pickups) {
    if (!pk.active) continue;
    for (const a of actors) {
      if (!a.alive) continue;
      if (a.position.distanceToSquared(pk.mesh.position) > 16) continue;
      if (pk.kind === 0) a.hp = Math.min(CFG.maxHp, a.hp + 35);
      else if (pk.kind === 1) a.ammo = CFG.maxStingers;
      else a.boost = CFG.boostMax;
      pk.active = false;
      pk.cooldown = 8;
      if (a === player) lastAmmo = lastHp = -1; // HUD-Refresh erzwingen
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Game-Loop — fester Physik-Substep gegen Tunneling bei Framedrops    */
/* ------------------------------------------------------------------ */
const STEP = 1 / 60;
let acc = 0, last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;     // Tab war im Hintergrund
  if (!running) { renderer.render(scene, camera); return; }

  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    acc -= STEP;
    steps++;
    timeLeft -= STEP;

    drivePlayer(STEP);
    for (const b of bots) b.think(STEP, actors, fireFrom);

    for (const a of actors) {
      a.regen(STEP);
      a.integrate(STEP, world);
      a.tickRespawn(STEP, world);
    }

    shots.update(STEP, actors);
    checkPickups();
  }

  world.update(dt);
  rig.update(dt, input.look, player.position, world);
  updateHUD(timeLeft);
  renderer.render(scene, camera);

  if (timeLeft <= 0) endMatch();
}
requestAnimationFrame(frame);

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* --- Bot-Auswahl -------------------------------------------------- */
const botPick = $('bot-pick');
function renderBotPick() {
  botPick.innerHTML = '';
  for (let n = CFG.npcMin; n <= CFG.npcMax; n++) {
    const b = document.createElement('button');
    b.className = 'opt' + (n === CFG.npcCount ? ' on' : '');
    b.textContent = n;
    b.addEventListener('click', () => { setBotCount(n); renderBotPick(); });
    botPick.appendChild(b);
  }
}
// Vorbelegung per URL: index.html?bots=3
const urlBots = parseInt(new URLSearchParams(location.search).get('bots'), 10);
setBotCount(Number.isFinite(urlBots) ? urlBots : CFG.npcCount);
renderBotPick();

function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
}

$('start-btn').addEventListener('click', () => {
  $('start').classList.add('hidden');
  enterFullscreen();
  last = performance.now();
  startMatch();
});

$('again').addEventListener('click', () => {
  $('end').classList.add('hidden');
  $('start').classList.remove('hidden');   // zurück ins Menü, Bots neu wählbar
  renderBotPick();
});

// Debug-Hook (praktisch für Tests und später fürs Netzwerk-Layer)
window.BHA = { scene, world, actors, player, bots, shots, rig, CFG, setBotCount };
