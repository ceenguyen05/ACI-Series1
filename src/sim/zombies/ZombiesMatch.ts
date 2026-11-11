import { Vector3 } from 'three';
import { Match } from '../mode/Match';
import { Agent, emptyCommand, type AgentCommand, type HitGroup } from '../entities/Agent';
import { motorRadii, stepMotor } from '../physics/CharacterMotor';
import { equip, equipBest } from '../combat/WeaponSystem';
import { explode } from '../combat/Explosion';
import type { DamageResult } from '../combat/damage';
import type { DamageFlags } from '../SimContext';
import type { Box } from '../physics/CollisionWorld';
import type { Device } from '../gadget/GadgetManager';
import { WEAPONS, type WeaponId } from '../../config/weapons';
import { OUTFITS, type AgentLook } from '../../config/cosmetics';
import type { Team } from '../../config/rules';
import { MOVE } from '../../config/movement';
import { GADGETS } from '../../config/gadgets';
import {
  ARMORY, BOX_POOL, BOX_PRICE, BOX_TUNING, FIRE_SALE_PRICE, FORGE_PRICE, FORGED_AMMO_PRICE, GAIT_SPEED, PERKS, PERK_LIMIT, POINTS, POWERUPS,
  POWERUP_ORDER, POWERUP_TUNING as PU, SOLO_SELF_REVIVES, START_WEAPON, ZDIFF, ZLENGTHS, ZOMBIES, ZOMBIE_ORDER, ZOMBIE_TUNING as T,
  ammoPrice, frenzyCount, rollGait, spawnDelay, teddyChance, waveCount, waveKind, zombieHealth,
  type ArmoryId, type PerkId, type PowerUpId, type WaveKind, type ZDifficulty, type ZDifficultyDef, type ZLength, type ZombieKind,
} from '../../config/zombies';
import { MACHINE_SIZE, cellRectWorld, wallPlace, type WallSpot, type ZGateDef, type ZombiesLayout } from '../maps/aciHqZombies';
import { FlowField } from './FlowField';
import { emptyZStats, type ZombieState } from './types';
import { refreshWeapon, zWeapon } from './zweapons';
import { AllyBot } from './AllyBot';
import { angleDiff, clamp, wrapAngle, yawTo } from '../../core/math';

export interface ZombiesConfig {
  layout: ZombiesLayout;
  difficulty: ZDifficulty;
  /** Squad size including you: 1, 3 or 5 (teammates are bots). */
  players: number;
  length: ZLength;
  playerName: string;
  playerLook: Record<Team, AgentLook>;
  /** All-bot squad (attract mode / tests). */
  spectate?: boolean;
  seed?: number;
  /** Debug / tests: begin on this wave with this many points. */
  startWave?: number;
  startPoints?: number;
  networkRoster?: { id: number; name: string; isBot: boolean; look: Record<Team, AgentLook> }[];
  localPlayerId?: number;
  poolIds?: number[];
}

export interface Placed { x: number; z: number; yaw: number }
export interface GateState { def: ZGateDef; open: boolean; openedAt: number; box: Box | null; key: number; rect: { x0: number; z0: number; x1: number; z1: number }; center: Vector3; lintel: number }
export interface WallBuyState { weapon: WeaponId; price: number; pos: Vector3; yaw: number }
export interface PerkMachine { perk: PerkId; pos: Vector3; yaw: number; soldOut: boolean }
export interface BoxState {
  spot: number; pos: Vector3; yaw: number; state: 'idle' | 'spinning' | 'ready' | 'teddy' | 'moving';
  until: number; weapon: WeaponId | null; userId: number | null; pulls: number; moved: boolean; teddy: boolean; spotsPos: Placed[]; startedAt: number;
}
export interface ForgeState { pos: Vector3; yaw: number; state: 'idle' | 'working' | 'ready'; until: number; weapon: WeaponId | null; ownerId: number | null; startedAt: number }
export interface PowerUp { id: number; kind: PowerUpId; pos: Vector3; born: number }
export interface Hazard { id: number; pos: Vector3; start: number; until: number; radius: number }
export interface Spit { id: number; pos: Vector3; vel: Vector3; ownerId: number; born: number }
export type ExfilPhase = 'none' | 'available' | 'called' | 'holding' | 'extracted' | 'failed';

export type InteractionKind = 'revive' | 'wallBuy' | 'ammo' | 'gate' | 'perk' | 'box' | 'boxTake' | 'forge' | 'forgeTake' | 'power' | 'armory' | 'radio' | 'ammoCrate';
export interface Interaction {
  kind: InteractionKind;
  /** What it is ("Vespa SMG", "Security Doors"…). */
  label: string;
  verb: string;
  price: number;
  ok: boolean;
  reason: string;
  hold: boolean;
  ref: number;
  progress?: number;
}

const POOL = 36;
const HUMAN_COLORS = ['#ffcf4a', '#5ec8ff', '#7ee06a', '#ff8a5a', '#d58aff'];
const BOT_NAMES = ['Rivet', 'Torque', 'Ledger', 'Badge', 'Sprocket', 'Keycard', 'Forklift', 'Memo'];
const ZOMBIE_LOOK: AgentLook = { ...OUTFITS[0].look };
const EXPLOSIVE = new Set(['frag', 'thumper', 'hammer', 'disruptor', 'c4', 'mine', 'hunter', 'bomber', 'lure', 'explosion', 'missile']);
const tmpV = new Vector3(), tmpV2 = new Vector3();

/** Machine and wall-buy placements of a layout (shared by the simulation and the view). */
export function layoutPlacements(layout: ZombiesLayout) {
  const map = layout.map;
  const place = (at: WallSpot, d: number) => wallPlace(map, at, d);
  return {
    perks: layout.perks.map((p) => ({ perk: p.perk, ...place(p.at, MACHINE_SIZE.perk.d) })),
    boxes: layout.boxSpots.map((s) => place(s, MACHINE_SIZE.box.d)),
    forge: place(layout.forge, MACHINE_SIZE.forge.d),
    power: place(layout.power, MACHINE_SIZE.power.d),
    armory: place(layout.armory, MACHINE_SIZE.armory.d),
    wallBuys: layout.wallBuys.map((w) => ({ weapon: w.weapon, price: w.price, ...place(w.at, MACHINE_SIZE.wallBuy.d) })),
    blocked: layout.blocked.map((c) => cellRectWorld(map, c)),
  };
}

function machineBox(p: Placed, size: { w: number; d: number; h: number }): Omit<Box, 'id'> {
  const alongX = Math.abs(Math.sin(p.yaw)) < 0.5; // facing ±Z → width runs along X
  const hx = (alongX ? size.w : size.d) / 2, hz = (alongX ? size.d : size.w) / 2;
  return { minX: p.x - hx, maxX: p.x + hx, minZ: p.z - hz, maxZ: p.z + hz, minY: 0, maxY: size.h, surface: 'metal' };
}

/** Static colliders for machines and boarded-up doorways. */
export function layoutColliders(layout: ZombiesLayout): Omit<Box, 'id'>[] {
  const pl = layoutPlacements(layout);
  const out: Omit<Box, 'id'>[] = [];
  for (const p of pl.perks) out.push(machineBox(p, MACHINE_SIZE.perk));
  for (const b of pl.boxes) out.push(machineBox(b, MACHINE_SIZE.box));
  out.push(machineBox(pl.forge, MACHINE_SIZE.forge), machineBox(pl.power, MACHINE_SIZE.power), machineBox(pl.armory, MACHINE_SIZE.armory));
  for (const r of pl.blocked) out.push({ minX: r.x0, maxX: r.x1, minZ: r.z0, maxZ: r.z1, minY: 0, maxY: 6, surface: 'metal' });
  return out;
}

/**
 * Zombies: round-based survival on ACI HQ (Call of Duty style). Players (you + bot teammates)
 * hold the building against escalating waves, earn points per hit and kill, and spend them
 * on doors, wall weapons, perks, the Mystery Box, the Prototype Forge and the Armory.
 * Zombies are pooled Agents on the T team, so bullets, grenades, gadgets and the renderer
 * work on them unchanged.
 */
export class ZombiesMatch extends Match {
  readonly zc: ZombiesConfig;
  readonly layout: ZombiesLayout;
  readonly diff: ZDifficultyDef;
  readonly humans: Agent[] = [];
  readonly zombiePool: Agent[] = [];
  readonly allies = new Map<number, AllyBot>();
  readonly flow: FlowField;
  readonly lureFlow: FlowField;
  readonly gates: GateState[] = [];
  readonly wallBuys: WallBuyState[] = [];
  readonly perkMachines: PerkMachine[] = [];
  readonly box: BoxState;
  readonly forge: ForgeState;
  readonly powerPos: Placed;
  readonly armoryPos: Placed;
  readonly zoneOpen: Record<string, boolean> = {};
  readonly spawnPoints: { x: number; z: number; zone: string }[] = [];
  private zoneGrid: Int8Array;

  power = false;
  wave = 0;
  /** Waves fully cleared (the end screen's "survived N waves"; replicated). */
  wavesCleared = 0;
  wavePhase: 'pre' | 'active' | 'intermission' | 'exfil' | 'over' = 'pre';
  waveKindNow: WaveKind = 'normal';
  phaseUntil = 0;
  waveTotal = 0;
  spawned = 0;
  killedThisWave = 0;
  private bossQueue = 0;
  private screamExtra = 0;
  private nextSpawnAt = 0;
  private lastKillPos = new Vector3();
  private lastKillAt = 0;

  powerUps: PowerUp[] = [];
  private puDrops = 0;
  private puThreshold: number;
  private puIncrement: number;
  private teamEarned = 0;
  timers: Record<'instaKill' | 'doublePoints' | 'fireSale', number> = { instaKill: 0, doublePoints: 0, fireSale: 0 };
  gas: Hazard[] = [];
  acid: Hazard[] = [];
  spits: Spit[] = [];
  private pendingBlasts: { pos: Vector3; at: number; ownerId: number }[] = [];
  private hazardAcc = new Map<number, number>();
  private nextId = 1;
  private reviving = new Map<number, number>();
  private stepDt = 1 / 64;

  exfil: { phase: ExfilPhase; until: number } = { phase: 'none', until: 0 };
  gameOver = false;
  won = false;
  totalKills = 0;

  constructor(zc: ZombiesConfig) {
    const diff = ZDIFF[zc.difficulty];
    super({
      map: zc.layout.map, difficulty: diff.allies, playerTeam: 'CT', playerName: zc.playerName, playerLook: zc.playerLook, seed: zc.seed,
      mode: 'zombies', worldExtras: layoutColliders(zc.layout),
      rules: { friendlyFire: false, killstreaks: false, maxMoney: 99_999_999, startMoney: zc.startPoints ?? diff.startPoints, freezeTime: 0, roundTime: 1e9, teamSize: zc.players },
    });
    this.zc = zc;
    this.layout = zc.layout;
    this.diff = diff;
    this.phase = 'live';
    this.puThreshold = this.puIncrement = PU.firstThreshold;
    const map = this.layout.map;

    // ---- zones
    this.zoneGrid = new Int8Array(map.cols * map.rows).fill(-1);
    this.layout.zones.forEach((z, zi) => {
      this.zoneOpen[z.id] = z.id === this.layout.startZone;
      for (const [c0, r0, c1, r1] of z.cells) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.zoneGrid[r * map.cols + c] = zi;
    });

    // ---- machines
    const pl = layoutPlacements(this.layout);
    for (const w of pl.wallBuys) this.wallBuys.push({ weapon: w.weapon, price: w.price, pos: new Vector3(w.x, 1.45, w.z), yaw: w.yaw });
    for (const p of pl.perks) this.perkMachines.push({ perk: p.perk, pos: new Vector3(p.x, 0, p.z), yaw: p.yaw, soldOut: false });
    const bs = pl.boxes[this.layout.boxStart];
    this.box = { spot: this.layout.boxStart, pos: new Vector3(bs.x, 0, bs.z), yaw: bs.yaw, state: 'idle', until: 0, weapon: null, userId: null, pulls: 0, moved: false, teddy: false, spotsPos: pl.boxes, startedAt: 0 };
    this.forge = { pos: new Vector3(pl.forge.x, 0, pl.forge.z), yaw: pl.forge.yaw, state: 'idle', until: 0, weapon: null, ownerId: null, startedAt: 0 };
    this.powerPos = pl.power;
    this.armoryPos = pl.armory;

    // ---- gates (closed shutters are dynamic colliders + nav blocks)
    this.layout.gates.forEach((g, i) => {
      const rect = cellRectWorld(map, g.cells);
      const door = map.doors.find((d) => d.c0 === g.cells[0] && d.r0 === g.cells[1] && d.c1 === g.cells[2] && d.r1 === g.cells[3]);
      const lintel = door?.lintel ?? 3;
      const st: GateState = { def: g, open: false, openedAt: -1, box: null, key: -1000 - i, rect, center: new Vector3((rect.x0 + rect.x1) / 2, 0, (rect.z0 + rect.z1) / 2), lintel };
      this.closeGate(st);
      this.gates.push(st);
    });

    this.flow = new FlowField(this.world.nav);
    this.lureFlow = new FlowField(this.world.nav);
    this.computeSpawnPoints();

    // ---- squad
    const names = this.rng.shuffle([...BOT_NAMES]);
    const ctLooks = OUTFITS.filter((o) => o.team === 'CT');
    const n = Math.max(1, Math.min(5, zc.players));
    for (let i = 0; i < n; i++) {
      const member = zc.networkRoster?.[i];
      const isPlayer = member ? member.id === zc.localPlayerId : i === 0 && !zc.spectate;
      const isBot = member ? member.isBot : !isPlayer;
      const look: Record<Team, AgentLook> = member?.look ?? (isPlayer ? zc.playerLook : { T: { ...OUTFITS[0].look }, CT: { ...this.rng.pick(ctLooks).look } });
      const a = new Agent(member?.name ?? (isPlayer ? (zc.playerName || 'Player') : names[i % names.length]), 'CT', isBot, look, member?.id);
      a.money = this.rules.startMoney;
      a.zp = {
        perks: [], downed: false, downedAt: 0, bleedUntil: 0, selfReviveAt: 0, revive: null, dead: false, selfRevives: SOLO_SELF_REVIVES, reviveKit: false,
        lastHurt: -10, protectedUntil: 0, shockReadyAt: 0, wasReloading: false, usePrev: false, color: HUMAN_COLORS[i % HUMAN_COLORS.length], stats: emptyZStats(),
      };
      this.humans.push(a);
      this.agents.push(a);
      if (isPlayer) this.player = a;
      else if (isBot) this.allies.set(a.id, new AllyBot(a, this, diff.allies));
    }
    this.humans.forEach((a, i) => this.spawnHuman(a, this.layout.playerSpawns[i % this.layout.playerSpawns.length]));
    // solo players get one free self-revive to start with (casual-friendly, Cold War style)
    if (this.humans.length === 1) this.humans[0].zp!.reviveKit = true;

    // ---- zombie pool
    for (let i = 0; i < POOL; i++) {
      const z = new Agent('Zombie', 'T', true, { T: ZOMBIE_LOOK, CT: ZOMBIE_LOOK }, zc.poolIds?.[i]);
      z.alive = false; z.deathTime = -1e9;
      z.secondary = null; z.primary = null; z.active = 'melee';
      z.zombie = this.blankZombie();
      this.zombiePool.push(z);
      this.agents.push(z);
    }

    // lure beacons explode when their tune ends
    this.events.on('detonate', (e) => {
      if (e.kind !== 'decoy') return;
      const owner = this.getAgent(e.ownerId);
      explode(this, e.pos.clone().setY(e.pos.y + 0.3), 5, 170, owner, 'lure');
      this.events.emit('zBlast', { kind: 'lure', pos: e.pos.clone(), radius: 5 });
    });

    const start = zc.startWave ?? 1;
    this.wave = start - 1;
    this.wavesCleared = start - 1;
    this.phaseUntil = this.time + (start > 1 ? 2 : T.firstWaveDelay);
    this.computeFlow();
  }

  private blankZombie(): ZombieState {
    return {
      kind: 'walker', gait: 'walk', speed: 1.4, active: false, mode: 'chase', modeAt: 0, modeUntil: 0, targetId: null, attackTargetId: null, nextAttack: 0, arm: 1, nextSpecial: 0,
      enragedUntil: 0, slowUntil: 0, helmet: 0, vest: 0, helmetMax: 0, vestMax: 0, charge: null, nextVoice: 0, checkAt: 0, checkX: 0, checkZ: 0, stuckFor: 0,
      headless: false, freeAt: 0, lured: false, gen: 0, boss: false,
    };
  }

  // ======================================================================== queries
  override isFrozen() { return false; }
  override canBuyNow() { return false; }
  override isPistolRound() { return false; }
  override timeLeft() { return Math.max(0, this.phaseUntil - this.time); }

  zoneIndexAt(x: number, z: number): number {
    const map = this.layout.map;
    const c = Math.floor((x - map.originX) / map.cellSize), r = Math.floor((z - map.originZ) / map.cellSize);
    if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return -1;
    return this.zoneGrid[r * map.cols + c];
  }
  /** Area name for the HUD location line. */
  areaName(x: number, z: number): string {
    const i = this.zoneIndexAt(x, z);
    if (i >= 0) return this.layout.zones[i].name;
    const g = this.gates.find((gt) => x >= gt.rect.x0 - 0.5 && x <= gt.rect.x1 + 0.5 && z >= gt.rect.z0 - 0.5 && z <= gt.rect.z1 + 0.5);
    return g ? g.def.name : '';
  }
  zoneAt(x: number, z: number): string | null {
    const i = this.zoneIndexAt(x, z);
    return i >= 0 ? this.layout.zones[i].id : null;
  }
  standing(): Agent[] { return this.humans.filter((h) => h.alive && !h.zp!.downed); }
  aliveZombies(): Agent[] { return this.zombiePool.filter((z) => z.alive); }
  zombiesLeft(): number { return this.wavePhase === 'active' ? Math.max(0, this.waveTotal - this.killedThisWave) : this.aliveZombies().length; }
  hasPerk(a: Agent, p: PerkId) { return !!a.zp?.perks.includes(p); }
  timerLeft(k: keyof ZombiesMatch['timers']) { return Math.max(0, this.timers[k] - this.time); }
  exfilAvailableWave(): boolean {
    const from = ZLENGTHS[this.zc.length].exfilFrom;
    return from !== null && this.wave >= from && this.wave % 5 === 0;
  }
  boxPrice() { return this.time < this.timers.fireSale ? FIRE_SALE_PRICE : BOX_PRICE; }
  perkPrice(p: PerkId) { const d = PERKS[p]; return this.humans.length === 1 && d.soloPrice ? d.soloPrice : d.price; }

  // ======================================================================== setup helpers
  private closeGate(g: GateState) {
    const r = g.rect;
    g.box = this.world.collision.addDynamic({ minX: r.x0, maxX: r.x1, minZ: r.z0, maxZ: r.z1, minY: 0, maxY: g.lintel, surface: 'metal' });
    this.world.nav.block(g.key, r.x0, r.z0, r.x1, r.z1);
  }

  private computeSpawnPoints() {
    const nav = this.world.nav, map = this.layout.map;
    const avoid: { x: number; z: number }[] = [];
    for (const g of this.gates) avoid.push({ x: g.center.x, z: g.center.z });
    const pl = layoutPlacements(this.layout);
    for (const b of pl.blocked) avoid.push({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 });
    for (const p of [...pl.perks, ...pl.boxes, pl.forge, pl.power, pl.armory, ...pl.wallBuys]) avoid.push(p);
    for (const d of map.doors) avoid.push({ x: map.originX + (d.c0 + d.c1 + 1) * map.cellSize / 2, z: map.originZ + (d.r0 + d.r1 + 1) * map.cellSize / 2 });
    this.layout.zones.forEach((zone, zi) => {
      const cand: { x: number; z: number }[] = [];
      for (let r = 0; r < nav.rows; r += 2) for (let c = 0; c < nav.cols; c += 2) {
        if (!nav.isWalkable(c, r) || nav.clearance[r * nav.cols + c] < 3) continue;
        const p = nav.center(c, r);
        if (this.zoneIndexAt(p.x, p.z) !== zi) continue;
        if (avoid.some((a) => Math.hypot(a.x - p.x, a.z - p.z) < 2.6)) continue;
        if (this.layout.playerSpawns.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 6)) continue;
        cand.push(p);
      }
      if (!cand.length) return;
      // farthest-point sampling spreads the spawns around the zone
      const picked = [cand[Math.floor(this.rng.next() * cand.length)]];
      const want = Math.min(cand.length, zone.id === 'yard' ? 16 : 12);
      while (picked.length < want) {
        let best = cand[0], bestD = -1;
        for (const c of cand) {
          const d = Math.min(...picked.map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
          if (d > bestD) { bestD = d; best = c; }
        }
        if (bestD < 2.5) break;
        picked.push(best);
      }
      for (const p of picked) this.spawnPoints.push({ x: p.x, z: p.z, zone: zone.id });
    });
  }

  private spawnHuman(a: Agent, s: { x: number; z: number; yaw: number }) {
    const zp = a.zp!;
    a.maxHealth = 100;
    a.resetForRound(false, START_WEAPON);
    a.secondary = zWeapon(START_WEAPON, 0, zp.perks);
    a.primary = null;
    a.active = 'secondary';
    a.grenades.frag = 2;
    a.motor.pos.set(s.x, this.world.collision.groundHeight(s.x, s.z, 1), s.z);
    a.motor.onGround = true;
    a.yaw = s.yaw; a.pitch = 0; a.motor.bodyYaw = s.yaw;
    zp.downed = false; zp.dead = false; zp.revive = null; zp.selfReviveAt = 0; zp.bleedUntil = 0;
    this.allies.get(a.id)?.reset();
  }

  // ======================================================================== main step
  override replaceWithBot(id: number) {
    const a = this.humans.find(h => h.id === id);
    if (!a || this.allies.has(id)) return;
    a.isBot = true; a.name = `BOT ${a.name}`; this.humanCommands.delete(id);
    if (a.operating !== null) this.gadgets.operate(a, null);
    const bot = new AllyBot(a, this, this.diff.allies); this.allies.set(id, bot); bot.reset();
  }

  override step(dt: number) {
    this.time += dt;
    this.tick++;
    if (this.gameOver) return;
    this.stepDt = dt;
    this.losCache.clear();
    if (!this.gameOver) this.updateWaves();
    if (this.tick % 12 === 0) this.computeFlow();
    // Clear abandoned revives before bleed-out and before another teammate takes over.
    for (const [rid, tid] of this.reviving) {
      const r = this.getAgent(rid), t = this.getAgent(tid);
      if (!r?.alive || r.zp?.downed || !t?.alive || !t.zp?.downed || !this.canRevive(r, t)) {
        if (r) this.stopRevive(r); else this.reviving.delete(rid);
      }
    }
    for (const h of this.humans) this.updateHuman(h, dt);
    for (const z of this.zombiePool) if (z.alive) this.updateZombie(z, dt);
    this.resolveBodies();
    this.utility.update(dt);
    this.gadgets.update(dt);
    this.ordnance.update(dt);
    this.updateWeaponLights();
    if (this.tick % 4 === 0) this.updateSpotting();
    this.updateHazards(dt);
    this.updatePowerUps();
    this.updateMachines();
    this.updateExfil();
    for (const z of this.zombiePool) if (!z.alive && z.zombie!.active && this.time >= z.zombie!.freeAt) z.zombie!.active = false;
    if (!this.gameOver) this.checkGameOver();
  }

  /** Radar proximity: zombies near any standing player show up (no line of sight needed). */
  protected override updateSpotting() {
    const st = this.standing();
    for (const z of this.zombiePool) {
      if (!z.alive) continue;
      if (st.some((h) => Math.abs(h.pos.x - z.pos.x) < 18 && Math.abs(h.pos.z - z.pos.z) < 18 && h.pos.distanceTo(z.pos) < 18)) z.spottedUntil = this.time + 0.35;
    }
  }
  protected override checkWin() { /* see checkGameOver */ }
  protected override updatePlantDefuse() { /* no bomb in zombies */ }

  // ======================================================================== waves
  private updateWaves() {
    const now = this.time;
    if (this.wavePhase === 'pre' || this.wavePhase === 'intermission') {
      if (now >= this.phaseUntil) this.startWave();
      return;
    }
    if (this.wavePhase === 'exfil') { this.spawnTick(true); return; }
    if (this.wavePhase !== 'active') return;
    this.spawnTick(false);
    if (this.spawned >= this.waveTotal && !this.zombiePool.some((z) => z.alive)) this.endWave();
    else if (now - this.lastKillAt > 75) {
      this.lastKillAt = now;
      for (const z of this.zombiePool) if (z.alive && z.zombie!.mode !== 'rise' && !this.seenByHuman(z)) this.reemerge(z);
    }
  }

  private startWave() {
    this.wave++;
    this.waveKindNow = waveKind(this.wave);
    const n = this.humans.length;
    const kind = this.waveKindNow;
    this.waveTotal = kind === 'frenzy' ? frenzyCount(this.wave, n, this.diff) : waveCount(this.wave, n, this.diff);
    this.bossQueue = kind === 'boss' ? 1 + Math.floor((this.wave - 10) / 10) : 0;
    this.waveTotal += this.bossQueue;
    this.spawned = 0; this.killedThisWave = 0; this.screamExtra = 0; this.puDrops = 0;
    this.lastKillAt = this.time;
    this.nextSpawnAt = this.time + 1.2;
    this.wavePhase = 'active';
    for (const h of this.humans) {
      const zp = h.zp!;
      if (zp.dead) this.respawnHuman(h);
      else if (h.alive) h.grenades.frag = Math.min(4, h.grenades.frag + 2);
    }
    this.events.emit('zWave', { wave: this.wave, kind, state: 'start', count: this.waveTotal, bonus: 0 });
    if (this.exfilAvailableWave() && this.exfil.phase === 'none') { this.exfil.phase = 'available'; this.events.emit('zExfil', { state: 'available', until: 0 }); }
  }

  private endWave() {
    const bonus = POINTS.waveBonus(this.wave);
    for (const h of this.standing()) this.addPoints(h, bonus, 'Wave cleared', false);
    this.events.emit('zWave', { wave: this.wave, kind: this.waveKindNow, state: 'end', count: this.killedThisWave, bonus });
    this.wavesCleared = this.wave;
    this.wavePhase = 'intermission';
    this.phaseUntil = this.time + T.intermission;
  }

  private spawnTick(exfil: boolean) {
    const now = this.time;
    if (now < this.nextSpawnAt) return;
    if (!exfil && this.spawned >= this.waveTotal) return;
    const alive = this.zombiePool.filter((z) => z.alive).length;
    if (alive >= T.maxAlive) return;
    let kind: ZombieKind | null;
    if (!exfil && this.bossQueue > 0 && this.spawned >= Math.floor(this.waveTotal * 0.25)
      && this.zombiePool.filter((z) => z.alive && z.zombie!.kind === 'tank').length < ZOMBIES.tank.maxAlive) kind = 'tank';
    else kind = this.pickKind(exfil);
    if (!kind) return;
    // Reserve remaining slots for scheduled bosses; never silently omit one at the cap.
    if (!exfil && kind !== 'tank' && this.waveTotal - this.spawned <= this.bossQueue) return;
    const sp = this.pickSpawn(exfil, kind);
    if (!sp) { this.nextSpawnAt = now + 0.5; return; }
    if (!this.spawnZombie(kind, sp.x, sp.z)) { this.nextSpawnAt = now + 0.25; return; }
    if (kind === 'tank' && this.bossQueue > 0) this.bossQueue--;
    if (!exfil) this.spawned++;
    const frenzy = this.waveKindNow === 'frenzy';
    this.nextSpawnAt = now + (exfil ? 0.45 : frenzy ? 0.55 : spawnDelay(this.wave) * (this.humans.length > 1 ? 0.85 : 1));
  }

  private pickKind(exfil: boolean): ZombieKind | null {
    const counts = new Map<ZombieKind, number>();
    for (const z of this.zombiePool) if (z.alive) counts.set(z.zombie!.kind, (counts.get(z.zombie!.kind) ?? 0) + 1);
    const opts: [ZombieKind, number][] = [];
    if (this.waveKindNow === 'frenzy' && !exfil) {
      if ((counts.get('runner') ?? 0) < ZOMBIES.runner.maxAlive) opts.push(['runner', 60]);
      if ((counts.get('crawler') ?? 0) < ZOMBIES.crawler.maxAlive) opts.push(['crawler', 28]);
      if (this.wave >= 8 && (counts.get('bomber') ?? 0) < ZOMBIES.bomber.maxAlive) opts.push(['bomber', 12]);
    } else {
      for (const k of ZOMBIE_ORDER) {
        const d = ZOMBIES[k];
        if (k === 'tank' || !d.weight) continue;
        const first = k === 'walker' ? 1 : Math.max(2, d.firstWave + this.diff.specialShift);
        if (this.wave < first || (counts.get(k) ?? 0) >= d.maxAlive) continue;
        opts.push([k, k === 'walker' ? d.weight : d.weight * Math.min(1.8, 1 + (this.wave - first) * 0.06)]);
      }
    }
    if (!opts.length) return null;
    const total = opts.reduce((s, [, w]) => s + w, 0);
    let r = this.rng.next() * total;
    for (const [k, w] of opts) { r -= w; if (r <= 0) return k; }
    return opts[0]?.[0] ?? 'walker';
  }

  /** Left-4-Dead-style placement: an open zone near the players, preferably out of sight. */
  private pickSpawn(exfil: boolean, kind: ZombieKind): { x: number; z: number } | null {
    const st = this.standing();
    const targets = st.length ? st : this.humans.filter((h) => h.alive);
    if (!targets.length) return null;
    const lz = this.layout.lz;
    const playerZones = new Set(targets.map((h) => this.zoneAt(h.pos.x, h.pos.z)));
    const adjacent = new Set<string>();
    for (const g of this.gates) if (g.open && (playerZones.has(g.def.zones[0]) || playerZones.has(g.def.zones[1]))) { adjacent.add(g.def.zones[0]); adjacent.add(g.def.zones[1]); }
    const scored: { p: { x: number; z: number }; w: number; hidden: boolean }[] = [];
    const minD = kind === 'tank' ? 14 : 9;
    for (const p of this.spawnPoints) {
      if (!this.zoneOpen[p.zone]) continue;
      if (exfil && Math.hypot(p.x - lz.x, p.z - lz.z) > 48) continue;
      let d = Infinity;
      for (const h of targets) d = Math.min(d, Math.hypot(h.pos.x - p.x, h.pos.z - p.z));
      if (d < minD || d > 42) continue;
      const w = playerZones.has(p.zone) ? 3 : adjacent.has(p.zone) ? 2 : 0.6;
      scored.push({ p, w: w * (d < 22 ? 1.2 : 1), hidden: true });
    }
    if (!scored.length) {
      // nothing in range: the nearest open spawn that isn't on top of anyone
      let best: { x: number; z: number } | null = null, bestD = Infinity;
      for (const p of this.spawnPoints) {
        if (!this.zoneOpen[p.zone]) continue;
        let d = Infinity;
        for (const h of targets) d = Math.min(d, Math.hypot(h.pos.x - p.x, h.pos.z - p.z));
        if (d >= 7 && d < bestD) { bestD = d; best = p; }
      }
      return best;
    }
    // prefer points no one can see (test a handful)
    this.rng.shuffle(scored);
    const sample = scored.slice(0, 10);
    for (const s of sample) {
      const at = tmpV.set(s.p.x, 1.2, s.p.z);
      s.hidden = !targets.some((h) => !this.world.collision.segmentBlocked(h.eyePos(tmpV2), at));
    }
    const hidden = sample.filter((s) => s.hidden);
    const pool = hidden.length ? hidden : sample;
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = this.rng.next() * total;
    for (const s of pool) { r -= s.w; if (r <= 0) return s.p; }
    return pool[0].p;
  }

  /** Activate a pooled zombie. Returns false if every slot is busy. */
  spawnZombie(kind: ZombieKind, x: number, z: number): Agent | null {
    const a = this.zombiePool.find((s) => !s.zombie!.active && !s.alive);
    if (!a) return null;
    const d = ZOMBIES[kind], zs = a.zombie!;
    const gen = zs.gen + 1;
    Object.assign(zs, this.blankZombie());
    zs.gen = gen;
    zs.kind = kind;
    zs.active = true;
    zs.gait = d.gait ?? rollGait(this.wave, this.diff, this.rng.next());
    const range = d.speed ?? GAIT_SPEED[zs.gait];
    zs.speed = this.rng.range(range[0], range[1]) * (kind === 'walker' && this.diff.speedRate > 8 && zs.gait === 'sprint' ? 1.04 : 1);
    let hp = zombieHealth(this.wave, this.diff) * d.hp;
    if (kind === 'tank') { hp *= 1 + 0.45 * (this.humans.length - 1); zs.boss = true; }
    if (kind === 'armored') { zs.helmet = zs.helmetMax = Math.round(hp * 0.7); zs.vest = zs.vestMax = Math.round(hp * 1.2); }
    a.maxHealth = Math.round(hp);
    a.resetForRound(false, START_WEAPON);
    a.secondary = null; a.primary = null; a.active = 'melee'; a.grenades.frag = 0;
    a.health = a.maxHealth;
    a.scaleW = d.scaleW; a.scaleH = d.scaleH;
    a.motor.pos.set(x, this.world.collision.groundHeight(x, z, 1), z);
    a.motor.vel.set(0, 0, 0);
    a.motor.onGround = true;
    const tgt = this.nearestHuman(x, z);
    a.yaw = tgt ? yawTo(tgt.pos.x - x, tgt.pos.z - z) : this.rng.range(-Math.PI, Math.PI);
    a.motor.bodyYaw = a.yaw;
    a.motor.prone = d.crawl ? 1 : 0;
    a.speedOverride = zs.speed;
    a.killedBy = -1;
    zs.mode = 'rise';
    zs.modeAt = this.time;
    zs.modeUntil = this.time + (kind === 'tank' ? 2.4 : d.crawl ? 1.1 : 1.5);
    zs.nextVoice = this.time + this.rng.range(0.4, 2.5);
    zs.nextSpecial = this.time + this.rng.range(2.5, 5);
    zs.checkAt = zs.modeUntil + 2; zs.checkX = x; zs.checkZ = z;
    a.stats.kills = 0;
    this.events.emit('zSpawn', { id: a.id, kind, pos: a.pos.clone() });
    if (kind === 'tank') this.events.emit('zVoice', { id: a.id, kind: 'roar', pos: a.pos.clone(), zombie: kind });
    return a;
  }

  private nearestHuman(x: number, z: number, standingOnly = true): Agent | null {
    let best: Agent | null = null, bestD = Infinity;
    for (const h of this.humans) {
      if (!h.alive || (standingOnly && h.zp!.downed)) continue;
      const d = Math.hypot(h.pos.x - x, h.pos.z - z);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  private computeFlow() {
    const devices = this.gadgets.devices.filter((d) => d.collider && (d.kind === 'barricade' || d.kind === 'steelBarricade' || d.kind === 'shield'));
    const nav = this.world.nav;
    for (const f of [this.flow, this.lureFlow]) {
      f.device.fill(0);
      for (const d of devices) {
        const b = d.collider!, r = 0.45;
        for (let row = nav.rowOf(b.minZ - r); row <= nav.rowOf(b.maxZ + r); row++) for (let col = nav.colOf(b.minX - r); col <= nav.colOf(b.maxX + r); col++) {
          if (nav.inBounds(col, row) && nav.walk[row * nav.cols + col] === 0) f.device[row * nav.cols + col] = 1;
        }
      }
    }
    const st = this.standing();
    const src = (st.length ? st : this.humans.filter((h) => h.alive)).map((h) => ({ x: h.pos.x, z: h.pos.z }));
    this.flow.compute(src);
    this.flow.computedAt = this.time;
    const lures = this.utility.decoys.map((d) => ({ x: d.pos.x, z: d.pos.z }));
    if (lures.length) { this.lureFlow.compute(lures); this.lureFlow.computedAt = this.time; }
  }

  // ======================================================================== zombie AI
  private steerTmp = { x: 0, z: 0, blocked: false };
  private steerCache = new Map<number, { x: number; z: number; blocked: boolean; ok: boolean }>();

  private updateZombie(a: Agent, dt: number) {
    const zs = a.zombie!, d = ZOMBIES[zs.kind], now = this.time;
    const crawl = !!d.crawl;
    let forward = 0;
    let faceYaw: number | null = null;
    let speed = zs.speed;
    if (now < zs.enragedUntil) speed *= T.screamBuff;
    if (now < zs.slowUntil) speed *= 0.45;
    speed *= 1 - 0.6 * a.stunAt(now);
    speed *= this.gadgets.wireSlowAt(a.pos);

    // ---- target: the nearest standing human (or a lure)
    const lure = this.utility.decoys.length > 0 && this.lureFlow.computedAt >= 0 ? this.utility.decoys.reduce((b, x) => (x.pos.distanceTo(a.pos) < b.pos.distanceTo(a.pos) ? x : b)) : null;
    zs.lured = !!lure && lure.pos.distanceTo(a.pos) < 30 && zs.kind !== 'tank';
    const committed = zs.mode === 'attack' ? this.getAgent(zs.attackTargetId) : null;
    const target = zs.mode === 'attack' ? (committed?.alive && !committed.zp?.downed ? committed : null) : this.nearestHuman(a.pos.x, a.pos.z);
    zs.targetId = target?.id ?? null;
    const tx = zs.lured ? lure!.pos.x : target?.pos.x ?? a.pos.x, tz = zs.lured ? lure!.pos.z : target?.pos.z ?? a.pos.z;
    const dist = Math.hypot(tx - a.pos.x, tz - a.pos.z);
    const dy = target ? Math.abs(target.pos.y - a.pos.y) : 0;

    switch (zs.mode) {
      case 'rise':
        if (now >= zs.modeUntil) { zs.mode = 'chase'; zs.modeAt = now; }
        break;
      case 'chase': {
        forward = 1;
        if (!target || zs.lured) break;
        const los = () => !this.world.collision.segmentBlocked(a.eyePos(tmpV), target.centerPos(tmpV2));
        if (zs.kind === 'bomber' && dist < d.reach && dy < 1.5) { this.setMode(zs, 'fuse', d.windup); this.voice(a, 'fuse'); break; }
        if (zs.kind === 'spitter' && now >= zs.nextSpecial && dist > 5 && dist < 18 && los()) { this.setMode(zs, 'spit', 0.75); this.voice(a, 'spit'); break; }
        if (zs.kind === 'spitter' && dist > 5 && dist < 9 && los()) forward = 0.15; // keep its distance
        if (zs.kind === 'shrieker' && now >= zs.nextSpecial && dist < 16 && los()) { this.setMode(zs, 'scream', 1.1); this.voice(a, 'shriek'); break; }
        if (zs.kind === 'tank' && now >= zs.nextSpecial && dist > 7 && dist < 20 && los()) {
          this.setMode(zs, 'roar', 1.0); this.voice(a, 'roar'); this.events.emit('zTank', { id: a.id, state: 'roar' }); break;
        }
        const reach = d.reach + 0.25 * (a.scaleW - 1) + 0.35;
        if (dist < reach && dy < 1.6 && now >= zs.nextAttack && zs.kind !== 'bomber' && los()) {
          if (zs.kind === 'tank') { this.setMode(zs, 'slam', d.windup); this.events.emit('zTank', { id: a.id, state: 'slam' }); }
          else { this.setMode(zs, 'attack', d.windup); zs.arm = -zs.arm; zs.attackTargetId = target.id; }
          break;
        }
        if (dist < 0.75 + 0.3 * a.scaleW) forward = 0; // pressed up against you
        break;
      }
      case 'attack': {
        forward = 0.2; faceYaw = target ? yawTo(target.pos.x - a.pos.x, target.pos.z - a.pos.z) : a.yaw;
        if (now >= zs.modeUntil) {
          zs.nextAttack = now + d.cooldown;
          if (target) {
            const reach = (d.reach + 0.25 * (a.scaleW - 1) + 0.35) * 1.3;
            const facing = Math.abs(angleDiff(a.yaw, yawTo(target.pos.x - a.pos.x, target.pos.z - a.pos.z))) < 1.3;
            const hitDist = Math.hypot(target.pos.x - a.pos.x, target.pos.z - a.pos.z);
            const hit = hitDist < reach && dy < 1.7 && facing && !this.world.collision.segmentBlocked(a.eyePos(tmpV), target.centerPos(tmpV2));
            if (hit) {
              const dmg = d.damage * this.diff.damage;
              this.applyDamage(target, a, { health: Math.round(dmg), armor: 0 }, 'chest', 'zombie', target.centerPos(new Vector3()), new Vector3(target.pos.x - a.pos.x, 0, target.pos.z - a.pos.z).normalize());
              if (zs.kind === 'bloater') this.addGas(target.pos.clone(), 2.2, 4);
            }
            this.events.emit('zSwipe', { id: a.id, targetId: target.id, hit });
          }
          zs.mode = 'chase'; zs.modeAt = now; zs.attackTargetId = null;
        }
        break;
      }
      case 'fuse':
        forward = 0.65;
        if (now >= zs.modeUntil) { this.bomberBlast(a, a.id); return; }
        break;
      case 'spit':
        faceYaw = yawTo(tx - a.pos.x, tz - a.pos.z);
        if (now >= zs.modeUntil) {
          if (target) this.launchSpit(a, target);
          zs.nextSpecial = now + this.rng.range(3.5, 5.5);
          zs.mode = 'chase'; zs.modeAt = now;
        }
        break;
      case 'scream':
        faceYaw = yawTo(tx - a.pos.x, tz - a.pos.z);
        if (now >= zs.modeUntil) {
          this.scream(a);
          zs.nextSpecial = now + this.rng.range(10, 14);
          zs.mode = 'chase'; zs.modeAt = now;
        }
        break;
      case 'roar':
        faceYaw = yawTo(tx - a.pos.x, tz - a.pos.z);
        if (now >= zs.modeUntil) {
          const yaw = faceYaw;
          zs.charge = { x: -Math.sin(yaw), z: -Math.cos(yaw), hit: [] };
          this.setMode(zs, 'charge', T.chargeTime);
          this.events.emit('zTank', { id: a.id, state: 'charge' });
        }
        break;
      case 'charge': {
        const c = zs.charge!;
        faceYaw = yawTo(c.x, c.z);
        forward = 1;
        speed = T.chargeSpeed;
        for (const h of this.standing()) {
          if (c.hit.includes(h.id)) continue;
          if (Math.hypot(h.pos.x - a.pos.x, h.pos.z - a.pos.z) < 1.5 && Math.abs(h.pos.y - a.pos.y) < 1.6
            && !this.world.collision.segmentBlocked(a.centerPos(tmpV), h.centerPos(tmpV2))) {
            c.hit.push(h.id);
            this.applyDamage(h, a, { health: Math.round(60 * this.diff.damage), armor: 0 }, 'chest', 'zombie', h.centerPos(new Vector3()), new Vector3(c.x, 0, c.z));
            h.motor.vel.set(c.x * 9, 3.5, c.z * 9); h.motor.onGround = false;
          }
        }
        if (now >= zs.modeUntil) { zs.nextSpecial = now + this.rng.range(7, 10); zs.mode = 'chase'; zs.modeAt = now; zs.charge = null; }
        break;
      }
      case 'dazed':
        if (now >= zs.modeUntil) { zs.mode = 'chase'; zs.modeAt = now; }
        break;
      case 'slam':
        faceYaw = yawTo(tx - a.pos.x, tz - a.pos.z);
        if (now >= zs.modeUntil) {
          zs.nextAttack = now + d.cooldown;
          for (const h of this.standing()) {
            const dd = Math.hypot(h.pos.x - a.pos.x, h.pos.z - a.pos.z);
            if (dd > T.slamRadius || Math.abs(h.pos.y - a.pos.y) > 1.8) continue;
            if (this.world.collision.segmentBlocked(a.centerPos(tmpV), h.centerPos(tmpV2))) continue;
            const k = 1 - dd / T.slamRadius * 0.5;
            this.applyDamage(h, a, { health: Math.round(d.damage * k * this.diff.damage), armor: 0 }, 'chest', 'zombie', h.centerPos(new Vector3()), new Vector3(h.pos.x - a.pos.x, 0, h.pos.z - a.pos.z).normalize());
            h.stunUntil = now + 1.2; h.stunStrength = 0.6;
          }
          this.events.emit('zBlast', { kind: 'slam', pos: a.pos.clone(), radius: T.slamRadius });
          zs.mode = 'chase'; zs.modeAt = now;
        }
        break;
    }

    // ---- steering
    let mx = 0, mz = 0;
    if (forward > 0 && zs.mode !== 'charge') {
      const near = target && !zs.lured && dist < 3.2 && this.world.nav.walkLine(a.pos.x, a.pos.z, tx, tz);
      if (near) { mx = tx - a.pos.x; mz = tz - a.pos.z; }
      else {
        let s = this.steerCache.get(a.id);
        if (!s || (this.tick + a.id) % 3 === 0) {
          const field = zs.lured ? this.lureFlow : this.flow;
          const ok = field.steer(a.pos.x, a.pos.z, this.steerTmp);
          s = { x: this.steerTmp.x, z: this.steerTmp.z, blocked: this.steerTmp.blocked, ok };
          this.steerCache.set(a.id, s);
        }
        if (s.ok) { mx = s.x - a.pos.x; mz = s.z - a.pos.z; } else { mx = tx - a.pos.x; mz = tz - a.pos.z; }
        if (s.blocked) this.smashDevice(a);
      }
      const len = Math.hypot(mx, mz) || 1;
      mx /= len; mz /= len;
      // separation from other zombies
      for (const o of this.zombiePool) {
        if (o === a || !o.alive) continue;
        const ox = a.pos.x - o.pos.x, oz = a.pos.z - o.pos.z;
        const dd = Math.hypot(ox, oz), r = 0.5 * (a.scaleW + o.scaleW) + 0.15;
        if (dd < r && dd > 0.001) { mx += (ox / dd) * (1 - dd / r) * 1.4; mz += (oz / dd) * (1 - dd / r) * 1.4; }
      }
      faceYaw ??= yawTo(mx, mz);
    }
    if (zs.mode === 'charge' && zs.charge) faceYaw = yawTo(zs.charge.x, zs.charge.z);
    if (faceYaw !== null) {
      const turn = (zs.mode === 'charge' ? 2 : zs.kind === 'tank' ? 3.5 : 7) * dt;
      a.yaw = wrapAngle(a.yaw + clamp(angleDiff(a.yaw, faceYaw), -turn, turn));
    }
    // move along the steering direction (the motor moves along yaw; strafe for the difference)
    let fwd = 0, right = 0;
    if (forward > 0) {
      const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw), rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
      const dirx = zs.mode === 'charge' && zs.charge ? zs.charge.x : mx, dirz = zs.mode === 'charge' && zs.charge ? zs.charge.z : mz;
      const l = Math.hypot(dirx, dirz) || 1;
      fwd = ((dirx * fx + dirz * fz) / l) * forward;
      right = ((dirx * rx + dirz * rz) / l) * forward;
    }
    const before = a.pos.clone();
    stepMotor(this.world.collision, a.motor, {
      forward: fwd, right, jump: false, crouch: crawl, prone: crawl, slide: false, walk: false,
      yaw: a.yaw, maxSpeed: (crawl ? speed / MOVE.proneMult : speed), frozen: zs.mode === 'rise' || zs.mode === 'dazed' || zs.mode === 'roar',
    }, dt);
    if (crawl) a.motor.prone = 1;
    // tank charge into a wall → dazed (takes double damage)
    if (zs.mode === 'charge' && now - zs.modeAt > 0.25 && Math.hypot(a.pos.x - before.x, a.pos.z - before.z) < T.chargeSpeed * dt * 0.3) {
      this.setMode(zs, 'dazed', T.dazedTime); zs.charge = null; zs.nextSpecial = now + 8;
      this.events.emit('zTank', { id: a.id, state: 'dazed' });
      this.events.emit('zBlast', { kind: 'slam', pos: a.pos.clone(), radius: 2 });
    }
    // footsteps (heavy ones carry further) and groans
    const sp = a.speed2D;
    if (sp > 0.4 && zs.mode !== 'rise') {
      a.footstepDist += sp * dt;
      if (a.footstepDist > (zs.kind === 'tank' ? 2.8 : crawl ? 1.6 : 2.2)) {
        a.footstepDist = 0;
        this.events.emit('footstep', { agentId: a.id, pos: a.pos.clone(), surface: this.world.floorAt(a.pos.x, a.pos.z)?.material ?? 'concrete' });
      }
    }
    if (now >= zs.nextVoice) {
      zs.nextVoice = now + this.rng.range(zs.gait === 'sprint' ? 2.2 : 3.5, zs.gait === 'sprint' ? 5 : 8.5);
      this.voice(a, zs.gait === 'sprint' || zs.mode !== 'chase' ? 'growl' : 'groan');
    }
    // stuck: a zombie nobody can see that hasn't moved for a while (or can't reach anyone) re-emerges elsewhere
    if (now >= zs.checkAt) {
      const moved = Math.hypot(a.pos.x - zs.checkX, a.pos.z - zs.checkZ);
      const unreachable = !zs.lured && this.flow.distanceAt(a.pos.x, a.pos.z) === Infinity;
      zs.stuckFor = (moved < 0.5 && zs.mode === 'chase' && dist > 3) || unreachable ? zs.stuckFor + 2 : 0;
      zs.checkAt = now + 2; zs.checkX = a.pos.x; zs.checkZ = a.pos.z;
      if (zs.stuckFor >= 8 && (dist > 10 || unreachable) && !this.seenByHuman(a)) this.reemerge(a);
    }
  }

  private seenByHuman(a: Agent) {
    return this.humans.some((h) => h.alive && !this.world.collision.segmentBlocked(h.eyePos(tmpV), a.centerPos(tmpV2)));
  }

  /** Move a zombie to a fresh spawn point near the squad (it climbs out of the floor again). */
  private reemerge(a: Agent) {
    const zs = a.zombie!, now = this.time;
    const sp = this.pickSpawn(false, zs.kind);
    if (!sp) return;
    a.motor.pos.set(sp.x, this.world.collision.groundHeight(sp.x, sp.z, 1), sp.z); a.motor.vel.set(0, 0, 0);
    zs.mode = 'rise'; zs.modeAt = now; zs.modeUntil = now + 1.2; zs.stuckFor = 0; zs.gen++; zs.charge = null;
    this.steerCache.delete(a.id);
    this.events.emit('zSpawn', { id: a.id, kind: zs.kind, pos: a.pos.clone() });
  }

  private setMode(zs: ZombieState, mode: ZombieState['mode'], dur: number) { zs.mode = mode; zs.modeAt = this.time; zs.modeUntil = this.time + dur; }
  private voice(a: Agent, kind: 'groan' | 'growl' | 'scream' | 'roar' | 'fuse' | 'spit' | 'shriek' | 'death') {
    this.events.emit('zVoice', { id: a.id, kind, pos: a.pos.clone(), zombie: a.zombie!.kind });
  }

  /** A barricade / shield in the way: claw at it. */
  private smashDevice(a: Agent) {
    const zs = a.zombie!, now = this.time;
    if (now < zs.nextAttack) return;
    let dev: Device | null = null, best = 2.2;
    for (const d of this.gadgets.devices) {
      if (!d.collider) continue;
      const dd = Math.hypot(d.pos.x - a.pos.x, d.pos.z - a.pos.z);
      if (dd < best) { best = dd; dev = d; }
    }
    if (!dev) return;
    const def = ZOMBIES[zs.kind];
    zs.nextAttack = now + def.cooldown;
    zs.arm = -zs.arm;
    this.setMode(zs, 'attack', 0.01);
    zs.nextAttack = now + def.cooldown;
    this.gadgets.damage(dev, def.damage * (zs.kind === 'tank' || zs.kind === 'brute' ? 2 : 0.8), null, 'explosion');
    this.events.emit('zSwipe', { id: a.id, targetId: -1, hit: true });
  }

  private bomberBlast(a: Agent, ownerId: number) {
    const pos = a.pos.clone().setY(a.pos.y + 0.9);
    if (a.alive) {
      a.alive = false; a.health = 0; a.deathTime = this.time; a.zombie!.freeAt = this.time + 0.2; a.zombie!.headless = true; this.killedThisWave++; this.totalKills++;
      this.lastKillAt = this.time;
      this.frenzyEndDrop(a.pos.clone());
    }
    this.pendingBlasts.push({ pos, at: this.time, ownerId });
  }

  private launchSpit(a: Agent, target: Agent) {
    const from = a.eyePos(new Vector3());
    const to = target.pos.clone().addScaledVector(target.vel, 0.6);
    const dx = to.x - from.x, dz = to.z - from.z, h = Math.hypot(dx, dz);
    const t = Math.max(0.5, h / T.spitSpeed);
    const vel = new Vector3(dx / t, (to.y + 0.3 - from.y) / t + 0.5 * 9.8 * t, dz / t);
    this.spits.push({ id: this.nextId++, pos: from, vel, ownerId: a.id, born: this.time });
    this.events.emit('zHazard', { kind: 'spit', pos: from.clone(), to: to.clone() });
  }

  private scream(a: Agent) {
    const now = this.time;
    this.events.emit('zVoice', { id: a.id, kind: 'scream', pos: a.pos.clone(), zombie: a.zombie!.kind });
    for (const o of this.zombiePool) if (o.alive && o !== a && o.pos.distanceTo(a.pos) < T.screamRadius) o.zombie!.enragedUntil = now + T.screamBuffTime;
    for (const h of this.standing()) {
      const d = h.pos.distanceTo(a.pos);
      if (d > T.screamStunRadius || this.world.collision.segmentBlocked(a.eyePos(tmpV), h.eyePos(tmpV2))) continue;
      const strength = 0.45 * (1 - d / T.screamStunRadius) + 0.15, dur = 1.6;
      h.stunUntil = Math.max(h.stunUntil, now + dur); h.stunStrength = Math.max(h.stunStrength, strength);
      this.events.emit('stunned', { agentId: h.id, strength, duration: dur, byId: a.id });
    }
    if (this.wavePhase === 'active' && this.screamExtra < 6) { this.screamExtra += T.screamExtra; this.waveTotal += T.screamExtra; }
  }

  private addGas(pos: Vector3, radius: number, dur: number) {
    pos.y = this.world.collision.groundHeight(pos.x, pos.z, pos.y + 0.5);
    this.gas.push({ id: this.nextId++, pos, start: this.time, until: this.time + dur, radius });
    this.events.emit('zHazard', { kind: 'gas', pos: pos.clone() });
  }

  /** Zombies and players can't walk through each other (being cornered matters). */
  private resolveBodies() {
    const col = this.world.collision;
    const tryMove = (a: Agent, dx: number, dz: number) => {
      const p = a.motor.pos, r = motorRadii(a.motor.prone, a.motor.bodyYaw), h = a.height;
      if (!col.overlaps(p.x + dx - r.x, p.y + 0.05, p.z + dz - r.z, p.x + dx + r.x, p.y + h, p.z + dz + r.z)) { p.x += dx; p.z += dz; }
    };
    const zs = this.zombiePool.filter((z) => z.alive && z.zombie!.mode !== 'rise');
    for (const h of this.humans) {
      if (!h.alive || h.zp!.downed) continue;
      for (const z of zs) {
        const dx = h.pos.x - z.pos.x, dz = h.pos.z - z.pos.z, d = Math.hypot(dx, dz);
        const r = T.bodyRadius * z.scaleW + 0.36;
        if (d >= r || Math.abs(h.pos.y - z.pos.y) > 1.5) continue;
        const nx = d > 1e-3 ? dx / d : 1, nz = d > 1e-3 ? dz / d : 0, push = r - d;
        const share = z.zombie!.kind === 'tank' ? 1 : z.zombie!.kind === 'crawler' ? 0.4 : 0.7;
        tryMove(h, nx * push * share, nz * push * share);
        tryMove(z, -nx * push * (1 - share), -nz * push * (1 - share));
      }
    }
    for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
      const a = zs[i], b = zs[j];
      const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z, d = Math.hypot(dx, dz);
      const r = T.bodyRadius * (a.scaleW + b.scaleW) * 0.85;
      if (d >= r || d < 1e-4) continue;
      const push = (r - d) * 0.5, nx = dx / d, nz = dz / d;
      tryMove(a, nx * push, nz * push); tryMove(b, -nx * push, -nz * push);
    }
  }

  // ======================================================================== humans
  private updateHuman(h: Agent, dt: number) {
    if (!h.alive) return;
    const zp = h.zp!, now = this.time;
    let cmd: AgentCommand = this.allies.get(h.id)?.think(dt) ?? this.humanCommands.get(h.id) ?? (h === this.player ? this.playerCmd : emptyCommand());
    cmd = { ...cmd, drop: false, killstreak: false, cams: false };
    if (zp.downed) {
      Object.assign(cmd, { prone: true, crouch: true, jump: false, slide: false, walk: false, quickMelee: false, stimSelf: false, selectGrenade: null, selectGadget: null,
        cycleGrenade: false, cycleGadget: false, lastWeapon: false, detonate: false, ping: false });
      cmd.select = h.active !== 'secondary' ? 'secondary' : null;
    }
    if (this.reviving.has(h.id)) { cmd.fire = false; cmd.alt = false; }
    h.speedMul = (this.hasPerk(h, 'marathon') ? 1.12 : 1) * (this.inHazard(this.gas, h.pos) ? 0.8 : 1);
    const w0 = h.activeWeapon();
    const emptyFrac = w0 && w0.def.mag > 0 ? 1 - w0.mag / w0.def.mag : 0;
    this.applyCommand(h, cmd, dt);
    if (!h.alive) return;
    const reloading = h.wpn.reloadUntil > now;
    if (reloading && !zp.wasReloading && this.hasPerk(h, 'shockCharge') && now >= zp.shockReadyAt) this.shockCharge(h, emptyFrac);
    zp.wasReloading = reloading;
    if (!zp.downed && h.health < h.maxHealth && now - zp.lastHurt > T.regenDelay) h.health = Math.min(h.maxHealth, h.health + T.regenRate * dt);
    if (zp.downed) {
      if (zp.selfReviveAt > 0 && now >= zp.selfReviveAt) this.reviveHuman(h, h, true);
      else if (zp.selfReviveAt === 0 && !zp.revive && now >= zp.bleedUntil) this.bleedOut(h);
    }
  }

  private shockCharge(h: Agent, emptyFrac: number) {
    const now = this.time, zp = h.zp!;
    zp.shockReadyAt = now + 3;
    const k = clamp(emptyFrac, 0.15, 1);
    const radius = 1.6 + 3.2 * k;
    const dmg = (220 + 70 * this.wave) * k;
    for (const z of this.zombiePool) {
      if (!z.alive || z.pos.distanceTo(h.pos) > radius) continue;
      z.zombie!.slowUntil = now + 1.6;
      this.applyDamage(z, h, { health: Math.round(dmg), armor: 0 }, 'chest', 'shock', z.centerPos(new Vector3()), new Vector3(z.pos.x - h.pos.x, 0, z.pos.z - h.pos.z).normalize());
    }
    this.events.emit('zBlast', { kind: 'shock', pos: h.pos.clone(), radius });
  }

  private respawnHuman(h: Agent) {
    const mate = this.standing()[0];
    let s = this.layout.playerSpawns[0];
    if (mate) {
      // next to a teammate, on their side of any wall (never across into a closed area)
      const nav = this.world.nav, zone = this.zoneAt(mate.pos.x, mate.pos.z);
      s = { x: mate.pos.x, z: mate.pos.z, yaw: mate.yaw };
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, r = i < 8 ? 1.4 : 2.2;
        const x = mate.pos.x + Math.cos(a) * r, z = mate.pos.z + Math.sin(a) * r;
        if (nav.isWalkableAt(x, z) && nav.walkLine(mate.pos.x, mate.pos.z, x, z) && this.zoneAt(x, z) === zone) { s = { x, z, yaw: mate.yaw }; break; }
      }
    }
    h.alive = true;
    h.zp!.perks = [];
    this.spawnHuman(h, s);
    h.zp!.protectedUntil = this.time + T.reviveProtection;
    this.events.emit('zRespawn', { agentId: h.id });
  }

  private downHuman(h: Agent) {
    const zp = h.zp!, now = this.time;
    this.stopRevive(h);
    const solo = this.humans.length === 1;
    const hadSW = zp.perks.includes('secondWind');
    zp.downed = true; zp.downedAt = now; zp.revive = null;
    zp.stats.downs++;
    h.health = 1;
    const penalty = Math.floor(h.money * T.downPenalty / 10) * 10;
    if (penalty > 0) { h.money -= penalty; this.events.emit('zPoints', { agentId: h.id, amount: -penalty, reason: 'Downed' }); }
    // perks are lost (CoD); Second Wind on solo / a kit stands you back up
    const self = (solo && hadSW) || zp.reviveKit;
    if (!hadSW || !solo) { if (zp.reviveKit) zp.reviveKit = false; }
    for (const p of [...zp.perks]) this.removePerk(h, p);
    zp.selfReviveAt = self ? now + T.selfReviveTime : 0;
    zp.bleedUntil = now + this.diff.bleedOut;
    h.wpn.reloadUntil = 0; h.wpn.ads = false; h.wpn.scope = 0;
    if (!h.secondary) h.secondary = zWeapon(START_WEAPON, 0, []);
    if (h.active !== 'secondary') equip(this, h, 'secondary');
    this.events.emit('zDowned', { agentId: h.id, self });
  }

  reviveHuman(h: Agent, by: Agent, self: boolean) {
    if (!h.alive || !h.zp?.downed) return;
    const zp = h.zp!;
    zp.downed = false; zp.revive = null; zp.selfReviveAt = 0; zp.bleedUntil = 0;
    h.health = Math.round(h.maxHealth * T.revivedHealth);
    zp.lastHurt = this.time;
    zp.protectedUntil = this.time + T.reviveProtection;
    h.motor.prone = 0.99;
    for (const [rid, tid] of this.reviving) if (tid === h.id) this.reviving.delete(rid);
    if (!self) { by.zp!.stats.revives++; this.addPoints(by, POINTS.revive, 'Revive', false); }
    equipBest(this, h);
    this.events.emit('zRevived', { agentId: h.id, byId: by.id, self });
  }

  private bleedOut(h: Agent) {
    const zp = h.zp!;
    this.stopRevive(h);
    zp.downed = false; zp.dead = true;
    h.alive = false; h.health = 0; h.deathTime = this.time; h.killedBy = -1; h.stats.deaths++;
    const penalty = Math.floor(h.money * T.bleedPenalty / 10) * 10;
    if (penalty > 0) h.money -= penalty;
    this.events.emit('zBleedOut', { agentId: h.id });
    this.events.emit('kill', { killerId: -1, victimId: h.id, weapon: 'zombie', headshot: false, assisterId: null, flashAssist: false, wallbang: false });
  }

  private checkGameOver() {
    if (this.standing().length > 0) return;
    if (this.humans.some((h) => h.alive && h.zp!.downed && h.zp!.selfReviveAt > 0)) return;
    this.endGame(false);
  }

  endGame(won: boolean) {
    if (this.gameOver) return;
    this.gameOver = true; this.won = won;
    this.wavePhase = 'over';
    this.matchOver = true;
    this.winner = won ? 'CT' : 'T';
    if (won) this.exfil.phase = 'extracted';
    this.events.emit('zGameOver', { wave: this.wave, won });
    this.phase = 'matchOver';
    this.events.emit('matchEnd', { winner: this.winner });
  }

  // ======================================================================== damage
  override applyDamage(victim: Agent, attacker: Agent | null, dmg: DamageResult, group: HitGroup, source: string, point: Vector3, dir: Vector3, flags: DamageFlags = {}) {
    if (!victim.alive || this.gameOver) return;
    if (victim.zombie) this.damageZombie(victim, attacker, dmg, group, source, point, dir, flags);
    else if (victim.zp) this.damageHuman(victim, attacker, dmg, group, source, point, dir);
  }

  private damageZombie(v: Agent, attacker: Agent | null, dmg: DamageResult, group: HitGroup, source: string, point: Vector3, dir: Vector3, flags: DamageFlags) {
    const zs = v.zombie!;
    if (attacker?.zombie && source !== 'bomber') return;
    const human = attacker?.zp ? attacker : null;
    const explosive = EXPLOSIVE.has(source);
    let h = dmg.health;
    let armorDamage = 0;
    if (source === 'knife') h *= T.meleeMult;
    else if (source === 'fire') h *= zs.kind === 'armored' && (zs.vest > 0 || zs.helmet > 0) ? 0 : T.fireMult;
    else if (source === 'bomber') h *= Math.max(T.bomberZombieDamage, zombieHealth(this.wave, this.diff) * 1.5) / (ZOMBIES.bomber.damage * this.diff.damage);
    else if (explosive) h *= T.explosiveMult;
    else if (source in WEAPONS) h *= T.gunMult;
    if (human && group === 'head' && this.hasPerk(human, 'deadEye')) h *= 1.25;
    if (zs.kind === 'tank' && zs.mode === 'dazed') h *= 2;
    // armored: the helmet soaks head damage, plates soak most body damage
    if (zs.kind === 'armored' && h > 0) {
      if (group === 'head' && zs.helmet > 0 && !explosive) {
        armorDamage = Math.min(zs.helmet, h);
        zs.helmet -= h; h = 0;
        if (zs.helmet <= 0) { h = -zs.helmet; zs.helmet = 0; this.events.emit('zArmor', { id: v.id, part: 'helmet' }); }
      } else if (zs.vest > 0 && (group === 'chest' || group === 'stomach' || explosive)) {
        const strip = explosive ? 2 : 1;
        const soak = Math.min(h * (explosive ? 0.5 : 0.7), zs.vest / strip);
        armorDamage = soak * strip;
        zs.vest -= armorDamage; h -= soak;
        if (zs.vest <= 0) { zs.vest = 0; this.events.emit('zArmor', { id: v.id, part: 'vest' }); }
      }
    }
    if (human && this.time < this.timers.instaKill && h > 0) h = zs.kind === 'tank' ? Math.max(h, v.maxHealth * 0.12) : v.health;
    h = Math.max(0, Math.round(h));
    v.health -= h;
    v.lastHurtTime = this.time;
    if (source in WEAPONS && source !== 'knife' && group !== 'legs') { v.motor.vel.x *= 0.55; v.motor.vel.z *= 0.55; } // stopping power
    this.events.emit('hit', { attackerId: attacker?.id ?? -1, victimId: v.id, amount: h, armorDamage: Math.round(armorDamage), group, point, source, wallbang: !!flags.wallbang });
    if (v.health <= 0) { this.killZombie(v, attacker, source, group, dir); return; }
    if (human && h > 0 && source !== 'fire' && source !== 'shock') this.addPoints(human, POINTS.hit, 'Hit', true);
  }

  private killZombie(v: Agent, attacker: Agent | null, source: string, group: HitGroup, dir: Vector3, nuke = false) {
    const zs = v.zombie!, now = this.time;
    v.alive = false; v.health = 0; v.deathTime = now;
    v.deathDir.copy(dir).setY(0).normalize();
    v.killedBy = attacker && attacker !== v ? attacker.id : -1;
    zs.freeAt = now + (zs.kind === 'tank' ? 7 : 4.6);
    zs.headless = group === 'head' && source in WEAPONS && source !== 'knife' && !nuke;
    zs.charge = null;
    this.killedThisWave++; this.totalKills++;
    this.lastKillPos.copy(v.pos);
    this.lastKillAt = now;
    const human = attacker?.zp ? attacker : null;
    if (human && !nuke) {
      const d = ZOMBIES[zs.kind];
      const base = source === 'knife' ? POINTS.melee : EXPLOSIVE.has(source) || source === 'fire' || source === 'shock' ? POINTS.explosive
        : group === 'head' ? POINTS.head : group === 'legs' ? POINTS.limb : POINTS.body;
      this.addPoints(human, base + (zs.kind === 'tank' ? 0 : d.bonus), group === 'head' && source in WEAPONS ? 'Headshot' : 'Kill', true);
      human.stats.kills++; human.zp!.stats.kills++;
      if (group === 'head' && source in WEAPONS) { human.stats.headshots++; human.zp!.stats.headshots++; }
    }
    if (zs.kind === 'tank') for (const h of this.humans) if (h.alive) this.addPoints(h, ZOMBIES.tank.bonus, 'Boss killed', true);
    this.events.emit('kill', { killerId: attacker?.id ?? -1, victimId: v.id, weapon: source, headshot: group === 'head', assisterId: null, flashAssist: false, wallbang: false });
    this.voice(v, 'death');
    if (!nuke) {
      if (zs.kind === 'bloater') this.addGas(v.pos.clone(), T.gasRadius, T.gasDuration);
      if (zs.kind === 'bomber') this.pendingBlasts.push({ pos: v.pos.clone().setY(v.pos.y + 0.9), at: now + 0.15, ownerId: human?.id ?? v.id });
      this.maybeDrop(v.pos, zs.kind === 'tank');
    }
    this.frenzyEndDrop(v.pos);
  }

  /** The last zombie of a frenzy wave drops a Max Ammo where it fell (shot or self-detonated). */
  private frenzyEndDrop(pos: Vector3) {
    if (this.wavePhase === 'active' && this.waveKindNow === 'frenzy' && this.spawned >= this.waveTotal && !this.zombiePool.some((z) => z.alive)) this.dropPowerUp('maxAmmo', pos);
  }

  private damageHuman(v: Agent, attacker: Agent | null, dmg: DamageResult, group: HitGroup, source: string, point: Vector3, dir: Vector3) {
    const zp = v.zp!;
    if (zp.downed || this.time < zp.protectedUntil) return;
    if (attacker?.zp && attacker !== v) return; // no friendly fire
    let h = dmg.health;
    let armorDamage = 0;
    const blast = EXPLOSIVE.has(source);
    if (this.hasPerk(v, 'blastShield')) {
      if ((blast && attacker === v) || source === 'fall') h = 0;
      else if (blast || source === 'gas') h *= 0.25;
    }
    if (blast && attacker === v && !this.hasPerk(v, 'blastShield')) h *= 0.5; // your own frags still sting
    if (v.isBot && attacker !== v) h *= 0.8; // bot teammates are a little sturdier so they can carry their weight
    if (v.armor > 0 && h > 0 && source !== 'fall') {
      const soak = Math.min(v.armor, h * 0.5);
      armorDamage = soak;
      v.armor -= soak; h -= soak;
      if (v.armor <= 0) { v.armor = 0; v.helmet = false; }
    }
    h = Math.round(h);
    if (h <= 0) return;
    v.health -= h;
    zp.lastHurt = this.time;
    v.lastHurtTime = this.time;
    if (attacker) v.lastHurtFrom.copy(attacker.eyePos(new Vector3())); else v.lastHurtFrom.copy(point).addScaledVector(dir, -2);
    if (source === 'zombie') {
      const kick = Math.min(4, 1 + h * 0.04);
      v.flinchPitch = Math.min(7, v.flinchPitch + kick); v.flinchYaw += (this.rng.next() - 0.5) * kick;
      v.motor.vel.x *= 0.4; v.motor.vel.z *= 0.4;
    }
    this.events.emit('hit', { attackerId: attacker?.id ?? -1, victimId: v.id, amount: h, armorDamage: Math.round(armorDamage), group, point, source });
    if (v.health <= 0) this.downHuman(v);
  }

  // ======================================================================== points & power-ups
  addPoints(a: Agent, amount: number, reason: string, doubled: boolean) {
    if (!a.zp) return;
    const n = Math.round(amount * (doubled && this.time < this.timers.doublePoints ? 2 : 1));
    a.money += n;
    a.zp.stats.earned += n;
    this.teamEarned += n;
    this.events.emit('zPoints', { agentId: a.id, amount: n, reason });
  }

  private spend(a: Agent, price: number, kind: string, name: string): boolean {
    if (a.money < price) { this.events.emit('zDenied', { agentId: a.id, reason: 'Not enough points' }); return false; }
    a.money -= price;
    a.zp!.stats.spent += price;
    this.events.emit('zBuy', { agentId: a.id, kind, name, price });
    return true;
  }

  private maybeDrop(pos: Vector3, forced: boolean) {
    if (this.waveKindNow === 'frenzy' && this.wavePhase === 'active') return;
    if (!forced && this.puDrops >= PU.maxPerWave) return;
    const byScore = this.teamEarned >= this.puThreshold;
    if (!forced && !byScore && this.rng.next() >= this.diff.dropChance) return;
    if (byScore) { this.puIncrement *= PU.thresholdMul; this.puThreshold = this.teamEarned + this.puIncrement; }
    this.puDrops++;
    const opts = POWERUP_ORDER.filter((k) => k !== 'fireSale' || this.box.state === 'idle');
    const total = opts.reduce((s, k) => s + POWERUPS[k].weight, 0);
    let r = this.rng.next() * total;
    let kind: PowerUpId = 'maxAmmo';
    for (const k of opts) { r -= POWERUPS[k].weight; if (r <= 0) { kind = k; break; } }
    this.dropPowerUp(kind, pos);
  }

  dropPowerUp(kind: PowerUpId, at: Vector3): PowerUp {
    const pos = at.clone();
    pos.y = this.world.collision.groundHeight(pos.x, pos.z, pos.y + 1) + 0.95;
    const p: PowerUp = { id: this.nextId++, kind, pos, born: this.time };
    this.powerUps.push(p);
    this.events.emit('zPowerUp', { id: p.id, kind, state: 'drop', byId: -1, pos: pos.clone() });
    return p;
  }

  private updatePowerUps() {
    const now = this.time;
    for (let i = this.powerUps.length - 1; i >= 0; i--) {
      const p = this.powerUps[i];
      if (now - p.born > PU.life) { this.powerUps.splice(i, 1); this.events.emit('zPowerUp', { id: p.id, kind: p.kind, state: 'expire', byId: -1, pos: p.pos.clone() }); continue; }
      const by = this.standing().find((h) => Math.hypot(h.pos.x - p.pos.x, h.pos.z - p.pos.z) < PU.radius && Math.abs(h.pos.y + 0.9 - p.pos.y) < 1.6
        && !this.world.collision.segmentBlocked(h.centerPos(tmpV), p.pos));
      if (!by) continue;
      this.powerUps.splice(i, 1);
      this.grabPowerUp(p, by);
    }
    for (const k of ['instaKill', 'doublePoints', 'fireSale'] as const) {
      if (this.timers[k] > 0 && now >= this.timers[k]) { this.timers[k] = 0; this.events.emit('zPowerUp', { id: 0, kind: k, state: 'end', byId: -1, pos: new Vector3() }); }
    }
  }

  private grabPowerUp(p: PowerUp, by: Agent) {
    const now = this.time;
    this.events.emit('zPowerUp', { id: p.id, kind: p.kind, state: 'grab', byId: by.id, pos: p.pos.clone() });
    switch (p.kind) {
      case 'maxAmmo':
        for (const h of this.humans) {
          if (!h.alive) continue;
          for (const w of [h.primary, h.secondary]) if (w) w.reserve = w.def.reserve;
          h.grenades.frag = Math.max(h.grenades.frag, 2);
        }
        break;
      case 'instaKill': case 'doublePoints': case 'fireSale':
        this.timers[p.kind] = now + POWERUPS[p.kind].duration;
        break;
      case 'nuke':
        for (const z of this.zombiePool) {
          if (!z.alive) continue;
          if (z.zombie!.boss) { this.applyDamage(z, null, { health: Math.round(z.maxHealth * 0.25), armor: 0 }, 'chest', 'nuke', z.centerPos(new Vector3()), new Vector3(0, -1, 0)); continue; }
          this.killZombie(z, null, 'nuke', 'chest', new Vector3(this.rng.range(-1, 1), 0, this.rng.range(-1, 1)), true);
        }
        for (const h of this.humans) if (h.alive) this.addPoints(h, POINTS.nuke, 'Nuke', false);
        this.events.emit('zBlast', { kind: 'nuke', pos: p.pos.clone(), radius: 200 });
        break;
      case 'carpenter':
        for (const d of this.gadgets.devices) if (d.kind === 'barricade' || d.kind === 'steelBarricade' || d.kind === 'wire') d.health = GADGETS[d.kind].health ?? d.health;
        for (const h of this.humans) if (h.alive) { h.armor = Math.min(150, h.armor + 50); this.addPoints(h, 200, 'Carpenter', false); }
        break;
      case 'bonusPoints':
        for (const h of this.humans) if (h.alive) this.addPoints(h, 500, 'Bonus points', false);
        break;
    }
  }

  // ======================================================================== hazards
  private inHazard(list: Hazard[], p: Vector3) {
    for (const g of list) if (Math.hypot(p.x - g.pos.x, p.z - g.pos.z) < g.radius && Math.abs(p.y - g.pos.y) < 2.5) return true;
    return false;
  }

  private updateHazards(dt: number) {
    const now = this.time;
    this.gas = this.gas.filter((g) => g.until > now);
    this.acid = this.acid.filter((g) => g.until > now);
    for (const h of this.humans) {
      if (!h.alive || h.zp!.downed) continue;
      let dps = 0;
      if (this.inHazard(this.gas, h.pos)) dps += T.gasDps;
      for (const g of this.acid) if (Math.hypot(h.pos.x - g.pos.x, h.pos.z - g.pos.z) < g.radius && h.pos.y - g.pos.y < 0.6) { dps += T.acidDps; break; }
      if (!dps) { this.hazardAcc.delete(h.id); continue; }
      const acc = (this.hazardAcc.get(h.id) ?? 0) + dps * this.diff.damage * dt;
      const whole = Math.floor(acc);
      this.hazardAcc.set(h.id, acc - whole);
      if (whole > 0) this.applyDamage(h, null, { health: whole, armor: 0 }, 'legs', 'gas', h.pos.clone(), new Vector3(0, -1, 0));
    }
    // acid spit
    for (let i = this.spits.length - 1; i >= 0; i--) {
      const s = this.spits[i];
      s.vel.y -= 9.8 * dt;
      const step = s.vel.length() * dt;
      const dir = s.vel.clone().normalize();
      const hit = this.world.collision.raycast(s.pos, dir, step);
      let land: Vector3 | null = hit ? hit.point.clone() : null;
      const victim = this.standing().find((h) => h.centerPos(tmpV).distanceTo(s.pos) < 0.6);
      if (victim) {
        this.applyDamage(victim, this.getAgent(s.ownerId), { health: Math.round(18 * this.diff.damage), armor: 0 }, 'chest', 'acid', s.pos.clone(), dir);
        land = victim.pos.clone();
      }
      if (!land && now - s.born > 4) { this.spits.splice(i, 1); continue; }
      if (land) {
        this.spits.splice(i, 1);
        land.y = this.world.collision.groundHeight(land.x, land.z, land.y + 0.3);
        this.acid.push({ id: this.nextId++, pos: land, start: now, until: now + T.acidDuration, radius: T.acidRadius });
        this.events.emit('zHazard', { kind: 'acid', pos: land.clone() });
        continue;
      }
      s.pos.addScaledVector(s.vel, dt);
    }
    // delayed bomber blasts (chain reactions credit whoever killed the bomber)
    for (let i = this.pendingBlasts.length - 1; i >= 0; i--) {
      const b = this.pendingBlasts[i];
      if (now < b.at) continue;
      this.pendingBlasts.splice(i, 1);
      const owner = this.getAgent(b.ownerId);
      explode(this, b.pos, T.bomberRadius, ZOMBIES.bomber.damage * this.diff.damage, owner, 'bomber');
      this.gadgets.explosion(b.pos, T.bomberRadius, 600, null);
      this.events.emit('zBlast', { kind: 'bomber', pos: b.pos.clone(), radius: T.bomberRadius });
    }
  }

  // ======================================================================== machines
  private updateMachines() {
    const now = this.time, b = this.box, f = this.forge;
    if (b.state === 'spinning' && now >= b.until) {
      if (b.teddy) {
        b.state = 'teddy'; b.until = now + 2.6;
        const u = this.getAgent(b.userId);
        if (u) { u.money += BOX_PRICE; this.events.emit('zPoints', { agentId: u.id, amount: BOX_PRICE, reason: 'Refund' }); }
        this.events.emit('zBox', { state: 'teddy', weapon: null, byId: b.userId ?? -1, spot: b.spot });
      } else {
        b.state = 'ready'; b.until = now + BOX_TUNING.ready;
        this.events.emit('zBox', { state: 'ready', weapon: b.weapon, byId: b.userId ?? -1, spot: b.spot });
      }
    } else if (b.state === 'ready' && now >= b.until) {
      this.events.emit('zBox', { state: 'expired', weapon: b.weapon, byId: b.userId ?? -1, spot: b.spot });
      b.state = 'idle'; b.weapon = null; b.userId = null;
    } else if (b.state === 'teddy' && now >= b.until) {
      b.state = 'moving'; b.until = now + BOX_TUNING.moveTime;
    } else if (b.state === 'moving' && now >= b.until) {
      const others = b.spotsPos.map((_, i) => i).filter((i) => i !== b.spot);
      const open = others.filter((i) => this.zoneOpen[this.zoneAt(b.spotsPos[i].x, b.spotsPos[i].z) ?? ''] );
      b.spot = this.rng.pick(open.length ? open : others);
      const s = b.spotsPos[b.spot];
      b.pos.set(s.x, 0, s.z); b.yaw = s.yaw;
      b.state = 'idle'; b.pulls = 0; b.moved = true; b.teddy = false; b.userId = null; b.weapon = null;
      this.events.emit('zBox', { state: 'moved', weapon: null, byId: -1, spot: b.spot });
    }
    if (f.state === 'working' && now >= f.until) {
      f.state = 'ready'; f.until = now + 18;
      this.events.emit('zForge', { state: 'ready', byId: f.ownerId ?? -1, weapon: f.weapon! });
    } else if (f.state === 'ready' && now >= f.until) {
      this.events.emit('zForge', { state: 'expired', byId: f.ownerId ?? -1, weapon: f.weapon! });
      f.state = 'idle'; f.weapon = null; f.ownerId = null;
    }
  }

  // ======================================================================== interactions
  /**
   * Close enough to the Armory to buy from it. Checked directly, not through `interactionFor`:
   * a downed teammate or an ammo crate nearby takes the Use prompt but must not cancel a purchase.
   */
  nearArmory(a: Agent): boolean {
    return !!a.zp && a.alive && !a.zp.downed && this.facing(a, this.armoryPos.x, this.armoryPos.z, 2.0) >= 0;
  }

  private facing(a: Agent, x: number, z: number, reach: number): number {
    const dx = x - a.pos.x, dz = z - a.pos.z, d = Math.hypot(dx, dz);
    if (d > reach) return -1;
    const eye = a.eyePos(tmpV), to = tmpV2.set(x, a.pos.y + 1.0, z).sub(eye);
    const len = to.length();
    const hit = this.world.collision.raycast(eye, to.multiplyScalar(1 / Math.max(0.001, len)), len);
    // The destination machine itself is solid. Accept its front face, but never a wall
    // or another prop between us and it.
    if (hit && !(x >= hit.box.minX && x <= hit.box.maxX && z >= hit.box.minZ && z <= hit.box.maxZ)) return -1;
    if (d < 0.9) return d;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    return (dx * fx + dz * fz) / d > 0.45 ? d : -1;
  }

  /** What the "use" key would do right now (also drives the HUD prompt). */
  interactionFor(a: Agent): Interaction | null {
    const zp = a.zp;
    if (!zp || !a.alive || zp.downed) return null;
    // revive a downed teammate (hold): keep on the one you are already reviving, so a second
    // teammate going down beside you never wipes the progress (and their bleed-out pause)
    const revive = (h: Agent): Interaction => ({ kind: 'revive', label: h.name, verb: 'revive', price: 0, ok: true, reason: '', hold: true, ref: h.id, progress: h.zp!.revive?.byId === a.id ? h.zp!.revive.progress : 0 });
    const current = this.humans.find((h) => h !== a && h.alive && h.zp!.downed && h.zp!.revive?.byId === a.id);
    if (current && this.canRevive(a, current)) return revive(current);
    for (const h of this.humans) {
      if (h === a || !h.alive || !h.zp!.downed) continue;
      if (h.zp!.revive && h.zp!.revive.byId !== a.id) continue;
      if (this.canRevive(a, h)) return revive(h);
    }
    const cand: { it: Interaction; d: number }[] = [];
    const add = (it: Interaction, d: number) => { if (d >= 0) cand.push({ it, d }); };
    const b = this.box;
    if (b.state === 'idle' || (b.state === 'ready' && b.userId === a.id)) {
      const d = this.facing(a, b.pos.x, b.pos.z, 2.3);
      if (b.state === 'ready') add({ kind: 'boxTake', label: WEAPONS[b.weapon!].name, verb: 'take', price: 0, ok: true, reason: '', hold: false, ref: 0 }, d);
      else { const price = this.boxPrice(); add({ kind: 'box', label: 'Mystery Box', verb: 'use', price, ok: a.money >= price, reason: a.money < price ? 'Not enough points' : '', hold: false, ref: 0 }, d); }
    }
    const f = this.forge;
    {
      const d = this.facing(a, f.pos.x, f.pos.z, 2.6);
      if (f.state === 'ready' && f.ownerId === a.id) add({ kind: 'forgeTake', label: WEAPONS[f.weapon!].name, verb: 'take', price: 0, ok: true, reason: '', hold: false, ref: 0 }, d);
      else if (f.state === 'idle') {
        const w = a.active === 'primary' || a.active === 'secondary' ? a.activeWeapon() : null;
        const ok = this.power && !!w && (w.def.tier ?? 0) === 0 && a.money >= FORGE_PRICE;
        const reason = !this.power ? 'Requires power' : !w ? 'Hold the gun you want to upgrade' : (w.def.tier ?? 0) > 0 ? 'Already upgraded' : a.money < FORGE_PRICE ? 'Not enough points' : '';
        add({ kind: 'forge', label: w ? `Prototype Forge — upgrade ${w.def.name}` : 'Prototype Forge', verb: 'use', price: FORGE_PRICE, ok, reason, hold: false, ref: 0 }, d);
      }
    }
    this.perkMachines.forEach((m, i) => {
      const d = this.facing(a, m.pos.x, m.pos.z, 1.9);
      if (d < 0) return;
      const def = PERKS[m.perk], price = this.perkPrice(m.perk);
      const owned = zp.perks.includes(m.perk);
      const soldOut = m.soldOut || (m.perk === 'secondWind' && this.humans.length === 1 && zp.selfRevives <= 0);
      const reason = def.needsPower && !this.power ? 'Requires power' : owned ? 'Already active' : soldOut ? 'Sold out' : zp.perks.length >= PERK_LIMIT ? `Perk limit (${PERK_LIMIT})` : a.money < price ? 'Not enough points' : '';
      add({ kind: 'perk', label: def.name, verb: 'buy', price, ok: !reason, reason, hold: false, ref: i }, d);
    });
    this.wallBuys.forEach((w, i) => {
      const d = this.facing(a, w.pos.x, w.pos.z, 1.7);
      if (d < 0) return;
      const own = [a.primary, a.secondary].find((x) => x && x.def.id === w.weapon);
      if (own) {
        const price = (own.def.tier ?? 0) > 0 ? FORGED_AMMO_PRICE : ammoPrice(w.price);
        const full = own.reserve >= own.def.reserve;
        add({ kind: 'ammo', label: `${own.def.name} ammo`, verb: 'buy', price, ok: !full && a.money >= price, reason: full ? 'Ammo full' : a.money < price ? 'Not enough points' : '', hold: false, ref: i }, d);
      } else add({ kind: 'wallBuy', label: WEAPONS[w.weapon].name, verb: 'buy', price: w.price, ok: a.money >= w.price, reason: a.money < w.price ? 'Not enough points' : '', hold: false, ref: i }, d);
    });
    this.gates.forEach((g, i) => {
      if (g.open) return;
      const r = g.rect;
      const cx = clamp(a.pos.x, r.x0, r.x1), cz = clamp(a.pos.z, r.z0, r.z1);
      const d = Math.hypot(cx - a.pos.x, cz - a.pos.z);
      if (d > 1.7) return;
      add({ kind: 'gate', label: g.def.name, verb: 'open', price: g.def.price, ok: a.money >= g.def.price, reason: a.money < g.def.price ? 'Not enough points' : '', hold: false, ref: i }, d);
    });
    if (!this.power) add({ kind: 'power', label: 'Power Switch', verb: 'turn on', price: 0, ok: true, reason: '', hold: false, ref: 0 }, this.facing(a, this.powerPos.x, this.powerPos.z, 1.9));
    add({ kind: 'armory', label: 'Armory', verb: 'open', price: 0, ok: true, reason: '', hold: false, ref: 0 }, this.facing(a, this.armoryPos.x, this.armoryPos.z, 2.0));
    if (this.exfil.phase === 'available') {
      const r = this.layout.radio;
      add({ kind: 'radio', label: 'Exfil Radio', verb: 'call the exfil', price: 0, ok: true, reason: '', hold: false, ref: 0 }, this.facing(a, r.x, r.z, 2.3));
    }
    const crate = this.gadgets.ammoBoxNear(a);
    if (crate) add({ kind: 'ammoCrate', label: 'Ammo Crate', verb: 'resupply from', price: 0, ok: true, reason: '', hold: false, ref: crate.id }, 0.5);
    if (!cand.length) return null;
    cand.sort((x, y) => x.d - y.d);
    return cand[0].it;
  }

  protected override updateUse(a: Agent, cmd: AgentCommand) {
    const zp = a.zp;
    if (!zp) return;
    const pressed = cmd.use && !zp.usePrev;
    zp.usePrev = cmd.use;
    const it = this.interactionFor(a);
    // revive: hold
    const prev = this.reviving.get(a.id);
    if (it?.kind === 'revive' && cmd.use) {
      const t = this.getAgent(it.ref)!;
      if (prev !== undefined && prev !== t.id) this.stopRevive(a);
      const r = t.zp!.revive;
      if (!r || r.byId !== a.id) t.zp!.revive = { byId: a.id, progress: 0 };
      this.reviving.set(a.id, t.id);
      const need = this.hasPerk(a, 'secondWind') ? T.reviveTimeFast : T.reviveTime;
      t.zp!.revive!.progress += this.stepDt / need;
      if (t.zp!.revive!.progress >= 1) this.reviveHuman(t, a, false);
      return;
    }
    if (prev !== undefined) this.stopRevive(a);
    if (!it || !pressed) return;
    if (!it.ok) { this.events.emit('zDenied', { agentId: a.id, reason: it.reason }); return; }
    this.interact(a, it);
  }

  private stopRevive(a: Agent) {
    const tid = this.reviving.get(a.id);
    this.reviving.delete(a.id);
    const t = tid !== undefined ? this.getAgent(tid) : null;
    if (t?.zp?.revive?.byId === a.id) t.zp.revive = null;
  }

  private canRevive(a: Agent, target: Agent): boolean {
    return Math.hypot(target.pos.x - a.pos.x, target.pos.z - a.pos.z) < T.reviveRange
      && Math.abs(target.pos.y - a.pos.y) < 1.3
      && !this.world.collision.segmentBlocked(a.centerPos(tmpV), target.centerPos(tmpV2));
  }

  /** Perform an interaction (used by the player's use key and by bots). */
  interact(a: Agent, it: Interaction): boolean {
    switch (it.kind) {
      case 'wallBuy': return this.buyWallWeapon(a, it.ref);
      case 'ammo': return this.buyAmmo(a, it.ref);
      case 'gate': return this.openGate(a, it.ref);
      case 'perk': return this.buyPerk(a, it.ref);
      case 'box': return this.useBox(a);
      case 'boxTake': return this.takeBoxWeapon(a);
      case 'forge': return this.startForge(a);
      case 'forgeTake': return this.takeForged(a);
      case 'power': return this.turnOnPower(a);
      case 'armory': this.events.emit('zArmory', { agentId: a.id }); return true;
      case 'radio': return this.callExfil(a);
      case 'ammoCrate': {
        const box = this.gadgets.devices.find((d) => d.id === it.ref);
        if (!box) return false;
        box.usedBy = box.usedBy ?? new Set();
        box.usedBy.add(a.id);
        for (const w of [a.primary, a.secondary]) if (w) w.reserve = Math.max(w.reserve, w.def.reserve);
        this.events.emit('resupply', { agentId: a.id });
        return true;
      }
      default: return false;
    }
  }

  /** Put a gun in an empty slot, or replace the one in your hands. */
  giveWeapon(a: Agent, id: WeaponId, tier = 0) {
    const w = zWeapon(id, tier, a.zp?.perks ?? []);
    const slot: 'primary' | 'secondary' = !a.primary ? 'primary' : !a.secondary ? 'secondary' : a.active === 'secondary' ? 'secondary' : 'primary';
    a[slot] = w;
    a.active = slot === 'primary' ? 'secondary' : 'primary';
    equip(this, a, slot);
  }

  buyWallWeapon(a: Agent, i: number): boolean {
    const w = this.wallBuys[i];
    if (!w || [a.primary, a.secondary].some((x) => x?.def.id === w.weapon)) return false;
    if (!this.spend(a, w.price, 'weapon', WEAPONS[w.weapon].name)) return false;
    this.giveWeapon(a, w.weapon);
    return true;
  }

  buyAmmo(a: Agent, i: number): boolean {
    const wb = this.wallBuys[i];
    const own = [a.primary, a.secondary].find((x) => x && x.def.id === wb.weapon);
    if (!own || own.reserve >= own.def.reserve) return false;
    const price = (own.def.tier ?? 0) > 0 ? FORGED_AMMO_PRICE : ammoPrice(wb.price);
    if (!this.spend(a, price, 'ammo', `${own.def.name} ammo`)) return false;
    own.reserve = own.def.reserve;
    this.events.emit('resupply', { agentId: a.id });
    return true;
  }

  openGate(a: Agent | null, i: number, free = false): boolean {
    const g = this.gates[i];
    if (!g || g.open) return false;
    if (a && !free && !this.spend(a, g.def.price, 'door', g.def.name)) return false;
    g.open = true; g.openedAt = this.time;
    if (g.box) this.world.collision.removeDynamic(g.box);
    g.box = null;
    this.world.nav.unblock(g.key);
    for (const z of g.def.zones) this.zoneOpen[z] = true;
    if (a?.zp) a.zp.stats.doors++;
    this.events.emit('zDoor', { gateId: g.def.id, byId: a?.id ?? -1, pos: g.center.clone() });
    this.computeFlow();
    return true;
  }

  buyPerk(a: Agent, i: number): boolean {
    const m = this.perkMachines[i], zp = a.zp!;
    if (!m) return false;
    const def = PERKS[m.perk];
    if (def.needsPower && !this.power) return false;
    if (zp.perks.includes(m.perk) || zp.perks.length >= PERK_LIMIT) return false;
    const solo = this.humans.length === 1;
    if (m.perk === 'secondWind' && solo && zp.selfRevives <= 0) return false;
    if (!this.spend(a, this.perkPrice(m.perk), 'perk', def.name)) return false;
    if (m.perk === 'secondWind' && solo) zp.selfRevives--;
    this.addPerk(a, m.perk);
    return true;
  }

  addPerk(a: Agent, p: PerkId) {
    const zp = a.zp!;
    if (zp.perks.includes(p)) return;
    zp.perks.push(p);
    zp.stats.perks++;
    if (p === 'ironGut') { a.maxHealth = 250; a.health = Math.min(250, a.health + 150); }
    for (const w of [a.primary, a.secondary]) if (w) refreshWeapon(w, zp.perks);
    this.events.emit('zPerk', { agentId: a.id, perk: p, gained: true });
  }

  private removePerk(a: Agent, p: PerkId) {
    const zp = a.zp!;
    zp.perks = zp.perks.filter((x) => x !== p);
    if (p === 'ironGut') { a.maxHealth = 100; a.health = Math.min(a.health, 100); }
    for (const w of [a.primary, a.secondary]) if (w) refreshWeapon(w, zp.perks);
    this.events.emit('zPerk', { agentId: a.id, perk: p, gained: false });
  }

  useBox(a: Agent): boolean {
    const b = this.box;
    if (b.state !== 'idle') return false;
    const price = this.boxPrice();
    if (!this.spend(a, price, 'box', 'Mystery Box')) return false;
    b.pulls++;
    a.zp!.stats.boxPulls++;
    const fireSale = this.time < this.timers.fireSale;
    b.teddy = !fireSale && this.rng.next() < teddyChance(b.pulls, b.moved);
    const owned = new Set([a.primary?.def.id, a.secondary?.def.id]);
    const pool = BOX_POOL.filter(([id]) => !owned.has(id));
    const total = pool.reduce((s, [, w]) => s + w, 0);
    let r = this.rng.next() * total;
    b.weapon = pool[0][0];
    for (const [id, w] of pool) { r -= w; if (r <= 0) { b.weapon = id; break; } }
    b.state = 'spinning'; b.until = this.time + BOX_TUNING.spin; b.userId = a.id; b.startedAt = this.time;
    this.events.emit('zBox', { state: 'spin', weapon: null, byId: a.id, spot: b.spot });
    return true;
  }

  takeBoxWeapon(a: Agent): boolean {
    const b = this.box;
    if (b.state !== 'ready' || b.userId !== a.id || !b.weapon) return false;
    this.giveWeapon(a, b.weapon);
    this.events.emit('zBox', { state: 'taken', weapon: b.weapon, byId: a.id, spot: b.spot });
    b.state = 'idle'; b.weapon = null; b.userId = null;
    return true;
  }

  startForge(a: Agent): boolean {
    const f = this.forge;
    if (f.state !== 'idle' || !this.power) return false;
    const slot = a.active === 'primary' || a.active === 'secondary' ? a.active : null;
    const w = slot ? a[slot] : null;
    if (!slot || !w || (w.def.tier ?? 0) > 0) return false;
    if (!this.spend(a, FORGE_PRICE, 'forge', w.def.name)) return false;
    a[slot] = null;
    equipBest(this, a);
    f.state = 'working'; f.until = this.time + 3.6; f.weapon = w.def.id; f.ownerId = a.id; f.startedAt = this.time;
    this.events.emit('zForge', { state: 'start', byId: a.id, weapon: w.def.id });
    return true;
  }

  takeForged(a: Agent): boolean {
    const f = this.forge;
    if (f.state !== 'ready' || f.ownerId !== a.id || !f.weapon) return false;
    this.giveWeapon(a, f.weapon, 1);
    this.events.emit('zForge', { state: 'taken', byId: a.id, weapon: f.weapon });
    f.state = 'idle'; f.weapon = null; f.ownerId = null;
    return true;
  }

  turnOnPower(a: Agent | null): boolean {
    if (this.power) return false;
    this.power = true;
    this.events.emit('zPower', { byId: a?.id ?? -1 });
    return true;
  }

  /** Armory purchase (menu for the player, direct for bots). Returns why it failed, or '' on success. */
  armoryBlocker(a: Agent, id: ArmoryId): string {
    const g = a.grenades, d = a.gadgets, zp = a.zp!;
    const full = (() => {
      switch (id) {
        case 'frag': return g.frag >= 4;
        case 'stun': return g.stun >= 2;
        case 'molotov': return g.fire >= 2;
        case 'lure': return g.decoy >= 2;
        case 'mine': return d.mine >= 4;
        case 'wire': return d.wire >= 2;
        case 'barricade': return d.barricade >= 2;
        case 'kevlar': return a.armor >= 100;
        case 'plate': return a.armor >= 150;
        case 'stim': return d.stim >= 3;
        case 'ammoBox': return d.ammoBox >= 1;
        case 'selfRevive': return zp.reviveKit;
      }
    })();
    if (full) return 'Already full';
    if (a.money < ARMORY[id].price) return 'Not enough points';
    return '';
  }

  buyArmory(a: Agent, id: ArmoryId): boolean {
    if (!a.zp || !a.alive || a.zp.downed || this.armoryBlocker(a, id)) return false;
    if (!this.spend(a, ARMORY[id].price, 'armory', ARMORY[id].name)) return false;
    const g = a.grenades, d = a.gadgets;
    switch (id) {
      case 'frag': g.frag = Math.min(4, g.frag + 2); break;
      case 'stun': g.stun++; break;
      case 'molotov': g.fire++; break;
      case 'lure': g.decoy++; break;
      case 'mine': d.mine = Math.min(4, d.mine + 2); break;
      case 'wire': d.wire++; break;
      case 'barricade': d.barricade++; break;
      case 'kevlar': a.armor = Math.max(a.armor, 100); break;
      case 'plate': a.armor = Math.min(150, a.armor + 50); break;
      case 'stim': d.stim = 3; break;
      case 'ammoBox': d.ammoBox++; break;
      case 'selfRevive': a.zp.reviveKit = true; break;
    }
    return true;
  }

  // ======================================================================== exfil
  callExfil(a: Agent | null): boolean {
    if (this.exfil.phase !== 'available') return false;
    // Open a complete route from reception, even when the squad saved its points and
    // stayed in the lobby. Opening only the Yard Gate can leave Security Doors locked.
    const destination = this.zoneAt(this.layout.lz.x, this.layout.lz.z);
    const queue = [{ zone: this.layout.startZone, cost: 0, path: [] as number[] }];
    const visited = new Set<string>();
    while (queue.length) {
      queue.sort((p, q) => p.cost - q.cost);
      const route = queue.shift()!;
      if (visited.has(route.zone)) continue;
      visited.add(route.zone);
      if (route.zone === destination) {
        for (const i of route.path) if (!this.gates[i].open) this.openGate(null, i, true);
        break;
      }
      this.gates.forEach((g, i) => {
        const [u, v] = g.def.zones;
        const next = route.zone === u ? v : route.zone === v ? u : null;
        if (next && !visited.has(next)) queue.push({ zone: next, cost: route.cost + (g.open ? 0 : 1), path: [...route.path, i] });
      });
    }
    const gi = this.gates.findIndex((g) => g.def.id === this.layout.lzGate);
    if (gi >= 0 && !this.gates[gi].open) this.openGate(null, gi, true);
    this.exfil = { phase: 'called', until: this.time + T.exfilReach };
    this.wavePhase = 'exfil';
    this.nextSpawnAt = this.time + 1;
    this.events.emit('zExfil', { state: 'called', until: this.exfil.until });
    void a;
    return true;
  }

  inLz(h: Agent) { return Math.hypot(h.pos.x - this.layout.lz.x, h.pos.z - this.layout.lz.z) < T.exfilRadius; }

  private updateExfil() {
    const ex = this.exfil, now = this.time;
    if (ex.phase === 'available' && !this.exfilAvailableWave() && this.wavePhase !== 'exfil') { ex.phase = 'none'; return; }
    if (ex.phase === 'called') {
      if (this.standing().some((h) => this.inLz(h))) { this.exfil = { phase: 'holding', until: now + T.exfilHold }; this.events.emit('zExfil', { state: 'holding', until: this.exfil.until }); }
      else if (now >= ex.until) { this.exfil.phase = 'failed'; this.events.emit('zExfil', { state: 'failed', until: 0 }); this.endGame(false); }
    } else if (ex.phase === 'holding' && now >= ex.until) {
      if (this.standing().some((h) => this.inLz(h))) this.endGame(true);
      else { this.exfil.phase = 'failed'; this.events.emit('zExfil', { state: 'failed', until: 0 }); this.endGame(false); }
    }
  }

  // ======================================================================== debug / tests
  debugSetWave(w: number) { this.wave = w - 1; this.wavesCleared = w - 1; this.wavePhase = 'intermission'; this.phaseUntil = this.time; }
  debugKillAll() { for (const z of this.zombiePool) if (z.alive) this.killZombie(z, null, 'nuke', 'chest', new Vector3(1, 0, 0), true); }
  /** Remove every zombie and corpse at once (staging for screenshots / tests). */
  debugClear() { for (const z of this.zombiePool) { z.alive = false; z.zombie!.active = false; z.deathTime = -1e9; } this.powerUps = []; this.gas = []; this.acid = []; this.spits = []; }
  debugOpenAll() { this.gates.forEach((_, i) => this.openGate(null, i, true)); }
}
