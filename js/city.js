'use strict';
// Prosedürel 2D şehir: yollar, bloklar, sözde-3D binalar, drift parkı, çarpışma ızgarası
(function () {
  const DS = window.DS, U = DS.U, C = DS.Collide;
  const NB = 9;          // her eksende blok sayısı
  const SW = 3.5;        // kaldırım genişliği
  const CELL = 16;       // çarpışma ızgara hücresi
  const DCELL = 32;      // çizim ızgara hücresi
  const PS = 20;         // doku pikseli / metre

  const FACADES = ['#c9b79c', '#a7a9ac', '#8d6e63', '#b0bec5', '#d7ccc8', '#9e9d89', '#6d7b8d', '#c2a385',
    '#7e8c7a', '#a1887f', '#546e7a', '#bcaaa4', '#b7a99a', '#8e9aa6', '#9c7f6a', '#7b8794'];
  const ROOFS = ['#55595f', '#62666c', '#4a4e54', '#6f7378', '#7d746a', '#5a5f57', '#666a62'];
  const CONT = ['#b23a2e', '#2e6db2', '#2e8b57', '#d98c1f', '#6b4f9e', '#8a8f98', '#c4c4c4', '#1f5f7a'];
  const NEON = ['#ff3a6e', '#38d9ff', '#ffb23e', '#7cff6b', '#c86bff'];
  const SOLID_KINDS = { bld: 1, barrier: 1, rail: 1, cont: 1, ware: 1, stand: 1, car: 1 };
  const SOLID_CIRCS = { tires: 1, island: 1, tree: 1, fountain: 1, pole: 1 };
  // en düşük kademede desen yerine düz renkler
  const FLAT = { asphalt: '#2d3139', lot: '#363a41', dpark: '#2e3238', sidewalk: '#9c978d', concrete: '#8b8880', grass: '#3c6a2d', gravel: '#a49b86' };
  // duvar dış normalleri: kuzey, doğu, güney, batı
  const WN = [0, -1, 1, 0, 0, 1, -1, 0];
  const RIPPLE = [];
  for (let i = 0; i < 10; i++) RIPPLE.push(`rgba(200,235,255,${(0.5 * (1 - i / 10)).toFixed(3)})`);

  function fillPat(ctx, pat, x, y, w, h) {
    ctx.save();
    ctx.scale(1 / PS, 1 / PS);
    ctx.fillStyle = pat;
    ctx.fillRect(x * PS, y * PS, w * PS, h * PS);
    ctx.restore();
  }

  class City {
    constructor(seed) {
      const R = (this.R = U.rng(seed || 20251005));
      this.camH = 165; // sözde-3D perspektif için kamera yüksekliği (m)
      this.margin = 70;
      this.wx = []; this.wy = [];
      for (let i = 0; i <= NB; i++) {
        const w = i === 0 || i === NB ? 24 : i === 3 || i === 6 ? 22 : 15;
        this.wx.push(w); this.wy.push(w);
      }
      this.bx = []; this.by = [];
      for (let i = 0; i < NB; i++) {
        this.bx.push(Math.round(74 + R() * 28));
        this.by.push(Math.round(74 + R() * 28));
      }
      this.lx = [this.margin + this.wx[0] / 2];
      this.ly = [this.margin + this.wy[0] / 2];
      for (let i = 0; i < NB; i++) {
        this.lx.push(this.lx[i] + this.wx[i] / 2 + this.bx[i] + this.wx[i + 1] / 2);
        this.ly.push(this.ly[i] + this.wy[i] / 2 + this.by[i] + this.wy[i + 1] / 2);
      }
      this.x0 = this.lx[0] - this.wx[0] / 2; this.x1 = this.lx[NB] + this.wx[NB] / 2;
      this.y0 = this.ly[0] - this.wy[0] / 2; this.y1 = this.ly[NB] + this.wy[NB] / 2;
      this.W = this.x1 + this.margin; this.H = this.y1 + this.margin;
      this.cx = (this.x0 + this.x1) / 2; this.cy = (this.y0 + this.y1) / 2;

      this.boxes = []; this.circs = []; this.solids = []; this.blocks = [];
      this.low = []; this.tall = []; this.marks = []; this.decals = [];
      this.lamps = []; this.cones = []; this.clips = []; this.floods = []; this.islands = []; this.tireIsl = [];
      this.fountains = [];
      this.cgrid = new Map(); this.dgrid = new Map(); this.qid = 1; this.dq = 1;
      this.roundabouts = [[3, 3], [6, 6]];
      this.Q = DS.Quality.TIERS[2];
      this.nid = 1;

      this._layout();
      this._roads();
      this._blocks();
      this._boundary();
      this._index();
    }

    blockRect(i, j) {
      return {
        x0: this.lx[i] + this.wx[i] / 2, x1: this.lx[i + 1] - this.wx[i + 1] / 2,
        y0: this.ly[j] + this.wy[j] / 2, y1: this.ly[j + 1] - this.wy[j + 1] / 2,
      };
    }
    inDrift(x, y, m) {
      const d = this.drift; m = m || 0;
      return x > d.x0 - m && x < d.x1 + m && y > d.y0 - m && y < d.y1 + m;
    }

    _layout() {
      const T = [];
      for (let i = 0; i < NB; i++) { T.push([]); for (let j = 0; j < NB; j++) T[i].push('build'); }
      const set = (list, t) => list.forEach(([i, j]) => (T[i][j] = t));
      set([[6, 1], [7, 1], [6, 2], [7, 2]], 'drift');
      set([[0, 6], [0, 7], [0, 8], [1, 7], [1, 8], [2, 8]], 'ind');
      set([[2, 2], [4, 5], [7, 6]], 'park');
      set([[3, 1], [5, 6], [1, 5]], 'parking');
      this.T = T;
      const a = this.blockRect(6, 1), b = this.blockRect(7, 2);
      this.drift = { x0: a.x0, y0: a.y0, x1: b.x1, y1: b.y1 };
    }

    // ---------- kayıt yardımcıları ----------
    addBox(x0, y0, x1, y1, kind) {
      const b = { x0, y0, x1, y1, kind, id: this.nid++, q: 0 };
      this.boxes.push(b);
      return b;
    }
    addCirc(x, y, r, kind, brk) {
      const c = { x, y, r, kind, brk: brk || 0, broken: false, id: this.nid++, q: 0 };
      this.circs.push(c);
      return c;
    }
    addSolid(o) {
      o.id = this.nid++;
      const base = o.wall || '#888888';
      // Güneş kuzeybatıdan: batı/kuzey duvarlar aydınlık
      o.wc = [U.shade(base, -0.12), U.shade(base, -0.34), U.shade(base, -0.24), U.shade(base, 0.04)];
      this.solids.push(o);
      return o;
    }
    addLamp(x, y, nx, ny) {
      const col = this.addCirc(x, y, 0.22, 'lamp', 2.6);
      const p = { kind: 'lamp', x, y, nx, ny, col, r: 3 };
      col.ref = p;
      this.lamps.push(p);
      this.tall.push(p);
    }
    addTree(x, y, r, solid) {
      const t = { kind: 'tree', x, y, rc: r, v: Math.floor(this.R() * 4), r: r + 1 };
      if (solid !== false) t.col = this.addCirc(x, y, 0.42, 'tree');
      this.tall.push(t);
      return t;
    }
    addLow(p) {
      if (p.r === undefined) p.r = 1.5;
      this.low.push(p);
      return p;
    }

    // ---------- yollar ----------
    _roads() {
      for (let i = 0; i <= NB; i++) {
        for (let j = 0; j < NB; j++) {
          const ya = this.ly[j] + this.wy[j] / 2, yb = this.ly[j + 1] - this.wy[j + 1] / 2;
          if (this.inDrift(this.lx[i], (ya + yb) / 2)) continue;
          this._segMarks(true, this.lx[i], ya, yb, this.wx[i]);
        }
      }
      for (let j = 0; j <= NB; j++) {
        for (let i = 0; i < NB; i++) {
          const xa = this.lx[i] + this.wx[i] / 2, xb = this.lx[i + 1] - this.wx[i + 1] / 2;
          if (this.inDrift((xa + xb) / 2, this.ly[j])) continue;
          this._segMarks(false, this.ly[j], xa, xb, this.wy[j]);
        }
      }
      for (const [i, j] of this.roundabouts) {
        const x = this.lx[i], y = this.ly[j], r = 5.4;
        this.islands.push({ x, y, r });
        this.addCirc(x, y, r, 'island');
        this.addTree(x, y, 3.6, false);
      }
    }

    _segMarks(vertical, c, a, b, w) {
      const R = this.R;
      const L = b - a;
      const add = (s0, s1, t0, t1, col) => {
        if (vertical) this.marks.push({ x0: c + t0, x1: c + t1, y0: s0, y1: s1, col, r: 0 });
        else this.marks.push({ x0: s0, x1: s1, y0: c + t0, y1: c + t1, col, r: 0 });
      };
      const avenue = w >= 22;
      const cw = 3.2;
      for (const end of [0, 1]) {
        const s0 = end ? b - 0.7 - cw : a + 0.7;
        for (let t = -w / 2 + 1.1; t < w / 2 - 1.4; t += 1.15) add(s0, s0 + cw, t, t + 0.58, 'w');
      }
      const m0 = a + 0.7 + cw + 1.4, m1 = b - 0.7 - cw - 1.4;
      if (m1 - m0 < 6) return;
      const rs = vertical ? -1 : 1; // sağdan trafik: şerit tarafı
      if (avenue) {
        add(m0, m1, -0.34, -0.2, 'y');
        add(m0, m1, 0.2, 0.34, 'y');
        for (const t of [-w / 4, w / 4]) {
          for (let s = m0 + 2; s < m1 - 3; s += 9) add(s, Math.min(s + 3.6, m1), t - 0.08, t + 0.08, 'w');
        }
        add(m0, m1, -w / 2 + 0.5, -w / 2 + 0.66, 'w');
        add(m0, m1, w / 2 - 0.66, w / 2 - 0.5, 'w');
      } else {
        for (let s = m0 + 1; s < m1 - 2; s += 7) add(s, Math.min(s + 3, m1), -0.08, 0.08, 'w');
      }
      // dur çizgileri
      const t0 = 0.4, t1 = w / 2 - 0.6;
      if (rs > 0) { add(m1 + 0.2, m1 + 0.7, t0, t1, 'w'); add(m0 - 0.7, m0 - 0.2, -t1, -t0, 'w'); }
      else { add(m1 + 0.2, m1 + 0.7, -t1, -t0, 'w'); add(m0 - 0.7, m0 - 0.2, t0, t1, 'w'); }
      // yol lekeleri
      const n = Math.max(1, Math.floor(L / 22));
      for (let k = 0; k < n; k++) {
        const s = U.lerp(a + 3, b - 3, R()), t = U.lerp(-w / 2 + 1.5, w / 2 - 1.5, R());
        const x = vertical ? c + t : s, y = vertical ? s : c + t;
        const q = R();
        if (q < 0.22) this.decals.push({ kind: 'manhole', x, y, r: 0.42 });
        else if (q < 0.55) {
          const pts = [x, y];
          let px = x, py = y, ang = R() * U.TAU;
          const seg = 3 + Math.floor(R() * 4);
          for (let m = 0; m < seg; m++) {
            ang += (R() - 0.5) * 1.4;
            px += Math.cos(ang) * (0.5 + R() * 1.1);
            py += Math.sin(ang) * (0.5 + R() * 1.1);
            pts.push(px, py);
          }
          this.decals.push({ kind: 'crack', x, y, r: 6, pts });
        } else if (q < 0.82) this.decals.push({ kind: 'oil', x, y, r: 0.6 + R() * 0.9, ang: R() * 3, e: 0.5 + R() * 0.4 });
        else this.decals.push({ kind: 'patch', x, y, r: 3, w: 1.6 + R() * 2.4, h: 1.4 + R() * 2.8 });
      }
    }

    // ---------- bloklar ----------
    _blocks() {
      for (let i = 0; i < NB; i++) {
        for (let j = 0; j < NB; j++) {
          const t = this.T[i][j];
          if (t === 'drift') {
            if (i === 6 && j === 1) this._driftPark();
            continue;
          }
          const r = this.blockRect(i, j);
          const b = { i, j, type: t, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, courts: [], paths: [], paint: [] };
          b.inner = { x0: r.x0 + SW, y0: r.y0 + SW, x1: r.x1 - SW, y1: r.y1 - SW };
          this.blocks.push(b);
          this._sidewalk(b);
          if (t === 'build') this._buildBlock(b);
          else if (t === 'park') this._park(b);
          else if (t === 'parking') this._parking(b, b.inner);
          else if (t === 'ind') this._industrial(b);
        }
      }
    }

    _sideRoadW(b, side) {
      if (b.type === 'drift') return 15;
      if (side === 0) return this.wy[b.j];
      if (side === 1) return this.wx[b.i + 1];
      if (side === 2) return this.wy[b.j + 1];
      return this.wx[b.i];
    }

    _sidewalk(b) {
      const R = this.R;
      const sides = [
        { ax: b.x0, ay: b.y0, bx: b.x1, by: b.y0, nx: 0, ny: -1 },
        { ax: b.x1, ay: b.y0, bx: b.x1, by: b.y1, nx: 1, ny: 0 },
        { ax: b.x1, ay: b.y1, bx: b.x0, by: b.y1, nx: 0, ny: 1 },
        { ax: b.x0, ay: b.y1, bx: b.x0, by: b.y0, nx: -1, ny: 0 },
      ];
      sides.forEach((sd, si) => {
        const len = Math.hypot(sd.bx - sd.ax, sd.by - sd.ay);
        const dx = (sd.bx - sd.ax) / len, dy = (sd.by - sd.ay) / len;
        const at = (s, off) => [sd.ax + dx * s - sd.nx * off, sd.ay + dy * s - sd.ny * off];
        const boulevard = this._sideRoadW(b, si) >= 22 && b.type !== 'park' && b.type !== 'drift';
        for (let s = 11; s <= len - 11; s += 29) {
          const [x, y] = at(s, 0.75);
          this.addLamp(x, y, sd.nx, sd.ny);
          if (boulevard && s + 14.5 < len - 8) {
            const [tx, ty] = at(s + 14.5, 1.9);
            this.addTree(tx, ty, 2.5 + R() * 0.9);
          }
        }
        if (b.type === 'drift') return;
        if (R() < 0.45) {
          const [x, y] = at(16 + R() * (len - 32), 1.0);
          const col = this.addCirc(x, y, 0.24, 'hydrant', 2.2);
          col.ref = this.addLow({ kind: 'hydrant', x, y, col });
        }
        if (R() < 0.4) {
          const [x, y] = at(14 + R() * (len - 28), 0.95);
          const col = this.addCirc(x, y, 0.32, 'bin', 1.2);
          col.ref = this.addLow({ kind: 'bin', x, y, col });
        }
        if (R() < 0.35) {
          const [x, y] = at(18 + R() * (len - 36), SW - 0.75);
          this.addLow({ kind: 'bench', x, y, ang: Math.atan2(dy, dx) });
        }
      });
    }

    _buildBlock(b) {
      const R = this.R, inner = b.inner;
      const lots = [];
      const split = (r, d) => {
        const w = r.x1 - r.x0, h = r.y1 - r.y0;
        if (d < 3 && (w > 30 || h > 30) && (d < 1 || R() < 0.78)) {
          if (w >= h) {
            const t = r.x0 + w * (0.36 + R() * 0.28);
            split({ x0: r.x0, y0: r.y0, x1: t, y1: r.y1 }, d + 1);
            split({ x0: t, y0: r.y0, x1: r.x1, y1: r.y1 }, d + 1);
          } else {
            const t = r.y0 + h * (0.36 + R() * 0.28);
            split({ x0: r.x0, y0: r.y0, x1: r.x1, y1: t }, d + 1);
            split({ x0: r.x0, y0: t, x1: r.x1, y1: r.y1 }, d + 1);
          }
        } else lots.push(r);
      };
      split(inner, 0);
      const maxR = Math.hypot(this.x1 - this.cx, this.y1 - this.cy);
      for (const lot of lots) {
        const edge = lot.x0 <= inner.x0 + 0.01 || lot.y0 <= inner.y0 + 0.01 || lot.x1 >= inner.x1 - 0.01 || lot.y1 >= inner.y1 - 0.01;
        const area = (lot.x1 - lot.x0) * (lot.y1 - lot.y0);
        if (edge && area > 220 && R() < 0.14) {
          b.courts.push(lot);
          this._court(lot);
          continue;
        }
        const bl = { x0: lot.x0 + 0.35, y0: lot.y0 + 0.35, x1: lot.x1 - 0.35, y1: lot.y1 - 0.35 };
        const mx = (bl.x0 + bl.x1) / 2, my = (bl.y0 + bl.y1) / 2;
        const dc = Math.hypot(mx - this.cx, my - this.cy) / maxR;
        let h = U.lerp(42, 10, U.sat(dc * 1.3)) * (0.55 + R() * 0.6);
        if (area < 380) h *= 0.75;
        h = U.clamp(h, 7, 52);
        const s = this.addSolid({
          kind: 'bld', x0: bl.x0, y0: bl.y0, x1: bl.x1, y1: bl.y1, h,
          wall: FACADES[Math.floor(R() * FACADES.length)],
          roof: ROOFS[Math.floor(R() * ROOFS.length)],
          win: R() < 0.5 ? 'band' : 'grid', lit: 0.18 + R() * 0.4,
          glass: R() < 0.5 ? 'rgba(28,44,62,0.62)' : 'rgba(40,52,60,0.5)',
          det: [],
        });
        const w = bl.x1 - bl.x0, hh = bl.y1 - bl.y0;
        const nAc = Math.floor(R() * 4);
        for (let k = 0; k < nAc; k++) {
          const aw = 1.2 + R() * 1.4, ah = 1 + R() * 1.2;
          const ax = bl.x0 + 1.2 + R() * Math.max(0.1, w - aw - 2.4), ay = bl.y0 + 1.2 + R() * Math.max(0.1, hh - ah - 2.4);
          s.det.push({ t: 'ac', x0: ax, y0: ay, x1: ax + aw, y1: ay + ah });
        }
        if (R() < 0.25 && w > 8 && hh > 8) s.det.push({ t: 'tank', x: bl.x0 + w * (0.2 + R() * 0.6), y: bl.y0 + hh * (0.2 + R() * 0.6), r: 1.3 });
        if (h > 36 && w > 16 && hh > 16 && R() < 0.6) s.det.push({ t: 'heli', x: mx, y: my, r: Math.min(w, hh) * 0.3 });
        if (R() < 0.28) {
          const e = Math.floor(R() * 4);
          s.neon = { e, col: NEON[Math.floor(R() * NEON.length)] };
        }
        this.addBox(bl.x0, bl.y0, bl.x1, bl.y1, 'bld');
      }
    }

    _court(lot) {
      const R = this.R;
      if (R() < 0.55) {
        // küçük otopark
        this._parking(null, { x0: lot.x0 + 0.5, y0: lot.y0 + 0.5, x1: lot.x1 - 0.5, y1: lot.y1 - 0.5 });
      } else {
        const n = 2 + Math.floor(R() * 3);
        for (let k = 0; k < n; k++) {
          this.addTree(U.lerp(lot.x0 + 3, lot.x1 - 3, R()), U.lerp(lot.y0 + 3, lot.y1 - 3, R()), 2.2 + R());
        }
      }
    }

    _park(b) {
      const R = this.R, inner = b.inner;
      const cx = (inner.x0 + inner.x1) / 2, cy = (inner.y0 + inner.y1) / 2;
      b.paths.push({ x0: inner.x0, y0: cy - 1.6, x1: inner.x1, y1: cy + 1.6 });
      b.paths.push({ x0: cx - 1.6, y0: inner.y0, x1: cx + 1.6, y1: inner.y1 });
      const plazaR = 9;
      b.plaza = { x: cx, y: cy, r: plazaR };
      const f = { x: cx, y: cy, r: 3.2 };
      this.fountains.push(f);
      this.addCirc(cx, cy, 3.2, 'fountain');
      const area = (inner.x1 - inner.x0) * (inner.y1 - inner.y0);
      const n = Math.floor(area / 170);
      for (let k = 0; k < n; k++) {
        const x = U.lerp(inner.x0 + 3, inner.x1 - 3, R()), y = U.lerp(inner.y0 + 3, inner.y1 - 3, R());
        if (Math.abs(x - cx) < 4.5 || Math.abs(y - cy) < 4.5) continue;
        if (Math.hypot(x - cx, y - cy) < plazaR + 3) continue;
        if (R() < 0.75) this.addTree(x, y, 2.4 + R() * 1.6);
        else this.addLow({ kind: 'bush', x, y, rr: 0.8 + R() * 0.8, r: 2 });
      }
    }

    _parking(b, inner) {
      const R = this.R;
      const stallW = 2.7, depth = 5.3, aisle = 7.2;
      // Sıra 0 koridora bakar (burun aşağı), sıra 1 koridorun altında (burun yukarı),
      // sıra 2 ona sırt sırta ... şeklinde devam eder
      let y = inner.y0 + 0.8;
      const rows = [];
      for (let k = 0; y + depth <= inner.y1 - 0.5; k++) {
        rows.push({ y0: y, y1: y + depth, face: k % 2 === 0 ? 1 : -1 });
        y += depth + (k % 2 === 0 ? aisle : 0);
      }
      for (const row of rows) {
        const x0 = inner.x0 + 1.5, x1 = inner.x1 - 1.5;
        for (let x = x0; x + stallW <= x1; x += stallW) {
          this.marks.push({ x0: x - 0.06, x1: x + 0.06, y0: row.y0, y1: row.y1, col: 'w', r: 0 });
          if (R() < 0.55) {
            const vi = Math.floor(R() * 8);
            const def = DS.CARS[vi % DS.CARS.length];
            const L = def.len * 0.98, Wd = def.wid;
            const cxp = x + stallW / 2, cyp = (row.y0 + row.y1) / 2 + (R() - 0.5) * 0.3;
            const ang = row.face > 0 ? Math.PI / 2 : -Math.PI / 2;
            this.addLow({ kind: 'car', x: cxp, y: cyp, ang: ang + (R() - 0.5) * 0.06, v: vi, r: 3 });
            this.addBox(cxp - Wd / 2, cyp - L / 2, cxp + Wd / 2, cyp + L / 2, 'car');
          }
        }
        this.marks.push({ x0: x0 - 0.06, x1: x0 + 0.06, y0: row.y0, y1: row.y1, col: 'w', r: 0 });
        const by = row.face > 0 ? row.y0 : row.y1 - 0.12;
        this.marks.push({ x0, x1, y0: by, y1: by + 0.12, col: 'w', r: 0 });
      }
      if (b) {
        // otopark aydınlatması
        const cx = (inner.x0 + inner.x1) / 2;
        this.addLamp(cx - 15, (inner.y0 + inner.y1) / 2, 0, 1);
        this.addLamp(cx + 15, (inner.y0 + inner.y1) / 2, 0, -1);
      }
    }

    _industrial(b) {
      const R = this.R, inner = b.inner;
      const w = inner.x1 - inner.x0, h = inner.y1 - inner.y0;
      // depo
      const horiz = R() < 0.5;
      let free;
      if (horiz) {
        const wh = h * (0.4 + R() * 0.15);
        const s = { kind: 'ware', x0: inner.x0 + 2, y0: inner.y0 + 2, x1: inner.x1 - 2, y1: inner.y0 + wh, h: 9 + R() * 4, wall: R() < 0.5 ? '#9aa6b2' : '#b8b2a3', roof: '#7d858c' };
        this.addSolid(s); this.addBox(s.x0, s.y0, s.x1, s.y1, 'ware');
        free = { x0: inner.x0 + 3, y0: s.y1 + 6, x1: inner.x1 - 3, y1: inner.y1 - 3 };
      } else {
        const ww = w * (0.38 + R() * 0.15);
        const s = { kind: 'ware', x0: inner.x0 + 2, y0: inner.y0 + 2, x1: inner.x0 + ww, y1: inner.y1 - 2, h: 9 + R() * 4, wall: R() < 0.5 ? '#9aa6b2' : '#b8b2a3', roof: '#7d858c' };
        this.addSolid(s); this.addBox(s.x0, s.y0, s.x1, s.y1, 'ware');
        free = { x0: s.x1 + 6, y0: inner.y0 + 3, x1: inner.x1 - 3, y1: inner.y1 - 3 };
      }
      // konteyner sıraları (aralarından drift atılabilir)
      const cw = 2.44;
      let y = free.y0 + 1;
      while (y + cw * 2 < free.y1) {
        let x = free.x0 + R() * 4;
        while (x < free.x1 - 7) {
          const len = R() < 0.6 ? 12.2 : 6.1;
          if (x + len > free.x1) break;
          const stack = R() < 0.35 ? 2 : 1;
          const col = CONT[Math.floor(R() * CONT.length)];
          if (R() < 0.82) {
            const s = { kind: 'cont', x0: x, y0: y, x1: x + len, y1: y + cw, h: 2.6 * stack, wall: col, roof: U.shade(col, 0.12) };
            this.addSolid(s); this.addBox(s.x0, s.y0, s.x1, s.y1, 'cont');
          }
          x += len + (R() < 0.3 ? 6 + R() * 4 : 0.4);
        }
        y += cw + 7 + R() * 4;
      }
      // zemin çizgileri
      this.marks.push({ x0: free.x0, x1: free.x1, y0: free.y0 - 2.2, y1: free.y0 - 2.0, col: 'y', r: 0 });
    }

    _driftPark() {
      const R = this.R, d = this.drift;
      const b = { i: 6, j: 1, type: 'drift', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, courts: [], paths: [], paint: [] };
      b.inner = { x0: d.x0 + SW, y0: d.y0 + SW, x1: d.x1 - SW, y1: d.y1 - SW };
      this.blocks.push(b);
      this._sidewalk(b);
      const I = b.inner, T = 0.8, G = 22;
      const cx = (I.x0 + I.x1) / 2, cy = (I.y0 + I.y1) / 2;
      const wall = (x0, y0, x1, y1) => {
        if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return;
        this.addSolid({ kind: 'barrier', x0, y0, x1, y1, h: 1.05, wall: '#d8d4cc', roof: '#ece8df' });
        this.addBox(x0, y0, x1, y1, 'barrier');
      };
      // kuzey ve güney: iki kapı; doğu ve batı: bir kapı
      const nx1 = I.x0 + (I.x1 - I.x0) * 0.3, nx2 = I.x0 + (I.x1 - I.x0) * 0.7;
      wall(I.x0, I.y0, nx1 - G / 2, I.y0 + T);
      wall(nx1 + G / 2, I.y0, nx2 - G / 2, I.y0 + T);
      wall(nx2 + G / 2, I.y0, I.x1, I.y0 + T);
      wall(I.x0, I.y1 - T, nx1 - G / 2, I.y1);
      wall(nx1 + G / 2, I.y1 - T, nx2 - G / 2, I.y1);
      wall(nx2 + G / 2, I.y1 - T, I.x1, I.y1);
      wall(I.x0, I.y0 + T, I.x0 + T, cy - G / 2);
      wall(I.x0, cy + G / 2, I.x0 + T, I.y1 - T);
      wall(I.x1 - T, I.y0 + T, I.x1, cy - G / 2);
      wall(I.x1 - T, cy + G / 2, I.x1, I.y1 - T);
      // sekiz çizmek için iki lastik adası
      const dx = (I.x1 - I.x0) * 0.22;
      for (const sx of [-1, 1]) {
        const x = cx + sx * dx, y = cy;
        this.tireIsl.push({ x, y, r: 4.4 });
        this.addCirc(x, y, 4.4, 'tires');
        b.paint.push({ t: 'ring', x, y, r: 4.4 + 7 });
        this.clips.push({ x: x + sx * (4.4 + 9), y, r: 3.6, id: this.clips.length, t: 0 });
      }
      this.clips.push({ x: cx, y: cy - 15, r: 3.6, id: this.clips.length, t: 0 });
      this.clips.push({ x: cx, y: cy + 15, r: 3.6, id: this.clips.length, t: 0 });
      // duvar dibi klip noktaları
      this.clips.push({ x: I.x0 + 6, y: I.y0 + 10, r: 3.6, id: this.clips.length, t: 0 });
      this.clips.push({ x: I.x1 - 6, y: I.y1 - 10, r: 3.6, id: this.clips.length, t: 0 });
      for (const c of this.clips) this.addLow({ kind: 'clip', x: c.x, y: c.y, ref: c, r: 5 });
      // projektör kuleleri: köşeler + kenar ortaları (kapı boşluklarının yanında)
      const fx1 = I.x0 + (I.x1 - I.x0) * 0.5, fy1 = I.y0 + (I.y1 - I.y0) * 0.25, fy2 = I.y0 + (I.y1 - I.y0) * 0.75;
      for (const [px, py] of [[I.x0 + 3, I.y0 + 3], [I.x1 - 3, I.y0 + 3], [I.x0 + 3, I.y1 - 3], [I.x1 - 3, I.y1 - 3],
        [fx1, I.y0 + 3], [fx1, I.y1 - 3], [I.x0 + 3, fy1], [I.x1 - 3, fy2]]) {
        this.addCirc(px, py, 0.55, 'pole');
        const f = { kind: 'flood', x: px, y: py, tx: cx, ty: cy, r: 3 };
        this.floods.push(f);
        this.tall.push(f);
      }
      // tribün
      const st = { kind: 'stand', x0: I.x0 + 8, y0: I.y0 + T + 1.2, x1: nx1 - G / 2 - 2, y1: I.y0 + T + 7.5, h: 4.2, wall: '#5d636b', roof: '#3f4550' };
      if (st.x1 - st.x0 > 10) { this.addSolid(st); this.addBox(st.x0, st.y0, st.x1, st.y1, 'stand'); }
      // dubalar: kuzeyde slalom, güneyde başlangıç kapısı
      for (let k = 0; k < 7; k++) this.cones.push(this._cone(cx - 30 + k * 10, I.y0 + 18));
      for (let k = 0; k < 5; k++) {
        this.cones.push(this._cone(nx1 - 8, I.y1 - 6 - k * 3.2));
        this.cones.push(this._cone(nx1 + 8, I.y1 - 6 - k * 3.2));
      }
      b.paint.push({ t: 'start', x: nx1, y: I.y1 - 16, w: 16 });
      b.paint.push({ t: 'text', x: cx, y: cy - 34, s: 'DRIFT PARK' });
      this.driftBlock = b;
    }
    _cone(x, y) {
      return { x, y, x0: x, y0: y, vx: 0, vy: 0, a: 0, w: 0, down: false };
    }

    _boundary() {
      const R = this.R, t = 0.7;
      const rail = (x0, y0, x1, y1) => {
        this.addSolid({ kind: 'rail', x0, y0, x1, y1, h: 0.95, wall: '#9aa1a9', roof: '#c7ccd1' });
        this.addBox(x0, y0, x1, y1, 'rail');
      };
      rail(this.x0 - t, this.y0 - t, this.x1 + t, this.y0);
      rail(this.x0 - t, this.y1, this.x1 + t, this.y1 + t);
      rail(this.x0 - t, this.y0, this.x0, this.y1);
      rail(this.x1, this.y0, this.x1 + t, this.y1);
      // şehir dışı ağaçlık
      const n = 260;
      for (let k = 0; k < n; k++) {
        let x, y;
        const side = Math.floor(R() * 4);
        if (side === 0) { x = R() * this.W; y = R() * (this.margin - 6); }
        else if (side === 1) { x = R() * this.W; y = this.y1 + 6 + R() * (this.margin - 6); }
        else if (side === 2) { x = R() * (this.margin - 6); y = R() * this.H; }
        else { x = this.x1 + 6 + R() * (this.margin - 6); y = R() * this.H; }
        this.addTree(x, y, 2.6 + R() * 2.4, false);
      }
    }

    // ---------- ızgaralar ----------
    _index() {
      const put = (map, cell, x0, y0, x1, y1, key, o) => {
        const ax = Math.floor(x0 / cell), bx = Math.floor(x1 / cell);
        const ay = Math.floor(y0 / cell), by = Math.floor(y1 / cell);
        for (let i = ax; i <= bx; i++) {
          for (let j = ay; j <= by; j++) {
            const k = i * 4096 + j;
            let c = map.get(k);
            if (!c) { c = { b: [], c: [], l: [], t: [], m: [], d: [] }; map.set(k, c); }
            c[key].push(o);
          }
        }
      };
      for (const b of this.boxes) put(this.cgrid, CELL, b.x0, b.y0, b.x1, b.y1, 'b', b);
      for (const c of this.circs) put(this.cgrid, CELL, c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r, 'c', c);
      for (const p of this.low) { p.q = 0; put(this.dgrid, DCELL, p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, 'l', p); }
      for (const p of this.tall) { p.q = 0; put(this.dgrid, DCELL, p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, 't', p); }
      for (const m of this.marks) { m.q = 0; put(this.dgrid, DCELL, m.x0, m.y0, m.x1, m.y1, 'm', m); }
      for (const d of this.decals) { d.q = 0; put(this.dgrid, DCELL, d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r, 'd', d); }
    }

    query(x0, y0, x1, y1, fn) {
      const q = ++this.qid;
      const ax = Math.floor(x0 / CELL), bx = Math.floor(x1 / CELL);
      const ay = Math.floor(y0 / CELL), by = Math.floor(y1 / CELL);
      for (let i = ax; i <= bx; i++) {
        for (let j = ay; j <= by; j++) {
          const c = this.cgrid.get(i * 4096 + j);
          if (!c) continue;
          for (const b of c.b) { if (b.q !== q) { b.q = q; if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1) fn('b', b); } }
          for (const o of c.c) { if (o.q !== q) { o.q = q; fn('c', o); } }
        }
      }
    }

    visible(v, key, out) {
      const q = ++this.dq;
      if (out) out.length = 0; else out = [];
      const ax = Math.floor(v.x0 / DCELL), bx = Math.floor(v.x1 / DCELL);
      const ay = Math.floor(v.y0 / DCELL), by = Math.floor(v.y1 / DCELL);
      for (let i = ax; i <= bx; i++) {
        for (let j = ay; j <= by; j++) {
          const c = this.dgrid.get(i * 4096 + j);
          if (!c) continue;
          const arr = c[key];
          for (let k = 0; k < arr.length; k++) {
            const o = arr[k];
            if (o.q !== q) { o.q = q; out.push(o); }
          }
        }
      }
      return out;
    }

    // ---------- fizik etkileşimi ----------
    // Araç (OBB) ile şehir çarpışması. ev: {hit(ct, res, kind), brk(col, car)}
    collideCar(car, ev) {
      const o = car.obb();
      const rb = Math.hypot(o.hl, o.hw) + 0.6;
      for (let it = 0; it < 3; it++) {
        let any = false;
        this.query(o.x - rb, o.y - rb, o.x + rb, o.y + rb, (k, col) => {
          let ct;
          if (k === 'b') ct = C.obbBox(o, col.x0, col.y0, col.x1, col.y1);
          else {
            if (col.broken) return;
            ct = C.obbCircle(o, col.x, col.y, col.r);
            if (ct && col.brk) {
              const rx = ct.px - car.x, ry = ct.py - car.y;
              const pvx = car.vx - car.w * ry, pvy = car.vy + car.w * rx;
              const sp = -(pvx * ct.nx + pvy * ct.ny);
              if (sp > col.brk) {
                this.breakProp(col, pvx, pvy);
                car.vx *= 0.93; car.vy *= 0.93;
                ev.brk(col, ct, sp);
                return;
              }
            }
          }
          if (!ct) return;
          const e = col.kind === 'tires' ? 0.45 : col.kind === 'car' ? 0.3 : 0.18;
          const res = C.resolve(car, ct, e, 0.32);
          o.x = car.x; o.y = car.y;
          any = true;
          ev.hit(ct, res, col.kind);
        });
        if (!any) break;
      }
      // dubalar
      for (const cn of this.cones) {
        const dx = cn.x - o.x, dy = cn.y - o.y;
        if (dx * dx + dy * dy > 16) continue;
        const ct = C.obbCircle(o, cn.x, cn.y, 0.3);
        if (!ct) continue;
        const rx = ct.px - car.x, ry = ct.py - car.y;
        const pvx = car.vx - car.w * ry, pvy = car.vy + car.w * rx;
        cn.x -= ct.nx * ct.pen; cn.y -= ct.ny * ct.pen;
        cn.vx = pvx * 1.15 - ct.nx * 2 + (Math.random() - 0.5) * 2;
        cn.vy = pvy * 1.15 - ct.ny * 2 + (Math.random() - 0.5) * 2;
        cn.w = (Math.random() - 0.5) * 18;
        if (!cn.down) { cn.down = true; ev.cone(cn); }
      }
    }

    breakProp(col, vx, vy) {
      col.broken = true;
      col.fall = Math.atan2(vy, vx) + (Math.random() - 0.5) * 0.6;
      col.bt = 0;
      if (col.ref) { col.ref.broken = true; col.ref.fall = col.fall; col.ref.bt = 0; }
    }

    updateCones(dt) {
      for (const cn of this.cones) {
        const sp = Math.hypot(cn.vx, cn.vy);
        if (sp < 0.01 && Math.abs(cn.w) < 0.01) continue;
        cn.x += cn.vx * dt; cn.y += cn.vy * dt;
        cn.a += cn.w * dt;
        const dec = Math.max(0, sp - 7 * dt) / (sp || 1);
        cn.vx *= dec; cn.vy *= dec;
        cn.w *= Math.exp(-3 * dt);
        this.query(cn.x - 0.4, cn.y - 0.4, cn.x + 0.4, cn.y + 0.4, (k, col) => {
          if (k !== 'b') return;
          if (cn.x > col.x0 - 0.3 && cn.x < col.x1 + 0.3 && cn.y > col.y0 - 0.3 && cn.y < col.y1 + 0.3) {
            const dl = cn.x - (col.x0 - 0.3), dr = col.x1 + 0.3 - cn.x, dt2 = cn.y - (col.y0 - 0.3), db = col.y1 + 0.3 - cn.y;
            const m = Math.min(dl, dr, dt2, db);
            if (m === dl) { cn.x -= dl; cn.vx = -Math.abs(cn.vx) * 0.4; }
            else if (m === dr) { cn.x += dr; cn.vx = Math.abs(cn.vx) * 0.4; }
            else if (m === dt2) { cn.y -= dt2; cn.vy = -Math.abs(cn.vy) * 0.4; }
            else { cn.y += db; cn.vy = Math.abs(cn.vy) * 0.4; }
          }
        });
      }
    }
    resetCones() {
      for (const cn of this.cones) { cn.x = cn.x0; cn.y = cn.y0; cn.vx = cn.vy = cn.w = cn.a = 0; cn.down = false; }
    }

    // Aracın en yakın duvar/engel mesafesi (yakınlık bonusu için)
    nearWall(car, range) {
      const o = car.obb();
      const rb = Math.hypot(o.hl, o.hw) + range;
      let best = 99;
      const pts = [];
      for (const [lx, ly] of [[o.hl, o.hw], [o.hl, -o.hw], [-o.hl, o.hw], [-o.hl, -o.hw], [0, o.hw], [0, -o.hw], [o.hl, 0], [-o.hl, 0]]) {
        pts.push(o.x + o.c * lx - o.s * ly, o.y + o.s * lx + o.c * ly);
      }
      this.query(o.x - rb, o.y - rb, o.x + rb, o.y + rb, (k, col) => {
        if (k === 'b') {
          if (!SOLID_KINDS[col.kind]) return;
          for (let i = 0; i < pts.length; i += 2) best = Math.min(best, U.distPointBox(pts[i], pts[i + 1], col.x0, col.y0, col.x1, col.y1));
        } else {
          if (!SOLID_CIRCS[col.kind] || col.broken) return;
          for (let i = 0; i < pts.length; i += 2) best = Math.min(best, Math.hypot(pts[i] - col.x, pts[i + 1] - col.y) - col.r);
        }
      });
      return best;
    }

    // 0 asfalt, 1 çim, 2 çakıl
    surfaceAt(x, y) {
      if (x < this.x0 || x > this.x1 || y < this.y0 || y > this.y1) return 1;
      let i = -1, j = -1;
      for (let k = 0; k <= NB; k++) {
        if (Math.abs(x - this.lx[k]) <= this.wx[k] / 2) return 0;
        if (x > this.lx[k]) i = k;
      }
      for (let k = 0; k <= NB; k++) {
        if (Math.abs(y - this.ly[k]) <= this.wy[k] / 2) return 0;
        if (y > this.ly[k]) j = k;
      }
      if (i < 0 || j < 0 || i >= NB || j >= NB) return 0;
      if (this.T[i][j] !== 'park') return 0;
      const r = this.blockRect(i, j);
      if (x < r.x0 + SW || x > r.x1 - SW || y < r.y0 + SW || y > r.y1 - SW) return 0;
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      if (Math.abs(x - cx) < 1.6 || Math.abs(y - cy) < 1.6 || Math.hypot(x - cx, y - cy) < 9) return 2;
      return 1;
    }

    // Yeniden doğma noktası: en yakın yol çizgisi, engel yoksa
    respawnPoint(x, y, heading) {
      const cands = [];
      for (let i = 0; i <= NB; i++) cands.push({ d: Math.abs(x - this.lx[i]), x: this.lx[i], y: U.clamp(y, this.y0 + 8, this.y1 - 8), v: true });
      for (let j = 0; j <= NB; j++) cands.push({ d: Math.abs(y - this.ly[j]), x: U.clamp(x, this.x0 + 8, this.x1 - 8), y: this.ly[j], v: false });
      cands.sort((a, b) => a.d - b.d);
      const c = cands[0];
      let h;
      if (c.v) h = Math.sin(heading) >= 0 ? Math.PI / 2 : -Math.PI / 2;
      else h = Math.cos(heading) >= 0 ? 0 : Math.PI;
      let px = c.x, py = c.y;
      for (let tries = 0; tries < 30; tries++) {
        if (!this.blocked(px, py, 3.2)) break;
        px += Math.cos(h) * 7; py += Math.sin(h) * 7;
        if (px < this.x0 + 6 || px > this.x1 - 6 || py < this.y0 + 6 || py > this.y1 - 6) { h += Math.PI; px += Math.cos(h) * 14; py += Math.sin(h) * 14; }
      }
      return { x: px, y: py, h };
    }
    blocked(x, y, r) {
      let hit = false;
      this.query(x - r, y - r, x + r, y + r, (k, col) => {
        if (k === 'b') { if (U.distPointBox(x, y, col.x0, col.y0, col.x1, col.y1) < r) hit = true; }
        else if (!col.broken && Math.hypot(x - col.x, y - col.y) < r + col.r) hit = true;
      });
      return hit;
    }

    // ================= ÇİZİM =================
    makeTextures() {
      const mk = (base, vari, fn) => {
        const S = 256, c = U.canvas(S, S), g = c.getContext('2d');
        const id = g.createImageData(S, S), d = id.data;
        const [r, gg, b] = U.hex2rgb(base);
        for (let i = 0; i < S * S; i++) {
          const n = (Math.random() - 0.5) * vari;
          d[i * 4] = r + n; d[i * 4 + 1] = gg + n; d[i * 4 + 2] = b + n; d[i * 4 + 3] = 255;
        }
        g.putImageData(id, 0, 0);
        if (fn) fn(g, S);
        return g.createPattern(c, 'repeat');
      };
      const wrap = (S, fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
      const specks = (g, S, n, col, sz) => {
        g.fillStyle = col;
        for (let i = 0; i < n; i++) g.fillRect(Math.random() * S, Math.random() * S, sz, sz);
      };
      const blotch = (g, S, n, col, rmin, rmax) => {
        for (let i = 0; i < n; i++) {
          const x = Math.random() * S, y = Math.random() * S, r = rmin + Math.random() * (rmax - rmin);
          wrap(S, (ox, oy) => {
            const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
            gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
            g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
          });
        }
      };
      const P = {};
      P.asphalt = mk('#2d3139', 12, (g, S) => {
        blotch(g, S, 7, 'rgba(255,255,255,0.035)', 30, 90);
        blotch(g, S, 6, 'rgba(0,0,0,0.08)', 20, 70);
        specks(g, S, 1400, 'rgba(120,125,135,0.35)', 1);
        specks(g, S, 900, 'rgba(10,10,14,0.4)', 1);
      });
      P.lot = mk('#363a41', 12, (g, S) => {
        blotch(g, S, 6, 'rgba(0,0,0,0.08)', 20, 60);
        specks(g, S, 1200, 'rgba(130,135,140,0.3)', 1);
      });
      P.dpark = mk('#2e3238', 8, (g, S) => {
        blotch(g, S, 10, 'rgba(0,0,0,0.12)', 25, 80);
        specks(g, S, 600, 'rgba(110,115,125,0.25)', 1);
      });
      P.sidewalk = mk('#9c978d', 16, (g, S) => {
        g.strokeStyle = 'rgba(60,55,50,0.35)'; g.lineWidth = 1;
        for (let k = 0; k <= S; k += 32) {
          g.beginPath(); g.moveTo(k + 0.5, 0); g.lineTo(k + 0.5, S); g.stroke();
          g.beginPath(); g.moveTo(0, k + 0.5); g.lineTo(S, k + 0.5); g.stroke();
        }
        blotch(g, S, 6, 'rgba(0,0,0,0.06)', 15, 50);
      });
      P.concrete = mk('#8b8880', 14, (g, S) => {
        g.strokeStyle = 'rgba(50,48,44,0.3)'; g.lineWidth = 1.2;
        for (let k = 0; k <= S; k += 64) {
          g.beginPath(); g.moveTo(k, 0); g.lineTo(k, S); g.stroke();
          g.beginPath(); g.moveTo(0, k); g.lineTo(S, k); g.stroke();
        }
        blotch(g, S, 8, 'rgba(0,0,0,0.07)', 20, 60);
      });
      P.grass = mk('#3c6a2d', 22, (g, S) => {
        blotch(g, S, 10, 'rgba(90,140,50,0.18)', 20, 70);
        blotch(g, S, 8, 'rgba(20,40,10,0.18)', 20, 60);
        for (let i = 0; i < 2600; i++) {
          const x = Math.random() * S, y = Math.random() * S, a = Math.random() * U.TAU, l = 2 + Math.random() * 4;
          g.strokeStyle = Math.random() < 0.5 ? 'rgba(110,160,70,0.5)' : 'rgba(30,60,20,0.45)';
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
        }
      });
      P.gravel = mk('#a49b86', 34, (g, S) => {
        specks(g, S, 1800, 'rgba(70,60,50,0.4)', 2);
        specks(g, S, 1200, 'rgba(230,225,210,0.4)', 1);
      });
      this.P = P;
      // Desen ölçeğini bir kez ayarla: dünya koordinatında doğrudan doldurulabilsin (save/scale/restore yok)
      this.patT = false;
      try {
        if (P.asphalt && typeof P.asphalt.setTransform === 'function') {
          const m = typeof DOMMatrix !== 'undefined' ? new DOMMatrix([1 / PS, 0, 0, 1 / PS, 0, 0]) : { a: 1 / PS, b: 0, c: 0, d: 1 / PS, e: 0, f: 0 };
          for (const k in P) P[k].setTransform(m);
          this.patT = true;
        }
      } catch (e) { this.patT = false; }
    }

    // Kalite kademesi (DS.Quality.TIERS öğesi)
    setQuality(Q) {
      this.Q = Q;
    }

    // Malzemeyi doldur: desen (dönüşümü bir kez ayarlı) ya da düz renk; desen dönüşümü desteklenmiyorsa eski yavaş yol
    _fillMat(ctx, mat, rule) {
      if (this.Q.flatGround || !this.patT) {
        if (!this.Q.flatGround && this._rects) return this._fillLegacy(ctx, mat);
        ctx.fillStyle = FLAT[mat];
      } else ctx.fillStyle = this.P[mat];
      ctx.fill(rule || 'nonzero');
    }
    _fillLegacy(ctx, mat) {
      // yalnızca CanvasPattern.setTransform olmayan eski tarayıcılar için
      const r = this._rects;
      for (let i = 0; i < r.length; i += 4) fillPat(ctx, this.P[mat], r[i], r[i + 1], r[i + 2], r[i + 3]);
    }

    drawGround(ctx, v, t) {
      const Q = this.Q;
      const legacy = !this.patT && !Q.flatGround;
      const rects = legacy ? (this._rects = []) : null;
      const R = (x, y, w, h) => { ctx.rect(x, y, w, h); if (rects) rects.push(x, y, w, h); };
      const begin = () => { ctx.beginPath(); if (rects) rects.length = 0; };
      // şehir dışında kalan görünür alan: çim (şehir dikdörtgeni delik)
      const inside = v.x0 >= this.x0 && v.y0 >= this.y0 && v.x1 <= this.x1 && v.y1 <= this.y1;
      if (!inside) {
        begin();
        ctx.rect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
        const cx0 = Math.max(this.x0, v.x0), cy0 = Math.max(this.y0, v.y0), cx1 = Math.min(this.x1, v.x1), cy1 = Math.min(this.y1, v.y1);
        if (cx1 > cx0 && cy1 > cy0) ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0);
        if (rects) { ctx.fillStyle = FLAT.grass; ctx.fill('evenodd'); } else this._fillMat(ctx, 'grass', 'evenodd');
      }
      // yollar: tek yol, birleşim (kavşaklar bir kez boyanır)
      begin();
      for (let i = 0; i <= NB; i++) {
        const x = this.lx[i], w = this.wx[i];
        if (x + w / 2 < v.x0 || x - w / 2 > v.x1) continue;
        const y0 = Math.max(this.y0, v.y0), y1 = Math.min(this.y1, v.y1);
        if (y1 > y0) R(x - w / 2, y0, w, y1 - y0);
      }
      for (let j = 0; j <= NB; j++) {
        const y = this.ly[j], w = this.wy[j];
        if (y + w / 2 < v.y0 || y - w / 2 > v.y1) continue;
        const x0 = Math.max(this.x0, v.x0), x1 = Math.min(this.x1, v.x1);
        if (x1 > x0) R(x0, y - w / 2, x1 - x0, w);
      }
      this._fillMat(ctx, 'asphalt');
      const vis = this._visBlocks || (this._visBlocks = []);
      vis.length = 0;
      for (const b of this.blocks) {
        if (b.x1 < v.x0 || b.x0 > v.x1 || b.y1 < v.y0 || b.y0 > v.y1) continue;
        vis.push(b);
      }
      // kaldırım halkaları (iç kısım boyanmaz)
      if (rects) {
        for (const b of vis) {
          const I = b.inner;
          fillPat(ctx, this.P.sidewalk, b.x0, b.y0, b.x1 - b.x0, SW);
          fillPat(ctx, this.P.sidewalk, b.x0, b.y1 - SW, b.x1 - b.x0, SW);
          fillPat(ctx, this.P.sidewalk, b.x0, I.y0, SW, I.y1 - I.y0);
          fillPat(ctx, this.P.sidewalk, I.x1, I.y0, SW, I.y1 - I.y0);
        }
      } else {
        ctx.beginPath();
        for (const b of vis) { const I = b.inner; ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); ctx.rect(I.x0, I.y0, I.x1 - I.x0, I.y1 - I.y0); }
        this._fillMat(ctx, 'sidewalk', 'evenodd');
      }
      // iç alanlar, malzeme başına tek dolgu
      const mats = [['concrete', 'ind'], ['lot', 'parking'], ['grass', 'park'], ['dpark', 'drift']];
      for (const [mat, type] of mats) {
        begin();
        let any = false;
        for (const b of vis) if (b.type === type) { const I = b.inner; R(I.x0, I.y0, I.x1 - I.x0, I.y1 - I.y0); any = true; }
        if (mat === 'lot') for (const b of vis) for (const c of b.courts) { R(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0); any = true; }
        if (any) this._fillMat(ctx, mat);
      }
      // bina blokları: iç zemin neredeyse tamamen binaların altında, düz renk yeter
      ctx.beginPath();
      let anyB = false;
      for (const b of vis) {
        if (b.type !== 'build') continue;
        const I = b.inner;
        // avlular ayrı boyandı; bina altı + bina arası şeritler
        ctx.rect(I.x0, I.y0, I.x1 - I.x0, I.y1 - I.y0); anyB = true;
        for (const c of b.courts) ctx.rect(c.x1, c.y0, c.x0 - c.x1, c.y1 - c.y0);
      }
      if (anyB) { ctx.fillStyle = '#7f7c75'; ctx.fill(); }
      // park yolları ve meydan
      begin();
      let anyP = false;
      for (const b of vis) if (b.type === 'park') for (const p of b.paths) { R(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0); anyP = true; }
      if (anyP) this._fillMat(ctx, 'gravel');
      ctx.beginPath();
      let anyPl = false;
      for (const b of vis) if (b.plaza) { ctx.moveTo(b.plaza.x + b.plaza.r, b.plaza.y); ctx.arc(b.plaza.x, b.plaza.y, b.plaza.r, 0, U.TAU); anyPl = true; }
      if (anyPl) { if (rects) { ctx.fillStyle = FLAT.sidewalk; ctx.fill(); } else this._fillMat(ctx, 'sidewalk'); }

      // kaldırım taşı (bordür) ve gölgesi
      ctx.beginPath();
      for (const b of vis) ctx.rect(b.x0 + 0.16, b.y0 + 0.16, b.x1 - b.x0 - 0.32, b.y1 - b.y0 - 0.32);
      ctx.lineWidth = 0.32; ctx.strokeStyle = '#c4bfb3'; ctx.stroke();
      ctx.beginPath();
      for (const b of vis) ctx.rect(b.x0 - 0.07, b.y0 - 0.07, b.x1 - b.x0 + 0.14, b.y1 - b.y0 + 0.14);
      ctx.lineWidth = 0.14; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
      ctx.beginPath();
      for (const b of vis) { const I = b.inner; ctx.rect(I.x0, I.y0, I.x1 - I.x0, I.y1 - I.y0); }
      ctx.lineWidth = 0.12; ctx.strokeStyle = 'rgba(40,36,30,0.45)'; ctx.stroke();

      // drift parkı boyaları
      for (const b of vis) if (b.type === 'drift') this._drawDriftPaint(ctx, b);

      // yol çizgileri
      const marks = this.visible(v, 'm', this._vm || (this._vm = []));
      ctx.beginPath();
      for (const m of marks) if (m.col === 'w') ctx.rect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      ctx.fillStyle = 'rgba(232,231,222,0.86)'; ctx.fill();
      ctx.beginPath();
      for (const m of marks) if (m.col === 'y') ctx.rect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      ctx.fillStyle = 'rgba(240,186,40,0.9)'; ctx.fill();

      // lekeler: türe göre toplu çizim
      if (Q.decals > 0) {
        const dec = this.visible(v, 'd', this._vd || (this._vd = []));
        ctx.beginPath();
        for (const d of dec) if (d.kind === 'manhole') { ctx.moveTo(d.x + d.r, d.y); ctx.arc(d.x, d.y, d.r, 0, U.TAU); }
        ctx.fillStyle = '#25282d'; ctx.fill();
        ctx.lineWidth = 0.07; ctx.strokeStyle = '#3e434b'; ctx.stroke();
        ctx.beginPath();
        for (const d of dec) if (d.kind === 'patch') ctx.rect(d.x - d.w / 2, d.y - d.h / 2, d.w, d.h);
        ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fill();
        ctx.lineWidth = 0.06; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
        if (Q.decals > 1) {
          ctx.beginPath();
          for (const d of dec) {
            if (d.kind !== 'crack') continue;
            ctx.moveTo(d.pts[0], d.pts[1]);
            for (let i = 2; i < d.pts.length; i += 2) ctx.lineTo(d.pts[i], d.pts[i + 1]);
          }
          ctx.lineWidth = 0.06; ctx.strokeStyle = 'rgba(12,12,16,0.55)'; ctx.stroke();
          ctx.beginPath();
          for (const d of dec) {
            if (d.kind !== 'oil') continue;
            ctx.moveTo(d.x + Math.cos(d.ang) * d.r, d.y + Math.sin(d.ang) * d.r);
            ctx.ellipse(d.x, d.y, d.r, d.r * d.e, d.ang, 0, U.TAU);
          }
          ctx.fillStyle = 'rgba(8,8,12,0.22)'; ctx.fill();
        }
      }
      // göbek adaları
      for (const is of this.islands) {
        if (is.x + 12 < v.x0 || is.x - 12 > v.x1 || is.y + 12 < v.y0 || is.y - 12 > v.y1) continue;
        ctx.beginPath(); ctx.arc(is.x, is.y, is.r + 4.6, 0, U.TAU);
        ctx.setLineDash([1.6, 1.6]); ctx.lineWidth = 0.14; ctx.strokeStyle = 'rgba(232,231,222,0.7)'; ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(is.x, is.y, is.r, 0, U.TAU);
        if (legacy) { ctx.fillStyle = FLAT.grass; ctx.fill(); } else this._fillMat(ctx, 'grass');
        ctx.lineWidth = 0.4; ctx.strokeStyle = '#d7d2c6'; ctx.stroke();
      }
      // fıskiyeler
      for (const f of this.fountains) {
        if (f.x + 6 < v.x0 || f.x - 6 > v.x1 || f.y + 6 < v.y0 || f.y - 6 > v.y1) continue;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, U.TAU);
        ctx.fillStyle = '#b8b2a5'; ctx.fill();
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r - 0.45, 0, U.TAU);
        ctx.fillStyle = '#2f6f8f'; ctx.fill();
        ctx.lineWidth = 0.08;
        for (let k = 0; k < 3; k++) {
          const ph = (t * 0.6 + k / 3) % 1;
          ctx.beginPath(); ctx.arc(f.x, f.y, 0.4 + ph * (f.r - 0.9), 0, U.TAU);
          ctx.strokeStyle = RIPPLE[Math.min(9, (ph * 10) | 0)]; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(f.x, f.y, 0.5, 0, U.TAU);
        ctx.fillStyle = 'rgba(230,248,255,0.9)'; ctx.fill();
      }
    }

    _drawDriftPaint(ctx, b) {
      for (const p of b.paint) {
        if (p.t === 'ring') {
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, U.TAU);
          ctx.setLineDash([2.2, 1.6]); ctx.lineWidth = 0.18; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.stroke();
          ctx.setLineDash([]);
        } else if (p.t === 'start') {
          const sq = 1;
          ctx.beginPath();
          for (let k = 0; k < p.w / sq; k++) for (let r = 0; r < 2; r++) if ((k + r) % 2) ctx.rect(p.x - p.w / 2 + k * sq, p.y + r * sq, sq, sq);
          ctx.fillStyle = 'rgba(240,240,235,0.85)'; ctx.fill();
          ctx.beginPath();
          for (let k = 0; k < p.w / sq; k++) for (let r = 0; r < 2; r++) if (!((k + r) % 2)) ctx.rect(p.x - p.w / 2 + k * sq, p.y + r * sq, sq, sq);
          ctx.fillStyle = 'rgba(20,20,22,0.85)'; ctx.fill();
        } else if (p.t === 'text') {
          ctx.font = '700 9px Bungee, Impact, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(255,178,62,0.22)';
          ctx.fillText(p.s, p.x, p.y);
        }
      }
    }

    drawShadows(ctx, v, env) {
      const Q = this.Q;
      if (!Q.shadows) return;
      const sx = env.sun.x, sy = env.sun.y;
      const ext = 60 * Math.max(sx, sy);
      ctx.beginPath();
      for (const s of this.solids) {
        if (s.x1 < v.x0 - ext || s.x0 > v.x1 || s.y1 < v.y0 - ext || s.y0 > v.y1) continue;
        const ox = sx * s.h, oy = sy * s.h;
        ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y0); ctx.lineTo(s.x1 + ox, s.y0 + oy);
        ctx.lineTo(s.x1 + ox, s.y1 + oy); ctx.lineTo(s.x0 + ox, s.y1 + oy); ctx.lineTo(s.x0, s.y1); ctx.closePath();
      }
      for (const ti of this.tireIsl) {
        ctx.moveTo(ti.x + sx * 1.1 + ti.r, ti.y + sy * 1.1); ctx.arc(ti.x + sx * 1.1, ti.y + sy * 1.1, ti.r, 0, U.TAU);
      }
      ctx.fillStyle = `rgba(12,16,34,${env.shadowA})`;
      ctx.fill();
      if (Q.shadows < 2) return;
      // ağaç ve direk gölgeleri
      const tall = this.visible({ x0: v.x0 - ext, y0: v.y0 - ext, x1: v.x1, y1: v.y1 }, 't', this._vs || (this._vs = []));
      const len = Math.min(4.5, 5 / Math.max(0.01, Math.hypot(sx, sy)));
      ctx.beginPath();
      for (const p of tall) {
        if (p.kind === 'tree') {
          const cx = p.x + sx * len, cy = p.y + sy * len, r = p.rc * 0.85;
          ctx.moveTo(cx + r, cy); ctx.ellipse(cx, cy, r, r * 0.9, 0, 0, U.TAU);
        }
      }
      ctx.fillStyle = `rgba(12,16,34,${env.shadowA * 0.6})`;
      ctx.fill();
      ctx.beginPath();
      for (const p of tall) {
        if (p.kind === 'lamp' && !p.broken) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + sx * 7.5, p.y + sy * 7.5); }
        else if (p.kind === 'flood') { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + sx * 16, p.y + sy * 16); }
      }
      ctx.lineWidth = 0.22; ctx.strokeStyle = `rgba(12,16,34,${env.shadowA * 0.8})`; ctx.stroke();
    }

    // Sabit dekor sprite'ları (lastik adası, klip noktası) bir kez çizilir
    _sprite(key, sizeM, draw) {
      const S = this._spr || (this._spr = {});
      if (S[key]) return S[key];
      const ppm = 24, px = Math.ceil(sizeM * ppm);
      const c = U.canvas(px, px), g = c.getContext('2d');
      g.scale(ppm, ppm); g.translate(sizeM / 2, sizeM / 2);
      draw(g);
      return (S[key] = c);
    }

    drawLowProps(ctx, v, t, M) {
      const list = this.visible(v, 'l', this._vl || (this._vl = []));
      // yangın muslukları, çöp kutuları, banklar, çalılar: türe göre toplu
      ctx.beginPath();
      for (const p of list) if (p.kind === 'hydrant' && !p.broken) { ctx.moveTo(p.x + 0.24, p.y); ctx.arc(p.x, p.y, 0.24, 0, U.TAU); }
      ctx.fillStyle = '#b8231f'; ctx.fill();
      ctx.beginPath();
      for (const p of list) if (p.kind === 'hydrant' && !p.broken) { ctx.moveTo(p.x - 0.05 + 0.12, p.y - 0.05); ctx.arc(p.x - 0.05, p.y - 0.05, 0.12, 0, U.TAU); }
      ctx.fillStyle = '#e35a4a'; ctx.fill();
      // kırık musluk: koyu kesik boru
      ctx.beginPath();
      for (const p of list) if (p.kind === 'hydrant' && p.broken) { ctx.moveTo(p.x + 0.14, p.y); ctx.arc(p.x, p.y, 0.14, 0, U.TAU); }
      ctx.fillStyle = '#5a1d1d'; ctx.fill();
      ctx.beginPath();
      for (const p of list) if (p.kind === 'bin' && !p.broken) ctx.rect(p.x - 0.3, p.y - 0.3, 0.6, 0.6);
      ctx.fillStyle = '#2f4a3a'; ctx.fill();
      ctx.beginPath();
      for (const p of list) if (p.kind === 'bush') { ctx.moveTo(p.x + p.rr, p.y); ctx.arc(p.x, p.y, p.rr, 0, U.TAU); }
      ctx.fillStyle = '#2d5626'; ctx.fill();
      ctx.beginPath();
      for (const p of list) if (p.kind === 'bush') { const r = p.rr * 0.6, x = p.x - p.rr * 0.25, y = p.y - p.rr * 0.25; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, U.TAU); }
      ctx.fillStyle = '#3f7434'; ctx.fill();
      for (const p of list) {
        if (p.kind === 'bench') {
          if (p.co === undefined) { p.co = Math.cos(p.ang); p.si = Math.sin(p.ang); }
          const a = M[0], b = M[1], c = M[2], d = M[3];
          ctx.setTransform(a * p.co + c * p.si, b * p.co + d * p.si, c * p.co - a * p.si, d * p.co - b * p.si, a * p.x + c * p.y + M[4], b * p.x + d * p.y + M[5]);
          ctx.fillStyle = '#6b4a2f'; ctx.fillRect(-0.85, -0.25, 1.7, 0.5);
          ctx.fillStyle = '#8a6440'; ctx.fillRect(-0.85, -0.25, 1.7, 0.12);
        } else if (p.kind === 'car') {
          DS.CarRender.drawParked(ctx, p, M);
        } else if (p.kind === 'clip') {
          const c = p.ref, hot = c.t > 0;
          const spr = this._sprite(hot ? 'clipHot' : 'clip', (c.r + 0.3) * 2, (g) => {
            g.beginPath(); g.arc(0, 0, c.r, 0, U.TAU);
            g.fillStyle = hot ? 'rgba(255,178,62,0.28)' : 'rgba(255,58,58,0.1)'; g.fill();
            for (let k = 0; k < 16; k++) {
              g.beginPath(); g.arc(0, 0, c.r, (k / 16) * U.TAU, ((k + 1) / 16) * U.TAU);
              g.lineWidth = 0.3; g.strokeStyle = k % 2 ? '#f2f2f2' : hot ? '#ffb23e' : '#e02424'; g.stroke();
            }
            g.beginPath(); g.arc(0, 0, 0.28, 0, U.TAU); g.fillStyle = hot ? '#ffb23e' : '#e02424'; g.fill();
          });
          const R = c.r + 0.3;
          ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
          ctx.drawImage(spr, c.x - R, c.y - R, R * 2, R * 2);
        }
      }
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      // lastik adaları
      for (const ti of this.tireIsl) {
        if (ti.x + 6 < v.x0 || ti.x - 6 > v.x1 || ti.y + 6 < v.y0 || ti.y - 6 > v.y1) continue;
        const spr = this._sprite('tires', ti.r * 2 + 1, (g) => {
          g.beginPath(); g.arc(0, 0, ti.r, 0, U.TAU); g.fillStyle = '#121316'; g.fill();
          const n = 22;
          for (let k = 0; k < n; k++) {
            const a = (k / n) * U.TAU, x = Math.cos(a) * (ti.r - 0.4), y = Math.sin(a) * (ti.r - 0.4);
            g.beginPath(); g.arc(x, y, 0.38, 0, U.TAU);
            g.fillStyle = '#1d1f23'; g.fill();
            g.lineWidth = 0.08; g.strokeStyle = k % 2 ? '#e8e8e8' : '#d22'; g.stroke();
          }
          g.beginPath(); g.arc(0, 0, ti.r - 1.1, 0, U.TAU); g.fillStyle = '#2b4a24'; g.fill();
        });
        const R = ti.r + 0.5;
        ctx.drawImage(spr, ti.x - R, ti.y - R, R * 2, R * 2);
      }
      // dubalar
      for (const cn of this.cones) {
        if (cn.x < v.x0 || cn.x > v.x1 || cn.y < v.y0 || cn.y > v.y1) continue;
        if (cn.down) {
          ctx.save(); ctx.translate(cn.x, cn.y); ctx.rotate(cn.a);
          ctx.beginPath(); ctx.moveTo(0.38, 0); ctx.lineTo(-0.3, -0.2); ctx.lineTo(-0.3, 0.2); ctx.closePath();
          ctx.fillStyle = '#ff6a13'; ctx.fill();
          ctx.fillStyle = '#f2f2f2'; ctx.fillRect(-0.05, -0.12, 0.12, 0.24);
          ctx.restore();
        } else {
          ctx.fillStyle = '#1b1b1b'; ctx.fillRect(cn.x - 0.26, cn.y - 0.26, 0.52, 0.52);
          ctx.beginPath(); ctx.arc(cn.x, cn.y, 0.2, 0, U.TAU); ctx.fillStyle = '#ff6a13'; ctx.fill();
          ctx.beginPath(); ctx.arc(cn.x, cn.y, 0.12, 0, U.TAU); ctx.fillStyle = '#f2f2f2'; ctx.fill();
        }
      }
    }

    // Uzun nesneler (lamba, projektör, ağaç) — kare başına bir kez toplanır, üç çizimde paylaşılır
    collectTall(v, M, W, H) {
      const out = this._vt || (this._vt = []);
      this.visible({ x0: v.x0 - 14, y0: v.y0 - 14, x1: v.x1 + 14, y1: v.y1 + 14 }, 't', out);
      // döndürülmüş ekran testiyle sık eleme (lamba ışığı 13 m)
      const z = Math.hypot(M[0], M[1]);
      let n = 0;
      for (let i = 0; i < out.length; i++) {
        const p = out[i];
        const r = (p.kind === 'tree' ? p.rc + 1 : 14) * z;
        const sx = M[0] * p.x + M[2] * p.y + M[4], sy = M[1] * p.x + M[3] * p.y + M[5];
        if (sx < -r || sx > W + r || sy < -r || sy > H + r) continue;
        out[n++] = p;
      }
      out.length = n;
      return out;
    }

    drawTallProps(ctx, cam, env, list) {
      const kl = this.camH / (this.camH - 7.5), kf = this.camH / (this.camH - 16), kt = this.camH / (this.camH - 6.5);
      const cx = cam.x, cy = cam.y;
      // direkler (tek çizgi yolu)
      ctx.beginPath();
      for (const p of list) {
        if (p.kind === 'lamp') {
          if (p.broken) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(p.fall) * 7.5, p.y + Math.sin(p.fall) * 7.5); }
          else {
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(cx + (p.x - cx) * kl, cy + (p.y - cy) * kl);
            ctx.lineTo(cx + (p.x + p.nx * 1.7 - cx) * kl, cy + (p.y + p.ny * 1.7 - cy) * kl);
          }
        } else if (p.kind === 'flood') {
          ctx.moveTo(p.x, p.y); ctx.lineTo(cx + (p.x - cx) * kf, cy + (p.y - cy) * kf);
        }
      }
      ctx.lineWidth = 0.17; ctx.lineCap = 'round'; ctx.strokeStyle = '#3b3f46'; ctx.stroke(); ctx.lineCap = 'butt';
      // lamba gövdeleri ve camları: döndürülmüş dörtgenler, iki dolgu
      const quad = (x, y, c, s, hx, hy) => {
        ctx.moveTo(x + c * hx - s * hy, y + s * hx + c * hy);
        ctx.lineTo(x - c * hx - s * hy, y - s * hx + c * hy);
        ctx.lineTo(x - c * hx + s * hy, y - s * hx - c * hy);
        ctx.lineTo(x + c * hx + s * hy, y + s * hx - c * hy);
        ctx.closePath();
      };
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (const p of list) {
          if (p.kind !== 'lamp') continue;
          let x, y, c, s;
          if (p.broken) { x = p.x + Math.cos(p.fall) * 7.5; y = p.y + Math.sin(p.fall) * 7.5; c = Math.cos(p.fall); s = Math.sin(p.fall); }
          else { x = cx + (p.x + p.nx * 1.7 - cx) * kl; y = cy + (p.y + p.ny * 1.7 - cy) * kl; c = p.nx; s = p.ny; }
          if (pass === 0) quad(x, y, c, s, 0.45, 0.22); else quad(x, y, c, s, 0.32, 0.13);
        }
        ctx.fillStyle = pass === 0 ? '#2a2d33' : env.lamps ? '#ffe2a6' : '#8d9096';
        ctx.fill();
      }
      for (const p of list) {
        if (p.kind !== 'flood') continue;
        const hx = cx + (p.x - cx) * kf, hy = cy + (p.y - cy) * kf;
        const a = Math.atan2(p.ty - p.y, p.tx - p.x);
        ctx.save(); ctx.translate(hx, hy); ctx.rotate(a);
        ctx.fillStyle = '#25282e'; ctx.fillRect(-0.5, -1.4, 1.0, 2.8);
        ctx.fillStyle = env.lamps ? '#fff6dc' : '#9aa0a8';
        for (let k = -1; k <= 1; k++) ctx.fillRect(0.1, k * 0.85 - 0.3, 0.35, 0.6);
        ctx.restore();
      }
      // ağaç tepeleri (tek atlas)
      const atlas = DS.Sprites.treeAtlas;
      for (const p of list) {
        if (p.kind !== 'tree') continue;
        const x = cx + (p.x - cx) * kt, y = cy + (p.y - cy) * kt, r = p.rc * kt;
        ctx.drawImage(atlas, (p.v & 1) * 128, (p.v >> 1) * 128, 128, 128, x - r, y - r, r * 2, r * 2);
      }
    }

    // Binalar ve hacimli nesneler — kameraya göre uzaktan yakına.
    // Işık haritası istenirse siluet/pencere geometrisi tampona kaydedilir (Path2D yok)
    drawSolids(ctx, v, cam, env, wantLight, M, W, H) {
      const z = Math.hypot(M[0], M[1]), camH = this.camH;
      const list = this._vsol || (this._vsol = []);
      list.length = 0;
      const ext = 40;
      for (const s of this.solids) {
        if (s.x1 < v.x0 - ext || s.x0 > v.x1 + ext || s.y1 < v.y0 - ext || s.y0 > v.y1 + ext) continue;
        // projeksiyonlu kutu (taban ∪ çatı) döndürülmüş ekrana değiyor mu?
        const k = camH / (camH - s.h);
        const rx0 = cam.x + (s.x0 - cam.x) * k, rx1 = cam.x + (s.x1 - cam.x) * k;
        const ry0 = cam.y + (s.y0 - cam.y) * k, ry1 = cam.y + (s.y1 - cam.y) * k;
        const bx0 = Math.min(s.x0, rx0), bx1 = Math.max(s.x1, rx1), by0 = Math.min(s.y0, ry0), by1 = Math.max(s.y1, ry1);
        const mx = (bx0 + bx1) / 2, my = (by0 + by1) / 2, rad = Math.hypot(bx1 - bx0, by1 - by0) / 2 * z;
        const sx = M[0] * mx + M[2] * my + M[4], sy = M[1] * mx + M[3] * my + M[5];
        if (sx < -rad || sx > W + rad || sy < -rad || sy > H + rad) continue;
        const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
        s._d = (cx - cam.x) * (cx - cam.x) + (cy - cam.y) * (cy - cam.y);
        list.push(s);
      }
      list.sort((a, b) => b._d - a._d);
      this.laN = 0;
      this._wantLight = wantLight;
      const neon = this.neonVis || (this.neonVis = []);
      neon.length = 0;
      for (const s of list) this._drawSolid(ctx, s, cam, env, z);
    }

    // ışık tamponu: [nSil, nLit, ...silüet dörtgenleri(8), ...pencere dörtgenleri(8)]
    _laReserve(n) {
      if (!this.la) this.la = new Float32Array(16384);
      if (this.laN + n > this.la.length) {
        const a = new Float32Array(Math.max(this.la.length * 2, this.laN + n + 1024));
        a.set(this.la.subarray(0, this.laN)); this.la = a;
      }
    }
    _laQuad(x0, y0, x1, y1, x2, y2, x3, y3) {
      const a = this.la, n = this.laN;
      a[n] = x0; a[n + 1] = y0; a[n + 2] = x1; a[n + 3] = y1; a[n + 4] = x2; a[n + 5] = y2; a[n + 6] = x3; a[n + 7] = y3;
      this.laN = n + 8;
    }

    _winPrep(s) {
      // pencere dörtgenleri yalnızca yüksekliğe bağlı: bir kez hesapla
      const camH = this.camH, S = (h) => camH / (camH - h);
      const floors = Math.min(16, Math.floor((s.h - 1.6) / 3.3));
      const lens = [s.x1 - s.x0, s.y1 - s.y0, s.x1 - s.x0, s.y1 - s.y0];
      s.wq = [];
      for (let e = 0; e < 4; e++) {
        const cols = Math.max(1, Math.min(12, Math.floor(lens[e] / 3.6)));
        const band = [], grid = [], lit = [];
        for (let f = 0; f < floors; f++) {
          const k0 = S(1.5 + f * 3.3), k1 = S(1.5 + f * 3.3 + 1.6);
          band.push(0.04, 0.96, k0, k1);
          for (let c = 0; c < cols; c++) {
            grid.push((c + 0.18) / cols, (c + 0.82) / cols, k0, k1);
            if (U.hash(s.id * 7 + e, f * 131 + c) < s.lit) lit.push((c + 0.16) / cols, (c + 0.84) / cols, k0, k1);
          }
        }
        s.wq.push({ band: new Float32Array(band), grid: new Float32Array(grid), lit: new Float32Array(lit), fk: floors ? S(3.1) - S(1.5) : 0 });
      }
    }

    _drawSolid(ctx, s, cam, env, z) {
      const camH = this.camH, Q = this.Q;
      const k = camH / (camH - s.h);
      const cx = cam.x, cy = cam.y;
      const BX = this._bx || (this._bx = new Float64Array(4)), BY = this._by || (this._by = new Float64Array(4));
      const RX = this._rx || (this._rx = new Float64Array(4)), RY = this._ry || (this._ry = new Float64Array(4));
      BX[0] = s.x0; BX[1] = s.x1; BX[2] = s.x1; BX[3] = s.x0;
      BY[0] = s.y0; BY[1] = s.y0; BY[2] = s.y1; BY[3] = s.y1;
      for (let i = 0; i < 4; i++) { RX[i] = cx + (BX[i] - cx) * k; RY[i] = cy + (BY[i] - cy) * k; }
      const night = env.windows;
      // alçak bariyerler dahil her katı cisim ışığı keser (eski davranış)
      const rec = this._wantLight;
      let hdr = 0;
      if (rec) { this._laReserve(2 + 8 * 5); hdr = this.laN; this.la[hdr] = 0; this.la[hdr + 1] = 0; this.laN += 2; }
      let visMask = 0;
      for (let e = 0; e < 4; e++) {
        const i = e, j = (e + 1) & 3;
        const mx = (BX[i] + BX[j]) / 2, my = (BY[i] + BY[j]) / 2;
        if (WN[e * 2] * (cx - mx) + WN[e * 2 + 1] * (cy - my) <= 0) continue;
        visMask |= 1 << e;
        ctx.beginPath();
        ctx.moveTo(BX[i], BY[i]); ctx.lineTo(BX[j], BY[j]); ctx.lineTo(RX[j], RY[j]); ctx.lineTo(RX[i], RY[i]); ctx.closePath();
        ctx.fillStyle = s.wc[e]; ctx.fill();
        if (rec) { this._laQuad(BX[i], BY[i], BX[j], BY[j], RX[j], RY[j], RX[i], RY[i]); this.la[hdr]++; }
      }
      // cephe detayları
      if (s.kind === 'bld' && visMask) {
        if (!s.wq) this._winPrep(s);
        const winMode = Q.windows;
        let glassOpen = false, litN = 0;
        // cam bantları / ızgara
        if (winMode > 0) {
          ctx.beginPath();
          for (let e = 0; e < 4; e++) {
            if (!(visMask & (1 << e))) continue;
            const W = s.wq[e], i = e, j = (e + 1) & 3;
            const mx = (BX[i] + BX[j]) / 2 - cx, my = (BY[i] + BY[j]) / 2 - cy;
            const floorPx = W.fk * Math.hypot(mx, my) * z;
            // yalnızca alt kademelerde, alt piksel boyuna inmiş cepheleri atla
            if (winMode < 3 && floorPx < 1) continue;
            // binanın kendi pencere tipi korunur; ızgara yalnızca uzakta / düşük kademede banda iner
            const arr = s.win === 'band' || winMode === 1 || (winMode === 2 && floorPx < 6) ? W.band : W.grid;
            this._emitQuads(ctx, arr, BX[i] - cx, BY[i] - cy, BX[j] - BX[i], BY[j] - BY[i], cx, cy, null);
            glassOpen = true;
          }
          if (glassOpen) { ctx.fillStyle = s.glass; ctx.fill(); }
        }
        // yanan pencereler (gece)
        if (night) {
          ctx.beginPath();
          for (let e = 0; e < 4; e++) {
            if (!(visMask & (1 << e))) continue;
            const W = s.wq[e], i = e, j = (e + 1) & 3;
            if (!W.lit.length) continue;
            const mx = (BX[i] + BX[j]) / 2 - cx, my = (BY[i] + BY[j]) / 2 - cy;
            if (Q.windows < 3 && W.fk * Math.hypot(mx, my) * z < (Q.windows ? 1.5 : 3)) continue;
            litN += this._emitQuads(ctx, W.lit, BX[i] - cx, BY[i] - cy, BX[j] - BX[i], BY[j] - BY[i], cx, cy, rec ? this : null);
          }
          if (litN) { ctx.fillStyle = '#ffd88f'; ctx.fill(); }
          if (rec) this.la[hdr + 1] = litN;
        }
      } else if (s.kind !== 'bld' && visMask && Q.windows > 0) this._solidFacade(ctx, s, BX, BY, k, cam, visMask);
      // çatı
      ctx.beginPath();
      ctx.moveTo(RX[0], RY[0]); ctx.lineTo(RX[1], RY[1]); ctx.lineTo(RX[2], RY[2]); ctx.lineTo(RX[3], RY[3]); ctx.closePath();
      ctx.fillStyle = s.roof; ctx.fill();
      if (rec) {
        // çatı silüeti pencerelerden önce okunmalı: başlık sayıları bunu belirler, sırayı replay düzeltir
        this._laReserve(8);
        this._laQuad(RX[0], RY[0], RX[1], RY[1], RX[2], RY[2], RX[3], RY[3]);
        this.la[hdr]++;
      }
      this._roof(ctx, s, k, cam, RX, RY, BX, BY);
    }

    // dörtgen listesini (u0,u1,k0,k1) yola ekler; rec verilirse ışık tamponuna da yazar
    _emitQuads(ctx, arr, ax, ay, dx, dy, cx, cy, rec) {
      const n = arr.length;
      if (rec) rec._laReserve(n * 2);
      for (let q = 0; q < n; q += 4) {
        const u0 = arr[q], u1 = arr[q + 1], k0 = arr[q + 2], k1 = arr[q + 3];
        const x0 = ax + dx * u0, y0 = ay + dy * u0, x1 = ax + dx * u1, y1 = ay + dy * u1;
        const p0x = cx + x0 * k0, p0y = cy + y0 * k0, p1x = cx + x1 * k0, p1y = cy + y1 * k0;
        const p2x = cx + x1 * k1, p2y = cy + y1 * k1, p3x = cx + x0 * k1, p3y = cy + y0 * k1;
        ctx.moveTo(p0x, p0y); ctx.lineTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.lineTo(p3x, p3y); ctx.closePath();
        if (rec) rec._laQuad(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y);
      }
      return n / 4;
    }

    _solidFacade(ctx, s, BX, BY, k, cam, visMask) {
      const camH = this.camH, cx = cam.x, cy = cam.y;
      const P = (i, j, u, kk) => {
        const x = BX[i] + (BX[j] - BX[i]) * u, y = BY[i] + (BY[j] - BY[i]) * u;
        return [cx + (x - cx) * kk, cy + (y - cy) * kk];
      };
      for (let e = 0; e < 4; e++) {
        if (!(visMask & (1 << e))) continue;
        const i = e, j = (e + 1) & 3;
        const len = Math.hypot(BX[j] - BX[i], BY[j] - BY[i]);
        if (s.kind === 'ware') {
          ctx.beginPath();
          const n = Math.floor(len / 8);
          for (let c = 1; c < n; c++) { const a = P(i, j, c / n, 1), b = P(i, j, c / n, k); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
          ctx.lineWidth = 0.12; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
          if (len > 20) {
            const kd = camH / (camH - 5);
            const a = P(i, j, 0.42, 1), b = P(i, j, 0.58, 1), c2 = P(i, j, 0.58, kd), d = P(i, j, 0.42, kd);
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
            ctx.fillStyle = 'rgba(40,44,50,0.75)'; ctx.fill();
          }
        } else if (s.kind === 'cont' && this.Q.windows > 1) {
          ctx.beginPath();
          const n = Math.floor(len / 0.5);
          for (let c = 1; c < n; c++) { const a = P(i, j, c / n, 1), b = P(i, j, c / n, k); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
          ctx.lineWidth = 0.05; ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.stroke();
        } else if (s.kind === 'barrier') {
          ctx.beginPath();
          const n = Math.max(1, Math.floor(len / 2));
          for (let c = 0; c < n; c += 2) {
            const a = P(i, j, c / n, 1), b = P(i, j, (c + 1) / n, 1), c2 = P(i, j, (c + 1) / n, k), d = P(i, j, c / n, k);
            ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
          }
          ctx.fillStyle = '#c8202a'; ctx.fill();
        } else if (s.kind === 'stand') {
          ctx.beginPath();
          for (let f = 0; f < 3; f++) {
            const k0 = camH / (camH - (0.6 + f * 1.2)), k1 = camH / (camH - (1.0 + f * 1.2));
            const a = P(i, j, 0.02, k0), b = P(i, j, 0.98, k0), c2 = P(i, j, 0.98, k1), d = P(i, j, 0.02, k1);
            ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
          }
          ctx.fillStyle = 'rgba(255,178,62,0.55)'; ctx.fill();
        }
      }
    }

    _roof(ctx, s, k, cam, RX, RY, BX, BY) {
      const camH = this.camH, Q = this.Q, cx = cam.x, cy = cam.y;
      const px = (x, kk) => cx + (x - cx) * kk, py = (y, kk) => cy + (y - cy) * kk;
      if (s.kind === 'bld') {
        const ins = 0.7;
        const ax = px(s.x0 + ins, k), ay = py(s.y0 + ins, k), bx = px(s.x1 - ins, k), by = py(s.y1 - ins, k);
        ctx.lineWidth = 0.3; ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.strokeRect(ax, ay, bx - ax, by - ay);
        if (Q.roofDetail) {
          ctx.lineWidth = 0.14; ctx.strokeStyle = 'rgba(255,255,255,0.12)';
          ctx.strokeRect(RX[0] + 0.1, RY[0] + 0.1, RX[2] - RX[0] - 0.2, RY[2] - RY[0] - 0.2);
          for (const d of s.det) {
            if (d.t === 'ac') {
              const kk = camH / (camH - s.h - 1.2);
              ctx.fillStyle = 'rgba(0,0,0,0.25)';
              ctx.fillRect(px(d.x0, k) + 0.25, py(d.y0, k) + 0.25, px(d.x1, k) - px(d.x0, k), py(d.y1, k) - py(d.y0, k));
              const q0x = px(d.x0, kk), q0y = py(d.y0, kk), q1x = px(d.x1, kk), q1y = py(d.y1, kk);
              ctx.fillStyle = '#b9bcc0'; ctx.fillRect(q0x, q0y, q1x - q0x, q1y - q0y);
              ctx.beginPath(); ctx.arc((q0x + q1x) / 2, (q0y + q1y) / 2, Math.min(q1x - q0x, q1y - q0y) * 0.3, 0, U.TAU);
              ctx.fillStyle = '#6d7176'; ctx.fill();
            } else if (d.t === 'tank') {
              const kk = camH / (camH - s.h - 3);
              ctx.beginPath(); ctx.arc(px(d.x, kk), py(d.y, kk), d.r * kk, 0, U.TAU); ctx.fillStyle = '#8b6a4c'; ctx.fill();
              ctx.lineWidth = 0.12; ctx.strokeStyle = '#5d4532'; ctx.stroke();
            } else if (d.t === 'heli') {
              const hx = px(d.x, k), hy = py(d.y, k), r = d.r * k;
              ctx.beginPath(); ctx.arc(hx, hy, r, 0, U.TAU);
              ctx.lineWidth = 0.4; ctx.strokeStyle = 'rgba(255,214,90,0.85)'; ctx.stroke();
              // 'H' harfi: yazı yerine üç dikdörtgen (her karede font çözümlemesi yok)
              ctx.fillStyle = 'rgba(255,255,255,0.8)';
              const w = r * 0.12, hh = r * 0.55;
              ctx.fillRect(hx - r * 0.32, hy - hh, w, hh * 2); ctx.fillRect(hx + r * 0.32 - w, hy - hh, w, hh * 2);
              ctx.fillRect(hx - r * 0.32, hy - w / 2, r * 0.64, w);
            }
          }
        }
        if (s.neon) {
          const e = s.neon.e, i = e, j = (e + 1) & 3;
          const kk = camH / (camH - s.h - 1.6);
          if (!s._neon) s._neon = new Float64Array(4);
          s._neon[0] = px(BX[i] + (BX[j] - BX[i]) * 0.2, kk); s._neon[1] = py(BY[i] + (BY[j] - BY[i]) * 0.2, kk);
          s._neon[2] = px(BX[i] + (BX[j] - BX[i]) * 0.8, kk); s._neon[3] = py(BY[i] + (BY[j] - BY[i]) * 0.8, kk);
          this.neonVis.push(s);
        }
      } else if (s.kind === 'ware') {
        ctx.beginPath();
        if (s.x1 - s.x0 > s.y1 - s.y0) for (let y = s.y0 + 1.2; y < s.y1; y += 1.2) { ctx.moveTo(px(s.x0, k), py(y, k)); ctx.lineTo(px(s.x1, k), py(y, k)); }
        else for (let x = s.x0 + 1.2; x < s.x1; x += 1.2) { ctx.moveTo(px(x, k), py(s.y0, k)); ctx.lineTo(px(x, k), py(s.y1, k)); }
        ctx.lineWidth = 0.1; ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.stroke();
      } else if (s.kind === 'cont') {
        if (Q.windows > 1) {
          ctx.beginPath();
          for (let x = s.x0 + 0.6; x < s.x1; x += 0.6) { ctx.moveTo(px(x, k), py(s.y0, k)); ctx.lineTo(px(x, k), py(s.y1, k)); }
          ctx.lineWidth = 0.05; ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.stroke();
        }
      } else if (s.kind === 'barrier') {
        ctx.beginPath();
        const horiz = s.x1 - s.x0 > s.y1 - s.y0;
        const L = horiz ? s.x1 - s.x0 : s.y1 - s.y0;
        for (let c = 0; c < L; c += 4) {
          const e2 = Math.min(L, c + 2);
          const ax = horiz ? px(s.x0 + c, k) : px(s.x0, k), ay = horiz ? py(s.y0, k) : py(s.y0 + c, k);
          const bx = horiz ? px(s.x0 + e2, k) : px(s.x1, k), by = horiz ? py(s.y1, k) : py(s.y0 + e2, k);
          ctx.rect(ax, ay, bx - ax, by - ay);
        }
        ctx.fillStyle = '#d0232c'; ctx.fill();
      } else if (s.kind === 'rail') {
        if (Q.windows > 0) {
          ctx.beginPath();
          const horiz = s.x1 - s.x0 > s.y1 - s.y0;
          const L = horiz ? s.x1 - s.x0 : s.y1 - s.y0;
          for (let c = 0; c < L; c += 2.5) {
            const ax = horiz ? px(s.x0 + c, k) : px((s.x0 + s.x1) / 2, k), ay = horiz ? py((s.y0 + s.y1) / 2, k) : py(s.y0 + c, k);
            ctx.moveTo(ax + 0.12, ay); ctx.arc(ax, ay, 0.12, 0, U.TAU);
          }
          ctx.fillStyle = '#5c636b'; ctx.fill();
        }
      } else if (s.kind === 'stand') {
        ctx.beginPath();
        for (let y = s.y0 + 0.8; y < s.y1; y += 1.3) { ctx.moveTo(px(s.x0, k), py(y, k)); ctx.lineTo(px(s.x1, k), py(y, k)); }
        ctx.lineWidth = 0.35; ctx.strokeStyle = 'rgba(255,90,60,0.6)'; ctx.stroke();
      }
    }

    // Gece ışık haritasına zemin ışıkları ('lighter' modunda)
    drawLightSources(lctx, env, list, M, W, H) {
      const spr = DS.Sprites;
      lctx.globalAlpha = env.lampA;
      for (const p of list) {
        if (p.kind === 'lamp' && !p.broken) {
          const x = p.x + p.nx * 1.9, y = p.y + p.ny * 1.9, r = 13;
          lctx.drawImage(spr.sodium, x - r, y - r, r * 2, r * 2);
        }
      }
      // projektörler: uzun menzil, ayrı ve sıkı eleme
      const z = Math.hypot(M[0], M[1]), R = this.Q.flood;
      for (const p of this.floods) {
        const a = Math.atan2(p.ty - p.y, p.tx - p.x);
        const x = p.x + Math.cos(a) * 30, y = p.y + Math.sin(a) * 30;
        const sx = M[0] * x + M[2] * y + M[4], sy = M[1] * x + M[3] * y + M[5], rr = R * z;
        if (sx < -rr || sx > W + rr || sy < -rr || sy > H + rr) continue;
        lctx.drawImage(spr.white, x - R, y - R, R * 2, R * 2);
      }
      lctx.globalAlpha = 1;
    }
    // Bina siluetleri ışık haritasında ışığı keser, yanan pencereler aydınlatır (kayıttan oynatma)
    drawSolidsLight(lctx, env) {
      const a = this.la;
      if (!a || !this.laN) return;
      let i = 0;
      while (i < this.laN) {
        const nSil = a[i], nLit = a[i + 1];
        i += 2;
        // kayıt sırası: duvarlar, (pencereler), çatı — silüet = duvarlar + çatı
        const wallN = nSil - 1;
        lctx.beginPath();
        for (let q = 0; q < wallN; q++, i += 8) {
          lctx.moveTo(a[i], a[i + 1]); lctx.lineTo(a[i + 2], a[i + 3]); lctx.lineTo(a[i + 4], a[i + 5]); lctx.lineTo(a[i + 6], a[i + 7]); lctx.closePath();
        }
        const litStart = i;
        i += nLit * 8;
        lctx.moveTo(a[i], a[i + 1]); lctx.lineTo(a[i + 2], a[i + 3]); lctx.lineTo(a[i + 4], a[i + 5]); lctx.lineTo(a[i + 6], a[i + 7]); lctx.closePath();
        i += 8;
        lctx.fillStyle = env.bldAmb; lctx.fill();
        if (nLit) {
          lctx.beginPath();
          for (let q = 0, j = litStart; q < nLit; q++, j += 8) {
            lctx.moveTo(a[j], a[j + 1]); lctx.lineTo(a[j + 2], a[j + 3]); lctx.lineTo(a[j + 4], a[j + 5]); lctx.lineTo(a[j + 6], a[j + 7]); lctx.closePath();
          }
          lctx.fillStyle = '#fff4dc'; lctx.fill();
        }
      }
    }
    // Parlama katmanı ('lighter')
    drawEmissive(ctx, cam, env, t, list) {
      const spr = DS.Sprites;
      const kl = this.camH / (this.camH - 7.5), kf = this.camH / (this.camH - 16);
      ctx.globalAlpha = 0.9 * env.lampA;
      for (const p of list) {
        if (p.kind === 'lamp' && !p.broken) {
          const x = cam.x + (p.x + p.nx * 1.7 - cam.x) * kl, y = cam.y + (p.y + p.ny * 1.7 - cam.y) * kl;
          ctx.drawImage(spr.sodium, x - 2.2, y - 2.2, 4.4, 4.4);
        } else if (p.kind === 'flood') {
          const x = cam.x + (p.x - cam.x) * kf, y = cam.y + (p.y - cam.y) * kf;
          ctx.drawImage(spr.white, x - 4, y - 4, 8, 8);
        }
      }
      ctx.globalAlpha = 1;
      // neon tabelalar (yalnızca bu karede çizilen binalar)
      const neon = this.neonVis || [];
      if (!neon.length) return;
      ctx.lineCap = 'round';
      for (const s of neon) {
        const n = s._neon;
        const flick = 0.75 + 0.25 * Math.sin(t * 9 + s.id) * Math.sin(t * 2.3 + s.id * 3);
        ctx.globalAlpha = 0.35 * flick; ctx.lineWidth = 2.2; ctx.strokeStyle = s.neon.col;
        ctx.beginPath(); ctx.moveTo(n[0], n[1]); ctx.lineTo(n[2], n[3]); ctx.stroke();
        ctx.globalAlpha = 0.95 * flick; ctx.lineWidth = 0.45; ctx.strokeStyle = '#ffffff';
        ctx.beginPath(); ctx.moveTo(n[0], n[1]); ctx.lineTo(n[2], n[3]); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineCap = 'butt';
    }

    // Mini harita görüntüsü
    buildMinimap() {
      const sc = 0.28;
      const c = U.canvas(this.W * sc, this.H * sc), g = c.getContext('2d');
      g.scale(sc, sc);
      g.fillStyle = '#20381f'; g.fillRect(0, 0, this.W, this.H);
      g.fillStyle = '#5b6069';
      g.fillRect(this.x0, this.y0, this.x1 - this.x0, this.y1 - this.y0);
      for (const b of this.blocks) {
        g.fillStyle = '#3a3f47'; g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        const I = b.inner;
        g.fillStyle = b.type === 'park' ? '#2f6b35' : b.type === 'drift' ? '#5a4520' : b.type === 'parking' ? '#454a52' : '#2c3037';
        g.fillRect(I.x0, I.y0, I.x1 - I.x0, I.y1 - I.y0);
      }
      g.fillStyle = '#181b21';
      for (const s of this.solids) if (s.kind === 'bld' || s.kind === 'ware') g.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
      g.fillStyle = '#7a5a2a';
      for (const s of this.solids) if (s.kind === 'cont') g.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
      g.fillStyle = '#ffb23e';
      for (const ti of this.tireIsl) { g.beginPath(); g.arc(ti.x, ti.y, ti.r + 2, 0, U.TAU); g.fill(); }
      g.fillStyle = '#2f6b35';
      for (const is of this.islands) { g.beginPath(); g.arc(is.x, is.y, is.r + 1, 0, U.TAU); g.fill(); }
      this.mini = { c, sc };
    }
  }

  DS.City = City;
  DS.City.NB = NB;
  DS.City.fillPat = fillPat;
})();
