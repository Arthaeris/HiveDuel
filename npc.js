/**
 * npc.js — Actor-Basisklasse (Spieler + Bots teilen sie) und die Bot-KI.
 *
 * Wichtig fürs spätere Multiplayer: Ein Actor weiß nicht, wer ihn steuert.
 * Der Spieler bekommt seine Beschleunigung vom Input, ein Bot von der FSM,
 * ein Remote-Spieler später vom Netzwerk. Gameplay-Code bleibt identisch.
 */
import * as THREE from 'three';
import { CFG, makeBee, resolveCollision, lineOfSight } from './systems.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _probe = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

/* ================================================================== */
/*  ACTOR                                                              */
/* ================================================================== */
export class Actor {
  constructor(scene, { color = 0xffd426, name = 'BEE', isPlayer = false } = {}) {
    this.name = name;
    this.color = color;
    this.isPlayer = isPlayer;
    this.mesh = makeBee(color);
    scene.add(this.mesh);

    this.position = this.mesh.position;
    this.velocity = new THREE.Vector3();
    this.accel = new THREE.Vector3();
    this.aim = new THREE.Vector3(0, 0, -1);

    this.radius = CFG.beeRadius;
    this.hp = CFG.maxHp;
    this.alive = true;
    this.respawnTimer = 0;

    this.ammo = CFG.maxStingers;
    this._ammoAcc = 0;
    this.fireTimer = 0;

    this.boost = CFG.boostMax;
    this.boosting = false;

    this.kills = 0;
    this.deaths = 0;
    this._roll = 0;
  }

  /** Beschleunigungswunsch in Weltkoordinaten setzen (Länge 0..1). */
  drive(dir01, boost) {
    this.accel.copy(dir01);
    if (this.accel.lengthSq() > 1) this.accel.normalize();
    this.boosting = !!boost && this.boost > 1;
  }

  get speedRatio() {
    return Math.min(1, this.velocity.length() / (CFG.maxSpeed * CFG.boostMult));
  }

  /** Munition + Boost regenerieren. Läuft auch im Tod weiter. */
  regen(dt) {
    this._ammoAcc += dt * CFG.stingerRegen;
    while (this._ammoAcc >= 1) {
      this._ammoAcc -= 1;
      if (this.ammo < CFG.maxStingers) this.ammo++;
    }
    if (this.ammo >= CFG.maxStingers) this._ammoAcc = 0;

    if (this.boosting) {
      this.boost = Math.max(0, this.boost - CFG.boostDrain * dt);
      if (this.boost <= 0) this.boosting = false;
    } else {
      this.boost = Math.min(CFG.boostMax, this.boost + CFG.boostRefill * dt);
    }
    this.fireTimer = Math.max(0, this.fireTimer - dt);
  }

  canFire() { return this.alive && this.ammo > 0 && this.fireTimer <= 0; }

  consumeShot() {
    this.ammo--;
    this.fireTimer = CFG.fireCooldown;
    _a.copy(this.aim).normalize();
    return _a.clone();
  }

  muzzle(out = new THREE.Vector3()) {
    return out.copy(this.position).addScaledVector(_a.copy(this.aim).normalize(), 2.6);
  }

  /** Bewegungsintegration — komplett frame-rate-unabhängig. */
  integrate(dt, world) {
    if (!this.alive) return;

    const mult = this.boosting ? CFG.boostMult : 1;
    this.velocity.addScaledVector(this.accel, CFG.accel * mult * dt);

    // exponentieller Luftwiderstand statt hartem Clamp -> weiches Ausschweben
    const damp = Math.exp(-CFG.drag * dt);
    this.velocity.multiplyScalar(damp);

    const max = CFG.maxSpeed * mult;
    const sp = this.velocity.length();
    if (sp > max) this.velocity.multiplyScalar(max / sp);

    this.position.addScaledVector(this.velocity, dt);

    if (resolveCollision(this.position, this.radius, world)) {
      this.velocity.multiplyScalar(0.55); // Aufprall dämpfen
    }

    this._orient(dt);
    this.mesh.userData.animate(dt, this.speedRatio);
  }

  _orient(dt) {
    _a.copy(this.aim);
    if (_a.lengthSq() < 1e-6) _a.set(0, 0, -1);
    _b.copy(this.position).add(_a);
    // Matrix4.lookAt(eye, target) legt +Z auf (eye - target), also nach HINTEN.
    // Die Biene ist mit dem Kopf auf +Z gebaut -> Argumente tauschen, sonst
    // fliegt sie rückwärts.
    _m.lookAt(_b, this.position, UP);
    _q.setFromRotationMatrix(_m);

    // Kurvenlage aus der Seitwärtsbewegung
    _c.crossVectors(UP, _a).normalize();
    const lateral = this.velocity.dot(_c) / CFG.maxSpeed;
    this._roll += (-lateral * 0.55 - this._roll) * Math.min(1, dt * 6);
    _q.multiply(_qRoll.setFromAxisAngle(FWD, this._roll));

    this.mesh.quaternion.slerp(_q, 1 - Math.exp(-CFG.turnLerp * dt));
  }

  damage(amount, from) {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.deaths++;
      this.respawnTimer = CFG.respawnDelay;
      this.mesh.visible = false;
      this.velocity.set(0, 0, 0);
      if (from) from.kills++;
      return true; // Kill
    }
    return false;
  }

  tickRespawn(dt, world) {
    if (this.alive) return false;
    this.respawnTimer -= dt;
    if (this.respawnTimer > 0) return false;
    this.respawn(world);
    return true;
  }

  /** Aus der Szene nehmen und Geometrie freigeben (Bot-Anzahl ändern). */
  dispose(scene) {
    scene.remove(this.mesh);
    if (this.mesh.userData.dispose) this.mesh.userData.dispose();
    this.alive = false;
  }

  respawn(world) {
    this.position.copy(world.randomSpawn());
    this.velocity.set(0, 0, 0);
    this.hp = CFG.maxHp;
    this.ammo = CFG.maxStingers;
    this.boost = CFG.boostMax;
    this.alive = true;
    this.mesh.visible = true;
  }
}

/* ================================================================== */
/*  BOT-BIENE — Patrol / Chase / Attack / Evade                        */
/* ================================================================== */
const SKILL = {
  easy:   { react: 0.55, aimErr: 0.20, lead: 0.4, engage: 55, burst: 3 },
  normal: { react: 0.32, aimErr: 0.12, lead: 0.75, engage: 70, burst: 4 },
  hard:   { react: 0.18, aimErr: 0.06, lead: 1.0, engage: 85, burst: 6 },
};

export class NPCBee extends Actor {
  constructor(scene, world, opts = {}) {
    super(scene, opts);
    this.world = world;
    this.skill = SKILL[opts.skill || 'normal'];
    this.state = 'patrol';
    this.target = null;
    this.waypoint = world.randomSpawn();
    this.thinkTimer = 0;
    this.stateTimer = 0;
    this.burstLeft = 0;
    this.strafeSign = Math.random() < 0.5 ? -1 : 1;
    this.strafePhase = Math.random() * 6.28;
    this.desired = new THREE.Vector3();
    this.respawn(world);
  }

  /**
   * @param dt        Delta
   * @param actors    alle Actors (für Zielsuche)
   * @param fireFn    (npc, dir) => void  — Schuss abfeuern
   */
  think(dt, actors, fireFn) {
    if (!this.alive) return;
    this.stateTimer += dt;
    this.thinkTimer -= dt;

    if (this.thinkTimer <= 0) {
      this.thinkTimer = this.skill.react;
      this._selectTarget(actors);
      this._transition();
    }

    switch (this.state) {
      case 'patrol': this._patrol(dt); break;
      case 'chase':  this._chase(dt); break;
      case 'attack': this._attack(dt, fireFn); break;
      case 'evade':  this._evade(dt); break;
    }

    this._steer(dt);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTimer = 0;
    if (s === 'attack') this.burstLeft = this.skill.burst;
    if (s === 'evade') this.strafeSign = Math.random() < 0.5 ? -1 : 1;
  }

  _selectTarget(actors) {
    let best = null, bestScore = Infinity;
    for (const a of actors) {
      if (a === this || !a.alive) continue;
      const d = this.position.distanceTo(a.position);
      if (d > 190) continue;
      const visible = lineOfSight(this.position, a.position, this.world);
      const score = d * (visible ? 1 : 2.6) * (a.isPlayer ? 0.75 : 1); // Spieler bevorzugen
      if (score < bestScore) { bestScore = score; best = a; }
    }
    this.target = best;
  }

  _transition() {
    if (!this.target) { this._setState('patrol'); return; }

    const d = this.position.distanceTo(this.target.position);
    const visible = lineOfSight(this.position, this.target.position, this.world);
    const lowHp = this.hp < 32;
    const noAmmo = this.ammo <= 0;

    if ((lowHp || noAmmo) && d < 90) this._setState('evade');
    else if (visible && d < this.skill.engage) this._setState('attack');
    else if (d < 190) this._setState('chase');
    else this._setState('patrol');
  }

  _patrol(dt) {
    if (this.position.distanceTo(this.waypoint) < 8 || this.stateTimer > 7) {
      this.waypoint.copy(this.world.randomSpawn());
      this.stateTimer = 0;
    }
    this.desired.copy(this.waypoint);
    this.aim.copy(this.desired).sub(this.position).normalize();
  }

  _chase(dt) {
    this.desired.copy(this.target.position);
    this.aim.copy(this.desired).sub(this.position).normalize();
  }

  _attack(dt, fireFn) {
    const toT = _a.copy(this.target.position).sub(this.position);
    const dist = toT.length();
    toT.divideScalar(dist || 1);

    // Kampfabstand halten + seitlich strafen, damit Bots kein Standziel sind
    this.strafePhase += dt * 1.4;
    const ideal = 34;
    const radial = (dist - ideal) * 0.06;
    _b.crossVectors(toT, UP).normalize().multiplyScalar(Math.sin(this.strafePhase) * this.strafeSign);
    _c.copy(toT).multiplyScalar(THREE.MathUtils.clamp(radial, -1, 1)).add(_b);
    _c.y += Math.sin(this.strafePhase * 0.7) * 0.35;
    this.desired.copy(this.position).addScaledVector(_c, 12);

    // Zielvorhalt auf die Flugbahn des Gegners
    const travel = dist / CFG.shotSpeed;
    _b.copy(this.target.position)
      .addScaledVector(this.target.velocity, travel * this.skill.lead)
      .sub(this.position)
      .normalize();
    _b.x += (Math.random() - 0.5) * this.skill.aimErr;
    _b.y += (Math.random() - 0.5) * this.skill.aimErr;
    _b.z += (Math.random() - 0.5) * this.skill.aimErr;
    this.aim.lerp(_b.normalize(), Math.min(1, dt * 7)).normalize();

    const onTarget = this.aim.dot(toT) > 0.965;
    if (onTarget && this.canFire() && lineOfSight(this.position, this.target.position, this.world)) {
      if (this.burstLeft > 0) {
        fireFn(this, this.aim);
        this.burstLeft--;
      } else if (this.stateTimer % 1 < dt) {
        this.burstLeft = this.skill.burst; // kurze Feuerpause zwischen Salven
      }
    }
  }

  _evade(dt) {
    const away = _a.copy(this.position).sub(this.target ? this.target.position : this.position);
    if (away.lengthSq() < 0.01) away.set(1, 0.3, 0);
    away.normalize();
    away.y += 0.35;
    this.desired.copy(this.position).addScaledVector(away, 40);
    this.aim.lerp(away, Math.min(1, dt * 4)).normalize();
    if (this.stateTimer > 4 && this.hp > 55 && this.ammo > 3) this._setState('chase');
  }

  /** Bewegung Richtung `desired` + einfache Hindernisvermeidung. */
  _steer(dt) {
    const dir = _a.copy(this.desired).sub(this.position);
    const dist = dir.length();
    if (dist > 0.001) dir.divideScalar(dist);

    // Vorausschau: sitzt vor mir Geometrie, weiche seitlich/nach oben aus
    _b.copy(this.position).addScaledVector(dir, 14);
    _probe.copy(_b);
    if (resolveCollision(_probe, this.radius * 2.2, this.world)) {
      _c.copy(_probe).sub(_b).normalize();  // Ausweichrichtung = Ausschieberichtung
      dir.addScaledVector(_c, 1.5).normalize();
    }

    this.drive(dir, this.state === 'chase' && dist > 70);
  }
}

const BOT_SKILLS = ['easy', 'normal', 'normal', 'hard', 'normal', 'easy', 'hard', 'normal', 'easy'];

/** Einzelnen Bot mit stabiler Identität für Index `i` erzeugen. */
export function makeNPC(scene, world, i, colors) {
  return new NPCBee(scene, world, {
    color: colors[(i + 1) % colors.length],
    name: `BOT ${i + 1}`,
    skill: BOT_SKILLS[i % BOT_SKILLS.length],
  });
}
