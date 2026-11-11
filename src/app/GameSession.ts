import { MATCH_LENGTHS, type MatchRules, type Team } from '../config/rules';
import { MOVE } from '../config/movement';
import { Match } from '../sim/mode/Match';
import { sndMap, type SndMapId } from '../sim/maps/index';
import type { Agent } from '../sim/entities/Agent';
import { MatchView } from '../render/MatchView';
import type { GameRenderer } from '../render/Renderer';
import { HUD } from '../ui/hud/HUD';
import { BuyMenu } from '../ui/hud/BuyMenu';
import { MatchEndScreen, PauseMenu, Scoreboard } from '../ui/hud/Overlays';
import { SettingsPanel } from '../ui/screens/SettingsPanel';
import { h, setText } from '../ui/dom';
import { sfx } from '../audio/Sfx';
import type { Input } from './Input';
import { PlayerController } from './PlayerController';
import { makeAimAssist } from './AimAssist';
import { keyLabel } from '../config/controls';
import { announcer } from '../audio/Announcer';
import type { Profile, Settings } from './Profile';
import { ZombiesMatch } from '../sim/zombies/ZombiesMatch';
import { ACI_HQ_ZOMBIES } from '../sim/maps/aciHqZombies';
import { ZombiesView } from '../render/ZombiesView';
import { ZombiesHUD } from '../ui/hud/ZombiesHUD';
import { ArmoryMenu, ZombiesEndScreen, ZombiesScoreboard } from '../ui/hud/ZombiesOverlays';
import { RemoteMatch } from '../net/RemoteMatch';
import type { OnlineClient } from '../net/OnlineClient';
import type { MatchStart } from '../net/protocol';
import { emptyCommand } from '../sim/entities/Agent';
import { RemoteZombiesMatch } from '../net/RemoteZombiesMatch';
import { MatchRewards } from '../progression/MatchRewards';
import { levelAt, rankLabel, type Award } from '../progression/career';

export type GameMode = 'snd' | 'zombies';

export interface SessionOptions {
  mode?: GameMode;
  spectate?: boolean;
  timeScale?: number;
  rules?: Partial<MatchRules>;
  seed?: number;
  /** Zombies debug: start on this wave with these points. */
  startWave?: number;
  startPoints?: number;
  /** Search & Destroy map (App resolves "Randomize" before the session starts). */
  mapId?: SndMapId;
  online?: { client: OnlineClient; match: MatchStart };
}

const DT = 1 / MOVE.tickRate;
/** crypto.randomUUID needs a secure context; plain-HTTP LAN play (dev:online) does not have one. */
const localMatchId = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

/** One running match: fixed-tick simulation + view + HUD + overlays + input routing. */
export class GameSession {
  readonly match: Match;
  /** Set in Zombies (same object as `match`). */
  readonly zm: ZombiesMatch | null;
  readonly view: MatchView;
  private hud: HUD;
  private buy: BuyMenu;
  private scoreboard: Scoreboard | ZombiesScoreboard;
  private zview: ZombiesView | null = null;
  private zhud: ZombiesHUD | null = null;
  private armory: ArmoryMenu | null = null;
  private pause: PauseMenu;
  private settingsOverlay: HTMLDivElement;
  private clickToPlay: HTMLDivElement;
  private root: HTMLDivElement;
  private ctrl: PlayerController;
  private acc = 0;
  private paused = false;
  private ended = false;
  private expectUnlock = false;
  private spectateIdx = 0;
  private freeYaw = 0;
  private online: OnlineClient | null = null;
  private netStatus: HTMLElement | null = null;
  private connectionLost = false;
  private rewards: MatchRewards | null = null;
  private xpStatus: HTMLElement;
  private xpMessage = '';
  private xpUntil = 0;
  private earnedXp = 0;
  private rankDelta: number | null = null;
  private resultCareer: HTMLElement | null = null;
  /** performance.now() when the killcam should start (0 = none pending). */
  private killcamAt = 0;
  private holdUseUntilRelease = false;
  timeScale: number;
  onExit: () => void = () => {};
  /** Zombies end screen "Play again". */
  onRestart: () => void = () => {};

  constructor(private r: GameRenderer, private input: Input, private profile: Profile, uiRoot: HTMLElement,
    private saveProfile: () => void, private applySettings: (s: Settings) => void, opts: SessionOptions = {}) {
    const mp = profile.match;
    const len = MATCH_LENGTHS[mp.length];
    const side: Team | 'spectator' = opts.spectate ? 'spectator' : mp.side === 'auto' ? (Math.random() < 0.5 ? 'T' : 'CT') : mp.side;
    if (opts.online) {
      this.online = opts.online.client;
      if (opts.online.match.mode === 'zombies') { this.zm = new RemoteZombiesMatch(this.online, opts.online.match); this.match = this.zm; }
      else { this.zm = null; this.match = new RemoteMatch(this.online, opts.online.match); }
    } else if (opts.mode === 'zombies') {
      const zp = profile.zombies;
      this.zm = new ZombiesMatch({
        layout: ACI_HQ_ZOMBIES, difficulty: zp.difficulty, players: zp.players, length: zp.length, playerName: profile.name, playerLook: profile.looks,
        spectate: opts.spectate, seed: opts.seed, startWave: opts.startWave, startPoints: opts.startPoints,
      });
      this.match = this.zm;
    } else {
      this.zm = null;
      this.match = new Match({
        map: sndMap(opts.mapId), difficulty: mp.difficulty, playerTeam: side, playerName: profile.name, playerLook: profile.looks, seed: opts.seed,
        rules: { roundsToWin: len.roundsToWin, halfLength: len.halfLength, teamSize: mp.teamSize, freezeTime: mp.freezeTime, friendlyFire: mp.friendlyFire, killstreaks: mp.killstreaks ?? true, ...opts.rules },
      });
    }
    this.timeScale = this.online ? 1 : opts.timeScale ?? 1;
    this.ctrl = new PlayerController(input, profile.settings);
    this.ctrl.assist = makeAimAssist(this.match, () => this.profile.settings.aimAssist ?? 'off');
    const settings = () => this.profile.settings;
    this.view = new MatchView(r, this.match, profile.finishes, () => settings());
    this.hud = new HUD(this.match, settings, () => this.view.viewAgent);
    this.view.onLocalHit = (head) => this.hud.onHit(head);
    this.view.onLocalKill = (hs) => this.hud.onKill(hs);
    this.view.onLocalDamage = (id, amount, point, head, armor) => this.hud.onDamage(id, amount, point, head, armor);
    this.view.onLocalNearMiss = (close) => this.hud.onNearMiss(close);
    this.view.onLocalHurt = (yaw) => this.hud.onHurt(yaw);
    this.view.onLocalFlash = (s, d) => this.hud.onFlash(s, d);
    this.hud.view = this.view;
    this.buy = new BuyMenu(this.match, () => this.closeBuy());
    this.scoreboard = this.zm ? new ZombiesScoreboard(this.zm) : new Scoreboard(this.match);
    if (this.zm) {
      const zm = this.zm;
      this.zview = new ZombiesView(r, zm, this.view, () => this.view.viewAgent);
      this.zhud = new ZombiesHUD(zm, settings, () => this.view.viewAgent);
      this.armory = new ArmoryMenu(zm, () => this.closeArmory());
      zm.events.on('zArmory', (e) => { if (e.agentId === zm.player?.id) this.openArmory(); });
      zm.events.on('zWave', (e) => {
        if (e.state !== 'start') return;
        const tip = this.zombieTip(e.wave);
        if (tip && zm.player) setTimeout(() => { if (!this.ended) this.hud.showTip(tip, 11); }, 3600);
      });
    }
    this.pause = new PauseMenu(() => this.resume(), () => this.openSettings(), () => this.quit(), !!this.online, !!opts.online?.match.ranked);
    const panel = new SettingsPanel(settings, (s) => { this.applySettings(s); this.ctrl.setSettings(s); }, input);
    this.settingsOverlay = h('div', { class: 'overlay-dim hidden' },
      h('div', { class: 'panel', style: 'padding:22px;max-height:90vh;overflow:auto' }, panel.el,
        h('button', { class: 'btn primary', style: 'margin-top:14px', onclick: () => { this.settingsOverlay.classList.add('hidden'); this.pause.show(true); } }, 'Back')));
    this.clickToPlay = h('div', { class: 'click-to-play', onclick: () => this.lock() }, 'CLICK TO PLAY');
    this.root = h('div', { style: 'position:absolute;inset:0' },
      this.hud.el, this.zhud?.el ?? null, this.scoreboard.el, this.buy.el, this.armory?.el ?? null, this.pause.el, this.settingsOverlay, this.clickToPlay);
    uiRoot.append(this.root);
    this.xpStatus = h('div', { class: 'xp-status' }); this.root.append(this.xpStatus);
    const showAwards = (awards: Award[]) => {
      const xp = awards.reduce((n, a) => n + a.xp, 0);
      if (xp) { this.earnedXp += xp; this.xpMessage = `+${xp} XP · ${awards.at(-1)!.label}`; this.xpUntil = performance.now() + 3500; }
    };
    if (!this.online && this.match.player && this.timeScale === 1) this.rewards = new MatchRewards(this.match, this.match.player.id, profile.career, localMatchId(), Date.now, .5,
      awards => { showAwards(awards); this.saveProfile(); });
    if (this.online) {
      const client = this.online;
      client.onCareer = (career, awards, rankDelta) => {
        profile.onlineCareer = career; this.saveProfile(); showAwards(awards);
        if (rankDelta !== undefined) { this.rankDelta = rankDelta; this.hud.showCenter(`${rankLabel(career.rank)} · ${rankDelta >= 0 ? '+' : ''}${rankDelta} RP`, 6); }
        this.refreshCareerResult();
      };
      this.netStatus = h('div', { class: 'net-status' });
      this.root.append(this.netStatus);
      client.onError = message => this.hud.showCenter(message, 4);
      client.onClose = () => {
        this.connectionLost = true;
        this.expectUnlock = true; this.input.exitLock(); this.input.gameFocus = false;
        this.root.append(h('div', { class: 'overlay-dim', style: 'z-index:90' }, h('div', { class: 'panel online-disconnected' },
          h('h2', null, 'Connection lost'), h('p', null, 'Your slot is now controlled by a bot. Return to the menu to join another match.'),
          h('button', { class: 'btn primary', onclick: () => this.quit() }, 'Return to menu'))));
      };
    }

    if (this.match.player) this.ctrl.syncFrom(this.match.player);
    this.match.events.on('roundStart', () => { if (this.match.player) this.ctrl.syncFrom(this.match.player); this.spectateIdx = 0; });
    this.match.events.on('matchEnd', () => this.onMatchEnd());
    this.match.events.on('zRespawn', e => { if (e.agentId === this.match.player?.id) this.ctrl.syncFrom(this.match.player!); });
    this.match.events.on('roundEnd', (e) => {
      // CoD S&D: the round-winning elimination is replayed from the killer's eyes
      this.killcamAt = !this.online && e.reason === 'elimination' && (this.profile.settings.killcam ?? true) && this.timeScale <= 1 ? performance.now() + 1300 : 0;
    });
    this.match.events.on('roundStart', (e) => {
      this.killcamAt = 0; this.view.stopKillcam();
      const tip = this.tipFor(e.round);
      if (tip && this.match.player) setTimeout(() => this.hud.showTip(tip), 600);
    });
    this.match.events.on('operate', (e) => {
      const me = this.match.player;
      if (!me || e.agentId !== me.id) return;
      const d = this.match.gadgets.get(e.deviceId);
      if (d) { this.ctrl.yaw = d.yaw; this.ctrl.pitch = d.pitch; } else this.ctrl.syncFrom(me);
    });
    this.input.gameFocus = true;
    this.input.onLockChange = (locked) => {
      if (locked) { this.clickToPlay.classList.add('hidden'); return; }
      if (this.expectUnlock || this.ended) { this.expectUnlock = false; return; }
      if (!this.paused) this.setPaused(true);
    };
    if (opts.spectate) this.clickToPlay.classList.add('hidden');
    // round 1 started inside the Match constructor, before we were listening
    const firstTip = this.zm ? this.zombieTip(0) : this.tipFor(this.match.round);
    if (firstTip && this.match.player) setTimeout(() => { if (!this.ended) this.hud.showTip(firstTip, 12); }, 900);
    this.pickView();
  }

  /** Rotating gameplay tips for the first rounds of a match. */
  private tipFor(round: number): string | null {
    const k = (a: keyof Settings['bindings']) => `<kbd>${keyLabel(this.profile.settings.bindings[a])}</kbd>`;
    const toggle = this.profile.settings.crouchMode === 'toggle';
    const tips = [
      `${k('buy')} buys gear. ${k('buy')} then <kbd>R</kbd> rebuys last round, <kbd>A</kbd> auto-buys, <kbd>4</kbd> opens the Gunsmith.`,
      toggle ? `Tap ${k('crouch')} to crouch, hold it to go prone. ${k('slide')} slides while running.` : `Hold ${k('crouch')} while standing still to go prone. ${k('slide')} slides while running forward.`,
      `${k('ping')} pings an enemy or a spot for your team. ${k('leanLeft')} ${k('leanRight')} lean around corners.`,
      `Kills in one life earn killstreaks – press ${k('killstreak')}. Hold ${k('jump')} into a ledge to mantle.`,
      `Unsuppressed shots show you on the enemy radar. Suppressors keep you hidden.`,
      `${k('quickMelee')} quick-melees, ${k('inspect')} inspects your gun, ${k('light')} toggles a weapon light.`,
    ];
    return round <= tips.length ? tips[round - 1] : null;
  }

  /** Zombies tips for the first waves. */
  private zombieTip(wave: number): string | null {
    const k = (a: keyof Settings['bindings']) => `<kbd>${keyLabel(this.profile.settings.bindings[a])}</kbd>`;
    const tips = [
      `Hold the lobby! Knife and pistol work on the first waves. ${k('use')} at a <b>wall weapon</b> buys it; ${k('use')} at a <b>shutter</b> opens the next area.`,
      `Points: 10 per hit, 60 per kill, 100 per headshot, 130 per knife kill — and a bonus for every wave you clear.`,
      `Turn on the <b>power</b> in the Server Room to switch on perk machines and the Prototype Forge (weapon upgrades).`,
      `The <b>Mystery Box</b> (blue light beam) gives a random gun — maybe the Disruptor. ${k('use')} at the Armory for armor, frags and traps.`,
      `Downed teammates can be saved: hold ${k('use')} next to them. Get <b>Second Wind</b> to revive faster (solo: get back up yourself).`,
      `Kills can drop power-ups: Max Ammo, Insta-Kill, Double Points, Nuke, Carpenter, Fire Sale and Bonus Points.`,
    ];
    return wave < tips.length ? tips[wave] : null;
  }

  private openArmory() {
    if (!this.armory || this.armory.visible) return;
    this.clickToPlay.classList.add('hidden');
    this.expectUnlock = true;
    this.input.exitLock();
    this.input.gameFocus = false;
    this.armory.show();
  }
  private closeArmory() {
    if (!this.armory) return;
    this.armory.hide();
    this.holdUseUntilRelease = true;
    this.input.gameFocus = true;
    if (!this.paused) this.lock();
  }

  private lock() { sfx.resume(); this.input.requestLock(); }

  private setPaused(p: boolean) {
    this.paused = p;
    this.pause.show(p);
    if (p) { this.buy.hide(); this.armory?.hide(); this.clickToPlay.classList.add('hidden'); this.input.gameFocus = false; }
  }
  private resume() { this.setPaused(false); this.input.gameFocus = true; this.lock(); }
  private openSettings() { this.pause.show(false); this.settingsOverlay.classList.remove('hidden'); }
  private quit() { this.ended = true; this.input.exitLock(); this.onExit(); }

  private openBuy() {
    const p = this.match.player;
    if (!p || !this.match.canBuyNow(p)) { this.hud.showCenter('You can only buy in your spawn during buy time', 1.5); return; }
    this.clickToPlay.classList.add('hidden');
    this.expectUnlock = true;
    this.input.exitLock();
    this.input.gameFocus = false;
    this.buy.show();
  }
  private closeBuy() {
    this.buy.hide();
    this.input.gameFocus = true;
    if (!this.paused) this.lock();
  }

  private onMatchEnd() {
    this.rewards?.finish(this.match.time >= 90);
    this.ended = true;
    this.input.exitLock();
    this.input.gameFocus = false;
    if (this.zm) { this.onZombiesEnd(this.zm); return; }
    const me = this.match.player;
    // Profile stats are the offline record; online results live in the server-owned career.
    if (me && !this.online) {
      const st = this.profile.stats;
      st.matches++; st.kills += me.stats.kills; st.deaths += me.stats.deaths; st.mvps += me.stats.mvps;
      if (this.match.winner === me.team) st.wins++;
      this.saveProfile();
    }
    const scr = new MatchEndScreen(this.match, () => { scr.el.remove(); this.onExit(); });
    this.attachCareerResult(scr.el);
    this.root.append(scr.el);
  }

  private onZombiesEnd(zm: ZombiesMatch) {
    this.armory?.hide();
    const zs = this.profile.zstats, me = zm.player, diff = zm.zc.difficulty;
    const prev = zs.best[diff] ?? 0;
    const newBest = !!me && !this.online && zm.wave > prev;
    if (me && !this.online) {
      const st = me.zp!.stats;
      zs.games++; zs.kills += st.kills; zs.headshots += st.headshots; zs.downs += st.downs; zs.revives += st.revives;
      if (zm.won) zs.exfils++;
      if (newBest) zs.best[diff] = zm.wave;
      this.saveProfile();
    }
    setTimeout(() => {
      if (!this.root.isConnected) return;
      const scr = new ZombiesEndScreen(zm, Math.max(prev, zm.wave), newBest, () => { scr.el.remove(); if (this.online) this.onExit(); else this.onRestart(); }, () => { scr.el.remove(); this.onExit(); }, !!this.online);
      this.attachCareerResult(scr.el);
      this.root.append(scr.el);
    }, zm.won ? 2200 : 1500);
  }

  private attachCareerResult(el: HTMLElement) {
    this.resultCareer = h('p', { class: 'career-result', style: 'color:#ffce7b;text-align:center' });
    (el.querySelector('.panel') ?? el).append(this.resultCareer); this.refreshCareerResult();
  }
  private refreshCareerResult() {
    if (!this.resultCareer) return;
    const c = this.online ? this.profile.onlineCareer : this.profile.career;
    this.resultCareer.textContent = c ? `+${this.earnedXp} XP · ${this.online ? 'Online' : 'Offline'} Level ${levelAt(c.xp).level}${this.online ? ` · ${rankLabel(c.rank)}` : ''}${this.rankDelta !== null ? ` · ${this.rankDelta >= 0 ? '+' : ''}${this.rankDelta} RP` : ''}` : 'Loading career result…';
  }

  /** Choose whose eyes we see through. */
  private pickView() {
    const m = this.match, me = m.player;
    if (me && me.alive) { this.view.viewAgent = me; this.view.freeCam = null; return; }
    if (me && !me.alive && m.time - me.deathTime < 3.2 && m.phase !== 'freeze') { this.view.viewAgent = me; this.view.freeCam = null; return; }
    const pool: Agent[] = m.agents.filter((a) => a.alive && (!me || a.team === me.team));
    const all = pool.length ? pool : m.agents.filter((a) => a.alive);
    if (!all.length) { return; }
    const target = all[this.spectateIdx % all.length];
    if (this.view.viewAgent !== target) {
      this.view.viewAgent = target;
      this.view.beforeStep(); this.view.afterStep();
    }
    this.view.freeCam = null;
  }

  update(frameDt: number) {
    if (this.match instanceof RemoteMatch || this.match instanceof RemoteZombiesMatch) {
      this.view.beforeStep(); this.match.receiveSnapshot(); this.view.afterStep();
      if (this.netStatus) {
        const client = this.online!;
        const stale = performance.now() - client.lastSnapshotAt > 1500;
        setText(this.netStatus, this.connectionLost ? 'Disconnected' : stale ? 'Waiting for server…' : `ONLINE · ${client.pingMs} ms`);
        this.netStatus.classList.toggle('stale', stale || this.connectionLost);
      }
    }
    const input = this.input, m = this.match, me = m.player;
    const career = this.online ? this.profile.onlineCareer : this.profile.career;
    setText(this.xpStatus, career ? `LV ${levelAt(career.xp).level} · ${this.online ? 'Online' : 'Offline'} XP${this.earnedXp ? ` · +${this.earnedXp} this match` : ''}${performance.now() < this.xpUntil ? ` · ${this.xpMessage}` : ''}` : '');
    const s = this.profile.settings;

    // ---- menu keys --------------------------------------------------------------
    if (!this.ended) {
      if (this.buy.visible) {
        if (input.wasPressed(s.bindings.buy) || input.wasPressed('Escape')) this.closeBuy();
        for (const k of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR', 'KeyA']) if (input.wasPressed(k)) this.buy.key(k);
        this.buy.refresh();
        if (me && !m.canBuyNow(me)) this.closeBuy();
      } else if (this.armory?.visible) {
        if (input.wasPressed(s.bindings.use) || input.wasPressed(s.bindings.buy) || input.wasPressed('Escape')) this.closeArmory();
        for (const k of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal']) if (input.wasPressed(k)) this.armory.key(k);
        this.armory.refresh();
        if (!me || !me.alive || me.zp?.downed) this.closeArmory();
      } else if (!this.paused) {
        if (!this.zm && input.actionPressed('buy')) this.openBuy();
        else if (this.zm && input.actionPressed('buy')) this.hud.showCenter(`Weapons: ${keyLabel(s.bindings.use)} at wall weapons or the Mystery Box · Gear: the Armory`, 2.2);
      }
      this.scoreboard.show(input.isDown(s.bindings.scoreboard) && !this.paused);
      if ((!me || !me.alive) && input.wasPressed('Mouse0')) { this.spectateIdx++; }
    }

    // ---- final killcam ----------------------------------------------------------------
    if (this.killcamAt && performance.now() >= this.killcamAt && !this.paused && !this.ended) {
      this.killcamAt = 0;
      if (this.view.startKillcam(m.matchOver)) sfx.killcamWhoosh();
    }
    const kc = this.view.killcam;
    if (kc && (kc.done || input.wasPressed('Space') || input.wasPressed(s.bindings.use))) {
      this.view.stopKillcam();
      m.hurryRoundEnd(1.2);
    }

    // ---- simulation ---------------------------------------------------------------
    this.ctrl.sensMul = me && me.alive ? 1 - 0.55 * me.stunAt(m.time) : 1;
    this.ctrl.frame(me, this.view.zoomFactor(), Math.min(0.05, frameDt));
    if (this.ctrl.inspectPressed) {
      this.ctrl.inspectPressed = false;
      if (me && me.alive && me.operating === null && !this.view.killcam) this.r.viewModel.onInspect();
    }
    const look = { yaw: this.ctrl.yaw, pitch: this.ctrl.pitch };
    if ((!this.paused && !this.view.killcam) || this.online) {
      this.acc += Math.min(0.25, frameDt) * this.timeScale;
      let steps = 0;
      const maxSteps = Math.max(8, Math.ceil(this.timeScale * 6));
      while (this.acc >= DT && steps < maxSteps) {
        this.pickView();
        this.view.beforeStep();
        let command = this.ctrl.command(me);
        // The Use key that closed the Armory is often still held; it must not reopen it (offline or on the server).
        if (this.holdUseUntilRelease) { if (command.use) command = { ...command, use: false }; else this.holdUseUntilRelease = false; }
        m.setPlayerCommand(this.online && (this.paused || this.ended || this.connectionLost || !this.input.locked || !this.input.gameFocus)
          ? { ...emptyCommand(), yaw: this.ctrl.yaw, pitch: this.ctrl.pitch } : command);
        m.step(DT);
        this.view.afterStep();
        this.acc -= DT;
        steps++;
      }
      if (steps === maxSteps) this.acc = 0;
    }
    if (!me) { this.freeYaw += frameDt * 0.1; }
    const feed = me ? m.gadgets.get(me.operating) : null;
    if (feed) { this.ctrl.yaw = feed.yaw; this.ctrl.pitch = feed.pitch; } // cameras clamp their look
    const viewing = this.view.viewAgent;
    if (viewing && viewing !== me) { look.yaw = viewing.yaw; look.pitch = viewing.pitch; }
    this.view.frame(frameDt, this.paused && !this.online ? 1 : this.acc / DT, look, { dx: this.ctrl.lastDX, dy: this.ctrl.lastDY });
    this.zview?.frame(frameDt);
    this.hud.update(frameDt, this.r.camera, look.yaw, this.view.smokeDensity(), this.buy.visible || !!this.armory?.visible);
    this.zhud?.update(frameDt, this.r.camera);
    this.clickToPlay.classList.toggle('hidden', input.locked || this.paused || this.buy.visible || !!this.armory?.visible || this.ended || !me || this.connectionLost);
  }

  dispose() {
    if (this.online) {
      this.online.onClose = () => {}; this.online.onError = () => {}; this.online.onStart = () => {}; this.online.onLobby = () => {}; this.online.onCareer = () => {};
      this.online.close();
    }
    announcer.stop();
    this.rewards?.dispose();
    this.input.gameFocus = false;
    this.input.onLockChange = () => {};
    this.zview?.dispose();
    this.zhud?.dispose();
    this.view.dispose();
    this.hud.dispose();
    this.root.remove();
    this.match.events.clear();
  }
}
