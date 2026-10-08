'use strict';
// Açık şehir navigasyonu: kavşak/şerit grafiği (sağdan trafik), kavşak çatışmaları ve ışıklar,
// yaya grafiği (CSR), 1 m zemin/görüş ızgarası, A* rota, akış alanı, GPS, doğma noktaları ve yerler.
// İlk açık şehir başlangıcında bir kez kurulur; deterministik (Math.random yok).
// Koordinatlar: metre, x doğu(+), y güney(+). Yön h: 0 doğu, +PI/2 güney; sağ vektör (−sin h, cos h).
//
// nav.places (SPEC §5.7; poz = {x, y, h}, dikdörtgen = {x0, y0, x1, y1}; her yerde x, y = işaret/blip noktası):
//   safehouse: { name, i, j, x, y, garage (bld katısı), door (alçak prop), trigger (kapı tetikleyicisi),
//                walker|spawn (yaya doğuşu), car|carSpawn (kendi araç), clear (kalıcı kaldırılan park alanı) }
//   spray:     { name, i, j, x, y, trigger, door, exit (araç çıkış pozu) }
//   hospital:  { name, i, j, x, y, respawn|spawn, sign }
//   police:    { name, i, j, x, y, respawn|spawn, sign, lanes|copLanes (şerit tanımları [v,i,j,dir,k,f]),
//                spawns: [{x, y, h, lane, s}] (polis doğma noktaları) }
//   phones:    [{ i, bi, bj, x, y, sx, sy (duruş noktası), prop, col (r 0.3 çarpışma dairesi) }] × 12
//   crane:     { name, x, y, r, sign }        driftGate: { name, x, y }
//   hideZones: [{ x0, y0, x1, y1, type: 'parking'|'park' }]
(function () {
  const DS = window.DS, U = DS.U;
  const PI = Math.PI, TAU = PI * 2;
  const NB = 9;            // her eksende blok sayısı (city.js ile aynı)
  const SW = 3.5;          // kaldırım genişliği
  const O = 2.9;           // yaya şeridi: bordürden içeri (ölçülmüş, engelsiz bant 2.55–3.25)
  const K = 0.5523;        // çeyrek daire Bezier katsayısı
  const RC = 7.8;          // göbek halka yarıçapı
  const SIG_C = 27;        // ışık çevrimi (s)
  const BK = 32;           // doğma örnekleri kova boyu (m)
  const HEAD = [-PI / 2, 0, PI / 2, PI]; // bacak yönü (merkezden dışarı): K, D, G, B
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const wrap = (a) => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const laneOff = (w) => (w >= 22 ? [w / 8 + 0.13, (3 * w) / 8 - 0.29] : [w / 4]);
  const vmaxOf = (w) => (w >= 24 ? 15 : w >= 22 ? 14 : 11);

  // ---------- ince eğri örnekleme (yalnız kurulumda) ----------
  const CX = [], CY = [], CH = [];
  const cReset = () => { CX.length = 0; CY.length = 0; CH.length = 0; };
  const cPush = (x, y, h) => { CX.push(x); CY.push(y); CH.push(h); };
  // kübik Bezier (analitik teğet)
  const cBezier = (p0x, p0y, h0, p3x, p3y, h3, A, B, n) => {
    const p1x = p0x + Math.cos(h0) * A * K, p1y = p0y + Math.sin(h0) * A * K;
    const p2x = p3x - Math.cos(h3) * B * K, p2y = p3y - Math.sin(h3) * B * K;
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = 1 - t;
      const x = u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
      const y = u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
      const dx = 3 * u * u * (p1x - p0x) + 6 * u * t * (p2x - p1x) + 3 * t * t * (p3x - p2x);
      const dy = 3 * u * u * (p1y - p0y) + 6 * u * t * (p2y - p1y) + 3 * t * t * (p3y - p2y);
      cPush(x, y, dx * dx + dy * dy > 1e-12 ? Math.atan2(dy, dx) : k ? h3 : h0);
    }
  };
  // sağa dönen teğet yay: (px,py)'den h yönüyle, yarıçap rho, açı tau (y aşağıda sağ = h artar)
  const cRightArc = (px, py, h, rho, tau, n, skip0) => {
    const cx = px - Math.sin(h) * rho, cy = py + Math.cos(h) * rho;
    for (let k = skip0 ? 1 : 0; k <= n; k++) {
      const a = h - PI / 2 + (tau * k) / n;
      cPush(cx + Math.cos(a) * rho, cy + Math.sin(a) * rho, a + PI / 2);
    }
  };
  // ince eğriyi yeniden örnekle -> Float32Array [x,y,h,s]*: ardışık köşeler ≤ 1 m ve ≤ 5° yön farkı
  // (dar sağ dönüşlerde sık, düzlükte 1 m). s = yay uzunluğu.
  const DH = (5 * PI) / 180;
  const OUT = [];
  const cResample = (h0, h1) => {
    const m = CX.length;
    OUT.length = 0;
    let S = 0, se = 0, he = h0;
    OUT.push(CX[0], CY[0], h0, 0);
    for (let j = 0; j < m - 1; j++) {
      const ds = Math.hypot(CX[j + 1] - CX[j], CY[j + 1] - CY[j]);
      if (ds < 1e-9) continue;
      const hj = CH[j], dh = wrap(CH[j + 1] - hj);
      let u = 0;
      // bütçe tam parça sınırında aşıldıysa parçanın başını köşe yap
      if (S - se > 1e-6 && Math.abs(wrap(hj - he)) >= DH - 1e-9) { se = S; he = hj; OUT.push(CX[j], CY[j], wrap(hj), S); }
      for (let guard = 0; guard < 1000; guard++) {
        let uu = (se + 1 - S) / ds;                     // mesafe bütçesi
        if (Math.abs(dh) > 1e-9) {                      // yön bütçesi
          const uh = wrap(he + (dh > 0 ? DH : -DH) - hj) / dh;
          if (uh > u + 1e-9 && uh < uu) uu = uh;
        }
        if (uu >= 1 - 1e-9) break;
        u = uu;
        const h = wrap(hj + dh * u);
        se = S + ds * u; he = h;
        OUT.push(CX[j] + (CX[j + 1] - CX[j]) * u, CY[j] + (CY[j + 1] - CY[j]) * u, h, se);
      }
      S += ds;
    }
    // son nokta: çok yakın bir ara köşe varsa onun yerine geçer
    const n0 = OUT.length;
    if (n0 > 4 && S - OUT[n0 - 1] < 0.05) OUT.length = n0 - 4;
    OUT.push(CX[m - 1], CY[m - 1], h1, S);
    const pts = new Float32Array(OUT);
    pts[2] = wrap(h0); pts[pts.length - 2] = wrap(h1);
    return pts;
  };

  // ---------- doğma örnekleri için kova ızgarası ----------
  // xs, ys: Float32Array örnek konumları -> {start:Int32Array(nb+1), items:Int32Array}
  const bucketize = (xs, ys, n, BW, BH) => {
    const nb = BW * BH, cnt = new Int32Array(nb + 1), cell = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const bx = U.clamp(Math.floor(xs[i] / BK), 0, BW - 1), by = U.clamp(Math.floor(ys[i] / BK), 0, BH - 1);
      cell[i] = by * BW + bx; cnt[cell[i] + 1]++;
    }
    for (let b = 0; b < nb; b++) cnt[b + 1] += cnt[b];
    const fillp = cnt.slice(0, nb), items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[fillp[cell[i]]++] = i;
    return { start: cnt, items };
  };

  class Nav {
    // city.applyWorldEdits(places) çağırır, sonra her şeyi kurar
    constructor(city) {
      const t0 = now();
      this.city = city;
      this.NB = NB;
      this._buildNodes();
      this._buildSegs();
      this._buildLanes();
      this._buildConnectors();
      this._buildConflicts();
      this._buildSignals();
      this.places = this._buildPlaces();
      city.applyWorldEdits(this.places);
      this._buildGrid();
      this._buildPed();
      this._buildSpawns();
      this._buildRouting();
      this.buildMs = now() - t0;
    }

    // ================= KAVŞAKLAR VE PARÇALAR =================
    _buildNodes() {
      const c = this.city;
      this.nodes = [];
      for (let i = 0; i <= NB; i++) {
        for (let j = 0; j <= NB; j++) {
          const id = i * (NB + 1) + j;
          let round = false;
          for (const r of c.roundabouts) if (r[0] === i && r[1] === j) round = true;
          this.nodes.push({
            id, i, j, x: c.lx[i], y: c.ly[j], hx: c.wx[i] / 2, hy: c.wy[j] / 2,
            legs: new Int32Array([-1, -1, -1, -1]), nLegs: 0, round, dead: false, signal: false,
            offset: ((i + j) * 2.3) % SIG_C, conns: null, ins: null, outs: null,
          });
        }
      }
    }

    _buildSegs() {
      const c = this.city, lx = c.lx, ly = c.ly, wx = c.wx, wy = c.wy;
      const segs = (this.segs = []);
      this._segIdx = new Int16Array(2 * (NB + 1) * NB).fill(-1);
      const iid = (i, j) => i * (NB + 1) + j;
      // dikey: yol i, parça j (kavşak (i,j) -> (i,j+1))
      for (let i = 0; i <= NB; i++) {
        for (let j = 0; j < NB; j++) {
          const a = ly[j] + wy[j] / 2, b = ly[j + 1] - wy[j + 1] / 2;
          if (c.inDrift(lx[i], (a + b) / 2)) continue;
          const s = { id: segs.length, v: true, i, j, c: lx[i], a, b, w: wx[i], A: iid(i, j), B: iid(i, j + 1), L: b - a, avenue: wx[i] >= 22 };
          segs.push(s);
          this.nodes[s.A].legs[2] = s.id; this.nodes[s.B].legs[0] = s.id;
          this._segIdx[i * NB + j] = s.id;
        }
      }
      // yatay: yol j, parça i (kavşak (i,j) -> (i+1,j))
      for (let j = 0; j <= NB; j++) {
        for (let i = 0; i < NB; i++) {
          const a = lx[i] + wx[i] / 2, b = lx[i + 1] - wx[i + 1] / 2;
          if (c.inDrift((a + b) / 2, ly[j])) continue;
          const s = { id: segs.length, v: false, i, j, c: ly[j], a, b, w: wy[j], A: iid(i, j), B: iid(i + 1, j), L: b - a, avenue: wy[j] >= 22 };
          segs.push(s);
          this.nodes[s.A].legs[1] = s.id; this.nodes[s.B].legs[3] = s.id;
          this._segIdx[(NB + 1) * NB + j * NB + i] = s.id;
        }
      }
      for (const n of this.nodes) {
        let k = 0;
        for (let l = 0; l < 4; l++) if (n.legs[l] >= 0) k++;
        n.nLegs = k; n.dead = k === 0;
      }
    }

    // dikey: yol i, (i,j)->(i,j+1); yatay: yol j, (i,j)->(i+1,j)
    segAt(vertical, i, j) {
      if (i < 0 || j < 0) return -1;
      if (vertical) { if (i > NB || j >= NB) return -1; return this._segIdx[i * NB + j]; }
      if (i >= NB || j > NB) return -1;
      return this._segIdx[(NB + 1) * NB + j * NB + i];
    }

    // ================= ŞERİTLER =================
    _buildLanes() {
      const lanes = (this.lanes = []);
      this._segLane = new Int32Array(this.segs.length * 4).fill(-1);
      for (const s of this.segs) {
        const offs = laneOff(s.w);
        for (const dir of [1, -1]) {
          const h = s.v ? (dir > 0 ? PI / 2 : -PI / 2) : dir > 0 ? 0 : PI;
          const rx = s.v ? (dir > 0 ? -1 : 1) : 0, ry = s.v ? 0 : dir > 0 ? 1 : -1;
          const from = dir > 0 ? s.A : s.B, to = dir > 0 ? s.B : s.A;
          const s0 = dir > 0 ? s.a : s.b, s1 = dir > 0 ? s.b : s.a;
          for (let k = 0; k < offs.length; k++) {
            const d = offs[k];
            const x0 = s.v ? s.c + rx * d : s0, y0 = s.v ? s0 : s.c + ry * d;
            const x1 = s.v ? s.c + rx * d : s1, y1 = s.v ? s1 : s.c + ry * d;
            const pts = new Float32Array([x0, y0, h, 0, x1, y1, h, s.L]);
            const legIn = this.nodes[to].legs.indexOf(s.id), legOut = this.nodes[from].legs.indexOf(s.id);
            const lane = {
              id: lanes.length, conn: false, seg: s.id, node: to, from, to, dir, k, d, turn: '',
              fromLane: -1, toLane: -1, pts, len: pts[7], h, h0: h, h1: h, vmax: vmaxOf(s.w),
              stopS: pts[7] - 5.1, next: null, avenue: s.avenue, bit: -1, conf: 0,
              legIn, legOut, phase: legIn === 0 || legIn === 2 ? 0 : 1, rank: s.avenue ? 1 : 0,
              nk: offs.length, outer: offs.length === 1 || k === 1, inner: offs.length === 1 || k === 0, ring: false,
            };
            lanes.push(lane);
            this._segLane[s.id * 4 + (dir > 0 ? 0 : 2) + k] = lane.id;
          }
        }
      }
      this.nRoad = lanes.length;
    }

    _buildConnectors() {
      const lanes = this.lanes, nodes = this.nodes, nRoad = this.nRoad;
      const insOf = nodes.map(() => []), outsOf = nodes.map(() => []), nextOf = [];
      for (let l = 0; l < nRoad; l++) { insOf[lanes[l].to].push(l); outsOf[lanes[l].from].push(l); nextOf.push([]); }
      // göbek: giriş/çıkış yayı, kavşak kutusu kenarında başlayacak şekilde çözülür
      const solveBeta = (d, H) => {
        let lo = Math.asin(Math.min(0.999, d / RC)) + 1e-4, hi = PI / 2 - 1e-3;
        for (let it = 0; it < 60; it++) {
          const m = (lo + hi) / 2, sb = Math.sin(m), rho = (RC * sb - d) / (1 - sb);
          if ((RC + rho) * Math.cos(m) > H) hi = m; else lo = m;
        }
        const sb = Math.sin(lo);
        return { beta: lo, rho: (RC * sb - d) / (1 - sb) };
      };
      this.nConn = 0;
      for (const n of nodes) {
        n.ins = new Int32Array(insOf[n.id]);
        n.outs = new Int32Array(outsOf[n.id]);
        const conns = [];
        if (!n.dead) {
          for (const lid of insOf[n.id]) {
            const li = lanes[lid];
            const legIn = li.legIn;
            const legs = [];
            for (let lo = 0; lo < 4; lo++) if (n.legs[lo] >= 0 && lo !== legIn) legs.push(lo);
            if (!legs.length) legs.push(legIn); // çıkmaz: U dönüşü
            for (const legOut of legs) {
              const rel = (legOut - ((legIn + 2) % 4) + 4) % 4; // 0 düz, 1 sağ, 3 sol, 2 U
              const turn = rel === 0 ? 'S' : rel === 1 ? 'R' : rel === 3 ? 'L' : 'U';
              // şerit kuralları: dış şerit sağ + düz, iç şerit sol + düz; göbekte düz/sol yalnız iç şeritten
              if (n.nLegs > 2) {
                if (turn === 'R' && !li.outer) continue;
                if (turn === 'L' && !li.inner) continue;
                if (n.round && turn === 'S' && !li.inner) continue;
              }
              const cands = [];
              for (const ol of outsOf[n.id]) if (lanes[ol].legOut === legOut) cands.push(lanes[ol]);
              if (!cands.length) continue;
              let lo = cands[0];
              if (cands.length > 1) {
                // 2 bacaklı köşe (çevre yolu köşeleri): aynı k -> eş merkezli yaylar (iç->dış eşlemesi 1.2 m yarıçap verir)
                const want = n.nLegs === 2 ? li.k : n.round && turn !== 'R' ? 0 : turn === 'S' ? li.k : turn === 'R' ? 1 : 0;
                for (const c of cands) if (c.k === want) lo = c;
              }
              const p0x = li.pts[4], p0y = li.pts[5], p3x = lo.pts[0], p3y = lo.pts[1], h0 = li.h, h3 = lo.h;
              cReset();
              const ring = n.round && turn !== 'R';
              if (ring) {
                const H = Math.min(n.hx, n.hy), bi = solveBeta(li.d, H), bo = solveBeta(lo.d, H), tau = PI / 2 - bi.beta;
                const te = HEAD[legIn] - bi.beta;
                let tx = HEAD[legOut] + bo.beta;
                while (tx > te - 0.05) tx -= TAU; // halkada θ azalır (ekranda saat yönü tersi)
                cRightArc(p0x, p0y, h0, bi.rho, tau, 24, false);
                const steps = Math.max(4, Math.ceil((te - tx) * RC * 6));
                for (let k = 1; k < steps; k++) {
                  const t = te + ((tx - te) * k) / steps;
                  cPush(n.x + Math.cos(t) * RC, n.y + Math.sin(t) * RC, t - PI / 2);
                }
                cRightArc(n.x + Math.cos(tx) * RC, n.y + Math.sin(tx) * RC, tx - PI / 2, bo.rho, PI / 2 - bo.beta, 24, false);
              } else if (turn === 'S') {
                cPush(p0x, p0y, h0); cPush(p3x, p3y, h3);
              } else {
                // 90° dönüş: çeyrek elips; yarıçaplar giriş/çıkış noktalarının yön eksenlerindeki farkı
                const dx = p3x - p0x, dy = p3y - p0y;
                const A = Math.abs(dx * Math.cos(h0) + dy * Math.sin(h0)), B = Math.abs(dx * Math.cos(h3) + dy * Math.sin(h3));
                if (turn === 'U') cBezier(p0x, p0y, h0, p3x, p3y, h3, 10, 10, 128);
                else cBezier(p0x, p0y, h0, p3x, p3y, h3, A, B, 128);
              }
              const pts = cResample(h0, h3);
              const len = pts[pts.length - 1];
              const vmax = ring ? 5.5 : turn === 'S' ? Math.min(li.vmax, lo.vmax) : turn === 'R' ? 4.5 : turn === 'L' ? 6.5 : 3;
              const cn = {
                id: lanes.length, conn: true, seg: -1, node: n.id, from: n.id, to: n.id, dir: 0, k: li.k, d: 0, turn,
                fromLane: li.id, toLane: lo.id, pts, len, h: h0, h0, h1: h3, vmax, stopS: -1,
                next: new Int32Array([lo.id]), avenue: li.avenue, bit: conns.length, conf: 0,
                legIn, legOut, phase: legIn === 0 || legIn === 2 ? 0 : 1, rank: li.avenue ? 1 : 0,
                nk: 1, outer: false, inner: false, ring, // yol şeritleriyle aynı alan sırası (tek gizli sınıf)
              };
              lanes.push(cn); conns.push(cn.id); nextOf[li.id].push(cn.id);
              this.nConn++;
            }
          }
        }
        n.conns = new Int32Array(conns);
      }
      for (let l = 0; l < nRoad; l++) lanes[l].next = new Int32Array(nextOf[l]);
    }

    // Aynı kavşakta iki bağlayıcı çatışır: farklı şeritten başlar ve (aynı hedef şerit ya da ≤ 1 m
    // örneklerde 2.2 m'den yakın geçer). conf: çatışan bağlayıcıların bit maskesi (uint32)
    _buildConflicts() {
      const lanes = this.lanes, R2 = 2.2 * 2.2;
      // sınır kutuları ayrı dizide (şerit nesnelerine geçici alan eklenmez: gizli sınıf bozulmasın)
      const BB = new Float64Array(lanes.length * 4);
      const bb = (c) => {
        const p = c.pts, o = c.id * 4;
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (let i = 0; i < p.length; i += 4) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]; }
        BB[o] = x0; BB[o + 1] = y0; BB[o + 2] = x1; BB[o + 3] = y1;
      };
      const near = (A, B) => {
        const a = A.id * 4, b = B.id * 4;
        if (BB[a + 2] + 2.2 < BB[b] || BB[b + 2] + 2.2 < BB[a] || BB[a + 3] + 2.2 < BB[b + 1] || BB[b + 3] + 2.2 < BB[a + 1]) return false;
        const pa = A.pts, pb = B.pts, bx0 = BB[b] - 2.2, by0 = BB[b + 1] - 2.2, bx1 = BB[b + 2] + 2.2, by1 = BB[b + 3] + 2.2;
        for (let i = 0; i < pa.length; i += 4) {
          const x = pa[i], y = pa[i + 1];
          if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
          for (let j = 0; j < pb.length; j += 4) {
            const dx = pb[j] - x, dy = pb[j + 1] - y;
            if (dx * dx + dy * dy < R2) return true;
          }
        }
        return false;
      };
      let pairs = 0;
      for (const n of this.nodes) {
        const cs = n.conns;
        for (let a = 0; a < cs.length; a++) bb(lanes[cs[a]]);
        for (let a = 0; a < cs.length; a++) {
          const A = lanes[cs[a]];
          for (let b = a + 1; b < cs.length; b++) {
            const B = lanes[cs[b]];
            if (A.fromLane === B.fromLane) continue;
            if (A.toLane === B.toLane || near(A, B)) {
              A.conf = (A.conf | (1 << B.bit)) >>> 0; B.conf = (B.conf | (1 << A.bit)) >>> 0; pairs++;
            }
          }
        }
      }
      this.nConflicts = pairs;
    }

    // Işıklar: göbek olmayan, 4 bacaklı ve bir bacağı cadde olan kavşaklar (24)
    _buildSignals() {
      this._sigOn = new Uint8Array(this.nodes.length);
      this._sigOff = new Float64Array(this.nodes.length);
      let n = 0;
      for (const nd of this.nodes) {
        let av = false;
        for (let l = 0; l < 4; l++) if (nd.legs[l] >= 0 && this.segs[nd.legs[l]].avenue) av = true;
        nd.signal = !nd.round && nd.nLegs === 4 && av;
        if (nd.signal) { this._sigOn[nd.id] = 1; n++; }
        this._sigOff[nd.id] = nd.offset;
      }
      this.nSignals = n;
    }

    // 0 kırmızı | 1 sarı | 2 yeşil — sinyalsiz kavşakta her zaman 2.
    // Faz 0 (K/G bacakları) yeşil [0,10), sarı [10,12.5); faz 1 (D/B) yeşil [13.5,23.5), sarı [23.5,26); arada 1 s tüm kırmızı
    light(nodeId, phase, t) {
      if (!this._sigOn[nodeId]) return 2;
      let tt = (t + this._sigOff[nodeId]) % SIG_C;
      if (tt < 0) tt += SIG_C;
      if (phase === 0) return tt < 10 ? 2 : tt < 12.5 ? 1 : 0;
      return tt >= 13.5 && tt < 23.5 ? 2 : tt >= 23.5 && tt < 26 ? 1 : 0;
    }
    // Yaya bu bacağı geçebilir mi: K/G bacağı (dikey yolu kesen geçit) yalnız faz 1 yeşilken, D/B faz 0 yeşilken
    walkOk(nodeId, leg, t) {
      if (!this._sigOn[nodeId]) return true;
      return this.light(nodeId, leg === 0 || leg === 2 ? 1 : 0, t) === 2;
    }

    // ---- şerit sorguları ----
    // out.x, out.y, out.h, out.k (eğrilik 1/m, sağa dönüş +). Tahsis yok; s [0, len] aralığına sınırlanır.
    laneAt(laneId, s, out) {
      const L = this.lanes[laneId], p = L.pts, n = p.length >> 2;
      if (!(s > 0)) s = 0; else if (s > L.len) s = L.len;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m * 4 + 3] <= s) lo = m; else hi = m; }
      const a = lo * 4, b = hi * 4, ds = p[b + 3] - p[a + 3];
      const u = ds > 1e-6 ? (s - p[a + 3]) / ds : 0;
      out.x = p[a] + (p[b] - p[a]) * u;
      out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * u;
      let dh = p[b + 2] - p[a + 2];
      if (dh > PI) dh -= TAU; else if (dh < -PI) dh += TAU;
      let h = p[a + 2] + dh * u;
      if (h > PI) h -= TAU; else if (h < -PI) h += TAU;
      out.h = h;
      out.k = ds > 1e-6 ? dh / ds : 0;
      return out;
    }

    // desc = [v(0|1), i, j, dir(±1), k(0|1), f(0..1)] -> out.x,y,h,s ; şerit id (yoksa -1)
    lanePoint(desc, out) {
      const seg = this.segAt(!!desc[0], desc[1], desc[2]);
      if (seg < 0) return -1;
      const base = seg * 4 + (desc[3] > 0 ? 0 : 2);
      let id = this._segLane[base + (desc[4] ? 1 : 0)];
      if (id < 0) id = this._segLane[base];
      const L = this.lanes[id], s = U.sat(desc[5]) * L.len;
      this.laneAt(id, s, out);
      out.s = s; out.lane = id;
      return id;
    }

    // Yalnız yol şeritleri. h verilirse |Δh| ≤ maxAng (radyan; > 6.3 verilirse derece kabul edilir)
    nearestLane(x, y, h, maxD, maxAng, out) {
      const useH = typeof h === 'number' && h === h;
      if (!(maxD > 0)) maxD = Infinity;
      if (!(maxAng >= 0)) maxAng = PI; else if (maxAng > 6.3) maxAng *= PI / 180;
      let best = -1, bd = maxD, bs = 0, bx = 0, by = 0;
      for (let l = 0; l < this.nRoad; l++) {
        const L = this.lanes[l], p = L.pts;
        if (useH && Math.abs(wrap(L.h - h)) > maxAng) continue;
        const x0 = p[0], y0 = p[1], dx = p[4] - x0, dy = p[5] - y0;
        let t = ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x0 + dx * t, py = y0 + dy * t, d = Math.hypot(px - x, py - y);
        if (d < bd || (d === bd && best < 0)) { bd = d; best = l; bs = t * L.len; bx = px; by = py; }
      }
      if (best < 0) return false;
      out.lane = best; out.s = bs; out.x = bx; out.y = by; out.h = this.lanes[best].h; out.d = bd;
      return true;
    }

    // ================= YERLER (§5.7) =================
    _buildPlaces() {
      const c = this.city;
      const blk = (i, j) => { for (const b of c.blocks) if (b.i === i && b.j === j && b.type !== 'drift') return b; return null; };
      const pose = (x, y, h) => ({ x: r2(x), y: r2(y), h });
      const P = {};
      // --- güvenli ev: otopark (3,1), 3. koridorun batı ucu
      {
        const b = blk(3, 1), I = b.inner, depth = 5.3, aisle = 7.2;
        const aY0 = r2(I.y0 + 0.8 + depth + 2 * (2 * depth + aisle)), aY1 = r2(aY0 + aisle), ay = r2((aY0 + aY1) / 2);
        const gx0 = r2(I.x0 + 1), gx1 = r2(I.x0 + 16);
        const garage = {
          kind: 'bld', x0: gx0, y0: r2(aY0 - 2 * depth + 0.4), x1: gx1, y1: r2(aY1 + 2 * depth), h: 6,
          wall: '#7b8794', roof: '#4a4e54', win: 'band', lit: 0.3, glass: 'rgba(28,44,62,0.62)', det: [],
        };
        const door = { kind: 'door', x: r2(gx1 + 0.2), y: ay, w: aisle, ang: PI / 2, col: '#ffb23e', r: aisle / 2 + 0.5 };
        const walker = pose(gx1 + 7.5, ay, 0), car = pose(gx1 + 22.5, ay, 0);
        P.safehouse = {
          name: 'Güvenli Ev', i: 3, j: 1, x: r2(gx1 + 2.5), y: ay,
          garage, door, trigger: { x0: r2(gx1 + 0.5), y0: aY0, x1: r2(gx1 + 4.5), y1: aY1 },
          walker, spawn: walker, car, carSpawn: car,
          clear: { x0: b.x0, y0: b.y0, x1: r2(gx1 + 1.5), y1: b.y1 },
        };
      }
      // --- boyahane: sanayi (1,7), depo doğu cephesi ile konteynerler arasındaki ara yol
      {
        const b = blk(1, 7);
        let ware = null;
        for (const s of c.solids) if (s.kind === 'ware' && s.x0 >= b.x0 && s.x1 <= b.x1 && s.y0 >= b.y0 && s.y1 <= b.y1) ware = s;
        // depo kenarı rastgele genişlikten gelir (245.52): yerler 0.5 m ızgaraya oturtulur (SPEC §5.7 değerleri)
        const wx1 = Math.round((ware ? ware.x1 : b.x0 + 51.5) * 2) / 2, wy1 = Math.round((ware ? ware.y1 : b.y1 - 5.5) * 2) / 2;
        const dy = r2(wy1 - 21.5);
        const exit = pose(wx1 + 3, dy + 15, PI / 2);
        P.spray = {
          name: 'Boyahane', i: 1, j: 7, x: r2(wx1 + 3), y: dy,
          trigger: { x0: r2(wx1 + 0.5), y0: r2(dy - 10), x1: r2(wx1 + 5.5), y1: r2(dy + 10) },
          // kapı duvarın hemen dışında (245.7): 245.4'te deponun duvar yüzü üstünü örter, görünmez
          door: { kind: 'door', x: r2(wx1 + 0.2), y: dy, w: 16, ang: PI / 2, col: '#c86bff', r: 8.5 },
          exit,
        };
      }
      // --- hastane: yapı (4,4), güney yaya şeridi
      {
        const b = blk(4, 4), x = r2((b.x0 + b.x1) / 2);
        const rs = pose(x, b.y1 - O, PI / 2);
        P.hospital = { name: 'Hastane', i: 4, j: 4, x: rs.x, y: rs.y, respawn: rs, spawn: rs, sign: { kind: 'sign', sym: 'cross', x, y: r2(b.y1 - 1.4), r: 1 } };
      }
      // --- karakol: yapı (5,3); polis doğma şeritleri cadde x=725 üzerinde
      {
        const b = blk(5, 3), x = r2((b.x0 + b.x1) / 2);
        const rs = pose(x, b.y1 - O, PI / 2);
        const lanes = [[1, 6, 3, 1, 0, 0.2], [1, 6, 3, 1, 1, 0.3]], spawns = [];
        const o = {};
        for (const d of lanes) { const id = this.lanePoint(d, o); spawns.push({ x: r2(o.x), y: r2(o.y), h: o.h, lane: id, s: o.s }); }
        P.police = { name: 'Karakol', i: 5, j: 3, x: rs.x, y: rs.y, respawn: rs, spawn: rs, sign: { kind: 'sign', sym: 'police', x, y: r2(b.y1 - 1.4), r: 1 }, lanes, copLanes: lanes, spawns };
      }
      // --- ankesörlü telefonlar: güney kaldırımlar, doğu köşesinden 47 m, bordürden 1.6 m
      {
        const list = [[1, 1], [4, 0], [8, 1], [2, 4], [4, 3], [7, 4], [1, 6], [3, 7], [6, 8], [8, 8], [5, 5], [6, 3]];
        P.phones = list.map(([i, j], k) => {
          const b = blk(i, j), x = r2(b.x1 - 47), y = r2(b.y1 - 1.6);
          return { i: k, bi: i, bj: j, x, y, sx: x, sy: r2(y - 1.2), prop: { kind: 'phone', x, y, r: 1 }, col: null };
        });
      }
      // --- hurda vinci: yol i=1, parça j=7, güneye giden şerit; tabela blok (1,7) batı kaldırımı
      {
        const seg = this.segs[this.segAt(true, 1, 7)], b = blk(1, 7);
        const x = r2(seg.c - seg.w / 4), y = r2((seg.a + seg.b) / 2);
        P.crane = { name: 'Hurda Vinci', x, y, r: 7, sign: { kind: 'sign', sym: 'crane', x: r2(b.x0 + 2), y, r: 1 } };
      }
      // --- drift parkı batı kapısı
      { const d = c.drift; P.driftGate = { name: 'Drift Parkı', x: r2(d.x0 + SW + 4.5), y: r2((d.y0 + d.y1) / 2) }; }
      // --- saklanma bölgeleri: otopark ve park iç alanları
      P.hideZones = [];
      for (const b of c.blocks) if (b.type === 'parking' || b.type === 'park') P.hideZones.push({ x0: b.inner.x0, y0: b.inner.y0, x1: b.inner.x1, y1: b.inner.y1, type: b.type });
      return P;
    }

    // ================= IZGARA (1 m) =================
    // bitler: 1 görüş engeli, 2 yaya engeli, 4 yol, 8 kaldırım, 16 çim/park, 32 drift parkı, 64 iç alan, 128 çakıl
    _buildGrid() {
      const c = this.city, GW = (this.GW = Math.ceil(c.W)), GH = (this.GH = Math.ceil(c.H));
      const grid = (this.grid = new Uint8Array(GW * GH));
      // yüzey bitleri tek-sıcak: boyama sırası = drawGround sırası (hücre merkezi içerideyse)
      const paint = (x0, y0, x1, y1, bit) => {
        const ax = Math.max(0, Math.round(x0)), ay = Math.max(0, Math.round(y0)), bx = Math.min(GW, Math.round(x1)), by = Math.min(GH, Math.round(y1));
        for (let y = ay; y < by; y++) { const o = y * GW; for (let x = ax; x < bx; x++) grid[o + x] = (grid[o + x] & 3) | bit; }
      };
      // engel bitleri: hücre merkezi kutunun kesin içindeyse (1 m'den ince duvarlar, ör. drift parkı
      // bariyerleri, ızgarada görünmeyebilir; kesin çarpışma için city.blocked kullanılır)
      const fill = (x0, y0, x1, y1, bit) => {
        const ax = Math.max(0, Math.floor(x0 - 0.5) + 1), bx = Math.min(GW - 1, Math.ceil(x1 - 0.5) - 1);
        const ay = Math.max(0, Math.floor(y0 - 0.5) + 1), by = Math.min(GH - 1, Math.ceil(y1 - 0.5) - 1);
        for (let y = ay; y <= by; y++) { const o = y * GW; for (let x = ax; x <= bx; x++) grid[o + x] |= bit; }
      };
      paint(0, 0, GW, GH, 16);
      for (let i = 0; i <= NB; i++) paint(c.lx[i] - c.wx[i] / 2, c.y0, c.lx[i] + c.wx[i] / 2, c.y1, 4);
      for (let j = 0; j <= NB; j++) paint(c.x0, c.ly[j] - c.wy[j] / 2, c.x1, c.ly[j] + c.wy[j] / 2, 4);
      for (const b of c.blocks) {
        paint(b.x0, b.y0, b.x1, b.y1, 8);
        const I = b.inner;
        paint(I.x0, I.y0, I.x1, I.y1, b.type === 'park' ? 16 : b.type === 'drift' ? 32 : 64);
        if (b.type === 'park') {
          for (const p of b.paths) paint(p.x0, p.y0, p.x1, p.y1, 128);
          if (b.plaza) {
            const pl = b.plaza, R = pl.r;
            for (let y = Math.floor(pl.y - R); y <= Math.ceil(pl.y + R); y++) {
              for (let x = Math.floor(pl.x - R); x <= Math.ceil(pl.x + R); x++) {
                const dx = x + 0.5 - pl.x, dy = y + 0.5 - pl.y;
                if (dx * dx + dy * dy <= R * R && x >= 0 && y >= 0 && x < GW && y < GH) grid[y * GW + x] = (grid[y * GW + x] & 3) | 128;
              }
            }
          }
        }
      }
      const LOS_KIND = { bld: 1, ware: 1, cont: 1, stand: 1 };
      for (const o of c.boxes) { if (o.off) continue; fill(o.x0, o.y0, o.x1, o.y1, LOS_KIND[o.kind] ? 3 : 2); }
      for (const o of c.circs) if (o.r >= 1) fill(o.x - o.r * 0.8, o.y - o.r * 0.8, o.x + o.r * 0.8, o.y + o.r * 0.8, 2);
      // blok sütun/satır arama tabloları: kutu içindeyse blok indeksi, değilse -1; *N: en yakın blok sütunu
      const bCol = (this._bCol = new Int8Array(GW).fill(-1)), bRow = (this._bRow = new Int8Array(GH).fill(-1));
      const nCol = (this._nCol = new Int8Array(GW)), nRow = (this._nRow = new Int8Array(GH));
      for (let x = 0; x < GW; x++) {
        const px = x + 0.5;
        let k = 0;
        while (k < NB - 1 && px >= c.lx[k + 1]) k++;
        nCol[x] = k;
        for (let i = 0; i < NB; i++) if (px >= c.lx[i] + c.wx[i] / 2 && px < c.lx[i + 1] - c.wx[i + 1] / 2) bCol[x] = i;
      }
      for (let y = 0; y < GH; y++) {
        const py = y + 0.5;
        let k = 0;
        while (k < NB - 1 && py >= c.ly[k + 1]) k++;
        nRow[y] = k;
        for (let j = 0; j < NB; j++) if (py >= c.ly[j] + c.wy[j] / 2 && py < c.ly[j + 1] - c.wy[j + 1] / 2) bRow[y] = j;
      }
    }

    // Amanatides–Woo DDA, bit 1; harita dışı = açık. Başlangıç ve bitiş hücreleri sayılmaz.
    los(x0, y0, x1, y1) {
      const grid = this.grid, GW = this.GW, GH = this.GH;
      let cx = Math.floor(x0), cy = Math.floor(y0);
      const ex = Math.floor(x1), ey = Math.floor(y1), dx = x1 - x0, dy = y1 - y0;
      const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
      const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity;
      let tmx = dx ? (dx > 0 ? cx + 1 - x0 : x0 - cx) * tdx : Infinity;
      let tmy = dy ? (dy > 0 ? cy + 1 - y0 : y0 - cy) * tdy : Infinity;
      for (let n = 0; n < 8192; n++) {
        if (cx === ex && cy === ey) return true;
        if (tmx < tmy) { tmx += tdx; cx += sx; } else { tmy += tdy; cy += sy; }
        if (cx === ex && cy === ey) return true;
        if (cx >= 0 && cy >= 0 && cx < GW && cy < GH && grid[cy * GW + cx] & 1) return false;
      }
      return true;
    }
    surf(x, y) {
      if (!(x >= 0 && y >= 0 && x < this.GW && y < this.GH)) return 16;
      return this.grid[(y | 0) * this.GW + (x | 0)];
    }
    walkable(x, y) {
      const c = this.city;
      if (!(x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1)) return false;
      return !(this.grid[(y | 0) * this.GW + (x | 0)] & 2);
    }
    // 'build'|'park'|'parking'|'ind'|'drift' (blok içinde, kaldırım dahil) ya da 'road'
    zoneAt(x, y) {
      const c = this.city;
      if (!(x >= 0 && y >= 0 && x < this.GW && y < this.GH)) return 'road';
      if (c.inDrift(x, y)) return 'drift';
      const i = this._bCol[x | 0], j = this._bRow[y | 0];
      if (i < 0 || j < 0) return 'road';
      return c.T[i][j];
    }
    // En yakın bloğun türü (yolda da bir blok türü döner; trafik varyant bölgesi için)
    zoneNear(x, y) {
      const c = this.city;
      if (c.inDrift(x, y)) return 'drift';
      const i = this._nCol[U.clamp(x | 0, 0, this.GW - 1)], j = this._nRow[U.clamp(y | 0, 0, this.GH - 1)];
      return c.T[i][j];
    }
    district(x, y) {
      const c = this.city;
      if (!(x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1)) return 'Çevre Yolu';
      if (c.inDrift(x, y)) return 'Drift Parkı';
      if (Math.abs(x - c.lx[0]) <= c.wx[0] / 2 || Math.abs(x - c.lx[NB]) <= c.wx[NB] / 2 ||
          Math.abs(y - c.ly[0]) <= c.wy[0] / 2 || Math.abs(y - c.ly[NB]) <= c.wy[NB] / 2) return 'Çevre Yolu';
      const xi = U.clamp(x | 0, 0, this.GW - 1), yi = U.clamp(y | 0, 0, this.GH - 1);
      const bi = this._bCol[xi], bj = this._bRow[yi];
      if (bi >= 0 && bj >= 0 && c.T[bi][bj] === 'park') return 'Park';
      const i = this._nCol[xi], j = this._nRow[yi];
      if (i >= 6 && i <= 7 && j >= 1 && j <= 2) return 'Drift Parkı';
      if (i <= 2 && j >= 6) return 'Sanayi';
      if (i >= 3 && i <= 5 && j >= 3 && j <= 5) return 'Merkez';
      const dx = x - c.cx, dy = y - c.cy;
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'Doğu' : 'Batı';
      return dy < 0 ? 'Kuzey' : 'Güney';
    }
    // otopark iç alanı ya da park iç alanı (saklanma bonusu)
    hideZone(x, y) {
      const z = this.places.hideZones;
      for (let k = 0; k < z.length; k++) { const r = z[k]; if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true; }
      return false;
    }

    // ================= YAYA GRAFİĞİ =================
    _buildPed() {
      const c = this.city;
      const nodes = [], edges = [];
      const pn = (x, y, tag) => { nodes.push({ x, y, tag, e: [] }); return nodes.length - 1; };
      const pe = (a, b, kind, node, leg) => {
        const L = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
        edges.push({ a, b, kind, L, node, leg }); nodes[a].e.push(edges.length - 1); nodes[b].e.push(edges.length - 1);
      };
      const bKey = new Map();
      for (const b of c.blocks) bKey.set(b, { b, x0: b.x0 + O, y0: b.y0 + O, x1: b.x1 - O, y1: b.y1 - O, side: [[], [], [], []] });
      const blockAt = (x, y) => { for (const b of c.blocks) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b; return null; };
      // yan üzerinde (ya da köşede) düğüm; yan: 0 kuzey, 1 doğu, 2 güney, 3 batı
      const sideNode = (R, side, x, y) => {
        const t = side === 0 || side === 2 ? x : y;
        for (const [tt, id] of R.side[side]) if (Math.abs(tt - t) < 0.5) return id;
        const id = pn(side === 1 ? R.x1 : side === 3 ? R.x0 : x, side === 0 ? R.y0 : side === 2 ? R.y1 : y, 0);
        R.side[side].push([t, id]);
        return id;
      };
      for (const R of bKey.values()) {
        const nw = pn(R.x0, R.y0, 1), ne = pn(R.x1, R.y0, 1), se = pn(R.x1, R.y1, 1), sw = pn(R.x0, R.y1, 1);
        R.side[0].push([R.x0, nw], [R.x1, ne]); R.side[1].push([R.y0, ne], [R.y1, se]);
        R.side[2].push([R.x0, sw], [R.x1, se]); R.side[3].push([R.y0, nw], [R.y1, sw]);
      }
      // yaya geçitleri: her parçanın iki ucunda, kutu kenarından 2.9 m (zebra 0.7..3.9)
      for (const s of this.segs) {
        for (const end of [0, 1]) {
          const t = end ? s.b - O : s.a + O;
          const pA = s.v ? [s.c - s.w / 2 - 0.01, t] : [t, s.c - s.w / 2 - 0.01];
          const pB = s.v ? [s.c + s.w / 2 + 0.01, t] : [t, s.c + s.w / 2 + 0.01];
          const bA = blockAt(pA[0], pA[1]), bB = blockAt(pB[0], pB[1]);
          if (!bA || !bB) continue; // şehir sınırı (bariyer) tarafı
          const RA = bKey.get(bA), RB = bKey.get(bB);
          const a = s.v ? sideNode(RA, 1, RA.x1, t) : sideNode(RA, 2, t, RA.y1);
          const b = s.v ? sideNode(RB, 3, RB.x0, t) : sideNode(RB, 0, t, RB.y0);
          const node = end ? s.B : s.A, leg = s.v ? (end ? 0 : 2) : end ? 3 : 1;
          pe(a, b, 1, node, leg);
        }
      }
      // park yolları: blok döngüsünün yan ortası -> meydan halkası (r=6) -> karşı yan
      for (const b of c.blocks) {
        if (b.type !== 'park') continue;
        const R = bKey.get(b), px = b.plaza.x, py = b.plaza.y, pr = 6;
        const ring = [pn(px, py - pr, 2), pn(px + pr, py, 2), pn(px, py + pr, 2), pn(px - pr, py, 2)];
        for (let k = 0; k < 4; k++) pe(ring[k], ring[(k + 1) % 4], 2, -1, -1);
        pe(sideNode(R, 0, px, R.y0), ring[0], 2, -1, -1); pe(sideNode(R, 1, R.x1, py), ring[1], 2, -1, -1);
        pe(sideNode(R, 2, px, R.y1), ring[2], 2, -1, -1); pe(sideNode(R, 3, R.x0, py), ring[3], 2, -1, -1);
      }
      // döngü kenarları: her yanı sırala ve ardışık bağla
      for (const R of bKey.values()) {
        for (let sd = 0; sd < 4; sd++) {
          const arr = R.side[sd].sort((p, q) => p[0] - q[0]);
          for (let k = 1; k < arr.length; k++) if (arr[k][1] !== arr[k - 1][1]) pe(arr[k - 1][1], arr[k][1], 0, -1, -1);
        }
      }
      // CSR (tipli diziler)
      const n = nodes.length, m = edges.length;
      const P = {
        n, x: new Float32Array(n), y: new Float32Array(n), nKind: new Uint8Array(n),
        eStart: new Int32Array(n + 1), adj: null,
        m, ea: new Int32Array(m), eb: new Int32Array(m), eLen: new Float32Array(m), eKind: new Uint8Array(m),
        eNode: new Int16Array(m), eLeg: new Int8Array(m),
      };
      let tot = 0;
      for (let i = 0; i < n; i++) { P.x[i] = nodes[i].x; P.y[i] = nodes[i].y; P.nKind[i] = nodes[i].tag; P.eStart[i] = tot; tot += nodes[i].e.length; }
      P.eStart[n] = tot;
      P.adj = new Int32Array(tot);
      for (let i = 0, k = 0; i < n; i++) for (const e of nodes[i].e) P.adj[k++] = e;
      for (let e = 0; e < m; e++) {
        const E = edges[e];
        P.ea[e] = E.a; P.eb[e] = E.b; P.eLen[e] = E.L; P.eKind[e] = E.kind; P.eNode[e] = E.node; P.eLeg[e] = E.leg;
      }
      this.ped = P;
    }

    nearestPedEdge(x, y, out) {
      const P = this.ped;
      let best = -1, bd = Infinity, bt = 0, bx = 0, by = 0;
      for (let e = 0; e < P.m; e++) {
        const a = P.ea[e], b = P.eb[e], x0 = P.x[a], y0 = P.y[a], dx = P.x[b] - x0, dy = P.y[b] - y0;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 1e-9 ? ((x - x0) * dx + (y - y0) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x0 + dx * t, py = y0 + dy * t, ddx = px - x, ddy = py - y, d2 = ddx * ddx + ddy * ddy;
        if (d2 < bd) { bd = d2; best = e; bt = t; bx = px; by = py; }
      }
      if (best < 0) return false;
      out.edge = best; out.t = bt; out.x = bx; out.y = by; out.d = Math.sqrt(bd);
      return true;
    }

    // ================= DOĞMA ÖRNEKLERİ =================
    _buildSpawns() {
      const BW = (this._BW = Math.ceil(this.city.W / BK)), BH = (this._BH = Math.ceil(this.city.H / BK));
      // şeritler: 10 m arayla, s ∈ [8, L-12]
      const lx = [], ly = [], ll = [], ls = [];
      const o = {};
      for (let l = 0; l < this.nRoad; l++) {
        const L = this.lanes[l];
        for (let s = 8; s <= L.len - 12 + 1e-6; s += 10) { this.laneAt(l, s, o); lx.push(o.x); ly.push(o.y); ll.push(l); ls.push(s); }
      }
      const LS = (this._ls = { n: lx.length, x: new Float32Array(lx), y: new Float32Array(ly), lane: new Int32Array(ll), s: new Float32Array(ls) });
      const lb = bucketize(LS.x, LS.y, LS.n, BW, BH);
      LS.start = lb.start; LS.items = lb.items;
      // yaya: geçit olmayan kenarlarda 6 m arayla (uçlardan 3 m içeriden başlayarak)
      const P = this.ped, px = [], py = [], pe = [], pt = [];
      for (let e = 0; e < P.m; e++) {
        if (P.eKind[e] === 1) continue;
        const a = P.ea[e], b = P.eb[e], L = P.eLen[e];
        for (let d = Math.min(3, L / 2); d < L; d += 6) {
          const t = d / L;
          px.push(P.x[a] + (P.x[b] - P.x[a]) * t); py.push(P.y[a] + (P.y[b] - P.y[a]) * t); pe.push(e); pt.push(t);
        }
      }
      const PSm = (this._ps = { n: px.length, x: new Float32Array(px), y: new Float32Array(py), edge: new Int32Array(pe), t: new Float32Array(pt) });
      const pb = bucketize(PSm.x, PSm.y, PSm.n, BW, BH);
      PSm.start = pb.start; PSm.items = pb.items;
    }

    // halka [r0,r1] içinde örnek seç; f (birim yön) verilirse önde kalanlar 4 kata kadar ağırlıklı. Tahsis yok.
    _pick(S, cx, cy, r0, r1, fx, fy, rnd) {
      const BW = this._BW, BH = this._BH;
      const bx0 = U.clamp(Math.floor((cx - r1) / BK), 0, BW - 1), bx1 = U.clamp(Math.floor((cx + r1) / BK), 0, BW - 1);
      const by0 = U.clamp(Math.floor((cy - r1) / BK), 0, BH - 1), by1 = U.clamp(Math.floor((cy + r1) / BK), 0, BH - 1);
      const a2 = r0 * r0, b2 = r1 * r1, dir = fx * fx + fy * fy > 1e-6;
      let tot = 0;
      for (let pass = 0; pass < 2; pass++) {
        let goal = 0;
        if (pass === 1) { if (tot <= 0) return -1; goal = rnd() * tot; tot = 0; }
        for (let by = by0; by <= by1; by++) {
          for (let bx = bx0; bx <= bx1; bx++) {
            const b = by * BW + bx, e = S.start[b + 1];
            for (let k = S.start[b]; k < e; k++) {
              const i = S.items[k], dx = S.x[i] - cx, dy = S.y[i] - cy, d2 = dx * dx + dy * dy;
              if (d2 < a2 || d2 > b2) continue;
              let w = 1;
              if (dir) { const cs = (dx * fx + dy * fy) / Math.sqrt(d2 || 1); if (cs > 0) w += 3 * cs; }
              tot += w;
              if (pass === 1 && tot > goal) return i;
            }
          }
        }
      }
      return -1;
    }
    // halka içinde yol şeridi noktası (ileri yön ağırlıklı); out.lane, s, x, y, h
    pickLaneSpawn(cx, cy, r0, r1, fx, fy, rnd, out) {
      const S = this._ls, i = this._pick(S, cx, cy, r0, r1, fx || 0, fy || 0, rnd || Math.random);
      if (i < 0) return false;
      out.lane = S.lane[i]; out.s = S.s[i]; out.x = S.x[i]; out.y = S.y[i]; out.h = this.lanes[out.lane].h;
      return true;
    }
    // halka içinde yaya kenarı noktası (geçitler hariç); out.edge, t, x, y
    pickPedSpawn(cx, cy, r0, r1, rnd, out) {
      const S = this._ps, i = this._pick(S, cx, cy, r0, r1, 0, 0, rnd || Math.random);
      if (i < 0) return false;
      out.edge = S.edge[i]; out.t = S.t[i]; out.x = S.x[i]; out.y = S.y[i];
      return true;
    }

    // ================= ROTA =================
    _buildRouting() {
      const N = this.nodes.length, segs = this.segs;
      const deg = new Int32Array(N + 1);
      for (const s of segs) { deg[s.A + 1]++; deg[s.B + 1]++; }
      for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
      const fillp = deg.slice(0, N), M = deg[N];
      this._aStart = deg;
      this._aTo = new Int16Array(M); this._aCost = new Float64Array(M); this._aSeg = new Int16Array(M);
      // kenar sırası prototiple aynı (parça sırasıyla): A*'ın eşitlik kırılımı korunur
      const c = this.city, d = c.drift, M2 = 2;
      this._segDrift = new Uint8Array(segs.length);
      for (const s of segs) {
        const cost = (s.L + this.nodes[s.A].hx + this.nodes[s.B].hx) * (s.avenue ? 1 : 1.25); // cadde tercih edilir
        let k = fillp[s.A]++; this._aTo[k] = s.B; this._aCost[k] = cost; this._aSeg[k] = s.id;
        k = fillp[s.B]++; this._aTo[k] = s.A; this._aCost[k] = cost; this._aSeg[k] = s.id;
        const x0 = s.v ? s.c - s.w / 2 : s.a, x1 = s.v ? s.c + s.w / 2 : s.b, y0 = s.v ? s.a : s.c - s.w / 2, y1 = s.v ? s.b : s.c + s.w / 2;
        if (x1 >= d.x0 - M2 && x0 <= d.x1 + M2 && y1 >= d.y0 - M2 && y0 <= d.y1 + M2) this._segDrift[s.id] = 1;
      }
      this._g = new Float64Array(N); this._f = new Float64Array(N);
      this._prev = new Int16Array(N); this._closed = new Uint8Array(N); this._open = new Int16Array(1024);
      this._tmpRoute = new Int16Array(N); this._snapA = {}; this._snapB = {};
      this.routeCost = 0;
    }

    // A* (Manhattan sezgisi); outNodes'a başlangıçtan hedefe kavşak id'leri yazar; düğüm sayısı (yol yoksa 0)
    route(fromNode, toNode, outNodes) {
      const nodes = this.nodes, N = nodes.length;
      if (!(fromNode >= 0 && fromNode < N && toNode >= 0 && toNode < N) || nodes[fromNode].dead || nodes[toNode].dead) return 0;
      const g = this._g, f = this._f, prev = this._prev, closed = this._closed, open = this._open;
      const tx = nodes[toNode].x, ty = nodes[toNode].y;
      g.fill(Infinity); prev.fill(-1); closed.fill(0);
      let no = 1;
      open[0] = fromNode; g[fromNode] = 0; f[fromNode] = Math.abs(nodes[fromNode].x - tx) + Math.abs(nodes[fromNode].y - ty);
      while (no) {
        let bi = 0;
        for (let k = 1; k < no; k++) if (f[open[k]] < f[open[bi]]) bi = k;
        const u = open[bi]; open[bi] = open[no - 1]; no--;
        if (u === toNode) break;
        if (closed[u]) continue;
        closed[u] = 1;
        for (let k = this._aStart[u], e = this._aStart[u + 1]; k < e; k++) {
          const v = this._aTo[k], ng = g[u] + this._aCost[k];
          if (ng < g[v]) {
            g[v] = ng; f[v] = ng + Math.abs(nodes[v].x - tx) + Math.abs(nodes[v].y - ty); prev[v] = u;
            if (no < open.length) open[no++] = v;
          }
        }
      }
      if (g[toNode] === Infinity) return 0;
      let n = 0;
      for (let u = toNode; u >= 0; u = prev[u]) n++;
      const cap = outNodes ? outNodes.length : 0;
      let k = n - 1;
      for (let u = toNode; u >= 0; u = prev[u], k--) if (k < cap) outNodes[k] = u;
      this.routeCost = g[toNode];
      return Math.min(n, cap);
    }

    // Ters Dijkstra: next[n] = hedefe giden komşu (-1), dist[n] = maliyet; avoidDrift: drift parkına
    // değen parçalar 4 kat pahalı (polis düşük yıldızda parkın çevresinden dolaşmaz)
    flowTo(targetNode, next, dist, avoidDrift) {
      const nodes = this.nodes, N = nodes.length, closed = this._closed;
      for (let i = 0; i < N; i++) { next[i] = -1; dist[i] = Infinity; }
      closed.fill(0);
      if (!(targetNode >= 0 && targetNode < N) || nodes[targetNode].dead) return;
      dist[targetNode] = 0;
      for (;;) {
        let u = -1, bd = Infinity;
        for (let i = 0; i < N; i++) if (!closed[i] && dist[i] < bd) { bd = dist[i]; u = i; }
        if (u < 0) break;
        closed[u] = 1;
        for (let k = this._aStart[u], e = this._aStart[u + 1]; k < e; k++) {
          const v = this._aTo[k];
          if (closed[v]) continue;
          const nd = bd + this._aCost[k] * (avoidDrift && this._segDrift[this._aSeg[k]] ? 4 : 1);
          if (nd < dist[v]) { dist[v] = nd; next[v] = u; }
        }
      }
    }

    // en yakın canlı kavşak
    nodeNear(x, y) {
      let best = -1, bd = Infinity;
      for (const n of this.nodes) {
        if (n.dead) continue;
        const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
        if (d < bd) { bd = d; best = n.id; }
      }
      return best;
    }

    // en yakın parça ekseni: out.seg, x, y, d, nA, nB, t (A'dan B'ye 0..1)
    snap(x, y, out) {
      let best = -1, bd = Infinity, bx = 0, by = 0, bt = 0;
      for (const s of this.segs) {
        const q = s.v ? y : x, a = q < s.a ? s.a : q > s.b ? s.b : q;
        const px = s.v ? s.c : a, py = s.v ? a : s.c, d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < bd) { bd = d; best = s.id; bx = px; by = py; bt = (a - s.a) / s.L; }
      }
      if (best < 0) return false;
      const s = this.segs[best];
      out.seg = best; out.x = bx; out.y = by; out.d = Math.sqrt(bd); out.nA = s.A; out.nB = s.B; out.t = bt;
      return true;
    }

    // GPS çoklu çizgisi: başlangıç izdüşümü, kavşak merkezleri, hedef izdüşümü
    // out.pts (Float32Array(512)), out.n (nokta), out.len (m); dönüş: n
    gps(x0, y0, x1, y1, out) {
      if (!out.pts || out.pts.length < 512) out.pts = new Float32Array(512);
      const P = out.pts, A = this._snapA, B = this._snapB;
      out.n = 0; out.len = 0;
      if (!this.snap(x0, y0, A) || !this.snap(x1, y1, B)) return 0;
      let n = 0;
      P[0] = A.x; P[1] = A.y; n = 1;
      if (A.seg !== B.seg) {
        const sA = this.segs[A.seg], sB = this.segs[B.seg], wA = sA.avenue ? 1 : 1.25, wB = sB.avenue ? 1 : 1.25;
        let best = Infinity, ba = -1, bb = -1;
        for (let ea = 0; ea < 2; ea++) {
          const na = ea ? sA.B : sA.A, NA = this.nodes[na];
          const ca = (Math.abs(NA.x - A.x) + Math.abs(NA.y - A.y)) * wA;
          for (let eb = 0; eb < 2; eb++) {
            const nb = eb ? sB.B : sB.A, NBn = this.nodes[nb];
            const cb = (Math.abs(NBn.x - B.x) + Math.abs(NBn.y - B.y)) * wB;
            if (!this.route(na, nb, this._tmpRoute)) continue;
            const tot = ca + this.routeCost + cb;
            if (tot < best) { best = tot; ba = na; bb = nb; }
          }
        }
        if (ba >= 0) {
          const m = this.route(ba, bb, this._tmpRoute);
          for (let k = 0; k < m && n < 255; k++) { const nd = this.nodes[this._tmpRoute[k]]; P[n * 2] = nd.x; P[n * 2 + 1] = nd.y; n++; }
        }
      }
      P[n * 2] = B.x; P[n * 2 + 1] = B.y; n++;
      let len = 0;
      for (let k = 1; k < n; k++) len += Math.hypot(P[k * 2] - P[k * 2 - 2], P[k * 2 + 1] - P[k * 2 - 1]);
      out.n = n; out.len = len;
      return n;
    }
  }

  DS.Nav = Nav;
})();
