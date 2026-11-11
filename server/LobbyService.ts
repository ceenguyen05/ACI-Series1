import { randomInt, randomUUID } from 'node:crypto';
import { Match } from '../src/sim/mode/Match';
import { narrowMapChoice, resolveMapChoice, sndMap, type SndMapChoice, type SndMapId } from '../src/sim/maps/index';
import { OUTFITS } from '../src/config/cosmetics';
import { MATCH_LENGTHS, type Team } from '../src/config/rules';
import { emptyCommand, type AgentCommand } from '../src/sim/entities/Agent';
import { captureSnapshot, encode, type WireEvent } from '../src/net/snapshot';
import { heldCommand, playerName, PROTOCOL_VERSION, QUEUE_WAIT_MS, roomOptions, roomCapacity, sanitizeCommand, validBuyItem,
  type LobbyPlayer, type LobbyState, type RoomOptions, type ServerMessage } from '../src/net/protocol';
import { MOVE } from '../src/config/movement';
import { ZombiesMatch } from '../src/sim/zombies/ZombiesMatch';
import { ACI_HQ_ZOMBIES } from '../src/sim/maps/aciHqZombies';
import { ARMORY } from '../src/config/zombies';
import { AccountStore, type Account } from './AccountStore';
import { levelAt, matchmakingWindow, rankLabel, RANKED_LEVEL, updateRank, type Award, type Career } from '../src/progression/career';
import { MatchRewards } from '../src/progression/MatchRewards';
import { balanceTeams, sameQueue, skillFits } from './matchmaking';

/** `encoded` is the JSON form of `message` when the service has already serialized it. */
export interface Peer { send(message: ServerMessage, encoded?: string): void; close?(): void }
/** Hard cap on a running match, measured from its start. Ending at the cap credits everyone normally. */
export const MATCH_TIME_LIMIT_MS = { snd: 90 * 60_000, zombies: 3 * 3_600_000 } as const;
const RESULTS_LINGER_MS = 120_000;
/** Clients ping every 2 s, so a connection silent this long is dead even if its socket isn't reaped yet. */
export const STALE_CLIENT_MS = 6000;
interface Client {
  id: string; peer: Peer; room: Room | null; agentId: number | null;
  pending: { seq: number; command: AgentCommand }[];
  last: AgentCommand; receivedAt: number; seq: number; ack: number;
  rateAt: number; messages: number; actions: number; seenAt: number;
  account: Account; participant: Participant | null;
}
interface Participant { clientId: string; account: Account; agentId: number; startTeam: Team; mmr: number; activityTicks: number;
  rewards: MatchRewards; awards: Award[]; abandoned: boolean; rankSettled: boolean }
export interface Room {
  code: string; visibility: 'public' | 'private'; ownerId: string; options: RoomOptions;
  players: LobbyPlayer[]; startsAt: number; match: Match | null; events: WireEvent[]; finishedAt: number | null; createdAt: number;
  matchId: string; participants: Participant[]; ranked: boolean; startedAt: number | null; lastFlushAt: number;
  /** Closed after a server error: nobody is charged an abandon. */
  failed?: boolean;
  /** The S&D map rolled at start. */
  mapId?: SndMapId;
}
const looks = () => ({ T: { ...OUTFITS.find(o => o.team === 'T')!.look }, CT: { ...OUTFITS.find(o => o.team === 'CT')!.look } });

/** One process owns all room state and simulations. No browser is a game host. */
export class LobbyService {
  shuttingDown = false;
  private lastMatchmakingAt = -Infinity;
  readonly clients = new Map<string, Client>();
  readonly rooms = new Map<string, Room>();
  constructor(private now = Date.now, private maxRooms = 16, readonly accounts = new AccountStore()) {}

  connect(peer: Peer, credential?: string): string {
    const id = randomUUID();
    let { account, token } = this.accounts.authenticate(credential);
    const existing = [...this.clients.values()].find(c => c.account.id === account.id);
    if (existing) {
      if (this.now() - existing.seenAt < STALE_CLIENT_MS) throw new Error('This online profile is already connected in another tab.');
      // A reconnect after a silent drop replaces the dead session instead of waiting for the heartbeat.
      existing.peer.close?.(); this.disconnect(existing.id);
      ({ account, token } = this.accounts.authenticate(credential)); // the release above may have parked it as idle
    }
    this.clients.set(id, { id, peer, room: null, agentId: null, pending: [], last: emptyCommand(), receivedAt: 0, seq: 0, ack: 0,
      rateAt: this.now(), messages: 0, actions: 0, seenAt: this.now(), account, participant: null });
    peer.send({ type: 'welcome', id, version: PROTOCOL_VERSION, accountId: account.id, token, career: account.career });
    return id;
  }
  disconnect(id: string) {
    const c = this.clients.get(id);
    if (c) { this.leave(c); this.accounts.release(c.account); }
    this.clients.delete(id);
  }
  private fail(c: Client, message: string) { c.peer.send({ type: 'error', message }); }
  private broadcast(r: Room, message: ServerMessage) {
    for (const p of r.players) this.clients.get(p.id)?.peer.send(message);
  }
  private lobby(r: Room) {
    const lobby: LobbyState = { code: r.code, visibility: r.visibility, ownerId: r.ownerId, options: r.options,
      players: r.players.map(p => ({ ...p })), startsAt: r.startsAt, serverNow: this.now(), ranked: r.options.playlist === 'ranked', ratingWindow: matchmakingWindow(this.now() - r.createdAt) };
    this.broadcast(r, { type: 'lobby', lobby });
  }
  private create(c: Client, options: RoomOptions, visibility: 'public' | 'private', name: unknown) {
    if (this.rooms.size >= this.maxRooms) { this.fail(c, 'The server is full. Please try again shortly.'); return; }
    let code: string;
    do { code = String(randomInt(10000, 100000)); } while (this.rooms.has(code));
    const now = this.now();
    const r: Room = { code, visibility, ownerId: c.id, options, players: [], startsAt: now + QUEUE_WAIT_MS, match: null,
      events: [], finishedAt: null, createdAt: now, matchId: randomUUID(), participants: [], ranked: false, startedAt: null, lastFlushAt: 0 };
    this.rooms.set(code, r);
    this.join(c, r, name);
  }
  /** `map`: the joiner's own map choice when matchmaking placed them here; it narrows a "random" room. */
  private join(c: Client, r: Room, name: unknown, map?: SndMapChoice): boolean {
    if (r.match) { this.fail(c, 'That match has already started.'); return false; }
    if (r.players.length >= roomCapacity(r.options)) { this.fail(c, 'That room is full.'); return false; }
    if (r.options.playlist === 'ranked' && !this.rankedReady(c)) return false;
    if (r.options.playlist === 'ranked' && !this.fits(r, c, this.now())) {
      this.fail(c, 'This Ranked room is outside your current skill range. Use Play online for a fair match.'); return false;
    }
    if (map && r.options.mode !== 'zombies') r.options = { ...r.options, map: narrowMapChoice(r.options.map, map) };
    const t = r.players.filter(p => p.team === 'T').length;
    const ct = r.players.length - t;
    r.players.push({ id: c.id, name: playerName(name), team: r.options.mode === 'zombies' ? 'CT' : t <= ct ? 'T' : 'CT',
      level: levelAt(c.account.career.xp).level, rank: rankLabel(c.account.career.rank) });
    c.room = r;
    this.lobby(r);
    if (r.players.length === roomCapacity(r.options)) this.start(r);
    return true;
  }
  private leave(c: Client) {
    const r = c.room;
    if (!r) return;
    if (!r.failed && r.match?.matchOver && r.finishedAt === null) this.finish(r);
    const part = c.participant;
    if (!this.shuttingDown && !r.failed && r.match && part && r.finishedAt === null && r.match.phase !== 'matchOver') {
      part.abandoned = true; part.rewards.dispose(); part.rewards.finish(false);
      if (r.ranked) this.settleRank(r, part, true);
      this.accounts.changed(); this.sendCareer(c, part);
    }
    if (r.match && !r.failed && c.agentId !== null) r.match.replaceWithBot(c.agentId);
    r.players = r.players.filter(p => p.id !== c.id);
    c.room = null; c.agentId = null; c.participant = null; c.pending = []; c.last = emptyCommand(); c.seq = c.ack = 0;
    if (!r.players.length) { for (const p of r.participants) p.rewards.dispose(); r.match?.events.clear(); this.rooms.delete(r.code); this.accounts.flush(); return; }
    if (r.ownerId === c.id) r.ownerId = r.players[0].id;
    if (!r.match) this.lobby(r);
  }
  private start(r: Room) {
    if (r.match || !r.players.length) return;
    const roster: NonNullable<import('../src/sim/mode/Match').MatchConfig['roster']> = [];
    let id = 1;
    if (r.visibility === 'public' && r.options.mode !== 'zombies') this.balance(r);
    r.ranked = r.visibility === 'public' && r.options.mode !== 'zombies' && r.options.playlist === 'ranked' && r.players.length === roomCapacity(r.options);
    for (const team of (r.options.mode === 'zombies' ? ['CT'] : ['T', 'CT']) as Team[]) {
      const humans = r.players.filter(p => p.team === team);
      for (let i = 0; i < r.options.teamSize; i++) {
        const p = humans[i], agentId = id++;
        roster.push({ id: agentId, name: p?.name ?? `BOT ${team === 'T' ? 'Raider' : 'Guard'} ${i + 1}`, team, isBot: !p, look: looks() });
        if (p) this.clients.get(p.id)!.agentId = agentId;
      }
    }
    const length = MATCH_LENGTHS[r.options.length];
    const config = { difficulty: 'normal' as const, playerTeam: 'spectator' as const, playerName: '', playerLook: looks(),
      seed: randomInt(1, 2 ** 30), roster, rules: { teamSize: r.options.teamSize, roundsToWin: length.roundsToWin, halfLength: length.halfLength } };
    const zombiesConfig = r.options.mode === 'zombies' ? { players: r.options.teamSize, difficulty: r.options.zDifficulty ?? 'normal', length: r.options.zLength ?? 'short',
      playerName: '', playerLook: looks(), spectate: true, seed: config.seed, networkRoster: roster, poolIds: Array.from({ length: 36 }, (_, i) => 100 + i) } : undefined;
    const mapId = r.mapId = zombiesConfig ? undefined : resolveMapChoice(r.options.map, n => randomInt(0, n));
    const m = r.match = zombiesConfig ? new ZombiesMatch({ ...zombiesConfig, layout: ACI_HQ_ZOMBIES }) : new Match({ ...config, map: sndMap(mapId) });
    m.events.onAny((type, payload) => { if (r.events.length < 2048) r.events.push({ type, payload: encode(payload) }); });
    r.startedAt = this.now();
    const snapshot = captureSnapshot(m, true);
    for (const p of r.players) {
      const c = this.clients.get(p.id)!;
      c.seq = c.ack = 0; c.pending = []; c.last = emptyCommand(); c.receivedAt = this.now();
      const awards: Award[] = [];
      const part: Participant = { clientId: c.id, account: c.account, agentId: c.agentId!, startTeam: p.team, mmr: c.account.career.rank.mmr,
        activityTicks: 0, awards, abandoned: false, rankSettled: false,
        rewards: new MatchRewards(m, c.agentId!, c.account.career, r.matchId, this.now, r.visibility === 'private' ? .5 : 1, a => { awards.push(...a); this.accounts.changed(); }) };
      c.participant = part; r.participants.push(part);
      c.peer.send({ type: 'started', match: { config, playerId: c.agentId!, snapshot, mode: zombiesConfig ? 'zombies' : 'snd', zombiesConfig, ranked: r.ranked, matchId: r.matchId, mapId } });
    }
  }

  private rankedReady(c: Client) {
    if (levelAt(c.account.career.xp).level >= RANKED_LEVEL && c.account.career.matches >= 5) return true;
    this.fail(c, `Ranked requires online level ${RANKED_LEVEL} and 5 completed online matches.`); return false;
  }
  private balance(r: Room) { balanceTeams(r.players, p => this.career(p.id).rank.mmr, r.options.teamSize); }
  private career(clientId: string): Career { return this.clients.get(clientId)!.account.career; }
  /** The shared skill rule for queueing, merging and Ranked code joins. */
  private fits(r: Room, c: Client, now: number) {
    return skillFits(r.options, r.players.map(p => this.career(p.id)), c.account.career, now - r.createdAt);
  }
  /** Contain a failure to its room: close it without abandon penalties and keep every other room running. */
  private abort(r: Room, error: unknown) {
    console.error(`Room ${r.code} closed after a server error`, error);
    r.failed = true;
    this.broadcast(r, { type: 'error', message: 'This match hit a server error and was closed. XP you earned is kept.' });
    for (const p of [...r.players]) {
      const c = this.clients.get(p.id);
      if (!c) continue;
      // `failed` keeps leave() away from the simulation; if it still throws, detach by hand.
      try { this.leave(c); } catch { c.room = null; c.agentId = null; c.participant = null; c.pending = []; }
    }
    r.players = [];
    for (const p of r.participants) p.rewards.dispose();
    this.rooms.delete(r.code);
    this.accounts.flush();
  }
  private settleRank(r: Room, p: Participant, abandon = false) {
    if (p.rankSettled || !r.ranked || !r.match) return;
    p.rankSettled = true;
    const own = r.participants.filter(a => a.startTeam === p.startTeam), other = r.participants.filter(a => a.startTeam !== p.startTeam);
    const avg = (a: Participant[]) => a.reduce((n, a) => n + a.mmr, 0) / Math.max(1, a.length);
    const a = r.match.getAgent(p.agentId)!;
    const delta = updateRank(p.account.career.rank, { score: r.match.winner === null ? .5 : r.match.winner === a.team ? 1 : 0,
      ownMmr: avg(own), opponentMmr: avg(other), margin: (r.match.score.T - r.match.score.CT) / Math.max(1, r.match.round), abandon });
    this.accounts.changed();
    this.clients.get(p.clientId)?.peer.send({ type: 'career', career: p.account.career, awards: [], rankDelta: delta, ranked: true });
  }
  private sendCareer(c: Client, p: Participant) { c.peer.send({ type: 'career', career: c.account.career, awards: p.awards.splice(0), ranked: c.room?.ranked }); }
  private finish(r: Room) {
    if (!r.match || r.finishedAt !== null) return;
    r.finishedAt = this.now();
    // A match this short is not a meaningful result: nobody is rated, and nobody is
    // charged an abandon for it. Inactive players in a full-length match still are.
    const rated = r.ranked && r.match.time >= 90;
    for (const p of r.participants) {
      const qualified = !p.abandoned && p.activityTicks >= MOVE.tickRate * 30 && r.match.time >= 90;
      p.rewards.finish(qualified); p.rewards.dispose();
      if (rated) this.settleRank(r, p, !qualified);
      const c = this.clients.get(p.clientId); if (c?.participant === p) this.sendCareer(c, p);
    }
    this.accounts.changed(); this.accounts.flush();
  }
  /** End at the server's time limit with the current leader, then settle normally. */
  private endAtTimeLimit(r: Room) {
    const m = r.match!;
    this.broadcast(r, { type: 'error', message: 'Match time limit reached. Final results are in.' });
    if (m instanceof ZombiesMatch) m.endGame(false);
    else m.forceEnd(m.score.T === m.score.CT ? null : m.score.T > m.score.CT ? 'T' : 'CT');
    this.finish(r);
  }
  /** Revisit waiting rooms as the skill window widens, rather than requiring players
   * to cancel/requeue to discover each other. Private codes are never merged. */
  private mergePublicRooms(now: number) {
    const rooms = [...this.rooms.values()].filter(r => !r.match && r.visibility === 'public');
    for (let i = 0; i < rooms.length; i++) {
      const dest = rooms[i]; if (!this.rooms.has(dest.code) || dest.match) continue;
      for (const source of rooms.slice(i + 1)) {
        if (dest.match || source.match || !this.rooms.has(source.code) || !sameQueue(dest.options, source.options)) continue;
        for (const p of [...source.players]) {
          if (dest.match || dest.players.length >= roomCapacity(dest.options)) break;
          const c = this.clients.get(p.id)!;
          if (!this.fits(dest, c, now)) continue;
          source.players = source.players.filter(x => x.id !== p.id); c.room = null;
          // join() repeats its own checks; if one ever refuses, keep the player where they were.
          if (!this.join(c, dest, p.name, source.options.map)) { source.players.push(p); c.room = source; }
        }
        if (!source.players.length) this.rooms.delete(source.code);
        else { if (!source.players.some(p => p.id === source.ownerId)) source.ownerId = source.players[0].id; this.lobby(source); }
      }
    }
  }

  /** Called only with a parsed, size-limited JSON value. A failure is contained to the sender's room. */
  receive(id: string, raw: unknown) {
    try { this.handle(id, raw); }
    catch (error) {
      const r = this.clients.get(id)?.room;
      if (r) this.abort(r, error); else console.error('Online message handling failed', error);
    }
  }
  /** Validate every field before use. */
  private handle(id: string, raw: unknown) {
    const c = this.clients.get(id);
    if (!c) return;
    const now = this.now();
    c.seenAt = now;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const v = raw as Record<string, unknown>;
    if (now - c.rateAt >= 1000) { c.rateAt = now; c.messages = c.actions = 0; }
    if (++c.messages > 160) return;
    if (v.type === 'ping') { if (typeof v.sentAt === 'number' && Number.isFinite(v.sentAt)) c.peer.send({ type: 'pong', sentAt: v.sentAt }); return; }
    if (v.type === 'input') {
      if (!c.room?.match || !Number.isSafeInteger(v.seq) || (v.seq as number) <= c.seq) return;
      const command = sanitizeCommand(v.command);
      if (!command) return;
      c.seq = v.seq as number; c.receivedAt = now;
      // Bounded backlog: flooding packets cannot make a player move faster.
      if (c.pending.length >= 8) c.pending.shift();
      c.pending.push({ seq: c.seq, command });
      return;
    }
    if (++c.actions > 12) return;
    if (v.type === 'leave') { this.leave(c); c.peer.send({ type: 'left' }); return; }
    if (v.type === 'start') {
      if (!c.room || c.room.ownerId !== id) { this.fail(c, 'Only the room owner can start the match.'); return; }
      this.start(c.room); return;
    }
    if (v.type === 'armory') {
      const m = c.room?.match, a = c.agentId === null ? null : m?.getAgent(c.agentId);
      if (!(m instanceof ZombiesMatch) || !a || typeof v.item !== 'string' || !Object.hasOwn(ARMORY, v.item) || !m.nearArmory(a) || !m.buyArmory(a, v.item as keyof typeof ARMORY)) this.fail(c, 'Armory purchase unavailable. Stand at the Armory with enough points.');
      return;
    }
    if (v.type === 'buy' || v.type === 'autoBuy' || v.type === 'rebuy') {
      const m = c.room?.match, a = c.agentId === null ? null : m?.getAgent(c.agentId);
      if (!m || !a || m instanceof ZombiesMatch || m.phase === 'matchOver') return;
      const ok = v.type === 'buy' ? validBuyItem(v.item) && m.tryBuy(a, v.item) : v.type === 'autoBuy' ? m.autoBuy(a) : m.rebuy(a);
      if (!ok) this.fail(c, 'Purchase unavailable: check your money, team, equipment and buy zone.');
      return;
    }
    if (!['create', 'queue', 'join'].includes(String(v.type))) return;
    if (c.room) { this.fail(c, 'Leave your current room before joining another.'); return; }
    if (v.type === 'join') {
      const code = typeof v.code === 'string' ? v.code.trim() : '';
      const r = /^\d{5}$/.test(code) ? this.rooms.get(code) : null;
      if (!r) { this.fail(c, 'Room not found. Check the five-digit code.'); return; }
      this.join(c, r, v.name); return;
    }
    const options = roomOptions(v.options);
    if (!options) { this.fail(c, 'Choose a team size from 1v1 to 5v5 and a valid match length.'); return; }
    if (options.playlist === 'ranked' && (options.teamSize < 3 || !this.rankedReady(c))) { if (options.teamSize < 3) this.fail(c, 'Ranked supports 3v3, 4v4 and 5v5.'); return; }
    if (v.type === 'create' && v.visibility === 'private' && options.playlist === 'ranked') { this.fail(c, 'Private matches are unranked. Choose Casual.'); return; }
    if (v.type === 'queue') {
      const r = [...this.rooms.values()].find(r => !r.match && r.visibility === 'public' && sameQueue(r.options, options) &&
        r.players.length < roomCapacity(options) && this.fits(r, c, now));
      if (r) this.join(c, r, v.name, options.map); else this.create(c, options, 'public', v.name);
    } else if (v.visibility === 'public' || v.visibility === 'private') this.create(c, options, v.visibility, v.name);
    else this.fail(c, 'Choose a public or private room.');
  }

  /** Advance exactly one simulation tick. Wall-clock queue timers never use simulation time. */
  step() {
    const now = this.now();
    if (now - this.lastMatchmakingAt >= 1000) {
      this.lastMatchmakingAt = now;
      try { this.mergePublicRooms(now); } catch (error) { console.error('Public room matchmaking failed', error); }
    }
    for (const r of this.rooms.values()) {
      try { this.stepRoom(r, now); } catch (error) { this.abort(r, error); }
    }
  }
  private stepRoom(r: Room, now: number) {
    if (!r.match && now >= r.startsAt) this.start(r);
    const m = r.match;
    if (!m) return;
    for (const p of r.players) {
      const c = this.clients.get(p.id)!;
      const next = c.pending.shift();
      if (next) { c.last = next.command; c.ack = next.seq; }
      const cmd = now - c.receivedAt > 250 ? { ...emptyCommand(), yaw: c.last.yaw, pitch: c.last.pitch } : next?.command ?? heldCommand(c.last);
      const a = m.getAgent(c.agentId!);
      if (c.participant && a?.alive && (cmd.forward || cmd.right || cmd.fire || cmd.use || cmd.reload || Math.abs(a.yaw - cmd.yaw) > .01)) c.participant.activityTicks++;
      m.setHumanCommand(c.agentId!, cmd);
    }
    if (m.phase !== 'matchOver') m.step(1 / MOVE.tickRate);
    if (m.phase === 'matchOver' && r.finishedAt === null) this.finish(r);
    if (r.finishedAt === null && r.startedAt !== null && now - r.startedAt > MATCH_TIME_LIMIT_MS[r.options.mode ?? 'snd']) this.endAtTimeLimit(r);
    if (r.finishedAt !== null && now - r.finishedAt > RESULTS_LINGER_MS) {
      this.broadcast(r, { type: 'error', message: 'This match has ended. Leave to return to online play.' });
      for (const p of [...r.players]) this.leave(this.clients.get(p.id)!);
    }
  }
  /** 20 Hz snapshots; authoritative events travel once and in order. */
  flush() {
    const now = this.now();
    for (const r of this.rooms.values()) {
      try { this.flushRoom(r, now); } catch (error) { this.abort(r, error); }
    }
  }
  private flushRoom(r: Room, now: number) {
    if (!r.match) return;
    // A finished board no longer changes; 1 Hz keeps clients' connection status fresh.
    if (r.finishedAt !== null && !r.events.length && now - r.lastFlushAt < 1000) return;
    r.lastFlushAt = now;
    const snapshot = captureSnapshot(r.match), events = r.events.splice(0);
    // Serialize the shared payload once per room; only `ack` differs between clients.
    const body = JSON.stringify({ snapshot, events }).slice(1);
    for (const p of r.players) {
      const c = this.clients.get(p.id)!;
      c.peer.send({ type: 'snapshot', snapshot, ack: c.ack, events }, `{"type":"snapshot","ack":${c.ack},${body}`);
      if (c.participant?.awards.length) this.sendCareer(c, c.participant);
    }
  }
}
