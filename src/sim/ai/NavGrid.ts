import type { CollisionWorld } from '../physics/CollisionWorld';
import { MOVE } from '../../config/movement';

export interface NavPoint { x: number; z: number }

/**
 * Walkability grid for bots. A cell is walkable if a standing character can occupy it
 * without intersecting geometry taller than step height.
 */
export class NavGrid {
  readonly cell: number;
  readonly minX: number; readonly minZ: number;
  readonly cols: number; readonly rows: number;
  readonly walk: Uint8Array;
  /** Distance (in cells) to nearest blocked cell, capped – used to keep paths off walls. */
  readonly clearance: Uint8Array;

  constructor(world: CollisionWorld, bounds: { minX: number; minZ: number; maxX: number; maxZ: number }, cell = 0.5) {
    this.cell = cell;
    this.minX = bounds.minX; this.minZ = bounds.minZ;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.walk = new Uint8Array(this.cols * this.rows);
    this.clearance = new Uint8Array(this.cols * this.rows);
    const r = MOVE.radius + 0.05;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = this.minX + (col + 0.5) * cell, z = this.minZ + (row + 0.5) * cell;
        const blocked = world.overlaps(x - r, MOVE.stepHeight, z - r, x + r, MOVE.standHeight, z + r);
        this.walk[row * this.cols + col] = blocked ? 0 : 1;
      }
    }
    this.baseWalk = this.walk.slice();
    this.blockCount = new Uint16Array(this.walk.length);
    this.computeClearance();
  }

  private computeClearance() {
    const { cols, rows } = this;
    const INF = 255;
    const d = this.clearance;
    for (let i = 0; i < d.length; i++) d[i] = this.walk[i] ? INF : 0;
    // two-pass chamfer distance (approx)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c; if (!d[i]) continue;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) v = Math.min(v, d[i - cols] + 1);
      d[i] = v;
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c; if (!d[i]) continue;
      let v = d[i];
      if (c < cols - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < rows - 1) v = Math.min(v, d[i + cols] + 1);
      d[i] = v;
    }
  }

  /** Walkability of the map itself, before any runtime obstacle. */
  private readonly baseWalk: Uint8Array;
  /** Cells each runtime obstacle covers (by key), and how many obstacles cover each cell. */
  private blockers = new Map<number, number[]>();
  private blockCount: Uint16Array;

  /**
   * Mark an area unwalkable for a runtime obstacle (shield, barricade, Zombies shutter). Cells are
   * counted, not saved and restored: overlapping obstacles (a shield just inside a boarded doorway)
   * can come down in any order, and a cell opens again only once nothing covers it.
   */
  block(key: number, minX: number, minZ: number, maxX: number, maxZ: number) {
    this.unblock(key);
    const r = 0.45, cells: number[] = [];
    for (let row = this.rowOf(minZ - r); row <= this.rowOf(maxZ + r); row++) {
      for (let col = this.colOf(minX - r); col <= this.colOf(maxX + r); col++) {
        if (!this.inBounds(col, row)) continue;
        const i = row * this.cols + col;
        cells.push(i);
        this.blockCount[i]++;
        this.walk[i] = 0;
      }
    }
    this.blockers.set(key, cells);
  }
  /** Remove an obstacle's block (nothing happens for a key that never blocked anything). */
  unblock(key: number) {
    const cells = this.blockers.get(key);
    if (!cells) return;
    this.blockers.delete(key);
    for (const i of cells) if (--this.blockCount[i] === 0) this.walk[i] = this.baseWalk[i];
  }
  unblockAll() { for (const k of [...this.blockers.keys()]) this.unblock(k); }

  colOf(x: number) { return Math.floor((x - this.minX) / this.cell); }
  rowOf(z: number) { return Math.floor((z - this.minZ) / this.cell); }
  inBounds(c: number, r: number) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }
  isWalkable(c: number, r: number) { return this.inBounds(c, r) && this.walk[r * this.cols + c] === 1; }
  isWalkableAt(x: number, z: number) { return this.isWalkable(this.colOf(x), this.rowOf(z)); }
  center(c: number, r: number): NavPoint { return { x: this.minX + (c + 0.5) * this.cell, z: this.minZ + (r + 0.5) * this.cell }; }

  /** Nearest walkable cell to a point (spiral search). */
  nearestWalkable(x: number, z: number, maxRadius = 12): { c: number; r: number } | null {
    const c0 = this.colOf(x), r0 = this.rowOf(z);
    if (this.isWalkable(c0, r0)) return { c: c0, r: r0 };
    for (let rad = 1; rad <= maxRadius; rad++) {
      let best: { c: number; r: number } | null = null, bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const c = c0 + dc, r = r0 + dr;
        if (!this.isWalkable(c, r)) continue;
        const d = dc * dc + dr * dr;
        if (d < bestD) { bestD = d; best = { c, r }; }
      }
      if (best) return best;
    }
    return null;
  }

  /** Grid line-of-walk (supercover-ish Bresenham) between two world points. */
  walkLine(ax: number, az: number, bx: number, bz: number): boolean {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / (this.cell * 0.5));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const c = this.colOf(x), r = this.rowOf(z);
      if (!this.isWalkable(c, r)) return false;
      if (this.clearance[r * this.cols + c] < 2) return false;
    }
    return true;
  }

  /** A* search. Returns smoothed world-space waypoints (excluding the start) or null. */
  findPath(sx: number, sz: number, tx: number, tz: number): NavPoint[] | null {
    const s = this.nearestWalkable(sx, sz), t = this.nearestWalkable(tx, tz);
    if (!s || !t) return null;
    const { cols } = this;
    const start = s.r * cols + s.c, goal = t.r * cols + t.c;
    if (start === goal) return [{ x: tx, z: tz }];
    const N = this.walk.length;
    const g = this.gScore ?? (this.gScore = new Float32Array(N));
    const came = this.came ?? (this.came = new Int32Array(N));
    const closed = this.closedGen ?? (this.closedGen = new Uint32Array(N));
    const openGen = this.openGen ?? (this.openGen = new Uint32Array(N));
    const gen = ++this.generation;
    const heap = new MinHeap();
    const h = (i: number) => {
      const dc = Math.abs((i % cols) - t.c), dr = Math.abs(Math.floor(i / cols) - t.r);
      return (dc + dr) + (Math.SQRT2 - 2) * Math.min(dc, dr);
    };
    g[start] = 0; openGen[start] = gen; came[start] = -1;
    heap.push(start, h(start));
    const DC = [1, -1, 0, 0, 1, 1, -1, -1], DR = [0, 0, 1, -1, 1, -1, 1, -1];
    let found = false, expanded = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (++expanded > 60000) break;
      const cc = cur % cols, cr = (cur - cc) / cols;
      for (let k = 0; k < 8; k++) {
        const nc = cc + DC[k], nr = cr + DR[k];
        if (!this.isWalkable(nc, nr)) continue;
        if (k >= 4 && (!this.isWalkable(cc + DC[k], cr) || !this.isWalkable(cc, cr + DR[k]))) continue; // no corner cutting
        const ni = nr * cols + nc;
        if (closed[ni] === gen) continue;
        const clr = this.clearance[ni];
        const wallPenalty = clr <= 1 ? 2.5 : clr === 2 ? 0.8 : 0;
        const ng = g[cur] + (k < 4 ? 1 : Math.SQRT2) + wallPenalty;
        if (openGen[ni] !== gen || ng < g[ni]) {
          g[ni] = ng; came[ni] = cur; openGen[ni] = gen;
          heap.push(ni, ng + h(ni));
        }
      }
    }
    if (!found) return null;
    const cellsPath: number[] = [];
    for (let i = goal; i !== -1; i = came[i]) cellsPath.push(i);
    cellsPath.reverse();
    const pts = cellsPath.map((i) => this.center(i % cols, Math.floor(i / cols)));
    pts[pts.length - 1] = { x: tx, z: tz };
    return this.smooth({ x: sx, z: sz }, pts);
  }

  private smooth(start: NavPoint, pts: NavPoint[]): NavPoint[] {
    const out: NavPoint[] = [];
    let anchor = start;
    let i = 0;
    while (i < pts.length) {
      let j = i;
      // furthest visible point from the anchor (limit lookahead for performance)
      for (let k = Math.min(pts.length - 1, i + 40); k > i; k--) {
        if (this.walkLine(anchor.x, anchor.z, pts[k].x, pts[k].z)) { j = k; break; }
      }
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return out;
  }

  private gScore?: Float32Array;
  private came?: Int32Array;
  private closedGen?: Uint32Array;
  private openGen?: Uint32Array;
  private generation = 0;
}

class MinHeap {
  private ids: number[] = [];
  private pri: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, p: number) {
    const ids = this.ids, pri = this.pri;
    let i = ids.length;
    ids.push(id); pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      ids[i] = ids[parent]; pri[i] = pri[parent];
      i = parent;
    }
    ids[i] = id; pri[i] = p;
  }
  pop(): number {
    const ids = this.ids, pri = this.pri;
    const top = ids[0];
    const lastId = ids.pop()!, lastP = pri.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && pri[r] < pri[l]) l = r;
        if (pri[l] >= lastP) break;
        ids[i] = ids[l]; pri[i] = pri[l];
        i = l;
      }
      ids[i] = lastId; pri[i] = lastP;
    }
    return top;
  }
}
