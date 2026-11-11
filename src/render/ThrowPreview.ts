import { Color, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, SphereGeometry, Vector3 } from 'three';
import { MOVE } from '../config/movement';
import { UTILITIES, UTILITY_TUNING, type UtilityId } from '../config/utilities';
import type { Agent } from '../sim/entities/Agent';
import type { Match } from '../sim/mode/Match';

const DOTS = 56;
/** Metres between dots along the arc. */
const SPACING = 0.5;
/** Throw strength for each trigger combination (left, right, both), as the weapon system uses. */
const STRENGTH = [0, 1, 0.45, 0.72] as const;
/** Area-denial grenades draw the ground they will cover. */
const COVER: Partial<Record<UtilityId, number>> = { smoke: UTILITY_TUNING.smokeRadius, fire: UTILITY_TUNING.fireRadius };

const _m = new Matrix4(), _q = new Quaternion(), _s = new Vector3(), _p = new Vector3();

/**
 * While you hold a grenade ready to throw: a dotted arc of the flight it would take right now
 * (bounces included), a marker where it will go off, and for smokes and firebombs the ground they
 * will cover. It runs the simulation's own grenade physics, so the grenade follows the dots.
 */
export class ThrowPreview {
  readonly group = new Group();
  private dots: InstancedMesh;
  private dotMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
  private ring: Mesh;
  private ringMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide, toneMapped: false });
  private cover: Mesh;
  private coverMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false, side: DoubleSide, toneMapped: false });
  private path: Vector3[] = [];
  private bounces: Vector3[] = [];
  private end = new Vector3();
  private age = 1;
  private flow = 0;
  private tint = new Color();
  /** What the current arc was computed for: it is only recomputed when something changes. */
  private last = { yaw: NaN, pitch: NaN, kind: '', strength: 0, pos: new Vector3(), vel: new Vector3() };

  constructor() {
    this.dots = new InstancedMesh(new SphereGeometry(1, 8, 6), this.dotMat, DOTS);
    this.dots.frustumCulled = false; this.dots.renderOrder = 4;
    this.ring = new Mesh(new RingGeometry(0.2, 0.26, 28).rotateX(-Math.PI / 2), this.ringMat);
    this.cover = new Mesh(new RingGeometry(0.985, 1, 64).rotateX(-Math.PI / 2), this.coverMat);
    this.ring.renderOrder = this.cover.renderOrder = 4;
    this.group.add(this.dots, this.ring, this.cover);
    this.group.visible = false;
  }

  /** The grenade the local player is holding ready, and how hard they would throw it. */
  private primed(a: Agent | null): { kind: UtilityId; strength: number } | null {
    if (!a || !a.alive || a.operating !== null || a.active !== 'grenade' || !a.activeGrenade || a.wpn.throwPrimed === 0) return null;
    // a thrown knife flies on the projectile system, not as a grenade
    if (a.activeGrenade === 'tknife' || a.grenades[a.activeGrenade] <= 0) return null;
    return { kind: a.activeGrenade, strength: STRENGTH[a.wpn.throwPrimed] };
  }

  /** `look` is the live mouse look, so the arc turns with the crosshair rather than a tick behind it. */
  update(match: Match, a: Agent | null, enabled: boolean, cam: Vector3, dt: number, look: { yaw: number; pitch: number }) {
    const throwing = enabled ? this.primed(a) : null;
    this.group.visible = !!throwing;
    if (!throwing || !a) { this.age = 1; this.last.kind = ''; return; }
    // A prediction costs 0.1–0.5 ms of ray casts: redo it only when the aim, the thrower or the
    // throw changed (and now and then regardless), never just because a frame was drawn.
    this.age += dt;
    const l = this.last;
    const changed = l.kind !== throwing.kind || l.strength !== throwing.strength || Math.abs(l.yaw - look.yaw) > 1e-4 || Math.abs(l.pitch - look.pitch) > 1e-4 ||
      l.pos.distanceToSquared(a.pos) > 1e-6 || l.vel.distanceToSquared(a.vel) > 1e-4;
    if (changed || this.age >= 0.1) {
      this.age = 0;
      l.kind = throwing.kind; l.strength = throwing.strength; l.yaw = look.yaw; l.pitch = look.pitch; l.pos.copy(a.pos); l.vel.copy(a.vel);
      const r = match.utility.predict(a, throwing.kind, throwing.strength, 1 / MOVE.tickRate, look);
      this.path = r.path; this.bounces = r.bounces; this.end.copy(r.end);
    }
    this.tint.set(UTILITIES[throwing.kind].color).lerp(_white, 0.55);
    this.dotMat.color.copy(this.tint); this.ringMat.color.copy(this.tint); this.coverMat.color.copy(this.tint);

    // dots at even spacing along the arc, drifting toward the target so the direction reads at a glance
    this.flow = (this.flow + dt * 1.6) % SPACING;
    let n = 0, want = 1.1 + this.flow, walked = 0;
    for (let i = 1; i < this.path.length && n < DOTS; i++) {
      const p0 = this.path[i - 1], p1 = this.path[i], seg = p0.distanceTo(p1);
      while (seg > 1e-6 && walked + seg >= want && n < DOTS) {
        _p.lerpVectors(p0, p1, (want - walked) / seg);
        // roughly constant on screen: small close up, still visible at the far end
        _s.setScalar(Math.min(0.055, Math.max(0.011, _p.distanceTo(cam) * 0.0042)));
        this.dots.setMatrixAt(n++, _m.compose(_p, _q, _s));
        want += SPACING;
      }
      walked += seg;
    }
    for (const b of this.bounces) {
      if (n >= DOTS) break;
      _s.setScalar(Math.min(0.1, Math.max(0.022, b.distanceTo(cam) * 0.008)));
      this.dots.setMatrixAt(n++, _m.compose(b, _q, _s));
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;

    const ground = match.world.collision.groundHeight(this.end.x, this.end.z, this.end.y + 0.1);
    const onFloor = this.end.y - ground < 0.4;
    this.ring.position.set(this.end.x, (onFloor ? ground : this.end.y) + 0.02, this.end.z);
    this.ring.scale.setScalar(Math.max(1, this.end.distanceTo(cam) * 0.07));
    const radius = COVER[throwing.kind];
    this.cover.visible = !!radius && (onFloor || throwing.kind === 'smoke');
    if (radius) { this.cover.position.set(this.end.x, ground + 0.025, this.end.z); this.cover.scale.setScalar(radius); }
  }

  dispose() {
    this.dots.geometry.dispose(); this.ring.geometry.dispose(); this.cover.geometry.dispose();
    this.dotMat.dispose(); this.ringMat.dispose(); this.coverMat.dispose();
    this.dots.dispose();
    this.group.removeFromParent();
  }
}

const _white = new Color('#ffffff');
