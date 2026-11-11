import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, DynamicDrawUsage, Euler, Group, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, NormalBlending, PlaneGeometry, PointLight, Points, Quaternion,
  RingGeometry, ShaderMaterial, SphereGeometry, Vector3, type Blending, type Camera, type Scene, type Texture,
} from 'three';
import { Random } from '../core/Random';
import { bloodSplat, bulletHole, flareSprite, scorchMark, softSprite } from './Textures';

// ============================================================================ particles
export interface EmitOpts {
  pos: Vector3; count: number; speed: number; spread?: number; dir?: Vector3; life: [number, number];
  size: [number, number]; color: string; alpha?: number; gravity?: number; drag?: number; up?: number;
}

/** CPU particle system rendered as one Points draw call with a soft sprite. */
class ParticleSystem {
  readonly points: Points;
  private max: number;
  private pos: Float32Array; private rgba: Float32Array; private size: Float32Array;
  private vel: Float32Array; private life: Float32Array; private maxLife: Float32Array;
  private s0: Float32Array; private s1: Float32Array; private grav: Float32Array; private drag: Float32Array; private a0: Float32Array;
  private cursor = 0;
  private geo: BufferGeometry;
  readonly material: ShaderMaterial;
  private rng = new Random(77);

  constructor(max: number, map: Texture, blending: Blending) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.rgba = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.a0 = new Float32Array(max);
    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('rgba', new BufferAttribute(this.rgba, 4).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('size', new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    this.material = new ShaderMaterial({
      uniforms: { map: { value: map }, scale: { value: 600 } },
      vertexShader: `attribute float size; attribute vec4 rgba; varying vec4 vC; uniform float scale;
        void main(){ vC = rgba; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vC;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); float a = vC.a * t.a; if (a < 0.004) discard; gl_FragColor = vec4(vC.rgb * t.rgb, a); }`,
      transparent: true, depthWrite: false, blending,
    });
    this.points = new Points(this.geo, this.material);
    this.points.frustumCulled = false;
  }

  emit(o: EmitOpts) {
    const c = new Color(o.color);
    const r = this.rng;
    for (let n = 0; n < o.count; n++) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
      let vx = r.range(-1, 1), vy = r.range(-1, 1), vz = r.range(-1, 1);
      const l = Math.hypot(vx, vy, vz) || 1; vx /= l; vy /= l; vz /= l;
      if (o.dir) {
        const s = o.spread ?? 0.4;
        vx = o.dir.x + vx * s; vy = o.dir.y + vy * s; vz = o.dir.z + vz * s;
      }
      const sp = o.speed * r.range(0.4, 1);
      this.pos.set([o.pos.x, o.pos.y, o.pos.z], i * 3);
      this.vel.set([vx * sp, vy * sp + (o.up ?? 0), vz * sp], i * 3);
      this.life[i] = this.maxLife[i] = r.range(o.life[0], o.life[1]);
      this.s0[i] = o.size[0] * r.range(0.7, 1.3); this.s1[i] = o.size[1] * r.range(0.7, 1.3);
      this.grav[i] = o.gravity ?? 0; this.drag[i] = o.drag ?? 0;
      const a = o.alpha ?? 1;
      this.a0[i] = a;
      this.rgba.set([c.r, c.g, c.b, a], i * 4);
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.rgba[i * 4 + 3] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.rgba[i * 4 + 3] = this.a0[i] * (1 - t) * Math.min(1, t * 8 + 0.3);
    }
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('rgba') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('size') as BufferAttribute).needsUpdate = true;
  }

  clear() { this.life.fill(0); }
}

// ============================================================================ tracers
const TRACER_N = 48;
const _side = new Vector3(), _head = new Vector3(), _tail = new Vector3(), _toCam = new Vector3();
/** Tracer opacity `d` metres from the muzzle: invisible at the gun, full strength from ~3 m out. */
const tracerFade = (d: number) => Math.min(1, Math.max(0, (d - 0.7) / 2.6)) * 0.9;

/**
 * Bullet tracers as camera-facing streaks, all in one draw call. (GL lines are one pixel wide
 * whatever the resolution, so line tracers all but vanish on a sharp display.) A streak leaves the
 * muzzle, flies to the impact and shrinks into it; it fades in over the first few metres so your
 * own shots never smear across the sights.
 */
class TracerBatch {
  readonly mesh: Mesh;
  private pos = new Float32Array(TRACER_N * 12);
  private alpha = new Float32Array(TRACER_N * 4);
  private items = Array.from({ length: TRACER_N }, () => ({ start: new Vector3(), dir: new Vector3(), len: 0, streak: 0, t: 1, dur: 0.05, live: false }));
  private posAttr: BufferAttribute; private alphaAttr: BufferAttribute;
  private cursor = 0;

  constructor() {
    const geo = new BufferGeometry();
    const uv = new Float32Array(TRACER_N * 8), index = new Uint16Array(TRACER_N * 6);
    for (let i = 0; i < TRACER_N; i++) {
      uv.set([0, 0, 0, 1, 1, 0, 1, 1], i * 8);
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.alphaAttr = new BufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    geo.setAttribute('alpha', this.alphaAttr);
    geo.setIndex(new BufferAttribute(index, 1));
    const material = new ShaderMaterial({
      vertexShader: `attribute float alpha; varying vec2 vUv; varying float vA;
        void main(){ vUv = uv; vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // a white-hot core inside a warm glow, thinning toward the tail
      fragmentShader: `varying vec2 vUv; varying float vA;
        void main(){
          float y = abs(vUv.y - 0.5) * 2.0;
          float core = exp(-y * y * 7.0);
          float a = core * smoothstep(0.0, 0.45, vUv.x) * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(mix(vec3(1.0, 0.6, 0.2), vec3(1.0, 0.95, 0.82), core * core), a);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
    });
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // see Effects: under smoke clouds, so tracers never show through a smoke
    this.mesh.visible = false;
  }

  add(start: Vector3, end: Vector3) {
    const len = start.distanceTo(end);
    if (len < 0.5) return;
    let it = this.items.find((x) => !x.live);
    if (!it) { it = this.items[this.cursor]; this.cursor = (this.cursor + 1) % TRACER_N; }
    it.start.copy(start); it.dir.subVectors(end, start).divideScalar(len);
    it.len = len; it.streak = Math.min(11, Math.max(2.5, len * 0.3));
    it.dur = Math.max(0.055, (len + it.streak) / 380);
    it.t = 0; it.live = true;
  }

  update(dt: number, cam: Vector3) {
    let any = false, wrote = false;
    for (let i = 0; i < TRACER_N; i++) {
      const it = this.items[i];
      if (!it.live) continue;
      wrote = true;
      it.t += dt / it.dur;
      const travelled = it.t * (it.len + it.streak);
      const head = Math.min(it.len, travelled), tail = Math.max(0, travelled - it.streak);
      if (it.t >= 1 || tail >= it.len) { it.live = false; this.alpha.fill(0, i * 4, i * 4 + 4); continue; }
      any = true;
      _head.copy(it.start).addScaledVector(it.dir, head);
      _tail.copy(it.start).addScaledVector(it.dir, tail);
      _toCam.copy(cam).sub(_head);
      const dist = _toCam.length();
      _side.crossVectors(it.dir, _toCam);
      const sl = _side.length();
      if (sl < 1e-6) _side.set(0, 1, 0); else _side.divideScalar(sl);
      // wide enough to cover a pixel or two at any range
      _side.multiplyScalar(0.008 + dist * 0.0017);
      const p = this.pos, o = i * 12;
      p[o] = _tail.x - _side.x; p[o + 1] = _tail.y - _side.y; p[o + 2] = _tail.z - _side.z;
      p[o + 3] = _tail.x + _side.x; p[o + 4] = _tail.y + _side.y; p[o + 5] = _tail.z + _side.z;
      p[o + 6] = _head.x - _side.x; p[o + 7] = _head.y - _side.y; p[o + 8] = _head.z - _side.z;
      p[o + 9] = _head.x + _side.x; p[o + 10] = _head.y + _side.y; p[o + 11] = _head.z + _side.z;
      const a0 = tracerFade(tail), a1 = tracerFade(head);
      this.alpha[i * 4] = a0; this.alpha[i * 4 + 1] = a0; this.alpha[i * 4 + 2] = a1; this.alpha[i * 4 + 3] = a1;
    }
    this.mesh.visible = any;
    if (wrote) { this.posAttr.needsUpdate = true; this.alphaAttr.needsUpdate = true; }
  }

  clear() {
    for (const it of this.items) { it.live = false; it.t = 1; }
    this.alpha.fill(0); this.alphaAttr.needsUpdate = true;
    this.mesh.visible = false;
  }
}

// ============================================================================ spent casings
const CASING_N = 56;
export type CasingKind = 'brass' | 'small' | 'shell';
const CASING_LOOK: Record<CasingKind, { color: string; scale: [number, number] }> = {
  brass: { color: '#d6ad5a', scale: [1, 1] }, small: { color: '#d6ad5a', scale: [0.85, 0.62] }, shell: { color: '#b3261e', scale: [1.75, 1.55] },
};

/**
 * Ejected brass in the world: it arcs away from the gun, bounces once or twice on the floor and
 * lies there for a few seconds. One instanced mesh, a fixed pool, no allocation per shot.
 */
class CasingPool {
  readonly mesh: InstancedMesh;
  private items = Array.from({ length: CASING_N }, () => ({ p: new Vector3(), v: new Vector3(), r: new Euler(), spin: new Vector3(), ground: 0, life: 0, delay: 0, bounces: 0, sx: 1, sy: 1 }));
  private cursor = 0;
  private live = 0;
  private obj = new Matrix4();
  private q = new Quaternion();
  private s = new Vector3();
  private color = new Color();
  /** Called on a casing's first bounce (the tinkle of brass on the floor). */
  onBounce: (pos: Vector3, kind: CasingKind) => void = () => {};
  private kinds: CasingKind[] = new Array(CASING_N).fill('brass');

  constructor() {
    const mat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.34, metalness: 0.78, emissive: '#2a2110', emissiveIntensity: 0.5 });
    this.mesh = new InstancedMesh(new CylinderGeometry(0.0052, 0.0056, 0.028, 7), mat, CASING_N);
    this.mesh.frustumCulled = false;
    this.s.setScalar(0);
    for (let i = 0; i < CASING_N; i++) { this.obj.compose(this.items[i].p, this.q, this.s); this.mesh.setMatrixAt(i, this.obj); this.mesh.setColorAt(i, this.color.set('#d6ad5a')); }
    this.mesh.visible = false;
  }

  spawn(pos: Vector3, vel: Vector3, ground: number, kind: CasingKind, delay: number, rng: Random) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % CASING_N;
    const c = this.items[i], look = CASING_LOOK[kind];
    c.p.copy(pos); c.v.copy(vel); c.ground = ground; c.life = 5.5; c.delay = delay; c.bounces = 0;
    c.r.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28));
    c.spin.set(rng.range(-22, 22), rng.range(-8, 8), rng.range(-22, 22));
    c.sx = look.scale[0]; c.sy = look.scale[1];
    this.kinds[i] = kind;
    this.mesh.setColorAt(i, this.color.set(look.color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.live = Math.max(this.live, 1);
  }

  update(dt: number) {
    if (!this.live) { this.mesh.visible = false; return; }
    let live = 0;
    for (let i = 0; i < CASING_N; i++) {
      const c = this.items[i];
      if (c.life <= 0) continue;
      if (c.delay > 0) { c.delay -= dt; live++; this.s.setScalar(0); this.obj.compose(c.p, this.q, this.s); this.mesh.setMatrixAt(i, this.obj); continue; }
      c.life -= dt;
      if (c.life <= 0) { this.s.setScalar(0); this.obj.compose(c.p, this.q, this.s); this.mesh.setMatrixAt(i, this.obj); continue; }
      live++;
      const rest = c.ground + 0.006 * c.sx;
      if (c.v.lengthSq() > 0) {
        c.v.y -= 9.8 * dt;
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.spin.x * dt; c.r.y += c.spin.y * dt; c.r.z += c.spin.z * dt;
        if (c.p.y <= rest && c.v.y < 0) {
          c.p.y = rest;
          if (c.bounces === 0) this.onBounce(c.p, this.kinds[i]);
          c.bounces++;
          if (-c.v.y > 0.7 && c.bounces < 4) { c.v.y *= -0.38; c.v.x *= 0.55; c.v.z *= 0.55; c.spin.multiplyScalar(0.6); }
          else { c.v.set(0, 0, 0); c.r.x = Math.PI / 2; c.r.z = 0; } // settles on its side
        }
      }
      const k = Math.min(1, c.life / 0.5);
      this.s.set(c.sx * k, c.sy * k, c.sx * k);
      this.obj.compose(c.p, this.q.setFromEuler(c.r), this.s);
      this.mesh.setMatrixAt(i, this.obj);
    }
    this.live = live;
    this.mesh.visible = live > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.s.setScalar(0);
    for (let i = 0; i < CASING_N; i++) { this.items[i].life = 0; this.obj.compose(this.items[i].p, this.q.identity(), this.s); this.mesh.setMatrixAt(i, this.obj); }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0; this.mesh.visible = false;
  }
}

// ============================================================================ effects manager
interface SmokeFx { id: number; mesh: InstancedMesh; offsets: Vector3[]; angles: number[]; scales: number[]; mat: MeshBasicMaterial }
interface FireFx { id: number; mesh: InstancedMesh; offsets: Vector3[]; phase: number[]; light: PointLight | null }
interface Ring { mesh: Mesh; t: number; dur: number; maxR: number }
interface Flash { light: PointLight; t: number; dur: number; intensity: number }
interface Shock { mesh: Mesh; mat: MeshBasicMaterial; t: number; dur: number; radius: number }
interface Scorch { mesh: Mesh; mat: MeshBasicMaterial; age: number }

const SMOKE_N = 46, FIRE_N = 26;
const _m = new Matrix4(), _q = new Quaternion(), _q2 = new Quaternion(), _s = new Vector3(), _p = new Vector3(), _z = new Vector3(0, 0, 1);
const _v = new Vector3(), _up = new Vector3(0, 1, 0);
/** Seconds a scorch mark stays before it fades (it also clears with the round). */
const SCORCH_LIFE = 45;

export class Effects {
  readonly group = new Group();
  private sparks: ParticleSystem;
  private dust: ParticleSystem;
  private tracers = new TracerBatch();
  private casings = new CasingPool();
  private shocks: Shock[] = [];
  private scorches: Scorch[] = [];
  private scorchIdx = 0;
  /**
   * Floor height under a point (set by the match view). Effects that touch the ground (brass,
   * scorch marks) use it; without it they fall back to y = 0.
   */
  groundAt: ((x: number, z: number, y: number) => number) | null = null;
  /** A spent casing's first bounce (the view plays the tinkle). */
  onCasingBounce: (pos: Vector3, kind: CasingKind) => void = () => {};
  private decals: Mesh[] = [];
  private decalIdx = 0;
  private bloods: Mesh[] = [];
  private bloodIdx = 0;
  private smokes = new Map<number, SmokeFx>();
  private fires = new Map<number, FireFx>();
  private rings: Ring[] = [];
  private lightPool: PointLight[] = [];
  private flashes: Flash[] = [];
  private rng = new Random(5);
  private smokeTex = softSprite();
  private flameTex = flareSprite();

  constructor() {
    this.sparks = new ParticleSystem(600, flareSprite(), AdditiveBlending);
    this.dust = new ParticleSystem(900, softSprite(), NormalBlending);
    this.group.add(this.sparks.points, this.dust.points, this.tracers.mesh, this.casings.mesh);
    // Draw order among the see-through effects: dust and debris, then glowing sparks and tracers (a
    // fireball glows through its own smoke), then smoke grenade clouds over both, so a muzzle flash or
    // tracer inside a smoke never gives a shooter away.
    this.sparks.points.renderOrder = 1;
    this.casings.onBounce = (pos, kind) => this.onCasingBounce(pos, kind);
    // blast pressure waves: a few reusable shells that swell and fade
    const shockGeo = new SphereGeometry(1, 24, 14);
    for (let i = 0; i < 4; i++) {
      const mat = new MeshBasicMaterial({ color: '#ffd9a8', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
      const mesh = new Mesh(shockGeo, mat);
      mesh.visible = false; mesh.renderOrder = 2;
      this.group.add(mesh);
      this.shocks.push({ mesh, mat, t: 1, dur: 0.2, radius: 1 });
    }
    const scorchGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const mat = new MeshBasicMaterial({ map: scorchMark(), transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
      const mesh = new Mesh(scorchGeo, mat);
      // on the floor: drawn before every see-through effect, so smoke in front of it covers it
      mesh.visible = false; mesh.renderOrder = -1;
      this.group.add(mesh);
      this.scorches.push({ mesh, mat, age: SCORCH_LIFE });
    }
    const holeMat = new MeshBasicMaterial({ map: bulletHole(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const holeGeo = new PlaneGeometry(0.11, 0.11);
    for (let i = 0; i < 160; i++) {
      const m = new Mesh(holeGeo, holeMat);
      m.visible = false;
      this.group.add(m);
      this.decals.push(m);
    }
    const bloodMat = new MeshBasicMaterial({ map: bloodSplat(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5 });
    const bloodGeo = new PlaneGeometry(1, 1);
    for (let i = 0; i < 48; i++) {
      const m = new Mesh(bloodGeo, bloodMat);
      m.visible = false;
      this.group.add(m);
      this.bloods.push(m);
    }
    // fixed light pool: light count never changes → no shader recompiles
    for (let i = 0; i < 4; i++) {
      const l = new PointLight(0xffb060, 0, 14, 1.8);
      this.group.add(l);
      this.lightPool.push(l);
    }
  }

  private takeLight(): PointLight {
    // pick the dimmest light (fires keep theirs while burning)
    const used = new Set([...this.fires.values()].map((f) => f.light));
    const free = this.lightPool.filter((l) => !used.has(l));
    const l = (free.length ? free : this.lightPool).reduce((a, b) => (a.intensity <= b.intensity ? a : b));
    this.flashes = this.flashes.filter((f) => f.light !== l);
    return l;
  }

  lightFlash(pos: Vector3, color: number, intensity: number, dur: number, dist = 14) {
    const l = this.takeLight();
    l.position.copy(pos); l.color.setHex(color); l.distance = dist; l.intensity = intensity;
    this.flashes.push({ light: l, t: 0, dur, intensity });
  }

  tracer(start: Vector3, end: Vector3) { this.tracers.add(start, end); }

  impact(point: Vector3, normal: Vector3, surface: string) {
    const d = this.decals[this.decalIdx]; this.decalIdx = (this.decalIdx + 1) % this.decals.length;
    d.position.copy(point).addScaledVector(normal, 0.005);
    d.lookAt(_p.copy(point).add(normal));
    d.rotateZ(this.rng.next() * 6.28);
    d.visible = true;
    const soft = surface === 'fabric' || surface === 'wood';
    const metal = surface === 'metal' || surface === 'vehicle';
    const glass = surface === 'glass';
    d.scale.setScalar(soft ? 1.15 : metal ? 0.7 : 1);
    this.dust.emit({ pos: point, count: glass ? 3 : soft ? 4 : 6, speed: 1.2, dir: normal, spread: 0.6, life: [0.12, 0.38], size: [0.045, 0.22], color: surface === 'wood' ? '#a07848' : '#aaa69e', alpha: 0.42, gravity: 2, drag: 4 });
    if (metal || glass) this.sparks.emit({ pos: point, count: metal ? 7 : 4, speed: metal ? 6 : 3, dir: normal, spread: 0.75, life: [0.06, 0.2], size: [0.035, 0.008], color: glass ? '#d4eeff' : '#ffc870', gravity: 9 });
    // chips knocked loose: masonry flakes, wood splinters and glass fragments fall away under gravity
    else this.dust.emit({ pos: point, count: soft ? 2 : 3, speed: 2.6, dir: normal, spread: 0.9, life: [0.25, 0.55], size: [0.022, 0.03],
      color: surface === 'wood' ? '#8a6238' : surface === 'fabric' ? '#8d8f8a' : '#c9c5bb', alpha: 0.95, gravity: 9, drag: 0.6 });
    if (glass) this.dust.emit({ pos: point, count: 3, speed: 2.2, dir: normal, spread: 1, life: [0.25, 0.5], size: [0.018, 0.024], color: '#dff2ff', alpha: 0.9, gravity: 9, drag: 0.5 });
  }

  /**
   * Eject a spent casing into the world. `delay` holds it back for a manual action (a pump or a
   * bolt throws the case when it is cycled, not when the shot breaks).
   */
  casing(pos: Vector3, vel: Vector3, kind: CasingKind = 'brass', delay = 0) {
    const land = _v.copy(pos).addScaledVector(vel, 0.4);
    this.casings.spawn(pos, vel, this.groundAt ? this.groundAt(land.x, land.z, pos.y) : 0, kind, delay, this.rng);
  }

  blood(point: Vector3, dir: Vector3, head: boolean) {
    this.dust.emit({ pos: point, count: head ? 14 : 8, speed: head ? 3 : 2, dir, spread: 0.7, life: [0.25, 0.6], size: [0.06, 0.25], color: '#8a0e0e', alpha: 0.9, gravity: 6, drag: 2 });
  }

  /** Blood sprayed onto the surface behind a hit (`dir` = bullet direction). */
  bloodDecal(point: Vector3, normal: Vector3, dir: Vector3, size: number) {
    const d = this.bloods[this.bloodIdx]; this.bloodIdx = (this.bloodIdx + 1) % this.bloods.length;
    d.position.copy(point).addScaledVector(normal, 0.006);
    d.lookAt(_p.copy(point).add(normal));
    // smear along the bullet's direction projected onto the surface
    const t = dir.clone().addScaledVector(normal, -dir.dot(normal));
    if (t.lengthSq() > 1e-4) {
      t.normalize();
      const right = new Vector3(1, 0, 0).applyQuaternion(d.quaternion), up = new Vector3(0, 1, 0).applyQuaternion(d.quaternion);
      d.rotateZ(Math.atan2(t.dot(up), t.dot(right)));
    } else d.rotateZ(this.rng.next() * 6.28);
    d.scale.setScalar(size);
    d.visible = true;
  }

  /** Concussion blast: white-blue flash, a shock ring and a puff of dust. */
  stunBlast(pos: Vector3) {
    this.sparks.emit({ pos, count: 26, speed: 9, life: [0.05, 0.18], size: [0.9, 0.2], color: '#dfe8ff' });
    this.dust.emit({ pos, count: 18, speed: 4, life: [0.5, 1.2], size: [0.4, 1.6], color: '#8a8c90', alpha: 0.5, drag: 2.5, up: 0.6 });
    this.lightFlash(pos.clone().setY(pos.y + 0.4), 0xc8d8ff, 70, 0.18, 14);
    this.pulseRing(pos, '#d0e0ff', 7);
  }

  /**
   * A gunshot's light. With `dir`, also the flash everyone else sees at the muzzle: a hot core, a
   * few sparks thrown forward and a wisp of smoke (`scale` 0.3 for a suppressor or flash hider).
   * Your own gun draws its flash in the view model, so the local shot passes no direction.
   */
  muzzle(pos: Vector3, dir?: Vector3, scale = 1) {
    this.lightFlash(pos, 0xffc070, 6 * Math.min(1, scale + 0.3), 0.06, 8);
    if (!dir) return;
    const tip = _v.copy(pos).addScaledVector(dir, 0.22);
    this.sparks.emit({ pos: tip, count: 1, speed: 0, life: [0.045, 0.06], size: [0.5 * scale, 0.16 * scale], color: '#ffe2ac' });
    if (scale < 0.5) return;
    this.sparks.emit({ pos: tip, count: 3, speed: 9, dir, spread: 0.3, life: [0.03, 0.08], size: [0.16, 0.03], color: '#ffc46a' });
    this.dust.emit({ pos: tip, count: 1, speed: 0.9, dir, spread: 0.5, life: [0.3, 0.7], size: [0.07, 0.42], color: '#a8a8a4', alpha: 0.16, drag: 2.5, up: 0.25 });
  }

  /** Dust kicked up at someone's feet: a hard landing, or a slide. */
  footDust(pos: Vector3, amount = 1, dir?: Vector3) {
    this.dust.emit({ pos, count: Math.round(5 * amount), speed: 1.3, dir: dir ?? _up, spread: dir ? 0.7 : 1.4, life: [0.35, 0.8], size: [0.12, 0.55], color: '#b4aea2', alpha: 0.22, drag: 3, up: 0.25 });
  }

  /** Pressure wave: a faint shell that swells to `radius` in a fraction of a second. */
  private shock(pos: Vector3, radius: number, dur = 0.22, color = 0xffd9a8) {
    const s = this.shocks.find((x) => x.t >= 1) ?? this.shocks[0];
    s.mesh.position.copy(pos); s.mat.color.setHex(color);
    s.t = 0; s.dur = dur; s.radius = radius;
    s.mesh.scale.setScalar(0.2); s.mesh.visible = true;
  }

  /** Burn the floor under a blast (only when it went off near the ground). */
  private scorch(pos: Vector3, size: number) {
    const ground = this.groundAt ? this.groundAt(pos.x, pos.z, pos.y + 0.3) : 0;
    if (pos.y - ground > 1.6) return;
    const s = this.scorches[this.scorchIdx]; this.scorchIdx = (this.scorchIdx + 1) % this.scorches.length;
    s.mesh.position.set(pos.x, ground + 0.012, pos.z);
    s.mesh.rotation.y = this.rng.next() * 6.28;
    s.mesh.scale.setScalar(size);
    s.age = 0; s.mat.opacity = 0.85; s.mesh.visible = true;
  }

  explosion(pos: Vector3) {
    this.sparks.emit({ pos, count: 60, speed: 14, life: [0.2, 0.6], size: [0.4, 0.1], color: '#ffb040', gravity: 6, up: 2 });
    // fireball: a white-hot core inside rolling orange, gone in a quarter of a second
    this.sparks.emit({ pos, count: 1, speed: 0, life: [0.09, 0.11], size: [3.4, 1.2], color: '#fff2d0' });
    this.sparks.emit({ pos, count: 10, speed: 3.2, life: [0.12, 0.28], size: [1.3, 0.5], color: '#ff9a34', up: 0.8 });
    this.dust.emit({ pos, count: 40, speed: 5, life: [0.8, 2.0], size: [0.6, 2.6], color: '#4a4440', alpha: 0.7, drag: 2, up: 1.5 });
    this.dust.emit({ pos, count: 16, speed: 9, life: [0.4, 1.1], size: [0.09, 0.14], color: '#2a2622', alpha: 0.95, gravity: 9, up: 3 }); // debris
    this.lightFlash(pos.clone().setY(pos.y + 0.5), 0xffa040, 80, 0.35, 18);
    this.shock(pos, 5.5);
    this.scorch(pos, 3.2);
  }

  /** Explosion scaled by blast radius (rockets, C4, killstreaks). */
  blast(pos: Vector3, radius: number) {
    const k = Math.max(0.6, radius / 4.5);
    this.sparks.emit({ pos, count: Math.round(50 * k), speed: 12 * Math.sqrt(k), life: [0.2, 0.7], size: [0.5 * k, 0.1], color: '#ffb040', gravity: 6, up: 2 });
    this.sparks.emit({ pos, count: Math.round(20 * k), speed: 4 * k, life: [0.1, 0.3], size: [1.6 * k, 0.4], color: '#ffe0a0' });
    this.sparks.emit({ pos, count: 1, speed: 0, life: [0.1, 0.13], size: [4 * k, 1.4 * k], color: '#fff2d0' });
    this.dust.emit({ pos, count: Math.round(36 * k), speed: 4.5 * Math.sqrt(k), life: [1.0, 2.6], size: [0.8 * k, 3.2 * k], color: '#3e3a36', alpha: 0.75, drag: 2, up: 1.4 });
    this.dust.emit({ pos, count: Math.round(14 * k), speed: 9 * Math.sqrt(k), life: [0.4, 1.2], size: [0.1, 0.25], color: '#2a2622', alpha: 0.9, gravity: 9, up: 3 });
    this.lightFlash(pos.clone().setY(pos.y + 0.6), 0xffa040, 90 * k, 0.4, 14 + radius * 2);
    this.shock(pos, radius * 1.15, 0.2 + radius * 0.012);
    this.scorch(pos, Math.min(9, radius * 0.8));
  }

  /** Smoke + embers left behind a rocket each frame. */
  rocketTrail(pos: Vector3) {
    this.dust.emit({ pos, count: 2, speed: 0.4, life: [0.6, 1.4], size: [0.15, 0.9], color: '#bdb8b0', alpha: 0.45, drag: 1.5, up: 0.3 });
    this.sparks.emit({ pos, count: 1, speed: 1.5, life: [0.05, 0.15], size: [0.25, 0.05], color: '#ffb050' });
  }

  /** Green motes rising off someone being stimmed. */
  heal(pos: Vector3) {
    this.sparks.emit({ pos, count: 14, speed: 0.8, life: [0.4, 1.0], size: [0.07, 0.02], color: '#50ff90', gravity: -1.2, up: 0.6 });
  }

  /** Splinters from boards being hacked / pried. */
  splinters(pos: Vector3, metal: boolean) {
    if (metal) this.sparks.emit({ pos, count: 10, speed: 5, life: [0.1, 0.3], size: [0.06, 0.02], color: '#ffd080', gravity: 9 });
    else this.dust.emit({ pos, count: 10, speed: 3, life: [0.4, 1.0], size: [0.04, 0.12], color: '#a07848', alpha: 0.95, gravity: 9, drag: 1 });
  }

  flashbang(pos: Vector3) {
    this.sparks.emit({ pos, count: 30, speed: 8, life: [0.05, 0.2], size: [1.2, 0.2], color: '#ffffff' });
    this.lightFlash(pos, 0xffffff, 140, 0.25, 22);
  }

  /** Generic soft puff (dust system: smoke, gas, debris). */
  puff(o: EmitOpts) { this.dust.emit(o); }
  /** Generic additive sparks (glows, embers, zaps). */
  glow(o: EmitOpts) { this.sparks.emit(o); }

  pulseRing(pos: Vector3, color = '#30d0ff', maxR = 12) {
    const mesh = new Mesh(new RingGeometry(0.9, 1, 48), new MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: DoubleSide, blending: AdditiveBlending, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(pos).setY(pos.y + 0.1);
    this.group.add(mesh);
    this.rings.push({ mesh, t: 0, dur: 0.9, maxR });
  }

  sync(smokes: { id: number; pos: Vector3; radius: number }[], fires: { id: number; pos: Vector3; radius: number }[]) {
    // smokes
    const alive = new Set(smokes.map((s) => s.id));
    for (const [id, fx] of this.smokes) if (!alive.has(id)) { this.group.remove(fx.mesh); fx.mesh.geometry.dispose(); fx.mat.dispose(); fx.mesh.dispose(); this.smokes.delete(id); }
    for (const s of smokes) {
      let fx = this.smokes.get(s.id);
      if (!fx) {
        const mat = new MeshBasicMaterial({ map: this.smokeTex, color: '#b9bdbf', transparent: true, depthWrite: false, opacity: 1 });
        const mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, SMOKE_N);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        const offsets: Vector3[] = [], angles: number[] = [], scales: number[] = [];
        for (let i = 0; i < SMOKE_N; i++) {
          const v = new Vector3(this.rng.range(-1, 1), this.rng.range(-0.55, 0.8), this.rng.range(-1, 1));
          if (v.length() > 1) v.normalize();
          offsets.push(v); angles.push(this.rng.range(0, 6.28)); scales.push(this.rng.range(2.2, 3.6));
          mesh.setColorAt(i, new Color().setScalar(this.rng.range(0.75, 1.05)));
        }
        this.group.add(mesh);
        fx = { id: s.id, mesh, offsets, angles, scales, mat };
        this.smokes.set(s.id, fx);
      }
      (fx.mesh.userData as { center: Vector3; radius: number }).center = s.pos;
      (fx.mesh.userData as { center: Vector3; radius: number }).radius = s.radius;
    }
    // fires
    const fireAlive = new Set(fires.map((f) => f.id));
    for (const [id, fx] of this.fires) if (!fireAlive.has(id)) {
      this.group.remove(fx.mesh); fx.mesh.geometry.dispose(); (fx.mesh.material as MeshBasicMaterial).dispose(); fx.mesh.dispose();
      if (fx.light) fx.light.intensity = 0;
      this.fires.delete(id);
    }
    for (const f of fires) {
      let fx = this.fires.get(f.id);
      if (!fx) {
        const mat = new MeshBasicMaterial({ map: this.flameTex, color: '#ff9a40', transparent: true, depthWrite: false, blending: AdditiveBlending });
        const mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, FIRE_N);
        mesh.frustumCulled = false;
        const offsets: Vector3[] = [], phase: number[] = [];
        for (let i = 0; i < FIRE_N; i++) {
          const a = this.rng.range(0, 6.28), r = Math.sqrt(this.rng.next());
          offsets.push(new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); phase.push(this.rng.range(0, 6.28));
        }
        this.group.add(mesh);
        const light = this.takeLight();
        light.color.setHex(0xff8030); light.distance = 10; light.position.copy(f.pos).setY(f.pos.y + 0.8);
        fx = { id: f.id, mesh, offsets, phase, light };
        this.fires.set(f.id, fx);
      }
      fx.mesh.userData.center = f.pos; fx.mesh.userData.radius = f.radius;
    }
  }

  update(dt: number, camera: Camera, viewportH: number, fovDeg: number, time: number) {
    const scale = viewportH / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.sparks.material.uniforms.scale.value = scale;
    this.dust.material.uniforms.scale.value = scale;
    this.sparks.update(dt);
    this.dust.update(dt);
    this.tracers.update(dt, camera.getWorldPosition(_v));
    this.casings.update(dt);
    for (const s of this.shocks) {
      if (s.t >= 1) continue;
      s.t = Math.min(1, s.t + dt / s.dur);
      const e = 1 - (1 - s.t) * (1 - s.t);
      s.mesh.scale.setScalar(Math.max(0.2, s.radius * e));
      s.mat.opacity = 0.2 * (1 - s.t) * (1 - s.t);
      if (s.t >= 1) s.mesh.visible = false;
    }
    for (const s of this.scorches) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      s.mat.opacity = 0.85 * Math.min(1, (SCORCH_LIFE - s.age) / 6);
      if (s.age >= SCORCH_LIFE) s.mesh.visible = false;
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = Math.max(0, 1 - f.t / f.dur);
      f.light.intensity = f.intensity * k * k;
      if (f.t >= f.dur) { f.light.intensity = 0; this.flashes.splice(i, 1); }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.dur;
      r.mesh.scale.setScalar(0.5 + k * r.maxR);
      (r.mesh.material as MeshBasicMaterial).opacity = 0.8 * (1 - k);
      if (k >= 1) { this.group.remove(r.mesh); r.mesh.geometry.dispose(); (r.mesh.material as MeshBasicMaterial).dispose(); this.rings.splice(i, 1); }
    }
    // billboard smoke puffs
    camera.getWorldQuaternion(_q);
    for (const fx of this.smokes.values()) {
      const { center, radius } = fx.mesh.userData as { center: Vector3; radius: number };
      if (!center) continue;
      const k = radius / 4.6;
      for (let i = 0; i < SMOKE_N; i++) {
        const o = fx.offsets[i];
        const drift = Math.sin(time * 0.3 + i) * 0.15;
        _p.set(center.x + o.x * radius * 0.85 + drift, Math.max(0.3, center.y + o.y * radius * 0.6), center.z + o.z * radius * 0.85 - drift);
        _q2.setFromAxisAngle(_z, fx.angles[i] + time * 0.05 * ((i % 2) * 2 - 1));
        _s.setScalar(fx.scales[i] * Math.max(0.2, k) * 1.5);
        _m.compose(_p, _q.clone().multiply(_q2), _s);
        fx.mesh.setMatrixAt(i, _m);
      }
      fx.mesh.instanceMatrix.needsUpdate = true;
      if (fx.mesh.instanceColor) fx.mesh.instanceColor.needsUpdate = true;
    }
    for (const fx of this.fires.values()) {
      const { center, radius } = fx.mesh.userData as { center: Vector3; radius: number };
      if (!center) continue;
      for (let i = 0; i < FIRE_N; i++) {
        const o = fx.offsets[i];
        const fl = 0.7 + 0.3 * Math.sin(time * 12 + fx.phase[i]) + 0.15 * Math.sin(time * 23 + i);
        const h = (0.6 + 0.6 * fl) * (1 - o.length() * 0.4);
        _p.set(center.x + o.x * radius, center.y + h * 0.45, center.z + o.z * radius);
        _s.set(h * 0.9, h * 1.4, 1);
        _m.compose(_p, _q, _s);
        fx.mesh.setMatrixAt(i, _m);
      }
      fx.mesh.instanceMatrix.needsUpdate = true;
      if (fx.light) fx.light.intensity = 9 + Math.sin(time * 17) * 2 + Math.sin(time * 31) * 1.5;
      if (Math.random() < dt * 20) {
        const o = fx.offsets[Math.floor(Math.random() * FIRE_N)];
        this.sparks.emit({ pos: _p.set(center.x + o.x * radius, center.y + 0.3, center.z + o.z * radius).clone(), count: 1, speed: 0.5, life: [0.4, 0.9], size: [0.07, 0.02], color: '#ffa040', up: 2.5 });
        if (Math.random() < 0.3) this.dust.emit({ pos: _p.clone().setY(center.y + 1.2), count: 1, speed: 0.3, life: [1, 2], size: [0.5, 2], color: '#2a2622', alpha: 0.35, up: 1.2 });
      }
    }
  }

  /** How deep the camera is inside a smoke cloud (0..1) – drives the full-screen smoke overlay. */
  smokeDensityAt(p: Vector3): number {
    let d = 0;
    for (const fx of this.smokes.values()) {
      const { center, radius } = fx.mesh.userData as { center: Vector3; radius: number };
      if (!center || radius < 0.5) continue;
      const dist = p.distanceTo(center);
      d = Math.max(d, Math.min(1, (radius * 1.05 - dist) / (radius * 0.45)));
    }
    return Math.max(0, d);
  }

  clear(scene?: Scene) {
    void scene;
    this.sparks.clear(); this.dust.clear();
    for (const d of this.decals) d.visible = false;
    for (const d of this.bloods) d.visible = false;
    this.tracers.clear();
    this.casings.clear();
    for (const s of this.shocks) { s.t = 1; s.mesh.visible = false; }
    for (const s of this.scorches) { s.age = SCORCH_LIFE; s.mesh.visible = false; }
    this.sync([], []);
    for (const ring of this.rings) { this.group.remove(ring.mesh); ring.mesh.geometry.dispose(); (ring.mesh.material as MeshBasicMaterial).dispose(); }
    this.rings = [];
    for (const flash of this.flashes) flash.light.intensity = 0;
    this.flashes = [];
  }
}
