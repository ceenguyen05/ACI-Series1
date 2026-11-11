import { Vector3 } from 'three';
import type { Team } from '../../config/rules';
import { WEAPONS, type WeaponDef, type WeaponId } from '../../config/weapons';
import { GADGET_TUNING as G } from '../../config/gadgets';
import { MAX_GRENADES, UTILITIES, UTILITY_TUNING as U } from '../../config/utilities';
import { dirFromAngles } from '../../core/math';
import type { Agent } from '../entities/Agent';
import type { SimContext } from '../SimContext';
import { shotAngles, traceBullet } from './Ballistics';
import { explode } from './Explosion';

export type ShotKind = 'rocket' | 'grenade' | 'plasma' | 'stim' | 'knife';

export interface Shot {
  id: number;
  kind: ShotKind;
  weapon: WeaponId | 'stim' | 'tknife';
  ownerId: number;
  team: Team;
  pos: Vector3;
  vel: Vector3;
  born: number;
  travelled: number;
  bounces: number;
  /** Launcher ballistics captured at fire time (upgraded weapons hit harder). */
  proj?: NonNullable<WeaponDef['projectile']>;
}

let NEXT = 1;
const dir = new Vector3();

/**
 * Physical projectiles: RPG rockets, 40 mm launcher shells and stim darts. They fly with
 * gravity, collide with the world, players and gadgets, and resolve on impact.
 */
/** A thrown knife lying in the world, waiting to be picked up. */
export interface KnifeDrop { id: number; pos: Vector3; dir: Vector3; stuck: boolean }

/** Launched projectiles leave this far along the shot from the eye, and this far below it. */
const MUZZLE_FORWARD = 0.45;
const muzzleDrop = (kind: string) => (kind === 'rocket' ? 0.02 : 0.1);

/**
 * Holdover for a launcher: how far below the aim point (radians) the shell lands on a target
 * `range` metres away along the line of sight at `pitch` (gravity drop plus the muzzle sitting
 * under the eye). Put the target on the mark that far under the crosshair to hit it. NaN when the
 * shell can't reach.
 */
export function launcherHoldover(def: WeaponDef, pitch: number, range: number): number {
  const p = def.projectile;
  if (!p) return 0;
  const tx = range * Math.cos(pitch), ty = range * Math.sin(pitch), drop = muzzleDrop(p.kind);
  // height of the shell above the eye once it has covered the target's horizontal distance
  const heightAt = (a: number) => {
    const c = Math.cos(a), x = tx - MUZZLE_FORWARD * c;
    return Math.tan(a) * tx - drop - (p.gravity * x * x) / (2 * p.speed * p.speed * c * c);
  };
  let lo = pitch, hi = Math.min(pitch + 0.7, 1.45);
  if (heightAt(hi) < ty) return NaN;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (heightAt(mid) < ty) lo = mid; else hi = mid; }
  return (lo + hi) / 2 - pitch;
}

export class OrdnanceManager {
  shots: Shot[] = [];
  knives: KnifeDrop[] = [];
  private ctx!: SimContext;

  attach(ctx: SimContext) { this.ctx = ctx; }
  clear() { this.shots = []; this.knives = []; }

  /** Throwing knife: overhand (strength 1) is fast and flat, underhand is a lob. */
  throwKnife(a: Agent, strength: number) {
    const d = dirFromAngles(a.yaw, a.pitch + (strength < 0.5 ? 0.12 : 0.025), new Vector3());
    this.spawn(a, 'knife', 'tknife', d, strength < 0.5 ? U.knifeUnderhand : U.knifeSpeed);
    this.ctx.events.emit('throw', { agentId: a.id, kind: 'tknife' });
  }

  /** Fire a launcher. Spread from movement / jumping is applied to the launch direction. */
  fireLauncher(a: Agent, weapon: WeaponId | WeaponDef, spread: number) {
    const def = typeof weapon === 'string' ? WEAPONS[weapon] : weapon;
    const weaponId = def.id;
    const p = def.projectile!;
    const rng = this.ctx.rng;
    const ang = rng.next() * Math.PI * 2, r = rng.next() * spread;
    const aim = shotAngles(a);
    const d = dirFromAngles(aim.yaw + Math.cos(ang) * r, aim.pitch + Math.sin(ang) * r, new Vector3());
    this.spawn(a, p.kind, weaponId, d, p.speed);
    this.shots[this.shots.length - 1].proj = p;
  }

  fireStim(a: Agent) {
    const d = dirFromAngles(a.yaw, a.pitch + 0.02, new Vector3());
    this.spawn(a, 'stim', 'stim', d, G.stimSpeed);
  }

  private spawn(a: Agent, kind: ShotKind, weapon: WeaponId | 'stim' | 'tknife', d: Vector3, speed: number) {
    const eye = a.eyePos(new Vector3());
    const right = new Vector3(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
    const start = eye.clone().addScaledVector(d, MUZZLE_FORWARD).addScaledVector(right, kind === 'rocket' ? 0.18 : 0.1);
    start.y -= muzzleDrop(kind);
    if (this.ctx.world.collision.segmentBlocked(eye, start)) start.copy(eye);
    this.shots.push({ id: NEXT++, kind, weapon, ownerId: a.id, team: a.team, pos: start, vel: d.multiplyScalar(speed), born: this.ctx.time, travelled: 0, bounces: 0 });
  }

  update(dt: number) {
    const ctx = this.ctx, now = ctx.time;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const owner = ctx.agents.find((x) => x.id === s.ownerId) ?? null;
      const gravity = s.proj ? s.proj.gravity : s.kind === 'knife' ? U.knifeGravity : 9.8;
      let done = now - s.born > 7;
      const sub = 3, h = dt / sub;
      for (let k = 0; k < sub && !done; k++) {
        s.vel.y -= gravity * h;
        const step = s.vel.length() * h;
        dir.copy(s.vel).normalize();
        // the shooter can't hit themselves during the first few metres
        const res = traceBullet(ctx, s.travelled < 2 ? owner : null, s.pos, dir, step);
        if (res.t >= step - 1e-4 && !res.agent && !res.device) { s.pos.addScaledVector(dir, step); s.travelled += step; continue; }
        s.pos.copy(res.point);
        s.travelled += res.t;
        done = this.impact(s, owner, res.agent, res.device, res.normal, res.group);
        if (!done && res.normal) {
          // unarmed 40 mm shells bounce off
          s.pos.addScaledVector(res.normal, 0.05);
          s.vel.addScaledVector(res.normal, -1.35 * s.vel.dot(res.normal)).multiplyScalar(0.45);
          s.bounces++;
          if (s.bounces > 3 || s.vel.lengthSq() < 1) done = true;
        }
      }
      if (done) this.shots.splice(i, 1);
    }
    // walk over a dropped throwing knife to take it back
    for (let i = this.knives.length - 1; i >= 0; i--) {
      const k = this.knives[i];
      for (const a of ctx.agents) {
        if (!a.alive || a.grenades.tknife >= UTILITIES.tknife.max || a.totalGrenades() >= MAX_GRENADES) continue;
        if (Math.hypot(a.pos.x - k.pos.x, a.pos.z - k.pos.z) > 1.2 || Math.abs(a.pos.y + 0.4 - k.pos.y) > 1.6) continue;
        a.grenades.tknife++;
        this.knives.splice(i, 1);
        ctx.events.emit('knifePickup', { agentId: a.id });
        break;
      }
    }
  }

  private dropKnife(pos: Vector3, dir: Vector3, stuck: boolean) {
    this.knives.push({ id: NEXT++, pos: pos.clone(), dir: dir.clone().normalize(), stuck });
  }

  /** Returns true if the projectile is consumed. */
  private impact(s: Shot, owner: Agent | null, agent: Agent | null, device: import('../gadget/GadgetManager').Device | null, normal: Vector3 | null,
    group: import('../entities/Agent').HitGroup | null = null): boolean {
    const ctx = this.ctx;
    if (s.kind === 'knife') {
      const d = dir.clone();
      if (agent) {
        // lethal to the head or body; legs take a heavy hit
        const lethal = group !== 'legs';
        ctx.applyDamage(agent, owner, { health: lethal ? 250 : 70, armor: 0 }, group ?? 'chest', 'tknife', s.pos.clone(), d);
        this.dropKnife(new Vector3(agent.pos.x, agent.pos.y + 0.03, agent.pos.z), new Vector3(d.x, 0, d.z), false);
      } else if (device) {
        ctx.gadgets.damage(device, 60, owner, 'melee');
        this.dropKnife(s.pos.clone().setY(Math.max(0.03, s.pos.y - 0.3)), d, false);
      } else {
        // stick into walls / floors / props
        this.dropKnife(s.pos.clone().addScaledVector(d, 0.06), d, true);
      }
      // (no 'knife' event: that is a swing in the thrower's hands, and they let go of this one long ago)
      ctx.events.emit('impact', { point: s.pos.clone(), normal: normal ?? d.clone().negate(), surface: 'metal' });
      return true;
    }
    if (s.kind === 'stim') {
      if (agent && agent.team === s.team) healWithStim(ctx, agent, owner, false);
      else if (agent) ctx.applyDamage(agent, owner, { health: 8, armor: 0 }, 'chest', 'stim', s.pos.clone(), dir.clone());
      else if (device) ctx.gadgets.damage(device, 100, owner, 'dart');
      ctx.events.emit('impact', { point: s.pos.clone(), normal: normal ?? dir.clone().negate(), surface: 'metal' });
      return true;
    }
    const def = s.proj ?? WEAPONS[s.weapon as WeaponId].projectile!;
    const armed = s.travelled >= def.armDistance && s.bounces === 0; // a shell that bounced before arming is a dud
    if (armed || s.kind === 'rocket' || s.kind === 'plasma') {
      if (!armed) {
        // too close to arm: a rocket thuds in as a dud
        if (agent) ctx.applyDamage(agent, owner, { health: 45, armor: 0 }, 'chest', s.weapon, s.pos.clone(), dir.clone());
        ctx.events.emit('impact', { point: s.pos.clone(), normal: normal ?? dir.clone().negate(), surface: 'metal' });
        return true;
      }
      const at = normal ? s.pos.clone().addScaledVector(normal, 0.2) : s.pos.clone();
      explode(ctx, at, def.radius, def.damage, owner, s.weapon);
      return true;
    }
    if (agent) { ctx.applyDamage(agent, owner, { health: 30, armor: 0 }, 'chest', s.weapon, s.pos.clone(), dir.clone()); return true; }
    return false; // unarmed shell bounces
  }
}

/** Heal-over-time from a stim. Repeated stims on the same target within 12 s are weaker. */
export function healWithStim(ctx: SimContext, target: Agent, healer: Agent | null, self: boolean) {
  const now = ctx.time;
  target.stimHistory = target.stimHistory.filter((t) => now - t < 12);
  const amount = (self ? G.stimSelf : G.stimTeam) * Math.pow(0.55, target.stimHistory.length);
  target.stimHistory.push(now);
  target.heals.push({ rate: amount / G.stimDuration, until: now + G.stimDuration });
  ctx.events.emit('stimHeal', { targetId: target.id, healerId: healer?.id ?? -1, amount: Math.round(amount), self });
}
