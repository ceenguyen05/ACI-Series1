import { DEFAULT_BINDINGS, type Action } from '../config/controls';
import { DEFAULT_CROSSHAIR, OUTFITS, type AgentLook, type CrosshairSettings } from '../config/cosmetics';
import type { BotDifficulty } from '../config/difficulty';
import type { MatchLength, Team } from '../config/rules';
import type { WeaponId } from '../config/weapons';
import type { ZDifficulty, ZLength } from '../config/zombies';
import { newCareer, restoreCareer, type Career } from '../progression/career';
import { isMapChoice, type SndMapChoice } from '../sim/maps/index';
import type { PaperDollMode } from '../render/PaperDoll';

export type Quality = 'low' | 'medium' | 'high';
export type AimAssist = 'off' | 'low' | 'medium' | 'high';

export interface Settings {
  sensitivity: number;
  zoomSensitivity: number;
  invertY: boolean;
  fov: number;
  viewmodelFov: number;
  leftHanded: boolean;
  leanToggle: boolean;
  /**
   * Crouch key: 'hold' (CS: hold to crouch; keep holding while still to go prone) or
   * 'toggle' (CoD: tap to crouch / stand, hold to go prone, Space to stand up).
   */
  crouchMode: 'hold' | 'toggle';
  adsToggle: boolean;
  showFps: boolean;
  rotateRadar: boolean;
  radarZoom: number;
  masterVolume: number;
  sfxVolume: number;
  uiVolume: number;
  renderScale: number;
  quality: Quality;
  /** Mouse aim assist: slow-down + gentle pull near visible enemies. Never applies to bots. */
  aimAssist: AimAssist;
  /** Replay the round-winning kill (CoD-style final killcam). */
  killcam: boolean;
  /** Spoken round announcer (browser speech synthesis). */
  announcer: boolean;
  /** On-screen markers for bomb sites, the planted bomb and a dropped bomb. */
  objectiveMarkers: boolean;
  /** Short gameplay tips during the first rounds. */
  tips: boolean;
  /** Minecraft-style paper doll: a live model of your character in the top-right corner. */
  paperDoll: PaperDollMode;
  /** Paper doll size (1 = 150 × 186 px). */
  paperDollSize: number;
  /** Dotted arc of a grenade's flight while you hold it ready to throw. */
  grenadePreview: boolean;
  /** Numbers floating off whoever you damage. */
  damageNumbers: boolean;
  /** Badges around the crosshair pointing at live grenades that can hurt or blind you. */
  grenadeWarnings: boolean;
  bindings: Record<Action, string>;
  crosshair: CrosshairSettings;
}

export interface MatchPrefs {
  side: Team | 'auto';
  teamSize: number;
  difficulty: BotDifficulty;
  length: MatchLength;
  freezeTime: number;
  friendlyFire: boolean;
  killstreaks: boolean;
  /** Search & Destroy map: a specific map or 'random'. */
  map: SndMapChoice;
}

/** Zombies setup remembered between games. */
export interface ZombiePrefs { players: 1 | 3 | 5; difficulty: ZDifficulty; length: ZLength }
export interface ZombieStats {
  games: number; kills: number; headshots: number; downs: number; revives: number; exfils: number;
  /** Highest wave reached per difficulty. */
  best: Partial<Record<ZDifficulty, number>>;
}

export interface Profile {
  name: string;
  looks: Record<Team, AgentLook>;
  finishes: Partial<Record<WeaponId, string>>;
  stats: { matches: number; wins: number; kills: number; deaths: number; mvps: number };
  match: MatchPrefs;
  zombies: ZombiePrefs;
  zstats: ZombieStats;
  settings: Settings;
  career: Career;
  onlineCareer: Career | null;
}

const KEY = 'aci-snd-profile-v1';

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 2.0, zoomSensitivity: 1.0, invertY: false, fov: 90, viewmodelFov: 60, leftHanded: false,
  leanToggle: false, crouchMode: 'hold', adsToggle: false, showFps: true, rotateRadar: true, radarZoom: 1,
  masterVolume: 0.7, sfxVolume: 1, uiVolume: 0.6, renderScale: 1, quality: 'medium', aimAssist: 'low', killcam: true, announcer: true, objectiveMarkers: true, tips: true,
  paperDoll: 'off', paperDollSize: 1, grenadePreview: true, damageNumbers: true, grenadeWarnings: true,
  bindings: { ...DEFAULT_BINDINGS }, crosshair: { ...DEFAULT_CROSSHAIR },
};

export function defaultProfile(): Profile {
  return {
    name: 'Player',
    looks: {
      T: { ...OUTFITS.find((o) => o.team === 'T')!.look },
      CT: { ...OUTFITS.find((o) => o.team === 'CT')!.look },
    },
    finishes: {},
    stats: { matches: 0, wins: 0, kills: 0, deaths: 0, mvps: 0 },
    match: { side: 'auto', teamSize: 5, difficulty: 'normal', length: 'short', freezeTime: 10, friendlyFire: false, killstreaks: true, map: 'random' },
    zombies: { players: 3, difficulty: 'normal', length: 'short' },
    zstats: { games: 0, kills: 0, headshots: 0, downs: 0, revives: 0, exfils: 0, best: {} },
    settings: structuredClone(DEFAULT_SETTINGS),
    career: newCareer(), onlineCareer: null,
  };
}

/** localStorage-backed profile (per-browser). Every read/write is guarded. */
export function loadProfile(): Profile {
  const base = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Profile>;
    return {
      ...base, ...p,
      career: restoreCareer(p.career), onlineCareer: p.onlineCareer ? restoreCareer(p.onlineCareer) : null,
      looks: { T: { ...base.looks.T, ...p.looks?.T }, CT: { ...base.looks.CT, ...p.looks?.CT } },
      stats: { ...base.stats, ...p.stats },
      match: { ...base.match, ...p.match, map: isMapChoice(p.match?.map) ? p.match!.map : base.match.map },
      zombies: { ...base.zombies, ...p.zombies },
      zstats: { ...base.zstats, ...p.zstats, best: { ...base.zstats.best, ...p.zstats?.best } },
      settings: {
        ...base.settings, ...p.settings,
        // V became quick melee: older profiles had cameras on V, move them to T
        bindings: { ...base.settings.bindings, ...p.settings?.bindings, ...(p.settings?.bindings?.cams === 'KeyV' && !p.settings?.bindings?.quickMelee ? { cams: 'KeyT' } : {}) },
        crosshair: { ...base.settings.crosshair, ...p.settings?.crosshair },
      },
    };
  } catch {
    return base;
  }
}

export function saveProfile(p: Profile) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
