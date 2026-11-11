import { ACTION_LABELS, DEFAULT_BINDINGS, keyLabel, type Action } from '../../config/controls';
import { DEFAULT_CROSSHAIR } from '../../config/cosmetics';
import type { Input } from '../../app/Input';
import { DEFAULT_SETTINGS, type Settings } from '../../app/Profile';
import { h } from '../dom';
import { optRow, seg, slider, toggle } from '../components';
import { drawCrosshair } from '../hud/Crosshair';

type Tab = 'game' | 'audio' | 'video' | 'controls' | 'crosshair';

/** Settings editor shared by the main menu and the in-game pause menu. Changes apply live. */
export class SettingsPanel {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private tab: Tab = 'game';

  constructor(private settings: () => Settings, private onChange: (s: Settings) => void, private input: Input) {
    this.body = h('div', { class: 'card', style: 'max-width:820px' });
    this.el = h('div', null,
      seg<Tab>([{ value: 'game', label: 'Game' }, { value: 'audio', label: 'Audio' }, { value: 'video', label: 'Video' }, { value: 'controls', label: 'Controls' }, { value: 'crosshair', label: 'Crosshair' }],
        this.tab, (t) => { this.tab = t; this.render(); }),
      h('div', { style: 'height:12px' }), this.body);
    this.render();
  }

  private set<K extends keyof Settings>(k: K, v: Settings[K]) {
    const s = this.settings();
    s[k] = v;
    this.onChange(s);
  }

  render() {
    const s = this.settings();
    this.body.innerHTML = '';
    const grid = h('div', { class: 'opt-grid' });
    const add = (label: string, c: HTMLElement) => grid.append(...optRow(label, c));
    switch (this.tab) {
      case 'game':
        add('Mouse sensitivity', slider(0.1, 8, 0.05, s.sensitivity, (v) => this.set('sensitivity', v), (v) => v.toFixed(2)));
        add('Zoom sensitivity', slider(0.2, 2, 0.05, s.zoomSensitivity, (v) => this.set('zoomSensitivity', v), (v) => v.toFixed(2)));
        add('Invert mouse Y', toggle(s.invertY, (v) => this.set('invertY', v)));
        add('Aim assist', seg([{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], s.aimAssist ?? 'off', (v) => this.set('aimAssist', v as Settings['aimAssist'])));
        grid.append(h('div'), h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:-6px' }, 'Slows your aim over visible enemies, gently pulls toward the nearest part of their body (never off a headshot) and helps track strafing targets while you aim or move. Smoke, walls and flashes switch it off.'));
        add('Field of view (4:3)', slider(70, 110, 1, s.fov, (v) => this.set('fov', v), (v) => v + '°'));
        add('View-model FOV', slider(50, 75, 1, s.viewmodelFov, (v) => this.set('viewmodelFov', v), (v) => v + '°'));
        add('Left-handed view model', toggle(s.leftHanded, (v) => this.set('leftHanded', v)));
        add('Crouch & prone', seg([{ value: 'hold', label: 'Hold (CS)' }, { value: 'toggle', label: 'Toggle (CoD)' }], s.crouchMode ?? 'hold', (v) => this.set('crouchMode', v as Settings['crouchMode'])));
        grid.append(h('div'), h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:-6px' }, 'Hold: hold crouch to crouch; keep holding while standing still to go prone. Toggle: tap to crouch or stand, hold to go prone, Space stands you up.'));
        add('Lean / tilt mode', seg([{ value: 'hold', label: 'Hold' }, { value: 'toggle', label: 'Toggle' }], s.leanToggle ? 'toggle' : 'hold', (v) => this.set('leanToggle', v === 'toggle')));
        add('Aim-down-sights mode', seg([{ value: 'hold', label: 'Hold' }, { value: 'toggle', label: 'Toggle' }], s.adsToggle ? 'toggle' : 'hold', (v) => this.set('adsToggle', v === 'toggle')));
        add('Final killcam', toggle(s.killcam ?? true, (v) => this.set('killcam', v)));
        add('Objective markers (sites, bomb)', toggle(s.objectiveMarkers ?? true, (v) => this.set('objectiveMarkers', v)));
        add('Grenade trajectory preview', toggle(s.grenadePreview ?? true, (v) => this.set('grenadePreview', v)));
        add('Grenade warning indicator', toggle(s.grenadeWarnings ?? true, (v) => this.set('grenadeWarnings', v)));
        add('Damage numbers', toggle(s.damageNumbers ?? true, (v) => this.set('damageNumbers', v)));
        grid.append(h('div'), h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:-6px' },
          'The preview draws where a grenade you hold ready will fly, bounce and go off. The warning points at live grenades close enough to hurt or blind you. Damage numbers float off whoever you hit (gold for headshots).'));
        add('Gameplay tips', toggle(s.tips ?? true, (v) => this.set('tips', v)));
        add('Rotate radar', toggle(s.rotateRadar, (v) => this.set('rotateRadar', v)));
        add('Radar zoom', slider(0.5, 2, 0.1, s.radarZoom, (v) => this.set('radarZoom', v), (v) => v.toFixed(1) + '×'));
        add('Show FPS', toggle(s.showFps, (v) => this.set('showFps', v)));
        add('Paper doll', seg([{ value: 'off', label: 'Off' }, { value: 'action', label: 'When acting' }, { value: 'always', label: 'Always' }],
          s.paperDoll ?? 'off', (v) => this.set('paperDoll', v as Settings['paperDoll'])));
        grid.append(h('div'), h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:-6px' },
          'A live model of your character in the top-right corner that copies what you do: shooting, reloading, throwing, melee, crouching, prone, slides, jumps, leans and planting. When acting shows it during those moves and tucks it away 2 seconds later; Always keeps it on screen.'));
        add('Paper doll size', slider(0.7, 1.5, 0.05, s.paperDollSize ?? 1, (v) => this.set('paperDollSize', v), (v) => Math.round(v * 100) + '%'));
        break;
      case 'audio':
        add('Master volume', slider(0, 1, 0.01, s.masterVolume, (v) => this.set('masterVolume', v), (v) => Math.round(v * 100) + '%'));
        add('Effects volume', slider(0, 1, 0.01, s.sfxVolume, (v) => this.set('sfxVolume', v), (v) => Math.round(v * 100) + '%'));
        add('Interface volume', slider(0, 1, 0.01, s.uiVolume, (v) => this.set('uiVolume', v), (v) => Math.round(v * 100) + '%'));
        add('Round announcer voice', toggle(s.announcer ?? true, (v) => this.set('announcer', v)));
        break;
      case 'video':
        add('Graphics quality', seg([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], s.quality, (v) => this.set('quality', v as Settings['quality'])));
        add('Resolution scale', slider(0.5, 2, 0.05, s.renderScale, (v) => this.set('renderScale', v), (v) => Math.round(v * 100) + '%'));
        grid.append(h('div'), h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5' },
          'Low: lighter shading for faster play. Medium: room lights and sun shadows. High: detailed surface lighting, soft shadows and contact shading. ',
          'Resolution 100% = your window size; raise it on high-DPI screens with a strong GPU.'));
        break;
      case 'controls': {
        const g = h('div', { class: 'bind-grid' });
        for (const a of Object.keys(ACTION_LABELS) as Action[]) {
          const btn = h('button', { class: 'bind-btn' }, keyLabel(s.bindings[a]));
          btn.addEventListener('click', () => {
            btn.textContent = 'Press a key…';
            btn.classList.add('wait');
            this.input.captureNext = (code) => {
              if (code !== 'Escape') { s.bindings[a] = code; this.onChange(s); }
              this.render();
            };
          });
          g.append(h('div', { class: 'muted' }, ACTION_LABELS[a]), btn);
        }
        this.body.append(g, h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => { s.bindings = { ...DEFAULT_BINDINGS }; this.onChange(s); this.render(); } }, 'Reset to defaults')),
          h('p', { class: 'muted', style: 'font-size:12px' }, 'Fire = Left mouse · Aim / Scope / Stab / Underhand throw = Right mouse · Mouse wheel cycles weapons. Quick melee stabs without switching weapons. Hold Use with a crowbar to pry barricades. Esc pauses.'));
        return;
      }
      case 'crosshair': {
        const c = s.crosshair;
        const dpr = window.devicePixelRatio || 1, px = 2 * Math.round(50 * dpr);
        const prev = h('canvas', { width: px, height: px, style: 'position:absolute;left:60px;top:30px;width:100px;height:100px' }) as HTMLCanvasElement;
        const redraw = () => drawCrosshair(prev.getContext('2d')!, c, 0, dpr);
        const setC = <K extends keyof typeof c>(k: K, v: (typeof c)[K]) => { c[k] = v; this.onChange(s); redraw(); };
        add('Style', seg([{ value: 'classic', label: 'Classic' }, { value: 'dot', label: 'Dot' }, { value: 'circle', label: 'Circle' }], c.style, (v) => setC('style', v as typeof c.style)));
        add('Color', seg(['#4cff4c', '#ffff40', '#40e0ff', '#ff40ff', '#ffffff', '#ff4040'].map((v) => ({ value: v, label: '■' })), c.color, (v) => setC('color', v)));
        add('Size', slider(1, 20, 0.5, c.size, (v) => setC('size', v)));
        add('Gap', slider(-2, 12, 0.5, c.gap, (v) => setC('gap', v)));
        add('Thickness', slider(1, 5, 1, c.thickness, (v) => setC('thickness', v)));
        add('Center dot', toggle(c.dot, (v) => setC('dot', v)));
        add('Outline', toggle(c.outline, (v) => setC('outline', v)));
        add('Dynamic (spread)', toggle(c.dynamic, (v) => setC('dynamic', v)));
        add('Follow recoil', toggle(c.followRecoil !== false, (v) => setC('followRecoil', v)));
        add('Opacity', slider(0.2, 1, 0.05, c.alpha, (v) => setC('alpha', v), (v) => Math.round(v * 100) + '%'));
        add('', h('button', { class: 'btn', onclick: () => { s.crosshair = { ...DEFAULT_CROSSHAIR }; this.onChange(s); this.render(); } }, 'Reset crosshair'));
        this.body.append(h('div', { class: 'row', style: 'align-items:flex-start;gap:24px' }, grid, h('div', { class: 'xhair-preview' }, prev)));
        redraw();
        return;
      }
    }
    this.body.append(grid,
      h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn', onclick: () => {
        const keep = { bindings: s.bindings, crosshair: s.crosshair };
        Object.assign(s, structuredClone(DEFAULT_SETTINGS), keep);
        this.onChange(s); this.render();
      } }, 'Reset this page to defaults')));
  }
}
