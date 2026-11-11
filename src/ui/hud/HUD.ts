import { Vector3, type PerspectiveCamera } from 'three';
import { TEAM_NAMES, type Team } from '../../config/rules';
import { WEAPONS, type WeaponId } from '../../config/weapons';
import { UTILITIES, UTILITY_ORDER, utilityName, type UtilityId } from '../../config/utilities';
import { keyLabel } from '../../config/controls';
import { GADGETS, GADGET_ORDER, type GadgetId } from '../../config/gadgets';
import { clamp, formatTime } from '../../core/math';
import type { Match } from '../../sim/mode/Match';
import type { Agent } from '../../sim/entities/Agent';
import { STREAKS, STREAK_ORDER, type StreakId } from '../../sim/mode/Killstreaks';
import type { Settings } from '../../app/Profile';
import { h, money, setText } from '../dom';
import { Sights } from './Sights';
import { Radar } from './Radar';
import { weaponIcon } from './WeaponIcons';
import { announcer } from '../../audio/Announcer';
import { sfx } from '../../audio/Sfx';
import type { MatchView } from '../../render/MatchView';
import { paperDollSize } from '../../render/PaperDoll';
import { UTILITY_TUNING } from '../../config/utilities';
import { inRect, rectCenter } from '../../core/math';

const REASON_TEXT = { elimination: 'All enemies eliminated', bomb: 'The bomb exploded', defuse: 'The bomb was defused', time: 'Time ran out' } as const;

/**
 * Live grenades the HUD warns about, and from how far (m). Blinding ones affect your own team, so
 * they are flagged even when a teammate threw them.
 */
const NADE_WARN: Partial<Record<UtilityId, { r: number; blind: boolean }>> = {
  frag: { r: UTILITY_TUNING.fragRadius + 0.5, blind: false },
  fire: { r: UTILITY_TUNING.fireRadius + 2, blind: false },
  flash: { r: 12, blind: true },
  stun: { r: UTILITY_TUNING.stunRadius + 1, blind: true },
};
/** Radius (CSS px) of the ring around the crosshair the grenade warnings sit on. */
const NADE_RING = 118;

function weaponLabel(src: string): string {
  if (src in WEAPONS) return WEAPONS[src as WeaponId].name;
  if (src in UTILITIES) return UTILITIES[src as UtilityId].name;
  if (src in GADGETS) return GADGETS[src as GadgetId].name;
  return ({ bomb: 'Bomb', fall: 'Fall', fire: 'Firebomb', frag: 'Frag Grenade', hunter: 'Hunter Drone', missile: 'Cruise Missile', stim: 'Stim Pistol', tknife: 'Throwing Knife' } as Record<string, string>)[src] ?? src;
}

/** Heads-up display (DOM). Reads match state every frame; listens to events for feed/banners. */
export class HUD {
  readonly el: HTMLDivElement;
  private hp: HTMLElement; private hpBox: HTMLElement; private ar: HTMLElement; private helm: HTMLElement;
  private moneyEl: HTMLElement; private moneyDelta: HTMLElement; private buyzone: HTMLElement; private location: HTMLElement;
  private ammoBox: HTMLElement; private mag: HTMLElement; private res: HTMLElement; private wname: HTMLElement;
  private slots: HTMLElement;
  private scoreT: HTMLElement; private scoreCT: HTMLElement; private timer: HTMLElement; private aliveT: HTMLElement; private aliveCT: HTMLElement;
  private roundInfo: HTMLElement; private freezeNote: HTMLElement;
  private feed: HTMLElement;
  private center: HTMLElement; private banner: HTMLElement;
  private progress: HTMLElement; private progLabel: HTMLElement; private progBar: HTMLElement;
  private hint: HTMLElement;
  private stance: HTMLElement;
  private hitmarker: HTMLElement; private dmgInd: HTMLElement;
  private flashOv: HTMLElement; private smokeOv: HTMLElement; private hurtOv: HTMLElement;
  private spectate: HTMLElement; private fps: HTMLElement;
  private killMark!: HTMLElement; private deathPanel!: HTMLElement; private deathUntil = 0;
  private sights = new Sights();
  private names: HTMLElement;
  private camOv: HTMLElement; private camTop: HTMLElement; private camList: HTMLElement; private camHint: HTMLElement;
  private radarJam: HTMLElement;
  private streakEl: HTMLElement;
  private objLayer: HTMLElement;
  private tip: HTMLElement; private tipUntil = 0;
  private kcEl: HTMLElement; private kcTitle: HTMLElement; private kcLine: HTMLElement; private kcBar: HTMLElement; private kcFlash: HTMLElement;
  private hbPanel: HTMLCanvasElement;
  private pingLayer: HTMLElement;
  private stunOv: HTMLElement; private lowHpOv: HTMLElement;
  private lightOv: HTMLElement; private glareOv: HTMLElement;
  /** Floating damage numbers: one per victim, totting up while you keep hitting them. */
  private dmgLayer: HTMLElement;
  private dmgNums: { victimId: number; total: number; head: boolean; pos: Vector3; born: number; el: HTMLElement; num: HTMLElement; side: number }[] = [];
  private dmgTmp = new Vector3();
  /** Live grenade warnings on a ring around the crosshair. */
  private nadeLayer: HTMLElement; private nadeEls: HTMLElement[] = [];
  private nadeTmp = new Vector3(); private nadeEye = new Vector3();
  /** RELOAD / LOW AMMO / NO AMMO under the crosshair. */
  private ammoPrompt: HTMLElement;
  /** Edge darkening when rounds crack past your head. */
  private suppressOv: HTMLElement; private suppressT = 0;
  private moment: HTMLElement; private momentUntil = 0;
  private clutchRound = -1; private lowHpBeat = 0;
  /** Set by the session so the HUD can show the killcam, pings and the heartbeat screen. */
  view: MatchView | null = null;
  private missileOv: HTMLElement; private missileInfo: HTMLElement;
  private lastFeed: number | null = null;
  private radar: Radar;
  private hitT = 0; private dmgT = 0; private hurtT = 0;
  private flashUntil = 0; private flashDur = 1; private flashStr = 0;
  private centerUntil = 0; private bannerUntil = 0;
  private moneyDeltaUntil = 0;
  private fpsAcc = 0; private fpsFrames = 0;
  private dollW = -1;
  private unsub: (() => void)[] = [];
  /** Zombies mode: the S&D widgets (score, timer, money, kill feed, bomb markers) are hidden. */
  readonly zombies: boolean;

  constructor(private match: Match, private getSettings: () => Settings, private viewer: () => Agent | null) {
    this.zombies = 'zombiePool' in match;
    const stat = (ico: string) => { const num = h('span', { class: 'num' }, '100'); return { box: h('div', { class: 'hud-stat' }, h('span', { class: 'ico' }, ico), num), num }; };
    const hp = stat('✚'), ar = stat('⛊');
    this.hp = hp.num; this.hpBox = hp.box; this.ar = ar.num;
    this.helm = h('span', { class: 'ico', style: 'font-size:16px' }, '');
    ar.box.append(this.helm);
    this.moneyEl = h('span', null, '$800'); this.moneyDelta = h('span', { class: 'delta' });
    this.mag = h('span', { class: 'mag' }); this.res = h('span', { class: 'res' }); this.wname = h('span', { class: 'wname' });
    this.ammoBox = h('div', { class: 'hud-ammo' }, this.wname, this.mag, this.res);
    this.scoreT = h('div', { class: 'hud-score t' }); this.scoreCT = h('div', { class: 'hud-score ct' });
    this.timer = h('div', { class: 'hud-timer' });
    this.aliveT = h('div', { class: 'hud-alive' }); this.aliveCT = h('div', { class: 'hud-alive' });
    this.progLabel = h('div'); this.progBar = h('i', { style: 'width:0%' });
    this.radar = new Radar(match);
    this.el = h('div', { class: 'hud' },
      this.flashOv = h('div', { class: 'flash-overlay' }),
      this.smokeOv = h('div', { class: 'smoke-overlay' }),
      this.hurtOv = h('div', { class: 'hurt-overlay' }),
      this.suppressOv = h('div', { class: 'suppress-overlay' }),
      this.sights.el,
      this.names = h('div'),
      this.dmgLayer = h('div', { class: 'dmg-layer' }),
      this.radar.el,
      this.location = h('div', { class: 'location' }),
      h('div', { class: 'hud-money' }, this.moneyEl, this.moneyDelta),
      this.buyzone = h('div', { class: 'hud-buyzone' }),
      h('div', { class: 'hud-bottom-left' }, hp.box, ar.box),
      this.stance = h('div', { class: 'hud-stance hidden' }),
      this.ammoBox,
      this.slots = h('div', { class: 'hud-slots' }),
      h('div', { class: 'hud-top' }, this.aliveT, this.scoreT, this.timer, this.scoreCT, this.aliveCT),
      this.roundInfo = h('div', { class: 'hud-round' }),
      this.freezeNote = h('div', { class: 'freeze-note' }),
      this.feed = h('div', { class: 'killfeed' }),
      this.center = h('div', { class: 'center-msg' }),
      this.banner = h('div', { class: 'round-banner hidden' }),
      this.progress = h('div', { class: 'progress hidden' }, this.progLabel, h('div', { class: 'bar' }, this.progBar)),
      this.hint = h('div', { class: 'hint hidden' }),
      this.ammoPrompt = h('div', { class: 'ammo-prompt' }),
      this.hitmarker = h('div', { class: 'hitmarker' }),
      this.dmgInd = h('div', { class: 'dmg-ind' }, h('i')),
      this.nadeLayer = h('div', { class: 'nade-layer' }),
      this.camOv = h('div', { class: 'cam-overlay hidden' },
        h('div', { class: 'tint' }), h('div', { class: 'scan' }), h('div', { class: 'noise' }), h('div', { class: 'vig' }),
        h('div', { class: 'cam-reticle' }),
        this.camTop = h('div', { class: 'cam-top' }),
        this.camList = h('div', { class: 'cam-list' }),
        this.camHint = h('div', { class: 'cam-hint' })),
      this.radarJam = h('div', { class: 'radar-jam hidden' }, 'RADAR JAMMED'),
      this.streakEl = h('div', { class: 'hud-streaks' }),
      this.objLayer = h('div', { class: 'obj-layer' }),
      this.pingLayer = h('div', { class: 'ping-layer' }),
      this.tip = h('div', { class: 'tip hidden' }),
      this.stunOv = h('div', { class: 'stun-overlay' }),
      this.lightOv = h('div', { class: 'wlight-overlay' }),
      this.glareOv = h('div', { class: 'glare-overlay' }),

      this.lowHpOv = h('div', { class: 'lowhp-overlay' }),
      this.hbPanel = h('canvas', { class: 'hb-panel hidden', width: 300, height: 190 }) as HTMLCanvasElement,
      this.moment = h('div', { class: 'moment hidden' }),
      this.kcEl = h('div', { class: 'killcam hidden' },
        h('div', { class: 'kc-bar top' }), h('div', { class: 'kc-bar bottom' }),
        this.kcFlash = h('div', { class: 'kc-flash' }),
        this.kcTitle = h('div', { class: 'kc-title' }),
        this.kcLine = h('div', { class: 'kc-line' }),
        h('div', { class: 'kc-progress' }, this.kcBar = h('i')),
        h('div', { class: 'kc-skip' }, 'SPACE to skip')),
      this.missileOv = h('div', { class: 'missile-overlay hidden' }, h('div', { class: 'thermal' }), h('div', { class: 'm-reticle' }), this.missileInfo = h('div', { class: 'm-info' })),
      this.killMark = h('div', { class: 'kill-mark' }),
      this.deathPanel = h('div', { class: 'death-panel hidden' }),
      this.spectate = h('div', { class: 'spectate hidden' }),
      this.fps = h('div', { class: 'fps' }),
    );
    this.dmgInd.style.opacity = '0';
    this.el.classList.toggle('mode-zombies', this.zombies);
    this.wire();
  }

  private wire() {
    const ev = this.match.events;
    const me = () => this.match.player;
    this.unsub.push(ev.on('kill', (e) => {
      if (this.zombies) return;
      const k = this.match.getAgent(e.killerId), v = this.match.getAgent(e.victimId), a = this.match.getAgent(e.assisterId);
      const col = (x: Agent | null) => (x ? (x.team === 'T' ? 'var(--t)' : 'var(--ct)') : '#ccc');
      const mine = !!me() && (e.killerId === me()!.id || e.victimId === me()!.id);
      const row = h('div', { class: 'kf' + (mine ? ' mine' : '') },
        k && k !== v ? h('span', { style: { color: col(k) } }, k.name) : null,
        a ? h('span', { style: { color: col(a), fontSize: '12px' } }, `+ ${e.flashAssist ? '⚡' : ''}${a.name}`) : null,
        h('span', { class: 'w', title: weaponLabel(e.weapon), html: weaponIcon(e.weapon) }),
        e.wallbang ? h('span', { class: 'wb', title: 'Wallbang' }, '⊘') : null,
        e.headshot ? h('span', { class: 'hs' }, '◉ HS') : null,
        h('span', { style: { color: col(v) } }, v?.name ?? '?'));
      this.feed.append(row);
      if (me() && e.victimId === me()!.id) this.showDeath(e.killerId, e.weapon, e.headshot, e.wallbang);
      setTimeout(() => row.remove(), 7000);
      while (this.feed.children.length > 6) this.feed.firstElementChild?.remove();
    }));
    this.unsub.push(ev.on('message', (e) => this.showCenter(e.text, 3)));
    this.unsub.push(ev.on('bombPlanted', () => announcer.say('Bomb has been planted', true)));
    this.unsub.push(ev.on('bombDefused', () => announcer.say('Bomb has been defused', true)));
    this.unsub.push(ev.on('roundEnd', (e) => {
      const p = me();
      const clutch = !!p && p.alive && e.winner === p.team && this.clutchRound === this.match.round;
      announcer.say(clutch ? 'Clutch! ' + TEAM_NAMES[e.winner] + ' win' : TEAM_NAMES[e.winner] + ' win', true);
      if (clutch) this.showMoment('CLUTCH', 'You won it alone', 5);
    }));
    this.unsub.push(ev.on('halftime', () => announcer.say('Halftime. Switching sides.')));
    this.unsub.push(ev.on('killstreakUsed', (e) => {
      const p = me(); if (!p) return;
      const friendly = e.team === p.team;
      const line: Record<string, [string, string]> = {
        uav: ['UAV online', 'Enemy UAV spotted'], counterUav: ['Counter UAV online', 'Enemy counter UAV. Radar jammed.'],
        hunter: ['Hunter drone launched', 'Enemy hunter drone inbound'], missile: ['Cruise missile away', 'Enemy cruise missile inbound'],
      };
      const l = line[e.streak]; if (l) announcer.say(friendly ? l[0] : l[1]);
    }));
    this.unsub.push(ev.on('kill', (e) => {
      const p = me();
      if (!p || e.killerId !== p.id || e.victimId === p.id) return;
      // multi-kills within the round
      const n = p.stats.roundKills;
      const enemiesLeft = this.match.agents.filter((a) => a.alive && a.team !== p.team).length;
      const teamSize = this.match.agents.filter((a) => a.team !== p.team).length;
      if (n >= teamSize && enemiesLeft === 0 && teamSize >= 3) { this.showMoment('ACE', `${n} kills`, 5); announcer.say('Ace!', true); }
      else if (n >= 2) {
        const label = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL', 'PENTA KILL'][Math.min(5, n)];
        this.showMoment(label, '', n);
      }
    }));
    this.unsub.push(ev.on('killstreakEarned', (e) => {
      if (e.agentId !== me()?.id) return;
      this.showCenter(`${STREAKS[e.streak as StreakId].name.toUpperCase()} READY — press ${keyLabel(this.getSettings().bindings.killstreak)}`, 3);
    }));
    this.unsub.push(ev.on('killstreakUsed', (e) => {
      const p = me(); if (!p) return;
      const who = this.match.getAgent(e.agentId);
      const name = STREAKS[e.streak as StreakId].name;
      if (e.team === p.team) this.showCenter(e.agentId === p.id ? `${name} inbound` : `Friendly ${name} called in by ${who?.name ?? 'a teammate'}`, 2.5);
      else this.showCenter(e.streak === 'counterUav' ? 'Enemy Counter-UAV — radar jammed' : `Enemy ${name} incoming!`, 2.5);
    }));
    this.unsub.push(ev.on('stimHeal', (e) => {
      const p = me(); if (!p) return;
      if (e.targetId === p.id && !e.self) this.showCenter(`Stimmed by ${this.match.getAgent(e.healerId)?.name ?? 'a teammate'} (+${e.amount} HP)`, 1.6);
      else if (e.healerId === p.id && !e.self) this.showCenter(`Healed ${this.match.getAgent(e.targetId)?.name ?? 'teammate'} +${e.amount} HP`, 1.4);
    }));
    this.unsub.push(ev.on('resupply', (e) => { if (e.agentId === me()?.id) this.showCenter('Ammo resupplied', 1.4); }));
    this.unsub.push(ev.on('gadgetAlert', (e) => { if (me()?.team === e.team) this.showCenter(e.text, 2.5); }));
    this.unsub.push(ev.on('ping', (e) => { if (e.agentId === me()?.id) this.showCenter(e.revealed.length ? `Pinged ${e.revealed.length} enem${e.revealed.length > 1 ? 'ies' : 'y'}` : 'Nothing to ping', 1.2); }));
    this.unsub.push(ev.on('emp', (e) => { const p = me(); if (p && p.team !== e.team && p.pos.distanceTo(e.pos) < 9) this.showCenter('EMP — your electronics are down', 2); }));
    this.unsub.push(ev.on('bombPickup', (e) => { if (e.agentId === me()?.id) this.showCenter('You picked up the bomb', 2); }));
    this.unsub.push(ev.on('roundStart', (e) => {
      const p = me();
      const half = this.match.isPistolRound() ? ' — PISTOL ROUND' : '';
      // Spawns move every round: say where this one is.
      const area = p && this.match.world.map.spawnAreas?.[p.team]?.find((s) => p.pos.x >= s.zone.x0 && p.pos.x <= s.zone.x1 && p.pos.z >= s.zone.z0 && p.pos.z <= s.zone.z1);
      this.showCenter(p ? `Round ${e.round}${half} · You are ${TEAM_NAMES[p.team]}${area ? ` · ${area.name}` : ''}` : `Round ${e.round}${half}`, 3);
    }));
    this.unsub.push(ev.on('halftime', () => setTimeout(() => this.showCenter('HALFTIME — switching sides', 4), 2500)));
    this.unsub.push(ev.on('roundEnd', (e) => {
      const team = e.winner;
      const mvp = this.match.getAgent(e.mvpId);
      this.banner.innerHTML = '';
      this.banner.style.borderColor = team === 'T' ? 'var(--t)' : 'var(--ct)';
      this.banner.append(
        h('div', { class: 'big', style: { color: team === 'T' ? 'var(--t)' : 'var(--ct)' } }, `${TEAM_NAMES[team]} win`),
        h('div', { class: 'small' }, REASON_TEXT[e.reason]),
      );
      if (mvp) this.banner.append(h('div', { class: 'mvp' }, `★ MVP: ${mvp.name}`));
      this.banner.classList.remove('hidden');
      this.bannerUntil = performance.now() + 5000;
    }));
    this.unsub.push(ev.on('money', (e) => {
      if (e.agentId !== me()?.id) return;
      setText(this.moneyDelta, `${e.amount >= 0 ? '+' : '-'}$${Math.abs(e.amount)}`);
      this.moneyDelta.style.color = e.amount >= 0 ? 'var(--good)' : 'var(--bad)';
      this.moneyDeltaUntil = performance.now() + 2500;
    }));
  }

  /** Big centre-top callout (multi-kills, clutch, ace) with a stinger. */
  showMoment(title: string, sub: string, level: number) {
    this.moment.innerHTML = '';
    this.moment.append(h('b', null, title), sub ? h('small', null, sub) : '');
    this.moment.classList.remove('hidden', 'pop'); void this.moment.offsetWidth; this.moment.classList.add('pop');
    this.momentUntil = performance.now() + 2600;
    sfx.stinger(level);
  }

  showCenter(text: string, seconds: number) { setText(this.center, text); this.centerUntil = performance.now() + seconds * 1000; }
  onHit(head: boolean) { this.hitT = 0.25; this.hitmarker.classList.toggle('head', head); }
  onKill(headshot: boolean) {
    this.killMark.classList.remove('show', 'hs');
    void this.killMark.offsetWidth; // restart the CSS animation
    this.killMark.classList.add('show');
    if (headshot) this.killMark.classList.add('hs');
  }

  /** CS-style death panel: who killed you, with what, their HP, and the round's damage report. */
  private showDeath(killerId: number, weapon: string, headshot: boolean, wallbang: boolean) {
    const m = this.match, me = m.player;
    if (!me) return;
    const k = m.getAgent(killerId);
    this.deathPanel.innerHTML = '';
    const head = k && k !== me
      ? h('div', { class: 'dp-head' }, h('span', { class: 'muted' }, 'KILLED BY '), h('b', { style: { color: k.team === 'T' ? 'var(--t)' : 'var(--ct)' } }, k.name),
        h('span', { class: 'dp-w' }, ` ${weaponLabel(weapon)}${headshot ? ' · HEADSHOT' : ''}${wallbang ? ' · WALLBANG' : ''}`),
        h('span', { class: 'dp-hp' }, `${Math.max(0, Math.ceil(k.health))} HP left`))
      : h('div', { class: 'dp-head' }, h('b', null, 'YOU DIED'), h('span', { class: 'dp-w' }, ` ${weaponLabel(weapon)}`));
    const rows = m.damageReport(me.id).map((r) => {
      const o = m.getAgent(r.otherId)!;
      return h('tr', null, h('td', { style: { color: o.team === 'T' ? 'var(--t)' : 'var(--ct)' } }, o.name),
        h('td', { class: r.given.dmg ? 'dp-good' : 'muted' }, r.given.hits ? `${r.given.dmg} in ${r.given.hits}` : '—'),
        h('td', { class: r.taken.dmg ? 'dp-bad' : 'muted' }, r.taken.hits ? `${r.taken.dmg} in ${r.taken.hits}` : '—'));
    });
    this.deathPanel.append(head, rows.length ? h('table', null, h('tr', null, h('th', null, 'DAMAGE'), h('th', null, 'GIVEN'), h('th', null, 'TAKEN')), ...rows) : '');
    this.deathPanel.classList.remove('hidden');
    this.deathUntil = performance.now() + 6000;
  }
  onHurt(relYaw: number) { this.dmgT = 1; this.hurtT = 0.6; this.dmgInd.style.transform = `rotate(${-relYaw}rad)`; }

  /**
   * You damaged someone: float the number off the wound. Hits on the same target within a moment
   * add up on one number (a burst reads as its total), gold for the head, pale blue into armor.
   */
  onDamage(victimId: number, amount: number, point: Vector3, head: boolean, armor: boolean) {
    if (!(this.getSettings().damageNumbers ?? true)) return;
    const now = performance.now();
    let d = this.dmgNums.find((x) => x.victimId === victimId && now - x.born < 900);
    if (d) { d.total += amount; d.head ||= head; d.pos.copy(point); d.born = now; }
    else {
      const num = h('b');
      const el = h('div', { class: 'dmgnum' }, num);
      this.dmgLayer.append(el);
      d = { victimId, total: amount, head, pos: point.clone(), born: now, el, num, side: Math.random() < 0.5 ? -1 : 1 };
      this.dmgNums.push(d);
      while (this.dmgNums.length > 8) this.dmgNums.shift()!.el.remove();
    }
    setText(d.num, String(Math.round(d.total)));
    d.el.classList.toggle('head', d.head);
    d.el.classList.toggle('armor', armor && !d.head);
    d.num.animate?.([{ transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { duration: 170, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  /** A round cracked past your head (0..1 = how close): the edges of the screen tighten for a moment. */
  onNearMiss(close: number) { this.suppressT = Math.min(0.8, Math.max(this.suppressT, 0.25 + 0.45 * close)); }

  private drawDamageNumbers(camera: PerspectiveCamera, nowMs: number) {
    const W = window.innerWidth, H = window.innerHeight, replay = !!this.view?.killcam;
    for (let i = this.dmgNums.length - 1; i >= 0; i--) {
      const d = this.dmgNums[i], age = (nowMs - d.born) / 1000;
      if (age > 1.15 || replay) { d.el.remove(); this.dmgNums.splice(i, 1); continue; }
      const p = this.dmgTmp.copy(d.pos).project(camera);
      if (p.z > 1) { d.el.style.opacity = '0'; continue; }
      // drift up and out to one side, so a stream of hits doesn't stack on the crosshair
      const x = (p.x * 0.5 + 0.5) * W + d.side * (16 + age * 18), y = (-p.y * 0.5 + 0.5) * H - 16 - age * 38;
      d.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      d.el.style.opacity = String(Math.min(1, (1.15 - age) / 0.4));
      const v = this.match.getAgent(d.victimId);
      d.el.classList.toggle('kill', !!v && !v.alive);
    }
  }

  /**
   * CoD-style grenade warning: a pulsing badge on a ring around the crosshair, pointing at each live
   * grenade close enough to hurt or blind you, with its distance. Your own grenade only counts once
   * it has left your hand, a teammate's frag only with friendly fire on, and anything walled off
   * from you is left out.
   */
  private drawGrenadeWarnings(a: Agent | null, yaw: number) {
    const m = this.match, list: { ang: number; dist: number; kind: UtilityId; blind: boolean }[] = [];
    if (a && a.alive && a.operating === null && !this.view?.killcam && (this.getSettings().grenadeWarnings ?? true)) {
      const center = a.centerPos(this.nadeTmp), eye = a.eyePos(this.nadeEye), col = m.world.collision;
      for (const p of m.utility.projectiles) {
        const w = NADE_WARN[p.kind];
        if (!w) continue;
        const mine = p.ownerId === a.id;
        if (mine && m.time - p.thrownAt < 0.6) continue;
        if (!mine && p.team === a.team && !w.blind && !m.rules.friendlyFire) continue;
        const dist = p.pos.distanceTo(center);
        if (dist > w.r) continue;
        if (col.segmentBlocked(p.pos, center) && col.segmentBlocked(p.pos, eye)) continue;
        list.push({ ang: Math.atan2(-(p.pos.x - a.pos.x), -(p.pos.z - a.pos.z)) - yaw, dist, kind: p.kind, blind: w.blind });
      }
    }
    while (this.nadeEls.length < list.length) {
      const el = h('div', { class: 'nade-warn' }, h('i'), h('span'));
      this.nadeLayer.append(el); this.nadeEls.push(el);
    }
    this.nadeEls.forEach((el, i) => {
      const w = list[i];
      if (!w) { el.style.display = 'none'; return; }
      el.style.display = '';
      if (el.dataset.k !== w.kind) { el.dataset.k = w.kind; (el.firstElementChild as HTMLElement).innerHTML = weaponIcon(w.kind); el.classList.toggle('blind', w.blind); }
      // CSS rotation runs clockwise: an angle to the left (positive yaw) goes counter-clockwise
      const t = -w.ang;
      el.style.transform = `translate(${(Math.sin(t) * NADE_RING).toFixed(1)}px, ${(-Math.cos(t) * NADE_RING).toFixed(1)}px)`;
      el.classList.toggle('close', w.dist < 4);
      setText(el.lastElementChild as HTMLElement, `${w.dist.toFixed(w.dist < 10 ? 1 : 0)}m`);
    });
  }
  onFlash(strength: number, duration: number) {
    this.flashUntil = performance.now() + duration * 1000; this.flashDur = duration; this.flashStr = strength;
  }

  update(dt: number, camera: PerspectiveCamera, yaw: number, smokeDensity: number, buyOpen: boolean) {
    if (this.deathUntil && (performance.now() > this.deathUntil || this.match.player?.alive)) { this.deathPanel.classList.add('hidden'); this.deathUntil = 0; }
    const m = this.match, now = m.time;
    const s = this.getSettings();
    const v = this.viewer();
    const me = m.player;
    const team: Team | null = me?.team ?? null;
    const nowMs = performance.now();

    announcer.enabled = s.announcer ?? true;
    announcer.volume = s.masterVolume * 0.9;
    // the paper doll owns the top-right corner: the kill feed moves to its left
    const doll = (s.paperDoll ?? 'off') !== 'off';
    this.el.classList.toggle('doll-on', doll);
    const dollW = doll ? paperDollSize(s.paperDollSize ?? 1).w : 0;
    if (dollW !== this.dollW) { this.dollW = dollW; this.el.style.setProperty('--doll-w', dollW + 'px'); }
    // fps
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) { setText(this.fps, s.showFps ? `${Math.round(this.fpsFrames / this.fpsAcc)} FPS` : ''); this.fpsAcc = 0; this.fpsFrames = 0; }

    // top bar
    setText(this.scoreT, String(m.score.T));
    setText(this.scoreCT, String(m.score.CT));
    const planted = m.phase === 'planted';
    this.timer.classList.toggle('bomb', planted);
    let t = '';
    if (m.phase === 'freeze') t = formatTime(m.phaseEnd - now);
    else if (m.phase === 'live') t = formatTime(m.phaseEnd - now);
    else if (planted) t = '💣';
    else t = formatTime(0);
    setText(this.timer, t);
    this.renderAlive(this.aliveT, 'T'); this.renderAlive(this.aliveCT, 'CT');
    setText(this.roundInfo, `ROUND ${m.round}  ·  FIRST TO ${m.rules.roundsToWin}`);
    setText(this.freezeNote, m.phase === 'freeze' ? `Round starts in ${Math.ceil(m.phaseEnd - now)} — press ${keyLabel(s.bindings.buy)} to buy` : '');

    // player stats
    const a = v;
    let stance = '';
    if (a?.alive && a.operating === null && !this.view?.killcam && !a.zp?.downed) {
      const C = keyLabel(s.bindings.crouch), toggle = s.crouchMode === 'toggle';
      if (a.sliding) stance = 'SLIDING';
      else if (a.prone) stance = !a.cmd.prone ? 'PRONE · Move clear to stand'
        : toggle ? `PRONE · Tap ${C} to crouch · ${keyLabel(s.bindings.jump)} to stand` : `PRONE · Release ${C} to rise`;
      else if (a.motor.slideCooldown > 0) stance = `${keyLabel(s.bindings.slide)} SLIDE · ${a.motor.slideCooldown.toFixed(1)}s`;
      else if (a.crouched) stance = !a.cmd.crouch ? 'CROUCH · Low ceiling'
        : toggle ? `CROUCH · Tap ${C} to stand · hold to go prone` : `CROUCH · Keep holding ${C} while still to go prone`;
    }
    setText(this.stance, stance);
    this.stance.classList.toggle('hidden', !stance);
    if (a) {
      setText(this.hp, String(Math.max(0, Math.ceil(a.health))));
      this.hpBox.classList.toggle('low', a.health <= 25 || !!a.zp?.downed);
      this.hpBox.classList.toggle('healing', a.alive && a.heals.length > 0 && a.health < a.maxHealth);
      setText(this.ar, String(Math.ceil(a.armor)));
      setText(this.helm, a.helmet ? '⛑' : '');
      setText(this.moneyEl, money(a.money));
      const w = a.activeWeapon();
      if (w && w.def.class !== 'knife') {
        setText(this.mag, String(w.mag)); setText(this.res, '/ ' + w.reserve); setText(this.wname, w.def.name);
        this.ammoBox.classList.toggle('low', w.mag <= Math.ceil(w.def.mag * 0.2));
      } else {
        setText(this.mag, a.active === 'grenade' && a.activeGrenade ? String(a.grenades[a.activeGrenade]) : '');
        setText(this.res, '');
        setText(this.wname, a.active === 'grenade' && a.activeGrenade ? utilityName(a.activeGrenade, a.team) : a.active === 'bomb' ? 'Bomb' : w?.def.name ?? '');
      }
      this.renderSlots(a);
      const area = (m as unknown as { areaName?: (x: number, z: number) => string }).areaName;
      setText(this.location, (area ? area.call(m, a.pos.x, a.pos.z) : m.world.calloutAt(a.pos.x, a.pos.z)).toUpperCase());
      const canBuy = me === a && m.canBuyNow(a);
      setText(this.buyzone, canBuy ? `BUY ZONE · ${Math.ceil(m.buyTimeLeft())}s` : '');
    }
    if (nowMs > this.moneyDeltaUntil) setText(this.moneyDelta, '');

    // hints & progress
    let hint = '';
    let prog: { label: string; p: number } | null = null;
    if (me && me.alive) {
      const eye = me.eyePos(new Vector3()), look = me.viewDir(new Vector3());
      const bar = me.operating === null ? m.gadgets.barricadeAt(eye, look) : null;
      if (me.pryProgress > 0 && bar) prog = { label: bar.kind === 'steelBarricade' ? 'PRYING STEEL' : 'PRYING', p: me.pryProgress };
      else if (me.isPlanting) prog = { label: `PLANTING · ${((1 - me.plantProgress) * m.rules.plantTime).toFixed(1)}s`, p: me.plantProgress };
      else if (me.isDefusing) prog = { label: `DEFUSING${me.hasKit ? ' (KIT)' : ''} · ${((1 - me.defuseProgress) * (me.hasKit ? m.rules.defuseTimeKit : m.rules.defuseTime)).toFixed(1)}s`, p: me.defuseProgress };
      else if (me.team === 'CT' && m.bomb.state === 'planted' && me.pos.distanceTo(m.bomb.pos) < 1.8) hint = `Hold ${keyLabel(s.bindings.use)} to defuse`;
      else if (me.hasBomb && m.world.siteAt(me.pos.x, me.pos.z) && m.phase === 'live') hint = me.active === 'bomb' ? 'Hold LEFT MOUSE to plant the bomb' : `Press ${keyLabel(s.bindings.bomb)} to equip the bomb`;
      else if (me.active === 'gadget' && me.activeGadget === 'heartbeat') hint = 'Heartbeat sensor: enemies within 24 m in front of you show on the screen. Nearby enemies can hear it beep.';
      else if (me.active === 'gadget' && me.activeGadget === 'stim') hint = `LEFT MOUSE to shoot a teammate (+60 HP) · ${keyLabel(s.bindings.stimSelf)} to stim yourself · ${me.gadgets.stim} left`;
      else if (me.active === 'gadget' && me.activeGadget) {
        const g = GADGETS[me.activeGadget];
        const fort = me.activeGadget === 'barricade' || me.activeGadget === 'steelBarricade' ? me.activeGadget : null;
        const spot = fort ? m.gadgets.barricadeTarget(me, fort, eye, look) : null;
        const verb = fort ? 'board up the doorway with' : g.deploy === 'throw' ? 'throw' : 'place';
        hint = fort && !spot ? `Look at a doorway within reach to place the ${g.name}`
          : fort && spot?.blocked ? 'That doorway is blocked'
            : `LEFT MOUSE to ${verb} ${g.name}` + (me.totalGadgets() > 1 ? ` · ${keyLabel(s.bindings.gadget)} to switch` : '');
      }
      else if (bar && bar.team !== me.team) hint = me.hasCrowbar ? `Hold ${keyLabel(s.bindings.use)} to pry off the ${bar.kind === 'steelBarricade' ? 'steel barricade' : 'barricade'}`
        : bar.kind === 'steelBarricade' ? 'Steel barricade — needs a crowbar or explosives' : `Melee (${keyLabel(s.bindings.quickMelee)}) or shoot to break the barricade`;
      else if (bar && me.hasCrowbar) hint = `Hold ${keyLabel(s.bindings.use)} to remove your team's barricade`;
      else if (!this.zombies && m.gadgets.ammoBoxNear(me)) hint = `Press ${keyLabel(s.bindings.use)} to resupply ammo`;
      else if (!this.zombies && m.items.some((i) => i.pos.distanceTo(me.pos) < 1.8)) hint = `Look at a weapon and press ${keyLabel(s.bindings.use)} to pick it up`;
    }
    this.progress.classList.toggle('hidden', !prog);
    if (prog) { setText(this.progLabel, prog.label); this.progBar.style.width = `${Math.round(clamp(prog.p, 0, 1) * 100)}%`; }
    if (me?.operating !== null && me?.operating !== undefined) hint = '';
    this.hint.classList.toggle('hidden', !hint);
    setText(this.hint, hint);

    // transient
    this.center.style.opacity = nowMs < this.centerUntil ? '1' : '0';
    if (nowMs > this.bannerUntil) this.banner.classList.add('hidden');
    this.hitT = Math.max(0, this.hitT - dt);
    this.hitmarker.style.opacity = String(this.hitT * 4);
    this.dmgT = Math.max(0, this.dmgT - dt * 1.2);
    this.dmgInd.style.opacity = String(this.dmgT);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.hurtOv.style.opacity = String(Math.min(0.6, this.hurtT) + (a && a.alive && a.health < 30 ? 0.25 : 0));
    const fl = nowMs < this.flashUntil ? (this.flashUntil - nowMs) / 1000 : 0;
    const flashA = fl > 0 ? Math.min(1, this.flashStr * Math.min(1, (fl / Math.max(0.3, this.flashDur)) * 2.2)) : 0;
    this.flashOv.style.opacity = String(flashA);
    this.smokeOv.style.opacity = String(Math.min(0.97, smokeDensity * 1.1));

    // crosshair, optics and scopes: all on the screen point the next shot goes to
    const w = a?.activeWeapon();
    const sighted = !!a && a.alive && a.operating === null && !this.view?.killcam;
    const aim = this.view?.aimNdc;
    this.sights.update({
      agent: sighted ? a : null, camera, aimX: aim?.x ?? 0, aimY: aim?.y ?? 0, ads: this.view?.adsBlend ?? (a?.wpn.ads ? 1 : 0),
      crosshair: s.crosshair, menu: buyOpen,
    });
    this.hitmarker.style.transform = `translate(${this.sights.offset.x}px, ${this.sights.offset.y}px) translate(-50%, -50%) rotate(45deg)`;
    // reload prompt under the crosshair (your own gun only, not while it is already reloading)
    let ammo = '', ammoCls = '';
    if (sighted && a === me && !buyOpen && w && w.def.class !== 'knife' && !(a.wpn.reloadUntil > now) && !a.zp?.downed) {
      if (w.mag === 0) { ammo = w.reserve > 0 ? `RELOAD · ${keyLabel(s.bindings.reload)}` : 'NO AMMO'; ammoCls = w.reserve > 0 ? 'empty' : 'out'; }
      else if (w.def.mag >= 5 && w.mag <= Math.max(1, Math.floor(w.def.mag * 0.2)) && w.reserve > 0) { ammo = 'LOW AMMO'; ammoCls = 'low'; }
    }
    if (this.ammoPrompt.dataset.k !== ammo) { this.ammoPrompt.dataset.k = ammo; setText(this.ammoPrompt, ammo); this.ammoPrompt.className = `ammo-prompt ${ammoCls}`; }
    // rounds cracking past
    this.suppressT = Math.max(0, this.suppressT - dt * 1.8);
    this.suppressOv.style.opacity = this.suppressT > 0 ? this.suppressT.toFixed(3) : '0';
    this.drawGrenadeWarnings(a, yaw);
    // weapon light: your own beam brightens the middle of the screen; an enemy beam glares
    this.lightOv.style.opacity = a && a.alive && a.lightOn && a.operating === null && w?.def.mods?.light ? '1' : '0';
    const glare = this.view?.glare;
    this.glareOv.style.opacity = glare ? String(Math.min(0.95, glare.strength)) : '0';
    if (glare) this.glareOv.style.background = `radial-gradient(circle at ${glare.x}px ${glare.y}px, #fff 0, rgba(255,255,248,.97) 9%, rgba(255,250,235,.7) 22%, rgba(255,245,225,.3) 42%, rgba(255,245,225,.08) 70%)`;
    this.glareOv.style.filter = glare ? `blur(${Math.round(2 + glare.strength * 4)}px)` : '';

    // spectate
    const spect = !!me && !me.alive && !!v && v !== me;
    this.spectate.classList.toggle('hidden', !spect && !(!me && v));
    if (v && (spect || !me)) {
      this.spectate.innerHTML = '';
      this.spectate.append(`Spectating ${v.name}`, h('small', null, 'Click to switch player'));
    }

    // teammate name tags, and the damage you're dealing
    this.updateNames(camera, team);
    this.drawDamageNumbers(camera, nowMs);

    // camera / drone feed overlay
    const feed = a && a.alive ? m.gadgets.get(a.operating) : null;
    this.camOv.classList.toggle('hidden', !feed);
    if (feed && a) {
      const feeds = m.gadgets.feedsFor(a);
      const idx = feeds.findIndex((d) => d.id === feed.id);
      const t = new Date();
      const owner = m.getAgent(feed.ownerId);
      const label = feed.kind === 'cctv' ? feed.name : `${feed.name}${owner ? ' · ' + owner.name : ''}`;
      const key = `${feed.id}|${idx}|${feeds.length}|${t.getSeconds()}`;
      if (this.camTop.dataset.k !== key) {
        this.camTop.dataset.k = key;
        this.camTop.innerHTML = '';
        this.camTop.append(h('span', { class: 'rec' }, '● REC'), `CAM ${idx + 1}/${feeds.length}  ${label.toUpperCase()}`,
          h('small', null, `${m.world.calloutAt(feed.pos.x, feed.pos.z).toUpperCase()} · ${t.toLocaleTimeString()} · HP ${Math.max(0, Math.ceil(feed.health))}`));
        this.camList.innerHTML = '';
        for (const d of feeds.slice(0, 10)) this.camList.append(h('div', { class: d.id === feed.id ? 'on' : '' }, d.kind === 'cctv' ? d.name : GADGETS[d.kind as GadgetId]?.short ?? d.kind));
        const L = keyLabel(s.bindings.leanLeft), R = keyLabel(s.bindings.leanRight), V = keyLabel(s.bindings.cams);
        this.camHint.innerHTML = feed.kind === 'drone'
          ? `<b>WASD</b> drive · <b>${keyLabel(s.bindings.jump)}</b> hop · <b>LMB</b> ping · <b>${L}/${R}</b> switch · <b>${V}</b> exit`
          : `<b>Mouse</b> look · <b>LMB</b> ping · <b>${L}/${R}</b> switch · <b>${V}</b> exit`;
      }
      if (this.lastFeed !== feed.id) { this.camOv.classList.add('switch'); setTimeout(() => this.camOv.classList.remove('switch'), 120); }
    }
    this.lastFeed = feed?.id ?? null;

    // killstreaks
    this.renderStreaks(a, s);

    // moments
    if (nowMs > this.momentUntil) this.moment.classList.add('hidden');
    if (!this.zombies && me && me.alive && this.clutchRound !== m.round && (m.phase === 'live' || m.phase === 'planted')) {
      const mates = m.agents.filter((x) => x.alive && x.team === me.team).length;
      const foes = m.agents.filter((x) => x.alive && x.team !== me.team).length;
      if (mates === 1 && foes >= 1 && m.agents.filter((x) => x.team === me.team).length > 1) {
        this.clutchRound = m.round;
        this.showMoment(`1 v ${foes}`, 'You are the last one alive', 1);
        announcer.say(`One versus ${['', 'one', 'two', 'three', 'four', 'five'][foes] ?? foes}`);
      }
    }

    // stun + low health
    const stun = a && a.alive ? a.stunAt(now) : 0;
    this.stunOv.style.opacity = String(stun);
    const low = a && a.alive && a === me && a.health <= 25 && m.phase !== 'freeze' && !a.zp?.downed;
    this.lowHpOv.style.opacity = low ? String(0.55 + 0.25 * Math.sin(nowMs / 160)) : '0';
    if (low) { this.lowHpBeat -= dt; if (this.lowHpBeat <= 0) { this.lowHpBeat = 0.85; sfx.lowHealth(); } } else this.lowHpBeat = 0;

    // heartbeat sensor screen
    this.drawHeartbeat(a, now);

    // objective markers + tips
    this.drawObjectives(camera, a);
    if (nowMs > this.tipUntil) this.tip.classList.add('hidden');

    // team pings
    this.drawPings(camera);

    // final killcam
    this.updateKillcam();

    // cruise missile: thermal view + boost / altitude readout
    const missile = feed?.kind === 'missile' ? feed : null;
    this.missileOv.classList.toggle('hidden', !missile);
    this.el.classList.toggle('steering', !!missile);
    if (missile) {
      this.camOv.classList.add('hidden');
      setText(this.missileInfo, `ALT ${Math.max(0, Math.round(missile.pos.y))} m · ${missile.boost ? 'BOOSTING' : 'LEFT MOUSE to boost'} · mouse to steer`);
    }

    // radar (jammed by EMP)
    const jammed = !!a && a.radarScrambledUntil > now;
    this.radarJam.classList.toggle('hidden', !jammed);
    this.radar.el.style.visibility = jammed ? 'hidden' : '';
    this.radar.draw(a, team ?? a?.team ?? null, yaw, s.rotateRadar, s.radarZoom);
  }

  private updateKillcam() {
    const kc = this.view?.killcam ?? null;
    this.kcEl.classList.toggle('hidden', !kc);
    this.el.classList.toggle('killcam-on', !!kc);
    if (!kc) return;
    const i = kc.info;
    const key = `${i.killerId}>${i.victimId}`;
    if (this.kcEl.dataset.k !== key) {
      this.kcEl.dataset.k = key;
      this.kcTitle.innerHTML = '';
      this.kcTitle.append(h('span', { class: 'rec' }, '●'), i.final ? 'FINAL KILLCAM' : 'KILLCAM', h('small', null, i.final ? 'Match-winning kill' : 'Round-winning kill'));
      const col = (t: Team) => (t === 'T' ? 'var(--t)' : 'var(--ct)');
      const victim = this.match.getAgent(i.victimId);
      this.kcLine.innerHTML = '';
      this.kcLine.append(h('b', { style: { color: col(i.killerTeam) } }, i.killerName),
        h('span', { class: 'w', html: weaponIcon(i.weapon) }), h('span', { class: 'wn' }, weaponLabel(i.weapon) + (i.headshot ? ' · HEADSHOT' : '')),
        h('b', { style: { color: victim ? col(victim.team) : '#ccc' } }, i.victimName));
    }
    this.kcBar.style.width = `${Math.round(kc.progress * 100)}%`;
    this.kcFlash.style.opacity = String(this.view?.killcamFlash ?? 0);
    this.kcEl.classList.toggle('slow', kc.slowMo);
  }

  private drawHeartbeat(a: Agent | null, now: number) {
    const show = !!a && a.alive && a === this.match.player && a.active === 'gadget' && a.activeGadget === 'heartbeat' && a.operating === null && !this.view?.killcam;
    this.hbPanel.classList.toggle('hidden', !show);
    if (!show || !a) return;
    const g = this.hbPanel.getContext('2d')!;
    const W = this.hbPanel.width, H = this.hbPanel.height, cx = W / 2, cy = H - 14, R = H - 26;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(4,22,12,.92)'; g.fillRect(0, 0, W, H);
    const half = 75 * Math.PI / 180;
    g.strokeStyle = 'rgba(60,255,140,.18)'; g.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) { g.beginPath(); g.arc(cx, cy, R * f, -Math.PI / 2 - half, -Math.PI / 2 + half); g.stroke(); }
    for (const ang of [-half, 0, half]) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(ang) * R, cy - Math.cos(ang) * R); g.stroke(); }
    // sweep line
    const since = now - (a.heartbeat?.at ?? now - 10);
    const sweep = Math.min(1, since / UTILITY_TUNING.heartbeatInterval);
    const sa = -half + sweep * 2 * half;
    const grd = g.createLinearGradient(cx, cy, cx + Math.sin(sa) * R, cy - Math.cos(sa) * R);
    grd.addColorStop(0, 'rgba(80,255,150,.0)'); grd.addColorStop(1, 'rgba(80,255,150,.85)');
    g.strokeStyle = grd; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(sa) * R, cy - Math.cos(sa) * R); g.stroke();
    // blips from the last sweep, fading
    const fade = Math.max(0, 1 - since / (UTILITY_TUNING.heartbeatInterval * 1.15));
    const scale = R / UTILITY_TUNING.heartbeatRange;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw), rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
    for (const b of a.heartbeat?.blips ?? []) {
      const dx = b.x - a.pos.x, dz = b.z - a.pos.z;
      const fwd = dx * fx + dz * fz, right = dx * rx + dz * rz;
      const x = cx + right * scale, y = cy - fwd * scale;
      g.fillStyle = `rgba(255,70,60,${0.25 + 0.75 * fade})`;
      g.beginPath(); g.arc(x, y, 5 + 3 * fade, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#50ff90'; g.beginPath(); g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(120,255,170,.8)'; g.font = '11px "Segoe UI", sans-serif';
    g.fillText(`HEARTBEAT · ${UTILITY_TUNING.heartbeatRange} m`, 10, 16);
  }

  /** A short gameplay tip under the round timer (first rounds only). */
  showTip(html: string, seconds = 9) {
    if (!(this.getSettings().tips ?? true)) return;
    this.tip.innerHTML = '';
    this.tip.append(h('b', null, 'TIP'), h('span', { html }));
    this.tip.classList.remove('hidden');
    this.tipUntil = performance.now() + seconds * 1000;
  }

  private objTmp = new Vector3();
  /** Bomb-site letters, the planted bomb (with its timer) and a dropped bomb for attackers. */
  private drawObjectives(camera: PerspectiveCamera, a: Agent | null) {
    const m = this.match, s = this.getSettings();
    const marks: { x: number; y: number; z: number; label: string; cls: string }[] = [];
    if ((s.objectiveMarkers ?? true) && a && a.alive && a.operating === null && !this.view?.killcam && m.phase !== 'freeze') {
      const b = m.bomb, planted = b.state === 'planted';
      for (const site of ['A', 'B'] as const) {
        const r = m.world.map.sites[site];
        if (planted && b.site === site) continue;
        if (inRect(r, a.pos.x, a.pos.z)) continue;
        const c = rectCenter(r);
        marks.push({ x: c.x, y: 1.9, z: c.z, label: site, cls: planted ? 'site dim' : 'site' });
      }
      if (planted) {
        const left = Math.max(0, m.rules.bombTimer - (m.time - b.plantedAt));
        marks.push({ x: b.pos.x, y: b.pos.y + 0.6, z: b.pos.z, label: `${b.site ?? ''} ${Math.ceil(left)}s`, cls: 'bomb' });
      } else if (b.state === 'dropped' && a.team === 'T') {
        marks.push({ x: b.pos.x, y: b.pos.y + 0.5, z: b.pos.z, label: 'BOMB', cls: 'dropped' });
      }
    }
    while (this.objLayer.children.length < marks.length) this.objLayer.append(h('div', { class: 'objm' }, h('i'), h('span')));
    [...this.objLayer.children].forEach((el, i) => {
      const e = el as HTMLElement, mk = marks[i];
      if (!mk) { e.style.display = 'none'; return; }
      const at = this.objTmp.set(mk.x, mk.y, mk.z);
      const dist = at.distanceTo(camera.position);
      const v = at.project(camera);
      let x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const behind = v.z > 1;
      if (behind) { x = window.innerWidth - x; y = window.innerHeight * 0.82; }
      x = Math.max(28, Math.min(window.innerWidth - 28, x)); y = Math.max(70, Math.min(window.innerHeight - 70, y));
      e.style.display = '';
      e.className = 'objm ' + mk.cls + (behind ? ' behind' : '');
      e.style.transform = `translate(${x}px, ${y}px)`;
      setText(e.firstElementChild as HTMLElement, mk.cls === 'site' || mk.cls === 'site dim' ? mk.label : mk.cls === 'bomb' ? '💣' : '◆');
      setText(e.lastElementChild as HTMLElement, mk.cls === 'bomb' ? `${mk.label} · ${Math.round(dist)}m` : mk.cls === 'dropped' ? `BOMB · ${Math.round(dist)}m` : `${Math.round(dist)}m`);
    });
  }

  private pingTmp = new Vector3();
  private drawPings(camera: PerspectiveCamera) {
    const pings = this.view && !this.view.killcam ? this.view.pings : [];
    while (this.pingLayer.children.length < pings.length) this.pingLayer.append(h('div', { class: 'ping' }, h('i'), h('span')));
    [...this.pingLayer.children].forEach((el, i) => {
      const e = el as HTMLElement, p = pings[i];
      if (!p) { e.style.display = 'none'; return; }
      const enemy = p.enemyId !== null ? this.match.getAgent(p.enemyId) : null;
      const at = enemy && enemy.alive ? enemy.centerPos(this.pingTmp).setY(enemy.pos.y + enemy.height + 0.35) : this.pingTmp.copy(p.pos);
      const dist = at.distanceTo(camera.position);
      const v = at.clone().project(camera);
      const behind = v.z > 1;
      let x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      if (behind) { x = window.innerWidth - x; y = window.innerHeight - 40; }
      x = Math.max(24, Math.min(window.innerWidth - 24, x)); y = Math.max(24, Math.min(window.innerHeight - 24, y));
      e.style.display = '';
      e.style.transform = `translate(${x}px, ${y}px)`;
      e.classList.toggle('enemy', p.enemyId !== null);
      setText(e.lastElementChild as HTMLElement, `${Math.round(dist)}m${p.by ? ' · ' + p.by : ''}`);
    });
  }

  private renderStreaks(a: Agent | null, s: Settings) {
    const m = this.match;
    // only once it matters: after your first kill this life, or with a streak ready to use
    const on = !!a && a.alive && m.rules.killstreaks && a === m.player && (a.streakKills > 0 || a.streaks.length > 0);
    const key = on ? `${a!.streakKills}|${a!.streaks.join(',')}` : '';
    if (this.streakEl.dataset.k === key) return;
    this.streakEl.dataset.k = key;
    this.streakEl.innerHTML = '';
    if (!on || !a) return;
    for (const id of STREAK_ORDER) {
      const d = STREAKS[id];
      const ready = a.streaks.includes(id);
      const got = a.streakKills >= d.kills;
      const pips = h('span', { class: 'pips' }, ...Array.from({ length: d.kills }, (_, i) => h('i', { class: i < a.streakKills ? 'on' : '' })));
      this.streakEl.append(h('div', { class: 'ks' + (ready ? ' ready' : got ? ' used' : '') },
        h('b', null, d.name), ready ? h('span', { class: 'key' }, keyLabel(s.bindings.killstreak)) : pips));
    }
  }

  private renderAlive(el: HTMLElement, team: Team) {
    const ags = this.match.teamOf(team);
    const key = ags.map((a) => (a.alive ? 1 : 0)).join('');
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.innerHTML = '';
    for (const a of ags) el.append(h('i', { class: a.alive ? '' : 'dead', style: { background: team === 'T' ? 'var(--t)' : 'var(--ct)' } }));
  }

  private renderSlots(a: Agent) {
    const rows: [string, string, boolean][] = [];
    const b = this.getSettings().bindings;
    if (a.primary) rows.push([keyLabel(b.primary), a.primary.def.name, a.active === 'primary']);
    if (a.secondary) rows.push([keyLabel(b.secondary), a.secondary.def.name, a.active === 'secondary']);
    rows.push([keyLabel(b.melee), 'Knife', a.active === 'melee']);
    const gs = UTILITY_ORDER.filter((k) => a.grenades[k] > 0);
    if (gs.length) rows.push([keyLabel(b.grenade), gs.map((k) => `${utilityName(k, a.team)}${a.grenades[k] > 1 ? ' ×' + a.grenades[k] : ''}`).join(' · '), a.active === 'grenade']);
    const gd = GADGET_ORDER.filter((k) => a.gadgets[k] > 0);
    if (gd.length) rows.push([keyLabel(b.gadget), gd.map((k) => `${GADGETS[k].short}${a.gadgets[k] > 1 ? ' ×' + a.gadgets[k] : ''}`).join(' · '), a.active === 'gadget']);
    if (a.gadgets.c4 === 0 && this.match.gadgets.devices.some((d) => d.kind === 'c4' && d.ownerId === a.id)) rows.push([keyLabel(b.detonate), 'Detonate C4', false]);
    if (a.hasCrowbar) rows.push([keyLabel(b.quickMelee), 'Crowbar', false]);
    if (a.activeWeapon()?.def.mods?.light) rows.push([keyLabel(b.light), a.lightOn ? 'Light ON' : 'Light off', a.lightOn]);
    if (a.hasBomb) rows.push([keyLabel(b.bomb), 'Bomb', a.active === 'bomb']);
    if (a.hasKit) rows.push(['', 'Defuse Kit', false]);
    if (a.zp?.reviveKit) rows.push(['', 'Self-Revive Kit', false]);
    const key = rows.map((r) => r.join('|')).join(';');
    if (this.slots.dataset.k === key) return;
    this.slots.dataset.k = key;
    this.slots.innerHTML = '';
    for (const [k, n, on] of rows) this.slots.append(h('div', { class: on ? 'on' : '' }, k ? `${n}  [${k}]` : n));
  }

  private tmp = new Vector3();
  private updateNames(camera: PerspectiveCamera, team: Team | null) {
    const m = this.match;
    const want: { id: number; x: number; y: number; name: string }[] = [];
    if (team) {
      for (const a of m.agents) {
        if (!a.alive || a.team !== team || a === m.player || a === this.viewer()) continue;
        const p = this.tmp.set(a.pos.x, a.pos.y + a.height + 0.35, a.pos.z).project(camera);
        if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) continue;
        if (a.pos.distanceTo(camera.position) > 40) continue;
        if (m.world.collision.segmentBlocked(camera.position, a.eyePos(this.tmp))) continue;
        want.push({ id: a.id, x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, name: a.name });
      }
    }
    while (this.names.children.length < want.length) this.names.append(h('div', { class: 'teamname' }));
    [...this.names.children].forEach((el, i) => {
      const e = el as HTMLElement;
      const w = want[i];
      if (!w) { e.style.display = 'none'; return; }
      e.style.display = '';
      e.style.left = w.x + 'px'; e.style.top = w.y + 'px';
      e.style.color = team === 'T' ? 'var(--t)' : 'var(--ct)';
      setText(e, w.name);
    });
  }

  dispose() { for (const u of this.unsub) u(); this.el.remove(); }
}
