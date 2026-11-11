import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import { Random } from '../core/Random';

/**
 * Every texture in the game is painted procedurally on a canvas at startup.
 * `worldSize` = meters covered by one texture repeat (used to compute UVs).
 */
export interface TexInfo { tex: Texture; worldW: number; worldH: number; surface?: { normal: Texture; roughness: Texture } }

type Painter = (g: CanvasRenderingContext2D, w: number, h: number, r: Random) => void;

const cache = new Map<string, TexInfo>();
let maxAniso = 4;
export function setMaxAnisotropy(n: number) { maxAniso = n; }

/** CC0 scans are bundled with the game; play never requires an external asset service. */
export function scannedSurface(id: 'concrete_floor' | 'corrugated_iron' | 'red_brick_03'): TexInfo {
  const key = 'scan:' + id;
  const cached = cache.get(key);
  if (cached) return cached;
  const loader = new TextureLoader();
  const texture = (map: string, color = false) => {
    const t = loader.load(`${import.meta.env.BASE_URL}textures/surfaces/${id}_${map}_1k.jpg`);
    t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = maxAniso;
    return t;
  };
  const size = id === 'concrete_floor' ? 2.1 : id === 'corrugated_iron' ? 1.12 : 1;
  const info: TexInfo = { tex: texture('diff', true), worldW: size, worldH: size,
    surface: { normal: texture('nor_gl'), roughness: texture('rough') } };
  cache.set(key, info);
  return info;
}

function make(key: string, size: number | [number, number], worldW: number, worldH: number, paint: Painter, seed = 1): TexInfo {
  const hit = cache.get(key);
  if (hit) return hit;
  const [w, h] = Array.isArray(size) ? size : [size, size];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  paint(g, w, h, new Random(seed * 9973 + key.length));
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = maxAniso;
  tex.minFilter = LinearMipmapLinearFilter;
  const info = { tex, worldW, worldH };
  cache.set(key, info);
  return info;
}

// ---------------------------------------------------------------- helpers
function speckle(g: CanvasRenderingContext2D, w: number, h: number, r: Random, n: number, color: string, alpha: number, size = 1) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * r.next();
    g.fillRect(r.next() * w, r.next() * h, size, size);
  }
  g.globalAlpha = 1;
}
function blotches(g: CanvasRenderingContext2D, w: number, h: number, r: Random, n: number, color: string, alpha: number, rad: number) {
  for (let i = 0; i < n; i++) {
    const x = r.next() * w, y = r.next() * h, rr = rad * (0.4 + r.next());
    const grd = g.createRadialGradient(x, y, 0, x, y, rr);
    grd.addColorStop(0, color); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = alpha * r.next();
    g.fillStyle = grd;
    g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  g.globalAlpha = 1;
}
function grid(g: CanvasRenderingContext2D, w: number, h: number, cell: number, color: string, lw = 1, alpha = 1) {
  g.strokeStyle = color; g.lineWidth = lw; g.globalAlpha = alpha;
  g.beginPath();
  for (let x = 0; x <= w; x += cell) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); }
  for (let y = 0; y <= h; y += cell) { g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); }
  g.stroke(); g.globalAlpha = 1;
}
const fill = (g: CanvasRenderingContext2D, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(0, 0, w, h); };

// ---------------------------------------------------------------- floors
export const TEX = {
  carpet: () => make('carpet', 512, 2, 2, (g, w, h, r) => {
    fill(g, w, h, '#545c6a');
    speckle(g, w, h, r, 26000, '#2e343e', 0.6);
    speckle(g, w, h, r, 12000, '#7a8494', 0.5);
    grid(g, w, h, 256, '#3c434e', 2, 0.6);
    blotches(g, w, h, r, 8, 'rgba(30,34,40,1)', 0.15, 90);
  }),
  confCarpet: () => make('confCarpet', 512, 2, 2, (g, w, h, r) => {
    fill(g, w, h, '#5c3036');
    speckle(g, w, h, r, 26000, '#3a1c22', 0.6);
    speckle(g, w, h, r, 9000, '#84505a', 0.5);
    for (let y = 0; y < h; y += 16) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, y, w, 8); }
  }),
  marble: () => make('marble', 512, 4, 4, (g, w, h, r) => {
    fill(g, w, h, '#d6d1c7');
    blotches(g, w, h, r, 30, 'rgba(190,184,172,1)', 0.5, 80);
    g.strokeStyle = 'rgba(120,115,108,0.35)';
    for (let i = 0; i < 14; i++) {
      g.lineWidth = 0.6 + r.next() * 1.4;
      g.beginPath();
      let x = r.next() * w, y = r.next() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += r.range(-80, 80); y += r.range(-80, 80); g.lineTo(x, y); }
      g.stroke();
    }
    grid(g, w, h, 128, 'rgba(90,86,80,0.6)', 2);
  }),
  tile: () => make('tile', 512, 2.4, 2.4, (g, w, h, r) => {
    const n = 4, s = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = 196 + r.int(-8, 8);
      g.fillStyle = `rgb(${v},${v - 3},${v - 10})`;
      g.fillRect(i * s, j * s, s, s);
    }
    speckle(g, w, h, r, 9000, '#8a8578', 0.35, 2);
    speckle(g, w, h, r, 2000, '#5a6a80', 0.25, 2);
    grid(g, w, h, s, '#8d897e', 2);
  }),
  checker: () => make('checker', 256, 1, 1, (g, w, h, r) => {
    const s = w / 2;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#2b2c2e' : '#dcd9d0'; g.fillRect(i * s, j * s, s, s); }
    speckle(g, w, h, r, 3000, '#777', 0.25, 1);
    grid(g, w, h, s, 'rgba(0,0,0,0.35)', 1);
  }),
  serverFloor: () => make('serverFloor', 256, 1.2, 1.2, (g, w, h, r) => {
    fill(g, w, h, '#9fa3a6');
    const s = w / 2;
    g.fillStyle = 'rgba(40,44,48,0.55)';
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0)
      for (let x = 10; x < s - 6; x += 9) for (let y = 10; y < s - 6; y += 9) g.fillRect(i * s + x, j * s + y, 3, 3);
    speckle(g, w, h, r, 2000, '#555', 0.3);
    grid(g, w, h, s, '#55595c', 3);
  }),
  lino: () => make('lino', 512, 3, 3, (g, w, h, r) => {
    fill(g, w, h, '#8e978c');
    speckle(g, w, h, r, 30000, '#6a7268', 0.6, 2);
    speckle(g, w, h, r, 15000, '#b8c0b4', 0.5, 2);
    grid(g, w, h, 256, 'rgba(60,64,58,0.45)', 2);
  }),
  /** Wood-look luxury vinyl plank: 0.18 x 1.2 m staggered planks in a warm grey oak. */
  lvt: () => make('lvt', 512, 2.4, 2.4, (g, w, h, r) => {
    const rows = 13, ph = h / rows, pl = w / 2;
    for (let j = 0; j < rows; j++) {
      const off = ((j * 0.37) % 1) * pl;
      for (let k = -1; k < 3; k++) {
        const x = k * pl + off;
        const v = r.int(-14, 12);
        g.fillStyle = `rgb(${168 + v},${150 + v},${124 + v})`;
        g.fillRect(x, j * ph, pl, ph);
        // grain: long faint streaks and a couple of knots per plank
        for (let s = 0; s < 9; s++) {
          g.fillStyle = `rgba(92,70,46,${0.05 + r.next() * 0.1})`;
          g.fillRect(x + r.next() * pl * 0.2, j * ph + r.next() * ph, pl * r.range(0.4, 0.95), 1);
        }
        if (r.chance(0.35)) { g.fillStyle = 'rgba(96,72,48,0.22)'; g.beginPath(); g.ellipse(x + r.range(20, pl - 20), j * ph + ph / 2, 6, 2.5, 0, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = 'rgba(58,44,30,0.55)'; g.fillRect(x, j * ph, 2, ph);
      }
      g.fillStyle = 'rgba(58,44,30,0.5)'; g.fillRect(0, j * ph, w, 1.5);
    }
    speckle(g, w, h, r, 4000, '#6e5a42', 0.12);
  }),
  /** Static-dissipative (ESD) vinyl tile: 0.6 m squares, grey with dark conductive veining. */
  esd: () => make('esd', 512, 1.2, 1.2, (g, w, h, r) => {
    const s = w / 2;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const v = r.int(-6, 6);
      g.fillStyle = `rgb(${134 + v},${140 + v},${148 + v})`;
      g.fillRect(i * s, j * s, s, s);
      g.save(); g.beginPath(); g.rect(i * s, j * s, s, s); g.clip();
      g.strokeStyle = 'rgba(32,36,42,0.55)';
      for (let k = 0; k < 16; k++) {
        g.lineWidth = 0.6 + r.next() * 1.2;
        g.beginPath();
        let x = i * s + r.next() * s, y = j * s + r.next() * s;
        g.moveTo(x, y);
        const a = r.range(0, Math.PI);
        for (let q = 0; q < 5; q++) { x += Math.cos(a) * r.range(10, 30) + r.range(-8, 8); y += Math.sin(a) * r.range(10, 30) + r.range(-8, 8); g.lineTo(x, y); }
        g.stroke();
      }
      g.restore();
    }
    speckle(g, w, h, r, 9000, '#3d434b', 0.35);
    speckle(g, w, h, r, 4000, '#c3cad3', 0.25);
    grid(g, w, h, s, 'rgba(48,52,58,0.7)', 2);
  }),
  /** Restroom porcelain: 0.3 m light-grey squares with grout lines. */
  porcelain: () => make('porcelain', 512, 1.2, 1.2, (g, w, h, r) => {
    const n = 4, s = w / n;
    fill(g, w, h, '#a2a49f');
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = r.int(-5, 5);
      g.fillStyle = `rgb(${214 + v},${215 + v},${211 + v})`;
      g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
    }
    speckle(g, w, h, r, 7000, '#9a9c97', 0.3);
    blotches(g, w, h, r, 10, 'rgba(255,255,255,1)', 0.06, 40);
  }),
  concrete: () => make('concrete', 512, 4, 4, (g, w, h, r) => {
    fill(g, w, h, '#8a8781');
    blotches(g, w, h, r, 65, 'rgba(70,68,62,1)', 0.09, 105);
    blotches(g, w, h, r, 45, 'rgba(160,156,148,1)', 0.12, 80);
    speckle(g, w, h, r, 20000, '#5e5b55', 0.4);
    g.strokeStyle = 'rgba(50,48,44,0.23)'; g.lineWidth = 0.7;
    for (let i = 0; i < 4; i++) {
      g.beginPath(); let x = r.next() * w, y = r.next() * h; g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += r.range(-25, 25); y += r.range(-25, 25); g.lineTo(x, y); }
      g.stroke();
    }
    grid(g, w, h, 512, 'rgba(40,38,34,0.4)', 2);
  }),
  warehouse: () => make('warehouse', 512, 4, 4, (g, w, h, r) => {
    fill(g, w, h, '#9b968b');
    blotches(g, w, h, r, 45, 'rgba(110,106,96,1)', 0.1, 100);
    blotches(g, w, h, r, 8, 'rgba(40,38,32,1)', 0.07, 60);
    speckle(g, w, h, r, 12000, '#6d6a62', 0.3);
    grid(g, w, h, 512, 'rgba(50,48,42,0.6)', 3);
  }),
  asphalt: () => make('asphalt', 512, 4, 4, (g, w, h, r) => {
    fill(g, w, h, '#3b3c3e');
    speckle(g, w, h, r, 40000, '#232425', 0.8, 2);
    speckle(g, w, h, r, 20000, '#6a6b6c', 0.6, 1);
    blotches(g, w, h, r, 12, 'rgba(20,20,22,1)', 0.25, 90);
  }),

  // ---------------------------------------------------------------- walls (worldH = designed wall height)
  officeWall: () => make('officeWall', [256, 512], 2, 3.4, (g, w, h, r) => {
    fill(g, w, h, '#cfcac0');
    speckle(g, w, h, r, 8000, '#b8b3a8', 0.4);
    blotches(g, w, h, r, 6, 'rgba(160,155,145,1)', 0.15, 60);
    const base = h * (1 - 0.12 / 3.4);
    g.fillStyle = '#3b3c40'; g.fillRect(0, base, w, h - base);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, base - 3, w, 3);
    const rail = h * (1 - 1.0 / 3.4);
    g.fillStyle = '#a49e92'; g.fillRect(0, rail, w, 6);
  }),
  lobbyWall: () => make('lobbyWall', [256, 512], 2, 6, (g, w, h, r) => {
    fill(g, w, h, '#e2ddd2');
    speckle(g, w, h, r, 6000, '#c9c3b6', 0.4);
    const panel = h * (1 - 1.3 / 6);
    const grd = g.createLinearGradient(0, panel, 0, h);
    grd.addColorStop(0, '#7a4e2c'); grd.addColorStop(1, '#5a3820');
    g.fillStyle = grd; g.fillRect(0, panel, w, h - panel);
    g.strokeStyle = 'rgba(30,18,8,0.5)'; g.lineWidth = 2;
    for (let x = 0; x < w; x += 64) { g.beginPath(); g.moveTo(x, panel); g.lineTo(x, h); g.stroke(); }
    for (let i = 0; i < 60; i++) { g.globalAlpha = 0.15; g.fillStyle = '#2a1608'; g.fillRect(r.next() * w, panel + r.next() * (h - panel), r.range(10, 60), 1); }
    g.globalAlpha = 1;
    g.fillStyle = '#c8a050'; g.fillRect(0, panel - 4, w, 4);
  }),
  factoryWall: () => make('factoryWall', [256, 1024], 2, 9, (g, w, h, r) => {
    // upper: ribbed metal cladding
    const lowerTop = h * (1 - 1.6 / 9);
    fill(g, w, h, '#818b91');
    for (let x = 0; x < w; x += 32) {
      const grd = g.createLinearGradient(x, 0, x + 32, 0);
      grd.addColorStop(0, '#737d83'); grd.addColorStop(0.12, '#929b9e'); grd.addColorStop(0.2, '#8a9396'); grd.addColorStop(0.88, '#8a9396'); grd.addColorStop(1, '#737d83');
      g.fillStyle = grd; g.fillRect(x, 0, 32, lowerTop);
    }
    blotches(g, w, lowerTop, r, 10, 'rgba(90,70,50,1)', 0.08, 40);
    for (let y = 32; y < lowerTop; y += 160) for (let x = 5; x < w; x += 32) {
      g.fillStyle = '#596064'; g.fillRect(x, y, 3, 3);
      g.fillStyle = '#bcc2bf'; g.fillRect(x, y, 2, 1);
    }
    // hazard stripe band
    const bandH = 18;
    g.save(); g.beginPath(); g.rect(0, lowerTop - bandH, w, bandH); g.clip();
    g.fillStyle = '#b6a04d'; g.fillRect(0, lowerTop - bandH, w, bandH);
    g.fillStyle = '#1a1a1a';
    for (let x = -bandH; x < w + bandH; x += 32) { g.beginPath(); g.moveTo(x, lowerTop); g.lineTo(x + 16, lowerTop); g.lineTo(x + 16 + bandH, lowerTop - bandH); g.lineTo(x + bandH, lowerTop - bandH); g.fill(); }
    g.restore();
    // lower: concrete block
    g.fillStyle = '#8a8884'; g.fillRect(0, lowerTop, w, h - lowerTop);
    speckle(g, w, h - lowerTop, r, 4000, '#6a6864', 0.4);
    g.strokeStyle = '#5c5a56'; g.lineWidth = 2;
    const bh = (h - lowerTop) / 8;
    for (let i = 0; i <= 8; i++) {
      const y = lowerTop + i * bh;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      for (let x = (i % 2) * 64; x < w; x += 128) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + bh); g.stroke(); }
    }
  }),
  exteriorWall: () => make('exteriorWall', [512, 1024], 4, 6, (g, w, h, r) => {
    fill(g, w, h, '#7d4a38');
    const bh = 14, bw = 44;
    for (let row = 0; row * bh < h; row++) {
      for (let x = -(row % 2) * bw / 2; x < w; x += bw) {
        const v = r.int(-14, 14);
        g.fillStyle = `rgb(${125 + v},${74 + v / 2},${56 + v / 2})`;
        g.fillRect(x + 1, row * bh + 1, bw - 2, bh - 2);
      }
    }
    const band = h * (1 - 0.8 / 6);
    g.fillStyle = '#8c8a84'; g.fillRect(0, band, w, h - band);
    speckle(g, w, h, r, 10000, '#3a2a20', 0.3);
  }),

  // ---------------------------------------------------------------- ceilings
  dropCeiling: () => make('dropCeiling', 256, 1.2, 1.2, (g, w, h, r) => {
    fill(g, w, h, '#e4e2dc');
    speckle(g, w, h, r, 5000, '#b8b5ad', 0.5, 1);
    grid(g, w, h, 128, '#9a978f', 3);
  }),
  plaster: () => make('plaster', 256, 4, 4, (g, w, h, r) => {
    fill(g, w, h, '#ecebe6');
    blotches(g, w, h, r, 10, 'rgba(200,198,190,1)', 0.3, 60);
  }),
  metalDeck: () => make('metalDeck', 256, 2, 2, (g, w, h, r) => {
    fill(g, w, h, '#4c535a');
    for (let x = 0; x < w; x += 32) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x, 0, 10, h); }
    speckle(g, w, h, r, 3000, '#2a2e32', 0.3);
  }),

  // ---------------------------------------------------------------- prop materials
  wood: () => make('wood', 256, 1, 1, (g, w, h, r) => {
    fill(g, w, h, '#a87a4a');
    for (let y = 0; y < h; y += 2) { g.fillStyle = `rgba(80,48,20,${0.05 + r.next() * 0.12})`; g.fillRect(0, y, w, 1 + r.next() * 2); }
    blotches(g, w, h, r, 6, 'rgba(90,55,25,1)', 0.25, 30);
  }),
  darkWood: () => make('darkWood', 256, 1, 1, (g, w, h, r) => {
    fill(g, w, h, '#4e3220');
    for (let y = 0; y < h; y += 2) { g.fillStyle = `rgba(20,10,4,${0.08 + r.next() * 0.15})`; g.fillRect(0, y, w, 1 + r.next() * 2); }
  }),
  crate: () => make('crate', 256, 1.2, 1.2, (g, w, h, r) => {
    fill(g, w, h, '#b08a58');
    for (let y = 0; y < h; y += 32) { g.fillStyle = 'rgba(70,45,20,0.6)'; g.fillRect(0, y, w, 2); }
    for (let y = 0; y < h; y += 3) { g.fillStyle = `rgba(90,60,30,${r.next() * 0.12})`; g.fillRect(0, y, w, 1); }
    g.strokeStyle = '#6e5230'; g.lineWidth = 18; g.strokeRect(9, 9, w - 18, h - 18);
    g.lineWidth = 14; g.beginPath(); g.moveTo(18, 18); g.lineTo(w - 18, h - 18); g.stroke();
    g.fillStyle = 'rgba(30,30,30,0.6)'; g.font = 'bold 22px monospace'; g.fillText('ACI-MFG', 70, h / 2 + 40);
  }),
  cardboard: () => make('cardboard', 256, 0.8, 0.8, (g, w, h, r) => {
    fill(g, w, h, '#b48c5c');
    speckle(g, w, h, r, 3000, '#8a6a40', 0.4);
    g.fillStyle = '#c8a878'; g.fillRect(w / 2 - 20, 0, 40, h);
    g.fillStyle = 'rgba(40,30,20,0.7)'; g.font = 'bold 18px sans-serif'; g.fillText('THIS SIDE UP ↑', 20, 60);
  }),
  fabric: () => make('fabric', 128, 0.6, 0.6, (g, w, h, r) => {
    fill(g, w, h, '#69717c');
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { g.fillStyle = `rgba(0,0,0,${r.next() * 0.12})`; g.fillRect(x, y, 1, 1); }
  }),
  cloth: () => make('uniform-cloth', 256, 0.4, 0.4, (g, w, h, r) => {
    fill(g, w, h, '#e1dfd8');
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      g.fillStyle = `rgba(50,48,44,${0.06 + r.next() * 0.12})`;
      g.fillRect(x, y, 1, 2);
    }
    blotches(g, w, h, r, 18, 'rgba(80,76,65,1)', 0.06, 25);
  }),
  metal: () => make('metal', 256, 1, 1, (g, w, h, r) => {
    fill(g, w, h, '#b9bec4');
    for (let y = 0; y < h; y++) { g.fillStyle = `rgba(255,255,255,${r.next() * 0.08})`; g.fillRect(0, y, w, 1); }
    blotches(g, w, h, r, 6, 'rgba(90,90,90,1)', 0.12, 50);
  }),
  painted: () => make('painted', 256, 1.5, 1.5, (g, w, h, r) => {
    fill(g, w, h, '#ffffff');
    speckle(g, w, h, r, 4000, '#c8c8c8', 0.3);
    blotches(g, w, h, r, 8, 'rgba(120,110,100,1)', 0.035, 40);
  }),
  serverFront: () => make('serverFront', [256, 512], 0.7, 2.2, (g, w, h, r) => {
    fill(g, w, h, '#1b1e22');
    for (let y = 16; y < h - 16; y += 22) {
      g.fillStyle = '#2a2f36'; g.fillRect(10, y, w - 20, 18);
      for (let k = 0; k < 4; k++) { g.fillStyle = r.chance(0.7) ? (r.chance(0.8) ? '#30ff70' : '#ffb020') : '#203020'; g.fillRect(20 + k * 8, y + 7, 4, 4); }
      g.fillStyle = '#111'; for (let x = 70; x < w - 20; x += 6) g.fillRect(x, y + 4, 3, 10);
    }
  }),
  screen: () => make('screen', 128, 1, 1, (g, w, h, r) => {
    const grd = g.createLinearGradient(0, 0, w, h); grd.addColorStop(0, '#1d3c66'); grd.addColorStop(1, '#0a1626');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(160,210,255,0.5)';
    for (let i = 0; i < 9; i++) g.fillRect(10, 12 + i * 12, r.range(30, 100), 4);
  }),
  machineBadge: () => make('machine-badge', [512, 128], 0.62, 0.16, (g, w, h) => {
    fill(g, w, h, '#26343b');
    g.fillStyle = '#c1c9bd'; g.font = 'bold 42px sans-serif'; g.fillText('ACI TEST SYSTEMS', 22, 53);
    g.fillStyle = '#8caaa9'; g.font = '20px monospace'; g.fillText('ENV-750  /  -40 TO +85 C', 24, 97);
    g.fillStyle = '#b99656'; g.fillRect(0, h - 8, w, 8);
  }),
  /** Regulatory plate on the radar speed trailer (one texture repeat = the 0.6 x 0.72 m plate). */
  speedLimit: () => make('label-speed-limit', [256, 308], 0.6, 0.72, (g, w, h) => {
    fill(g, w, h, '#f3f3ee');
    g.strokeStyle = '#151515'; g.lineWidth = 9; g.strokeRect(12, 12, w - 24, h - 24);
    g.fillStyle = '#151515'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 52px Arial, sans-serif'; g.fillText('SPEED', w / 2, 62); g.fillText('LIMIT', w / 2, 118);
    g.font = 'bold 140px Arial, sans-serif'; g.fillText('30', w / 2, 220);
  }),
  /** Door placard on the RF test chamber (0.9 x 0.36 m). */
  rfPlacard: () => make('label-rf', [512, 204], 0.9, 0.36, (g, w, h) => {
    fill(g, w, h, '#efc02c');
    g.strokeStyle = '#151515'; g.lineWidth = 10; g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = '#151515'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 54px Arial, sans-serif'; g.fillText('RF TEST CHAMBER', w / 2, 72);
    g.font = 'bold 28px Arial, sans-serif'; g.fillText('KEEP DOOR CLOSED DURING TEST', w / 2, 140);
  }),
  /** Knotted netting (pitching backstop): dark cord on a transparent ground, 5 cm mesh. */
  net: () => make('net', 128, 0.4, 0.4, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(38,40,44,1)'; g.lineWidth = 2;
    for (let i = 0; i <= w; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke();
    }
  }),
  hazard: () => make('hazard', 128, 0.5, 0.5, (g, w, h) => {
    fill(g, w, h, '#e8b818');
    g.fillStyle = '#151515';
    for (let x = -h; x < w + h; x += 64) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 32, h); g.lineTo(x + 32 + h, 0); g.lineTo(x + h, 0); g.fill(); }
  }),
  sky: () => make('sky', [16, 256], 1, 1, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#4b77b5'); grd.addColorStop(0.55, '#9fc0e0'); grd.addColorStop(1, '#e8dcc8');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }),
};

const detailMaps = new WeakMap<Texture, { normal: Texture; roughness: Texture }>();

/** Derive seamless micro-normal / roughness variation from the same authored surface. */
export function surfaceDetail(info: TexInfo) {
  if (info.surface) return info.surface;
  const cached = detailMaps.get(info.tex);
  if (cached) return cached;
  const source = info.tex.image as HTMLCanvasElement;
  const w = source.width, h = source.height;
  const pixels = source.getContext('2d')!.getImageData(0, 0, w, h).data;
  const n = document.createElement('canvas'), r = document.createElement('canvas');
  n.width = r.width = w; n.height = r.height = h;
  const ng = n.getContext('2d')!, rg = r.getContext('2d')!;
  const ni = ng.createImageData(w, h), ri = rg.createImageData(w, h);
  const luminance = (x: number, y: number) => {
    const i = (((y + h) % h) * w + (x + w) % w) * 4;
    return (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const dx = (luminance(x - 1, y) - luminance(x + 1, y)) * 1.5;
    const dy = (luminance(x, y - 1) - luminance(x, y + 1)) * 1.5;
    const len = Math.hypot(dx, dy, 1);
    ni.data.set([(dx / len * 0.5 + 0.5) * 255, (dy / len * 0.5 + 0.5) * 255, (1 / len * 0.5 + 0.5) * 255, 255], i);
    const rough = 200 + (1 - luminance(x, y)) * 55;
    ri.data.set([rough, rough, rough, 255], i);
  }
  ng.putImageData(ni, 0, 0); rg.putImageData(ri, 0, 0);
  const texture = (canvas: HTMLCanvasElement) => {
    const t = new CanvasTexture(canvas); t.colorSpace = NoColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping; t.anisotropy = maxAniso; return t;
  };
  const result = { normal: texture(n), roughness: texture(r) };
  detailMaps.set(info.tex, result); return result;
}

/** Soft contact shadow, deliberately separate from smoke's irregular sprite. */
export function contactShadow(): Texture {
  return make('contact-shadow', 64, 1, 1, (g, w, h) => {
    const gradient = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, w, h);
  }).tex;
}

/** Large painted floor letter for bombsites. */
export function siteDecal(letter: string): Texture {
  return make('site' + letter, 512, 1, 1, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(220,40,30,0.85)';
    g.font = `bold ${h * 0.82}px Impact, Arial Black, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, w / 2, h / 2 + h * 0.04);
    g.globalCompositeOperation = 'destination-out';
    const r = new Random(letter.charCodeAt(0));
    for (let i = 0; i < 400; i++) { g.globalAlpha = r.next() * 0.5; g.fillRect(r.next() * w, r.next() * h, 3 + r.next() * 8, 2); }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }).tex;
}

/** Text sign texture. */
/** Sign face. Size the canvas to the sign's aspect (see `signCanvas`) so lettering is not stretched; long text shrinks to fit. */
export function signTexture(text: string, bg: string, fg: string, w = 512, h = 128): Texture {
  return make(`sign:${text}:${bg}:${fg}:${w}x${h}`, [w, h], 1, 1, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    const font = (px: number) => `bold ${px}px "Segoe UI", Arial, sans-serif`;
    let px = Math.floor(h * 0.55);
    g.font = font(px);
    const width = g.measureText(text).width, room = w * 0.9;
    if (width > room) { px = Math.max(8, Math.floor(px * room / width)); g.font = font(px); }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  }).tex;
}

/** Canvas size (px) for a sign plane of `w` × `h` metres: 512 px wide, height from the aspect. */
export function signCanvas(w: number, h: number): [number, number] {
  return [512, Math.max(32, Math.min(1024, Math.round(512 * h / w)))];
}

/** Soft round sprite for smoke / particles. */
export function softSprite(): Texture {
  return make('soft', 128, 1, 1, (g, w, h, r) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 18; i++) {
      const x = w / 2 + r.range(-18, 18), y = h / 2 + r.range(-18, 18), rad = r.range(25, 50);
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }
  }).tex;
}

export function flareSprite(): Texture {
  return make('flare', 64, 1, 1, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,240,1)'); grd.addColorStop(0.25, 'rgba(255,220,140,0.8)'); grd.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }).tex;
}

/** Bullet hole decal. */
export function bulletHole(): Texture {
  return make('hole', 64, 1, 1, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(0.25, 'rgba(20,18,16,0.95)'); grd.addColorStop(0.5, 'rgba(60,55,50,0.4)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }).tex;
}

/** Scorch mark left on the floor by an explosion: a burnt core with soot streaks thrown outward. */
export function scorchMark(): Texture {
  return make('scorch', 128, 1, 1, (g, w, h, r) => {
    g.clearRect(0, 0, w, h);
    const core = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    core.addColorStop(0, 'rgba(8,7,6,0.92)'); core.addColorStop(0.3, 'rgba(14,12,10,0.8)');
    core.addColorStop(0.62, 'rgba(24,20,17,0.36)'); core.addColorStop(1, 'rgba(30,26,22,0)');
    g.fillStyle = core; g.fillRect(0, 0, w, h);
    g.lineCap = 'round';
    for (let i = 0; i < 64; i++) {
      const ang = r.range(0, Math.PI * 2), d0 = r.range(0.06, 0.2) * w, d1 = r.range(0.24, 0.46) * w;
      g.strokeStyle = `rgba(10,9,8,${r.range(0.06, 0.24).toFixed(2)})`;
      g.lineWidth = r.range(1, 3.2);
      g.beginPath(); g.moveTo(w / 2 + Math.cos(ang) * d0, h / 2 + Math.sin(ang) * d0);
      g.lineTo(w / 2 + Math.cos(ang) * d1, h / 2 + Math.sin(ang) * d1); g.stroke();
    }
  }).tex;
}

/** Blood splatter decal: a dark core with droplets flung in one direction. */
export function bloodSplat(): Texture {
  return make('blood', 128, 1, 1, (g, w, h, r) => {
    g.clearRect(0, 0, w, h);
    const blob = (x: number, y: number, rad: number, a: number) => {
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, `rgba(92,6,8,${a})`); grd.addColorStop(0.7, `rgba(70,4,6,${a * 0.85})`); grd.addColorStop(1, 'rgba(60,0,0,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    };
    blob(w * 0.42, h * 0.5, w * 0.2, 0.95);
    for (let i = 0; i < 26; i++) {
      const ang = r.range(-0.6, 0.6), d = r.range(0.08, 0.48) * w;
      blob(w * 0.42 + Math.cos(ang) * d, h * 0.5 + Math.sin(ang) * d, r.range(1.5, 7) * (1 - d / w), r.range(0.6, 0.95));
    }
  }).tex;
}

/** Soft dark disc used as a contact shadow under characters. */
export function blobShadow(): Texture {
  return make('blobshadow', 64, 1, 1, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(0,0,0,0.75)'); grd.addColorStop(0.5, 'rgba(0,0,0,0.4)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }).tex;
}

/** Weapon finish texture (skins). */
export function finishTexture(id: string, base: string, accent: string, pattern: string): Texture {
  return make(`finish:${id}`, 256, 1, 1, (g, w, h, r) => {
    fill(g, w, h, base);
    g.fillStyle = accent;
    switch (pattern) {
      case 'camo':
        for (let i = 0; i < 30; i++) {
          g.beginPath();
          const x = r.next() * w, y = r.next() * h;
          g.moveTo(x, y);
          for (let k = 0; k < 6; k++) g.lineTo(x + r.range(-40, 40), y + r.range(-40, 40));
          g.fill();
        }
        break;
      case 'digital':
        for (let i = 0; i < 260; i++) g.fillRect(Math.floor(r.next() * 32) * 8, Math.floor(r.next() * 32) * 8, 8 * r.int(1, 3), 8);
        break;
      case 'stripes':
        for (let x = -h; x < w + h; x += 48) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 18, h); g.lineTo(x + 18 + h, 0); g.lineTo(x + h, 0); g.fill(); }
        break;
      case 'gradient': {
        const grd = g.createLinearGradient(0, 0, w, h); grd.addColorStop(0, base); grd.addColorStop(1, accent);
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
        break;
      }
      case 'hex':
        g.strokeStyle = accent; g.lineWidth = 2;
        for (let y = 0; y < h + 20; y += 18) for (let x = (y / 18) % 2 ? 10 : 0; x < w + 20; x += 20) {
          g.beginPath();
          for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9); }
          g.closePath(); g.stroke();
        }
        break;
      default:
        speckle(g, w, h, r, 3000, accent, 0.3, 2);
    }
    speckle(g, w, h, r, 2500, '#000000', 0.15);
  }).tex;
}
