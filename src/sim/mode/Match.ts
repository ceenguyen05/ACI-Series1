import { Vector3 } from 'three';
import { EventBus } from '../../core/EventBus';
import { Random } from '../../core/Random';
import { DEG, clamp, approach, inRect } from '../../core/math';
import { MOVE } from '../../config/movement';
import { DEFAULT_RULES, otherTeam, type MatchRules, type Team } from '../../config/rules';
import { ECONOMY } from '../../config/economy';
import { DEFAULT_PISTOL, WEAPONS } from '../../config/weapons';
import { OUTFITS, type AgentLook } from '../../config/cosmetics';
import type { BotDifficulty } from '../../config/difficulty';
import { Agent, emptyCommand, makeWeapon, refitWeapon, type AgentCommand, type HitGroup, type WeaponInstance } from '../entities/Agent';
import { stepMotor } from '../physics/CharacterMotor';
import { moveAgent } from '../physics/AgentMovement';
import { World } from '../world/World';
import type { MapDef, SpawnArea, Spot } from '../world/MapTypes';
import type { SimEvents, RoundEndReason } from '../events';
import type { DamageFlags, NoiseKind, SimContext } from '../SimContext';
import type { DamageResult } from '../combat/damage';
import { explosionDamage } from '../combat/damage';
import { equip, equipBest, updateWeapon } from '../combat/WeaponSystem';
import { UtilityManager } from '../utility/UtilityManager';
import { GadgetManager } from '../gadget/GadgetManager';
import { ATTACHMENTS } from '../../config/attachments';
import type { WeaponId } from '../../config/weapons';
import { OrdnanceManager } from '../combat/Ordnance';
import { Killstreaks } from './Killstreaks';
import type { GadgetId } from '../../config/gadgets';
import { BotController } from '../ai/BotController';
import { TeamCoach } from '../ai/TeamCoach';
import { killReward, lossBonus, nextLossStreak, priceOf, purchaseBlocker, winReward, type BuyItem, itemKey } from './Economy';
import type { BombState, DroppedItem, MatchQuery, Phase } from './types';

export interface MatchConfig {
  map: MapDef;
  rules?: Partial<MatchRules>;
  difficulty: BotDifficulty;
  /** Player's starting side, or 'spectator' for an all-bot match. */
  playerTeam: Team | 'spectator';
  playerName: string;
  playerLook: Record<Team, AgentLook>;
  seed?: number;
  /** Extra static colliders for the mode (Zombies machines and boarded-up doorways). */
  worldExtras?: Omit<import('../physics/CollisionWorld').Box, 'id'>[];
  /** 'zombies' skips the Search & Destroy roster and round setup (ZombiesMatch builds its own). */
  mode?: 'snd' | 'zombies';
  /** Explicit roster for an authoritative online match or its display replica. */
  roster?: { id: number; name: string; team: Team; isBot: boolean; look: Record<Team, AgentLook> }[];
  localPlayerId?: number;
}

const BOT_NAMES = ['Rivet', 'Torque', 'Gasket', 'Sprocket', 'Ratchet', 'Flux', 'Solder', 'Piston', 'Dowel', 'Ledger',
  'Badge', 'Audit', 'Keycard', 'Memo', 'Lanyard', 'Stapler', 'Binder', 'Payroll', 'Forklift', 'Pallet'];

export interface RoundRecord { round: number; winner: Team; reason: RoundEndReason }

/** Authoritative Search & Destroy simulation. Pure logic – no rendering, DOM or audio. */
export class Match implements SimContext, MatchQuery {
  readonly events = new EventBus<SimEvents>();
  readonly world: World;
  readonly rules: MatchRules;
  readonly rng: Random;
  readonly utility = new UtilityManager();
  readonly gadgets = new GadgetManager();
  readonly ordnance = new OrdnanceManager();
  readonly killstreaks: Killstreaks;
  readonly agents: Agent[] = [];
  readonly bots = new Map<number, BotController>();
  readonly coaches: Record<Team, TeamCoach>;
  player: Agent | null = null;
  difficulty: BotDifficulty;

  time = 0;
  tick = 0;
  phase: Phase = 'freeze';
  phaseEnd = 0;
  liveStart = 0;
  round = 0;
  score: Record<Team, number> = { T: 0, CT: 0 };
  lossStreak: Record<Team, number> = { T: 0, CT: 0 };
  history: RoundRecord[] = [];
  items: DroppedItem[] = [];
  winner: Team | null = null;
  matchOver = false;
  bomb: BombState = { state: 'none', carrierId: null, pos: new Vector3(), vel: new Vector3(), site: null, plantedAt: 0, plantedBy: null, defuserId: null, nextBeep: 0, spottedByCT: -10 };
  lastRoundEnd: { winner: Team; reason: RoundEndReason; mvpId: number | null } | null = null;
  /** Spawn areas in use this round (ids into map.spawnAreas); their zones are the buy zones. Replicated. */
  spawnAreas: Record<Team, string[]> = { T: [], CT: [] };

  protected playerCmd: AgentCommand = emptyCommand();
  protected humanCommands = new Map<number, AgentCommand>();
  private pendingHalftime = false;
  protected losCache = new Map<number, boolean>();
  private nextItemId = 1;
  private plantedThisRound = false;
  /** The Attackers' area last round (never reused the next round) and each agent's last spot. */
  private lastAttackArea = '';
  private lastSpot = new Map<number, string>();
  protected prevUse = new Map<number, boolean>();

  constructor(cfg: MatchConfig) {
    this.rules = { ...DEFAULT_RULES, ...cfg.rules };
    this.rng = new Random(cfg.seed ?? (Math.random() * 1e9) | 0);
    this.world = new World(cfg.map, cfg.worldExtras);
    this.difficulty = cfg.difficulty;
    this.utility.attach(this);
    this.gadgets.attach(this);
    this.ordnance.attach(this);
    this.killstreaks = new Killstreaks(this);
    this.coaches = { T: new TeamCoach('T', this, this.bots), CT: new TeamCoach('CT', this, this.bots) };
    if (cfg.mode === 'zombies') return;

    const names = this.rng.shuffle([...BOT_NAMES]);
    const randomLook = (): Record<Team, AgentLook> => ({
      T: { ...this.rng.pick(OUTFITS.filter((o) => o.team === 'T')).look },
      CT: { ...this.rng.pick(OUTFITS.filter((o) => o.team === 'CT')).look },
    });
    let player: Agent | null = null;
    if (cfg.roster) {
      for (const p of cfg.roster) {
        const a = new Agent(p.name, p.team, p.isBot, p.look, p.id);
        a.money = this.rules.startMoney;
        this.agents.push(a);
        if (p.id === cfg.localPlayerId) player = a;
        if (p.isBot) this.bots.set(a.id, new BotController(a, this, cfg.difficulty, () => this.coaches[a.team]));
      }
    } else for (const team of ['T', 'CT'] as Team[]) {
      for (let i = 0; i < this.rules.teamSize; i++) {
        const isPlayer = cfg.playerTeam === team && i === 0;
        const a = isPlayer ? new Agent(cfg.playerName || 'Player', team, false, cfg.playerLook)
          : new Agent(`BOT ${names.pop() ?? 'Unit' + i}`, team, true, randomLook());
        a.money = this.rules.startMoney;
        this.agents.push(a);
        if (isPlayer) player = a;
        else this.bots.set(a.id, new BotController(a, this, cfg.difficulty, () => this.coaches[a.team]));
      }
    }
    this.player = player;
    this.startRound(true);
  }

  // ===================================================================== SimContext
  isFrozen() { return this.phase === 'freeze'; }
  isPistolRound() { return this.round === 1 || this.round === this.rules.halfLength + 1; }
  timeLeft() {
    if (this.phase === 'live') return this.phaseEnd - this.time;
    if (this.phase === 'planted') return this.bomb.plantedAt + this.rules.bombTimer - this.time;
    if (this.phase === 'freeze') return this.rules.roundTime;
    return 0;
  }
  canBuyNow(a: Agent): boolean {
    if (!a.alive) return false;
    const inTime = this.phase === 'freeze' || (this.phase === 'live' && this.time - this.liveStart <= this.rules.buyTime);
    return inTime && this.inBuyZone(a.team, a.pos.x, a.pos.z);
  }
  /** Inside one of the team's spawn areas in use this round. */
  inBuyZone(team: Team, x: number, z: number): boolean {
    return this.spawnAreas[team].some((id) => {
      const area = this.world.map.spawnAreas[team].find((s) => s.id === id);
      return !!area && inRect(area.zone, x, z);
    });
  }
  /** The nearest spawn spot (either team) far enough from (bx, bz) to be clear of a blast; bots run there. */
  fleePoint(a: Agent, bx: number, bz: number, clear = 36): Spot {
    let best: Spot | null = null, bestD = Infinity, far: Spot = { x: a.pos.x, z: a.pos.z }, farD = -1;
    for (const t of ['T', 'CT'] as const) for (const area of this.world.map.spawnAreas[t]) for (const s of area.spots) {
      const fromBomb = Math.hypot(s.x - bx, s.z - bz);
      if (fromBomb > farD) { farD = fromBomb; far = s; }
      const d = Math.hypot(s.x - a.pos.x, s.z - a.pos.z);
      if (fromBomb >= clear && d < bestD) { bestD = d; best = s; }
    }
    return best ?? far;
  }
  buyTimeLeft(): number {
    if (this.phase === 'freeze') return this.phaseEnd - this.time + this.rules.buyTime;
    if (this.phase === 'live') return Math.max(0, this.rules.buyTime - (this.time - this.liveStart));
    return 0;
  }
  setPlayerCommand(cmd: AgentCommand) { this.playerCmd = cmd; }
  setHumanCommand(id: number, cmd: AgentCommand) { this.humanCommands.set(id, cmd); }
  invalidateVisibility() { this.losCache.clear(); }
  /** Server time limit: end now with the given winner (null = draw), as a normal match end. */
  forceEnd(winner: Team | null) {
    if (this.phase === 'matchOver') return;
    this.winner = winner; this.matchOver = true; this.phase = 'matchOver';
    this.events.emit('matchEnd', { winner });
  }
  /** A disconnected human keeps their slot, inventory and score under bot control. */
  replaceWithBot(id: number) {
    const a = this.getAgent(id);
    if (!a || this.bots.has(id)) return;
    a.isBot = true;
    a.name = `BOT ${a.name}`;
    this.humanCommands.delete(id);
    if (a.operating !== null) this.gadgets.operate(a, null); // bots never leave a camera/drone feed
    const bot = new BotController(a, this, this.difficulty, () => this.coaches[a.team]);
    this.bots.set(id, bot);
    bot.resetRound();
  }
  getAgent(id: number | null) { return id === null ? null : this.agents.find((a) => a.id === id) ?? null; }
  setDifficulty(d: BotDifficulty) { this.difficulty = d; for (const b of this.bots.values()) b.setDifficulty(d); }

  los(o: Agent, t: Agent): boolean {
    const key = o.id * 65536 + t.id;
    const v = this.losCache.get(key);
    if (v !== undefined) return v;
    const r = this.computeLos(o, t);
    this.losCache.set(key, r);
    return r;
  }

  protected computeLos(o: Agent, t: Agent): boolean {
    if (!o.alive || !t.alive) return false;
    const eye = o.eyePos(new Vector3());
    if (eye.distanceTo(t.pos) > 90) return false;
    const targets = [t.eyePos(new Vector3()), t.aimPoint(false), new Vector3(t.pos.x, t.pos.y + Math.min(0.5, t.height * 0.35), t.pos.z)];
    for (const p of targets) {
      if (!this.world.collision.segmentBlocked(eye, p) && !this.utility.smokeBlocks(eye, p)) return true;
    }
    return false;
  }

  /**
   * Ping (middle mouse): mark the enemy under your crosshair (spotted on radar for 5 s) or the
   * spot you're looking at. Teammates see a marker; bots turn to check it.
   */
  teamPing(a: Agent) {
    a.pingReadyAt = this.time + 0.8;
    const eye = a.eyePos(new Vector3()), dir = a.viewDir(new Vector3());
    let enemy: Agent | null = null, best = Infinity;
    for (const e of this.agents) {
      if (!e.alive || e.team === a.team) continue;
      const c = e.centerPos(new Vector3());
      const to = c.clone().sub(eye);
      const d = to.length();
      if (d > 90) continue;
      const off = Math.acos(Math.min(1, to.dot(dir) / d));
      if (off > Math.atan2(0.7, d) + 0.03 || off > best) continue;
      if (!this.computeLos(a, e)) continue; // fresh: positions may have changed this tick
      best = off; enemy = e;
    }
    let pos: Vector3;
    if (enemy) {
      enemy.spottedUntil = Math.max(enemy.spottedUntil, this.time + 5);
      pos = enemy.centerPos(new Vector3());
    } else {
      const hit = this.world.collision.raycast(eye, dir, 80);
      pos = hit ? hit.point.clone().addScaledVector(hit.normal, 0.1) : eye.clone().addScaledVector(dir, 30);
    }
    this.events.emit('teamPing', { agentId: a.id, team: a.team, pos, enemyId: enemy?.id ?? null });
    for (const [id, bot] of this.bots) {
      const b = this.getAgent(id);
      if (b && b.alive && b.team === a.team && b !== a) bot.onTeamPing(pos);
    }
  }

  /**
   * Tactical lights: an enemy inside the beam (14 m, ~11° cone) who is looking back toward it
   * gets glare – the player sees a bright flare, bots aim slower.
   */
  protected updateWeaponLights() {
    const now = this.time;
    for (const a of this.agents) {
      if (!a.alive || !a.lightOn || a.operating !== null || !a.activeWeapon()?.def.mods?.light) continue;
      const eye = a.eyePos(new Vector3()), dir = a.viewDir(new Vector3());
      for (const e of this.agents) {
        if (!e.alive || e.team === a.team) continue;
        const ee = e.eyePos(new Vector3());
        const to = ee.clone().sub(eye);
        const d = to.length();
        if (d > 14 || d < 0.3) continue;
        to.divideScalar(d);
        const inBeam = to.dot(dir);
        if (inBeam < 0.98) continue;
        const facing = -to.dot(e.viewDir(new Vector3()));
        if (facing < 0.5) continue;
        if (!this.los(a, e)) continue;
        const strength = Math.min(1, (1 - d / 14) * 1.2) * ((facing - 0.5) * 2) * ((inBeam - 0.98) / 0.02);
        if (strength < 0.05) continue;
        e.dazzleUntil = now + 0.15;
        e.dazzleStrength = Math.max(strength, e.dazzleAt(now));
      }
    }
  }

  /** Per-round damage log for the death screen: key `${attacker}>${victim}`. */
  roundDamage = new Map<string, { dmg: number; hits: number }>();

  applyDamage(victim: Agent, attacker: Agent | null, dmg: DamageResult, group: HitGroup, source: string, point: Vector3, dir: Vector3, flags: DamageFlags = {}) {
    if (!victim.alive) return;
    if (attacker && attacker !== victim && attacker.team === victim.team && !this.rules.friendlyFire) return;
    const amount = Math.min(dmg.health, victim.health);
    victim.armor = Math.max(0, victim.armor - dmg.armor);
    if (victim.armor === 0) victim.helmet = false;
    victim.health -= amount;
    if (attacker && attacker !== victim && attacker.team !== victim.team) {
      attacker.stats.damage += amount;
      victim.damageTaken.set(attacker.id, (victim.damageTaken.get(attacker.id) ?? 0) + amount);
      const key = `${attacker.id}>${victim.id}`;
      const log = this.roundDamage.get(key) ?? { dmg: 0, hits: 0 };
      log.dmg += amount; log.hits++;
      this.roundDamage.set(key, log);
    }
    // CS-style aim punch: being shot kicks the victim's aim (less with a helmet on head shots)
    if (source !== 'fire' && source !== 'fall' && source !== 'bomb' && amount > 0) {
      const kick = Math.min(5, 0.6 + amount * 0.06) * (group === 'head' && victim.helmet ? 0.5 : 1);
      victim.flinchPitch = Math.min(7, victim.flinchPitch + kick);
      victim.flinchYaw += (this.rng.next() - 0.5) * kick * 0.8;
    }
    victim.lastHurtTime = this.time;
    if (attacker) victim.lastHurtFrom.copy(attacker.eyePos(new Vector3())); else victim.lastHurtFrom.copy(point).addScaledVector(dir, -2);
    if (source !== 'fire') { victim.motor.vel.x *= 0.5; victim.motor.vel.z *= 0.5; } // tagging
    this.events.emit('hit', { attackerId: attacker?.id ?? -1, victimId: victim.id, amount, armorDamage: dmg.armor, group, point, source, wallbang: !!flags.wallbang });
    this.bots.get(victim.id)?.onDamaged(attacker);
    // getting shot pulls you off camera feeds (not off a missile you're steering — dying does that)
    // (burning counts: standing in a fire is exactly when you need your eyes back)
    if (victim.operating !== null && this.gadgets.get(victim.operating)?.kind !== 'missile') this.gadgets.operate(victim, null);
    if (victim.health <= 0) this.kill(victim, attacker, source, group === 'head', dir, !!flags.wallbang);
  }

  /** Damage given / taken this round between `agentId` and each opponent (CS death-screen report). */
  damageReport(agentId: number) {
    const out: { otherId: number; given: { dmg: number; hits: number }; taken: { dmg: number; hits: number } }[] = [];
    for (const o of this.agents) {
      if (o.id === agentId) continue;
      const given = this.roundDamage.get(`${agentId}>${o.id}`) ?? { dmg: 0, hits: 0 };
      const taken = this.roundDamage.get(`${o.id}>${agentId}`) ?? { dmg: 0, hits: 0 };
      if (given.hits || taken.hits) out.push({ otherId: o.id, given, taken });
    }
    return out;
  }

  noise(pos: Vector3, radius: number, source: Agent | null, kind: NoiseKind) {
    for (const [id, bot] of this.bots) {
      const a = bot.agent;
      if (!a.alive || id === source?.id) continue;
      if (source && source.team === a.team && kind !== 'decoy') continue;
      const d = a.pos.distanceTo(pos);
      if (d > radius) continue;
      // walls muffle sound
      if (d > radius * 0.5 && this.world.collision.segmentBlocked(a.eyePos(new Vector3()), pos)) continue;
      bot.onHear(pos, kind);
    }
  }

  dropWeapon(a: Agent, w: WeaponInstance, toss: boolean) {
    const fwd = a.viewDir(new Vector3());
    const pos = a.eyePos(new Vector3()).addScaledVector(fwd, 0.3);
    pos.y -= 0.3;
    const vel = toss ? fwd.multiplyScalar(4).add(new Vector3(0, 1.5, 0)).add(a.vel) : new Vector3(this.rng.range(-1, 1), 1, this.rng.range(-1, 1));
    this.items.push({ id: this.nextItemId++, weapon: w, pos, vel, droppedBy: a.id, droppedAt: this.time, yaw: a.yaw });
  }

  // ===================================================================== buying
  tryBuy(a: Agent, item: BuyItem): boolean {
    if (!this.canBuyNow(a)) return false;
    if (purchaseBlocker(item, a)) return false;
    const price = priceOf(item, a);
    a.money -= price;
    if (item.kind !== 'attachment') a.roundBuys.push(item);
    switch (item.kind) {
      case 'weapon': {
        const def = WEAPONS[item.id];
        const slot = def.slot === 'primary' ? 'primary' : 'secondary';
        const old = a[slot];
        if (old) this.dropWeapon(a, old, false);
        a[slot] = makeWeapon(item.id, a.loadoutOf(item.id)); // your Gunsmith loadout comes back
        a.active = slot === 'primary' ? 'secondary' : 'primary'; // force a draw
        equip(this, a, slot);
        break;
      }
      case 'utility': a.grenades[item.id]++; break;
      case 'gadget': a.gadgets[item.id] = item.id === 'stim' ? 3 : a.gadgets[item.id] + 1; break;
      case 'gear':
        // never lower armor already raised by plates (up to 150)
        if (item.id === 'kevlar') a.armor = Math.max(a.armor, 100);
        else if (item.id === 'helmet') { a.armor = Math.max(a.armor, 100); a.helmet = true; }
        else if (item.id === 'kit') a.hasKit = true;
        else if (item.id === 'plate') a.armor = Math.min(150, Math.max(a.armor, 0) + 25);
        else if (item.id === 'crowbar') a.hasCrowbar = true;
        break;
      case 'attachment': this.fitAttachment(a, item.weapon, item.id); break;
    }
    this.events.emit('buy', { agentId: a.id, item: item.kind === 'attachment' ? `attachment:${item.weapon}:${item.id}` : `${item.kind}:${item.id}` });
    return true;
  }

  /**
   * Gunsmith: own the attachment (already paid for) and toggle it on the gun: fitting it
   * replaces whatever is in that slot; fitting it again takes it off.
   */
  private fitAttachment(a: Agent, weapon: import('../../config/weapons').WeaponId, id: import('../../config/attachments').AttachmentId) {
    const lo = a.loadouts[weapon] ??= { owned: [], equipped: {} };
    if (!lo.owned.includes(id)) lo.owned.push(id);
    const slot = ATTACHMENTS[id].slot;
    if (lo.equipped[slot] === id) delete lo.equipped[slot];
    else lo.equipped[slot] = id;
    for (const w of [a.primary, a.secondary]) if (w && w.def.id === weapon) refitWeapon(w, lo.equipped, true);
    this.events.emit('attachment', { agentId: a.id, weapon, id, fitted: lo.equipped[slot] === id });
  }

  /**
   * Rebuy (CS2-style): buy again whatever you bought last round that you don't already have.
   * Gunsmith attachments come back with the gun for free. Returns how many items were bought.
   */
  rebuy(a: Agent): number {
    if (!this.canBuyNow(a)) return 0;
    let n = 0;
    // grenades / gadgets: top up to what you had last round, never beyond it
    const want = new Map<string, number>();
    for (const item of a.lastBuys) want.set(itemKey(item), (want.get(itemKey(item)) ?? 0) + 1);
    const have = (item: BuyItem) => item.kind === 'utility' ? a.grenades[item.id] : item.kind === 'gadget' ? a.gadgets[item.id] : 0;
    // Only the last gun bought for each slot: a P-30 swapped for a Judge last round is not bought again.
    const lastGun = new Map<string, number>();
    a.lastBuys.forEach((item, i) => { if (item.kind === 'weapon') lastGun.set(WEAPONS[item.id].slot, i); });
    for (const [i, item] of a.lastBuys.entries()) {
      if (item.kind === 'attachment') continue;
      if (item.kind === 'weapon' && lastGun.get(WEAPONS[item.id].slot) !== i) continue;
      if ((item.kind === 'utility' || item.kind === 'gadget') && have(item) >= (want.get(itemKey(item)) ?? 0)) continue;
      if (this.tryBuy(a, item)) n++;
    }
    return n;
  }

  /**
   * Auto-buy: the best sensible loadout for the money – a rifle (or SMG / budget rifle when
   * short), armor, a kit on defense, then flash / smoke / frag while money lasts.
   */
  autoBuy(a: Agent): number {
    if (!this.canBuyNow(a)) return 0;
    let n = 0;
    const buy = (item: BuyItem) => { if (this.tryBuy(a, item)) n++; };
    const T = a.team === 'T';
    if (!a.primary) {
      const options: WeaponId[] = T ? ['ravager', 'galeforce', 'mako', 'vespa'] : ['sentinel', 'tempest', 'mako', 'hornet'];
      // keep enough for at least a vest when possible
      const pick = options.find((id) => a.money - WEAPONS[id].price >= 650) ?? options.find((id) => a.money >= WEAPONS[id].price);
      if (pick) buy({ kind: 'weapon', id: pick });
    }
    if (a.armor < 100 || !a.helmet) buy({ kind: 'gear', id: a.money >= 1000 || (a.armor >= 100 && !a.helmet) ? 'helmet' : 'kevlar' });
    if (!T && !a.hasKit) buy({ kind: 'gear', id: 'kit' });
    for (const u of ['flash', 'smoke', T ? 'fire' : 'flash', 'frag'] as const) buy({ kind: 'utility', id: u });
    return n;
  }

  // ===================================================================== rounds
  protected startRound(first = false) {
    if (this.pendingHalftime) this.doHalftime();
    this.round++;
    this.phase = 'freeze';
    this.phaseEnd = this.time + this.rules.freezeTime;
    this.liveStart = this.phaseEnd;
    this.items = [];
    this.roundDamage.clear();
    this.utility.clear();
    this.gadgets.resetRound();
    this.ordnance.clear();
    this.killstreaks.reset();
    this.plantedThisRound = false;
    this.lastRoundEnd = null;
    const spawns = this.chooseSpawns();
    for (const a of this.agents) {
      const keep = !first && a.alive && !this.isPistolRound();
      if (a.roundBuys.length) a.lastBuys = a.roundBuys;
      a.roundBuys = [];
      a.resetForRound(keep, DEFAULT_PISTOL[a.team]);
      const s = spawns.get(a.id)!;
      a.motor.pos.set(s.x, 0, s.z);
      a.motor.onGround = true;
      a.yaw = s.yaw;
      a.motor.bodyYaw = a.yaw; a.motor.groundY = a.pos.y;
      a.pitch = 0;
    }
    // bomb to a random attacker
    const ts = this.agents.filter((a) => a.team === 'T');
    if (ts.length) {
      const carrier = this.rng.pick(ts);
      carrier.hasBomb = true;
      this.bomb = { state: 'carried', carrierId: carrier.id, pos: carrier.pos.clone(), vel: new Vector3(), site: null, plantedAt: 0, plantedBy: null, defuserId: null, nextBeep: 0, spottedByCT: -10 };
    }
    for (const b of this.bots.values()) b.resetRound();
    this.events.emit('roundStart', { round: this.round });
  }

  /**
   * Where everyone starts this round. Attackers use one of their areas, never the same as last
   * round; Defenders are split at random between their areas (one per bombsite). Each player gets
   * a spot they did not have last round, nudged by up to 0.75 m and facing the area's focus point.
   */
  private chooseSpawns(): Map<number, { x: number; z: number; yaw: number }> {
    const map = this.world.map, out = new Map<number, { x: number; z: number; yaw: number }>();
    const taken: { x: number; z: number }[] = [];
    const team = (t: Team) => this.agents.filter((a) => a.team === t);
    const groups: [SpawnArea, Agent[]][] = [];
    // Attackers: one area for the whole team, a different one from last round.
    const tAreas = map.spawnAreas.T;
    const fresh = tAreas.length > 1 ? tAreas.filter((s) => s.id !== this.lastAttackArea) : tAreas;
    const tArea = this.rng.pick(fresh);
    this.lastAttackArea = tArea.id;
    groups.push([tArea, team('T')]);
    // Defenders: shuffled and split between the bombsite areas (2/3 or 3/2 in a 5v5, a coin flip in a 1v1).
    const cts = this.rng.shuffle(team('CT')), cAreas = this.rng.shuffle([...map.spawnAreas.CT]);
    if (cAreas.length === 1) groups.push([cAreas[0], cts]);
    else if (cAreas.length === 2) {
      const k = clamp(Math.round(cts.length / 2 + this.rng.range(-0.75, 0.75)), 0, cts.length);
      groups.push([cAreas[0], cts.slice(0, k)], [cAreas[1], cts.slice(k)]);
    } else cAreas.forEach((area, i) => groups.push([area, cts.filter((_, j) => j % cAreas.length === i)]));
    const defending = groups.slice(1).filter(([, g]) => g.length).map(([area]) => area.id);
    this.spawnAreas = { T: [tArea.id], CT: defending.length ? defending : cAreas.slice(0, 1).map((area) => area.id) };

    for (const [area, agents] of groups) {
      const spots = this.rng.shuffle([...area.spots]);
      const key = (s: Spot) => area.id + ':' + s.x + ',' + s.z;
      for (const a of agents) {
        // a spot this player did not have last round
        let i = spots.findIndex((s) => key(s) !== this.lastSpot.get(a.id));
        if (i < 0) i = 0;
        const base = spots.length ? spots.splice(i, 1)[0] : this.rng.pick(area.spots);
        this.lastSpot.set(a.id, key(base));
        const p = this.nudge(base, area, taken);
        taken.push(p);
        const yaw = Math.atan2(-(area.face.x - p.x), -(area.face.z - p.z)) + this.rng.range(-0.3, 0.3);
        out.set(a.id, { x: p.x, z: p.z, yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) });
      }
    }
    return out;
  }

  /** A random offset of up to 0.75 m that stays in the area, on open floor and clear of the other spawns. */
  private nudge(s: Spot, area: SpawnArea, taken: { x: number; z: number }[]) {
    const r = MOVE.radius, col = this.world.collision;
    const clear = (x: number, z: number) => inRect(area.zone, x, z) && this.world.nav.isWalkableAt(x, z) &&
      !col.overlaps(x - r, MOVE.stepHeight, z - r, x + r, MOVE.standHeight, z + r) && taken.every((t) => Math.hypot(t.x - x, t.z - z) >= 1.1);
    for (let k = 0; k < 6; k++) {
      const x = s.x + this.rng.range(-0.75, 0.75), z = s.z + this.rng.range(-0.75, 0.75);
      if (clear(x, z)) return { x, z };
    }
    return { x: s.x, z: s.z };
  }

  private doHalftime() {
    for (const a of this.agents) { a.streaks = []; a.streakKills = 0; a.loadouts = {}; } // Gunsmith unlocks last one half
    this.pendingHalftime = false;
    for (const a of this.agents) {
      a.team = otherTeam(a.team);
      a.money = this.rules.startMoney;
      a.alive = false; // forces a full reset
      a.primary = null;
    }
    this.score = { T: this.score.CT, CT: this.score.T };
    this.lossStreak = { T: 0, CT: 0 };
  }

  private endRound(winner: Team, reason: RoundEndReason) {
    if (this.phase === 'over' || this.phase === 'matchOver') return;
    const loser = otherTeam(winner);
    this.score[winner]++;
    this.history.push({ round: this.round, winner, reason });
    // economy
    for (const a of this.agents) {
      if (a.team === winner) this.addMoney(a, winReward(reason), 'Round win');
      else {
        // CS: attackers who survive a time-out get no loss bonus
        const survivedTimeout = reason === 'time' && a.team === 'T' && a.alive;
        if (!survivedTimeout) this.addMoney(a, lossBonus(this.lossStreak[loser] + 1), 'Loss bonus');
        if (a.team === 'T' && this.plantedThisRound) this.addMoney(a, ECONOMY.plantBonusTeamOnLoss, 'Bomb planted');
      }
    }
    this.lossStreak[winner] = nextLossStreak(this.lossStreak[winner], true);
    this.lossStreak[loser] = nextLossStreak(this.lossStreak[loser], false);
    // MVP
    let mvp: Agent | null = null;
    if (reason === 'defuse') mvp = this.getAgent(this.bomb.defuserId);
    else if (reason === 'bomb') mvp = this.getAgent(this.bomb.plantedBy);
    if (!mvp) {
      const ws = this.agents.filter((a) => a.team === winner);
      mvp = ws.reduce<Agent | null>((b, a) => (!b || a.stats.roundKills > b.stats.roundKills ? a : b), null);
      if (mvp && mvp.stats.roundKills === 0) mvp = null;
    }
    if (mvp) { mvp.stats.mvps++; mvp.stats.score += 2; }
    this.lastRoundEnd = { winner, reason, mvpId: mvp?.id ?? null };
    this.events.emit('roundEnd', { winner, reason, mvpId: mvp?.id ?? null });

    // match end / halftime
    if (this.score[winner] >= this.rules.roundsToWin) {
      this.winner = winner;
      this.matchOver = true;
    } else if (this.round >= this.rules.halfLength * 2) {
      this.winner = null; // draw
      this.matchOver = true;
    } else if (this.round === this.rules.halfLength) {
      this.pendingHalftime = true;
      this.events.emit('halftime', {});
    }
    this.phase = 'over';
    this.phaseEnd = this.time + this.rules.roundEndDelay;
  }

  protected addMoney(a: Agent, amount: number, reason: string) {
    const before = a.money;
    a.money = clamp(a.money + amount, 0, this.rules.maxMoney);
    if (a.money !== before) this.events.emit('money', { agentId: a.id, amount: a.money - before, reason });
  }

  protected kill(victim: Agent, attacker: Agent | null, source: string, headshot: boolean, dir: Vector3, wallbang = false) {
    victim.alive = false;
    victim.health = 0;
    victim.deathTime = this.time;
    victim.deathDir.copy(dir).setY(0).normalize();
    victim.killedBy = attacker && attacker !== victim ? attacker.id : -1;
    victim.stats.deaths++;
    victim.streakKills = 0;
    victim.heals = [];
    victim.isDefusing = false; victim.isPlanting = false;
    if (victim.operating !== null) this.gadgets.operate(victim, null);
    if (this.bomb.defuserId === victim.id) this.bomb.defuserId = null;
    if (attacker && attacker !== victim) {
      if (attacker.team !== victim.team) {
        attacker.stats.kills++;
        attacker.stats.roundKills++;
        attacker.stats.score += 2;
        if (headshot) attacker.stats.headshots++;
        this.addMoney(attacker, killReward(source), 'Kill');
        // a frag or fire that kills after you died counts for nothing: the streak is per life
        if (attacker.alive) this.killstreaks.onKill(attacker, source);
      } else {
        attacker.stats.kills--;
        this.addMoney(attacker, ECONOMY.teamKillPenalty, 'Team kill');
      }
    }
    // assists
    let assister: Agent | null = null, flashAssist = false;
    for (const [id, dmg] of victim.damageTaken) {
      if (attacker && id === attacker.id) continue;
      if (dmg >= 41) { assister = this.getAgent(id); break; }
    }
    if (!assister) {
      for (const [id, until] of victim.flashedBy) {
        if (until > this.time && (!attacker || id !== attacker.id)) { assister = this.getAgent(id); flashAssist = true; break; }
      }
    }
    if (assister && assister.team !== victim.team) { assister.stats.assists++; assister.stats.score++; }
    else assister = null;
    // drops
    const w = victim.primary ?? victim.secondary;
    if (w) {
      if (victim.primary === w) victim.primary = null; else victim.secondary = null;
      this.dropWeapon(victim, w, false);
    }
    if (victim.hasBomb) {
      victim.hasBomb = false;
      this.bomb.state = 'dropped';
      this.bomb.carrierId = null;
      this.bomb.pos.copy(victim.pos).add(new Vector3(0, 1, 0));
      this.bomb.vel.set(this.rng.range(-1, 1), 1, this.rng.range(-1, 1));
      this.events.emit('bombDrop', { agentId: victim.id, pos: this.bomb.pos.clone() });
    }
    this.events.emit('kill', {
      killerId: attacker?.id ?? -1, victimId: victim.id, weapon: source, headshot,
      assisterId: assister?.id ?? null, flashAssist, wallbang,
    });
  }

  // ===================================================================== main step
  step(dt: number) {
    this.time += dt;
    this.tick++;
    this.losCache.clear();

    // phase transitions
    if (this.phase === 'freeze' && this.time >= this.phaseEnd) {
      this.phase = 'live';
      this.liveStart = this.time;
      this.phaseEnd = this.time + this.rules.roundTime;
      for (const c of Object.values(this.coaches)) c.planRound();
      this.events.emit('freezeEnd', { round: this.round });
    } else if (this.phase === 'live' && this.time >= this.phaseEnd) {
      this.endRound('CT', 'time');
    } else if (this.phase === 'over' && this.time >= this.phaseEnd) {
      if (this.matchOver) {
        this.phase = 'matchOver';
        this.events.emit('matchEnd', { winner: this.winner });
      } else this.startRound();
    }

    // agents
    for (const a of this.agents) {
      if (!a.alive) continue;
      let cmd: AgentCommand;
      const bot = this.bots.get(a.id);
      if (bot) cmd = bot.think(dt);
      else cmd = this.humanCommands.get(a.id) ?? (a === this.player ? this.playerCmd : emptyCommand());
      this.applyCommand(a, cmd, dt);
    }
    if (this.phase === 'live' || this.phase === 'planted') { this.coaches.T.update(); this.coaches.CT.update(); }

    this.utility.update(dt);
    this.gadgets.update(dt);
    this.ordnance.update(dt);
    this.updateWeaponLights();
    this.killstreaks.update();
    this.updateBomb(dt);
    this.updateItems(dt);
    if (this.tick % 4 === 0) this.updateSpotting();
    this.checkWin();
  }

  protected prevFire = new Map<number, boolean>();

  protected applyCommand(a: Agent, cmd: AgentCommand, dt: number) {
    a.cmd = cmd;
    const decay = Math.exp(-dt * 10);
    a.flinchPitch *= decay; a.flinchYaw *= decay;
    if (cmd.killstreak) this.killstreaks.activate(a);
    if (cmd.ping && this.time >= a.pingReadyAt) this.teamPing(a);
    if (a.heals.length) {
      // stim heal-over-time
      a.heals = a.heals.filter((h) => h.until > this.time);
      a.healAcc += a.heals.reduce((s, h) => s + h.rate, 0) * dt;
      const whole = Math.floor(a.healAcc);
      if (whole > 0) { a.health = Math.min(a.maxHealth, a.health + whole); a.healAcc -= whole; }
      if (a.health >= a.maxHealth) a.healAcc = 0;
    }
    // ---- camera / drone feeds -------------------------------------------------------
    const steering = this.gadgets.get(a.operating)?.kind === 'missile'; // no bailing out of a missile
    if (cmd.cams && !steering) {
      if (a.operating !== null) this.gadgets.operate(a, null);
      // not during freeze time: CCTV would show the attackers' spawn, which changes every round
      else if (!a.isPlanting && !a.isDefusing && !this.isFrozen()) this.gadgets.cycle(a, 0);
    } else if (a.operating !== null && cmd.camCycle && !steering) this.gadgets.cycle(a, cmd.camCycle);
    if (a.operating !== null) {
      const firePressed = cmd.fire && !this.prevFire.get(a.id);
      this.prevFire.set(a.id, cmd.fire);
      this.gadgets.control(a, cmd, dt, firePressed);
      // the body stands still while you watch the feed
      a.lean = approach(a.lean, 0, dt * MOVE.leanSpeed);
      stepMotor(this.world.collision, a.motor, { forward: 0, right: 0, jump: false, crouch: a.motor.duck > 0.5, prone: a.prone, walk: false, yaw: a.yaw, maxSpeed: a.maxSpeed(), frozen: true }, dt);
      if (a.flashUntil <= this.time) a.flashStrength = 0;
      return;
    }
    this.prevFire.set(a.id, cmd.fire);
    a.yaw = cmd.yaw;
    a.pitch = clamp(cmd.pitch, -89 * DEG, 89 * DEG);

    const wasGround = a.motor.onGround;
    const wasSliding = a.sliding, wasProne = a.prone;
    const res = moveAgent(this, a, cmd, dt);
    if (wasProne !== a.prone) this.events.emit('prone', { agentId: a.id, down: a.prone, pos: a.pos.clone() });
    if (!wasSliding && a.sliding) {
      this.events.emit('slide', { agentId: a.id, pos: a.pos.clone() });
      this.noise(a.pos, 15, a, 'footstep');
      a.footstepDist = 0;
    }
    if (res.mantled && a.motor.mantle) {
      this.events.emit('mantle', { agentId: a.id, height: a.motor.mantle.height });
      this.noise(a.pos, 10, a, 'land');
    }
    if (wasGround && !a.motor.onGround && a.motor.vel.y > 0) this.events.emit('jump', { agentId: a.id });
    if (res.landed) {
      this.events.emit('land', { agentId: a.id, pos: a.pos.clone(), hard: res.impactSpeed > 6 });
      if (res.impactSpeed > 3) this.noise(a.pos, 12, a, 'land');
      if (res.impactSpeed > 11) {
        const dmg = Math.floor((res.impactSpeed - 11) * 9);
        if (dmg > 0) this.applyDamage(a, null, { health: dmg, armor: 0 }, 'legs', 'fall', a.pos.clone(), new Vector3(0, -1, 0));
        if (!a.alive) return;
      }
    }
    // footsteps (silent when walking or crouching)
    const sp = a.speed2D;
    if (a.motor.onGround && !a.sliding && sp > a.maxSpeed() * MOVE.footstepSpeedFrac) {
      a.footstepDist += sp * dt;
      if (a.footstepDist > 2.2) {
        a.footstepDist = 0;
        const floor = this.world.floorAt(a.pos.x, a.pos.z);
        this.events.emit('footstep', { agentId: a.id, pos: a.pos.clone(), surface: floor?.material ?? 'concrete' });
        this.noise(a.pos, 17, a, 'footstep');
      }
    } else a.footstepDist = Math.min(a.footstepDist, 1.5);

    updateWeapon(this, a, cmd, dt);
    this.updatePlantDefuse(a, cmd, dt);
    this.updateUse(a, cmd);

    // flash recovery
    if (a.flashUntil <= this.time) a.flashStrength = 0;
  }

  protected updatePlantDefuse(a: Agent, cmd: AgentCommand, dt: number) {
    const bomb = this.bomb;
    // planting
    if (a.team === 'T' && a.active === 'bomb' && a.hasBomb) {
      const site = this.world.siteAt(a.pos.x, a.pos.z);
      const canPlant = this.phase === 'live' && site !== null && a.motor.onGround && !a.sliding && this.time >= a.wpn.drawUntil;
      if (cmd.fire && canPlant) {
        if (!a.isPlanting) { a.isPlanting = true; a.plantProgress = 0; this.events.emit('plantStart', { agentId: a.id }); }
        a.plantProgress += dt / this.rules.plantTime;
        if (a.plantProgress >= 1) {
          a.isPlanting = false;
          a.hasBomb = false;
          this.plantedThisRound = true;
          bomb.state = 'planted';
          bomb.carrierId = null;
          bomb.site = site;
          bomb.pos.set(a.pos.x, a.pos.y, a.pos.z);
          bomb.plantedAt = this.time;
          bomb.plantedBy = a.id;
          bomb.nextBeep = this.time;
          this.phase = 'planted';
          this.addMoney(a, ECONOMY.plantReward, 'Planted bomb');
          a.stats.score += 2;
          equipBest(this, a);
          this.coaches.T.onBombPlanted(); this.coaches.CT.onBombPlanted();
          this.events.emit('bombPlanted', { agentId: a.id, site: site!, pos: bomb.pos.clone() });
          this.events.emit('message', { text: 'The bomb has been planted.', kind: 'big' });
          this.noise(bomb.pos, 30, a, 'bomb');
        }
      } else if (a.isPlanting) {
        a.isPlanting = false; a.plantProgress = 0;
        this.events.emit('plantAbort', { agentId: a.id });
      }
    } else if (a.isPlanting) { a.isPlanting = false; a.plantProgress = 0; }

    // defusing
    if (a.team === 'CT' && bomb.state === 'planted') {
      const d = Math.hypot(a.pos.x - bomb.pos.x, a.pos.z - bomb.pos.z);
      const can = cmd.use && d < 1.6 && Math.abs(a.pos.y - bomb.pos.y) < 1.2 && a.motor.onGround && !a.sliding &&
        (bomb.defuserId === null || bomb.defuserId === a.id) &&
        !this.world.collision.segmentBlocked(a.eyePos(), bomb.pos.clone().add(new Vector3(0, 0.12, 0)));
      if (can) {
        if (!a.isDefusing) {
          a.isDefusing = true; a.defuseProgress = 0; bomb.defuserId = a.id;
          a.wpn.reloadUntil = 0; a.wpn.burstLeft = 0; a.wpn.scope = 0; a.wpn.rescopeAt = 0; a.wpn.ads = false;
          this.events.emit('defuseStart', { agentId: a.id, kit: a.hasKit });
          this.noise(bomb.pos, 15, a, 'bomb');
        }
        a.defuseProgress += dt / (a.hasKit ? this.rules.defuseTimeKit : this.rules.defuseTime);
        if (a.defuseProgress >= 1) {
          a.isDefusing = false;
          bomb.state = 'defused';
          this.addMoney(a, ECONOMY.defuseReward, 'Defused bomb');
          a.stats.score += 2;
          this.events.emit('bombDefused', { agentId: a.id });
          this.events.emit('message', { text: 'The bomb has been defused.', kind: 'big' });
          this.endRound('CT', 'defuse');
        }
      } else if (a.isDefusing) {
        a.isDefusing = false; a.defuseProgress = 0;
        if (bomb.defuserId === a.id) bomb.defuserId = null;
        this.events.emit('defuseAbort', { agentId: a.id });
      }
    } else if (a.isDefusing) { a.isDefusing = false; a.defuseProgress = 0; }
  }

  /** "Use" key: swap-pick-up the weapon you're looking at. */
  protected updateUse(a: Agent, cmd: AgentCommand) {
    const pressed = cmd.use && !this.prevUse.get(a.id);
    this.prevUse.set(a.id, cmd.use);
    // crowbar: hold use on a barricade to pry it off
    const bar = cmd.use && a.hasCrowbar && !a.isDefusing ? this.gadgets.barricadeAt(a.eyePos(new Vector3()), a.viewDir(new Vector3())) : null;
    if (bar) {
      a.pryProgress += (1 / 64) / (bar.kind === 'steelBarricade' ? 4 : 1);
      if (a.pryProgress >= 1) {
        a.pryProgress = 0;
        this.events.emit('barricadeRemoved', { agentId: a.id, pos: bar.pos.clone() });
        this.gadgets.destroy(bar, a.id);
      }
      return;
    }
    a.pryProgress = 0;
    if (!pressed || a.isDefusing) return;
    const box = this.gadgets.ammoBoxNear(a);
    if (box) {
      box.usedBy = box.usedBy ?? new Set();
      box.usedBy.add(a.id);
      for (const w of [a.primary, a.secondary]) if (w) w.reserve = Math.max(w.reserve, w.def.reserve);
      if (a.gadgets.stim > 0) a.gadgets.stim = Math.min(4, a.gadgets.stim + 1);
      this.events.emit('resupply', { agentId: a.id });
      return;
    }
    const eye = a.eyePos(new Vector3()), dir = a.viewDir(new Vector3());
    let best: DroppedItem | null = null, bestD = 2.2;
    for (const it of this.items) {
      const to = it.pos.clone().sub(eye);
      const d = to.length();
      if (d > 2.4) continue;
      const along = to.dot(dir);
      if (along < 0) continue;
      const off = Math.sqrt(Math.max(0, d * d - along * along));
      if (off < 0.6 && d < bestD) { bestD = d; best = it; }
    }
    if (best) this.pickUp(a, best, true);
  }

  protected pickUp(a: Agent, it: DroppedItem, swap: boolean) {
    const slot = it.weapon.def.slot === 'primary' ? 'primary' : 'secondary';
    if (a[slot] && !swap) return;
    const old = a[slot];
    this.items = this.items.filter((x) => x !== it);
    if (old) this.dropWeapon(a, old, true);
    a[slot] = it.weapon;
    if (swap || a.active === 'melee') { a.active = slot === 'primary' ? 'secondary' : 'primary'; equip(this, a, slot); }
    this.events.emit('pickup', { agentId: a.id, item: it.weapon.def.id });
  }

  protected updateItems(dt: number) {
    const col = this.world.collision;
    const settle = (pos: Vector3, vel: Vector3) => {
      if (vel.lengthSq() === 0) return;
      vel.y -= 9.8 * dt;
      const next = pos.clone().addScaledVector(vel, dt);
      const ground = col.groundHeight(next.x, next.z, pos.y + 0.05) + 0.05;
      if (col.overlaps(next.x - 0.1, next.y, next.z - 0.1, next.x + 0.1, next.y + 0.1, next.z + 0.1)) { vel.x = 0; vel.z = 0; next.x = pos.x; next.z = pos.z; }
      if (next.y <= ground) { next.y = ground; vel.set(0, 0, 0); }
      pos.copy(next);
    };
    for (const it of this.items) settle(it.pos, it.vel);
    if (this.bomb.state === 'dropped') settle(this.bomb.pos, this.bomb.vel);
    // auto pickups
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (this.bomb.state === 'dropped' && a.team === 'T' && Math.hypot(a.pos.x - this.bomb.pos.x, a.pos.z - this.bomb.pos.z) < 1.0 && Math.abs(a.pos.y + 0.5 - this.bomb.pos.y) < 1.5) {
        a.hasBomb = true;
        this.bomb.state = 'carried';
        this.bomb.carrierId = a.id;
        this.events.emit('bombPickup', { agentId: a.id });
      }
      for (const it of this.items) {
        if (it.droppedBy === a.id && this.time - it.droppedAt < 1.5) continue;
        if (Math.hypot(a.pos.x - it.pos.x, a.pos.z - it.pos.z) > 0.9) continue;
        const slot = it.weapon.def.slot === 'primary' ? 'primary' : 'secondary';
        if (!a[slot]) { this.pickUp(a, it, false); break; }
      }
    }
    if (this.bomb.state === 'carried') {
      const c = this.getAgent(this.bomb.carrierId);
      if (c) this.bomb.pos.set(c.pos.x, c.pos.y + 1, c.pos.z);
    }
  }

  protected updateBomb(dt: number) {
    const bomb = this.bomb;
    void dt;
    if (bomb.state !== 'planted') return;
    const elapsed = this.time - bomb.plantedAt;
    const left = this.rules.bombTimer - elapsed;
    if (left <= 0) {
      bomb.state = 'exploded';
      this.events.emit('bombExploded', { pos: bomb.pos.clone() });
      this.noise(bomb.pos, 200, null, 'explosion');
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.pos.distanceTo(bomb.pos);
        const raw = d < 14 ? 500 : d < 32 ? 500 * Math.pow(1 - (d - 14) / 18, 2) : 0;
        if (raw > 0) this.applyDamage(a, null, explosionDamage(raw, a.armor), 'chest', 'bomb', a.pos.clone(), a.pos.clone().sub(bomb.pos).normalize());
      }
      this.gadgets.explosion(bomb.pos.clone().setY(bomb.pos.y + 0.5), 30, 1000, null);
      this.endRound('T', 'bomb');
      return;
    }
    if (this.time >= bomb.nextBeep) {
      const urgency = clamp(elapsed / this.rules.bombTimer, 0, 1);
      this.events.emit('bombBeep', { pos: bomb.pos.clone(), urgency });
      const interval = left > 10 ? 1.0 - urgency * 0.55 : left > 5 ? 0.3 : left > 2 ? 0.18 : 0.1;
      bomb.nextBeep = this.time + interval;
    }
  }

  protected updateSpotting() {
    const now = this.time;
    for (const o of this.agents) {
      if (!o.alive) continue;
      const view = o.viewDir(new Vector3());
      const eye = o.eyePos(new Vector3());
      for (const t of this.agents) {
        if (!t.alive || t.team === o.team) continue;
        const to = t.centerPos(new Vector3()).sub(eye);
        const d = to.length();
        if (d > 80 || to.normalize().dot(view) < Math.cos(75 * DEG)) continue;
        if (this.los(o, t)) t.spottedUntil = now + 0.6;
      }
      if (o.team === 'CT' && (this.bomb.state === 'dropped' || this.bomb.state === 'planted')) {
        const to = this.bomb.pos.clone().sub(eye);
        if (to.length() < 40 && to.normalize().dot(view) > 0.5 &&
            !this.world.collision.segmentBlocked(eye, this.bomb.pos.clone().add(new Vector3(0, 0.15, 0)))) this.bomb.spottedByCT = now;
      }
    }
  }

  protected checkWin() {
    if (this.phase !== 'live' && this.phase !== 'planted') return;
    const tAlive = this.agents.some((a) => a.alive && a.team === 'T');
    const ctAlive = this.agents.some((a) => a.alive && a.team === 'CT');
    if (this.phase === 'live') {
      if (!tAlive && !ctAlive) this.endRound('CT', 'elimination');
      else if (!tAlive) this.endRound('CT', 'elimination');
      else if (!ctAlive) this.endRound('T', 'elimination');
    } else if (!ctAlive) this.endRound('T', 'elimination');
  }

  // ===================================================================== helpers for UI
  teamOf(team: Team) { return this.agents.filter((a) => a.team === team); }
  alive(team: Team) { return this.agents.filter((a) => a.team === team && a.alive).length; }
  /** Debug/test: skip freeze time. */
  skipFreeze() { if (this.phase === 'freeze') this.phaseEnd = this.time; }
  /** Cut the round-end pause short (used after the killcam has played). */
  hurryRoundEnd(seconds: number) { if (this.phase === 'over') this.phaseEnd = Math.min(this.phaseEnd, this.time + seconds); }

  /** Debug/test helpers (exposed on window.__aci in the browser). */
  debugGive(a: Agent, id: import('../../config/weapons').WeaponId) {
    const def = WEAPONS[id];
    if (def.slot === 'melee') { equip(this, a, 'melee'); return; }
    const slot = def.slot === 'primary' ? 'primary' : 'secondary';
    a[slot] = makeWeapon(id, a.loadoutOf(id));
    a.active = slot === 'primary' ? 'secondary' : 'primary';
    equip(this, a, slot);
    a.wpn.drawUntil = this.time;
  }
  debugGiveStreak(a: Agent, id: import('./Killstreaks').StreakId) { a.streaks.push(id); }
  debugGiveGadget(a: Agent, id: GadgetId, n = 1) {
    a.gadgets[id] += n;
    equip(this, a, 'gadget', null, id);
    a.wpn.drawUntil = this.time;
  }
  debugTeleport(a: Agent, x: number, z: number, yaw: number, pitch = 0) {
    a.motor.pos.set(x, this.world.collision.groundHeight(x, z, 1.0), z);
    a.motor.vel.set(0, 0, 0);
    a.yaw = yaw; a.pitch = pitch;
  }
}
