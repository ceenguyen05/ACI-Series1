import {
  AdditiveBlending, Color, CylinderGeometry, DirectionalLight, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera,
  Scene, Sprite, SpriteMaterial, Vector3,
} from 'three';
import { WEAPONS, type WeaponId } from '../config/weapons';
import type { UtilityId } from '../config/utilities';
import { clamp, damp } from '../core/math';
import { LandingSpring, MovementCycle } from './MovementMotion';
import { bombModel, crowbarModel, grenadeModel, weaponModel } from './WeaponModels';
import { deviceModel } from './GadgetModels';
import type { GadgetId } from '../config/gadgets';
import { flareSprite, TEX } from './Textures';
import { batchModel, bevelBox, releaseModel } from './Geometry';

export interface ViewModelState {
  dt: number;
  speed: number;
  maxSpeed: number;
  onGround: boolean;
  crouch: number;
  prone?: number;
  slidePose?: number;
  lookDX: number;
  lookDY: number;
  ads: boolean;
  scoped: boolean;
  reload: number;     // 0 = not reloading, else progress 0..1
  draw: number;       // 1 = fully drawn
  planting: boolean;
  defusing: boolean;
  throwPrimed: boolean;
  lateralSpeed: number;
  forwardSpeed?: number;
  verticalSpeed: number;
  /** Mantle progress 0..1 (0 = not climbing). */
  mantle?: number;
  /** Stun grenade amount 0..1. */
  stun?: number;
  /** Busy (firing / reloading / aiming) cancels an inspect. */
  busy?: boolean;
  /** Rounds left in the held gun's magazine (an empty pistol holds its slide open). */
  mag?: number;
}

type ItemKind = 'rifle' | 'pistol' | 'knife' | 'grenade' | 'bomb' | 'none';

const FORWARD = new Vector3(0, 0, -1), aimDir = new Vector3(), pivotTmp = new Matrix4();

/**
 * Where the eye sits in a held gun's own frame when aimed: on the fitted optic's sight line, else
 * on the model's iron sights (`userData.ironY`), a little behind the grip.
 */
export function aimedEye(model: { sightY?: unknown; ironY?: unknown }, pistol: boolean, out = new Vector3()): Vector3 {
  const y = typeof model.sightY === 'number' ? model.sightY + 0.002 : typeof model.ironY === 'number' ? model.ironY : pistol ? 0.071 : 0.102;
  return out.set(0, y, pistol ? 0.36 : 0.33);
}

/** First-person arms + weapon rendered in its own scene (never clips into walls). */
export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 1, 0.01, 20);
  /** Turns the whole gun about the eye so its sights point where the next bullet goes (see setAim). */
  private aim = new Group();
  private rig = new Group();
  private holder = new Group();
  private armR = new Group();
  private armL = new Group();
  private item: Group | null = null;
  private itemKey = '';
  private kind: ItemKind = 'none';
  private muzzleLocal = new Vector3();
  private flash: Sprite;
  private flashT = 0;
  private kick = 0; private kickRot = 0;
  /** Each shot also twists the gun a little to one side, so a spray never looks like one canned bounce. */
  private kickYaw = 0; private kickRoll = 0;
  /** Slow breathing drift while the gun is at the hip. */
  private breathT = Math.random() * 10;
  /** Slide / bolt held open on an empty magazine. */
  private lockT = 0;
  private gait = new MovementCycle();
  private swayX = 0; private swayY = 0;
  private adsT = 0;
  private slashT = 1; private slashDir = 1; private stab = false;
  private throwT = 1;
  private landing = new LandingSpring();
  private moveT = 0;
  private airT = 0;
  private strafeT = 0;
  private forwardT = 0;
  private runT = 0;
  private actionT = 1;
  private suppressed = false;
  private noShells = false;
  private smallFlash = false;
  private launcher = false;
  /** Quick melee: the gun dips out of view while a knife (or crowbar) thrusts in from the right. */
  private meleeRig = new Group();
  private meleeKnife: Group;
  private meleeBar: Group;
  private meleeT = 1;
  private inspectT = 1;
  private mantleT = 0;
  private tablet = false;
  private magazine: Object3D | null = null;
  private slide: Object3D | null = null;
  private bolt: Object3D | null = null;
  private pump: Object3D | null = null;
  private cycleDuration = 0.11;
  private casings: InstancedMesh;
  private shellCursor = 0;
  private shells = Array.from({ length: 16 }, () => ({ p: new Vector3(), v: new Vector3(), r: new Vector3(), life: 0 }));
  private shellTransform = new Object3D();
  leftHanded = false;
  fovBase = 60;

  private hemi = new HemisphereLight(0xe3eaf0, 0x544b3d, 1.2);
  private key = new DirectionalLight(0xffebd2, 2.4);
  private envBase = -1;

  /** Match the weapon / arms to the baked light at the camera (1 = neutral room). */
  setLight(c: Color) {
    const lum = Math.max(0.12, Math.min(2.2, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
    const k = 0.35 + 0.75 * lum;
    this.hemi.intensity = 1.25 * k;
    this.hemi.color.setRGB(0.75 + 0.25 * c.r / lum, 0.75 + 0.25 * c.g / lum, 0.75 + 0.25 * c.b / lum);
    this.key.intensity = 2.3 * k;
    if (this.envBase < 0) this.envBase = this.scene.environmentIntensity;
    this.scene.environmentIntensity = this.envBase * (0.45 + 0.6 * lum);
  }

  constructor() {
    this.scene.add(this.hemi);
    const d = this.key;
    d.position.set(-1, 2, 1);
    this.scene.add(d);
    this.scene.add(this.camera);
    this.camera.add(this.aim);
    this.aim.add(this.rig);
    this.rig.add(this.holder, this.armL);
    this.holder.add(this.armR);
    this.meleeKnife = weaponModel('knife');
    this.meleeBar = crowbarModel();
    this.meleeRig.add(this.meleeKnife, this.meleeBar);
    this.meleeRig.visible = false;
    this.camera.add(this.meleeRig);
    this.flash = new Sprite(new SpriteMaterial({ map: flareSprite(), color: new Color('#ffd890'), blending: AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.visible = false;
    this.flash.scale.setScalar(0.18);
    this.holder.add(this.flash);
    this.casings = new InstancedMesh(new CylinderGeometry(0.004, 0.0045, 0.024, 8), new MeshStandardMaterial({ color: '#b6934c', roughness: 0.32, metalness: 0.72 }), this.shells.length);
    this.casings.frustumCulled = false;
    this.scene.add(this.casings);
    this.updateShells(0);
  }

  setArms(sleeve: string, glove: string) {
    const key = sleeve + glove;
    if (this.armR.userData.key === key) return;
    this.armR.userData.key = key;
    const oldMaterials = new Set<MeshStandardMaterial>();
    for (const arm of [this.armR, this.armL]) arm.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (object.userData.batched) object.geometry.dispose();
      if (!Array.isArray(object.material)) oldMaterials.add(object.material as MeshStandardMaterial);
    });
    for (const material of oldMaterials) material.dispose();
    this.armR.clear(); this.armL.clear();
    this.meleeRig.getObjectByName('meleeArm')?.removeFromParent();
    const sm = new MeshStandardMaterial({ color: sleeve, map: TEX.cloth().tex, roughness: 0.93 });
    const gm = new MeshStandardMaterial({ color: glove, roughness: 0.84 });
    const pad = new MeshStandardMaterial({ color: '#42483f', roughness: 0.75 });
    const mk = (g: Group, mat: MeshStandardMaterial, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
      const mesh = new Mesh(bevelBox(w, h, d, Math.min(w, h, d) * 0.35, 2), mat); mesh.position.set(x, y, z); mesh.rotation.x = rx; g.add(mesh);
    };
    const sleeveBetween = (g: Group, from: Vector3, to: Vector3) => {
      const direction = to.clone().sub(from);
      const mesh = new Mesh(new CylinderGeometry(0.031, 0.05, direction.length(), 16, 3), sm);
      mesh.position.copy(from).add(to).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()); g.add(mesh);
    };
    sleeveBetween(this.armR, new Vector3(0.11, -0.24, 0.29), new Vector3(0.015, -0.065, 0.05));
    sleeveBetween(this.armL, new Vector3(-0.2, -0.22, 0.3), new Vector3(-0.015, -0.045, 0.025));
    for (const [arm, x, z] of [[this.armR, 0, 0.025], [this.armL, -0.008, 0.005]] as const) {
      mk(arm, sm, 0.069, 0.055, 0.045, x, -0.06, z + 0.045, 0.25);
      mk(arm, gm, 0.05, 0.065, 0.063, x, -0.025, z);
      // Individual curled fingers, a thumb and dorsal padding give a recognisable grip.
      for (let i = 0; i < 4; i++) mk(arm, gm, 0.048, 0.012, 0.018, x, -0.045 + i * 0.013, z - 0.028, 0.12);
      mk(arm, gm, 0.018, 0.045, 0.025, x - 0.025, -0.006, z - 0.005, -0.5);
      mk(arm, pad, 0.035, 0.018, 0.032, x, 0.006, z + 0.004);
      batchModel(arm);
    }
    // the quick-melee hand is a copy of the right arm
    const mArm = this.armR.clone(true); mArm.name = 'meleeArm';
    this.meleeRig.add(mArm);
  }

  /** key: 'w:<id>:<finish>' | 'g:<kind>' | 'bomb' | '' */
  setItem(key: string) {
    if (key === this.itemKey) return;
    this.itemKey = key;
    if (this.item) releaseModel(this.item);
    this.item = null;
    this.kind = 'none';
    this.magazine = this.slide = this.bolt = this.pump = null;
    this.cycleDuration = 0.11;
    this.kick = this.kickRot = 0;
    this.actionT = 1;
    this.flashT = 0;
    if (!key) return;
    const [k, id, finish, att] = key.split(':');
    this.noShells = false;
    this.inspectT = 1;
    this.tablet = k === 'd' && id === 'heartbeat';
    this.launcher = id === 'hammer' || id === 'thumper';
    if (k === 'w') {
      this.item = weaponModel(id as WeaponId, finish, att ?? '');
      this.kind = id === 'knife' ? 'knife' : WEAPONS[id as WeaponId]?.class === 'pistol' ? 'pistol' : 'rifle';
      this.noShells = this.launcher || id === 'disruptor';
    } else if (k === 'g') { this.item = grenadeModel(id as UtilityId); this.kind = 'grenade'; }
    else if (k === 'd' && id === 'stim') {
      this.item = deviceModel('stim');
      this.kind = 'pistol';
      this.noShells = true;
    } else if (k === 'd' && id === 'heartbeat') {
      this.item = deviceModel('heartbeat');
      this.item.rotation.set(1.05, 0, 0); // screen tilted up toward the eyes
      this.item.scale.setScalar(1.05);
      this.kind = 'grenade';
    } else if (k === 'd') {
      this.item = deviceModel(id as GadgetId);
      const big = id === 'shield' || id === 'wire' || id === 'flockCam';
      const bulky = id === 'barricade' || id === 'steelBarricade' || id === 'ammoBox';
      this.item.scale.setScalar(big ? 0.1 : bulky ? 0.28 : id === 'drone' ? 0.42 : 1.1);
      if (bulky) this.item.rotation.set(0.2, 0.5, 0);
      this.item.userData.muzzle = this.item.userData.muzzle ?? null;
      this.kind = 'grenade';
    }
    else { this.item = bombModel(); this.kind = 'bomb'; }
    this.muzzleLocal.copy(this.item.userData.muzzle ?? new Vector3());
    this.suppressed = !!this.item.userData.suppressed;
    this.smallFlash = !!this.item.userData.smallFlash;
    this.magazine = this.item.getObjectByName('magazine') ?? null;
    this.slide = this.item.getObjectByName('slide') ?? null;
    this.bolt = this.item.getObjectByName('bolt') ?? null;
    this.pump = this.item.getObjectByName('pump') ?? null;
    this.cycleDuration = this.pump ? 0.6 : id === 'longbow' || id === 'kestrel' ? 0.65 : this.launcher ? 0.3 : 0.11;
    this.flash.position.copy(this.muzzleLocal).add(new Vector3(0, 0, -0.04));
    this.holder.add(this.item);
    // left hand placement on handguard / slide
    const lz = this.kind === 'rifle' ? -0.28 : this.kind === 'pistol' ? -0.02 : 0;
    this.armL.visible = this.kind === 'rifle' || this.kind === 'pistol' || this.kind === 'bomb' || this.tablet;
    this.armL.userData.z = lz;
    if (this.kind === 'bomb') this.item.rotation.set(-0.3, 0, 0);
  }

  onFire(kick: number) {
    this.inspectT = 1;
    this.kick = Math.min(0.065, this.kick + 0.019 * kick);
    this.kickRot = Math.min(0.23, this.kickRot + 0.045 * kick);
    this.kickYaw = clamp(this.kickYaw + (Math.random() - 0.5) * 0.03 * kick, -0.05, 0.05);
    this.kickRoll = clamp(this.kickRoll + (Math.random() - 0.5) * 0.05 * kick, -0.07, 0.07);
    this.actionT = 0;
    if (this.kind === 'rifle' || this.kind === 'pistol') {
      this.flashT = this.suppressed ? 0.014 : this.launcher ? 0.07 : this.noShells ? 0 : 0.026;
      const size = this.suppressed ? 0.035 : this.launcher ? 0.32 : (this.kind === 'pistol' ? 0.095 : 0.14) * (this.smallFlash ? 0.45 : 1);
      const sightClearance = 1 - this.adsT * 0.4;
      this.flash.scale.set(size * 0.65 * sightClearance, size * sightClearance, 1);
      this.flash.material.rotation = Math.random() * Math.PI * 2;
      if (this.noShells) return;
      const shell = this.shells[this.shellCursor++ % this.shells.length];
      this.rig.updateMatrix(); this.aim.updateMatrix();
      shell.p.set(0.035, 0.045, -0.055).applyMatrix4(this.rig.matrix).applyMatrix4(this.aim.matrix);
      shell.v.set((this.leftHanded ? -1 : 1) * (0.65 + Math.random() * 0.4), 0.45 + Math.random() * 0.45, 0.15);
      shell.r.set(0, 0, 0); shell.life = 0.65;
    }
  }
  onKnife(stab: boolean) { this.slashT = 0; this.stab = stab; this.slashDir = -this.slashDir; this.inspectT = 1; }
  /** Weapon inspect (presentation only): turn the gun to admire the finish. */
  onInspect() { if (this.kind === 'rifle' || this.kind === 'pistol' || this.kind === 'knife') this.inspectT = 0; }
  /** Quick melee: crowbar if you carry one, otherwise the knife. */
  onQuickMelee(crowbar: boolean) { this.meleeT = 0; this.meleeKnife.visible = !crowbar; this.meleeBar.visible = crowbar; }
  onThrow() { this.throwT = 0; }
  onLand(hard = false) { this.landing.kick(hard ? 1.6 : 1); }

  setAspect(a: number) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }

  /** How far the gun is raised to the eye (0 = hip, 1 = sights aligned). */
  get adsBlend() { return this.adsT; }

  /**
   * Point the gun at a screen position (NDC, 0,0 = centre): where the next bullet goes. The view
   * model has its own FOV, so the angle is converted to land on the same pixel. Aimed, the sight
   * line passes through the eye, so the front post / dot sits exactly on that point.
   */
  setAim(x: number, y: number) {
    const t = Math.tan(this.camera.fov * Math.PI / 360);
    aimDir.set(x * t * this.camera.aspect, y * t, -1).normalize();
    this.aim.quaternion.setFromUnitVectors(FORWARD, aimDir);
  }

  private updateShells(dt: number) {
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i], t = this.shellTransform;
      s.life = Math.max(0, s.life - dt);
      if (s.life > 0) {
        s.v.y -= 4.5 * dt; s.p.addScaledVector(s.v, dt);
        s.r.x += dt * 15; s.r.z += dt * 9;
        t.position.copy(s.p); t.rotation.set(s.r.x, s.r.y, s.r.z); t.scale.setScalar(1);
      } else t.scale.setScalar(0);
      t.updateMatrix(); this.casings.setMatrixAt(i, t.matrix);
    }
    this.casings.instanceMatrix.needsUpdate = true;
  }

  update(s: ViewModelState) {
    const dt = Math.min(0.05, s.dt);
    const forwardSpeed = s.forwardSpeed ?? Math.sqrt(Math.max(0, s.speed ** 2 - s.lateralSpeed ** 2));
    this.gait.update({ speed: s.speed, forward: forwardSpeed, right: s.lateralSpeed,
      onGround: s.onGround, crouch: s.crouch, slide: s.slidePose ?? 0, prone: s.prone ?? 0 }, dt);
    const run = Math.min(1, this.gait.speed / Math.max(1, s.maxSpeed));
    this.moveT = run * this.gait.grounded;
    const forward = clamp(forwardSpeed / Math.max(1, s.maxSpeed), -1, 1);
    this.forwardT = damp(this.forwardT, forward, 10, dt);
    const canRunPose = !s.busy && !s.ads && !s.reload && s.draw === 1 && !s.planting && !s.defusing && !s.throwPrimed && !s.mantle;
    this.runT = damp(this.runT, canRunPose ? clamp((this.gait.speed - 2.6) / 3.4, 0, 1) * this.gait.grounded * (1 - s.crouch) * (1 - (s.slidePose ?? 0)) * (1 - (s.prone ?? 0)) : 0, canRunPose ? 10 : 22, dt);
    this.airT = damp(this.airT, s.onGround ? 0 : Math.max(-1, Math.min(1, s.verticalSpeed / 7)), 9, dt);
    this.strafeT = damp(this.strafeT, s.lateralSpeed / Math.max(1, s.maxSpeed), 9, dt);
    // Mouse deltas are per frame: convert to a 60 Hz reference so sway is FPS independent.
    const rate = 1 / Math.max(0.25, dt * 60);
    this.swayX = damp(this.swayX, Math.max(-0.025, Math.min(0.025, -s.lookDX * rate * 0.00035)), 14, dt);
    this.swayY = damp(this.swayY, Math.max(-0.02, Math.min(0.02, s.lookDY * rate * 0.00035)), 14, dt);
    this.kick = damp(this.kick, 0, 14, dt);
    this.kickRot = damp(this.kickRot, 0, 12, dt);
    this.kickYaw = damp(this.kickYaw, 0, 11, dt);
    this.kickRoll = damp(this.kickRoll, 0, 9, dt);
    this.breathT += dt;
    // An empty gun stays locked open through the reload until the new magazine is seated, then the
    // slide / bolt snaps home (the magazine counter only refills when the reload finishes).
    this.lockT = damp(this.lockT, s.mag === 0 && s.reload < 0.8 ? 1 : 0, 26, dt);
    this.adsT = damp(this.adsT, s.ads ? 1 : 0, 16, dt);
    const landing = this.landing.update(dt);
    this.slashT = Math.min(1, this.slashT + dt / (this.stab ? 0.5 : 0.32));
    this.throwT = Math.min(1, this.throwT + dt / 0.4);
    this.meleeT = Math.min(1, this.meleeT + dt / 0.42);
    if (s.busy || this.meleeT < 1 || (s.slidePose ?? 0) > 0.1) this.inspectT = 1;
    this.inspectT = Math.min(1, this.inspectT + dt / 2.6);
    this.mantleT = damp(this.mantleT, s.mantle ? Math.sin(Math.PI * Math.min(1, s.mantle)) : 0, 18, dt);
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.flash.material.opacity = Math.min(1, Math.max(0, this.flashT / 0.012));
    this.actionT = Math.min(1, this.actionT + dt / this.cycleDuration);
    const cycle = Math.sin(Math.PI * Math.max(0, Math.min(1, (this.actionT - (this.cycleDuration > 0.2 ? 0.18 : 0)) / (this.cycleDuration > 0.2 ? 0.82 : 1))));
    // An empty magazine holds a pistol's slide (or a self-loading bolt) open until the reload.
    const manual = this.cycleDuration > 0.2;
    const open = manual ? cycle : Math.max(cycle, this.lockT);
    if (this.slide) this.slide.position.z = open * 0.033;
    if (this.bolt) {
      this.bolt.position.z = open * (manual ? 0.07 : 0.025);
      this.bolt.rotation.z = manual ? -cycle * 0.7 : 0;
    }
    if (this.pump) this.pump.position.z = cycle * 0.09;
    this.updateShells(dt);

    const side = this.leftHanded ? -1 : 1;
    const base = this.kind === 'pistol' ? new Vector3(0.15, -0.14, -0.44)
      : this.kind === 'knife' ? new Vector3(0.18, -0.18, -0.4)
        : this.kind === 'grenade' ? new Vector3(0.17, -0.17, -0.4)
          : this.kind === 'bomb' ? new Vector3(0.05, -0.24, -0.42)
            : this.launcher ? new Vector3(0.16, -0.16, -0.46) : new Vector3(0.17, -0.175, -0.51);
    // Aimed, the eye sits on the sight line (the optic's, else the model's iron sights).
    const adsPos = aimedEye(this.item?.userData ?? {}, this.kind === 'pistol').negate();
    const p = base.clone().lerp(adsPos, this.adsT);
    p.x *= side;
    const prone = s.prone ?? 0, slidePose = s.slidePose ?? 0;
    // Hip-fire motion fades out as the sights come up: offsets that would move the eye off the
    // sight line go entirely, sway keeps a little inertia, and the visible recoil comes from the
    // aim pivot (the gun turning to where the bullets go) instead of a free kick.
    const hip = 1 - this.adsT, loose = 1 - 0.8 * this.adsT;
    const bobAmt = (1 - this.adsT * 0.9) * this.moveT * (1 - slidePose) * (1 - prone * 0.6);
    p.x += Math.sin(this.gait.phase) * 0.007 * bobAmt + (this.swayX - this.strafeT * 0.008) * hip;
    p.y += Math.cos(this.gait.phase * 2) * 0.004 * bobAmt + (this.swayY - landing - s.crouch * 0.006 - this.airT * 0.012 - this.runT * 0.018) * hip;
    p.z += this.kick + ((forward - this.forwardT) * 0.022 + this.runT * 0.012) * hip;
    let rx = (this.kickRot + this.airT * 0.035) * hip + this.swayY * 2 * loose, ry = this.swayX * 2 * loose + hip * 0.09, rz = -this.strafeT * 0.025 * hip;
    ry += this.kickYaw * hip; rz += this.kickRoll * hip;
    rx -= this.runT * 0.055 * hip;
    rz += this.runT * 0.04 * hip * side;
    p.y -= slidePose * 0.035 * (1 - this.adsT);
    rz += slidePose * 0.08 * (1 - this.adsT) * side;
    // draw animation
    const drawK = 1 - s.draw;
    p.y -= drawK * 0.25; rx -= drawK * 0.9;
    // reload animation
    if (s.reload > 0) {
      const k = Math.sin(Math.PI * Math.min(1, s.reload / 0.9));
      p.y -= k * 0.045; rz += k * 0.32 * side; rx += k * 0.12;
      if (this.magazine) {
        const out = s.reload < 0.42 ? Math.min(1, Math.max(0, (s.reload - 0.12) / 0.18)) : Math.max(0, 1 - (s.reload - 0.48) / 0.22);
        this.magazine.position.set(-out * 0.035, -out * 0.2, out * 0.035);
        this.magazine.rotation.x = out * 0.2;
        this.magazine.visible = s.reload < 0.4 || s.reload > 0.5;
      }
      if (this.bolt) this.bolt.position.z += Math.sin(Math.PI * Math.max(0, Math.min(1, (s.reload - 0.78) / 0.15))) * 0.045;
    } else if (this.magazine) {
      this.magazine.position.set(0, 0, 0); this.magazine.rotation.set(0, 0, 0); this.magazine.visible = true;
    }
    // knife slash / stab
    if (this.kind === 'knife' && this.slashT < 1) {
      const k = Math.sin(Math.PI * this.slashT);
      if (this.stab) { p.z -= k * 0.18; rx -= k * 0.5; }
      else { p.x -= k * 0.18 * this.slashDir * side; ry += k * 0.9 * this.slashDir; rz += k * 0.6 * this.slashDir; }
    }
    if (this.kind === 'grenade') {
      if (s.throwPrimed) { p.y += 0.06; p.z += 0.08; rx += 0.5; }
      if (this.throwT < 1) { const k = Math.sin(Math.PI * this.throwT); p.z -= k * 0.25; p.y += k * 0.1; rx -= k * 0.8; }
    }
    if (s.planting || s.defusing) { p.y -= 0.1; rx -= 0.6; p.z += 0.05; }
    // heartbeat tablet: held low and centred, both hands
    if (this.tablet) { p.set(0.0, -0.2, -0.36); rx = 0.05 + this.swayY * 2; ry = this.swayX * 2; rz = 0; }
    // mantle: weapon swings down and aside while the hands grab the ledge
    if (this.mantleT > 0.01) { p.y -= this.mantleT * 0.22; p.x += this.mantleT * 0.05 * side; rx -= this.mantleT * 0.7; rz += this.mantleT * 0.45 * side; }
    // stun: drunken sway
    if (s.stun) { const w = performance.now() / 1000; p.x += Math.sin(w * 2.3) * 0.02 * s.stun; p.y += Math.sin(w * 3.1) * 0.012 * s.stun; rz += Math.sin(w * 1.7) * 0.12 * s.stun; }
    // inspect: turn the left side toward you, tip it up, then bring it back
    if (this.inspectT < 1) {
      const t = this.inspectT, e = (a: number, b: number) => { const x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
      const turn = e(0.04, 0.22) * (1 - e(0.5, 0.62)), tip = e(0.5, 0.62) * (1 - e(0.82, 0.97));
      p.x -= turn * 0.07 * side; p.y += turn * 0.04 + tip * 0.05; p.z += turn * 0.06;
      ry += turn * 0.95 * side; rz += turn * 0.55 * side; rx += tip * 0.55; rz -= tip * 0.25 * side;
    }
    // quick melee: gun drops and rolls away while the blade thrusts forward
    const mk = this.meleeT < 1 ? Math.sin(Math.PI * Math.min(1, this.meleeT * 1.15)) : 0;
    p.y -= mk * 0.2; p.x -= mk * 0.06 * side; rx -= mk * 0.55; rz += mk * 0.35 * side;
    this.meleeRig.visible = this.meleeT < 1 && this.kind !== 'none';
    if (this.meleeRig.visible) {
      const t = this.meleeT;
      // wind-up (0-0.3) → thrust (0.3-0.55) → recover
      const wind = Math.min(1, t / 0.3), thrust = Math.max(0, Math.min(1, (t - 0.28) / 0.22)), back = Math.max(0, (t - 0.6) / 0.4);
      const ease = (x: number) => x * x * (3 - 2 * x);
      const out = ease(wind) * (1 - ease(back));
      this.meleeRig.position.set((0.2 - 0.08 * ease(thrust)) * side, -0.32 + 0.17 * out, -0.36 - 0.2 * ease(thrust) * (1 - back));
      this.meleeRig.rotation.set(-0.1 + 0.25 * out - 0.2 * ease(thrust), (0.35 - 0.5 * ease(thrust)) * side, (-0.6 + 0.4 * ease(thrust)) * side);
      this.meleeRig.scale.x = side;
    }
    this.rig.position.copy(p);
    this.rig.rotation.set(rx, ry, rz);
    this.rig.scale.x = side;
    // Standing still at the hip, the arms ride your breathing in a slow figure of eight. It is its
    // own layer above the rig, so every pose above still settles exactly, and moving, firing or
    // aiming fades it out, so it never shifts the sights.
    const breath = hip * (1 - this.moveT) * (1 - slidePose) * (1 - Math.min(1, this.kickRot * 8));
    this.aim.position.set(Math.sin(this.breathT * 0.85) * 0.0018 * breath * side, Math.sin(this.breathT * 1.7) * 0.0026 * breath, 0);
    this.holder.rotation.x = Math.sin(this.breathT * 1.7 + 0.9) * 0.005 * breath;
    const reloadHand = s.reload > 0 ? Math.sin(Math.PI * Math.max(0, Math.min(1, (s.reload - 0.08) / 0.7))) : 0;
    this.armL.position.set(-reloadHand * 0.06, 0.01 - reloadHand * 0.16, (this.armL.userData.z ?? -0.25) + reloadHand * 0.12);
    if (this.pump) this.armL.position.z += cycle * 0.09;
    this.armL.rotation.z = -reloadHand * 0.3;
    this.rig.visible = !s.scoped && this.kind !== 'none';
  }

  /** Muzzle position in view-camera space (for tracer start in world). */
  muzzleCamSpace(out: Vector3): Vector3 {
    this.rig.updateMatrix(); this.holder.updateMatrix(); this.aim.updateMatrix();
    return out.copy(this.muzzleLocal).applyMatrix4(pivotTmp.multiplyMatrices(this.aim.matrix, this.rig.matrix).multiply(this.holder.matrix));
  }
}
