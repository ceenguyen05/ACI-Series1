import type { Team } from './rules';

export type WeaponId =
  | 'knife'
  | 'k9' | 'warden' | 'p30' | 'judge' | 'viper'
  | 'vespa' | 'hornet' | 'mako' | 'breacher' | 'reaper'
  | 'galeforce' | 'tempest' | 'ravager' | 'sentinel' | 'talon' | 'kestrel' | 'marshal' | 'longbow'
  | 'bulwark' | 'anvil' | 'thumper' | 'hammer'
  | 'disruptor';

export type WeaponSlot = 'primary' | 'secondary' | 'melee';
export type WeaponClass = 'knife' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'lmg' | 'sniper' | 'launcher';
export type SoundProfile = 'pistol' | 'heavyPistol' | 'suppressed' | 'smg' | 'rifle' | 'heavyRifle' | 'sniper' | 'shotgun' | 'knife' | 'launcher' | 'rocket' | 'energy';

/** All inaccuracy values in milliradians (CS weapon-script style), converted at runtime. */
export interface SpreadDef {
  base: number;     // innate spread
  stand: number;
  crouch: number;
  move: number;     // added at full movement speed
  air: number;      // added while airborne
  perShot: number;  // added per shot fired
  recovery: number; // seconds to recover fire inaccuracy
  /** × stand / crouch spread when not aiming down sights or scoped (attachments; absent = 1). */
  hip?: number;
}

export interface RecoilDef {
  climb: number;       // degrees per shot at the start of a spray
  climbShots: number;  // shots before the pattern turns horizontal
  lateClimb: number;   // degrees per shot after climbShots
  sway: number;        // horizontal amplitude in degrees
  swayPeriod: number;  // shots per left→right swing
  firstSide: 1 | -1;   // +1 pulls left first, -1 right
  jitter: number;      // deterministic per-shot noise in degrees
  kick: number;        // view-model kick strength
  seed: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  class: WeaponClass;
  slot: WeaponSlot;
  team: Team | 'both';
  price: number;
  killReward: number;
  damage: number;
  /** Fraction of damage that goes to health when armored (CS "armor ratio" × 0.5). */
  armorPen: number;
  /** Damage multiplier per 12.7 m (500 units) travelled. */
  rangeMod: number;
  range: number;
  rpm: number;
  auto: boolean;
  mag: number;
  reserve: number;
  reloadTime: number;
  drawTime: number;
  moveSpeed: number;
  pellets?: number;
  spread: SpreadDef;
  recoil: RecoilDef;
  /** `stay`: semi-auto marksman rifles keep the scope up between shots (no bolt). */
  scope?: { zooms: number[]; unscopedPenalty: number; scopedSpeed: number; stay?: boolean };
  /** Burst weapons fire `count` rounds at `rpm` per trigger pull; `rpm` above is the burst cadence. */
  burst?: { count: number; rpm: number };
  /** Launchers fire a physical projectile instead of a hitscan bullet. */
  projectile?: { kind: 'rocket' | 'grenade' | 'plasma'; speed: number; gravity: number; radius: number; damage: number; armDistance: number };
  sound: SoundProfile;
  /** Short description shown in the buy menu. */
  blurb: string;
  /** Aim-down-sights tuning (optics change it; iron sights when absent). */
  ads?: { zoom: number; spread: number; move: number };
  /** Built-in aiming optic (the rocket launcher's PGO-style scope). */
  optic?: 'pgo';
  /** Attachment effects that aren't plain stat changes (see config/attachments.ts). */
  mods?: {
    penMul: number; laser?: 'red' | 'green'; light?: boolean; bipod?: boolean; optic?: 'reddot' | 'holo' | 'acog';
    smallFlash?: boolean; suppressed?: boolean; list: string[];
  };
  /** Spray-pattern cache key: attachments scale the base pattern. */
  patternKey?: string;
  /** Only in Zombies (Mystery Box wonder weapon): hidden from Search & Destroy menus. */
  zombiesOnly?: boolean;
  /** Zombies: Prototype Forge upgrade tier (0 = stock). */
  tier?: number;
}

const recoil = (r: Partial<RecoilDef>): RecoilDef => ({
  climb: 1, climbShots: 8, lateClimb: 0.15, sway: 2, swayPeriod: 10, firstSide: 1, jitter: 0.15, kick: 1, seed: 1, ...r,
});

const knifeSpread: SpreadDef = { base: 0, stand: 0, crouch: 0, move: 0, air: 0, perShot: 0, recovery: 0.1 };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife', name: 'Field Knife', class: 'knife', slot: 'melee', team: 'both', price: 0, killReward: 1500,
    damage: 40, armorPen: 0.85, rangeMod: 1, range: 1.6, rpm: 120, auto: true, mag: 0, reserve: 0,
    reloadTime: 0, drawTime: 0.5, moveSpeed: 6.35, spread: knifeSpread, recoil: recoil({ climb: 0, sway: 0, jitter: 0, kick: 0 }),
    sound: 'knife', blurb: 'Slash (LMB) 40 / Stab (RMB) 65. Backstabs are lethal.',
  },
  // ---------------------------------------------------------------- pistols
  k9: {
    id: 'k9', name: 'K9 Compact', class: 'pistol', slot: 'secondary', team: 'T', price: 200, killReward: 300,
    damage: 30, armorPen: 0.47, rangeMod: 0.85, range: 120, rpm: 400, auto: false, mag: 20, reserve: 120,
    reloadTime: 2.2, drawTime: 0.6, moveSpeed: 6.1,
    spread: { base: 2, stand: 6, crouch: 4.5, move: 13, air: 200, perShot: 56, recovery: 0.32 },
    recoil: recoil({ climb: 1.1, climbShots: 4, lateClimb: 0.4, sway: 1.2, swayPeriod: 6, jitter: 0.35, kick: 0.8, seed: 11 }),
    sound: 'pistol', blurb: 'Attacker default sidearm. High capacity, low armor penetration.',
  },
  warden: {
    id: 'warden', name: 'Warden SD', class: 'pistol', slot: 'secondary', team: 'CT', price: 200, killReward: 300,
    damage: 35, armorPen: 0.505, rangeMod: 0.91, range: 120, rpm: 352, auto: false, mag: 12, reserve: 24,
    reloadTime: 2.2, drawTime: 0.6, moveSpeed: 6.1,
    spread: { base: 1.5, stand: 4.5, crouch: 3.5, move: 13, air: 200, perShot: 52, recovery: 0.3 },
    recoil: recoil({ climb: 1.2, climbShots: 4, lateClimb: 0.4, sway: 1, swayPeriod: 6, jitter: 0.3, kick: 0.7, seed: 12 }),
    sound: 'suppressed', blurb: 'Defender default sidearm. Integrated suppressor, accurate first shot.',
  },
  p30: {
    id: 'p30', name: 'P-30 Duty', class: 'pistol', slot: 'secondary', team: 'both', price: 300, killReward: 300,
    damage: 38, armorPen: 0.64, rangeMod: 0.9, range: 120, rpm: 400, auto: false, mag: 13, reserve: 26,
    reloadTime: 2.2, drawTime: 0.6, moveSpeed: 6.1,
    spread: { base: 2, stand: 6.5, crouch: 5, move: 13, air: 200, perShot: 60, recovery: 0.35 },
    recoil: recoil({ climb: 1.4, climbShots: 4, lateClimb: 0.5, sway: 1.3, swayPeriod: 6, jitter: 0.35, kick: 0.9, seed: 13 }),
    sound: 'pistol', blurb: 'Cheap upgrade with solid armor penetration.',
  },
  judge: {
    id: 'judge', name: 'Judge .50', class: 'pistol', slot: 'secondary', team: 'both', price: 700, killReward: 300,
    damage: 63, armorPen: 0.932, rangeMod: 0.81, range: 160, rpm: 267, auto: false, mag: 7, reserve: 35,
    reloadTime: 2.2, drawTime: 0.7, moveSpeed: 5.84,
    spread: { base: 2, stand: 4, crouch: 3, move: 25, air: 260, perShot: 120, recovery: 0.55 },
    recoil: recoil({ climb: 4, climbShots: 3, lateClimb: 1.2, sway: 2, swayPeriod: 4, jitter: 0.6, kick: 2.2, seed: 14 }),
    sound: 'heavyPistol', blurb: 'Hand cannon. One headshot kills through a helmet.',
  },
  viper: {
    id: 'viper', name: 'Viper MP', class: 'pistol', slot: 'secondary', team: 'both', price: 500, killReward: 300,
    damage: 24, armorPen: 0.5, rangeMod: 0.8, range: 60, rpm: 857, auto: true, mag: 18, reserve: 90,
    reloadTime: 2.1, drawTime: 0.5, moveSpeed: 6.0,
    spread: { base: 4, stand: 14, crouch: 11, move: 22, air: 200, perShot: 13, recovery: 0.3 },
    recoil: recoil({ climb: 1.05, climbShots: 7, lateClimb: 0.25, sway: 2.6, swayPeriod: 6, firstSide: -1, jitter: 0.45, kick: 0.7, seed: 15 }),
    sound: 'pistol', blurb: 'Fully automatic machine pistol. Melts at close range; wild past 10 m.',
  },
  // ---------------------------------------------------------------- SMGs / heavy
  vespa: {
    id: 'vespa', name: 'Vespa SMG', class: 'smg', slot: 'primary', team: 'T', price: 1050, killReward: 600,
    damage: 29, armorPen: 0.575, rangeMod: 0.8, range: 80, rpm: 800, auto: true, mag: 30, reserve: 100,
    reloadTime: 2.6, drawTime: 0.6, moveSpeed: 6.1,
    spread: { base: 3, stand: 12, crouch: 9, move: 30, air: 160, perShot: 10, recovery: 0.3 },
    recoil: recoil({ climb: 0.75, climbShots: 9, lateClimb: 0.12, sway: 2.4, swayPeriod: 8, firstSide: 1, jitter: 0.3, kick: 0.6, seed: 21 }),
    sound: 'smg', blurb: 'Attacker run-and-gun SMG. $600 kill reward.',
  },
  hornet: {
    id: 'hornet', name: 'Hornet-9', class: 'smg', slot: 'primary', team: 'CT', price: 1250, killReward: 600,
    damage: 26, armorPen: 0.6, rangeMod: 0.87, range: 80, rpm: 857, auto: true, mag: 30, reserve: 120,
    reloadTime: 2.1, drawTime: 0.6, moveSpeed: 6.1,
    spread: { base: 3, stand: 11, crouch: 8, move: 26, air: 150, perShot: 9, recovery: 0.28 },
    recoil: recoil({ climb: 0.7, climbShots: 9, lateClimb: 0.12, sway: 2.2, swayPeriod: 8, firstSide: -1, jitter: 0.3, kick: 0.55, seed: 22 }),
    sound: 'smg', blurb: 'Defender SMG with a blistering fire rate. $600 kill reward.',
  },
  mako: {
    id: 'mako', name: 'Mako PDW', class: 'smg', slot: 'primary', team: 'both', price: 1500, killReward: 600,
    damage: 26, armorPen: 0.69, rangeMod: 0.86, range: 90, rpm: 857, auto: true, mag: 50, reserve: 100,
    reloadTime: 3.3, drawTime: 0.6, moveSpeed: 5.97,
    spread: { base: 3, stand: 11, crouch: 8, move: 28, air: 160, perShot: 7, recovery: 0.3 },
    recoil: recoil({ climb: 0.6, climbShots: 10, lateClimb: 0.1, sway: 2, swayPeriod: 9, firstSide: 1, jitter: 0.28, kick: 0.5, seed: 23 }),
    sound: 'smg', blurb: 'Bullpup PDW with a 50-round top magazine and soft recoil. $600 kill reward.',
  },
  breacher: {
    id: 'breacher', name: 'Breacher-12', class: 'shotgun', slot: 'primary', team: 'both', price: 1050, killReward: 900,
    damage: 26, armorPen: 0.5, rangeMod: 0.7, range: 40, rpm: 68, auto: false, mag: 8, reserve: 32,
    reloadTime: 3.2, drawTime: 0.7, moveSpeed: 5.59, pellets: 9,
    spread: { base: 40, stand: 10, crouch: 8, move: 30, air: 120, perShot: 25, recovery: 0.4 },
    recoil: recoil({ climb: 3.5, climbShots: 2, lateClimb: 1, sway: 1, swayPeriod: 3, jitter: 0.5, kick: 2.5, seed: 31 }),
    sound: 'shotgun', blurb: 'Pump shotgun for tight office corners. $900 kill reward.',
  },
  reaper: {
    id: 'reaper', name: 'Reaper Auto-12', class: 'shotgun', slot: 'primary', team: 'both', price: 1900, killReward: 900,
    damage: 20, armorPen: 0.8, rangeMod: 0.7, range: 40, rpm: 240, auto: true, mag: 7, reserve: 32,
    reloadTime: 2.8, drawTime: 0.8, moveSpeed: 5.46, pellets: 6,
    spread: { base: 38, stand: 10, crouch: 8, move: 30, air: 120, perShot: 30, recovery: 0.35 },
    recoil: recoil({ climb: 2.4, climbShots: 3, lateClimb: 1.2, sway: 1.2, swayPeriod: 3, jitter: 0.5, kick: 1.8, seed: 32 }),
    sound: 'shotgun', blurb: 'Box-fed automatic shotgun. Locks down doorways – pricey and weak at range.',
  },
  // ---------------------------------------------------------------- rifles
  galeforce: {
    id: 'galeforce', name: 'Galeforce AR', class: 'rifle', slot: 'primary', team: 'T', price: 1800, killReward: 300,
    damage: 30, armorPen: 0.775, rangeMod: 0.98, range: 200, rpm: 666, auto: true, mag: 35, reserve: 90,
    reloadTime: 3.0, drawTime: 0.8, moveSpeed: 5.46,
    spread: { base: 0.6, stand: 6, crouch: 4.5, move: 150, air: 400, perShot: 9, recovery: 0.4 },
    recoil: recoil({ climb: 0.95, climbShots: 9, lateClimb: 0.12, sway: 2.6, swayPeriod: 10, firstSide: 1, jitter: 0.2, kick: 1, seed: 41 }),
    sound: 'rifle', blurb: 'Budget attacker rifle with a deep magazine.',
  },
  tempest: {
    id: 'tempest', name: 'Tempest Carbine', class: 'rifle', slot: 'primary', team: 'CT', price: 2050, killReward: 300,
    damage: 30, armorPen: 0.7, rangeMod: 0.96, range: 200, rpm: 666, auto: true, mag: 25, reserve: 90,
    reloadTime: 3.3, drawTime: 0.8, moveSpeed: 5.59,
    spread: { base: 0.6, stand: 5.5, crouch: 4, move: 140, air: 400, perShot: 9, recovery: 0.38 },
    recoil: recoil({ climb: 0.9, climbShots: 8, lateClimb: 0.14, sway: 2.4, swayPeriod: 9, firstSide: -1, jitter: 0.2, kick: 0.95, seed: 42 }),
    sound: 'rifle', blurb: 'Budget defender rifle. Good while crouched.',
  },
  ravager: {
    id: 'ravager', name: 'Ravager R7', class: 'rifle', slot: 'primary', team: 'T', price: 2700, killReward: 300,
    damage: 36, armorPen: 0.775, rangeMod: 0.98, range: 220, rpm: 600, auto: true, mag: 30, reserve: 90,
    reloadTime: 2.5, drawTime: 0.9, moveSpeed: 5.46,
    spread: { base: 0.6, stand: 4.9, crouch: 3.7, move: 140, air: 400, perShot: 7.8, recovery: 0.35 },
    recoil: recoil({ climb: 1.15, climbShots: 9, lateClimb: 0.1, sway: 3.2, swayPeriod: 11, firstSide: 1, jitter: 0.15, kick: 1.3, seed: 43 }),
    sound: 'heavyRifle', blurb: 'Iconic attacker rifle. One-tap headshots even through helmets.',
  },
  sentinel: {
    id: 'sentinel', name: 'Sentinel M4', class: 'rifle', slot: 'primary', team: 'CT', price: 2900, killReward: 300,
    damage: 33, armorPen: 0.7, rangeMod: 0.97, range: 220, rpm: 666, auto: true, mag: 30, reserve: 90,
    reloadTime: 3.1, drawTime: 0.9, moveSpeed: 5.72,
    spread: { base: 0.5, stand: 4.2, crouch: 3.2, move: 130, air: 400, perShot: 7, recovery: 0.33 },
    recoil: recoil({ climb: 0.95, climbShots: 9, lateClimb: 0.1, sway: 2.6, swayPeriod: 11, firstSide: -1, jitter: 0.12, kick: 1.05, seed: 44 }),
    sound: 'rifle', blurb: 'Precise defender rifle with controllable spray.',
  },
  talon: {
    id: 'talon', name: 'Talon B3', class: 'rifle', slot: 'primary', team: 'both', price: 2350, killReward: 300,
    damage: 32, armorPen: 0.72, rangeMod: 0.97, range: 200, rpm: 200, auto: false, mag: 30, reserve: 90,
    reloadTime: 2.9, drawTime: 0.8, moveSpeed: 5.59, burst: { count: 3, rpm: 1000 },
    spread: { base: 0.5, stand: 4.4, crouch: 3.3, move: 140, air: 400, perShot: 5.5, recovery: 0.3 },
    recoil: recoil({ climb: 0.8, climbShots: 9, lateClimb: 0.1, sway: 1.6, swayPeriod: 9, firstSide: 1, jitter: 0.1, kick: 0.9, seed: 45 }),
    sound: 'rifle', blurb: '3-round burst bullpup. Two bursts to the body, one to a bare head. Rewards tapping.',
  },
  kestrel: {
    id: 'kestrel', name: 'Kestrel Scout', class: 'sniper', slot: 'primary', team: 'both', price: 1700, killReward: 300,
    damage: 88, armorPen: 0.85, rangeMod: 0.98, range: 250, rpm: 48, auto: false, mag: 10, reserve: 90,
    reloadTime: 3.7, drawTime: 1.0, moveSpeed: 5.84,
    spread: { base: 0.3, stand: 2.5, crouch: 2, move: 100, air: 30, perShot: 40, recovery: 0.3 },
    recoil: recoil({ climb: 2.5, climbShots: 1, lateClimb: 0, sway: 0.4, swayPeriod: 2, jitter: 0.3, kick: 2, seed: 51 }),
    scope: { zooms: [2.5, 6], unscopedPenalty: 45, scopedSpeed: 5.84 },
    sound: 'sniper', blurb: 'Light bolt-action sniper. Famously accurate mid-jump.',
  },
  marshal: {
    id: 'marshal', name: 'Marshal DMR', class: 'sniper', slot: 'primary', team: 'both', price: 3600, killReward: 300,
    damage: 58, armorPen: 0.85, rangeMod: 0.98, range: 260, rpm: 240, auto: false, mag: 15, reserve: 60,
    reloadTime: 3.0, drawTime: 1.0, moveSpeed: 5.46,
    spread: { base: 0.4, stand: 3, crouch: 2.2, move: 120, air: 380, perShot: 22, recovery: 0.32 },
    recoil: recoil({ climb: 1.6, climbShots: 3, lateClimb: 0.6, sway: 0.8, swayPeriod: 4, jitter: 0.3, kick: 1.6, seed: 53 }),
    scope: { zooms: [2.0], unscopedPenalty: 14, scopedSpeed: 4.6, stay: true },
    sound: 'heavyRifle', blurb: 'Semi-auto marksman rifle. Stays scoped: two quick body shots or one headshot.',
  },
  longbow: {
    id: 'longbow', name: 'Longbow .338', class: 'sniper', slot: 'primary', team: 'both', price: 4750, killReward: 100,
    damage: 115, armorPen: 0.975, rangeMod: 0.99, range: 300, rpm: 41, auto: false, mag: 5, reserve: 30,
    reloadTime: 3.7, drawTime: 1.2, moveSpeed: 5.08,
    spread: { base: 0.2, stand: 2, crouch: 1.5, move: 180, air: 500, perShot: 100, recovery: 0.35 },
    recoil: recoil({ climb: 4, climbShots: 1, lateClimb: 0, sway: 0.5, swayPeriod: 2, jitter: 0.4, kick: 3.5, seed: 52 }),
    scope: { zooms: [2.2, 5], unscopedPenalty: 90, scopedSpeed: 2.54 },
    sound: 'sniper', blurb: 'Heavy sniper. One shot to the body is lethal. $100 kill reward.',
  },
  // ---------------------------------------------------------------- heavy
  bulwark: {
    id: 'bulwark', name: 'Bulwark L8', class: 'lmg', slot: 'primary', team: 'both', price: 4200, killReward: 300,
    damage: 32, armorPen: 0.8, rangeMod: 0.97, range: 220, rpm: 750, auto: true, mag: 100, reserve: 200,
    reloadTime: 5.6, drawTime: 1.1, moveSpeed: 4.95,
    spread: { base: 0.8, stand: 8, crouch: 5, move: 170, air: 450, perShot: 5, recovery: 0.45 },
    recoil: recoil({ climb: 0.55, climbShots: 12, lateClimb: 0.04, sway: 2.2, swayPeriod: 14, firstSide: 1, jitter: 0.35, kick: 1.1, seed: 61 }),
    sound: 'heavyRifle', blurb: 'Belt-fed LMG. 100 rounds of suppression – slow to move and reload.',
  },
  anvil: {
    id: 'anvil', name: 'Anvil M60', class: 'lmg', slot: 'primary', team: 'both', price: 5200, killReward: 300,
    damage: 38, armorPen: 0.82, rangeMod: 0.97, range: 230, rpm: 580, auto: true, mag: 75, reserve: 150,
    reloadTime: 6.0, drawTime: 1.2, moveSpeed: 4.7,
    spread: { base: 0.9, stand: 9, crouch: 5.5, move: 180, air: 450, perShot: 6.5, recovery: 0.5 },
    recoil: recoil({ climb: 0.75, climbShots: 10, lateClimb: 0.08, sway: 2.8, swayPeriod: 12, firstSide: -1, jitter: 0.4, kick: 1.5, seed: 62 }),
    sound: 'heavyRifle', blurb: 'Heavy 7.62 machine gun. Punches through cover and gadgets – punishing on the move.',
  },
  thumper: {
    id: 'thumper', name: 'Thumper 40mm', class: 'launcher', slot: 'primary', team: 'both', price: 2900, killReward: 300,
    damage: 0, armorPen: 1, rangeMod: 1, range: 120, rpm: 55, auto: false, mag: 1, reserve: 4,
    reloadTime: 2.4, drawTime: 0.9, moveSpeed: 5.3,
    spread: { base: 2, stand: 6, crouch: 4, move: 40, air: 120, perShot: 20, recovery: 0.6 },
    recoil: recoil({ climb: 5, climbShots: 1, lateClimb: 0, sway: 0.5, swayPeriod: 2, jitter: 0.4, kick: 2.6, seed: 71 }),
    projectile: { kind: 'grenade', speed: 36, gravity: 9.8, radius: 4.6, damage: 120, armDistance: 5 },
    sound: 'launcher', blurb: 'Break-action grenade launcher. Lobbed 40mm shells arm after 5 m. Bounces off cover.',
  },
  hammer: {
    id: 'hammer', name: 'Hammer RPG', class: 'launcher', slot: 'primary', team: 'both', price: 4500, killReward: 300,
    damage: 0, armorPen: 1, rangeMod: 1, range: 200, rpm: 30, auto: false, mag: 1, reserve: 2,
    reloadTime: 3.4, drawTime: 1.3, moveSpeed: 4.8,
    spread: { base: 1, stand: 5, crouch: 3, move: 60, air: 200, perShot: 10, recovery: 0.6 },
    recoil: recoil({ climb: 3, climbShots: 1, lateClimb: 0, sway: 0.3, swayPeriod: 2, jitter: 0.3, kick: 3.2, seed: 72 }),
    projectile: { kind: 'rocket', speed: 52, gravity: 1.5, radius: 5.5, damage: 170, armDistance: 4 },
    ads: { zoom: 2, spread: 0.75, move: 0.8 }, optic: 'pgo',
    sound: 'rocket', blurb: 'Shoulder-fired rocket with a 2× ranging scope. Devastating splash, shreds barricades and gadgets. 2 spare rockets.',
  },
  disruptor: {
    id: 'disruptor', name: 'Disruptor X-1', class: 'launcher', slot: 'primary', team: 'both', price: 0, killReward: 0,
    damage: 0, armorPen: 1, rangeMod: 1, range: 150, rpm: 181, auto: false, mag: 20, reserve: 160,
    reloadTime: 2.6, drawTime: 0.8, moveSpeed: 5.8,
    spread: { base: 0.8, stand: 3, crouch: 2, move: 25, air: 80, perShot: 4, recovery: 0.4 },
    recoil: recoil({ climb: 1.4, climbShots: 1, lateClimb: 0, sway: 0.3, swayPeriod: 2, jitter: 0.2, kick: 1.4, seed: 81 }),
    projectile: { kind: 'plasma', speed: 70, gravity: 0, radius: 2.4, damage: 380, armDistance: 0 },
    sound: 'energy', zombiesOnly: true,
    blurb: 'ACI R&D prototype. Fires bolts of green plasma that burst on impact. Mystery Box only.',
  },
};

/** Weapons sold in Search & Destroy (the Zombies wonder weapon is excluded). */
export const WEAPON_LIST = Object.values(WEAPONS).filter((w) => !w.zombiesOnly);

export const DEFAULT_PISTOL: Record<Team, WeaponId> = { T: 'k9', CT: 'warden' };

/** The optic you look through when aiming: a fitted Gunsmith optic or the gun's built-in one. */
export function adsOptic(def: WeaponDef | undefined): 'reddot' | 'holo' | 'acog' | 'pgo' | undefined {
  return def?.mods?.optic ?? def?.optic;
}

/** True when the view is a full-screen scope picture (sniper scope, ACOG, launcher scope) instead of the gun. */
export function scopedView(def: WeaponDef | undefined, ads: boolean, scope: number): boolean {
  if (!def) return false;
  if (def.scope) return scope > 0;
  const optic = adsOptic(def);
  return ads && (optic === 'acog' || optic === 'pgo');
}

export function availableTo(def: { team: Team | 'both' }, team: Team): boolean {
  return def.team === 'both' || def.team === team;
}
