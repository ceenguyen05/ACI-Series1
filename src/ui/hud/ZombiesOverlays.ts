import type { ZombiesMatch } from '../../sim/zombies/ZombiesMatch';
import { ARMORY, ARMORY_ORDER, ZDIFF, ZLENGTHS, type ArmoryId } from '../../config/zombies';
import { h } from '../dom';
import { sfx } from '../../audio/Sfx';

/** Armory station (F): lethals, defenses and support gear for points. Keys 1–9 / 0 / - / = buy. */
export class ArmoryMenu {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private pts: HTMLElement;
  visible = false;
  constructor(private m: ZombiesMatch, private onClose: () => void) {
    this.pts = h('span', { class: 'money' });
    this.body = h('div', { class: 'armory-grid' });
    this.el = h('div', { class: 'overlay-dim hidden' },
      h('div', { class: 'armory panel' },
        h('div', { class: 'buy-head' }, h('div', null, h('b', { style: 'font-size:22px;letter-spacing:.14em' }, 'ARMORY'), h('span', { class: 'muted', style: 'margin-left:14px;font-size:13px' }, 'Lethals · Defenses · Support')), this.pts),
        this.body,
        h('div', { class: 'buy-foot' }, h('span', null, 'Click or press the number to buy · F / Esc closes'), h('span', null, 'Weapons come from the walls and the Mystery Box'))));
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.onClose(); });
  }
  show() { this.visible = true; this.el.classList.remove('hidden'); this.render(); }
  hide() { this.visible = false; this.el.classList.add('hidden'); }
  key(code: string) {
    const keys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];
    const i = keys.indexOf(code);
    if (i >= 0 && ARMORY_ORDER[i]) this.buy(ARMORY_ORDER[i]);
  }
  private buy(id: ArmoryId) {
    const p = this.m.player;
    if (!p) return;
    if (this.m.buyArmory(p, id)) sfx.purchase(); else sfx.denied();
    this.render();
  }
  private lastKey = '';
  refresh() {
    const p = this.m.player;
    const key = p ? `${p.money}|${p.armor}|${JSON.stringify(p.grenades)}|${JSON.stringify(p.gadgets)}|${p.zp?.reviveKit}` : '';
    if (key !== this.lastKey) this.render();
  }
  private render() {
    const p = this.m.player;
    if (!p) return;
    this.lastKey = `${p.money}|${p.armor}|${JSON.stringify(p.grenades)}|${JSON.stringify(p.gadgets)}|${p.zp?.reviveKit}`;
    this.pts.textContent = `${p.money.toLocaleString('en-US')} pts`;
    this.body.innerHTML = '';
    const keyNames = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
    for (const cat of ['Lethal', 'Defense', 'Support'] as const) {
      const col = h('div', { class: 'buy-col' }, h('h4', null, cat));
      ARMORY_ORDER.forEach((id, i) => {
        const d = ARMORY[id];
        if (d.cat !== cat) return;
        const why = this.m.armoryBlocker(p, id);
        col.append(h('button', { class: 'buy-item' + (why === 'Already full' ? ' owned' : ''), disabled: !!why, title: why, onclick: () => this.buy(id), onmouseenter: () => sfx.ui_hover() },
          h('div', { class: 'n' }, h('span', { class: 'k' }, keyNames[i] + '  '), d.name, h('div', { class: 'k' }, d.blurb)),
          h('div', { class: 'p' }, why === 'Already full' ? 'FULL' : `${d.price.toLocaleString('en-US')}`)));
      });
      this.body.append(col);
    }
  }
}

/** Hold-Tab squad board. */
export class ZombiesScoreboard {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  constructor(private m: ZombiesMatch) {
    this.body = h('div', { class: 'scoreboard panel' });
    this.el = h('div', { class: 'overlay-dim hidden', style: 'background:rgba(4,6,8,.35)' }, this.body);
  }
  show(on: boolean) { this.el.classList.toggle('hidden', !on); if (on) this.render(); }
  render() {
    const m = this.m, me = m.player;
    this.body.innerHTML = '';
    this.body.append(h('div', { class: 'sb-team' },
      h('h3', { style: { color: '#ff5a3c' } }, h('span', null, `${m.layout.name.toUpperCase()} · ${ZDIFF[m.zc.difficulty].label.toUpperCase()}`), h('span', null, `WAVE ${Math.max(1, m.wave)}`)),
      h('table', { class: 'sb-table' },
        h('tr', null, ...['PLAYER', 'POINTS', 'KILLS', 'HEADSHOTS', 'DOWNS', 'REVIVES', 'PERKS'].map((x) => h('th', null, x))),
        m.humans.map((a) => {
          const s = a.zp!.stats;
          return h('tr', { class: (a.alive ? '' : 'dead') + (a === me ? ' me' : '') },
            h('td', null, h('i', { style: { display: 'inline-block', width: '10px', height: '10px', marginRight: '8px', background: a.zp!.color } }), a.name + (a.zp!.downed ? '  ✚' : '')),
            h('td', null, a.money.toLocaleString('en-US')), h('td', null, String(s.kills)), h('td', null, String(s.headshots)),
            h('td', null, String(s.downs)), h('td', null, String(s.revives)), h('td', null, String(a.zp!.perks.length)));
        }))));
    this.body.append(h('div', { class: 'sb-history' }, h('span', { class: 'muted', style: 'font-size:12px' },
      `Zombies killed: ${m.totalKills} · Doors opened: ${m.gates.filter((g) => g.open).length}/${m.gates.length} · Power: ${m.power ? 'ON' : 'off'} · ${ZLENGTHS[m.zc.length].label}`)));
  }
}

/** Game over / successful exfil. */
export class ZombiesEndScreen {
  readonly el: HTMLDivElement;
  constructor(m: ZombiesMatch, best: number, newBest: boolean, onAgain: () => void, onMenu: () => void, online = false) {
    const me = m.player;
    const won = m.won;
    const title = won ? 'EXFIL SUCCESSFUL' : 'GAME OVER';
    // (the game is already over here, so the wave phase can't tell a cleared wave from a lost one).
    // Waves cleared is always this wave or the one before; the floor covers a server that doesn't send it yet.
    const cleared = Math.max(0, Math.min(m.wave, Math.max(m.wavesCleared ?? 0, m.wave - 1)));
    const sub = won ? `You escaped ACI HQ after ${m.wave} waves`
      : `You survived ${cleared} wave${cleared === 1 ? '' : 's'} — ${cleared >= m.wave ? `fell before wave ${m.wave + 1}` : `fell on wave ${m.wave}`}`;
    const rows = [...m.humans].sort((a, b) => b.zp!.stats.kills - a.zp!.stats.kills);
    this.el = h('div', { class: 'overlay-dim z-end' },
      h('div', { class: 'match-end panel z-end-panel' },
        h('div', { class: 'big', style: { color: won ? 'var(--good)' : '#ff4a32' } }, title),
        h('div', { class: 'z-end-wave' }, h('b', null, String(m.wave)), h('span', null, 'WAVE')),
        h('div', { class: 'muted', style: 'margin:6px 0 14px' }, sub),
        newBest ? h('div', { class: 'mvp' }, `★ NEW BEST: WAVE ${best} on ${ZDIFF[m.zc.difficulty].label}`) : h('div', { class: 'muted', style: 'font-size:13px' }, `Best on ${ZDIFF[m.zc.difficulty].label}: wave ${best}`),
        h('table', { class: 'sb-table', style: 'margin-top:16px' },
          h('tr', null, ...['PLAYER', 'KILLS', 'HEADSHOTS', 'DOWNS', 'REVIVES', 'EARNED'].map((x) => h('th', null, x))),
          rows.map((a) => h('tr', { class: a === me ? 'me' : '' }, h('td', null, a.name), h('td', null, String(a.zp!.stats.kills)), h('td', null, String(a.zp!.stats.headshots)),
            h('td', null, String(a.zp!.stats.downs)), h('td', null, String(a.zp!.stats.revives)), h('td', null, a.zp!.stats.earned.toLocaleString('en-US'))))),
        h('div', { class: 'row', style: 'justify-content:center;margin-top:24px;gap:12px' },
          h('button', { class: 'btn primary', onclick: () => { sfx.ui_click(); onAgain(); } }, online ? 'Find another match' : 'Play again'),
          h('button', { class: 'btn', onclick: () => { sfx.ui_click(); onMenu(); } }, 'Main menu'))));
  }
}
