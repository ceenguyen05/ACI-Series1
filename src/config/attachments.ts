import { WEAPONS, type WeaponClass, type WeaponDef, type WeaponId } from './weapons';

/**
 * Gunsmith: buyable weapon attachments (Call of Duty Gunsmith / Siege style).
 *
 * - Attachments are bought per gun and stay unlocked for that gun for the rest of the half,
 *   even if you die: buy the same gun again and your loadout is re-applied for free.
 * - Like CoD's Gunsmith, a gun can run at most 5 attachments, one per slot.
 * - Which slots a gun has depends on its class (plus a few per-gun exceptions: bullpups have
 *   no stock slot, guns with an integral suppressor have no muzzle slot).
 */
export type AttachmentSlot = 'optic' | 'muzzle' | 'barrel' | 'underbarrel' | 'laser' | 'magazine' | 'stock' | 'ammo';
export type AttachmentId =
  | 'reddot' | 'holo' | 'acog'
  | 'suppressor' | 'compensator' | 'flashhider' | 'brake' | 'choke'
  | 'longbarrel' | 'shortbarrel'
  | 'vgrip' | 'agrip' | 'bipod'
  | 'laser1mw' | 'laser5mw' | 'flashlight'
  | 'extmag' | 'fastmag' | 'drum'
  | 'tacstock' | 'lightstock'
  | 'fmj' | 'hollow';

export const MAX_ATTACHMENTS = 5;

export const SLOT_ORDER: AttachmentSlot[] = ['optic', 'muzzle', 'barrel', 'underbarrel', 'laser', 'magazine', 'stock', 'ammo'];
export const SLOT_NAMES: Record<AttachmentSlot, string> = {
  optic: 'Optic', muzzle: 'Muzzle', barrel: 'Barrel', underbarrel: 'Underbarrel', laser: 'Laser / Light', magazine: 'Magazine', stock: 'Stock', ammo: 'Ammo',
};

export interface AttachmentMods {
  /** × vertical recoil (climb + view kick). */
  recoil?: number;
  /** × horizontal recoil (sway + jitter). */
  sway?: number;
  /** × hip-fire spread (standing / crouching, not aiming). */
  hip?: number;
  /** × spread added by movement. */
  moveSpread?: number;
  /** × time to recover from firing inaccuracy. */
  recovery?: number;
  /** Aim-down-sights: zoom, spread multiplier and movement multiplier. */
  adsZoom?: number;
  adsSpread?: number;
  adsMove?: number;
  moveSpeed?: number;
  reload?: number;
  draw?: number;
  magMul?: number;
  magAdd?: number;
  /** Added to the damage falloff per 12.7 m (higher = keeps damage further out). */
  rangeMod?: number;
  damage?: number;
  /** × wall-penetration power. */
  pen?: number;
  /** Added to the fraction of damage that goes through armor. */
  armorPen?: number;
  /** × shotgun pellet spread. */
  pellet?: number;
  suppressed?: boolean;
  smallFlash?: boolean;
  laser?: 'red' | 'green';
  light?: boolean;
  bipod?: boolean;
  optic?: 'reddot' | 'holo' | 'acog';
}

export interface AttachmentDef {
  id: AttachmentId;
  slot: AttachmentSlot;
  name: string;
  price: number;
  classes: WeaponClass[];
  pros: string[];
  cons: string[];
  mods: AttachmentMods;
}

const GUNS: WeaponClass[] = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'sniper'];
const LONG: WeaponClass[] = ['smg', 'shotgun', 'rifle', 'lmg', 'sniper'];

export const ATTACHMENTS: Record<AttachmentId, AttachmentDef> = {
  // ---------------------------------------------------------------- optics (snipers have their own scope)
  reddot: { id: 'reddot', slot: 'optic', name: 'Red Dot Sight', price: 200, classes: ['pistol', 'smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Clear red-dot reticle', 'ADS zoom 1.25×', 'ADS spread −7%'], cons: [],
    mods: { optic: 'reddot', adsZoom: 1.25, adsSpread: 0.93 } },
  holo: { id: 'holo', slot: 'optic', name: 'Holographic Sight', price: 250, classes: ['smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Ring-and-dot reticle', 'ADS zoom 1.4×', 'ADS spread −15%'], cons: ['ADS move speed −5%'],
    mods: { optic: 'holo', adsZoom: 1.4, adsSpread: 0.85, adsMove: 0.95 } },
  acog: { id: 'acog', slot: 'optic', name: '2.5× ACOG', price: 450, classes: ['rifle', 'lmg'],
    pros: ['2.5× magnified scope', 'ADS spread −30%'], cons: ['ADS move speed −15%', 'Draw time +10%'],
    mods: { optic: 'acog', adsZoom: 2.5, adsSpread: 0.7, adsMove: 0.85, draw: 1.1 } },
  // ---------------------------------------------------------------- muzzle
  suppressor: { id: 'suppressor', slot: 'muzzle', name: 'Suppressor', price: 400, classes: GUNS,
    pros: ['Quiet shots: no radar ping, enemies hear you at ~⅓ the distance', 'No tracers, tiny muzzle flash', 'Recoil −8%'],
    cons: ['Damage falls off sooner at range'],
    mods: { suppressed: true, smallFlash: true, recoil: 0.92, rangeMod: -0.03 } },
  compensator: { id: 'compensator', slot: 'muzzle', name: 'Compensator', price: 200, classes: ['pistol', 'smg', 'rifle', 'lmg'],
    pros: ['Horizontal recoil −25%'], cons: ['Vertical recoil +4%'],
    mods: { sway: 0.75, recoil: 1.04 } },
  flashhider: { id: 'flashhider', slot: 'muzzle', name: 'Flash Hider', price: 100, classes: ['smg', 'rifle', 'lmg', 'sniper', 'shotgun'],
    pros: ['Hides most of the muzzle flash', 'Recoil −5%'], cons: [],
    mods: { smallFlash: true, recoil: 0.95 } },
  brake: { id: 'brake', slot: 'muzzle', name: 'Muzzle Brake', price: 250, classes: ['smg', 'rifle', 'lmg', 'sniper'],
    pros: ['Vertical recoil −18%', 'Faster spread recovery'], cons: ['Horizontal recoil +5%'],
    mods: { recoil: 0.82, sway: 1.05, recovery: 0.9 } },
  choke: { id: 'choke', slot: 'muzzle', name: 'Choke', price: 150, classes: ['shotgun'],
    pros: ['Pellet spread −30%', 'Longer effective range'], cons: [],
    mods: { pellet: 0.7, rangeMod: 0.04 } },
  // ---------------------------------------------------------------- barrel
  longbarrel: { id: 'longbarrel', slot: 'barrel', name: 'Extended Barrel', price: 250, classes: LONG,
    pros: ['Damage falls off ~20% slower', 'Muzzle velocity: stronger penetration (+10%)'], cons: ['Move speed −3%', 'Hip-fire spread +10%'],
    mods: { rangeMod: 0.03, pen: 1.1, moveSpeed: 0.97, hip: 1.1 } },
  shortbarrel: { id: 'shortbarrel', slot: 'barrel', name: 'Short Barrel', price: 150, classes: ['smg', 'shotgun', 'rifle'],
    pros: ['Move speed +4%', 'Hip-fire spread −15%', 'Draw time −15%'], cons: ['Damage falls off sooner'],
    mods: { moveSpeed: 1.04, hip: 0.85, draw: 0.85, rangeMod: -0.03 } },
  // ---------------------------------------------------------------- underbarrel
  vgrip: { id: 'vgrip', slot: 'underbarrel', name: 'Vertical Grip', price: 250, classes: ['smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Vertical recoil −15%'], cons: [],
    mods: { recoil: 0.85 } },
  agrip: { id: 'agrip', slot: 'underbarrel', name: 'Angled Grip', price: 200, classes: ['smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Spread recovers 20% faster', 'Horizontal recoil −10%', 'ADS move speed +5%'], cons: [],
    mods: { recovery: 0.8, sway: 0.9, adsMove: 1.05 } },
  bipod: { id: 'bipod', slot: 'underbarrel', name: 'Bipod', price: 300, classes: ['lmg', 'sniper'],
    pros: ['While crouched: recoil −40%, spread −40%'], cons: ['Move speed −2%'],
    mods: { bipod: true, moveSpeed: 0.98 } },
  // ---------------------------------------------------------------- laser / light
  laser1mw: { id: 'laser1mw', slot: 'laser', name: '1 mW Laser', price: 200, classes: ['pistol', 'smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Hip-fire spread −20%', 'Run-and-gun spread −10%', 'Beam only visible to you'], cons: [],
    mods: { laser: 'red', hip: 0.8, moveSpread: 0.9 } },
  laser5mw: { id: 'laser5mw', slot: 'laser', name: '5 mW Tac Laser', price: 300, classes: ['pistol', 'smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Hip-fire spread −35%', 'Run-and-gun spread −20%'], cons: ['Bright green beam everyone can see'],
    mods: { laser: 'green', hip: 0.65, moveSpread: 0.8 } },
  flashlight: { id: 'flashlight', slot: 'laser', name: 'Tactical Light', price: 200, classes: ['pistol', 'smg', 'shotgun', 'rifle', 'lmg'],
    pros: ['Toggle with L: dazzles enemies you point it at within 14 m (slower aim, glare)'], cons: ['Enemies see the beam when it is on'],
    mods: { light: true } },
  // ---------------------------------------------------------------- magazine
  extmag: { id: 'extmag', slot: 'magazine', name: 'Extended Mag', price: 300, classes: ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'],
    pros: ['Magazine +50% (shotguns +3 shells)'], cons: ['Reload +12%', 'Move speed −2%'],
    mods: { magMul: 1.5, reload: 1.12, moveSpeed: 0.98 } },
  fastmag: { id: 'fastmag', slot: 'magazine', name: 'Fast Mag', price: 250, classes: GUNS,
    pros: ['Reload −25%'], cons: [],
    mods: { reload: 0.75 } },
  drum: { id: 'drum', slot: 'magazine', name: 'Drum Mag', price: 500, classes: ['smg', 'rifle'],
    pros: ['Magazine ×2'], cons: ['Reload +35%', 'Move speed −5%', 'Draw time +15%'],
    mods: { magMul: 2, reload: 1.35, moveSpeed: 0.95, draw: 1.15 } },
  // ---------------------------------------------------------------- stock
  tacstock: { id: 'tacstock', slot: 'stock', name: 'Tactical Stock', price: 200, classes: LONG,
    pros: ['Recoil −10%', 'Run-and-gun spread −10%'], cons: ['ADS move speed −5%'],
    mods: { recoil: 0.9, moveSpread: 0.9, adsMove: 0.95 } },
  lightstock: { id: 'lightstock', slot: 'stock', name: 'Skeleton Stock', price: 150, classes: LONG,
    pros: ['Move speed +4%', 'ADS move speed +8%', 'Draw time −15%'], cons: ['Recoil +8%'],
    mods: { moveSpeed: 1.04, adsMove: 1.08, draw: 0.85, recoil: 1.08 } },
  // ---------------------------------------------------------------- ammo
  fmj: { id: 'fmj', slot: 'ammo', name: 'FMJ Rounds', price: 350, classes: ['pistol', 'smg', 'rifle', 'lmg', 'sniper'],
    pros: ['Wall penetration +60%', 'Armor penetration +8%'], cons: ['Damage −3%'],
    mods: { pen: 1.6, armorPen: 0.08, damage: 0.97 } },
  hollow: { id: 'hollow', slot: 'ammo', name: 'Hollow Points', price: 250, classes: ['pistol', 'smg', 'rifle'],
    pros: ['Damage +8%'], cons: ['Armor penetration −15%', 'Wall penetration −40%'],
    mods: { damage: 1.08, armorPen: -0.15, pen: 0.6 } },
};

export const ATTACHMENT_LIST = Object.values(ATTACHMENTS);

/** Guns that can't take a given slot regardless of class. */
const NO_SLOT: Partial<Record<WeaponId, AttachmentSlot[]>> = {
  warden: ['muzzle'],                    // integral suppressor
  tempest: ['stock'], talon: ['stock'], mako: ['stock'], // bullpups: the stock is the receiver
  judge: ['optic'],
  breacher: ['magazine'],                // tube-fed pump: no box magazine
};

/** Can this attachment go on this gun? */
export function fits(weapon: WeaponId, att: AttachmentId): boolean {
  const def = WEAPONS[weapon], a = ATTACHMENTS[att];
  if (!def || !a || def.slot === 'melee' || def.projectile) return false;
  if (!a.classes.includes(def.class)) return false;
  if (NO_SLOT[weapon]?.includes(a.slot)) return false;
  // snipers / DMRs already have a scope
  if (a.slot === 'optic' && def.scope) return false;
  if (att === 'drum' && def.class === 'rifle' && def.burst) return false;
  return true;
}

/** Attachments that fit a gun, grouped by slot (only slots with at least one option). */
export function optionsFor(weapon: WeaponId): { slot: AttachmentSlot; options: AttachmentDef[] }[] {
  return SLOT_ORDER.map((slot) => ({ slot, options: ATTACHMENT_LIST.filter((a) => a.slot === slot && fits(weapon, a.id)) }))
    .filter((s) => s.options.length > 0);
}

export type Loadout = Partial<Record<AttachmentSlot, AttachmentId>>;

/** Stable key of a loadout (used for caches / model keys). */
export const loadoutKey = (eq: Loadout | undefined): string =>
  eq ? SLOT_ORDER.map((s) => eq[s]).filter(Boolean).join('+') : '';

/** Default aim-down-sights behaviour for guns without an optic. */
export const IRON_ADS = { zoom: 1.18, spread: 0.75, move: 0.8 };

const derived = new Map<string, WeaponDef>();

/**
 * The stats of a gun with attachments: a modified copy of its WeaponDef. Everything in the
 * simulation (damage, spread, recoil, magazine, reload, speed, sound) reads these.
 */
export function deriveDef(id: WeaponId, eq: Loadout | undefined): WeaponDef {
  const base = WEAPONS[id];
  const key = loadoutKey(eq);
  if (!key) return base;
  const cacheKey = id + '|' + key;
  const hit = derived.get(cacheKey);
  if (hit) return hit;
  const m: Required<Pick<AttachmentMods, 'recoil' | 'sway' | 'hip' | 'moveSpread' | 'recovery' | 'adsMove' | 'moveSpeed' | 'reload' | 'draw' | 'magMul' | 'damage' | 'pen' | 'pellet'>> & AttachmentMods =
    { recoil: 1, sway: 1, hip: 1, moveSpread: 1, recovery: 1, adsMove: 1, moveSpeed: 1, reload: 1, draw: 1, magMul: 1, damage: 1, pen: 1, pellet: 1 };
  let rangeAdd = 0, armorAdd = 0, adsSpread = 1;
  const att: AttachmentId[] = [];
  for (const slot of SLOT_ORDER) {
    const aid = eq?.[slot];
    if (!aid || !fits(id, aid)) continue;
    att.push(aid);
    const mods = ATTACHMENTS[aid].mods;
    for (const k of ['recoil', 'sway', 'hip', 'moveSpread', 'recovery', 'adsMove', 'moveSpeed', 'reload', 'draw', 'magMul', 'damage', 'pen', 'pellet'] as const) {
      if (mods[k] !== undefined) m[k] *= mods[k]!;
    }
    if (mods.rangeMod) rangeAdd += mods.rangeMod;
    if (mods.armorPen) armorAdd += mods.armorPen;
    if (mods.adsSpread) adsSpread *= mods.adsSpread;
    if (mods.adsZoom) m.adsZoom = mods.adsZoom;
    for (const flag of ['suppressed', 'smallFlash', 'laser', 'light', 'bipod', 'optic'] as const) if (mods[flag] !== undefined) (m as unknown as Record<string, unknown>)[flag] = mods[flag];
  }
  const shotgun = base.class === 'shotgun';
  const magMul = m.magMul;
  const mag = magMul > 1 && shotgun ? base.mag + 3 : Math.round(base.mag * magMul);
  const d: WeaponDef = {
    ...base,
    damage: base.damage * m.damage,
    armorPen: Math.max(0.2, Math.min(1, base.armorPen + armorAdd)),
    rangeMod: Math.max(0.5, Math.min(0.995, base.rangeMod + rangeAdd)),
    mag,
    reserve: Math.max(base.reserve, Math.round(base.reserve * Math.max(1, magMul * 0.75))),
    reloadTime: base.reloadTime * m.reload,
    drawTime: base.drawTime * m.draw,
    moveSpeed: base.moveSpeed * m.moveSpeed,
    spread: {
      ...base.spread,
      base: shotgun ? base.spread.base * m.pellet : base.spread.base,
      // hip-fire only: inaccuracy() applies it to the stance spread when you are not aiming
      hip: m.hip,
      move: base.spread.move * m.moveSpread,
      recovery: base.spread.recovery * m.recovery,
    },
    recoil: {
      ...base.recoil,
      climb: base.recoil.climb * m.recoil,
      lateClimb: base.recoil.lateClimb * m.recoil,
      kick: base.recoil.kick * m.recoil,
      sway: base.recoil.sway * m.sway,
      jitter: base.recoil.jitter * m.sway,
    },
    sound: m.suppressed ? 'suppressed' : base.sound,
    ads: {
      zoom: m.adsZoom ?? IRON_ADS.zoom,
      spread: IRON_ADS.spread * adsSpread,
      move: IRON_ADS.move * m.adsMove,
    },
    mods: {
      penMul: m.pen, laser: m.laser, light: m.light, bipod: m.bipod, optic: m.optic, smallFlash: m.smallFlash, suppressed: m.suppressed, list: att,
    },
    patternKey: cacheKey,
  };
  derived.set(cacheKey, d);
  return d;
}
