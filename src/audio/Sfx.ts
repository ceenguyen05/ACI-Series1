import type { Vector3 } from 'three';
import type { SoundProfile } from '../config/weapons';

type Pos = Vector3 | null;
/**
 * Where a sound layer plays: a world position, null (inside the listener's head), or a node
 * already built for this sound, so every layer of one sound shares a single panner.
 */
type Dest = Pos | AudioNode;

interface GunVoice { body: number; q: number; thump: number; dur: number; gain: number; click: number }
const GUN: Record<SoundProfile, GunVoice> = {
  pistol: { body: 1500, q: 0.9, thump: 0.5, dur: 0.16, gain: 0.8, click: 0.6 },
  heavyPistol: { body: 800, q: 0.8, thump: 1.0, dur: 0.3, gain: 1.0, click: 0.7 },
  suppressed: { body: 2600, q: 1.5, thump: 0.1, dur: 0.08, gain: 0.35, click: 0.3 },
  smg: { body: 1300, q: 0.9, thump: 0.5, dur: 0.12, gain: 0.7, click: 0.6 },
  rifle: { body: 1000, q: 0.8, thump: 0.8, dur: 0.2, gain: 0.9, click: 0.8 },
  heavyRifle: { body: 750, q: 0.7, thump: 1.0, dur: 0.24, gain: 1.0, click: 0.9 },
  sniper: { body: 450, q: 0.6, thump: 1.4, dur: 0.5, gain: 1.15, click: 1.0 },
  shotgun: { body: 380, q: 0.6, thump: 1.3, dur: 0.35, gain: 1.1, click: 0.8 },
  knife: { body: 3000, q: 1, thump: 0, dur: 0.1, gain: 0.3, click: 0 },
  launcher: { body: 260, q: 0.6, thump: 1.6, dur: 0.3, gain: 1.0, click: 0.5 },
  rocket: { body: 180, q: 0.5, thump: 1.8, dur: 0.9, gain: 1.2, click: 0.6 },
  energy: { body: 2600, q: 4, thump: 0.25, dur: 0.18, gain: 0.55, click: 0.15 },
};

/**
 * Procedural sound effects (WebAudio). No audio files: every sound is synthesized from noise
 * and oscillators, with HRTF positional panning for world sounds.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private world!: GainNode;
  private ui!: GainNode;
  private muffle!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private ringOsc: OscillatorNode | null = null;
  private volumes = { master: 0.8, sfx: 1, ui: 0.7 };
  private reverbSend: GainNode | null = null;
  private room = 0.2;
  /**
   * How much of the path from the listener to a world position is blocked (0 open … 1 fully behind
   * walls). Set by the match view; occluded sounds are duller and quieter.
   */
  occlusion: ((pos: Vector3) => number) | null = null;

  /** Must be called from a user gesture. */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.muffle = this.ctx.createBiquadFilter();
      this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000;
      this.world = this.ctx.createGain();
      this.ui = this.ctx.createGain();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.world.connect(this.muffle).connect(this.master);
      this.ui.connect(this.master);
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // Room reverb: world sounds leave a short tail, so gunfire rings indoors instead of stopping dead.
      try {
        const reverb = this.ctx.createConvolver();
        reverb.buffer = this.impulse(1.25);
        this.reverbSend = this.ctx.createGain();
        this.reverbSend.gain.value = this.room;
        this.muffle.connect(this.reverbSend).connect(reverb).connect(this.master);
      } catch { this.reverbSend = null; /* no convolver: play dry */ }
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** A synthetic room response: a few early reflections, then a decaying, darkening noise tail. */
  private impulse(seconds: number): AudioBuffer {
    const c = this.ctx!, sr = c.sampleRate, len = Math.floor(sr * seconds);
    const buf = c.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        // the tail loses its highs as it decays (air and soft furnishings absorb them first)
        const k = 0.5 - 0.42 * Math.min(1, t / seconds);
        lp += ((Math.random() * 2 - 1) - lp) * k;
        d[i] = lp * Math.exp(-6.9 * t / seconds) * Math.min(1, t / 0.006);
      }
      for (const [ms, g] of [[11, 0.5], [19, -0.38], [31, 0.3], [47, -0.22]] as const) {
        const i = Math.floor((ms + ch * 2.5) * sr / 1000);
        if (i < len) d[i] += g;
      }
    }
    return buf;
  }

  /** Reverb amount for where the listener stands: 1 = a hard-walled room, 0 = open air. */
  setRoom(amount: number) {
    const v = 0.03 + 0.19 * Math.max(0, Math.min(1, amount));
    if (Math.abs(v - this.room) < 0.005) return;
    this.room = v;
    if (this.ctx && this.reverbSend) this.reverbSend.gain.setTargetAtTime(v, this.ctx.currentTime, 0.35);
  }

  setVolumes(master: number, sfx: number, ui: number) { this.volumes = { master, sfx, ui }; this.applyVolumes(); }
  private applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.world.gain.value = this.volumes.sfx;
    this.ui.gain.value = this.volumes.ui;
  }

  setListener(pos: Vector3, fwd: Vector3) {
    const c = this.ctx;
    if (!c) return;
    const l = c.listener;
    if (l.positionX) {
      const t = c.currentTime;
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
    }
  }

  // ---------------------------------------------------------------- primitives
  private out(at: Dest, bus?: GainNode): AudioNode {
    const c = this.ctx!;
    if (!at) return bus ?? this.world;
    if (!(at as Vector3).isVector3) return at as AudioNode;
    const pos = at as Vector3;
    const p = c.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = 2.5; p.rolloffFactor = 1.1; p.maxDistance = 120;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    p.connect(bus ?? this.world);
    // Behind a wall: lose the highs and some level, like a sound heard through a building.
    const occ = this.occlusion ? Math.max(0, Math.min(1, this.occlusion(pos))) : 0;
    if (occ < 0.05) return p;
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 16000 * Math.pow(0.055, occ); f.Q.value = 0.5;
    const g = c.createGain();
    g.gain.value = 1 - 0.32 * occ;
    f.connect(g).connect(p);
    return f;
  }

  /**
   * One destination for every layer of a sound. A gunshot has five layers; giving each its own
   * HRTF panner made a firefight cost several times the audio work it needs.
   */
  private dest(at: Pos): Dest { return this.ctx && at ? this.out(at) : at; }

  private noiseHit(o: { at: Dest; dur: number; type: BiquadFilterType; freq: number; freqEnd?: number; q?: number; gain: number; attack?: number; delay?: number; bus?: GainNode }) {
    const c = this.ctx; if (!c || !(o.gain > 0.002)) return;
    const t = c.currentTime + (o.delay ?? 0);
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = o.type; f.frequency.setValueAtTime(o.freq, t); f.Q.value = o.q ?? 1;
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain, t + (o.attack ?? 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(g).connect(this.out(o.at, o.bus));
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.05);
  }

  private tone(o: { at: Dest; type: OscillatorType; freq: number; freqEnd?: number; dur: number; gain: number; delay?: number; bus?: GainNode; attack?: number }) {
    const c = this.ctx; if (!c || !(o.gain > 0.002)) return;
    const t = c.currentTime + (o.delay ?? 0);
    const osc = c.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.freqEnd), t + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain, t + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g).connect(this.out(o.at, o.bus));
    osc.start(t); osc.stop(t + o.dur + 0.05);
  }

  // ---------------------------------------------------------------- weapons
  /**
   * `emptying` (0..1, your own gun only) adds the hollow ring of a magazine running dry over its
   * last few rounds, so you hear when to reload without looking at the counter.
   */
  gunshot(profile: SoundProfile, pos: Pos, distance = 0, emptying = 0) {
    if (!this.ctx) return;
    const v = GUN[profile];
    const far = Math.min(1, distance / 60);
    const lp = 16000 * (1 - far * 0.85);
    const at = this.dest(pos);
    this.noiseHit({ at, dur: 0.02, type: 'highpass', freq: 2500, gain: 0.5 * v.click * (1 - far), attack: 0.0005 });
    this.noiseHit({ at, dur: v.dur, type: 'bandpass', freq: v.body * (1 - far * 0.4), q: v.q, gain: 1.4 * v.gain, attack: 0.001 });
    this.noiseHit({ at, dur: v.dur * 2.6, type: 'lowpass', freq: Math.min(lp, 2200), freqEnd: 300, gain: 0.35 * v.gain, attack: 0.004 });
    if (v.thump > 0) this.tone({ at, type: 'sine', freq: 140, freqEnd: 45, dur: 0.12 + v.thump * 0.05, gain: 0.7 * v.thump * (1 - far * 0.5) });
    // A short mechanical layer separates the action from the report.
    this.noiseHit({ at, dur: 0.035, type: 'bandpass', freq: 3400, q: 3.5, gain: 0.11 * (1 - far), delay: profile === 'shotgun' ? 0.28 : 0.045 });
    if (profile === 'sniper' || profile === 'shotgun') this.noiseHit({ at, dur: 0.085, type: 'highpass', freq: 1700, gain: 0.15 * (1 - far), delay: 0.36 });
    if (emptying > 0) this.tone({ at, type: 'triangle', freq: 2300 + 1100 * emptying, freqEnd: 1900 + 900 * emptying, dur: 0.07, gain: 0.05 + 0.09 * emptying, delay: 0.025 });
  }

  dryFire() { this.tone({ at: null, type: 'square', freq: 1800, freqEnd: 900, dur: 0.03, gain: 0.15 }); }

  reload(pos: Pos, duration = 2.5) {
    const at = this.dest(pos);
    this.noiseHit({ at, dur: 0.12, type: 'highpass', freq: 1100, gain: 0.12, delay: duration * 0.08 });
    this.noiseHit({ at, dur: 0.05, type: 'bandpass', freq: 2500, q: 4, gain: 0.3, delay: duration * 0.16 });
    this.noiseHit({ at, dur: 0.06, type: 'bandpass', freq: 1800, q: 3, gain: 0.4, delay: duration * 0.67 });
    this.noiseHit({ at, dur: 0.05, type: 'bandpass', freq: 3200, q: 5, gain: 0.35, delay: duration * 0.85 });
  }

  draw(at: Pos) { this.noiseHit({ at, dur: 0.08, type: 'bandpass', freq: 3000, q: 2, gain: 0.25 }); }

  knife(pos: Pos, hit: boolean) {
    const at = this.dest(pos);
    this.noiseHit({ at, dur: 0.16, type: 'bandpass', freq: 4000, freqEnd: 1500, q: 1.5, gain: 0.25 });
    if (hit) this.noiseHit({ at, dur: 0.08, type: 'lowpass', freq: 900, gain: 0.6, delay: 0.05 });
  }

  /**
   * A round passing close to your head: the crack of it going by, then the hiss trailing off.
   * `close` is 1 for a near graze and falls toward 0 at the edge of earshot.
   */
  whiz(pos: Pos, close: number) {
    const at = this.dest(pos);
    this.noiseHit({ at, dur: 0.028, type: 'highpass', freq: 3600, gain: 0.55 * close, attack: 0.0005 });
    this.noiseHit({ at, dur: 0.17, type: 'bandpass', freq: 2600 + Math.random() * 900, freqEnd: 650, q: 2.4, gain: 0.36 * close, delay: 0.01 });
  }

  /** A bullet striking something near you: each material answers differently. */
  impact(pos: Pos, surface: string) {
    const at = this.dest(pos);
    switch (surface) {
      case 'metal': case 'vehicle': {
        const f = 2300 + Math.random() * 1500;
        this.noiseHit({ at, dur: 0.045, type: 'bandpass', freq: 3200, q: 4, gain: 0.3 });
        this.tone({ at, type: 'triangle', freq: f, freqEnd: f * 0.78, dur: 0.14, gain: 0.11 }); // ricochet ring
        break;
      }
      case 'glass':
        this.noiseHit({ at, dur: 0.07, type: 'highpass', freq: 4500, gain: 0.28 });
        this.tone({ at, type: 'sine', freq: 3600 + Math.random() * 900, dur: 0.05, gain: 0.07 });
        break;
      case 'wood':
        this.noiseHit({ at, dur: 0.07, type: 'lowpass', freq: 900, gain: 0.42 });
        this.noiseHit({ at, dur: 0.03, type: 'bandpass', freq: 2000, q: 2, gain: 0.15 });
        break;
      case 'fabric':
        this.noiseHit({ at, dur: 0.06, type: 'lowpass', freq: 520, gain: 0.26 });
        break;
      default:
        this.noiseHit({ at, dur: 0.06, type: 'bandpass', freq: 1300 + Math.random() * 500, q: 1, gain: 0.36 });
        this.noiseHit({ at, dur: 0.03, type: 'highpass', freq: 3000, gain: 0.14 });
    }
  }

  /** Spent brass ringing off the floor (a shotgun hull is a dull plastic tap). */
  casing(pos: Pos, shell = false) {
    const at = this.dest(pos);
    if (shell) { this.noiseHit({ at, dur: 0.05, type: 'bandpass', freq: 900, q: 2, gain: 0.16 }); return; }
    const f = 3900 + Math.random() * 1700;
    this.tone({ at, type: 'triangle', freq: f, dur: 0.045, gain: 0.05 });
    this.tone({ at, type: 'triangle', freq: f * 1.19, dur: 0.035, gain: 0.03, delay: 0.075 + Math.random() * 0.04 });
  }

  /** Cloth and gear shifting as you push off the ground. */
  jump(at: Pos) { this.noiseHit({ at, dur: 0.1, type: 'bandpass', freq: 650, freqEnd: 900, q: 0.8, gain: at ? 0.2 : 0.11 }); }

  /** Bringing the gun up to your eye, or lowering it again. */
  aim(up: boolean) { this.noiseHit({ at: null, dur: 0.07, type: 'bandpass', freq: up ? 1500 : 1100, q: 1.2, gain: 0.07 }); }

  /** A scope's zoom ring clicking to its next stop (or back off the eye). */
  scopeClick(level: number) {
    this.noiseHit({ at: null, dur: 0.025, type: 'bandpass', freq: level > 0 ? 3000 + level * 500 : 2200, q: 5, gain: 0.16 });
    if (level > 0) this.noiseHit({ at: null, dur: 0.09, type: 'bandpass', freq: 1300, q: 1, gain: 0.05, delay: 0.02 });
  }

  /** Feedback when the local player hits someone (CS-style audible hit). */
  hitConfirm(head: boolean, helmet: boolean) {
    if (head && helmet) this.tone({ at: null, type: 'triangle', freq: 3200, freqEnd: 2600, dur: 0.18, gain: 0.25, bus: this.ui });
    else if (head) this.noiseHit({ at: null, dur: 0.08, type: 'bandpass', freq: 1800, q: 2, gain: 0.6, bus: this.ui });
    else this.noiseHit({ at: null, dur: 0.05, type: 'lowpass', freq: 700, gain: 0.5, bus: this.ui });
  }

  /** Crisp confirmation when the local player gets a kill (brighter for headshots). */
  killConfirm(headshot: boolean) {
    this.tone({ at: null, type: 'sine', freq: headshot ? 1480 : 1180, dur: 0.09, gain: 0.22, bus: this.ui });
    this.tone({ at: null, type: 'sine', freq: headshot ? 2220 : 1580, dur: 0.16, gain: 0.18, delay: 0.06, bus: this.ui });
    if (headshot) this.noiseHit({ at: null, dur: 0.05, type: 'highpass', freq: 5000, gain: 0.25, bus: this.ui });
  }
  /** Low heartbeat-style thump when you die. */
  death() {
    this.tone({ at: null, type: 'sine', freq: 90, freqEnd: 40, dur: 0.5, gain: 0.6, bus: this.ui });
    this.noiseHit({ at: null, dur: 0.6, type: 'lowpass', freq: 400, freqEnd: 80, gain: 0.5, bus: this.ui });
  }

  hurt() { this.noiseHit({ at: null, dur: 0.12, type: 'lowpass', freq: 500, gain: 0.7 }); }

  footstep(surface: string, at: Pos, loud = 1) {
    const s: Record<string, [BiquadFilterType, number, number]> = {
      carpet: ['lowpass', 500, 0.35], carpetSite: ['lowpass', 500, 0.35], confCarpet: ['lowpass', 450, 0.3],
      marble: ['bandpass', 2400, 0.55], tile: ['bandpass', 2000, 0.5], checker: ['bandpass', 2200, 0.5],
      serverFloor: ['bandpass', 1400, 0.6], lino: ['bandpass', 1600, 0.45],
      concrete: ['bandpass', 1100, 0.55], concreteSite: ['bandpass', 1100, 0.55], warehouse: ['bandpass', 1200, 0.55],
      asphalt: ['bandpass', 800, 0.5], asphaltSpawn: ['bandpass', 800, 0.5],
    };
    const [type, freq, gain] = s[surface] ?? ['bandpass', 1000, 0.5];
    const d = this.dest(at);
    this.noiseHit({ at: d, dur: 0.07, type, freq: freq * (0.85 + Math.random() * 0.3), q: 1.2, gain: gain * loud });
    this.noiseHit({ at: d, dur: 0.05, type: 'lowpass', freq: 250, gain: 0.4 * loud, delay: 0.01 });
  }

  land(at: Pos) { this.noiseHit({ at, dur: 0.12, type: 'lowpass', freq: 400, gain: 0.6 }); }
  /** Dropping to / getting up from prone: cloth and gear rustle, a soft body thud going down. */
  prone(at: Pos, down: boolean) {
    this.noiseHit({ at, dur: down ? 0.3 : 0.22, type: 'bandpass', freq: down ? 900 : 1200, freqEnd: down ? 400 : 700, q: 0.8, gain: 0.22 });
    if (down) this.noiseHit({ at, dur: 0.14, type: 'lowpass', freq: 220, gain: 0.35, delay: 0.18 });
  }
  slide(at: Pos) {
    this.noiseHit({ at, dur: 0.42, type: 'bandpass', freq: 1300, freqEnd: 380, q: 0.6, gain: 0.38 });
    this.noiseHit({ at, dur: 0.12, type: 'lowpass', freq: 280, gain: 0.3 });
  }

  // ---------------------------------------------------------------- utility
  throwSound(at: Pos) { this.noiseHit({ at, dur: 0.2, type: 'bandpass', freq: 1200, freqEnd: 600, q: 1, gain: 0.3 }); }
  bounce(at: Pos) { this.tone({ at, type: 'triangle', freq: 900 + Math.random() * 400, dur: 0.06, gain: 0.2 }); }

  explosion(pos: Pos, big = false) {
    const k = big ? 1.6 : 1;
    const at = this.dest(pos);
    this.noiseHit({ at, dur: 1.4 * k, type: 'lowpass', freq: 1800, freqEnd: 120, gain: 1.8, attack: 0.002 });
    this.tone({ at, type: 'sine', freq: 90, freqEnd: 30, dur: 0.8 * k, gain: 1.4 });
    this.noiseHit({ at, dur: 0.06, type: 'highpass', freq: 1500, gain: 0.9 });
  }

  flashPop(at: Pos) {
    this.noiseHit({ at, dur: 0.5, type: 'highpass', freq: 1200, gain: 1.4, attack: 0.001 });
    this.tone({ at, type: 'sine', freq: 200, freqEnd: 60, dur: 0.3, gain: 0.8 });
  }

  smokePop(at: Pos) {
    this.noiseHit({ at, dur: 0.1, type: 'bandpass', freq: 600, gain: 0.6 });
    this.noiseHit({ at, dur: 3.5, type: 'highpass', freq: 3000, gain: 0.25, attack: 0.2 });
  }

  fireIgnite(at: Pos) {
    this.noiseHit({ at, dur: 0.15, type: 'highpass', freq: 3000, gain: 0.6 });
    this.noiseHit({ at, dur: 2.5, type: 'bandpass', freq: 700, q: 0.5, gain: 0.5, attack: 0.1 });
  }
  fireCrackle(at: Pos) { this.noiseHit({ at, dur: 0.04, type: 'highpass', freq: 2500, gain: 0.25 }); }
  fireOut(at: Pos) { this.noiseHit({ at, dur: 0.8, type: 'highpass', freq: 4000, freqEnd: 1500, gain: 0.4 }); }

  pulse(at: Pos) {
    this.tone({ at, type: 'sine', freq: 1400, freqEnd: 900, dur: 0.35, gain: 0.35 });
    this.tone({ at, type: 'sine', freq: 2100, freqEnd: 1300, dur: 0.25, gain: 0.2, delay: 0.05 });
  }

  /** Flash-bang tinnitus + muffling for the local player. */
  tinnitus(strength: number, duration: number) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setValueAtTime(400 + (1 - strength) * 3000, t);
    this.muffle.frequency.exponentialRampToValueAtTime(20000, t + duration);
    if (this.ringOsc) { try { this.ringOsc.stop(); } catch { /* already stopped */ } }
    const osc = c.createOscillator();
    osc.frequency.value = 3600;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.12 * strength), t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + duration + 0.1);
    this.ringOsc = osc;
  }

  // ---------------------------------------------------------------- gadgets
  gadgetDeploy(at: Pos) {
    this.noiseHit({ at, dur: 0.08, type: 'lowpass', freq: 600, gain: 0.5 });
    this.tone({ at, type: 'square', freq: 1600, dur: 0.05, gain: 0.08, delay: 0.08 });
  }
  ping() {
    this.tone({ at: null, type: 'sine', freq: 1760, dur: 0.08, gain: 0.2, bus: this.ui });
    this.tone({ at: null, type: 'sine', freq: 2640, dur: 0.12, gain: 0.15, delay: 0.07, bus: this.ui });
  }
  camSwitch() { this.noiseHit({ at: null, dur: 0.12, type: 'highpass', freq: 3000, gain: 0.25, bus: this.ui }); }
  deviceDestroyed(at: Pos) {
    this.noiseHit({ at, dur: 0.15, type: 'highpass', freq: 2500, gain: 0.5 });
    this.tone({ at, type: 'sawtooth', freq: 900, freqEnd: 120, dur: 0.25, gain: 0.15 });
  }
  emp(at: Pos) {
    this.tone({ at, type: 'sawtooth', freq: 120, freqEnd: 2400, dur: 0.35, gain: 0.35 });
    this.noiseHit({ at, dur: 0.6, type: 'bandpass', freq: 4000, q: 2, gain: 0.5 });
  }
  mineArmed(at: Pos) { this.tone({ at, type: 'sine', freq: 2400, dur: 0.06, gain: 0.15 }); this.tone({ at, type: 'sine', freq: 2400, dur: 0.06, gain: 0.15, delay: 0.12 }); }
  mineTrip(at: Pos) { this.tone({ at, type: 'square', freq: 3000, dur: 0.25, gain: 0.25 }); }
  wireRattle(at: Pos) {
    for (let i = 0; i < 4; i++) this.noiseHit({ at, dur: 0.04, type: 'bandpass', freq: 3500 + Math.random() * 2000, q: 6, gain: 0.35, delay: i * 0.05 });
  }
  droneHum(at: Pos) { this.tone({ at, type: 'sawtooth', freq: 180 + Math.random() * 20, dur: 0.12, gain: 0.04 }); }

  // ---------------------------------------------------------------- bomb / round
  // ---------------------------------------------------------------- arsenal + killstreaks
  /** Blast scaled by radius: rockets / C4 / hunter drones / cruise missiles. */
  blast(pos: Pos, radius: number) {
    const big = radius >= 7;
    const at = this.dest(pos);
    this.explosion(pos, big);
    this.tone({ at, type: 'sine', freq: 70, freqEnd: 24, dur: 0.9 + radius * 0.05, gain: 0.9 });
    this.noiseHit({ at, dur: 0.6, type: 'highpass', freq: 3000, freqEnd: 800, gain: 0.25, delay: 0.12 }); // debris rattle
  }
  rocketLoop(at: Pos) { this.noiseHit({ at, dur: 0.18, type: 'bandpass', freq: 700, q: 0.8, gain: 0.35 }); }
  stimShot(at: Pos) {
    this.noiseHit({ at, dur: 0.09, type: 'bandpass', freq: 2600, q: 3, gain: 0.35 });
    this.tone({ at, type: 'sine', freq: 520, freqEnd: 260, dur: 0.12, gain: 0.12 });
  }
  stimInject(at: Pos) {
    this.noiseHit({ at, dur: 0.35, type: 'highpass', freq: 5000, freqEnd: 2500, gain: 0.22 });
    this.tone({ at, type: 'sine', freq: 660, dur: 0.12, gain: 0.12, delay: 0.1 });
    this.tone({ at, type: 'sine', freq: 990, dur: 0.18, gain: 0.1, delay: 0.2 });
  }
  meleeSwing(pos: Pos, hit: boolean) {
    const at = this.dest(pos);
    this.noiseHit({ at, dur: 0.18, type: 'bandpass', freq: 2200, freqEnd: 700, q: 1.2, gain: 0.32 });
    if (hit) this.noiseHit({ at, dur: 0.09, type: 'lowpass', freq: 800, gain: 0.7, delay: 0.09 });
  }
  pry(at: Pos) { this.noiseHit({ at, dur: 0.25, type: 'bandpass', freq: 480 + Math.random() * 200, q: 6, gain: 0.3 }); }
  barricadeBreak(at: Pos, metal: boolean) {
    this.noiseHit({ at, dur: 0.5, type: metal ? 'bandpass' : 'lowpass', freq: metal ? 1800 : 900, freqEnd: 200, q: metal ? 3 : 1, gain: 0.8 });
    this.noiseHit({ at, dur: 0.15, type: 'highpass', freq: 2500, gain: 0.3, delay: 0.08 });
  }
  resupply() {
    for (let i = 0; i < 3; i++) this.noiseHit({ at: null, dur: 0.05, type: 'bandpass', freq: 2600 + i * 400, q: 4, gain: 0.3, delay: i * 0.09 });
  }
  /** UI fanfare when a killstreak is earned. */
  streakEarned() {
    [880, 1175, 1480].forEach((f, i) => this.tone({ at: null, type: 'triangle', freq: f, dur: 0.14, gain: 0.16, delay: i * 0.08, bus: this.ui }));
  }
  /** Radio blip when a streak is called in (friendly or enemy). */
  streakCalled(friendly: boolean) {
    this.noiseHit({ at: null, dur: 0.12, type: 'bandpass', freq: 1800, q: 2, gain: 0.25, bus: this.ui });
    this.tone({ at: null, type: 'square', freq: friendly ? 1320 : 440, dur: 0.1, gain: 0.07, delay: 0.14, bus: this.ui });
    this.tone({ at: null, type: 'square', freq: friendly ? 1760 : 330, dur: 0.14, gain: 0.07, delay: 0.26, bus: this.ui });
  }
  uavPing() { this.tone({ at: null, type: 'sine', freq: 1900, freqEnd: 1500, dur: 0.18, gain: 0.05, bus: this.ui }); }
  missileWind() { this.noiseHit({ at: null, dur: 0.3, type: 'bandpass', freq: 500, q: 0.7, gain: 0.25 }); }
  c4Arm(at: Pos) { this.tone({ at, type: 'square', freq: 2800, dur: 0.04, gain: 0.12 }); }

  // ---------------------------------------------------------------- tactical gear + moments
  stunBang(at: Pos) {
    this.noiseHit({ at, dur: 0.5, type: 'lowpass', freq: 2400, freqEnd: 200, gain: 1.3, attack: 0.001 });
    this.tone({ at, type: 'sine', freq: 95, freqEnd: 40, dur: 0.4, gain: 0.7 });
  }
  /** Local player stunned: a muffled wobbling hum. */
  stunned(strength: number, duration: number) {
    this.tone({ at: null, type: 'sine', freq: 180, freqEnd: 120, dur: Math.max(0.6, duration), gain: 0.06 + 0.1 * strength, bus: this.ui, attack: 0.05 });
    this.tone({ at: null, type: 'sine', freq: 187, freqEnd: 125, dur: Math.max(0.6, duration), gain: 0.05 + 0.08 * strength, bus: this.ui, attack: 0.05 });
  }
  mantle(at: Pos) {
    this.noiseHit({ at, dur: 0.12, type: 'bandpass', freq: 900, q: 1.5, gain: 0.35 });
    this.noiseHit({ at, dur: 0.2, type: 'lowpass', freq: 500, gain: 0.35, delay: 0.16 });
  }
  knifeThrow(at: Pos) { this.noiseHit({ at, dur: 0.22, type: 'bandpass', freq: 3200, freqEnd: 1200, q: 2, gain: 0.3 }); }
  knifePickup() { this.tone({ at: null, type: 'triangle', freq: 2600, dur: 0.06, gain: 0.12, bus: this.ui }); this.tone({ at: null, type: 'triangle', freq: 3400, dur: 0.08, gain: 0.1, delay: 0.05, bus: this.ui }); }
  heartbeatBeep(found: boolean) {
    this.tone({ at: null, type: 'sine', freq: 1450, dur: 0.07, gain: 0.07, bus: this.ui });
    if (found) this.tone({ at: null, type: 'sine', freq: 980, dur: 0.12, gain: 0.08, delay: 0.09, bus: this.ui });
  }
  pingSound(enemy: boolean) {
    this.tone({ at: null, type: 'sine', freq: enemy ? 1320 : 990, dur: 0.08, gain: 0.14, bus: this.ui });
    this.tone({ at: null, type: 'sine', freq: enemy ? 1760 : 1320, dur: 0.12, gain: 0.12, delay: 0.07, bus: this.ui });
  }
  /** Multi-kill / clutch stinger: more notes for bigger moments. */
  stinger(level: number) {
    const notes = [523, 659, 784, 1047, 1319, 1568].slice(0, Math.min(6, level + 1));
    notes.forEach((f, i) => this.tone({ at: null, type: 'triangle', freq: f, dur: 0.16, gain: 0.13, delay: i * 0.07, bus: this.ui }));
  }
  /** Low-health heartbeat thump. */
  lowHealth() {
    this.tone({ at: null, type: 'sine', freq: 62, freqEnd: 45, dur: 0.14, gain: 0.32, bus: this.ui });
    this.tone({ at: null, type: 'sine', freq: 58, freqEnd: 42, dur: 0.16, gain: 0.26, delay: 0.2, bus: this.ui });
  }
  killcamWhoosh() {
    this.noiseHit({ at: null, dur: 0.6, type: 'bandpass', freq: 400, freqEnd: 2400, q: 0.8, gain: 0.35, bus: this.ui });
  }

  bombBeep(at: Pos) { this.tone({ at, type: 'sine', freq: 2200, dur: 0.09, gain: 0.5 }); }
  plantKey() { this.tone({ at: null, type: 'square', freq: 1200 + Math.random() * 800, dur: 0.05, gain: 0.08 }); }
  defuseTick(at: Pos) { this.noiseHit({ at, dur: 0.04, type: 'bandpass', freq: 3500, q: 6, gain: 0.3 }); }
  bombPlanted() {
    this.tone({ at: null, type: 'square', freq: 880, dur: 0.12, gain: 0.12, bus: this.ui });
    this.tone({ at: null, type: 'square', freq: 660, dur: 0.2, gain: 0.12, delay: 0.15, bus: this.ui });
  }

  roundStart() {
    this.tone({ at: null, type: 'triangle', freq: 523, dur: 0.15, gain: 0.25, bus: this.ui });
    this.tone({ at: null, type: 'triangle', freq: 784, dur: 0.3, gain: 0.25, delay: 0.15, bus: this.ui });
  }
  roundEnd(win: boolean) {
    const notes = win ? [523, 659, 784, 1047] : [440, 392, 349, 262];
    notes.forEach((f, i) => this.tone({ at: null, type: 'triangle', freq: f, dur: 0.35, gain: 0.22, delay: i * 0.14, bus: this.ui }));
  }
  ui_click() { this.tone({ at: null, type: 'sine', freq: 1200, freqEnd: 800, dur: 0.05, gain: 0.15, bus: this.ui }); }
  ui_hover() { this.tone({ at: null, type: 'sine', freq: 1800, dur: 0.02, gain: 0.05, bus: this.ui }); }
  buy() {
    this.noiseHit({ at: null, dur: 0.05, type: 'bandpass', freq: 3000, q: 4, gain: 0.3, bus: this.ui });
    this.tone({ at: null, type: 'sine', freq: 1500, dur: 0.08, gain: 0.12, delay: 0.04, bus: this.ui });
  }
  denied() { this.tone({ at: null, type: 'square', freq: 220, dur: 0.12, gain: 0.08, bus: this.ui }); }

  // ---------------------------------------------------------------- zombies
  private voiceBudget = 0;
  private voiceAt = 0;
  /** Formant voice: detuned saws through a vowel band-pass, with a pitch glide. */
  private voice(at: Pos, f0: number, f1: number, dur: number, gain: number, formant: number, q = 3, delay = 0) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + delay;
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = formant; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.12, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.out(at));
    for (const det of [0.995, 1.012]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * det, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * det), t + dur);
      o.connect(f); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  /** Limit how many zombie voices start in a short window (a horde would be a wall of noise). */
  private allowVoice(): boolean {
    const c = this.ctx; if (!c) return false;
    const now = c.currentTime;
    if (now - this.voiceAt > 0.5) { this.voiceAt = now; this.voiceBudget = 0; }
    return ++this.voiceBudget <= 4;
  }
  zombieVoice(at: Pos, kind: string, mood: 'groan' | 'growl' | 'death' | 'spit' | 'fuse') {
    if (!this.allowVoice()) return;
    const deep = kind === 'tank' ? 0.45 : kind === 'brute' ? 0.7 : kind === 'bloater' ? 0.8 : kind === 'shrieker' || kind === 'spitter' ? 1.35 : kind === 'runner' ? 1.15 : 1;
    const r = 0.85 + Math.random() * 0.3;
    switch (mood) {
      case 'groan':
        this.voice(at, 115 * deep * r, 82 * deep * r, 0.9 + Math.random() * 0.6, 0.28, 520 * deep + Math.random() * 120, 2.5);
        break;
      case 'growl':
        this.voice(at, 150 * deep * r, 95 * deep * r, 0.45, 0.32, 700 * deep, 2);
        this.noiseHit({ at, dur: 0.4, type: 'bandpass', freq: 380 * deep, q: 1.5, gain: 0.22 });
        break;
      case 'death':
        this.voice(at, 130 * deep * r, 50 * deep, 0.6, 0.3, 480 * deep, 2);
        this.noiseHit({ at, dur: 0.35, type: 'lowpass', freq: 600, freqEnd: 150, gain: 0.25 });
        break;
      case 'spit':
        this.noiseHit({ at, dur: 0.3, type: 'bandpass', freq: 1400, freqEnd: 500, q: 1.2, gain: 0.45 });
        this.voice(at, 260, 160, 0.25, 0.18, 900, 3);
        break;
      case 'fuse':
        for (let i = 0; i < 8; i++) this.tone({ at, type: 'square', freq: 1900, dur: 0.05, gain: 0.22, delay: i * 0.11 * (1 - i * 0.07) });
        break;
    }
  }
  zombieScream(at: Pos) {
    this.voice(at, 620, 980, 1.0, 0.5, 1800, 1.5);
    this.voice(at, 940, 1500, 0.9, 0.35, 2600, 2, 0.05);
    this.noiseHit({ at, dur: 1.0, type: 'highpass', freq: 2600, gain: 0.3, attack: 0.05 });
  }
  zombieRoar(at: Pos) {
    this.voice(at, 70, 44, 1.6, 0.9, 260, 1.2);
    this.voice(at, 104, 66, 1.4, 0.5, 420, 1.5, 0.05);
    this.noiseHit({ at, dur: 1.5, type: 'lowpass', freq: 500, freqEnd: 180, gain: 0.55, attack: 0.08 });
  }
  zombieSwipe(at: Pos, hit: boolean) {
    this.noiseHit({ at, dur: 0.16, type: 'bandpass', freq: 1500, freqEnd: 500, q: 0.8, gain: 0.3 });
    if (hit) this.noiseHit({ at, dur: 0.12, type: 'lowpass', freq: 700, gain: 0.7, delay: 0.05 });
  }
  zombieStep(at: Pos, heavy: boolean) {
    if (heavy) this.noiseHit({ at, dur: 0.22, type: 'lowpass', freq: 160, gain: 0.9 });
    else this.noiseHit({ at, dur: 0.14, type: 'lowpass', freq: 420 + Math.random() * 200, gain: 0.32 });
  }
  zombieRise(at: Pos) {
    this.noiseHit({ at, dur: 0.9, type: 'lowpass', freq: 380, freqEnd: 120, gain: 0.45 });
    for (let i = 0; i < 5; i++) this.noiseHit({ at, dur: 0.05, type: 'bandpass', freq: 1800 + Math.random() * 1500, q: 3, gain: 0.18, delay: 0.1 + i * 0.12 });
  }
  gasBurst(at: Pos) {
    this.noiseHit({ at, dur: 1.4, type: 'lowpass', freq: 900, freqEnd: 220, gain: 0.6, attack: 0.02 });
    this.voice(at, 90, 50, 0.6, 0.25, 300, 1);
  }
  acidSizzle(at: Pos) { this.noiseHit({ at, dur: 1.2, type: 'highpass', freq: 3200, freqEnd: 1800, gain: 0.22, attack: 0.05 }); }
  shockZap(at: Pos) {
    for (let i = 0; i < 6; i++) this.noiseHit({ at, dur: 0.06, type: 'highpass', freq: 3000 + Math.random() * 3000, gain: 0.35, delay: i * 0.04 });
    this.tone({ at, type: 'sawtooth', freq: 120, freqEnd: 60, dur: 0.35, gain: 0.25 });
  }
  disruptorZap(at: Pos) {
    this.tone({ at, type: 'sawtooth', freq: 1800, freqEnd: 300, dur: 0.22, gain: 0.3 });
    this.tone({ at, type: 'sine', freq: 900, freqEnd: 2200, dur: 0.12, gain: 0.25 });
  }
  /** Ominous wave start: low bell + drum hits (frenzy: alarm, boss: horn). */
  waveStart(kind: 'normal' | 'frenzy' | 'boss') {
    const ui = this.ui;
    if (kind === 'frenzy') {
      for (let i = 0; i < 4; i++) { this.tone({ at: null, type: 'square', freq: 660, dur: 0.22, gain: 0.07, delay: i * 0.5, bus: ui }); this.tone({ at: null, type: 'square', freq: 520, dur: 0.22, gain: 0.07, delay: i * 0.5 + 0.25, bus: ui }); }
    }
    if (kind === 'boss') this.voice(null, 65, 58, 2.6, 0.5, 300, 1, 0);
    for (const [f, d] of [[110, 0], [164.8, 0.02], [220, 0.04]] as const) this.tone({ at: null, type: 'sine', freq: f, freqEnd: f * 0.99, dur: 3.2, gain: 0.16, delay: d, bus: ui, attack: 0.01 });
    for (let i = 0; i < 3; i++) this.noiseHit({ at: null, dur: 0.3, type: 'lowpass', freq: 140, gain: 0.7, delay: 0.4 + i * 0.42, bus: ui });
  }
  waveEnd() {
    [[523, 415], [440, 330], [330, 247]].forEach(([a, b], i) => this.tone({ at: null, type: 'triangle', freq: a, freqEnd: b, dur: 1.6, gain: 0.1, delay: i * 0.18, bus: this.ui }));
  }
  purchase() {
    this.tone({ at: null, type: 'triangle', freq: 1568, dur: 0.08, gain: 0.14, bus: this.ui });
    this.tone({ at: null, type: 'triangle', freq: 2093, dur: 0.16, gain: 0.14, delay: 0.07, bus: this.ui });
    this.noiseHit({ at: null, dur: 0.12, type: 'highpass', freq: 5000, gain: 0.12, delay: 0.05, bus: this.ui });
  }
  doorOpen(at: Pos) {
    for (let i = 0; i < 9; i++) this.noiseHit({ at, dur: 0.07, type: 'bandpass', freq: 900 + (i % 3) * 200, q: 3, gain: 0.35, delay: i * 0.09 });
    this.noiseHit({ at, dur: 0.6, type: 'lowpass', freq: 300, gain: 0.5, delay: 0.85 });
  }
  powerOn() {
    this.tone({ at: null, type: 'sawtooth', freq: 40, freqEnd: 120, dur: 2.5, gain: 0.2, bus: this.ui, attack: 1.2 });
    this.tone({ at: null, type: 'sine', freq: 60, dur: 3.5, gain: 0.25, bus: this.ui, attack: 0.8, delay: 0.5 });
    for (let i = 0; i < 10; i++) this.noiseHit({ at: null, dur: 0.05, type: 'highpass', freq: 4000, gain: 0.2, delay: 0.2 + Math.random() * 1.8, bus: this.ui });
    this.noiseHit({ at: null, dur: 0.5, type: 'lowpass', freq: 200, gain: 0.8, delay: 2.4, bus: this.ui });
  }
  /** Perk machine jingle (each perk starts on its own note). */
  perkJingle(seed: number) {
    const base = [262, 294, 330, 349, 392, 440, 494, 523][seed % 8];
    [1, 1.25, 1.5, 2, 1.5, 2].forEach((m, i) => this.tone({ at: null, type: 'triangle', freq: base * m, dur: 0.18, gain: 0.12, delay: i * 0.13, bus: this.ui }));
    this.tone({ at: null, type: 'sine', freq: base / 2, dur: 0.9, gain: 0.1, delay: 0.1, bus: this.ui });
  }
  /** Mystery Box music-box tune while it spins. */
  boxSpin(at: Pos, seconds: number) {
    const notes = [659, 784, 988, 784, 659, 523, 587, 659, 784, 659, 523, 494];
    const n = Math.floor(seconds / 0.32);
    for (let i = 0; i < n; i++) this.tone({ at, type: 'sine', freq: notes[i % notes.length] * 2, dur: 0.3, gain: 0.16, delay: i * 0.32, attack: 0.003 });
  }
  boxReady(at: Pos) { this.tone({ at, type: 'triangle', freq: 1047, dur: 0.4, gain: 0.2 }); this.tone({ at, type: 'triangle', freq: 1568, dur: 0.6, gain: 0.18, delay: 0.12 }); }
  boxTeddy(at: Pos) {
    [392, 370, 349, 330].forEach((f, i) => this.voice(at, f, f * 0.92, 0.22, 0.25, 900, 4, i * 0.2));
  }
  forgeWork(at: Pos) {
    this.tone({ at, type: 'sawtooth', freq: 80, freqEnd: 160, dur: 3.4, gain: 0.18, attack: 0.3 });
    for (let i = 0; i < 6; i++) this.noiseHit({ at, dur: 0.12, type: 'bandpass', freq: 600, q: 2, gain: 0.4, delay: 0.4 + i * 0.5 });
    this.tone({ at, type: 'triangle', freq: 880, freqEnd: 1760, dur: 0.6, gain: 0.15, delay: 3.2 });
  }
  powerUpDrop(at: Pos) { [1320, 1760, 2093].forEach((f, i) => this.tone({ at, type: 'sine', freq: f, dur: 0.25, gain: 0.18, delay: i * 0.06 })); }
  powerUpGrab() {
    [523, 784, 1047, 1568].forEach((f, i) => this.tone({ at: null, type: 'triangle', freq: f, dur: 0.22, gain: 0.16, delay: i * 0.05, bus: this.ui }));
    this.noiseHit({ at: null, dur: 0.5, type: 'highpass', freq: 6000, gain: 0.12, bus: this.ui });
  }
  powerUpEnd() { this.tone({ at: null, type: 'triangle', freq: 784, freqEnd: 392, dur: 0.5, gain: 0.12, bus: this.ui }); }
  nukeFlash() {
    this.noiseHit({ at: null, dur: 2.2, type: 'lowpass', freq: 600, freqEnd: 60, gain: 1.0, bus: this.ui });
    this.tone({ at: null, type: 'sine', freq: 200, freqEnd: 2400, dur: 1.4, gain: 0.12, bus: this.ui });
  }
  downed() {
    this.tone({ at: null, type: 'sine', freq: 70, freqEnd: 40, dur: 1.2, gain: 0.5, bus: this.ui });
    this.setMuffle(true);
  }
  revived() {
    this.setMuffle(false);
    [392, 494, 587, 784].forEach((f, i) => this.tone({ at: null, type: 'triangle', freq: f, dur: 0.4, gain: 0.12, delay: i * 0.07, bus: this.ui }));
  }
  /** Muffle the world (downed / bleeding out). */
  setMuffle(on: boolean) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setValueAtTime(Math.max(20, this.muffle.frequency.value), t);
    this.muffle.frequency.exponentialRampToValueAtTime(on ? 700 : 20000, t + (on ? 0.4 : 0.8));
  }
  radio() {
    this.noiseHit({ at: null, dur: 0.8, type: 'bandpass', freq: 1800, q: 0.6, gain: 0.25, bus: this.ui });
    [1200, 1200, 1600].forEach((f, i) => this.tone({ at: null, type: 'square', freq: f, dur: 0.08, gain: 0.06, delay: 0.9 + i * 0.16, bus: this.ui }));
  }
  rotor(at: Pos) { this.noiseHit({ at, dur: 0.09, type: 'lowpass', freq: 220, gain: 0.7 }); }
}

export const sfx = new Sfx();
