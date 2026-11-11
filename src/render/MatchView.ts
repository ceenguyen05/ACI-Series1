import { AdditiveBlending, BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, SphereGeometry, Vector2, Vector3 } from 'three';
import { KillcamPlayer, KillcamRecorder, type AgentFrame, type ReplayEvent } from './Killcam';
import { blobShadow } from './Textures';
import { releaseModel } from './Geometry';
import { WEAPONS, scopedView } from '../config/weapons';
import { loadoutKey } from '../config/attachments';
import { GADGETS, type GadgetId } from '../config/gadgets';
import type { Shot } from '../sim/combat/Ordnance';
import { deviceModel } from './GadgetModels';
import { DEG, clamp, damp, dirFromAngles, wrapAngle } from '../core/math';
import { MOVE } from '../config/movement';
import type { WeaponId } from '../config/weapons';
import type { Agent } from '../sim/entities/Agent';
import type { Match } from '../sim/mode/Match';
import { VIEW_PUNCH_FRACTION } from '../sim/combat/recoil';
import { sfx } from '../audio/Sfx';
import { CharacterModel } from './CharacterModel';
import { LandingSpring, StairMotion } from './MovementMotion';
import { ZombieModel } from './ZombieModel';
import type { GameRenderer } from './Renderer';
import { bombModel, grenadeModel, weaponModel } from './WeaponModels';
import type { PaperDollMode } from './PaperDoll';
import { ThrowPreview } from './ThrowPreview';
import type { CasingKind } from './Effects';
import type { WeaponDef } from '../config/weapons';

interface CharEntry {
  model: CharacterModel | ZombieModel; prev: Vector3; cur: Vector3; xray: Group; firing: number; light: Color; hitAt: number; throwAt: number; shadow: Mesh;
  /** Zombies: pool generation seen, last AI mode, and when the last swipe landed. */
  gen: number; lastMode: string; strikeAt: number;
}

const lerpAngle = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;
const v3 = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];
const _dust = new Vector3();
const SHADOW_GEO = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
let shadowMat: MeshBasicMaterial | null = null;

export interface ViewSettings { fov: number; viewmodelFov: number; leftHanded: boolean; paperDoll?: PaperDollMode; paperDollSize?: number; grenadePreview?: boolean }

/** How a gun throws its spent case: what it looks like, and how long after the shot (manual actions eject on the cycle). */
function ejection(def: WeaponDef): { kind: CasingKind; delay: number } | null {
  if (def.projectile || def.class === 'knife' || def.class === 'launcher' || def.sound === 'energy') return null;
  if (def.class === 'shotgun') return { kind: 'shell', delay: def.auto ? 0 : 0.34 };
  if (def.class === 'sniper') return { kind: 'brass', delay: def.scope?.stay ? 0 : 0.5 };
  return { kind: def.class === 'pistol' || def.class === 'smg' ? 'small' : 'brass', delay: 0 };
}

/** Convert CS-style horizontal FOV at 4:3 into a vertical FOV. */
export const verticalFov = (hfov43: number) => 2 * Math.atan(Math.tan((hfov43 * DEG) / 2) * 0.75) / DEG;

/** Presents a running Match: syncs models, effects, audio and the camera. */
export class MatchView {
  private chars = new Map<number, CharEntry>();
  private items = new Map<number, Group>();
  private projectiles = new Map<number, Group>();
  private shots = new Map<number, Group>();
  private trailT = 0;
  private uavs: { g: Group; until: number; phase: number; r: number }[] = [];
  private missileWindT = 0;
  private ghost: Group | null = null;
  private ghostKey = '';
  private devices = new Map<number, Group>();
  private lasers = new Map<number, Line>();
  private laserMat = new LineBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false });
  private humT = 0;
  private bomb: Group;
  private bombLed: Mesh | null;
  private root = new Group();
  private shake = 0;
  private probeTmp = new Color();
  private deathCamYaw: number | null = null;
  private deathCamPitch = 0;
  private vmLight = new Color(1, 1, 1);
  private landing = new LandingSpring();
  private stairs = new StairMotion(MOVE.stepHeight);
  private prevFeetY = 0;
  private prevGround = false;
  private punchPitch = 0;
  private punchYaw = 0;
  private prevEye = new Vector3();
  private curEye = new Vector3();
  private stepAlpha = 0;
  private unsub: (() => void)[] = [];
  private knives = new Map<number, Group>();
  private beams = new Map<number, { line: Line; dot: Mesh; cone: Mesh; flare: Mesh }>();
  private beamMats = {
    red: new LineBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }),
    green: new LineBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.75, blending: AdditiveBlending, depthWrite: false }),
  };
  /** Glare on the local player's screen from an enemy weapon light (HUD draws it). */
  glare: { x: number; y: number; strength: number } | null = null;
  /**
   * Screen position (NDC, 0,0 = centre) the next shot goes to before spread. The camera shows only
   * part of the recoil punch, so this climbs off-centre in a spray; the HUD crosshair, optic
   * reticles and the view model's sights all sit on it.
   */
  readonly aimNdc = new Vector2();
  private aimDir = new Vector3();
  private aimQ = new Quaternion();
  private aimEuler = new Euler();
  /** Short replay buffer + the killcam currently playing (null when live). */
  readonly recorder = new KillcamRecorder();
  killcam: KillcamPlayer | null = null;
  /** Flash on the kill moment of the killcam (HUD reads it). */
  killcamFlash = 0;
  private kcYaw = 0;
  /** Team pings for the HUD to draw. */
  pings: { pos: Vector3; enemyId: number | null; until: number; by: string }[] = [];
  /** Time of the local heartbeat sensor's last sweep (HUD animates the scan line). */
  lastHeartbeat = 0;
  /** Agent whose eyes we look through (player, or spectated teammate). */
  viewAgent: Agent | null = null;
  /** Called by HUD hooks. */
  onLocalHit: (head: boolean) => void = () => {};
  onLocalKill: (headshot: boolean) => void = () => {};
  onLocalHurt: (fromYaw: number) => void = () => {};
  onLocalFlash: (strength: number, duration: number) => void = () => {};
  onLocalStun: (strength: number, duration: number) => void = () => {};
  /** The viewer damaged someone: the HUD floats the number off the wound. */
  onLocalDamage: (victimId: number, amount: number, point: Vector3, head: boolean, armor: boolean) => void = () => {};
  /** A round passed close to the viewer's head (0..1 = how close). */
  onLocalNearMiss: (close: number) => void = () => {};
  freeCam: { pos: Vector3; yaw: number; pitch: number } | null = null;
  private throwPreview = new ThrowPreview();
  /** Rate limits (performance.now ms) for the busiest positional sounds. */
  private whizAt = 0;
  private impactAt = 0;
  private casingAt = 0;
  private roomT = 0;
  private adsWas = false;

  /** Zombies mode: no killcam recording, zombie models and sounds. */
  private readonly zombies: boolean;

  constructor(private r: GameRenderer, private match: Match, private finishes: Partial<Record<WeaponId, string>>, private settings: () => ViewSettings) {
    this.zombies = match.agents.some((a) => a.zombie) || 'zombiePool' in match;
    r.scene.add(this.root);
    this.bomb = bombModel();
    this.bomb.visible = false;
    this.bombLed = this.bomb.getObjectByName('led') as Mesh | null;
    this.root.add(this.bomb, this.throwPreview.group);
    for (const a of match.agents) this.addChar(a);
    // effects that touch the floor, and sound that knows about walls
    const col = match.world.collision;
    r.effects.groundAt = (x, z, y) => col.groundHeight(x, z, y);
    r.effects.onCasingBounce = (pos, kind) => {
      const t = performance.now();
      if (t < this.casingAt || pos.distanceToSquared(r.camera.position) > 144) return;
      this.casingAt = t + 45;
      sfx.casing(pos.clone(), kind === 'shell');
    };
    sfx.occlusion = (pos) => this.occlusionAt(pos);
    this.wireEvents();
  }

  private occA = new Vector3(); private occB = new Vector3(); private occSide = new Vector3();
  /**
   * How much of the way from the listener to a sound is walled off (0 open … 0.85 solid). Besides
   * the straight line it tries either side of the source and above it, so a sound just round a
   * corner or through a doorway is only partly muffled.
   */
  private occlusionAt(pos: Vector3): number {
    const cam = this.r.camera.position, col = this.match.world.collision;
    const src = this.occA.copy(pos);
    if (src.y < cam.y - 0.7) src.y += 0.7; // footsteps and floor impacts: listen at body height, not through the furniture
    const dx = src.x - cam.x, dz = src.z - cam.z, flat = Math.hypot(dx, dz);
    if (flat < 1.5 && Math.abs(src.y - cam.y) < 2) return 0;
    const side = this.occSide.set(-dz, 0, dx).multiplyScalar(flat > 1e-3 ? 0.9 / flat : 0);
    let blocked = 0;
    if (col.segmentBlocked(cam, src)) blocked++;
    if (col.segmentBlocked(cam, this.occB.copy(src).add(side))) blocked++;
    if (col.segmentBlocked(cam, this.occB.copy(src).sub(side))) blocked++;
    if (col.segmentBlocked(cam, this.occB.copy(src).setY(src.y + 0.9))) blocked++;
    return blocked * 0.2125;
  }

  /** Throw a spent case out of a gun that just fired. */
  private ejectCasing(a: Agent, def: WeaponDef, local: boolean, origin: Vector3, end: Vector3) {
    const ej = ejection(def);
    if (!ej) return;
    const cam = this.r.camera, fx = this.r.effects;
    const hand = local && this.settings().leftHanded ? -1 : 1;
    const right = new Vector3(Math.cos(a.yaw) * hand, 0, -Math.sin(a.yaw) * hand);
    const fwd = end.clone().sub(origin).normalize();
    // Your own brass leaves the port below the edge of the screen (the view model shows it up close)
    // and lands beside you; everyone else's is thrown from their gun.
    const pos = local ? cam.position.clone().addScaledVector(right, 0.42).addScaledVector(fwd, 0.25).setY(cam.position.y - 0.38)
      : origin.clone().addScaledVector(fwd, -0.3).addScaledVector(right, 0.05);
    if (!local && pos.distanceToSquared(cam.position) > 900) return;
    const vel = right.multiplyScalar(1.3 + Math.random() * 0.9).addScaledVector(fwd, -0.2 - Math.random() * 0.5)
      .add(new Vector3(a.vel.x, 1.2 + Math.random() * 0.8, a.vel.z));
    fx.casing(pos, vel, ej.kind, ej.delay);
  }

  /** A shot by someone else: does it pass close enough to the viewer's head to hear it go by? */
  private nearMiss(origin: Vector3, end: Vector3) {
    const view = this.viewAgent;
    if (!view || !view.alive || this.freeCam || view.operating !== null || this.killcam) return;
    const now = performance.now();
    if (now < this.whizAt) return;
    const cam = this.r.camera.position;
    const d = end.clone().sub(origin), len = d.length();
    if (len < 5) return;
    d.divideScalar(len);
    const along = clamp(cam.clone().sub(origin).dot(d), 0, len);
    // it has to have flown a few metres to get here, and to carry on past (a round that stops at you is a hit or an impact)
    if (along < 4 || len - along < 0.7) return;
    const closest = origin.clone().addScaledVector(d, along);
    const miss = closest.distanceTo(cam);
    if (miss > 2.2) return;
    this.whizAt = now + 70;
    const close = 1 - miss / 2.2;
    sfx.whiz(closest, 0.35 + 0.65 * close);
    this.onLocalNearMiss(close);
    // a faint flinch of the view (camera only: the aim and the crosshair stay put)
    this.shake = Math.max(this.shake, 0.03 + 0.06 * close);
  }

  private addChar(a: Agent) {
    const model = a.zombie ? new ZombieModel() : new CharacterModel(a.look[a.team]);
    const xray = new Group();
    const xm = new MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.55, depthTest: false });
    for (let i = 0; i < 4; i++) {
      const m = new Mesh(new BoxGeometry(1, 1, 1), xm); m.renderOrder = 10; xray.add(m);
    }
    xray.visible = false;
    shadowMat ??= new MeshBasicMaterial({ map: blobShadow(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, opacity: 0.8 });
    const shadow = new Mesh(SHADOW_GEO, shadowMat);
    shadow.renderOrder = 1;
    this.root.add(model.root, xray, shadow);
    this.chars.set(a.id, { model, prev: a.pos.clone(), cur: a.pos.clone(), xray, firing: 0, light: new Color(1, 1, 1), hitAt: -10, throwAt: -10, shadow, gen: -1, lastMode: '', strikeAt: -10 });
  }

  private heldKey(a: Agent): string {
    if (a.active === 'grenade' && a.activeGrenade) return 'g:' + a.activeGrenade;
    if (a.active === 'bomb') return 'bomb';
    if (a.active === 'gadget' && a.activeGadget) return 'd:' + a.activeGadget;
    const w = a.activeWeapon();
    if (!w) return '';
    const finish = (w.def.tier ?? 0) > 0 ? 'forged' : a.isBot ? '' : this.finishes[w.def.id] ?? '';
    return `w:${w.def.id}:${finish}:${loadoutKey(w.att)}`;
  }

  // ------------------------------------------------------------------ events → fx/audio
  private wireEvents() {
    const ev = this.match.events, fx = this.r.effects;
    const on = <K extends Parameters<typeof ev.on>[0]>(k: K, fn: Parameters<typeof ev.on<K>>[1]) => this.unsub.push(ev.on(k, fn));
    const isView = (id: number) => this.viewAgent?.id === id;
    const listenerPos = () => this.r.camera.position;
    on('shot', (e) => {
      const ent = this.chars.get(e.agentId);
      if (ent) ent.firing = 1;
      const shooter = this.match.getAgent(e.agentId);
      const gun = shooter?.activeWeapon() ?? null;
      // the held gun's own def carries its attachments; fall back to the stock one (never trust it exists)
      const def: WeaponDef | undefined = gun && gun.def.id === e.weaponId ? gun.def : WEAPONS[e.weaponId];
      if (isView(e.agentId)) {
        if (!e.pellet) {
          this.r.viewModel.onFire(def?.recoil.kick ?? 1);
          // the last quarter of a magazine rings hollow, so you hear it running dry
          const quarter = def ? Math.ceil(def.mag * 0.25) : 0;
          const emptying = gun && def && def.mag >= 6 && gun.mag < quarter ? 1 - gun.mag / quarter : 0;
          sfx.gunshot(e.sound, null, 0, emptying);
          fx.muzzle(this.r.camera.position);
          if (shooter && def) this.ejectCasing(shooter, def, true, e.origin, e.end);
        }
        if (e.tracer) {
          const start = this.r.viewModel.muzzleCamSpace(new Vector3());
          this.r.camera.localToWorld(start);
          fx.tracer(start, e.end);
        }
      } else {
        if (!e.pellet) {
          sfx.gunshot(e.sound, e.origin, e.origin.distanceTo(listenerPos()));
          // everyone else's muzzle flash is drawn in the world (a suppressor or flash hider all but hides it)
          const quiet = e.sound === 'suppressed' || def?.mods?.smallFlash;
          fx.muzzle(e.origin, def?.projectile ? undefined : e.end.clone().sub(e.origin).normalize(), quiet ? 0.3 : def?.class === 'pistol' || def?.class === 'smg' ? 0.75 : 1);
          if (shooter && def) this.ejectCasing(shooter, def, false, e.origin, e.end);
        }
        if (e.tracer) fx.tracer(e.origin, e.end);
        if (!def?.projectile) this.nearMiss(e.origin, e.end);
      }
    });
    on('impact', (e) => {
      fx.impact(e.point, e.normal, e.surface);
      const t = performance.now();
      if (t >= this.impactAt && e.point.distanceToSquared(listenerPos()) < 324) { this.impactAt = t + 40; sfx.impact(e.point, e.surface); }
    });
    on('hit', (e) => {
      const dir = e.point.clone().sub(this.match.getAgent(e.attackerId)?.eyePos(new Vector3()) ?? e.point).normalize();
      if (e.source !== 'fire' && e.source !== 'fall') fx.blood(e.point, dir, e.group === 'head');
      if (isView(e.attackerId) && e.attackerId !== e.victimId) {
        const v = this.match.getAgent(e.victimId);
        sfx.hitConfirm(e.group === 'head', !!v && v.helmet && e.group === 'head');
        this.onLocalHit(e.group === 'head');
        if (e.amount > 0) this.onLocalDamage(e.victimId, e.amount, e.point, e.group === 'head', e.armorDamage > 0);
      }
      if (isView(e.victimId)) {
        sfx.hurt();
        const att = this.match.getAgent(e.attackerId);
        if (att) {
          const v = this.viewAgent!;
          this.onLocalHurt(Math.atan2(-(att.pos.x - v.pos.x), -(att.pos.z - v.pos.z)) - v.yaw);
        }
        this.shake = Math.max(this.shake, 0.3);
      }
    });
    on('hit', (e) => { const c = this.chars.get(e.victimId); if (c) c.hitAt = this.match.time; });
    on('throw', (e) => { const c = this.chars.get(e.agentId); if (c) c.throwAt = this.match.time; });
    on('gadgetDeploy', (e) => { const c = this.chars.get(e.agentId); if (c) c.throwAt = this.match.time; });
    on('kill', (e) => {
      if (isView(e.killerId) && e.killerId !== e.victimId) { sfx.killConfirm(e.headshot); this.onLocalKill(e.headshot); }
      if (isView(e.victimId)) { sfx.death(); this.deathCamYaw = null; }
    });
    on('footstep', (e) => {
      const z = this.zombies ? this.match.getAgent(e.agentId)?.zombie : null;
      if (z) {
        const heavy = z.kind === 'tank' || z.kind === 'brute';
        if (e.pos.distanceTo(listenerPos()) < (heavy ? 30 : 15)) sfx.zombieStep(e.pos.clone().setY(e.pos.y + 0.1), heavy);
        return;
      }
      if (isView(e.agentId)) sfx.footstep(e.surface, null, 0.45);
      else sfx.footstep(e.surface, e.pos.clone().setY(e.pos.y + 0.1));
    });
    on('land', (e) => {
      if (isView(e.agentId)) { this.landing.kick(e.hard ? 2 : 1); this.r.viewModel.onLand(e.hard); sfx.land(null); } else sfx.land(e.pos);
      if (e.hard) fx.footDust(e.pos.clone().setY(e.pos.y + 0.05), 1.4);
    });
    on('slide', (e) => { sfx.slide(isView(e.agentId) ? null : e.pos); fx.footDust(e.pos.clone().setY(e.pos.y + 0.05)); });
    on('jump', (e) => { if (isView(e.agentId)) sfx.jump(null); });
    on('scope', (e) => { if (isView(e.agentId)) sfx.scopeClick(e.level); });
    on('prone', (e) => sfx.prone(isView(e.agentId) ? null : e.pos, e.down));
    on('reload', (e) => {
      const a = this.match.getAgent(e.agentId);
      sfx.reload(isView(e.agentId) ? null : a?.pos.clone() ?? null, a?.activeWeapon()?.def.reloadTime);
    });
    on('draw', (e) => { if (isView(e.agentId)) sfx.draw(null); });
    on('dryFire', (e) => { if (isView(e.agentId)) sfx.dryFire(); });
    on('knife', (e) => {
      if (isView(e.agentId)) { this.r.viewModel.onKnife(e.stab); sfx.knife(null, e.hit); }
      else sfx.knife(this.match.getAgent(e.agentId)?.pos.clone() ?? null, e.hit);
    });
    on('throw', (e) => {
      if (isView(e.agentId)) this.r.viewModel.onThrow();
      sfx.throwSound(isView(e.agentId) ? null : this.match.getAgent(e.agentId)?.pos.clone() ?? null);
    });
    on('bounce', (e) => sfx.bounce(e.pos));
    on('detonate', (e) => {
      switch (e.kind) {
        case 'frag': fx.explosion(e.pos); sfx.explosion(e.pos); this.addShake(e.pos, 0.6, 14); break;
        case 'flash': fx.flashbang(e.pos); sfx.flashPop(e.pos); break;
        case 'smoke': sfx.smokePop(e.pos); break;
        case 'fire': sfx.fireIgnite(e.pos); break;
        case 'pulse': sfx.pulse(e.pos); break;
        case 'decoy': sfx.bounce(e.pos); break;
      }
    });
    on('fireOut', (e) => sfx.fireOut(e.pos));
    on('decoyShot', (e) => { if (this.zombies) sfx.boxSpin(e.pos, 0.95); else sfx.gunshot(e.sound, e.pos, e.pos.distanceTo(listenerPos())); });
    on('pulse', (e) => {
      fx.pulseRing(e.pos);
      sfx.pulse(e.pos);
    });
    on('flashed', (e) => {
      if (isView(e.agentId)) { this.onLocalFlash(e.strength, e.duration); sfx.tinnitus(e.strength, e.duration); }
    });
    on('bombBeep', (e) => { sfx.bombBeep(e.pos); if (this.bombLed) this.bombLed.userData.blink = 0.08; });
    on('bombPlanted', () => sfx.bombPlanted());
    on('bombExploded', (e) => {
      fx.explosion(e.pos); fx.explosion(e.pos.clone().add(new Vector3(0, 2, 0)));
      fx.lightFlash(e.pos.clone().setY(3), 0xffc080, 400, 1.2, 60);
      sfx.explosion(e.pos, true); sfx.explosion(null, true);
      this.addShake(e.pos, 1.2, 60);
    });
    on('defuseStart', (e) => sfx.defuseTick(this.match.getAgent(e.agentId)?.pos.clone() ?? null));
    on('plantStart', (e) => { if (isView(e.agentId)) sfx.plantKey(); });
    on('roundStart', () => { this.r.effects.clear(); sfx.roundStart(); });
    on('gadgetDeploy', (e) => sfx.gadgetDeploy(isView(e.agentId) ? null : e.pos));
    on('gadgetDestroyed', (e) => { sfx.deviceDestroyed(e.pos); fx.impact(e.pos, new Vector3(0, 1, 0), 'metal'); fx.lightFlash(e.pos, 0x80c0ff, 6, 0.15, 6); });
    on('ping', (e) => { if (isView(e.agentId)) sfx.ping(); });
    on('operate', (e) => { if (isView(e.agentId)) sfx.camSwitch(); });
    on('emp', (e) => { sfx.emp(e.pos); fx.pulseRing(e.pos, '#60a0ff', 9); fx.lightFlash(e.pos, 0x6090ff, 40, 0.4, 14); });
    on('mineArmed', (e) => sfx.mineArmed(e.pos));
    on('mineTrip', (e) => sfx.mineTrip(e.pos));
    on('wireRattle', (e) => sfx.wireRattle(e.pos));
    // ---- arsenal + killstreaks
    on('explosion', (e) => {
      if (e.source === 'disruptor') {
        fx.glow({ pos: e.pos, count: 40, speed: 7, life: [0.15, 0.5], size: [0.5, 0.08], color: '#8aff5a' });
        fx.pulseRing(e.pos, '#7dff4a', e.radius * 1.3);
        fx.lightFlash(e.pos.clone().setY(e.pos.y + 0.4), 0x70ff50, 60, 0.3, 12);
        sfx.disruptorZap(e.pos.distanceTo(listenerPos()) < 2 ? null : e.pos);
        return;
      }
      fx.blast(e.pos, e.radius);
      sfx.blast(e.pos.distanceTo(listenerPos()) < 2 ? null : e.pos, e.radius);
      this.addShake(e.pos, Math.min(1.4, 0.4 + e.radius * 0.1), e.radius * 4);
    });
    on('quickMelee', (e) => {
      const a = this.match.getAgent(e.agentId);
      const c = this.chars.get(e.agentId); if (c) c.throwAt = this.match.time;
      if (isView(e.agentId)) { this.r.viewModel.onQuickMelee(!!a?.hasCrowbar); sfx.meleeSwing(null, e.hit); }
      else sfx.meleeSwing(a?.pos.clone() ?? null, e.hit);
    });
    on('stimHeal', (e) => {
      const t = this.match.getAgent(e.targetId);
      if (t) fx.heal(t.pos.clone().setY(t.pos.y + 1.1));
      sfx.stimInject(isView(e.targetId) ? null : t?.pos.clone() ?? null);
    });
    on('gadgetDeploy', (e) => {
      if (e.kind !== 'stim') return;
      if (isView(e.agentId)) this.r.viewModel.onFire(0.5);
      sfx.stimShot(isView(e.agentId) ? null : e.pos);
    });
    on('resupply', (e) => { if (isView(e.agentId)) sfx.resupply(); });
    on('barricadeRemoved', (e) => { fx.splinters(e.pos.clone().setY(1.2), false); sfx.barricadeBreak(e.pos, false); });
    on('gadgetDestroyed', (e) => { if (e.kind === 'barricade' || e.kind === 'steelBarricade') { fx.splinters(e.pos.clone().setY(1.1), e.kind === 'steelBarricade'); sfx.barricadeBreak(e.pos, e.kind === 'steelBarricade'); } });
    on('killstreakEarned', (e) => { if (isView(e.agentId)) sfx.streakEarned(); });
    on('killstreakUsed', (e) => {
      const friendly = e.team === (this.match.player?.team ?? this.viewAgent?.team);
      sfx.streakCalled(friendly);
      if (e.streak === 'uav' || e.streak === 'counterUav') this.spawnUav(e.streak === 'uav' ? 25 : 20);
    });
    on('uavSweep', (e) => { if (e.team === (this.match.player?.team ?? this.viewAgent?.team)) sfx.uavPing(); });
    on('c4Detonate', (e) => { if (isView(e.agentId)) sfx.c4Arm(null); });

    // ---- tactical gear, movement, pings
    on('detonate', (e) => { if (e.kind === 'stun') { fx.stunBlast(e.pos); sfx.stunBang(e.pos); this.addShake(e.pos, 0.5, 12); } });
    on('stunned', (e) => { if (isView(e.agentId)) { this.onLocalStun(e.strength, e.duration); sfx.stunned(e.strength, e.duration); this.shake = Math.max(this.shake, 0.5 * e.strength); } });
    on('mantle', (e) => sfx.mantle(isView(e.agentId) ? null : this.match.getAgent(e.agentId)?.pos.clone() ?? null));
    on('throw', (e) => { if (e.kind === 'tknife') sfx.knifeThrow(isView(e.agentId) ? null : this.match.getAgent(e.agentId)?.pos.clone() ?? null); });
    on('knifePickup', (e) => { if (isView(e.agentId)) sfx.knifePickup(); });
    on('heartbeatScan', (e) => { if (isView(e.agentId)) { sfx.heartbeatBeep(e.count > 0); this.lastHeartbeat = this.match.time; } });
    on('teamPing', (e) => {
      const viewer = this.match.player ?? this.viewAgent;
      if (!viewer || viewer.team !== e.team) return;
      this.pings = this.pings.filter((p) => p.until > this.match.time && p.by !== (this.match.getAgent(e.agentId)?.name ?? ''));
      this.pings.push({ pos: e.pos.clone(), enemyId: e.enemyId, until: this.match.time + (e.enemyId !== null ? 4 : 6), by: this.match.getAgent(e.agentId)?.name ?? '' });
      sfx.pingSound(e.enemyId !== null);
    });
    on('roundStart', () => { this.pings = []; this.recorder.clear(); for (const g of this.knives.values()) releaseModel(g); this.knives.clear(); });
    // blood sprays onto the wall behind bullet hits
    on('hit', (e) => {
      if (!(e.source in WEAPONS) || e.source === 'knife') return;
      const att = this.match.getAgent(e.attackerId);
      if (!att) return;
      const dir = e.point.clone().sub(att.eyePos(new Vector3())).normalize();
      if (e.group !== 'head' && Math.random() > 0.65) return;
      const hit = this.match.world.collision.raycast(e.point, dir, 2.6);
      if (hit) fx.bloodDecal(hit.point, hit.normal, dir, (e.group === 'head' ? 0.75 : 0.5) * (1 - hit.t / 4));
    });

    // ---- replay recording (final killcam)
    const rec = (ev: ReplayEvent) => this.recorder.record(ev);
    on('shot', (e) => rec({ k: 'shot', agentId: e.agentId, sound: e.sound, o: v3(e.origin), e: v3(e.end), tracer: e.tracer, pellet: e.pellet,
      kick: this.match.getAgent(e.agentId)?.activeWeapon()?.def.recoil.kick ?? 1 }));
    on('impact', (e) => rec({ k: 'impact', p: v3(e.point), n: v3(e.normal), surface: e.surface }));
    on('hit', (e) => {
      const att = this.match.getAgent(e.attackerId);
      const d = e.point.clone().sub(att?.eyePos(new Vector3()) ?? e.point).normalize();
      rec({ k: 'hit', victimId: e.victimId, attackerId: e.attackerId, p: v3(e.point), d: v3(d), head: e.group === 'head', source: e.source });
    });
    on('explosion', (e) => rec({ k: 'blast', p: v3(e.pos), radius: e.radius }));
    on('detonate', (e) => { if (e.kind === 'frag') rec({ k: 'frag', p: v3(e.pos) }); else if (e.kind === 'flash') rec({ k: 'flash', p: v3(e.pos) }); });
    on('kill', (e) => rec({ k: 'kill', killerId: e.killerId, victimId: e.victimId, weapon: e.weapon, headshot: e.headshot }));
    on('knife', (e) => rec({ k: 'knife', agentId: e.agentId, stab: e.stab, hit: e.hit }));
    on('quickMelee', (e) => rec({ k: 'melee', agentId: e.agentId, hit: e.hit }));
    on('throw', (e) => rec({ k: 'throw', agentId: e.agentId }));

    // ---- HUD paper doll (mirrors whoever we look through)
    const doll = this.r.paperDoll;
    on('shot', (e) => { if (isView(e.agentId) && !e.pellet) doll.onShot(); });
    on('hit', (e) => { if (isView(e.victimId)) doll.onHit(); });
    for (const k of ['throw', 'gadgetDeploy', 'quickMelee', 'knife'] as const) on(k, (e) => { if (isView(e.agentId)) doll.onSwing(); });
  }

  // ------------------------------------------------------------------ final killcam
  /** Start replaying the most recent kill. Returns false if there's nothing worth showing. */
  startKillcam(final: boolean): boolean {
    const k = this.recorder.lastKill();
    if (!k) return false;
    const { killerId, victimId, weapon, headshot } = k.ev;
    const killer = this.match.getAgent(killerId), victim = this.match.getAgent(victimId);
    if (!killer || !victim || killerId === victimId) return false;
    const kf = this.recorder.frames[k.idx].agents.find((a) => a.id === killerId);
    const firstPerson = (weapon in WEAPONS || weapon === 'tknife') && !!kf?.alive;
    this.killcam = new KillcamPlayer([...this.recorder.frames], k.idx, {
      killerId, victimId, killerName: killer.name, victimName: victim.name, killerTeam: killer.team, weapon, headshot, final, firstPerson,
    });
    const vf = this.recorder.frames[k.idx].agents.find((a) => a.id === victimId);
    this.kcYaw = vf ? vf.yaw + Math.PI * 0.75 : 0;
    this.killcamFlash = 0;
    return true;
  }
  stopKillcam() { this.killcam = null; }

  private replayEvent(ev: ReplayEvent, kc: KillcamPlayer) {
    const fx = this.r.effects, vm = this.r.viewModel;
    const fpKiller = (id: number) => kc.info.firstPerson && id === kc.info.killerId;
    const at = (p: [number, number, number]) => new Vector3(p[0], p[1], p[2]);
    switch (ev.k) {
      case 'shot': {
        const c = this.chars.get(ev.agentId); if (c) c.firing = 1;
        const origin = at(ev.o), end = at(ev.e);
        if (fpKiller(ev.agentId)) {
          if (!ev.pellet) { vm.onFire(ev.kick); sfx.gunshot(ev.sound, null); fx.muzzle(this.r.camera.position); }
          if (ev.tracer) { const s = vm.muzzleCamSpace(new Vector3()); this.r.camera.localToWorld(s); fx.tracer(s, end); }
        } else {
          if (!ev.pellet) {
            sfx.gunshot(ev.sound, origin, origin.distanceTo(this.r.camera.position));
            const flight = end.clone().sub(origin);
            fx.muzzle(origin, flight.lengthSq() > 9 ? flight.normalize() : undefined, ev.sound === 'suppressed' ? 0.3 : 1);
          }
          if (ev.tracer) fx.tracer(origin, end);
        }
        break;
      }
      case 'impact': fx.impact(at(ev.p), at(ev.n), ev.surface); break;
      case 'hit': {
        if (ev.source !== 'fire' && ev.source !== 'fall') fx.blood(at(ev.p), at(ev.d), ev.head);
        const c = this.chars.get(ev.victimId); if (c) c.hitAt = kc.time;
        if (fpKiller(ev.attackerId)) sfx.hitConfirm(ev.head, false);
        break;
      }
      case 'blast': fx.blast(at(ev.p), ev.radius); sfx.blast(at(ev.p), ev.radius); this.addShake(at(ev.p), 1, ev.radius * 4); break;
      case 'frag': fx.explosion(at(ev.p)); sfx.explosion(at(ev.p)); break;
      case 'flash': fx.flashbang(at(ev.p)); sfx.flashPop(at(ev.p)); break;
      case 'kill':
        if (ev.killerId === kc.info.killerId && ev.victimId === kc.info.victimId) { sfx.killConfirm(ev.headshot); this.killcamFlash = 1; }
        break;
      case 'knife': if (fpKiller(ev.agentId)) vm.onKnife(ev.stab); sfx.knife(null, ev.hit); break;
      case 'melee': if (fpKiller(ev.agentId)) vm.onQuickMelee(false); sfx.meleeSwing(null, ev.hit); break;
      case 'throw': { const c = this.chars.get(ev.agentId); if (c) c.throwAt = kc.time; if (fpKiller(ev.agentId)) vm.onThrow(); break; }
    }
  }

  /** Characters + camera driven by the recorded frames instead of the live match. */
  private frameKillcam(dt: number, kc: KillcamPlayer, lookDelta: { dx: number; dy: number }) {
    for (const ev of kc.advance(dt)) this.replayEvent(ev, kc);
    this.killcamFlash = damp(this.killcamFlash, 0, 3, dt);
    const { a, b, alpha } = kc.sample();
    const find = (f: typeof a, id: number) => f.agents.find((x) => x.id === id);
    const info = kc.info;
    const ka = find(a, info.killerId), kb = find(b, info.killerId) ?? ka;
    const fp = info.firstPerson && !!ka?.alive;
    for (const ag of this.match.agents) {
      const e = this.chars.get(ag.id)!;
      if (e.model instanceof ZombieModel) continue;
      const fa = find(a, ag.id), fb = find(b, ag.id) ?? fa;
      e.xray.visible = false;
      if (!fa || !fb) { e.model.root.visible = false; e.shadow.visible = false; continue; }
      e.model.root.visible = !(fp && ag.id === info.killerId) && (fa.alive || kc.time - fa.deathTime < 30);
      if (!e.model.root.visible) { e.shadow.visible = false; continue; }
      const p = new Vector3(fa.x + (fb.x - fa.x) * alpha, fa.y + (fb.y - fa.y) * alpha, fa.z + (fb.z - fa.z) * alpha);
      e.model.setLook(ag.look[fa.team]);
      e.model.setHeld(fa.held);
      e.model.root.position.copy(p);
      e.model.root.rotation.y = fa.prone > 0 ? lerpAngle(fa.bodyYaw, fb.bodyYaw, alpha) : fa.alive ? lerpAngle(fa.yaw, fb.yaw, alpha) : fa.deathYaw;
      e.firing = damp(e.firing, 0, 18, dt);
      e.model.update({
        speed: fa.speed, maxSpeed: fa.maxSpeed, crouch: fa.duck + (fb.duck - fa.duck) * alpha, pitch: fa.pitch + (fb.pitch - fa.pitch) * alpha,
        prone: fa.prone + (fb.prone - fa.prone) * alpha, slide: fa.slide + (fb.slide - fa.slide) * alpha, aimYaw: wrapAngle(fa.yaw - fa.bodyYaw),
        lean: fa.lean + (fb.lean - fa.lean) * alpha, onGround: fa.onGround, dead: !fa.alive, deathT: kc.time - fa.deathTime, firing: e.firing,
        planting: fa.planting, dt, deathVariant: fa.deathVariant, hitT: kc.time - e.hitAt, throwT: kc.time - e.throwAt,
        forward: fa.fwd, right: fa.right, reload: fa.reload,
      });
      this.lightChar(e, p, dt);
      this.placeShadow(e, p, fa.alive, fa.duck, fa.prone);
    }
    // camera
    const cam = this.r.camera, s = this.settings();
    const baseV = verticalFov(s.fov);
    cam.near = 0.05;
    this.shake = damp(this.shake, 0, 5, dt);
    if (fp && ka && kb) {
      const yaw = lerpAngle(ka.yaw, kb.yaw, alpha), pitch = ka.pitch + (kb.pitch - ka.pitch) * alpha;
      cam.position.set(ka.ex + (kb.ex - ka.ex) * alpha, ka.ey + (kb.ey - ka.ey) * alpha, ka.ez + (kb.ez - ka.ez) * alpha);
      const pp = (ka.punchP + (kb.punchP - ka.punchP) * alpha) * VIEW_PUNCH_FRACTION * DEG, py = (ka.punchY + (kb.punchY - ka.punchY) * alpha) * VIEW_PUNCH_FRACTION * DEG;
      cam.rotation.set(pitch + pp + (Math.random() - 0.5) * this.shake * 0.04, yaw + py, -ka.lean * MOVE.leanRollDeg * DEG * (1 - ka.prone) * (1 - ka.slide), 'YXZ');
      const zoom = ka.zoom;
      cam.fov = 2 * Math.atan(Math.tan((baseV * DEG) / 2) / zoom) / DEG;
      cam.updateProjectionMatrix();
      this.driveViewModel(dt, ka, yaw, s);
      this.r.showViewModel = !ka.scoped;
    } else {
      // chase camera circling the victim (explosives, killstreaks, or the killer died first)
      const va = find(a, info.victimId), vb = find(b, info.victimId) ?? va;
      const c = va && vb ? new Vector3(va.x + (vb.x - va.x) * alpha, va.y + 1.0, va.z + (vb.z - va.z) * alpha) : new Vector3();
      this.kcYaw += dt * 0.35;
      const want = new Vector3(Math.sin(this.kcYaw) * 4.2, 1.6, Math.cos(this.kcYaw) * 4.2);
      const hit = this.match.world.collision.raycast(c, want.clone().normalize(), want.length());
      const dist = hit ? Math.max(1.2, hit.t - 0.3) : want.length();
      cam.position.copy(c).addScaledVector(want.normalize(), dist);
      cam.lookAt(c);
      cam.fov = baseV; cam.updateProjectionMatrix();
      this.r.showViewModel = false;
    }
    void lookDelta;
  }

  private driveViewModel(dt: number, f: AgentFrame, yaw: number, s: ViewSettings) {
    const vm = this.r.viewModel;
    const killer = this.match.getAgent(f.id);
    if (killer) vm.setArms(killer.look[f.team].primary, '#25272a');
    vm.leftHanded = s.leftHanded;
    vm.camera.fov = s.viewmodelFov; vm.camera.updateProjectionMatrix();
    vm.setAim(0, 0);
    vm.setItem(f.held);
    vm.update({
      dt, speed: f.speed, maxSpeed: f.maxSpeed, onGround: f.onGround, crouch: f.duck, lookDX: 0, lookDY: 0,
      prone: f.prone, slidePose: f.slide,
      ads: f.ads, scoped: f.scoped, reload: f.reload, draw: 1, planting: f.planting, defusing: false, throwPrimed: false,
      lateralSpeed: f.right, forwardSpeed: f.fwd, verticalSpeed: f.vy, busy: true,
    });
    void yaw;
  }

  private lightChar(e: CharEntry, p: Vector3, dt: number) {
    if (!this.r.baked) return;
    // baked light-probe lighting: characters darken in shadow and catch muzzle flashes
    this.r.baked.probe(p.x, p.y + 1.1, p.z, this.probeTmp);
    const k = 1 - Math.exp(-dt * 8), boost = e.firing * 0.5;
    e.light.r += (Math.min(2.4, this.probeTmp.r + boost) - e.light.r) * k;
    e.light.g += (Math.min(2.4, this.probeTmp.g + boost * 0.85) - e.light.g) * k;
    e.light.b += (Math.min(2.4, this.probeTmp.b + boost * 0.6) - e.light.b) * k;
    e.model.setLight(e.light);
  }

  private frameZombie(a: Agent, e: CharEntry, model: ZombieModel, alpha: number, dt: number, now: number) {
    const zs = a.zombie!;
    const vis = zs.active && (a.alive || now < zs.freeAt);
    model.root.visible = vis;
    e.xray.visible = false;
    if (!vis) { e.shadow.visible = false; return; }
    if (e.gen !== zs.gen) {
      e.gen = zs.gen; e.prev.copy(a.pos); e.cur.copy(a.pos); e.lastMode = zs.mode; e.strikeAt = -10; e.hitAt = -10;
      model.setKind(zs.kind, a.id * 3 + zs.gen);
    }
    if (e.lastMode !== zs.mode) { if (e.lastMode === 'attack' || e.lastMode === 'slam') e.strikeAt = now; e.lastMode = zs.mode; }
    const p = new Vector3().lerpVectors(e.prev, e.cur, alpha);
    model.root.position.copy(p);
    model.root.rotation.y = !a.alive ? Math.atan2(a.deathDir.x, a.deathDir.z) : zs.kind === 'crawler' ? a.motor.bodyYaw : a.yaw;
    model.update({
      speed: a.alive ? a.speed2D : 0, gait: zs.gait, mode: zs.mode, modeT: now - zs.modeAt, modeDur: zs.modeUntil - zs.modeAt, strikeT: now - e.strikeAt, arm: zs.arm,
      rise: zs.mode === 'rise' && a.alive ? clamp((now - zs.modeAt) / Math.max(0.1, zs.modeUntil - zs.modeAt), 0, 1) : 1,
      enraged: now < zs.enragedUntil, headless: zs.headless, helmet: zs.helmet > 0, vest: zs.vest > 0,
      dead: !a.alive, deathT: now - a.deathTime, deathVariant: (a.id * 7 + Math.floor(a.deathTime * 13)) % 4, hitT: now - e.hitAt, dt, time: now,
    });
    this.lightChar(e, p, dt);
    this.placeShadow(e, p, a.alive, 0, zs.kind === 'crawler' ? 1 : 0, a.scaleW);
    if (zs.mode === 'rise' && a.alive) e.shadow.visible = false;
  }

  /** Soft contact shadow under a character (baked lighting has no dynamic shadows). */
  private placeShadow(e: CharEntry, p: Vector3, alive: boolean, duck: number, prone = 0, scale = 1) {
    e.shadow.visible = !!this.r.baked;
    if (!e.shadow.visible) return;
    const ground = this.match.world.collision.groundHeight(p.x, p.z, p.y + 0.3);
    const lift = Math.max(0, p.y - ground);
    e.shadow.position.set(p.x, ground + 0.015, p.z);
    const size = (alive ? 1.05 + duck * 0.15 : 1.9) * (1 + lift * 0.25) * scale;
    e.shadow.scale.set(alive ? size * (1 - prone * 0.3) : size * 0.7, 1, size * (1 + prone * 0.9));
    e.shadow.rotation.y = e.model.root.rotation.y;
    (e.shadow.material as MeshBasicMaterial).opacity = 0.8;
    e.shadow.visible = lift < 3;
  }

  private spawnUav(duration: number) {
    const g = deviceModel('uav');
    g.scale.setScalar(1.4);
    this.root.add(g);
    this.uavs.push({ g, until: this.match.time + duration, phase: Math.random() * Math.PI * 2, r: 70 + Math.random() * 20 });
  }

  private shotModel(s: Shot): Group {
    const g = new Group();
    if (s.kind === 'rocket') {
      const body = new Mesh(new CylinderGeometry(0.045, 0.045, 0.55, 10), new MeshStandardMaterial({ color: '#4a5038', roughness: 0.7 }));
      body.rotation.x = Math.PI / 2; g.add(body);
      const nose = new Mesh(new ConeGeometry(0.05, 0.22, 10), body.material); nose.rotation.x = -Math.PI / 2; nose.position.z = -0.38; g.add(nose);
      const flame = new Mesh(new ConeGeometry(0.06, 0.4, 8), new MeshBasicMaterial({ color: '#ffc060', transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));
      flame.rotation.x = -Math.PI / 2; flame.position.z = 0.48; g.add(flame);
    } else if (s.kind === 'grenade') {
      const shell = new Mesh(new CylinderGeometry(0.02, 0.02, 0.07, 10), new MeshStandardMaterial({ color: '#6a7040', roughness: 0.5, metalness: 0.4 }));
      shell.rotation.x = Math.PI / 2; g.add(shell);
      const tip = new Mesh(new SphereGeometry(0.02, 10, 6), new MeshStandardMaterial({ color: '#c8b040', roughness: 0.4, metalness: 0.6 })); tip.position.z = -0.035; g.add(tip);
    } else if (s.kind === 'knife') {
      const k = grenadeModel('tknife');
      g.add(k);
    } else if (s.kind === 'plasma') {
      const core = new Mesh(new SphereGeometry(0.07, 12, 10), new MeshBasicMaterial({ color: '#d8ffb0', toneMapped: false }));
      g.add(core);
      const halo = new Mesh(new SphereGeometry(0.2, 14, 10), new MeshBasicMaterial({ color: '#6aff3a', transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.scale.set(1, 1, 2.2);
      g.add(halo);
    } else {
      const dart = new Mesh(new CylinderGeometry(0.008, 0.008, 0.12, 6), new MeshBasicMaterial({ color: '#60ff9a' }));
      dart.rotation.x = Math.PI / 2; g.add(dart);
      const glow = new Mesh(new SphereGeometry(0.03, 8, 6), new MeshBasicMaterial({ color: '#40ff80', transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false }));
      g.add(glow);
    }
    return g;
  }

  /** Camera shake for anything near the viewer (used by the Zombies view too). */
  shakeAt(pos: Vector3, amt: number, radius: number) { this.addShake(pos, amt, radius); }

  private addShake(pos: Vector3, amt: number, radius: number) {
    const d = pos.distanceTo(this.r.camera.position);
    if (d < radius) this.shake = Math.max(this.shake, amt * (1 - d / radius));
  }

  /** Call right before each simulation tick (stores interpolation sources). */
  beforeStep() {
    for (const a of this.match.agents) {
      const e = this.chars.get(a.id);
      if (e) e.prev.copy(a.pos);
    }
    if (this.viewAgent) {
      this.viewAgent.eyePos(this.prevEye);
      this.prevFeetY = this.viewAgent.pos.y;
      this.prevGround = this.viewAgent.motor.onGround;
    }
  }
  afterStep() {
    for (const a of this.match.agents) {
      const e = this.chars.get(a.id);
      if (e) e.cur.copy(a.pos);
    }
    if (!this.zombies) this.recorder.capture(this.match, (a) => this.heldKey(a), (a) => {
      const w = a.activeWeapon();
      return w?.def.scope && a.wpn.scope > 0 ? w.def.scope.zooms[a.wpn.scope - 1] : a.wpn.ads ? w?.def.ads?.zoom ?? 1.18 : 1;
    });
    if (this.viewAgent) {
      const a = this.viewAgent;
      a.eyePos(this.curEye);
      const rise = a.pos.y - this.prevFeetY;
      if (this.prevGround && a.motor.onGround && Math.abs(rise) > 0.02 && Math.abs(rise) <= MOVE.stepHeight + 0.01) {
        this.stairs.step(rise);
      } else this.stairs.step();
      if (this.prevEye.distanceToSquared(this.curEye) > 4) {
        this.prevEye.copy(this.curEye); this.stairs.reset();
      }
    }
  }

  /** Render-frame update. alpha = interpolation factor between last two sim ticks. */
  frame(dt: number, alpha: number, look: { yaw: number; pitch: number }, lookDelta: { dx: number; dy: number }) {
    this.stepAlpha = alpha;
    const m = this.match, now = m.time;
    const view = this.viewAgent;
    const firstPerson = !!view && view.alive && !this.freeCam && view.operating === null;
    const viewerTeam = m.player?.team ?? view?.team ?? null;
    // steering a cruise missile: enemies glow white-hot through the roof
    const thermal = view?.operating != null && m.gadgets.get(view.operating)?.kind === 'missile';

    const kc = this.killcam;
    // characters
    if (!kc) for (const a of m.agents) {
      const e = this.chars.get(a.id)!;
      if (e.model instanceof ZombieModel) { this.frameZombie(a, e, e.model, alpha, dt, now); continue; }
      const hide = firstPerson && a === view;
      e.model.root.visible = !hide && (a.alive || now - a.deathTime < 30);
      if (!e.model.root.visible) { e.xray.visible = false; e.shadow.visible = false; continue; }
      e.model.setLook(a.look[a.team]);
      e.model.setHeld(a.alive ? this.heldKey(a) : '');
      const p = new Vector3().lerpVectors(e.prev, e.cur, alpha);
      e.model.root.position.copy(p);
      e.model.root.rotation.y = a.motor.prone > 0 ? a.motor.bodyYaw : a.alive ? a.yaw : Math.atan2(a.deathDir.x, a.deathDir.z);
      e.firing = damp(e.firing, 0, 18, dt);
      e.model.update({
        speed: a.speed2D, maxSpeed: a.maxSpeed(), crouch: a.motor.duck, pitch: a.pitch, lean: a.lean, onGround: a.motor.onGround,
        prone: a.motor.prone, slide: a.motor.slidePose, aimYaw: wrapAngle(a.yaw - a.motor.bodyYaw),
        dead: !a.alive, deathT: now - a.deathTime, firing: e.firing, planting: a.isPlanting || a.isDefusing, dt,
        deathVariant: a.killedBy >= 0 ? (a.id * 7 + Math.floor(a.deathTime * 13)) % 4 : 1, hitT: now - e.hitAt, throwT: now - e.throwAt,
        forward: -a.vel.x * Math.sin(a.yaw) - a.vel.z * Math.cos(a.yaw),
        right: a.vel.x * Math.cos(a.yaw) - a.vel.z * Math.sin(a.yaw),
        reload: a.wpn.reloadUntil > now && a.activeWeapon() ? 1 - (a.wpn.reloadUntil - now) / a.activeWeapon()!.def.reloadTime : 0,
      });
      this.lightChar(e, p, dt);
      this.placeShadow(e, p, a.alive, a.motor.duck, a.motor.prone);
      e.xray.visible = a.alive && viewerTeam !== null && a.team !== viewerTeam && (a.revealedUntil > now || thermal);
      if (e.xray.visible) ((e.xray.children[0] as Mesh).material as MeshBasicMaterial).color.set(thermal ? 0xffffff : 0xff3030);
      if (e.xray.visible) {
        e.xray.position.copy(p);
        a.hitboxes().forEach((box, i) => {
          const mesh = e.xray.children[i];
          mesh.position.set((box.minX + box.maxX) / 2 - a.pos.x, (box.minY + box.maxY) / 2 - a.pos.y, (box.minZ + box.maxZ) / 2 - a.pos.z);
          mesh.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
        });
      }
    }

    for (const g of this.items.values()) g.visible = !kc;
    for (const g of this.projectiles.values()) g.visible = !kc;
    for (const g of this.shots.values()) g.visible = !kc;
    // thrown knives lying around
    const kl = new Set(m.ordnance.knives.map((k) => k.id));
    for (const [id, g] of this.knives) if (!kl.has(id)) { releaseModel(g); this.knives.delete(id); }
    for (const k of m.ordnance.knives) {
      if (this.knives.has(k.id)) continue;
      const g = new Group(), kn = grenadeModel('tknife');
      if (k.stuck) { g.add(kn); g.position.copy(k.pos); g.lookAt(k.pos.x - k.dir.x, k.pos.y - k.dir.y, k.pos.z - k.dir.z); }
      else { kn.rotation.set(Math.PI / 2, 0, 0); g.add(kn); g.position.copy(k.pos); g.rotation.y = Math.atan2(k.dir.x, k.dir.z); }
      this.root.add(g); this.knives.set(k.id, g);
    }
    // dropped weapons
    const live = new Set(m.items.map((i) => i.id));
    for (const [id, g] of this.items) if (!live.has(id)) { releaseModel(g); this.items.delete(id); }
    for (const it of m.items) {
      let g = this.items.get(it.id);
      if (!g) {
        g = new Group();
        const w = weaponModel(it.weapon.def.id);
        w.rotation.set(0, 0, Math.PI / 2);
        g.add(w);
        this.root.add(g);
        this.items.set(it.id, g);
        g.rotation.y = it.yaw;
      }
      g.position.copy(it.pos);
      g.visible = !kc;
    }
    // projectiles
    const pl = new Set(m.utility.projectiles.map((p) => p.id));
    for (const d of [...m.utility.decoys, ...m.utility.pulses]) pl.add(-d.id);
    for (const [id, g] of this.projectiles) if (!pl.has(id)) { releaseModel(g); this.projectiles.delete(id); }
    for (const p of m.utility.projectiles) {
      let g = this.projectiles.get(p.id);
      if (!g) { g = grenadeModel(p.kind); this.root.add(g); this.projectiles.set(p.id, g); }
      g.position.copy(p.pos);
      g.rotation.x += p.vel.length() * dt * 2;
    }
    for (const d of m.utility.decoys) {
      if (!this.projectiles.has(-d.id)) { const g = grenadeModel('decoy'); this.root.add(g); this.projectiles.set(-d.id, g); g.position.copy(d.pos); }
    }
    for (const p of m.utility.pulses) {
      if (!this.projectiles.has(-p.id)) { const g = grenadeModel('pulse'); this.root.add(g); this.projectiles.set(-p.id, g); g.position.copy(p.pos); }
    }
    // launcher shells, rockets and stim darts
    const sl = new Set(m.ordnance.shots.map((s) => s.id));
    for (const [id, g] of this.shots) if (!sl.has(id)) { releaseModel(g); this.shots.delete(id); }
    this.trailT -= dt;
    const trail = this.trailT <= 0;
    if (trail) this.trailT = 1 / 45;
    for (const s of m.ordnance.shots) {
      let g = this.shots.get(s.id);
      if (!g) { g = this.shotModel(s); this.root.add(g); this.shots.set(s.id, g); }
      g.position.copy(s.pos);
      g.visible = !kc;
      if (s.vel.lengthSq() > 0.01) g.lookAt(s.pos.x - s.vel.x, s.pos.y - s.vel.y, s.pos.z - s.vel.z);
      if (s.kind === 'knife') g.rotateX(-now * 28); // tumbling throw
      if (s.kind === 'rocket' && trail) { this.r.effects.rocketTrail(s.pos.clone().addScaledVector(s.vel, -0.012)); if (Math.random() < 0.3) sfx.rocketLoop(s.pos); }
      if (s.kind === 'plasma' && trail) this.r.effects.glow({ pos: s.pos.clone(), count: 2, speed: 0.6, life: [0.08, 0.22], size: [0.22, 0.04], color: '#8aff5a' });
    }
    // UAV flyovers
    for (let i = this.uavs.length - 1; i >= 0; i--) {
      const u = this.uavs[i];
      if (now > u.until + 4 || m.phase === 'freeze') { releaseModel(u.g); this.uavs.splice(i, 1); continue; }
      const t = now * 0.09 + u.phase;
      u.g.position.set(Math.cos(t) * u.r, 75, Math.sin(t) * u.r * 0.7);
      u.g.rotation.set(0, -t, 0.25);
    }
    // bomb
    const b = m.bomb;
    this.bomb.visible = b.state === 'dropped' || b.state === 'planted' || b.state === 'defused';
    if (this.bomb.visible) {
      this.bomb.position.copy(b.pos);
      if (b.state === 'dropped') this.bomb.position.y -= 0.02;
      if (this.bombLed) {
        this.bombLed.userData.blink = Math.max(0, (this.bombLed.userData.blink ?? 0) - dt);
        this.bombLed.visible = b.state === 'planted' && this.bombLed.userData.blink > 0;
      }
    }

    // gadgets
    this.syncDevices(dt);
    this.syncGhost();
    this.syncWeaponBeams(!!kc);

    // utility visuals
    this.r.effects.sync(
      m.utility.smokes.map((s) => ({ id: s.id, pos: s.pos, radius: m.utility.smokeRadius(s, now) })),
      m.utility.fires.map((f) => ({ id: f.id, pos: f.pos, radius: 3.2 * clamp((now - f.start) / 0.6, 0.3, 1) })),
    );

    // camera
    if (kc) { this.aimNdc.set(0, 0); this.frameKillcam(dt, kc, lookDelta); }
    else this.updateCamera(dt, look, lookDelta);
    this.syncPaperDoll(dt, look, firstPerson && !kc);
    // grenade arc for the local player while a throw is held ready
    this.throwPreview.update(m, firstPerson && !kc && view === m.player ? view : null, this.settings().grenadePreview ?? true, this.r.camera.position, dt, look);
    if (!kc) {
      // dust trailing off anyone sliding
      for (const a of m.agents) if (a.alive && a.sliding && Math.random() < dt * 24) this.r.effects.footDust(_dust.set(a.pos.x, a.pos.y + 0.05, a.pos.z), 0.4);
      // the gun coming up to the eye and going back down
      const aiming = firstPerson && !!view && view.wpn.ads;
      if (aiming !== this.adsWas) { this.adsWas = aiming; if (firstPerson) sfx.aim(aiming); }
    }
    // room tone: a tall factory hall rings, an office is tighter, the yard is nearly dry
    this.roomT -= dt;
    if (this.roomT <= 0) {
      this.roomT = 0.4;
      const cp = this.r.camera.position, floor = m.world.floorAt(cp.x, cp.z);
      sfx.setRoom(!floor || floor.ceiling === null || cp.y > floor.ceiling ? 0.12 : clamp(0.4 + floor.ceiling / 12, 0.5, 1));
    }
    this.pings = this.pings.filter((p) => p.until > now);
    this.r.effects.update(dt, this.r.camera, this.r.height, this.r.camera.fov, kc ? kc.time : now);
    const fwd = this.r.camera.getWorldDirection(new Vector3());
    sfx.setListener(this.r.camera.position, fwd);
    void look;
  }

  private syncDevices(dt: number) {
    const g = this.match.gadgets, now = this.match.time;
    const operated = this.viewAgent?.operating ?? null;
    const live = new Set(g.devices.map((d) => d.id));
    for (const thrown of g.thrown) live.add(-100000 - thrown.id);
    for (const [id, m] of this.devices) if (!live.has(id)) { releaseModel(m); this.devices.delete(id); }
    for (const [id, l] of this.lasers) if (!live.has(id)) { this.root.remove(l); l.geometry.dispose(); this.lasers.delete(id); }
    for (const d of g.devices) {
      let m = this.devices.get(d.id);
      if (!m) { m = deviceModel(d.kind, d.size); this.root.add(m); this.devices.set(d.id, m); }
      m.visible = d.id !== operated;
      m.position.copy(d.pos);
      if (d.kind === 'missile') {
        m.rotation.set(d.pitch, d.yaw, 0, 'YXZ');
        const flame = m.getObjectByName('flame');
        if (flame) flame.scale.set(1, 1, (d.boost ? 1.8 : 1) * (0.85 + Math.random() * 0.3));
        if (Math.random() < 0.5) this.r.effects.rocketTrail(d.pos.clone().addScaledVector(d.vel, -0.03));
      } else if (d.kind === 'hunter') {
        m.rotation.y = d.yaw;
        m.position.y += Math.sin(now * 3 + d.id) * 0.04;
        m.traverse((o) => { if (o.name === 'rotor') o.rotation.y += dt * 60; });
      } else if ((d.kind === 'barricade' || d.kind === 'steelBarricade')) {
        m.rotation.y = d.yaw;
        // boards work loose as the barricade takes damage
        const max = GADGETS[d.kind as GadgetId].health ?? 100;
        const dmg = 1 - Math.max(0, d.health) / max;
        m.traverse((o) => { if (o.name.startsWith('plank')) { const i = +o.name.slice(5); o.rotation.z = (o.userData.baseRot ?? 0) + dmg * (i % 2 ? 0.22 : -0.18); o.position.z = (i % 2) * 0.03 - 0.015 - dmg * 0.04 * (i % 3); } });
      } else if ((d.kind === 'stickyCam' || d.kind === 'c4') && d.normal) {
        m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normal);
        m.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), d.normal.y > 0.7 ? d.yaw : 0));
      } else if (d.kind === 'flockCam') {
        m.rotation.y = d.baseYaw;
        const head = m.getObjectByName('head');
        if (head) { head.rotation.y = d.yaw - d.baseYaw; head.rotation.x = d.pitch; }
      } else if (d.kind === 'cctv') {
        m.rotation.set(d.pitch, d.yaw, 0, 'YXZ');
      } else m.rotation.y = d.yaw;
      const led = m.getObjectByName('led');
      if (led) led.visible = d.jammedUntil > now ? false : d.kind === 'mine' ? d.armed && (Math.floor(now * (d.triggeredAt >= 0 ? 12 : 1.5)) % 2 === 0) : Math.floor(now * 1.2 + d.id) % 2 === 0;
      if (d.kind === 'mine' && d.armed) {
        let l = this.lasers.get(d.id);
        if (!l) { l = new Line(new BufferGeometry(), this.laserMat); l.frustumCulled = false; this.root.add(l); this.lasers.set(d.id, l); }
        l.geometry.setFromPoints(g.laser(d));
      }
    }
    // thrown gadgets in flight
    for (const t of g.thrown) {
      const key = -100000 - t.id;
      let m = this.devices.get(key);
      if (!m) { m = deviceModel(t.kind); this.root.add(m); this.devices.set(key, m); }
      m.position.copy(t.pos);
      m.rotation.x += dt * 8;
    }
    for (const d of g.devices) if (d.kind === 'hunter' && Math.random() < dt * 8) sfx.droneHum(d.pos);
    // operated drone hum
    const od = g.get(operated);
    if (od?.kind === 'missile') { this.missileWindT -= dt; if (this.missileWindT <= 0) { this.missileWindT = 0.25; sfx.missileWind(); } }
    if (od?.kind === 'drone' && od.vel.lengthSq() > 0.5) { this.humT -= dt; if (this.humT <= 0) { this.humT = 0.12; sfx.droneHum(null); } }
  }

  /** Translucent preview of where a barricade you're holding will go (green = OK, red = blocked). */
  private syncGhost() {
    const a = this.match.player;
    const kind = a && a.alive && a.operating === null && a.active === 'gadget' && (a.activeGadget === 'barricade' || a.activeGadget === 'steelBarricade') ? a.activeGadget : null;
    const t = kind ? this.match.gadgets.barricadeTarget(a!, kind, a!.eyePos(new Vector3()), a!.viewDir(new Vector3())) : null;
    const key = t ? `${kind}:${t.door}` : '';
    if (key !== this.ghostKey) {
      if (this.ghost) {
        releaseModel(this.ghost);
        this.ghost = null;
      }
      this.ghostKey = key;
      if (t && kind) {
        const g = deviceModel(kind, { w: t.f.w, h: t.f.h });
        const mat = new MeshBasicMaterial({ color: 0x60ff90, transparent: true, opacity: 0.28, depthWrite: false });
        g.traverse((o) => { if ((o as Mesh).isMesh) (o as Mesh).material = mat; });
        g.position.set(t.f.cx, 0, t.f.cz);
        g.rotation.y = t.f.alongX ? 0 : Math.PI / 2;
        this.root.add(g);
        this.ghost = g;
      }
    }
    if (this.ghost && t) {
      const m = (this.ghost.children.find((c) => (c as Mesh).isMesh) as Mesh | undefined)?.material as MeshBasicMaterial | undefined;
      m?.color.set(t.blocked ? 0xff5040 : 0x60ff90);
      if (m) m.opacity = 0.22 + 0.08 * Math.sin(this.match.time * 6);
    }
  }

  /** Laser beams (1 mW: only you see it; 5 mW: everyone) and weapon-light cones. */
  private syncWeaponBeams(replay: boolean) {
    const m = this.match, view = this.viewAgent;
    const local = view && view.alive && !this.freeCam && view.operating === null ? view : null;
    const seen = new Set<number>();
    this.glare = null;
    for (const a of m.agents) {
      const w = a.alive && a.operating === null && !replay ? a.activeWeapon() : null;
      const mods = w?.def.mods;
      const laser = mods?.laser && (mods.laser === 'green' || a === local) ? mods.laser : null;
      const light = !!(mods?.light && a.lightOn);
      if (!laser && !light) continue;
      seen.add(a.id);
      let b = this.beams.get(a.id);
      if (!b) {
        const line = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0, -1)]), this.beamMats.red);
        line.frustumCulled = false;
        const dot = new Mesh(new SphereGeometry(0.018, 8, 6), new MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));
        const cone = new Mesh(new ConeGeometry(1.4, 8, 20, 1, true).translate(0, -4, 0).rotateX(-Math.PI / 2),
          new MeshBasicMaterial({ color: 0xfff4d8, transparent: true, opacity: 0.11, blending: AdditiveBlending, depthWrite: false, side: 2 }));
        const flare = new Mesh(new SphereGeometry(0.07, 12, 10), new MeshBasicMaterial({ color: 0xfffbe8, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));
        this.root.add(line, dot, cone, flare);
        b = { line, dot, cone, flare };
        this.beams.set(a.id, b);
      }
      const eye = a === local ? this.r.camera.position.clone() : a.eyePos(new Vector3());
      const dir = a === local ? this.r.camera.getWorldDirection(new Vector3()) : a.viewDir(new Vector3());
      // where the beam leaves the gun
      let start: Vector3;
      if (a === local) { start = this.r.viewModel.muzzleCamSpace(new Vector3()); this.r.camera.localToWorld(start); }
      else {
        const right = new Vector3(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
        start = eye.clone().addScaledVector(dir, 0.55).addScaledVector(right, 0.18).add(new Vector3(0, -0.22, 0));
      }
      const hit = m.world.collision.raycast(eye, dir, 60);
      const end = hit ? hit.point.clone().addScaledVector(hit.normal, 0.01) : eye.clone().addScaledVector(dir, 60);
      b.line.visible = !!laser; b.dot.visible = !!laser;
      if (laser) {
        b.line.material = this.beamMats[laser];
        b.line.geometry.setFromPoints([start, end]);
        b.dot.position.copy(end);
        (b.dot.material as MeshBasicMaterial).color.set(laser === 'green' ? 0x50ff70 : 0xff3030);
      }
      // light: a soft cone for others, a flare at the lens; the HUD brightens your own view
      b.cone.visible = light && a !== local; b.flare.visible = light && a !== local;
      if (light && a !== local) {
        b.cone.position.copy(start); b.flare.position.copy(start);
        b.cone.lookAt(start.clone().add(dir));
        if (local && a.team !== local.team) {
          const amt = local.dazzleAt(m.time);
          if (amt > 0) {
            const s = start.clone().project(this.r.camera);
            if (s.z < 1) this.glare = { x: (s.x * 0.5 + 0.5) * window.innerWidth, y: (-s.y * 0.5 + 0.5) * window.innerHeight, strength: amt };
          }
        }
      }
    }
    for (const [id, b] of this.beams) if (!seen.has(id)) { b.line.visible = b.dot.visible = b.cone.visible = b.flare.visible = false; }
  }

  /** How far the view model's gun is raised to the eye (0 hip … 1 sights aligned). */
  get adsBlend(): number { return this.r.viewModel.adsBlend; }

  zoomFactor(): number {
    const a = this.viewAgent;
    if (!a || !a.alive) return 1;
    const w = a.activeWeapon();
    if (w?.def.scope && a.wpn.scope > 0) return w.def.scope.zooms[a.wpn.scope - 1];
    if (a.wpn.ads) return w?.def.ads?.zoom ?? 1.18;
    return 1;
  }

  private updateCamera(dt: number, look: { yaw: number; pitch: number }, lookDelta: { dx: number; dy: number }) {
    const cam = this.r.camera;
    const s = this.settings();
    const a = this.viewAgent;
    this.shake = damp(this.shake, 0, 5, dt);
    const landDip = this.landing.update(dt) * 2.5;
    const stepOffset = this.stairs.update(dt, this.stepAlpha);
    this.aimNdc.set(0, 0);
    const baseV = verticalFov(s.fov);
    if (this.freeCam || !a) {
      const f = this.freeCam ?? { pos: new Vector3(0, 30, 60), yaw: 0, pitch: -0.5 };
      cam.position.copy(f.pos);
      cam.rotation.set(f.pitch, f.yaw, 0, 'YXZ');
      cam.fov = baseV; cam.updateProjectionMatrix();
      this.r.showViewModel = false;
      return;
    }
    const feed = a.alive ? this.match.gadgets.get(a.operating) : null;
    if (feed) {
      this.match.gadgets.eye(feed, cam.position);
      cam.rotation.set(feed.pitch + (Math.random() - 0.5) * this.shake * 0.05, feed.yaw, 0, 'YXZ');
      cam.fov = feed.kind === 'drone' ? 80 : feed.kind === 'missile' ? (feed.boost ? 62 : 54) : 72;
      cam.near = 0.02;
      cam.updateProjectionMatrix();
      this.r.showViewModel = false;
      return;
    }
    cam.near = 0.05;
    if (!a.alive) {
      // Death cam: drift up and back from where you fell and turn to face your killer.
      const t = Math.min(1, (this.match.time - a.deathTime) / 1.2);
      const ease = t * t * (3 - 2 * t);
      const killer = this.match.getAgent(a.killedBy);
      const from = new Vector3(a.pos.x, a.pos.y + 1.0 + ease * 0.9, a.pos.z);
      let wantYaw = a.yaw, wantPitch = -0.35;
      if (killer) {
        const k = killer.centerPos(new Vector3());
        wantYaw = Math.atan2(-(k.x - from.x), -(k.z - from.z));
        wantPitch = Math.atan2(k.y - from.y, Math.max(0.5, Math.hypot(k.x - from.x, k.z - from.z)));
        from.x -= Math.sin(wantYaw) * -ease * 0.8; from.z -= Math.cos(wantYaw) * -ease * 0.8;
      }
      // The drift must not carry the camera through a wall or ceiling next to where you fell.
      const body = new Vector3(a.pos.x, a.pos.y + 1.0, a.pos.z), drift = from.clone().sub(body), far = drift.length();
      if (far > 0.01) {
        const wall = this.match.world.collision.raycast(body, drift.divideScalar(far), far + 0.3);
        if (wall) from.copy(body).addScaledVector(drift, Math.max(0, wall.t - 0.3));
      }
      if (this.deathCamYaw === null) { this.deathCamYaw = a.yaw; this.deathCamPitch = a.pitch; }
      const k2 = 1 - Math.exp(-dt * 4);
      this.deathCamYaw += Math.atan2(Math.sin(wantYaw - this.deathCamYaw), Math.cos(wantYaw - this.deathCamYaw)) * k2;
      this.deathCamPitch += (wantPitch - this.deathCamPitch) * k2;
      cam.position.copy(from);
      cam.rotation.set(this.deathCamPitch, this.deathCamYaw, 0.12 * (1 - ease), 'YXZ');
      cam.fov = damp(cam.fov, baseV, 6, dt); cam.updateProjectionMatrix();
      this.r.showViewModel = false;
      return;
    }
    const isLocal = a === this.match.player && a.alive;
    const eye = new Vector3().lerpVectors(this.prevEye, this.curEye, this.stepAlpha);
    if (isLocal) {
      // use the live (unsmoothed) lean so the camera responds immediately
      eye.y += stepOffset - landDip;
    }
    const yaw = isLocal ? look.yaw : a.yaw;
    const pitch = isLocal ? look.pitch : a.pitch;
    this.punchPitch = damp(this.punchPitch, a.aimPunchPitch, 38, dt);
    this.punchYaw = damp(this.punchYaw, a.aimPunchYaw, 38, dt);
    // weapon recoil shows partially (CS view punch); being shot kicks the view fully
    const punchP = (this.punchPitch * VIEW_PUNCH_FRACTION + a.flinchPitch) * DEG;
    const punchY = (this.punchYaw * VIEW_PUNCH_FRACTION + a.flinchYaw) * DEG;
    const sh = this.shake;
    const now0 = this.match.time;
    const stun = a.stunAt(now0);
    const mantle = a.motor.mantle ? Math.min(1, a.motor.mantle.t / a.motor.mantle.dur) : 0;
    const wob = performance.now() / 1000;
    const camPitch = pitch + punchP + Math.sin(wob * 1.9) * 0.035 * stun - Math.sin(Math.PI * mantle) * 0.12;
    const camYaw = yaw + punchY + Math.sin(wob * 1.3) * 0.045 * stun;
    const roll = -a.lean * MOVE.leanRollDeg * DEG * (1 - a.motor.prone) * (1 - a.motor.slidePose) + Math.sin(wob * 1.1) * 0.06 * stun + Math.sin(Math.PI * mantle) * 0.05;
    cam.position.copy(eye);
    cam.rotation.set(camPitch + (Math.random() - 0.5) * sh * 0.05, camYaw + (Math.random() - 0.5) * sh * 0.05, roll, 'YXZ');
    const zoom = this.zoomFactor();
    const targetFov = 2 * Math.atan(Math.tan((baseV * DEG) / 2) / zoom) / DEG;
    cam.fov = zoom > 1.5 ? targetFov : damp(cam.fov, targetFov, 18, dt);
    cam.updateProjectionMatrix();
    // Where the next shot goes (view angles + full recoil punch + flinch), seen through the camera
    // without its random shake (pure noise the bullets don't share). Only the camera smooths
    // punch; sights use the full current punch so they never lag behind the actual next shot.
    dirFromAngles(yaw + (a.aimPunchYaw + a.flinchYaw) * DEG, pitch + (a.aimPunchPitch + a.flinchPitch) * DEG, this.aimDir)
      .applyQuaternion(this.aimQ.setFromEuler(this.aimEuler.set(camPitch, camYaw, roll, 'YXZ')).invert());
    if (this.aimDir.z < -0.05) {
      const t = Math.tan((cam.fov * DEG) / 2);
      this.aimNdc.set(clamp(this.aimDir.x / -this.aimDir.z / (t * cam.aspect), -1, 1), clamp(this.aimDir.y / -this.aimDir.z / t, -1, 1));
    }

    // view model
    const vm = this.r.viewModel;
    if (this.r.baked) {
      this.r.baked.probe(eye.x, eye.y - 0.25, eye.z, this.probeTmp);
      const k = 1 - Math.exp(-dt * 6);
      this.vmLight.r += (this.probeTmp.r - this.vmLight.r) * k;
      this.vmLight.g += (this.probeTmp.g - this.vmLight.g) * k;
      this.vmLight.b += (this.probeTmp.b - this.vmLight.b) * k;
      vm.setLight(this.vmLight);
    }
    vm.leftHanded = s.leftHanded;
    vm.camera.fov = s.viewmodelFov;
    vm.camera.updateProjectionMatrix();
    vm.setAim(this.aimNdc.x, this.aimNdc.y);
    vm.setArms(a.look[a.team].primary, '#25272a');
    vm.setItem(this.heldKey(a));
    const w = a.activeWeapon();
    const now = this.match.time;
    const reloadP = a.wpn.reloadUntil > now && w ? 1 - (a.wpn.reloadUntil - now) / w.def.reloadTime : 0;
    const drawTotal = w ? Math.min(w.def.drawTime, 1) : 0.45;
    const drawP = a.wpn.drawUntil > now ? 1 - (a.wpn.drawUntil - now) / drawTotal : 1;
    vm.update({
      dt, speed: a.speed2D, maxSpeed: a.maxSpeed(), onGround: a.motor.onGround, crouch: a.motor.duck,
      prone: a.motor.prone, slidePose: a.motor.slidePose,
      lookDX: isLocal ? lookDelta.dx : 0, lookDY: isLocal ? lookDelta.dy : 0,
      ads: a.wpn.ads, scoped: scopedView(w?.def, a.wpn.ads, a.wpn.scope), reload: reloadP, draw: clamp(drawP, 0, 1),
      planting: a.isPlanting, defusing: a.isDefusing, throwPrimed: a.wpn.throwPrimed > 0,
      lateralSpeed: a.vel.x * Math.cos(yaw) - a.vel.z * Math.sin(yaw), verticalSpeed: a.vel.y,
      forwardSpeed: -a.vel.x * Math.sin(yaw) - a.vel.z * Math.cos(yaw),
      mantle, stun, busy: a.wpn.ads || reloadP > 0 || now - a.wpn.lastShot < 0.3 || drawP < 1,
      mag: w && w.def.class !== 'knife' ? w.mag : undefined,
    });
    this.r.showViewModel = a.alive;
  }

  /** Feed the HUD paper doll the live pose of the agent we look through (hidden when dead or on a camera feed). */
  private syncPaperDoll(dt: number, look: { yaw: number; pitch: number }, firstPerson: boolean) {
    const doll = this.r.paperDoll, s = this.settings();
    doll.mode = s.paperDoll ?? 'off';
    doll.scale = s.paperDollSize ?? 1;
    const a = this.viewAgent;
    if (doll.mode === 'off' || !a || !firstPerson) { doll.update(dt, null); return; }
    const now = this.match.time, w = a.activeWeapon(), local = a === this.match.player;
    const ground = a.motor.onGround ? a.pos.y : this.match.world.collision.groundHeight(a.pos.x, a.pos.z, a.pos.y + 0.3);
    doll.update(dt, {
      id: a.id, look: a.look[a.team], held: this.heldKey(a),
      speed: a.speed2D, maxSpeed: a.maxSpeed(),
      forward: -a.vel.x * Math.sin(a.yaw) - a.vel.z * Math.cos(a.yaw),
      right: a.vel.x * Math.cos(a.yaw) - a.vel.z * Math.sin(a.yaw),
      crouch: a.motor.duck, prone: a.motor.prone, slide: a.motor.slidePose, onGround: a.motor.onGround, lift: Math.max(0, a.pos.y - ground),
      yaw: local ? look.yaw : a.yaw, pitch: local ? look.pitch : a.pitch, aimYaw: wrapAngle(a.yaw - a.motor.bodyYaw), lean: a.lean,
      reload: a.wpn.reloadUntil > now && w ? 1 - (a.wpn.reloadUntil - now) / w.def.reloadTime : 0,
      planting: a.isPlanting || a.isDefusing, ads: a.wpn.ads, mantling: !!a.motor.mantle,
    });
  }

  smokeDensity(): number { return this.r.effects.smokeDensityAt(this.r.camera.position); }

  dispose() {
    for (const u of this.unsub) u();
    for (const entry of this.chars.values()) { entry.model.dispose(); releaseModel(entry.xray); }
    for (const models of [this.items, this.projectiles, this.shots, this.knives, this.devices]) {
      for (const model of models.values()) releaseModel(model);
      models.clear();
    }
    for (const u of this.uavs) releaseModel(u.g);
    for (const laser of this.lasers.values()) laser.geometry.dispose();
    this.laserMat.dispose();
    for (const beam of this.beams.values()) {
      beam.line.geometry.dispose(); releaseModel(beam.dot); releaseModel(beam.cone); releaseModel(beam.flare);
    }
    this.beamMats.red.dispose(); this.beamMats.green.dispose();
    if (this.ghost) releaseModel(this.ghost);
    releaseModel(this.bomb);
    this.throwPreview.dispose();
    this.recorder.clear();
    this.killcam = null;
    this.r.scene.remove(this.root);
    this.r.effects.groundAt = null;
    this.r.effects.onCasingBounce = () => {};
    sfx.occlusion = null;
    sfx.setRoom(1);
    this.r.effects.clear();
    this.r.paperDoll.reset();
  }
}
