import { Vector3 } from 'three';
import type { Team } from '../../config/rules';
import { UTILITIES, UTILITY_TUNING as TUNE, type UtilityId } from '../../config/utilities';
import { DEG, clamp, dirFromAngles, segmentSphereOverlap } from '../../core/math';
import type { Agent } from '../entities/Agent';
import type { SimContext } from '../SimContext';
import { explosionDamage } from '../combat/damage';

export interface Projectile {
  id: number; kind: UtilityId; ownerId: number; team: Team;
  pos: Vector3; vel: Vector3; thrownAt: number; restSince: number; spin: number;
}
export interface SmokeCloud { id: number; pos: Vector3; start: number; end: number }
export interface FireZone { id: number; pos: Vector3; start: number; end: number; ownerId: number; team: Team; dmgAcc: Map<number, number> }
export interface DecoyState { id: number; pos: Vector3; end: number; nextShot: number; burst: number; ownerId: number; team: Team; sound: string }
export interface PulseState { id: number; pos: Vector3; ownerId: number; team: Team; left: number; next: number }

let NEXT = 1;
const tmpA = new Vector3(), tmpB = new Vector3(), tmpDir = new Vector3();

/** Simulation of thrown grenades/gadgets and their lingering effects. */
export class UtilityManager {
  projectiles: Projectile[] = [];
  smokes: SmokeCloud[] = [];
  fires: FireZone[] = [];
  decoys: DecoyState[] = [];
  pulses: PulseState[] = [];
  private ctx!: SimContext;

  attach(ctx: SimContext) { this.ctx = ctx; }

  clear() { this.projectiles = []; this.smokes = []; this.fires = []; this.decoys = []; this.pulses = []; }

  /**
   * Where a grenade leaves the hand and how fast, for a throw of `strength` (1 overhand, 0.72
   * medium, 0.45 underhand). The throw and its on-screen preview share this.
   */
  launch(a: Agent, strength: number, yaw = a.yaw, pitch = a.pitch): { pos: Vector3; vel: Vector3 } {
    const pitchDeg = pitch / DEG;
    const adj = clamp(pitchDeg + 10 * (1 - Math.abs(pitchDeg) / 90), -89, 89) * DEG;
    const dir = dirFromAngles(yaw, adj, new Vector3());
    const speed = TUNE.underhandSpeed + (TUNE.throwSpeed - TUNE.underhandSpeed) * clamp((strength - 0.45) / 0.55, 0, 1);
    const eye = a.eyePos(new Vector3());
    if (strength < 0.5) eye.y -= 0.6;
    const pos = eye.clone().addScaledVector(dir, 0.35);
    if (this.ctx.world.collision.segmentBlocked(eye, pos)) pos.copy(eye);
    return { pos, vel: dir.multiplyScalar(speed).addScaledVector(a.vel, 0.9) };
  }

  throwGrenade(a: Agent, kind: UtilityId, strength: number) {
    const ctx = this.ctx;
    const { pos, vel } = this.launch(a, strength);
    this.projectiles.push({ id: NEXT++, kind, ownerId: a.id, team: a.team, pos, vel, thrownAt: ctx.time, restSince: -1, spin: ctx.rng.range(-8, 8) });
    ctx.events.emit('throw', { agentId: a.id, kind });
    ctx.noise(a.pos, 6, a, 'reload');
  }

  /**
   * The flight a grenade thrown right now would take, up to where it goes off: the same
   * integration the real throw runs, one point per tick. `bounces` are the points where it
   * strikes a surface. `look` aims it somewhere other than the agent's last simulated view (the
   * renderer passes the live mouse look). Nothing in the match changes.
   */
  predict(a: Agent, kind: UtilityId, strength: number, dt: number, look?: { yaw: number; pitch: number }, maxTime = 6): { path: Vector3[]; bounces: Vector3[]; end: Vector3 } {
    const def = UTILITIES[kind];
    const p = { ...this.launch(a, strength, look?.yaw, look?.pitch) };
    const path = [p.pos.clone()], bounces: Vector3[] = [];
    let rest = -1;
    // (the real grenade is first integrated on the tick it is thrown, at age 0)
    for (let age = 0; age <= maxTime + 1e-9; age += dt) {
      const floor = this.integrate(p, dt, (at) => bounces.push(at.clone()));
      path.push(p.pos.clone());
      if (p.vel.length() < 0.25) { if (rest < 0) rest = age; } else rest = -1;
      if (kind === 'fire' ? floor || age >= (def.fuse ?? 2) : def.fuse !== null ? age >= def.fuse : rest >= 0 && age - rest > 0.25) break;
    }
    return { path, bounces, end: p.pos.clone() };
  }

  update(dt: number) {
    const ctx = this.ctx;
    const now = ctx.time;
    // ---- projectiles ----------------------------------------------------------------------
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const def = UTILITIES[p.kind];
      const landedOnFloor = this.integrate(p, dt, (at) => ctx.events.emit('bounce', { pos: at.clone(), kind: p.kind }));
      const age = now - p.thrownAt;
      const speed = p.vel.length();
      if (speed < 0.25) { if (p.restSince < 0) p.restSince = now; } else p.restSince = -1;
      let detonate = false;
      if (p.kind === 'fire') detonate = landedOnFloor || age >= (def.fuse ?? 2);
      else if (def.fuse !== null) detonate = age >= def.fuse;
      else detonate = (p.restSince >= 0 && now - p.restSince > 0.25) || age > 6;
      if (detonate) { this.projectiles.splice(i, 1); this.detonate(p); }
    }
    // ---- lingering effects ------------------------------------------------------------------
    this.smokes = this.smokes.filter((s) => s.end > now);
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (f.end <= now || this.smokes.some((s) => s.pos.distanceTo(f.pos) < TUNE.smokeRadius + TUNE.fireRadius * 0.5 && now - s.start > 0.2)) {
        this.fires.splice(i, 1);
        ctx.events.emit('fireOut', { pos: f.pos });
        continue;
      }
      this.burn(f, dt);
    }
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      if (now >= d.end) { this.decoys.splice(i, 1); ctx.events.emit('detonate', { kind: 'decoy', pos: d.pos, ownerId: d.ownerId }); continue; }
      if (now >= d.nextShot) {
        ctx.events.emit('decoyShot', { pos: d.pos, sound: d.sound as any });
        ctx.noise(d.pos, 45, null, 'decoy');
        d.burst--;
        if (d.burst <= 0) { d.burst = ctx.rng.int(1, 5); d.nextShot = now + ctx.rng.range(0.8, 2.2); }
        else d.nextShot = now + ctx.rng.range(0.09, 0.14);
      }
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      if (now < p.next) continue;
      const revealed: number[] = [];
      for (const a of ctx.agents) {
        if (!a.alive || a.team === p.team) continue;
        if (a.pos.distanceTo(p.pos) <= TUNE.pulseRadius) {
          a.revealedUntil = now + TUNE.pulseRevealTime;
          a.spottedUntil = Math.max(a.spottedUntil, now + TUNE.pulseRevealTime);
          revealed.push(a.id);
        }
      }
      ctx.events.emit('pulse', { pos: p.pos, team: p.team, revealed });
      p.left--;
      p.next = now + TUNE.pulseInterval;
      if (p.left <= 0) this.pulses.splice(i, 1);
    }
  }

  /**
   * Bouncy point-mass integration. Returns true if it struck a floor-like surface this tick;
   * `onBounce` hears about every hard strike.
   */
  private integrate(p: { pos: Vector3; vel: Vector3 }, dt: number, onBounce: (at: Vector3) => void): boolean {
    const col = this.ctx.world.collision;
    let hitFloor = false;
    const sub = 4, h = dt / sub;
    for (let s = 0; s < sub; s++) {
      p.vel.y -= TUNE.gravity * h;
      const step = p.vel.length() * h;
      if (step < 1e-5) continue;
      tmpDir.copy(p.vel).normalize();
      const hit = col.raycast(p.pos, tmpDir, step + TUNE.radius);
      if (hit && hit.t <= step + TUNE.radius) {
        p.pos.copy(hit.point).addScaledVector(hit.normal, TUNE.radius + 0.005);
        const vn = p.vel.dot(hit.normal);
        const impact = Math.abs(vn);
        p.vel.addScaledVector(hit.normal, -(1 + TUNE.restitution) * vn);
        // tangential friction
        const tn = tmpA.copy(hit.normal).multiplyScalar(p.vel.dot(hit.normal));
        const tangent = tmpB.copy(p.vel).sub(tn).multiplyScalar(TUNE.friction);
        p.vel.copy(tn).add(tangent);
        if (hit.normal.y > 0.7) {
          hitFloor = true;
          if (Math.abs(p.vel.y) < 1.2) p.vel.y = 0;
        }
        if (impact > 1.5) onBounce(p.pos);
      } else {
        p.pos.addScaledVector(p.vel, h);
      }
    }
    // resting on ground: kill tiny velocities
    if (hitFloor && p.vel.lengthSq() < 0.1) p.vel.set(0, 0, 0);
    return hitFloor;
  }

  private detonate(p: Projectile) {
    const ctx = this.ctx;
    const now = ctx.time;
    const pos = p.pos.clone();
    const owner = ctx.agents.find((a) => a.id === p.ownerId) ?? null;
    switch (p.kind) {
      case 'frag': {
        ctx.events.emit('detonate', { kind: 'frag', pos, ownerId: p.ownerId });
        ctx.noise(pos, 60, owner, 'explosion');
        const from = pos.clone().add(new Vector3(0, 0.2, 0));
        for (const a of ctx.agents) {
          if (!a.alive) continue;
          const c = a.centerPos(tmpA);
          const d = c.distanceTo(from);
          if (d > TUNE.fragRadius) continue;
          if (ctx.world.collision.segmentBlocked(from, c)) continue;
          const raw = TUNE.fragDamage * Math.pow(1 - d / TUNE.fragRadius, 1.2);
          if (raw < 1) continue;
          const dir = c.clone().sub(from).normalize();
          ctx.applyDamage(a, owner, explosionDamage(raw, a.armor), 'chest', 'frag', c.clone(), dir);
        }
        ctx.gadgets.explosion(from, TUNE.fragRadius, TUNE.fragDamage, owner);
        break;
      }
      case 'flash': {
        ctx.events.emit('detonate', { kind: 'flash', pos, ownerId: p.ownerId });
        ctx.noise(pos, 40, owner, 'explosion');
        for (const a of ctx.agents) {
          if (!a.alive) continue;
          const eye = a.eyePos(tmpA);
          const d = eye.distanceTo(pos);
          if (d > TUNE.flashRange) continue;
          if (ctx.world.collision.segmentBlocked(pos, eye)) continue;
          const view = a.viewDir(tmpB);
          const to = tmpDir.copy(pos).sub(eye).normalize();
          const dot = view.dot(to);
          const angle = dot > 0.6 ? 1 : dot > 0 ? 0.35 + 0.65 * (dot / 0.6) : dot > -0.5 ? 0.2 : 0.08;
          const distF = clamp(1 - Math.pow(d / TUNE.flashRange, 1.4), 0, 1);
          const duration = TUNE.flashMaxDuration * angle * distF;
          if (duration < 0.3) continue;
          a.flashUntil = Math.max(a.flashUntil, now + duration);
          a.flashDuration = Math.max(duration, a.flashUntil - now);
          a.flashStrength = Math.max(clamp(duration / 2.2, 0, 1), a.flashUntil > now ? a.flashStrength : 0);
          if (owner && owner.team !== a.team) a.flashedBy.set(owner.id, now + duration);
          ctx.events.emit('flashed', { agentId: a.id, strength: a.flashStrength, duration, byId: p.ownerId });
        }
        break;
      }
      case 'smoke': {
        const center = pos.clone(); center.y = Math.max(center.y, 0) + 1.2;
        this.smokes.push({ id: p.id, pos: center, start: now, end: now + TUNE.smokeDuration });
        ctx.events.emit('detonate', { kind: 'smoke', pos, ownerId: p.ownerId });
        break;
      }
      case 'fire': {
        // find ground below
        const down = ctx.world.collision.raycast(pos.clone().add(new Vector3(0, 0.1, 0)), new Vector3(0, -1, 0), 4);
        if (!down) { ctx.events.emit('fireOut', { pos }); break; }
        const ground = down.point.clone();
        if (this.smokes.some((s) => s.pos.distanceTo(ground) < TUNE.smokeRadius)) {
          ctx.events.emit('fireOut', { pos: ground });
          break;
        }
        this.fires.push({ id: p.id, pos: ground, start: now, end: now + TUNE.fireDuration, ownerId: p.ownerId, team: p.team, dmgAcc: new Map() });
        ctx.events.emit('detonate', { kind: 'fire', pos: ground, ownerId: p.ownerId });
        ctx.noise(ground, 25, owner, 'explosion');
        break;
      }
      case 'decoy': {
        const ownerSound = owner?.primary?.def.sound ?? owner?.secondary?.def.sound ?? 'rifle';
        this.decoys.push({ id: p.id, pos, end: now + TUNE.decoyDuration, nextShot: now + 0.3, burst: 3, ownerId: p.ownerId, team: p.team, sound: ownerSound });
        break;
      }
      case 'stun': {
        ctx.events.emit('detonate', { kind: 'stun', pos, ownerId: p.ownerId });
        ctx.noise(pos, 45, owner, 'explosion');
        const from = pos.clone().add(new Vector3(0, 0.15, 0));
        for (const a of ctx.agents) {
          if (!a.alive) continue;
          const c = a.centerPos(tmpA);
          const d = c.distanceTo(from);
          if (d > TUNE.stunRadius) continue;
          if (ctx.world.collision.segmentBlocked(from, c) && ctx.world.collision.segmentBlocked(from, a.eyePos(tmpB))) continue;
          const strength = clamp(1.15 - d / TUNE.stunRadius, 0.3, 1);
          const duration = TUNE.stunMaxDuration * (0.35 + 0.65 * strength);
          if (now + duration > a.stunUntil) { a.stunUntil = now + duration; a.stunStrength = Math.max(strength, a.stunAt(now)); }
          ctx.events.emit('stunned', { agentId: a.id, strength, duration, byId: p.ownerId });
        }
        break;
      }
      case 'pulse': {
        this.pulses.push({ id: p.id, pos, ownerId: p.ownerId, team: p.team, left: TUNE.pulseCount, next: now + 0.6 });
        ctx.events.emit('detonate', { kind: 'pulse', pos, ownerId: p.ownerId });
        break;
      }
    }
  }

  private burn(f: FireZone, dt: number) {
    const ctx = this.ctx;
    const owner = ctx.agents.find((a) => a.id === f.ownerId) ?? null;
    const grow = clamp((ctx.time - f.start) / 0.6, 0.3, 1);
    const radius = TUNE.fireRadius * grow;
    const from = tmpA.copy(f.pos); from.y += 0.3;
    for (const a of ctx.agents) {
      if (!a.alive) continue;
      const dx = a.pos.x - f.pos.x, dz = a.pos.z - f.pos.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      if (Math.abs(a.pos.y - f.pos.y) > 1.2) continue;
      tmpB.set(a.pos.x, a.pos.y + 0.3, a.pos.z);
      if (ctx.world.collision.segmentBlocked(from, tmpB)) continue;
      const acc = (f.dmgAcc.get(a.id) ?? 0) + TUNE.fireDps * dt;
      const whole = Math.floor(acc);
      f.dmgAcc.set(a.id, acc - whole);
      if (whole > 0) ctx.applyDamage(a, owner, { health: whole, armor: 0 }, 'legs', 'fire', a.pos.clone(), new Vector3(dx, 0, dz).normalize());
    }
  }

  /** Smoke radius at time t (blooms in). */
  smokeRadius(s: SmokeCloud, t: number): number {
    const fadeOut = clamp((s.end - t) / 1.5, 0, 1);
    return TUNE.smokeRadius * clamp((t - s.start) / TUNE.smokeBloom, 0.15, 1) * (0.6 + 0.4 * fadeOut);
  }

  /** Does smoke block the line a → b? */
  smokeBlocks(a: Vector3, b: Vector3): boolean {
    const t = this.ctx.time;
    for (const s of this.smokes) {
      const r = this.smokeRadius(s, t) * 0.92;
      if (r < 0.8) continue;
      if (segmentSphereOverlap(a, b, s.pos, r) > 1.0) return true;
      if (a.distanceTo(s.pos) < r * 0.8) return true;
    }
    return false;
  }

  /** Is a point inside any fire zone? (bots avoid) */
  inFire(x: number, z: number, margin = 0.5): boolean {
    for (const f of this.fires) if (Math.hypot(x - f.pos.x, z - f.pos.z) < TUNE.fireRadius + margin) return true;
    return false;
  }
}
