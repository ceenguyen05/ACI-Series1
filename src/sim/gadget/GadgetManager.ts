import { Vector3 } from 'three';
import type { Team } from '../../config/rules';
import { GADGETS, GADGET_TUNING as G, type GadgetId } from '../../config/gadgets';
import { DEG, angleDiff, clamp, dirFromAngles, wrapAngle, yawTo } from '../../core/math';
import type { Agent, AgentCommand } from '../entities/Agent';
import { rayBox, type Box } from '../physics/CollisionWorld';
import type { NavPoint } from '../ai/NavGrid';
import type { SimContext } from '../SimContext';
import { explode } from '../combat/Explosion';

export type DeviceKind = 'drone' | 'stickyCam' | 'flockCam' | 'cctv' | 'mine' | 'wire' | 'shield'
  | 'c4' | 'barricade' | 'steelBarricade' | 'ammoBox' | 'hunter' | 'missile';
export type DamageKind = 'bullet' | 'melee' | 'explosion' | 'dart';

/** How hard each kind of damage hits each device (default 1). */
const DAMAGE_MULT: Partial<Record<DeviceKind, Partial<Record<DamageKind, number>>>> = {
  // one stim dart (100) takes a 120 HP wooden barricade down, as the stim pistol promises
  barricade: { bullet: 0.25, melee: 1, explosion: 3, dart: 1.2 },
  steelBarricade: { bullet: 0, melee: 0.06, explosion: 2.5, dart: 0.08 },
  shield: { explosion: 2.5 },
};
/** Devices that are physical colliders (hit through the world raycast, not the device list). */
const COLLIDERS = new Set<DeviceKind>(['shield', 'barricade', 'steelBarricade']);

export interface Device {
  id: number;
  kind: DeviceKind;
  team: Team;
  /** Owning agent id, or -1 for building CCTV. */
  ownerId: number;
  name: string;
  pos: Vector3;
  /** View direction (cameras/drones) or facing (mine/wire/shield). */
  yaw: number;
  pitch: number;
  baseYaw: number;
  basePitch: number;
  normal: Vector3 | null;
  health: number;
  alive: boolean;
  vel: Vector3;
  onGround: boolean;
  createdAt: number;
  jammedUntil: number;
  triggeredAt: number;
  armed: boolean;
  lastScan: number;
  lastAlert: number;
  collider: Box | null;
  /** Route state for autonomous devices; `goalId` is the agent a Hunter Drone is flying to. */
  ai: { path: NavPoint[] | null; idx: number; tx: number; tz: number; goalId?: number } | null;
  jumpHeld: boolean;
  /** Barricade footprint (doorway) – used by the renderer. */
  size?: { w: number; h: number; t: number; alongX: boolean };
  doorKey?: number;
  /** Ammo box: players who already resupplied. */
  usedBy?: Set<number>;
  /** Hunter drone / missile target and state. */
  target?: Vector3 | null;
  boost?: boolean;
}

interface Thrown { id: number; kind: 'stickyCam' | 'emp' | 'drone' | 'c4'; ownerId: number; team: Team; pos: Vector3; vel: Vector3; thrownAt: number; restSince: number; aiTarget: { x: number; z: number } | null }

const VIEWABLE: DeviceKind[] = ['drone', 'stickyCam', 'flockCam', 'cctv'];
let NEXT = 1;
const tA = new Vector3(), tB = new Vector3(), tD = new Vector3();

/** Simulation of gadget devices (cameras, drones, traps, shields) and thrown gadgets. */
export class GadgetManager {
  devices: Device[] = [];
  thrown: Thrown[] = [];
  private ctx!: SimContext;
  private wireNoise = new Map<number, number>();

  attach(ctx: SimContext) { this.ctx = ctx; }

  // ------------------------------------------------------------------ lifecycle
  /** Remove every device and re-install the building CCTV for Defenders. */
  resetRound() {
    for (const d of this.devices) this.release(d);
    this.devices = [];
    this.thrown = [];
    this.ctx.world.collision.clearDynamic();
    this.ctx.world.nav.unblockAll();
    for (const c of this.ctx.world.map.cctv) {
      const d = this.make('cctv', 'CT', -1, new Vector3(c.x, c.y, c.z));
      d.name = c.name;
      d.yaw = d.baseYaw = yawTo(c.lookX - c.x, c.lookZ - c.z);
      d.pitch = d.basePitch = Math.atan2(c.lookY - c.y, Math.hypot(c.lookX - c.x, c.lookZ - c.z));
      d.health = 1;
    }
  }

  private make(kind: DeviceKind, team: Team, ownerId: number, pos: Vector3): Device {
    const d: Device = {
      id: NEXT++, kind, team, ownerId, name: kind === 'cctv' ? 'CCTV' : GADGETS[kind as GadgetId]?.name ?? kind, pos, yaw: 0, pitch: 0, baseYaw: 0, basePitch: 0,
      normal: null, health: kind === 'cctv' ? 1 : GADGETS[kind as GadgetId]?.health ?? 30, alive: true, vel: new Vector3(), onGround: false,
      createdAt: this.ctx.time, jammedUntil: 0, triggeredAt: -1, armed: false, lastScan: 0, lastAlert: -100, collider: null, ai: null, jumpHeld: false,
    };
    this.devices.push(d);
    return d;
  }

  private release(d: Device) {
    if (d.collider) { this.ctx.world.collision.removeDynamic(d.collider); d.collider = null; }
    // shields and barricades both block bot routes; anything else has no block to lift
    this.ctx.world.nav.unblock(d.id);
  }

  // ------------------------------------------------------------------ deploying
  /** Use a gadget from the agent's inventory. Returns false if it could not be deployed (nothing consumed). */
  deploy(a: Agent, kind: GadgetId, aiTarget: { x: number; z: number } | null = null): boolean {
    const ctx = this.ctx;
    const def = GADGETS[kind];
    const eye = a.eyePos(new Vector3());
    const view = a.viewDir(new Vector3());
    if (def.deploy === 'throw') {
      const speed = kind === 'drone' ? G.droneThrowSpeed : G.stickThrowSpeed;
      const dir = dirFromAngles(a.yaw, kind === 'drone' ? Math.min(a.pitch, 0.1) : a.pitch + 0.08, new Vector3());
      const start = eye.clone().addScaledVector(dir, 0.3);
      if (kind === 'drone') start.y -= 0.6;
      if (ctx.world.collision.segmentBlocked(eye, start)) start.copy(eye);
      this.thrown.push({ id: NEXT++, kind: kind as Thrown['kind'], ownerId: a.id, team: a.team, pos: start, vel: dir.multiplyScalar(speed).addScaledVector(a.vel, 0.6), thrownAt: ctx.time, restSince: -1, aiTarget });
      ctx.events.emit('gadgetDeploy', { agentId: a.id, kind, pos: start.clone() });
      return true;
    }
    if (kind === 'barricade' || kind === 'steelBarricade') return this.placeBarricade(a, kind, eye, view);
    // placed gadgets: on the floor in front of the player (or at the aimed floor point within reach)
    const hit = ctx.world.collision.raycast(eye, view, 2.6);
    let p: Vector3;
    if (hit && hit.normal.y > 0.7) p = hit.point.clone();
    else {
      const ahead = kind === 'shield' ? 1.0 : kind === 'wire' ? 1.6 : 0.9;
      p = new Vector3(a.pos.x - Math.sin(a.yaw) * ahead, a.pos.y, a.pos.z - Math.cos(a.yaw) * ahead);
      const max = hit ? hit.t - 0.3 : 9;
      if (hit && Math.hypot(p.x - a.pos.x, p.z - a.pos.z) > max) return false;
      p.y = ctx.world.collision.groundHeight(p.x, p.z, a.pos.y + 0.5);
    }
    if (ctx.world.collision.segmentBlocked(tA.set(a.pos.x, a.pos.y + 0.5, a.pos.z), tB.set(p.x, p.y + 0.3, p.z))) return false;
    return this.placeAt(a, kind, p, a.yaw);
  }

  /** Every doorway narrow enough to board up (bots use this to pick one). */
  doorFrames() {
    return this.ctx.world.map.doors.map((_, i) => ({ i, f: this.doorFrame(i) })).filter((x) => x.f && !this.devices.some((d) => d.alive && d.doorKey === x.i))
      .map((x) => ({ i: x.i, ...x.f! }));
  }

  /** Doorway geometry for barricades (null if too wide to board up). */
  private doorFrame(i: number) {
    const map = this.ctx.world.map, d = map.doors[i];
    const { cellSize: cs, originX: ox, originZ: oz } = map;
    const x0 = ox + d.c0 * cs, x1 = ox + (d.c1 + 1) * cs, z0 = oz + d.r0 * cs, z1 = oz + (d.r1 + 1) * cs;
    let alongX: boolean;
    if (d.c1 > d.c0) alongX = true;
    else if (d.r1 > d.r0) alongX = false;
    else alongX = !(this.ctx.world.charAt(d.c0, d.r0 - 1) === '#' && this.ctx.world.charAt(d.c0, d.r0 + 1) === '#');
    const w = alongX ? x1 - x0 : z1 - z0;
    if (w > 4.2) return null;
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w, h: Math.min(d.lintel, 3), alongX };
  }

  /** Board up the doorway the agent is looking at (within reach). */
  /**
   * The doorway a barricade would go into (the one nearest the point 2.2 m along your view,
   * within reach), or why it can't: also used for the placement preview.
   */
  barricadeTarget(a: Agent, kind: 'barricade' | 'steelBarricade', eye: Vector3, view: Vector3) {
    const ctx = this.ctx;
    const aim = eye.clone().addScaledVector(view, 2.2);
    let best = -1, bestD = 3.2;
    ctx.world.map.doors.forEach((_, i) => {
      const f = this.doorFrame(i);
      if (!f) return;
      if (Math.hypot(f.cx - a.pos.x, f.cz - a.pos.z) > 3.8) return;
      const dd = Math.hypot(f.cx - aim.x, f.cz - aim.z);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (best < 0) return null;
    const f = this.doorFrame(best)!;
    const t = kind === 'steelBarricade' ? 0.1 : 0.14;
    const box = f.alongX
      ? { minX: f.cx - f.w / 2, maxX: f.cx + f.w / 2, minZ: f.cz - t / 2, maxZ: f.cz + t / 2, minY: 0, maxY: f.h }
      : { minX: f.cx - t / 2, maxX: f.cx + t / 2, minZ: f.cz - f.w / 2, maxZ: f.cz + f.w / 2, minY: 0, maxY: f.h };
    let blocked = this.devices.some((d) => d.alive && d.doorKey === best);
    for (const o of ctx.agents) {
      if (o.alive && o.pos.x + 0.4 > box.minX && o.pos.x - 0.4 < box.maxX && o.pos.z + 0.4 > box.minZ && o.pos.z - 0.4 < box.maxZ) blocked = true;
    }
    return { door: best, f, t, box, blocked };
  }

  placeBarricade(a: Agent, kind: 'barricade' | 'steelBarricade', eye: Vector3, view: Vector3): boolean {
    const ctx = this.ctx;
    const target = this.barricadeTarget(a, kind, eye, view);
    if (!target || target.blocked) return false;
    const { f, t, box, door: best } = target;
    const d = this.make(kind, a.team, a.id, new Vector3(f.cx, 0, f.cz));
    d.yaw = d.baseYaw = f.alongX ? 0 : Math.PI / 2;
    d.size = { w: f.w, h: f.h, t, alongX: f.alongX };
    d.doorKey = best;
    d.collider = ctx.world.collision.addDynamic({ ...box, surface: kind === 'steelBarricade' ? 'metal' : 'wood', device: d.id });
    ctx.world.nav.block(d.id, box.minX, box.minZ, box.maxX, box.maxZ);
    ctx.events.emit('gadgetDeploy', { agentId: a.id, kind, pos: d.pos.clone() });
    ctx.noise(d.pos, 18, a, 'reload');
    return true;
  }

  /** The barricade directly in front of an eye within reach (for crowbars). */
  barricadeAt(eye: Vector3, dir: Vector3, reach = 1.9): Device | null {
    const hit = this.ctx.world.collision.raycast(eye, dir, reach);
    const d = hit && hit.box.device !== undefined ? this.get(hit.box.device) : null;
    return d && (d.kind === 'barricade' || d.kind === 'steelBarricade') ? d : null;
  }

  /** Ammo box within reach that this agent hasn't used yet this round. */
  ammoBoxNear(a: Agent): Device | null {
    for (const d of this.devices) {
      if (d.alive && d.kind === 'ammoBox' && d.team === a.team && !d.usedBy?.has(a.id) && d.pos.distanceTo(a.pos) < 1.7) return d;
    }
    return null;
  }

  /** Blow every C4 charge this agent has placed. */
  detonateC4(a: Agent): boolean {
    const mine = this.devices.filter((d) => d.alive && d.kind === 'c4' && d.ownerId === a.id);
    if (!mine.length) return false;
    this.ctx.events.emit('c4Detonate', { agentId: a.id });
    for (const d of mine) {
      d.alive = false;
      this.devices = this.devices.filter((x) => x !== d);
      const at = d.normal ? d.pos.clone().addScaledVector(d.normal, 0.15) : d.pos.clone();
      explode(this.ctx, at, G.c4Radius, G.c4Damage, a, 'c4');
    }
    return true;
  }

  /** Killstreak: quadcopter that hunts the nearest enemy. */
  spawnHunter(a: Agent) {
    const d = this.make('hunter', a.team, a.id, new Vector3(a.pos.x, a.pos.y + 2.1, a.pos.z));
    d.health = 25;
    d.yaw = a.yaw;
    d.ai = { path: null, idx: 0, tx: a.pos.x, tz: a.pos.z };
    return d;
  }

  /** Killstreak: guided cruise missile from high above. Humans steer it; bots aim it at `target`. */
  spawnMissile(a: Agent, target: Vector3 | null): boolean {
    const back = new Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw)).multiplyScalar(22);
    const d = this.make('missile', a.team, a.id, new Vector3(a.pos.x + back.x, 95, a.pos.z + back.z));
    d.health = 999;
    d.target = target;
    d.yaw = a.yaw; d.pitch = -1.15;
    if (target) { d.yaw = yawTo(target.x - d.pos.x, target.z - d.pos.z); d.pitch = Math.atan2(target.y - d.pos.y, Math.hypot(target.x - d.pos.x, target.z - d.pos.z)); }
    if (!a.isBot) this.operate(a, d.id);
    return true;
  }

  /** Place a ground gadget at an exact spot (also used directly by bots). */
  placeAt(a: Agent, kind: GadgetId, p: Vector3, yaw: number): boolean {
    const ctx = this.ctx;
    p = p.clone();
    p.y = ctx.world.collision.groundHeight(p.x, p.z, p.y + 0.6);
    if (kind === 'shield') {
      const snap = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
      const alongX = Math.abs(Math.sin(snap)) < 0.5; // facing ±Z → panel spans X
      const hw = alongX ? 0.6 : 0.07, hd = alongX ? 0.07 : 0.6;
      const box = { minX: p.x - hw, maxX: p.x + hw, minZ: p.z - hd, maxZ: p.z + hd, minY: p.y, maxY: p.y + 1.05 };
      if (ctx.world.collision.overlaps(box.minX, box.minY + 0.05, box.minZ, box.maxX, box.maxY, box.maxZ)) return false;
      for (const o of ctx.agents) if (o.alive && Math.abs(o.pos.x - p.x) < hw + 0.4 && Math.abs(o.pos.z - p.z) < hd + 0.4) return false;
      const d = this.make('shield', a.team, a.id, p);
      d.yaw = d.baseYaw = snap;
      d.collider = ctx.world.collision.addDynamic({ ...box, surface: 'metal', device: d.id });
      ctx.world.nav.block(d.id, box.minX, box.minZ, box.maxX, box.maxZ);
    } else {
      const d = this.make(kind as DeviceKind, a.team, a.id, p);
      d.yaw = d.baseYaw = yaw;
      if (kind === 'flockCam') { d.pos.y += 1.9; d.pitch = d.basePitch = -0.12; }
    }
    ctx.events.emit('gadgetDeploy', { agentId: a.id, kind, pos: p.clone() });
    ctx.noise(p, 6, a, 'reload');
    return true;
  }

  // ------------------------------------------------------------------ viewing
  feedsFor(a: Agent): Device[] {
    const now = this.ctx.time;
    const list = this.devices.filter((d) => d.alive && d.team === a.team && VIEWABLE.includes(d.kind) && d.jammedUntil <= now);
    const rank = (d: Device) => (d.ownerId === a.id ? 0 : 1) * 10 + VIEWABLE.indexOf(d.kind);
    return list.sort((x, y) => rank(x) - rank(y) || x.id - y.id);
  }

  get(id: number | null) { return id === null ? null : this.devices.find((d) => d.id === id && d.alive) ?? null; }

  /** Start/stop operating a camera/drone feed. */
  operate(a: Agent, deviceId: number | null) {
    if (a.operating === deviceId) return;
    a.operating = deviceId;
    this.ctx.events.emit('operate', { agentId: a.id, deviceId });
  }

  cycle(a: Agent, dir: number) {
    const feeds = this.feedsFor(a);
    if (!feeds.length) { this.operate(a, null); return; }
    const i = feeds.findIndex((d) => d.id === a.operating), step = Math.sign(dir);
    const next = feeds[((i < 0 ? 0 : i + step) % feeds.length + feeds.length) % feeds.length];
    this.operate(a, next.id);
  }

  eye(d: Device, out = new Vector3()): Vector3 {
    out.copy(d.pos);
    if (d.kind === 'drone') out.y += G.droneEye;
    else if (d.normal) out.addScaledVector(d.normal, 0.06);
    return out;
  }

  /** Apply the operator's command to the device being viewed. */
  control(a: Agent, cmd: AgentCommand, dt: number, firePressed: boolean) {
    const d = this.get(a.operating);
    if (!d || d.jammedUntil > this.ctx.time) { this.operate(a, null); return; }
    if (d.kind === 'missile') {
      d.yaw = cmd.yaw;
      d.pitch = clamp(cmd.pitch, -1.5, -0.3);
      if (firePressed) d.boost = true;
      return;
    }
    if (d.kind === 'drone') {
      d.yaw = cmd.yaw; d.pitch = clamp(cmd.pitch, -1.2, 1.2);
      this.drive(d, cmd.forward, cmd.right, cmd.jump, dt);
    } else {
      const lim = d.kind === 'cctv' || d.kind === 'flockCam' ? 75 * DEG : 85 * DEG;
      d.yaw = wrapAngle(d.baseYaw + clamp(angleDiff(d.baseYaw, cmd.yaw), -lim, lim));
      d.pitch = clamp(cmd.pitch, d.basePitch - 0.8, d.basePitch + 0.8);
    }
    // a human watching a feed passively spots what the feed sees
    this.scan(d, 70, G.camRange, false);
    if (firePressed) this.ping(a, d);
  }

  /** Clamp a camera's look to its mount (used by controllers to sync their yaw). */
  lookFor(d: Device) { return { yaw: d.yaw, pitch: d.pitch }; }

  private ping(a: Agent, d: Device) {
    const ctx = this.ctx, now = ctx.time;
    const eye = this.eye(d, tA.clone());
    const view = dirFromAngles(d.yaw, d.pitch, new Vector3());
    const revealed: number[] = [];
    for (const e of ctx.agents) {
      if (!e.alive || e.team === d.team) continue;
      const c = e.centerPos(new Vector3());
      const to = c.clone().sub(eye);
      const dist = to.length();
      if (dist > G.camRange || to.normalize().dot(view) < Math.cos(G.pingCone * DEG)) continue;
      if (!this.visible(eye, e)) continue;
      e.revealedUntil = Math.max(e.revealedUntil, now + G.pingRevealTime);
      e.spottedUntil = Math.max(e.spottedUntil, now + G.pingRevealTime);
      revealed.push(e.id);
    }
    ctx.events.emit('ping', { agentId: a.id, team: d.team, revealed, pos: eye.clone() });
  }

  private visible(eye: Vector3, e: Agent): boolean {
    const col = this.ctx.world.collision;
    for (const p of [e.eyePos(tB), tD.set(e.pos.x, e.pos.y + e.height * 0.55, e.pos.z)]) {
      if (!col.segmentBlocked(eye, p) && !this.ctx.utility.smokeBlocks(eye, p)) return true;
    }
    return false;
  }

  /** Auto-scan a device's view cone. `reveal` = full x-ray reveal (flock/bot cams) vs radar spot only. */
  private scan(d: Device, fovDeg: number, range: number, reveal: boolean): Agent[] {
    const ctx = this.ctx, now = ctx.time;
    if (now - d.lastScan < 0.35) return [];
    d.lastScan = now;
    const eye = this.eye(d, new Vector3());
    const view = dirFromAngles(d.yaw, d.pitch, new Vector3());
    const seen: Agent[] = [];
    for (const e of ctx.agents) {
      if (!e.alive || e.team === d.team) continue;
      const to = e.centerPos(new Vector3()).sub(eye);
      const dist = to.length();
      if (dist > range || to.normalize().dot(view) < Math.cos((fovDeg / 2) * DEG)) continue;
      if (!this.visible(eye, e)) continue;
      e.spottedUntil = Math.max(e.spottedUntil, now + G.autoRevealTime);
      if (reveal) e.revealedUntil = Math.max(e.revealedUntil, now + G.autoRevealTime);
      seen.push(e);
    }
    return seen;
  }

  // ------------------------------------------------------------------ physics helpers
  private drive(d: Device, forward: number, right: number, jump: boolean, dt: number) {
    const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw), rx = Math.cos(d.yaw), rz = -Math.sin(d.yaw);
    let wx = fx * forward + rx * right, wz = fz * forward + rz * right;
    const l = Math.hypot(wx, wz);
    if (l > 1) { wx /= l; wz /= l; }
    const accel = d.onGround ? 22 : 4;
    d.vel.x += clamp(wx * G.droneSpeed - d.vel.x, -accel * dt, accel * dt);
    d.vel.z += clamp(wz * G.droneSpeed - d.vel.z, -accel * dt, accel * dt);
    if (jump && !d.jumpHeld && d.onGround) { d.vel.y = G.droneHop; d.onGround = false; }
    d.jumpHeld = jump;
    // the match's seeded random stream, so a seeded match with drones replays identically
    if (l > 0.1 && d.onGround && this.ctx.rng.next() < dt * 3) this.ctx.noise(d.pos, 7, null, 'footstep');
    this.moveBox(d.pos, d.vel, G.droneRadius, G.droneHeight, dt, d);
  }

  private moveBox(p: Vector3, v: Vector3, r: number, h: number, dt: number, d: { onGround: boolean }) {
    const col = this.ctx.world.collision;
    v.y -= 9.8 * dt;
    for (const axis of ['x', 'z'] as const) {
      const delta = v[axis] * dt;
      p[axis] += delta;
      const hits = col.query(p.x - r, p.y + 0.02, p.z - r, p.x + r, p.y + h, p.z + r);
      for (const b of hits) {
        if (b.maxY - p.y < 0.12) { p.y = b.maxY; continue; } // tiny step
        if (axis === 'x') p.x = delta > 0 ? b.minX - r - 0.001 : b.maxX + r + 0.001;
        else p.z = delta > 0 ? b.minZ - r - 0.001 : b.maxZ + r + 0.001;
        v[axis] = 0;
      }
    }
    p.y += v.y * dt;
    d.onGround = false;
    for (const b of col.query(p.x - r, p.y, p.z - r, p.x + r, p.y + h, p.z + r)) {
      if (v.y <= 0 && b.maxY - p.y < 0.5) { p.y = b.maxY; v.y = 0; d.onGround = true; }
      else if (v.y > 0) { p.y = b.minY - h - 0.001; v.y = 0; }
    }
    if (!d.onGround && col.overlaps(p.x - r, p.y - 0.03, p.z - r, p.x + r, p.y + 0.01, p.z + r)) { d.onGround = true; v.y = Math.max(0, v.y); }
    if (d.onGround) { v.x *= Math.exp(-dt * 2); v.z *= Math.exp(-dt * 2); }
  }

  // ------------------------------------------------------------------ damage
  /** Bullet / melee ray against devices that aren't world colliders. */
  raycast(origin: Vector3, dir: Vector3, maxT: number, includeWire = false): { t: number; device: Device } | null {
    let best: { t: number; device: Device } | null = null;
    for (const d of this.devices) {
      if (!d.alive || COLLIDERS.has(d.kind) || d.kind === 'missile' || (d.kind === 'wire' && !includeWire)) continue;
      const b = this.hitBox(d);
      const r = rayBox(origin, dir, b, best ? best.t : maxT);
      if (r) best = { t: r.t, device: d };
    }
    return best;
  }

  hitBox(d: Device) {
    const p = d.pos;
    switch (d.kind) {
      case 'drone': return { minX: p.x - 0.2, maxX: p.x + 0.2, minZ: p.z - 0.2, maxZ: p.z + 0.2, minY: p.y, maxY: p.y + 0.2 };
      case 'mine': return { minX: p.x - 0.15, maxX: p.x + 0.15, minZ: p.z - 0.15, maxZ: p.z + 0.15, minY: p.y, maxY: p.y + 0.22 };
      case 'wire': return { minX: p.x - G.wireHalfW, maxX: p.x + G.wireHalfW, minZ: p.z - G.wireHalfW, maxZ: p.z + G.wireHalfW, minY: p.y, maxY: p.y + 0.5 };
      case 'flockCam': return { minX: p.x - 0.2, maxX: p.x + 0.2, minZ: p.z - 0.2, maxZ: p.z + 0.2, minY: p.y - 1.9, maxY: p.y + 0.3 };
      case 'ammoBox': return { minX: p.x - 0.32, maxX: p.x + 0.32, minZ: p.z - 0.22, maxZ: p.z + 0.22, minY: p.y, maxY: p.y + 0.36 };
      case 'hunter': return { minX: p.x - 0.32, maxX: p.x + 0.32, minZ: p.z - 0.32, maxZ: p.z + 0.32, minY: p.y - 0.12, maxY: p.y + 0.12 };
      default: return { minX: p.x - 0.13, maxX: p.x + 0.13, minZ: p.z - 0.13, maxZ: p.z + 0.13, minY: p.y - 0.13, maxY: p.y + 0.13 };
    }
  }

  damage(d: Device, amount: number, attacker: Agent | null, kind: DamageKind = 'bullet') {
    if (!d.alive) return;
    if (attacker && attacker.team === d.team && d.ownerId !== attacker.id && !this.ctx.rules.friendlyFire) return;
    amount *= DAMAGE_MULT[d.kind]?.[kind] ?? 1;
    if (amount <= 0) return;
    d.health -= amount;
    if (d.health <= 0) this.destroy(d, attacker?.id ?? -1);
  }

  destroy(d: Device, byId: number) {
    if (!d.alive) return;
    d.alive = false;
    this.release(d);
    for (const a of this.ctx.agents) if (a.operating === d.id) this.operate(a, null);
    this.devices = this.devices.filter((x) => x !== d);
    this.ctx.events.emit('gadgetDestroyed', { kind: d.kind, pos: d.pos.clone(), byId, team: d.team });
  }

  /** Explosions (frag, mine, bomb) damage devices with line of sight. */
  explosion(pos: Vector3, radius: number, damage: number, attacker: Agent | null) {
    for (const d of [...this.devices]) {
      const c = this.hitCenter(d);
      const dist = c.distanceTo(pos);
      if (dist > radius) continue;
      if (!COLLIDERS.has(d.kind) && this.ctx.world.collision.segmentBlocked(pos, c)) continue;
      this.damage(d, damage * (1 - dist / radius), attacker, 'explosion');
    }
  }

  private hitCenter(d: Device) {
    const b = this.hitBox(d);
    return new Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
  }

  /** Movement multiplier for an agent standing in barbed wire. */
  wireSlowAt(p: Vector3): number {
    for (const d of this.devices) if (d.kind === 'wire' && this.inWire(d, p)) return G.wireSlow;
    return 1;
  }
  inWire(d: Device, p: Vector3): boolean {
    const dx = p.x - d.pos.x, dz = p.z - d.pos.z;
    // local frame: wide axis across the facing direction
    const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
    const along = dx * fx + dz * fz, across = dx * -fz + dz * fx;
    return Math.abs(along) <= G.wireHalfD + 0.3 && Math.abs(across) <= G.wireHalfW + 0.3 && Math.abs(p.y - d.pos.y) < 0.8;
  }

  /** Laser segment of a trip mine (clipped by walls). */
  laser(d: Device): [Vector3, Vector3] {
    const a = new Vector3(d.pos.x, d.pos.y + 0.16, d.pos.z);
    const dir = new Vector3(-Math.sin(d.yaw), 0, -Math.cos(d.yaw));
    const hit = this.ctx.world.collision.raycast(a, dir, G.mineLaser);
    return [a, a.clone().addScaledVector(dir, hit ? hit.t : G.mineLaser)];
  }

  // ------------------------------------------------------------------ per-tick update
  update(dt: number) {
    const ctx = this.ctx, now = ctx.time;
    this.updateThrown(dt);
    for (const d of [...this.devices]) {
      if (!d.alive) continue;
      const jammed = d.jammedUntil > now;
      switch (d.kind) {
        case 'drone': {
          const operated = ctx.agents.some((a) => a.operating === d.id);
          if (!operated) {
            if (d.ai && !jammed) this.driveAi(d, dt);
            else this.moveBox(d.pos, d.vel, G.droneRadius, G.droneHeight, dt, d);
          }
          const owner = ctx.agents.find((a) => a.id === d.ownerId);
          if (owner?.isBot && !jammed) this.scan(d, G.scanFov, 28, true);
          break;
        }
        case 'stickyCam': {
          const owner = ctx.agents.find((a) => a.id === d.ownerId);
          if (owner?.isBot && owner.alive && !jammed) this.scan(d, 90, 22, true);
          break;
        }
        case 'flockCam': {
          if (jammed) break;
          // slow sweep, like a real auto-scan camera; it holds still while someone steers it from the feed
          if (!ctx.agents.some((a) => a.operating === d.id)) d.yaw = wrapAngle(d.baseYaw + Math.sin((now - d.createdAt) * 0.6) * 0.5);
          const seen = this.scan(d, G.scanFov, G.flockRange, true);
          if (seen.length && now - d.lastAlert > 6) {
            d.lastAlert = now;
            const where = ctx.world.calloutAt(seen[0].pos.x, seen[0].pos.z) || 'unknown';
            ctx.events.emit('gadgetAlert', { team: d.team, text: `FLOCK CAM · ${seen.length} enem${seen.length > 1 ? 'ies' : 'y'} spotted — ${where}` });
          }
          break;
        }
        case 'mine': this.updateMine(d); break;
        case 'wire': {
          for (const a of ctx.agents) {
            if (!a.alive || a.speed2D < 0.6 || !this.inWire(d, a.pos)) continue;
            const last = this.wireNoise.get(a.id) ?? -10;
            if (now - last > 0.6) {
              this.wireNoise.set(a.id, now);
              ctx.events.emit('wireRattle', { pos: a.pos.clone() });
              ctx.noise(a.pos, 20, a.team === d.team ? null : a, 'footstep');
            }
          }
          break;
        }
        case 'hunter': this.updateHunter(d, dt); break;
        case 'missile': this.updateMissile(d, dt); break;
        default: break;
      }
    }
  }

  private updateHunter(d: Device, dt: number) {
    const ctx = this.ctx, now = ctx.time;
    const owner = ctx.agents.find((a) => a.id === d.ownerId) ?? null;
    const foes = ctx.agents.filter((a) => a.alive && a.team !== d.team);
    if (!foes.length || now - d.createdAt > 30) { this.blowHunter(d, owner); return; }
    const nearest = foes.reduce((b, a) => (a.pos.distanceTo(d.pos) < b.pos.distanceTo(d.pos) ? a : b));
    if (nearest.centerPos(tA).distanceTo(d.pos) < 2.2) { this.blowHunter(d, owner); return; }
    const ai = d.ai!;
    let goal = foes.find((a) => a.id === ai.goalId) ?? null;
    if (!ai.path || !goal || now - d.lastScan > 0.8 || Math.hypot(ai.tx - goal.pos.x, ai.tz - goal.pos.z) > 2) {
      d.lastScan = now;
      // The nearest enemy it can actually reach: one behind boarded-up doorways may have no route
      // at all, and the drone must never cut straight through the walls to get there.
      goal = null; ai.path = null;
      for (const f of [...foes].sort((p, q) => p.pos.distanceToSquared(d.pos) - q.pos.distanceToSquared(d.pos))) {
        const path = ctx.world.nav.findPath(d.pos.x, d.pos.z, f.pos.x, f.pos.z);
        if (path) { goal = f; ai.path = path; break; }
      }
      ai.idx = 0; ai.goalId = goal?.id ?? -1;
      if (goal) { ai.tx = goal.pos.x; ai.tz = goal.pos.z; }
    }
    if (ctx.rng.next() < dt * 4) ctx.noise(d.pos, 22, null, 'footstep');
    if (!goal || !ai.path) { d.vel.set(0, 0, 0); d.pos.y += (1.95 - d.pos.y) * Math.min(1, dt * 3); return; } // nobody reachable: hover
    const aim = goal.centerPos(new Vector3());
    let wp = ai.path[ai.idx];
    while (wp && Math.hypot(wp.x - d.pos.x, wp.z - d.pos.z) < 0.6) wp = ai.path[++ai.idx];
    const tx = wp ? wp.x : aim.x, tz = wp ? wp.z : aim.z;
    const dx = tx - d.pos.x, dz = tz - d.pos.z, len = Math.hypot(dx, dz) || 1;
    const speed = 7.2;
    d.vel.set((dx / len) * speed, 0, (dz / len) * speed);
    d.yaw = yawTo(dx, dz);
    // Never through a wall or barricade: a route can still clip a corner, and the last dash goes
    // straight at the target. Checked at chest height (the nav grid only promises clearance up to a
    // standing head; every doorway is taller than the drone flies). Blocked, it waits for a re-plan.
    tA.set(d.pos.x, Math.min(d.pos.y, 1.75), d.pos.z);
    tB.set(d.pos.x + d.vel.x * dt, tA.y, d.pos.z + d.vel.z * dt);
    if (ctx.world.collision.segmentBlocked(tA, tB)) { d.vel.set(0, 0, 0); d.lastScan = Math.min(d.lastScan, now - 0.6); }
    else { d.pos.x = tB.x; d.pos.z = tB.z; }
    const alt = (!wp ? aim.y : 1.95);
    d.pos.y += (alt - d.pos.y) * Math.min(1, dt * 3);
  }

  private blowHunter(d: Device, owner: Agent | null) {
    d.alive = false;
    this.devices = this.devices.filter((x) => x !== d);
    explode(this.ctx, d.pos.clone(), 4.6, 140, owner, 'hunter');
  }

  private updateMissile(d: Device, dt: number) {
    const ctx = this.ctx, now = ctx.time;
    const owner = ctx.agents.find((a) => a.id === d.ownerId) ?? null;
    if (d.target && !ctx.agents.some((a) => a.operating === d.id)) {
      // autopilot (bot launch): curve onto the target
      const wantYaw = yawTo(d.target.x - d.pos.x, d.target.z - d.pos.z);
      const wantPitch = Math.atan2(d.target.y - d.pos.y, Math.max(1, Math.hypot(d.target.x - d.pos.x, d.target.z - d.pos.z)));
      d.yaw += angleDiff(d.yaw, wantYaw) * Math.min(1, dt * 3);
      d.pitch += (clamp(wantPitch, -1.5, -0.3) - d.pitch) * Math.min(1, dt * 3);
    }
    const speed = d.boost ? 78 : 30;
    const dirv = dirFromAngles(d.yaw, d.pitch, new Vector3());
    d.vel.copy(dirv).multiplyScalar(speed);
    let step = speed * dt;
    const o = d.pos.clone();
    let impact: Vector3 | null = null;
    for (let k = 0; k < 4 && step > 0; k++) {
      const hit = ctx.world.collision.raycast(o, dirv, step);
      if (!hit) { o.addScaledVector(dirv, step); step = 0; break; }
      if (hit.box.surface === 'ceiling') { o.copy(hit.point).addScaledVector(dirv, 0.7); step -= hit.t + 0.7; continue; } // punches through the roof
      impact = hit.point.clone().addScaledVector(hit.normal, 0.3);
      break;
    }
    if (!impact) {
      for (const a of ctx.agents) {
        if (!a.alive) continue;
        const c = a.centerPos(new Vector3());
        const t = clamp(c.clone().sub(d.pos).dot(dirv), 0, speed * dt);
        if (d.pos.clone().addScaledVector(dirv, t).distanceTo(c) < 1) { impact = c; break; }
      }
    }
    if (!impact && (o.y < 0.1 || now - d.createdAt > 14)) impact = o.clone().setY(Math.max(0.3, o.y));
    if (impact) {
      d.alive = false;
      this.devices = this.devices.filter((x) => x !== d);
      for (const a of ctx.agents) if (a.operating === d.id) this.operate(a, null);
      explode(ctx, impact, 9.5, 260, owner, 'missile', { ignoreCeilings: true });
      return;
    }
    d.pos.copy(o);
  }

  private updateMine(d: Device) {
    const ctx = this.ctx, now = ctx.time;
    if (!d.armed) {
      if (now - d.createdAt >= G.mineArm) { d.armed = true; ctx.events.emit('mineArmed', { pos: d.pos.clone() }); }
      return;
    }
    if (d.jammedUntil > now) return;
    if (d.triggeredAt < 0) {
      const [a, b] = this.laser(d);
      const dir = b.clone().sub(a);
      const len = dir.length();
      dir.normalize();
      for (const e of ctx.agents) {
        if (!e.alive || e.team === d.team) continue;
        const box = { minX: e.pos.x - 0.25, maxX: e.pos.x + 0.25, minZ: e.pos.z - 0.25, maxZ: e.pos.z + 0.25, minY: e.pos.y, maxY: e.pos.y + 1.0 };
        if (rayBox(a, dir, box, len)) { d.triggeredAt = now; ctx.events.emit('mineTrip', { pos: d.pos.clone() }); break; }
      }
      return;
    }
    if (now - d.triggeredAt < G.mineDelay) return;
    // detonate: directional blast toward the laser side
    const owner = ctx.agents.find((a) => a.id === d.ownerId) ?? null;
    const center = d.pos.clone().add(new Vector3(0, 0.3, 0));
    const fwd = new Vector3(-Math.sin(d.yaw), 0, -Math.cos(d.yaw));
    d.alive = false;
    this.devices = this.devices.filter((x) => x !== d);
    ctx.events.emit('detonate', { kind: 'frag', pos: center.clone(), ownerId: d.ownerId });
    ctx.noise(center, 60, owner, 'explosion');
    for (const a of ctx.agents) {
      if (!a.alive) continue;
      const c = a.centerPos(new Vector3());
      const to = c.clone().sub(center);
      const dist = to.length();
      if (dist > G.mineRadius) continue;
      const facing = to.clone().setY(0).normalize().dot(fwd);
      if (facing < -0.25 && dist > 1.2) continue;
      if (ctx.world.collision.segmentBlocked(center, c)) continue;
      const raw = G.mineDamage * (1 - dist / G.mineRadius);
      const health = a.armor > 0 ? Math.floor(raw * 0.6) : Math.floor(raw);
      ctx.applyDamage(a, owner, { health, armor: a.armor > 0 ? Math.floor(raw * 0.2) : 0 }, 'chest', 'mine', c, to.normalize());
    }
    this.explosion(center, G.mineRadius, 80, owner);
  }

  private driveAi(d: Device, dt: number) {
    const ai = d.ai!;
    if (!ai.path) { ai.path = this.ctx.world.nav.findPath(d.pos.x, d.pos.z, ai.tx, ai.tz) ?? []; ai.idx = 0; }
    const wp = ai.path[ai.idx];
    if (!wp) {
      d.yaw = wrapAngle(d.yaw + dt * 0.5); // parked: slowly look around
      this.drive(d, 0, 0, false, dt);
      return;
    }
    if (Math.hypot(wp.x - d.pos.x, wp.z - d.pos.z) < 0.5) { ai.idx++; return; }
    d.yaw = yawTo(wp.x - d.pos.x, wp.z - d.pos.z);
    d.pitch = 0;
    this.drive(d, 0.85, 0, false, dt);
  }

  private updateThrown(dt: number) {
    const ctx = this.ctx, now = ctx.time;
    const col = ctx.world.collision;
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      let stuck: { point: Vector3; normal: Vector3 } | null = null;
      const sub = 4, h = dt / sub;
      let floor = false;
      for (let s = 0; s < sub && !stuck; s++) {
        t.vel.y -= 9.8 * h;
        const step = t.vel.length() * h;
        if (step < 1e-5) continue;
        const dir = tA.copy(t.vel).normalize();
        const hit = col.raycast(t.pos, dir, step + 0.06);
        if (hit) {
          if (t.kind === 'stickyCam' || t.kind === 'c4') { stuck = { point: hit.point.clone(), normal: hit.normal.clone() }; break; }
          t.pos.copy(hit.point).addScaledVector(hit.normal, 0.07);
          const vn = t.vel.dot(hit.normal);
          t.vel.addScaledVector(hit.normal, -(1 + (t.kind === 'drone' ? 0.15 : 0.4)) * vn);
          t.vel.multiplyScalar(0.7);
          if (hit.normal.y > 0.7) floor = true;
          if (Math.abs(vn) > 1.5) ctx.events.emit('bounce', { pos: t.pos.clone(), kind: 'decoy' });
        } else t.pos.addScaledVector(t.vel, h);
      }
      if (t.kind === 'stickyCam') {
        if (stuck) {
          this.thrown.splice(i, 1);
          const d = this.make('stickyCam', t.team, t.ownerId, stuck.point.addScaledVector(stuck.normal, 0.03));
          d.normal = stuck.normal;
          if (stuck.normal.y > 0.7) { d.yaw = d.baseYaw = yawTo(t.vel.x, t.vel.z); d.pitch = d.basePitch = 0.05; }
          else if (stuck.normal.y < -0.7) { d.yaw = d.baseYaw = yawTo(t.vel.x, t.vel.z); d.pitch = d.basePitch = -0.6; }
          else { d.yaw = d.baseYaw = yawTo(stuck.normal.x, stuck.normal.z); d.pitch = d.basePitch = -0.15; }
          ctx.events.emit('gadgetDeploy', { agentId: t.ownerId, kind: 'stickyCam', pos: d.pos.clone() });
        } else if (now - t.thrownAt > 5) this.thrown.splice(i, 1);
        continue;
      }
      if (t.kind === 'c4') {
        if (stuck) {
          this.thrown.splice(i, 1);
          const d = this.make('c4', t.team, t.ownerId, stuck.point.addScaledVector(stuck.normal, 0.03));
          d.normal = stuck.normal;
          d.yaw = d.baseYaw = yawTo(t.vel.x, t.vel.z);
          ctx.events.emit('gadgetDeploy', { agentId: t.ownerId, kind: 'c4', pos: d.pos.clone() });
        } else if (now - t.thrownAt > 6) this.thrown.splice(i, 1);
        continue;
      }
      if (t.kind === 'emp') {
        if (now - t.thrownAt >= G.empFuse) { this.thrown.splice(i, 1); this.emp(t.pos.clone(), t.team, t.ownerId); }
        continue;
      }
      // drone: lands, then becomes a device
      const nearGround = floor || t.pos.y - col.groundHeight(t.pos.x, t.pos.z, t.pos.y + 0.05) < 0.12;
      if (nearGround) { t.vel.x *= Math.exp(-dt * 6); t.vel.z *= Math.exp(-dt * 6); }
      if (nearGround && t.vel.lengthSq() < 0.6) { if (t.restSince < 0) t.restSince = now; } else t.restSince = -1;
      if ((t.restSince >= 0 && now - t.restSince > 0.15) || now - t.thrownAt > 4) {
        this.thrown.splice(i, 1);
        const p = t.pos.clone();
        p.y = col.groundHeight(p.x, p.z, p.y + 0.2);
        const d = this.make('drone', t.team, t.ownerId, p);
        d.yaw = d.baseYaw = yawTo(t.vel.x || 0.0001, t.vel.z || -1);
        d.onGround = true;
        if (t.aiTarget) d.ai = { path: null, idx: 0, tx: t.aiTarget.x, tz: t.aiTarget.z };
        const owner = ctx.agents.find((a) => a.id === t.ownerId);
        // a planter or defuser keeps both hands on the bomb; they can open the feed with T afterwards
        if (owner && !owner.isBot && owner.alive && !owner.isDefusing && !owner.isPlanting) this.operate(owner, d.id);
      }
    }
  }

  private emp(pos: Vector3, team: Team, ownerId: number) {
    const ctx = this.ctx, now = ctx.time;
    ctx.events.emit('emp', { pos, team });
    const owner = ctx.agents.find((a) => a.id === ownerId) ?? null;
    for (const d of [...this.devices]) {
      if (d.team === team || d.pos.distanceTo(pos) > G.empRadius) continue;
      if (d.kind === 'cctv') { d.jammedUntil = now + 15; for (const a of ctx.agents) if (a.operating === d.id) this.operate(a, null); }
      else if (!['wire', 'shield', 'barricade', 'steelBarricade', 'ammoBox', 'missile'].includes(d.kind)) this.destroy(d, owner?.id ?? -1);
    }
    for (const a of ctx.agents) {
      if (a.alive && a.team !== team && a.pos.distanceTo(pos) < G.empRadius) a.radarScrambledUntil = now + G.empScramble;
    }
    // fries enemy recon pulses and decoys
    const u = ctx.utility;
    u.pulses = u.pulses.filter((p) => p.team === team || p.pos.distanceTo(pos) > G.empRadius);
    u.decoys = u.decoys.filter((p) => p.team === team || p.pos.distanceTo(pos) > G.empRadius);
  }
}
