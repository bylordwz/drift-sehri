'use strict';
// Tandem: şehir sokaklarında drift atan yapay zekâ lider ve takip hakemi
(function () {
  const DS = window.DS, U = DS.U;
  const ROUTE = [[1, 1], [4, 1], [4, 2], [5, 2], [5, 4], [2, 4], [2, 3], [1, 3]];

  class Path {
    constructor(city) {
      const P = ROUTE.map(([i, j]) => [city.lx[i], city.ly[j]]);
      // R=16 m köşe yarıçapı: ~0,8 g yanal ivmeyle ~40 km/s viraj hızı (gerçek araçla takip edilebilir)
      const n = P.length, R = 16;
      const corners = [];
      for (let k = 0; k < n; k++) {
        const pv = P[(k - 1 + n) % n], cu = P[k], nx = P[(k + 1) % n];
        let ix = cu[0] - pv[0], iy = cu[1] - pv[1]; const il = Math.hypot(ix, iy); ix /= il; iy /= il;
        let ox = nx[0] - cu[0], oy = nx[1] - cu[1]; const ol = Math.hypot(ox, oy); ox /= ol; oy /= ol;
        const turn = Math.sign(ix * oy - iy * ox) || 1;
        const t1 = [cu[0] - ix * R, cu[1] - iy * R], t2 = [cu[0] + ox * R, cu[1] + oy * R];
        const c = [t1[0] + -iy * R * turn, t1[1] + ix * R * turn];
        corners.push({ t1, t2, c, turn, a0: Math.atan2(t1[1] - c[1], t1[0] - c[0]) });
      }
      const pts = [];
      const push = (x, y, ang, arc, turn) => pts.push({ x, y, ang, arc, turn });
      for (let k = 0; k < n; k++) {
        const a = corners[k], b = corners[(k + 1) % n];
        const dx = b.t1[0] - a.t2[0], dy = b.t1[1] - a.t2[1], L = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        for (let s = 0; s < L; s += 1) push(a.t2[0] + (dx / L) * s, a.t2[1] + (dy / L) * s, ang, 0, 0);
        const steps = Math.ceil((Math.PI / 2) * R);
        for (let s = 0; s < steps; s++) {
          const th = b.a0 + b.turn * (s / steps) * (Math.PI / 2);
          push(b.c[0] + Math.cos(th) * R, b.c[1] + Math.sin(th) * R, th + b.turn * Math.PI / 2, 1, b.turn);
        }
      }
      this.pts = pts; this.len = pts.length;
      // drift açısı ve hız profili
      const N = pts.length;
      const raw = new Float32Array(N), cor = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let tgt = 0;
        for (let d = -8; d <= 16; d++) {
          const q = pts[(i + d + N) % N];
          if (q.arc) { tgt = q.turn * 0.72; break; }
        }
        raw[i] = tgt;
        cor[i] = pts[i].arc ? 1 : 0;
      }
      const smooth = (src, w) => {
        const out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          let s = 0;
          for (let d = -w; d <= w; d++) s += src[(i + d + N) % N];
          out[i] = s / (2 * w + 1);
        }
        return out;
      };
      this.drift = smooth(smooth(raw, 9), 6);
      // viraj katsayısı: yumuşatıp tepe değerini 1'e ölçekle (viraj ortasında tam yavaşlama)
      const cs = smooth(smooth(cor, 22), 10);
      let mx = 0;
      for (let i = 0; i < N; i++) mx = Math.max(mx, cs[i]);
      for (let i = 0; i < N; i++) cs[i] = Math.min(1, cs[i] / (mx * 0.9));
      this.corner = cs;
    }
    at(s) {
      const N = this.len;
      const f = ((s % N) + N) % N;
      const i = Math.floor(f), j = (i + 1) % N, t = f - i;
      const a = this.pts[i], b = this.pts[j];
      return {
        x: U.lerp(a.x, b.x, t), y: U.lerp(a.y, b.y, t),
        ang: U.alerp(a.ang, b.ang, t),
        drift: U.lerp(this.drift[i], this.drift[j], t),
        corner: U.lerp(this.corner[i], this.corner[j], t),
      };
    }
    // Noktaya en yakın yol konumu (son bilinen konum etrafında arar)
    nearest(x, y, hint) {
      const N = this.len;
      let best = hint, bd = Infinity;
      const span = hint === undefined ? N : 70;
      const start = hint === undefined ? 0 : hint - span;
      for (let k = 0; k < (hint === undefined ? N : span * 2); k++) {
        const i = ((start + k) % N + N) % N;
        const p = this.pts[i];
        const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        if (d < bd) { bd = d; best = i; }
      }
      const p = this.pts[best];
      const off = (x - p.x) * -Math.sin(p.ang) + (y - p.y) * Math.cos(p.ang);
      return { i: best, d: Math.sqrt(bd), off };
    }
  }

  class Leader {
    constructor(city, def, setup) {
      this.path = new Path(city);
      this.def = def; this.setup = setup;
      this.p = { a: def.wb * (1 - def.fw), b: def.wb * def.fw, len: def.len, wid: def.wid };
      this._obb = { x: 0, y: 0, c: 1, s: 0, hl: def.len / 2, hw: def.wid / 2 };
      this.reset(30);
    }
    reset(s) {
      this.s = s; this.sTot = s; this.v = 0; this.go = false;
      this.steer = 0; this.axf = 0; this.ayf = 0; this.brakeOn = false; this.revOn = false;
      this.rpm = this.def.idle; this.slipR = 0; this.slipF = 0; this.wob = 0;
      this.place();
      this.px = this.x; this.py = this.y; this.ph = this.h;
    }
    place() {
      const q = this.path.at(this.s);
      const wob = Math.sin(this.sTot * 0.21) * 0.05 * Math.abs(q.drift);
      this.driftA = q.drift + wob;
      this.x = q.x; this.y = q.y;
      this.h = q.ang + this.driftA;
      this.vx = Math.cos(q.ang) * this.v; this.vy = Math.sin(q.ang) * this.v;
      this.speed = this.v;
      this.beta = -this.driftA;
      this.corner = q.corner;
    }
    update(dt, gap) {
      const q = this.path.at(this.s);
      let vt = U.lerp(19, 11.2, q.corner);
      if (gap !== undefined) {
        // takipçi geride kalırsa lider hafifçe bekler
        if (gap > 13) vt *= U.lerp(1, 0.6, U.sat((gap - 13) / 18));
        else if (gap < 4) vt *= 1.06;
      }
      if (!this.go) vt = 0;
      const pv = this.v;
      this.v = U.approach(this.v, vt, (vt > this.v ? 4.5 : 6) * dt);
      this.axf = U.damp(this.axf, (this.v - pv) / Math.max(dt, 1e-4), 6, dt);
      this.s += this.v * dt; this.sTot += this.v * dt;
      if (this.s >= this.path.len) this.s -= this.path.len;
      const ph = this.h;
      this.place();
      this.w = U.wrap(this.h - ph) / Math.max(dt, 1e-4);
      this.ayf = U.damp(this.ayf, -this.driftA * this.v * 0.6, 4, dt);
      this.steer = U.clamp(-this.driftA * 0.75, -0.8, 0.8);
      const da = Math.abs(this.driftA);
      this.slipR = da > 0.14 && this.v > 4 ? this.v * Math.sin(da) * 0.9 + 2 : 0;
      this.rpm = U.lerp(3200, 6900, U.sat(this.v / 22)) + (da > 0.2 ? 600 : 0) + Math.sin(this.sTot) * 80;
      this.brakeOn = vt < this.v - 1;
    }
    obb() {
      const o = this._obb;
      o.x = this.x; o.y = this.y; o.c = Math.cos(this.h); o.s = Math.sin(this.h);
      return o;
    }
    wheels(out) {
      const c = Math.cos(this.h), s = Math.sin(this.h), tw = this.def.wid * 0.43;
      const pts = [[this.p.a, -tw], [this.p.a, tw], [-this.p.b, -tw], [-this.p.b, tw]];
      for (let i = 0; i < 4; i++) {
        out[i * 2] = this.x + c * pts[i][0] - s * pts[i][1];
        out[i * 2 + 1] = this.y + s * pts[i][0] + c * pts[i][1];
      }
      return out;
    }
  }

  class TandemJudge {
    constructor(leader) {
      this.L = leader;
      this.state = 'count'; this.t = 3.4; this.hint = undefined;
      this.sumT = 0; this.sumP = 0; this.sumA = 0; this.wA = 0; this.sumL = 0;
      this.pen = 0; this.far = 0; this.passCD = 0; this.hitCD = 0;
      this.gap = 9; this.live = 0; this.progress = 0; this.startS = leader.sTot;
      this.pS = leader.sTot - 9; this.lastI = undefined;
      this.msgs = [];
    }
    contact() {
      if (this.state !== 'run' || this.hitCD > 0) return;
      this.hitCD = 1.2; this.pen += 5;
      this.msgs.push({ text: 'TEMAS', kind: 'bad', sub: '−5' });
    }
    update(dt, car) {
      const L = this.L, path = L.path, N = path.len;
      if (this.hitCD > 0) this.hitCD -= dt;
      if (this.passCD > 0) this.passCD -= dt;
      const nr = path.nearest(car.x, car.y, this.lastI);
      if (this.lastI !== undefined) {
        let di = nr.i - this.lastI;
        if (di > N / 2) di -= N; if (di < -N / 2) di += N;
        this.pS += di;
      }
      this.lastI = nr.i;
      this.gap = L.sTot - this.pS;
      if (this.state === 'count') {
        this.t -= dt;
        if (this.t <= 0) { this.state = 'run'; L.go = true; this.msgs.push({ text: 'BAŞLA!', kind: 'hot', sub: '' }); }
        return;
      }
      if (this.state !== 'run') return;
      const g = this.gap;
      const prox = g < 1.5 ? 0.5 : g <= 9 ? 1 : g <= 16 ? U.lerp(1, 0.35, (g - 9) / 7) : g <= 28 ? U.lerp(0.35, 0, (g - 16) / 12) : 0;
      const line = 1 - U.clamp((Math.abs(nr.off) - 2.5) / 6, 0, 1);
      this.sumT += dt; this.sumP += prox * dt; this.sumL += line * dt;
      const aL = L.driftA, aP = car.speed > 3 ? -car.beta : 0;
      if (Math.abs(aL) > 0.2) {
        const sync = 1 - Math.min(1, Math.abs(aP - aL) / 0.6);
        this.sumA += sync * dt; this.wA += dt;
      }
      this.live = this.score();
      if (g < -1 && this.passCD <= 0) {
        this.passCD = 2.5; this.pen += 15;
        this.msgs.push({ text: 'LİDERİ GEÇTİN', kind: 'bad', sub: '−15' });
      }
      if (g > 40) {
        this.far += dt;
        if (this.far > 5) this.finish(false, 'Lideri kaybettin. Mesafeyi 16 metrenin altında tut.');
      } else this.far = 0;
      this.progress = U.sat((L.sTot - this.startS) / N);
      if (L.sTot - this.startS >= N) this.finish(true);
    }
    parts() {
      const T = Math.max(this.sumT, 0.001);
      return { prox: this.sumP / T, ang: this.wA > 0 ? this.sumA / this.wA : 0, line: this.sumL / T };
    }
    score() {
      const p = this.parts();
      return U.clamp(Math.round(100 * (0.45 * p.prox + 0.35 * p.ang + 0.2 * p.line) - this.pen), 0, 100);
    }
    finish(done, note) {
      this.state = 'done';
      this.result = { ...this.parts(), score: done ? this.score() : Math.min(this.score(), 30), done, note: note || '' };
    }
  }

  DS.Leader = Leader;
  DS.TandemJudge = TandemJudge;
})();
