import { WEAPONS, type WeaponDef, type WeaponId } from '../../config/weapons';
import {
  ATTACHMENTS, MAX_ATTACHMENTS, SLOT_NAMES, deriveDef, optionsFor, type AttachmentDef, type Loadout,
} from '../../config/attachments';
import type { Match } from '../../sim/mode/Match';
import type { Agent } from '../../sim/entities/Agent';
import { priceOf, purchaseBlocker } from '../../sim/mode/Economy';
import { h, setText } from '../dom';
import { sfx } from '../../audio/Sfx';

type Which = 'primary' | 'secondary';

/** One stat bar: value 0..1 for the base gun and the gun as fitted. */
interface Stat { label: string; base: (d: WeaponDef) => number; text: (d: WeaponDef) => string }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Standing spread from the hip (milliradians), with the attachments' hip-fire change. */
const hipSpread = (d: WeaponDef) => d.spread.base + d.spread.stand * (d.spread.hip ?? 1);
const STATS: Stat[] = [
  { label: 'Damage', base: (d) => clamp01((d.damage * (d.pellets ?? 1)) / 130), text: (d) => d.pellets ? `${Math.round(d.damage)}×${d.pellets}` : `${Math.round(d.damage)}` },
  { label: 'Range', base: (d) => clamp01((d.rangeMod - 0.7) / 0.3), text: (d) => `${Math.round(d.rangeMod * 100)}%` },
  { label: 'Recoil control', base: (d) => clamp01(1 - (d.recoil.climb + d.recoil.sway * 0.18 + d.recoil.kick * 0.25) / 3.2), text: (d) => `${(d.recoil.climb).toFixed(2)}°` },
  { label: 'Hip-fire accuracy', base: (d) => clamp01(1 - hipSpread(d) / 30), text: (d) => `${hipSpread(d).toFixed(1)}` },
  { label: 'Run-and-gun', base: (d) => clamp01(1 - d.spread.move / 190), text: (d) => `${Math.round(d.spread.move)}` },
  { label: 'ADS zoom', base: (d) => clamp01(((d.ads?.zoom ?? 1.18) - 1) / 1.6), text: (d) => `${(d.ads?.zoom ?? 1.18).toFixed(2)}×` },
  { label: 'Mobility', base: (d) => clamp01((d.moveSpeed - 4.4) / 1.9), text: (d) => `${Math.round(d.moveSpeed / 0.0254)} u/s` },
  { label: 'Reload speed', base: (d) => clamp01(1 - (d.reloadTime - 1.6) / 4.6), text: (d) => `${d.reloadTime.toFixed(1)} s` },
  { label: 'Magazine', base: (d) => clamp01(d.mag / 100), text: (d) => `${d.mag}` },
];

/**
 * Gunsmith tab of the buy menu: pick your primary or secondary, see its stats change as you
 * fit attachments, and buy / fit / remove attachments per slot.
 */
export class Gunsmith {
  readonly el: HTMLDivElement;
  private which: Which = 'primary';
  private head: HTMLElement;
  private statsEl: HTMLElement;
  private slotsEl: HTMLElement;
  private countEl: HTMLElement;
  private builtFor = '';
  private buttons: { att: AttachmentDef; weapon: WeaponId; btn: HTMLButtonElement; price: HTMLElement }[] = [];

  constructor(private match: Match, private setInfo: (node: string | Node) => void) {
    this.head = h('div', { class: 'gs-head' });
    this.countEl = h('div', { class: 'gs-count' });
    this.statsEl = h('div', { class: 'gs-stats' });
    this.slotsEl = h('div', { class: 'gs-slots' });
    this.el = h('div', { class: 'gunsmith' },
      h('div', { class: 'gs-top' }, this.head, this.countEl),
      h('div', { class: 'gs-body' }, this.statsEl, this.slotsEl));
  }

  private weapon(p: Agent): WeaponId | null {
    const w = (this.which === 'primary' ? p.primary : p.secondary) ?? (this.which === 'primary' ? p.secondary : p.primary);
    return w ? w.def.id : null;
  }

  build(p: Agent) {
    const wid = this.weapon(p);
    const key = `${this.which}|${wid}|${p.primary?.def.id}|${p.secondary?.def.id}`;
    if (key === this.builtFor) return;
    this.builtFor = key;
    this.head.innerHTML = '';
    for (const which of ['primary', 'secondary'] as Which[]) {
      const w = which === 'primary' ? p.primary : p.secondary;
      this.head.append(h('button', {
        class: 'gs-gun' + (w && w.def.id === wid ? ' on' : ''), disabled: !w,
        onclick: () => { this.which = which; this.builtFor = ''; sfx.ui_click(); this.build(p); this.refresh(p); },
      }, h('small', null, which.toUpperCase()), w ? WEAPONS[w.def.id].name : '—'));
    }
    this.slotsEl.innerHTML = '';
    this.buttons = [];
    if (!wid) {
      this.slotsEl.append(h('div', { class: 'gs-empty' }, 'Buy a gun first, then customise it here.'));
      return;
    }
    const groups = optionsFor(wid);
    if (!groups.length) {
      this.slotsEl.append(h('div', { class: 'gs-empty' }, `${WEAPONS[wid].name} can't take attachments.`));
      return;
    }
    this.slotsEl.style.gridTemplateColumns = `repeat(${groups.length}, minmax(0, 1fr))`;
    for (const g of groups) {
      const col = h('div', { class: 'gs-slot' }, h('h4', null, SLOT_NAMES[g.slot]));
      for (const att of g.options) {
        const price = h('span', { class: 'p' });
        const btn = h('button', {
          class: 'gs-att',
          onclick: () => this.click(wid, att),
          onmouseenter: () => { this.setInfo(this.describe(att)); sfx.ui_hover(); },
        }, h('span', { class: 'n' }, att.name), price);
        col.append(btn);
        this.buttons.push({ att, weapon: wid, btn, price });
      }
      this.slotsEl.append(col);
    }
  }

  private describe(att: AttachmentDef): Node {
    return h('span', { class: 'gs-info' }, h('b', null, att.name + ' '),
      ...att.pros.map((t) => h('span', { class: 'pro' }, '▲ ' + t)),
      ...att.cons.map((t) => h('span', { class: 'con' }, '▼ ' + t)));
  }

  private click(weapon: WeaponId, att: AttachmentDef) {
    const p = this.match.player;
    if (!p) return;
    const owned = p.loadouts[weapon]?.owned.includes(att.id);
    if (this.match.tryBuy(p, { kind: 'attachment', weapon, id: att.id })) owned ? sfx.ui_click() : sfx.buy();
    else sfx.denied();
    this.refresh(p);
  }

  refresh(p: Agent) {
    this.build(p);
    const wid = this.weapon(p);
    const lo = wid ? p.loadouts[wid] : undefined;
    const eq: Loadout = lo?.equipped ?? {};
    const fitted = Object.values(eq).filter(Boolean).length;
    setText(this.countEl, wid ? `Attachments ${fitted} / ${MAX_ATTACHMENTS} · kept for this gun for the rest of the half, even if you die` : '');
    for (const b of this.buttons) {
      const owned = !!lo?.owned.includes(b.att.id);
      const on = eq[b.att.slot] === b.att.id;
      const item = { kind: 'attachment' as const, weapon: b.weapon, id: b.att.id };
      const blocker = purchaseBlocker(item, p);
      setText(b.price, on ? 'FITTED' : owned ? 'OWNED' : '$' + priceOf(item, p));
      b.btn.classList.toggle('on', on);
      b.btn.classList.toggle('owned', owned && !on);
      b.btn.disabled = !!blocker && !on;
      b.btn.title = blocker ?? (on ? 'Click to remove (free)' : owned ? 'Click to fit (free)' : 'Click to buy and fit');
    }
    // stats: base gun vs. as fitted
    this.statsEl.innerHTML = '';
    if (!wid) return;
    const base = WEAPONS[wid], cur = deriveDef(wid, eq);
    this.statsEl.append(h('h4', null, WEAPONS[wid].name.toUpperCase()));
    for (const s of STATS) {
      const b = s.base(base), c = s.base(cur);
      const better = c > b + 0.004, worse = c < b - 0.004;
      const fill = h('i', { class: 'base', style: { width: `${Math.round(Math.min(b, c) * 100)}%` } });
      const delta = h('i', { class: 'delta ' + (better ? 'up' : worse ? 'down' : ''), style: { left: `${Math.round(Math.min(b, c) * 100)}%`, width: `${Math.round(Math.abs(c - b) * 100)}%` } });
      this.statsEl.append(h('div', { class: 'gs-stat' }, h('span', { class: 'l' }, s.label), h('div', { class: 'bar' }, fill, delta),
        h('span', { class: 'v ' + (better ? 'up' : worse ? 'down' : '') }, s.text(cur))));
    }
    const fittedNames = Object.values(eq).filter(Boolean).map((id) => ATTACHMENTS[id!].name);
    this.statsEl.append(h('div', { class: 'gs-fitted' }, fittedNames.length ? fittedNames.join(' · ') : 'No attachments fitted'));
  }
}
