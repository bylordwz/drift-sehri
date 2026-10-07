'use strict';
// Araç dinamiği (iki tekerlekli bisiklet modeli + Pacejka lastik eğrisi + sürtünme çemberi)
// ve üstten görünüş araç çizimi
(function () {
  const DS = window.DS, U = DS.U;
  const G = 9.81;
  const SMU = [1, 0.62, 0.8];   // zemin tutuşu: asfalt, çim, çakıl
  const SROLL = [1, 12, 4];     // zemin yuvarlanma direnci çarpanı

  // Basitleştirilmiş Pacejka "magic formula" (normalize edilmiş, tepe = 1)
  // C: şekil katsayısı — büyüdükçe tepe sonrası kayma bölgesinde tutuş daha çok düşer
  function pac(al, Cc) {
    const B = 9.5, E = 0.25;
    const x = B * al;
    return Math.sin(Cc * Math.atan(x - E * (x - Math.atan(x))));
  }

  class Car {
    constructor(def, setup) {
      this.events = [];
      this.auto = true;
      this.stab = 3.0; // drift yardımı (ayarlardan)
      this._obb = { x: 0, y: 0, c: 1, s: 0, hl: 1, hw: 1 };
      this.setDef(def, setup);
      this.reset(0, 0, 0);
    }

    setDef(def, setup) {
      this.def = def;
      this.setup = setup;
      const lv = (key) => {
        const u = DS.UPGRADES.find((x) => x.key === key);
        return u.levels[U.clamp(setup.upg[key] || 0, 0, u.levels.length - 1)].v;
      };
      const p = (this.p = {});
      p.len = def.len; p.wid = def.wid; p.m = def.mass;
      p.L = def.wb; p.b = def.wb * def.fw; p.a = def.wb - p.b;
      p.cgH = def.cgH;
      p.I = (p.m * (p.len * p.len + p.wid * p.wid)) / 12 * 1.05;
      p.mu = def.mu * lv('tires');
      p.torque = def.torque * lv('engine');
      p.turbo = def.turbo + lv('turbo');
      p.steerMax = ((def.steer + lv('angle')) * Math.PI) / 180;
      p.pos = def.pos * lv('diff');
      p.gears = def.gears; p.final = def.final; p.R = 0.31;
      p.redline = def.redline; p.idle = def.idle;
      p.brake = def.brake;
      p.drag = 0.42; p.roll = 9;
      p.lockGrip = 0.5;
      p.cf = 1.5; p.cr = DS.TUNE.cr;
      p.krpm = (60 / (2 * Math.PI * p.R)) * p.final;
      this.m = p.m; this.I = p.I;
    }

    reset(x, y, h) {
      this.x = x; this.y = y; this.h = h;
      this.px = x; this.py = y; this.ph = h;
      this.vx = 0; this.vy = 0; this.w = 0;
      this.steer = 0; this.rpm = this.p.idle; this.gear = 1;
      this.boost = 0; this.spinEx = 0; this.axf = 0; this.ayf = 0;
      this.shift = 0; this.kick = 0; this.limiter = 0; this.clutchWas = false; this.bovDone = true;
      this.speed = 0; this.vxl = 0; this.vyl = 0; this.beta = 0;
      this.slipR = 0; this.slipF = 0; this.spinning = 0;
      this.brakeOn = false; this.revOn = false; this.thr = 0; this.hb = 0;
      this.surfF = 0; this.surfR = 0; this.dbeta = 0;
      this.events.length = 0;
    }

    ev(name) { this.events.push(name); }

    obb() {
      const o = this._obb;
      o.x = this.x; o.y = this.y; o.c = Math.cos(this.h); o.s = Math.sin(this.h);
      o.hl = this.p.len / 2; o.hw = this.p.wid / 2;
      return o;
    }

    shiftUp() {
      if (this.gear === -1) { this.gear = 1; return; }
      if (this.gear < this.p.gears.length) { this.gear++; this.shift = 0.14; this.ev('shift'); }
    }
    shiftDown() {
      if (this.gear > 1) { this.gear--; this.shift = 0.1; this.ev('down'); }
    }

    // Direksiyon: girdi (-1..1) + otomatik kontra (ön tekerleği hız yönüne hizalar)
    updateSteer(dt, sIn, assist) {
      const p = this.p;
      const speed = this.speed, vxl = this.vxl, vyl = this.vyl;
      let neutral = 0;
      if (speed > 3 && vxl > 0) {
        const vxa = Math.max(Math.abs(vxl), 2.2);
        neutral = Math.atan2(vyl + p.a * this.w, vxa) * assist;
      }
      const beta = speed > 3 ? Math.abs(Math.atan2(vyl, Math.abs(vxl))) : 0;
      const drift = U.smooth(0.06, 0.3, beta);
      const gripLim = U.clamp(1 - speed / 50, 0.32, 1);
      const lim = p.steerMax * U.lerp(gripLim, 1, drift);
      const a = Math.abs(sIn);
      let target = a > 0.001 ? U.lerp(neutral, sIn * lim, a) : neutral;
      target = U.clamp(target, -p.steerMax, p.steerMax);
      this.steer = U.approach(this.steer, target, 7.5 * dt);
    }

    step(dt, inp, city, env) {
      const p = this.p, m = p.m;
      const c = Math.cos(this.h), s = Math.sin(this.h);
      const vxl = c * this.vx + s * this.vy;
      const vyl = -s * this.vx + c * this.vy;
      const speed = Math.hypot(this.vx, this.vy);
      this.speed = speed; this.vxl = vxl; this.vyl = vyl;
      this.beta = speed > 1 ? Math.atan2(vyl, vxl) : 0;

      // ---- vites / geri ----
      if (this.gear === -1) {
        if (inp.throttle > 0.1 && vxl > -1) this.gear = 1;
      } else if (inp.brake > 0.3 && inp.throttle < 0.05 && vxl < 0.6 && speed < 1.5) {
        this.gear = -1;
      }
      let thr = inp.throttle, brk = inp.brake;
      if (this.gear === -1) { thr = inp.brake; brk = inp.throttle; }
      this.thr = thr;
      const gr = this.gear === -1 ? 3.3 : p.gears[this.gear - 1];
      const rpmRoad = Math.abs(vxl) * gr * p.krpm;
      if (this.shift > 0) this.shift -= dt;
      if (this.auto && this.gear >= 1 && this.shift <= 0) {
        // drift sırasında vitesi tut (drifçiler virajı tek viteste döner); 1. vitese sadece yavaşken in
        const drifting = Math.abs(this.beta) > 0.18 && speed > 6;
        if (rpmRoad > p.redline * (drifting ? 0.98 : 0.9) && this.gear < p.gears.length) {
          this.gear++; this.shift = 0.16; this.ev('shift');
        } else if (!drifting && this.gear > 1 && rpmRoad < p.redline * 0.45 &&
          (this.gear > 2 || speed < 5.5) &&
          Math.abs(vxl) * p.gears[this.gear - 2] * p.krpm < p.redline * 0.72) {
          this.gear--; this.shift = 0.1; this.ev('down');
        }
      }

      // ---- debriyaj / el freni ----
      const hb = inp.handbrake ? 1 : 0;
      this.hb = hb;
      const clutchIn = hb > 0 || this.shift > 0;

      // ---- motor devri ----
      const wheelRpm = (Math.abs(vxl) + this.spinEx) * gr * p.krpm;
      if (hb) {
        // el freninde debriyaj basılı: motor boşta gazla devir alır
        const target = p.idle + thr * (p.redline * 1.02 - p.idle);
        this.rpm = U.approach(this.rpm, target, (target > this.rpm ? 9000 : 6000) * dt);
      } else if (clutchIn) {
        this.rpm = U.approach(this.rpm, Math.max(p.idle, wheelRpm), 14000 * dt);
      } else {
        if (this.clutchWas && this.rpm > wheelRpm + 1500 && thr > 0.3 && this.gear >= 1) {
          // debriyaj bırakıldı: biriken devir arka tekerleği patinaja sokar
          const extra = (this.rpm - wheelRpm) / (gr * p.krpm);
          this.spinEx += extra * 0.6;
          this.kick = Math.max(this.kick, 0.18 + ((this.rpm - wheelRpm) / p.redline) * 0.35);
          this.ev('dump');
        }
        // kalkışta debriyaj kaydırma: 1. viteste devir gazla yükselir
        const launch = this.gear === 1 || this.gear === -1 ? p.idle + thr * 2600 : p.idle;
        const target = Math.max(launch, wheelRpm);
        this.rpm = U.approach(this.rpm, target, 30000 * dt);
      }
      this.clutchWas = clutchIn;
      if (this.rpm >= p.redline) { this.rpm = p.redline; if (this.limiter <= 0) { this.limiter = 0.07; this.ev('limiter'); } }
      if (this.limiter > 0) this.limiter -= dt;

      // ---- turbo ----
      const boostT = p.turbo > 0 && thr > 0.5 && this.rpm > p.redline * 0.42 ? 1 : 0;
      const pb = this.boost;
      this.boost = U.approach(this.boost, boostT, (boostT > this.boost ? 0.9 : 3.5) * dt);
      if (pb > 0.55 && thr < 0.2 && !this.bovDone) { this.ev('bov'); this.bovDone = true; }
      if (thr > 0.5) this.bovDone = false;

      // ---- tork ----
      const rn = this.rpm / p.redline;
      let tc = rn < 0.18 ? 0.55 : rn < 0.72 ? 0.55 + 0.45 * Math.sin(((rn - 0.18) / 0.54) * Math.PI / 2) : 1 - (rn - 0.72) * 0.65;
      if (p.turbo > 0) tc *= 0.85 + this.boost * p.turbo;
      let drive = clutchIn || this.limiter > 0 ? 0 : (thr * p.torque * tc * gr * p.final * 0.85) / p.R;
      if (this.gear === -1) drive = -drive;
      if (!clutchIn && thr < 0.05 && Math.abs(vxl) > 1) drive -= Math.sign(vxl) * rn * 450 * gr;

      // ---- debriyaj atma (gaz çift tık / Shift) ----
      if (inp.kick && !clutchIn && this.gear >= 1 && speed > 3) {
        this.kick = 0.34;
        this.rpm = Math.min(p.redline, this.rpm + 1800);
        this.spinEx += 7;
        this.ev('kick');
      }
      if (this.kick > 0) this.kick -= dt;

      // ---- aks yükleri (ağırlık transferi) ----
      let Fzf = (m * G * p.b) / p.L - (m * this.axf * p.cgH) / p.L;
      let Fzr = (m * G * p.a) / p.L + (m * this.axf * p.cgH) / p.L;
      Fzf = Math.max(Fzf, m * G * 0.12);
      Fzr = Math.max(Fzr, m * G * 0.12);

      // ---- zemin ----
      let sf = 0, sr = 0;
      if (city) {
        sf = city.surfaceAt(this.x + c * p.a, this.y + s * p.a);
        sr = city.surfaceAt(this.x - c * p.b, this.y - s * p.b);
      }
      this.surfF = sf; this.surfR = sr;
      const wet = env && env.rain ? 0.8 : 1;
      const Gf = p.mu * SMU[sf] * wet * Fzf;
      const Gr = p.mu * SMU[sr] * wet * Fzr;

      // ---- kayma açıları ----
      const dirS = vxl >= 0 ? 1 : -1;
      const vxa = Math.max(Math.abs(vxl), 2.2);
      const af = Math.atan2(vyl + p.a * this.w, vxa) - this.steer * dirS;
      const ar = Math.atan2(vyl - p.b * this.w, vxa);
      let fyF = -pac(af, p.cf) * Gf;
      let fyR = -pac(ar, p.cr) * Gr;

      // ---- boyuna kuvvetler ----
      let fxF = 0, fxR = drive;
      this.brakeOn = brk > 0.05;
      this.revOn = this.gear === -1;
      if (brk > 0.01) {
        const bf = brk * p.brake;
        if (Math.abs(vxl) > 0.6) { fxF -= dirS * bf * 0.62; fxR -= dirS * bf * 0.38; }
        else fxF -= vxl * m * 3;
      }
      if (hb) {
        if (Math.abs(vxl) > 0.5) fxR -= dirS * Gr * 0.9;
        else fxR -= vxl * m * 2;
        fyR *= p.lockGrip;
      }
      // kayarken gaz arka yanal tutuşu düşürür (güç-savrulma)
      const slide = U.smooth(DS.TUNE.s0, DS.TUNE.s1, Math.abs(ar));
      if (!clutchIn && this.gear >= 1) fyR *= 1 - thr * p.pos * DS.TUNE.posK * slide;
      if (this.kick > 0) fyR *= 0.55;

      // ---- sürtünme çemberi ----
      const tR = Math.hypot(fxR, fyR);
      this.spinning = 0;
      if (tR > Gr) {
        const k = Gr / tR;
        this.spinning = U.sat((tR / Gr - 1) * 1.5);
        fxR *= k; fyR *= k;
      }
      const tF = Math.hypot(fxF, fyF);
      if (tF > Gf) { const k = Gf / tF; fxF *= k; fyF *= k; }

      // ---- patinaj (devir ve duman için sanal teker hızı) ----
      let spinT = 0;
      if (!clutchIn && thr > 0.05 && this.gear >= 1) {
        spinT = Math.max(0, Math.abs(drive) / Math.max(Gr, 1) - 0.95) * 9 + slide * thr * 6;
      }
      if (this.kick > 0) spinT += 8;
      this.spinEx = hb ? 0 : U.approach(this.spinEx, Math.min(spinT, 30), (spinT > this.spinEx ? 40 : 22) * dt);

      // efektler için kayma hızları
      const latR = vyl - p.b * this.w;
      const latSlip = Math.max(0, Math.abs(latR) - vxa * 0.12);
      const longSlip = hb ? Math.abs(vxl) * 0.8 : this.spinEx;
      this.slipR = Math.hypot(latSlip, longSlip);
      const latF = vyl + p.a * this.w;
      this.slipF = Math.max(0, Math.abs(latF * Math.cos(this.steer) - vxl * Math.sin(this.steer)) - vxa * 0.22);
      if (brk > 0.8 && Math.abs(vxl) > 8) this.slipF = Math.max(this.slipF, (brk - 0.8) * 10);

      // ---- gövdeye kuvvetler ----
      const cd = Math.cos(this.steer), sd = Math.sin(this.steer);
      let Fx = fxF * cd - fyF * sd + fxR;
      let Fy = fxF * sd + fyF * cd + fyR;
      const roll = p.roll * (SROLL[sf] + SROLL[sr]) * 0.5;
      Fx -= p.drag * vxl * Math.abs(vxl) + roll * vxl;
      Fy -= p.drag * 1.6 * vyl * Math.abs(vyl) + roll * vyl;
      if (speed < 2.5) Fy -= vyl * m * 2.5 * (1 - speed / 2.5);
      let tq = p.a * (fxF * sd + fyF * cd) - p.b * fyR;
      // Drift dengeleyici: kayma açısının değişim hızını sönümler (spin ve sönmeyi yavaşlatır)
      const driftMask = speed > 6 && vxl > 0 ? U.smooth(0.05, 0.2, Math.abs(this.beta)) : 0;
      tq += p.I * this.stab * this.dbeta * driftMask;

      // ---- entegrasyon ----
      const axl = Fx / m, ayl = Fy / m;
      const psi0 = Math.atan2(this.vy, this.vx);
      this.axf = U.damp(this.axf, U.clamp(axl, -12, 12), 10, dt);
      this.ayf = U.damp(this.ayf, U.clamp(ayl, -14, 14), 8, dt);
      this.vx += (c * axl - s * ayl) * dt;
      this.vy += (s * axl + c * ayl) * dt;
      if (speed > 1) {
        const dpsi = U.wrap(Math.atan2(this.vy, this.vx) - psi0) / dt;
        this.dbeta = U.damp(this.dbeta, dpsi - this.w, 30, dt);
      } else this.dbeta = 0;
      this.w += (tq / p.I) * dt;
      if (speed < 1.5) this.w *= Math.max(0, 1 - 6 * dt * (1 - speed / 1.5));
      this.h += this.w * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (speed < 0.35 && thr < 0.02 && brk < 0.02) { this.vx *= 0.9; this.vy *= 0.9; this.w *= 0.9; }
    }

    // Tekerlek dünya konumları: ÖS, ÖSğ, AS, ASğ
    wheels(out) {
      const p = this.p, c = Math.cos(this.h), s = Math.sin(this.h);
      const tw = p.wid * 0.43;
      const pts = [[p.a, -tw], [p.a, tw], [-p.b, -tw], [-p.b, tw]];
      for (let i = 0; i < 4; i++) {
        const [lx, ly] = pts[i];
        out[i * 2] = this.x + c * lx - s * ly;
        out[i * 2 + 1] = this.y + s * lx + c * ly;
      }
      return out;
    }
  }
  DS.Car = Car;

  // ================= ÇİZİM =================
  const PX = 26;
  const PARK_COLORS = ['#8a8f98', '#f2efe6', '#1b1d22', '#c8102e', '#1d4e9e', '#b5a27a', '#2f6f4f', '#7fd1ff'];
  // açık dünya kaplamaları ('polis', 'taksi'): garaj listesinde (DS.LIVERIES) yoklar
  const POLIS_WHITE = '#f4f6f8', POLIS_BLUE = '#1f4fa8', POLIS_BAND = 0.15;

  function bodyPath(g, L, W, sh) {
    const hl = L / 2, hw = W / 2;
    const hf = hw * sh.taperF, hr = hw * sh.taperR;
    const rn = sh.nose * W, rt = sh.tail * W;
    g.beginPath();
    g.moveTo(-hl + rt, -hr);
    g.bezierCurveTo(-hl * 0.35, -hw * 1.01, hl * 0.35, -hw * 1.01, hl - rn, -hf);
    g.quadraticCurveTo(hl, -hf, hl, -hf + rn);
    g.quadraticCurveTo(hl + 0.05, 0, hl, hf - rn);
    g.quadraticCurveTo(hl, hf, hl - rn, hf);
    g.bezierCurveTo(hl * 0.35, hw * 1.01, -hl * 0.35, hw * 1.01, -hl + rt, hr);
    g.quadraticCurveTo(-hl, hr, -hl, hr - rt);
    g.quadraticCurveTo(-hl - 0.03, 0, -hl, -hr + rt);
    g.quadraticCurveTo(-hl, -hr, -hl + rt, -hr);
    g.closePath();
  }

  function contrast(hex) { return U.luma(hex) > 0.55 ? '#16181c' : '#f4f1ea'; }

  const CR = (DS.CarRender = {
    PX,
    cache: new Map(),

    sprite(def, setup) {
      const key = [def.id, setup.color, setup.livery, setup.wing ? 1 : 0, setup.bar ? 1 : 0, setup.sign ? 1 : 0].join('|');
      let s = this.cache.get(key);
      if (!s) {
        s = this.build(def, setup);
        this.cache.set(key, s);
        if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
      }
      return s;
    },

    build(def, setup) {
      const L = def.len, W = def.wid, sh = def.shape;
      const mw = L + 0.9, mh = W + 0.9;
      const c = U.canvas(mw * PX, mh * PX), g = c.getContext('2d');
      g.scale(PX, PX);
      g.translate(mw / 2, mh / 2);
      const hl = L / 2, hw = W / 2;
      const lv = setup.livery;
      // polis kaplaması her zaman beyaz gövde üstüne çizilir
      const col = lv === 'polis' ? POLIS_WHITE : setup.color;
      const xW0 = hl - L * sh.hood, xW1 = xW0 - L * sh.wind, xR1 = xW1 - L * sh.roof, xB1 = xR1 - L * sh.rear;
      const cw = hw * sh.cabin, rw = cw * 0.86;

      // gövde
      bodyPath(g, L, W, sh);
      const gr = g.createLinearGradient(0, -hw, 0, hw);
      gr.addColorStop(0, U.shade(col, -0.45));
      gr.addColorStop(0.16, U.shade(col, -0.1));
      gr.addColorStop(0.5, U.shade(col, 0.14));
      gr.addColorStop(0.84, U.shade(col, -0.1));
      gr.addColorStop(1, U.shade(col, -0.45));
      g.fillStyle = gr; g.fill();
      g.save();
      bodyPath(g, L, W, sh); g.clip();
      // boyuna parlaklık
      const lg = g.createLinearGradient(-hl, 0, hl, 0);
      lg.addColorStop(0, 'rgba(0,0,0,0.12)'); lg.addColorStop(0.45, 'rgba(255,255,255,0.06)'); lg.addColorStop(1, 'rgba(0,0,0,0.08)');
      g.fillStyle = lg; g.fillRect(-hl, -hw, L, W);
      // kaplamalar
      const cc = contrast(col);
      if (lv === 'stripes') {
        g.fillStyle = cc;
        g.fillRect(-hl, -W * 0.17, L, W * 0.09);
        g.fillRect(-hl, W * 0.08, L, W * 0.09);
      } else if (lv === 'panda') {
        g.lineWidth = 0.34; g.strokeStyle = '#141518';
        bodyPath(g, L, W, sh); g.stroke();
        g.fillStyle = '#141518';
        g.fillRect(hl - 0.22, -hw, 0.3, W);
        g.fillRect(-hl - 0.05, -hw, 0.26, W);
      } else if (lv === 'tiger') {
        g.fillStyle = cc;
        for (let x = -hl + 0.4; x < hl - 0.3; x += 0.62) {
          for (const sgn of [-1, 1]) {
            g.beginPath();
            g.moveTo(x, sgn * hw); g.lineTo(x + 0.22, sgn * hw);
            g.lineTo(x + 0.42, sgn * hw * 0.45); g.lineTo(x + 0.3, sgn * hw * 0.4);
            g.closePath(); g.fill();
          }
        }
      } else if (lv === 'split') {
        g.fillStyle = cc;
        g.beginPath(); g.moveTo(xW1 + 0.3, -hw - 0.1); g.lineTo(xW1 - 0.3, hw + 0.1); g.lineTo(-hl - 0.1, hw + 0.1); g.lineTo(-hl - 0.1, -hw - 0.1); g.closePath(); g.fill();
      } else if (lv === 'sticker') {
        const r = U.rng(def.id.length * 977 + col.length);
        const cols = ['#ff3a3a', '#ffd400', '#38d9ff', '#ffffff', '#16181c', '#4cff8a', '#ff4fd8', '#ff8a1f'];
        for (let k = 0; k < 34; k++) {
          g.fillStyle = cols[Math.floor(r() * cols.length)];
          const x = U.lerp(-hl + 0.1, hl - 0.2, r()), y = U.lerp(-hw, hw, r());
          const w = 0.18 + r() * 0.35, h = 0.1 + r() * 0.22;
          g.save(); g.translate(x, y); g.rotate((r() - 0.5) * 0.8);
          if (r() < 0.3) { g.beginPath(); g.arc(0, 0, h, 0, U.TAU); g.fill(); } else g.fillRect(-w / 2, -h / 2, w, h);
          g.restore();
        }
      } else if (lv === 'polis') {
        // iki yanda mavi bant (toplam genişliğin %30'u) ve siyah tamponlar
        const bw = W * POLIS_BAND;
        g.fillStyle = POLIS_BLUE;
        g.fillRect(-hl - 0.1, -hw - 0.1, L + 0.2, bw + 0.1);
        g.fillRect(-hl - 0.1, hw - bw, L + 0.2, bw + 0.1);
        g.fillStyle = '#121418';
        g.fillRect(hl - 0.13, -hw - 0.1, 0.25, W + 0.2);
        g.fillRect(-hl - 0.12, -hw - 0.1, 0.25, W + 0.2);
      }
      g.restore();

      // kaput detayları
      g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 0.03;
      g.beginPath();
      g.moveTo(xW0 + 0.02, -cw); g.lineTo(hl - 0.3, -hw * sh.taperF + 0.1);
      g.moveTo(xW0 + 0.02, cw); g.lineTo(hl - 0.3, hw * sh.taperF - 0.1);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.1)'; g.lineWidth = 0.03;
      g.beginPath(); g.moveTo(xW0 + 0.1, -0.18); g.lineTo(hl - 0.25, -0.14); g.moveTo(xW0 + 0.1, 0.18); g.lineTo(hl - 0.25, 0.14); g.stroke();
      if (def.turbo > 0) {
        g.fillStyle = 'rgba(10,10,12,0.55)';
        for (let k = 0; k < 4; k++) g.fillRect(xW0 + 0.25 + k * 0.1, -0.22, 0.05, 0.44);
      }
      if (sh.scoop) {
        g.fillStyle = U.shade(col, -0.25); g.fillRect(xW0 + 0.25, -0.3, 0.75, 0.6);
        g.fillStyle = '#101114'; g.fillRect(xW0 + 0.85, -0.22, 0.12, 0.44);
      }
      if (!sh.hatch) {
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.03;
        g.beginPath(); g.moveTo(xB1 - 0.05, -cw * 0.95); g.lineTo(xB1 - 0.05, cw * 0.95); g.stroke();
      }
      if (lv === 'polis') {
        // kaputta enine "POLİS" yazısı (yalnızca yapımda bir kez)
        const mx = (xW0 + hl) / 2, maxW = W * (1 - 2 * POLIS_BAND) * 0.98;
        let fs = Math.min((hl - xW0) * 0.5, W * 0.24);
        g.save(); g.translate(mx, 0); g.rotate(Math.PI / 2);
        g.font = `800 ${fs}px Arial, Helvetica, sans-serif`;
        const tw = g.measureText('POLİS').width;
        if (tw > maxW) { fs *= maxW / tw; g.font = `800 ${fs}px Arial, Helvetica, sans-serif`; }
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = POLIS_BLUE;
        g.fillText('POLİS', 0, 0);
        g.restore();
      }

      // yan camlar
      g.fillStyle = 'rgba(14,18,26,0.92)';
      for (const sg of [-1, 1]) {
        g.beginPath();
        g.moveTo(xW0 - 0.05, sg * cw * 0.98); g.lineTo(xB1 + 0.05, sg * cw * 0.95);
        g.lineTo(xB1 + 0.1, sg * rw); g.lineTo(xW1, sg * rw);
        g.closePath(); g.fill();
      }
      // ön cam
      const glass = (x0, w0, x1, w1) => {
        g.beginPath(); g.moveTo(x0, -w0); g.lineTo(x0, w0); g.lineTo(x1, w1); g.lineTo(x1, -w1); g.closePath();
        const gg = g.createLinearGradient(x0, -w0, x1, w1);
        gg.addColorStop(0, '#1d2a3a'); gg.addColorStop(0.5, '#0c1119'); gg.addColorStop(1, '#162232');
        g.fillStyle = gg; g.fill();
        g.save(); g.clip();
        g.fillStyle = 'rgba(255,255,255,0.13)';
        g.beginPath(); g.moveTo(x0, -w0 * 0.2); g.lineTo(x0, w0 * 0.15); g.lineTo(x1, -w1 * 0.4); g.lineTo(x1, -w1 * 0.8); g.closePath(); g.fill();
        g.restore();
      };
      glass(xW0, cw * 0.98, xW1, rw);
      // tavan
      g.beginPath();
      g.moveTo(xW1, -rw); g.lineTo(xR1, -rw); g.lineTo(xR1, rw); g.lineTo(xW1, rw); g.closePath();
      const rg = g.createLinearGradient(0, -rw, 0, rw);
      rg.addColorStop(0, U.shade(col, -0.18)); rg.addColorStop(0.5, U.shade(col, 0.18)); rg.addColorStop(1, U.shade(col, -0.18));
      g.fillStyle = lv === 'split' ? U.shade(cc, 0.05) : rg; g.fill();
      if (lv === 'stripes') {
        g.fillStyle = cc;
        g.fillRect(xR1, -W * 0.17, xW1 - xR1, W * 0.09); g.fillRect(xR1, W * 0.08, xW1 - xR1, W * 0.09);
      }
      if (lv === 'number') {
        const r = Math.min(rw * 0.85, (xW1 - xR1) * 0.42);
        const mx = (xW1 + xR1) / 2;
        g.beginPath(); g.arc(mx, 0, r, 0, U.TAU); g.fillStyle = '#f7f5ef'; g.fill();
        g.lineWidth = 0.04; g.strokeStyle = '#16181c'; g.stroke();
        g.save(); g.translate(mx, 0); g.rotate(Math.PI / 2);
        g.font = `700 ${r * 1.05}px Bungee, Impact, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#16181c';
        g.fillText(def.num, 0, r * 0.06);
        g.restore();
      }
      if (lv === 'taksi') {
        // tavan kenarlarında siyah/beyaz dama şeridi
        const n = Math.max(2, Math.round((xW1 - xR1) / 0.16)), st = (xW1 - xR1) / n, q = Math.min(0.16, rw * 0.3);
        for (let i = 0; i < n; i++) {
          g.fillStyle = i & 1 ? '#16181c' : '#f4f1ea';
          g.fillRect(xR1 + i * st, -rw, st, q);
          g.fillStyle = i & 1 ? '#f4f1ea' : '#16181c';
          g.fillRect(xR1 + i * st, rw - q, st, q);
        }
      }
      const rx = (xW1 + xR1) / 2;
      if (setup.bar) {
        // tavan çakar çubuğu (sönük hâli; yanıp sönen parlaklık ActorSprites.drawSirenBar'da)
        g.fillStyle = '#15171b'; g.fillRect(rx - 0.175, -0.55, 0.35, 1.1);
        g.globalAlpha = 0.55;
        g.fillStyle = '#ff2a2a'; g.fillRect(rx - 0.135, -0.51, 0.27, 0.42);
        g.fillStyle = '#2a6bff'; g.fillRect(rx - 0.135, 0.09, 0.27, 0.42);
        g.globalAlpha = 0.9;
        g.fillStyle = '#f4f6f8'; g.fillRect(rx - 0.09, -0.07, 0.18, 0.14);
        g.globalAlpha = 1;
      }
      if (setup.sign) {
        // taksi tavan lambası: sarı kenarlı beyaz kutu
        g.fillStyle = '#ffc400'; g.fillRect(rx - 0.15, -0.4, 0.3, 0.8);
        g.fillStyle = '#ffffff'; g.fillRect(rx - 0.11, -0.36, 0.22, 0.72);
        g.fillStyle = '#16181c'; g.fillRect(rx - 0.02, -0.24, 0.04, 0.48);
      }
      // arka cam
      glass(xR1, rw, xB1, cw * 0.95);
      // aynalar
      g.fillStyle = U.shade(col, -0.3);
      for (const sg of [-1, 1]) { g.beginPath(); g.ellipse(xW0 - 0.12, sg * (hw + 0.04), 0.1, 0.07, 0, 0, U.TAU); g.fill(); }
      // farlar
      const hf = hw * sh.taperF;
      for (const sg of [-1, 1]) {
        if (sh.popups) {
          g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.025;
          g.strokeRect(hl - 0.62, sg > 0 ? hf - 0.48 : -hf + 0.1, 0.42, 0.38);
        } else {
          g.fillStyle = '#d9e2e8';
          g.fillRect(hl - 0.3, sg > 0 ? hf - 0.48 : -hf + 0.1, 0.24, 0.38);
          g.fillStyle = '#ffffff';
          g.fillRect(hl - 0.2, sg > 0 ? hf - 0.4 : -hf + 0.18, 0.1, 0.22);
        }
      }
      // ön tampon / ızgara
      g.fillStyle = 'rgba(12,12,14,0.75)';
      g.fillRect(hl - 0.1, -hw * 0.35, 0.08, hw * 0.7);
      // stoplar
      const hr = hw * sh.taperR;
      for (const sg of [-1, 1]) {
        g.fillStyle = '#7d0d12';
        g.fillRect(-hl + 0.02, sg > 0 ? hr - 0.5 : -hr + 0.08, 0.18, 0.42);
        g.fillStyle = '#d31f26';
        g.fillRect(-hl + 0.05, sg > 0 ? hr - 0.44 : -hr + 0.13, 0.1, 0.3);
      }
      g.fillStyle = '#f1f1ea'; g.fillRect(-hl - 0.02, -0.22, 0.05, 0.44);
      // kanat
      if (setup.wing) {
        const wx = -hl + 0.3;
        g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(wx - 0.08, -hw * 0.92, 0.28, hw * 1.84);
        g.fillStyle = '#17181b'; g.fillRect(wx, -hw * 0.95, 0.24, hw * 1.9);
        g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(wx + 0.02, -hw * 0.95, 0.05, hw * 1.9);
        g.fillStyle = '#0d0e10';
        g.fillRect(wx - 0.08, -hw * 0.98, 0.4, 0.06); g.fillRect(wx - 0.08, hw * 0.92, 0.4, 0.06);
      }
      return { c, w: mw, h: mh };
    },

    // Tavan ortasının araç ekseni üzerindeki konumu (m, ağırlık merkezinden öne +): çakar/taksi lambası
    roofX(def) {
      const L = def.len, sh = def.shape;
      return L / 2 - L * (sh.hood + sh.wind + sh.roof / 2);
    },

    wheel(ctx, x, y, ang, rim) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.fillStyle = '#0c0c0e'; ctx.fillRect(-0.32, -0.13, 0.64, 0.26);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      for (let k = -0.24; k < 0.3; k += 0.12) ctx.fillRect(k, -0.13, 0.04, 0.26);
      ctx.fillStyle = rim; ctx.fillRect(-0.22, y > 0 ? 0.08 : -0.12, 0.44, 0.04);
      ctx.restore();
    },

    drawCar(ctx, car) {
      const def = car.def, st = car.setup;
      // sprite'ı araçta önbelleğe al; kurulum değişince anahtar değişir
      if (!car._spr || car._sprDef !== def || car._sprC !== st.color || car._sprL !== st.livery || car._sprW !== st.wing ||
        car._sprB !== st.bar || car._sprS !== st.sign) {
        car._spr = this.sprite(def, st); car._sprDef = def; car._sprC = st.color; car._sprL = st.livery; car._sprW = st.wing;
        car._sprB = st.bar; car._sprS = st.sign;
      }
      const spr = car._spr;
      const tw = def.wid * 0.43;
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.h);
      const rim = car.setup.rim;
      this.wheel(ctx, car.p.a, -tw, car.steer, rim);
      this.wheel(ctx, car.p.a, tw, car.steer, rim);
      this.wheel(ctx, -car.p.b, -tw, 0, rim);
      this.wheel(ctx, -car.p.b, tw, 0, rim);
      const ox = U.clamp(-car.axf * 0.008, -0.07, 0.07), oy = U.clamp(-car.ayf * 0.011, -0.11, 0.11);
      ctx.drawImage(spr.c, -spr.w / 2 + ox, -spr.h / 2 + oy, spr.w, spr.h);
      const hl = def.len / 2, hr = (def.wid / 2) * def.shape.taperR;
      if (car.brakeOn) {
        ctx.fillStyle = '#ff2a2a';
        ctx.fillRect(-hl + 0.05 + ox, hr - 0.46 + oy, 0.13, 0.34);
        ctx.fillRect(-hl + 0.05 + ox, -hr + 0.12 + oy, 0.13, 0.34);
      }
      if (car.revOn) {
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(-hl + 0.05 + ox, hr - 0.62 + oy, 0.1, 0.12);
        ctx.fillRect(-hl + 0.05 + ox, -hr + 0.5 + oy, 0.1, 0.12);
      }
      ctx.restore();
    },

    drawShadow(ctx, car, env) {
      const L = car.def.len + 0.3, W = car.def.wid + 0.25;
      let ox = 0.2, oy = 0.2;
      if (env.sun) { ox = Math.min(env.sun.x, 0.8) * 1.2; oy = Math.min(env.sun.y, 0.5) * 1.2; }
      ctx.save();
      ctx.translate(car.x + ox, car.y + oy);
      ctx.rotate(car.h);
      const a = env.sun ? env.shadowA : 0.42;
      if (env._shA !== a) { env._shA = a; env._sh = [`rgba(8,10,20,${a * 0.45})`, `rgba(8,10,20,${a * 0.75})`]; }
      for (let q = 0; q < 2; q++) {
        const grow = q === 0 ? 0.35 : 0;
        ctx.fillStyle = env._sh[q];
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-L / 2 - grow, -W / 2 - grow, L + grow * 2, W + grow * 2, 0.45 + grow);
        else ctx.rect(-L / 2 - grow, -W / 2 - grow, L + grow * 2, W + grow * 2);
        ctx.fill();
      }
      ctx.restore();
    },

    parkSetup(vi) {
      const def = DS.CARS[vi % DS.CARS.length];
      return { def, setup: { color: PARK_COLORS[vi % PARK_COLORS.length], livery: 'none', wing: false, rim: '#b8b8b8' } };
    },

    // Park hâlindeki araç: gölge sprite'a gömülü, matris doğrudan kurulur (save/restore yok)
    parkedSprite(vi) {
      const pc = this._parked || (this._parked = []);
      if (pc[vi]) return pc[vi];
      const { def, setup } = this.parkSetup(vi);
      const spr = this.build(def, setup);
      const c = U.canvas(spr.c.width, spr.c.height), g = c.getContext('2d');
      g.scale(PX, PX);
      g.fillStyle = 'rgba(8,10,20,0.35)';
      g.fillRect(spr.w / 2 - def.len / 2 + 0.1, spr.h / 2 - def.wid / 2 + 0.05, def.len, def.wid);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(spr.c, 0, 0);
      return (pc[vi] = { c, w: spr.w, h: spr.h });
    },
    prewarmParked() { for (let i = 0; i < 8; i++) this.parkedSprite(i); },
    drawParked(ctx, p, M) {
      const spr = p.spr || (p.spr = this.parkedSprite(p.v));
      if (p.co === undefined) { p.co = Math.cos(p.ang); p.si = Math.sin(p.ang); }
      const a = M[0], b = M[1], c = M[2], d = M[3], co = p.co, si = p.si;
      ctx.setTransform(a * co + c * si, b * co + d * si, c * co - a * si, d * co - b * si, a * p.x + c * p.y + M[4], b * p.x + d * p.y + M[5]);
      ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
    },

    // Gece ışık haritası: farlar, stoplar, alt neon
    drawLights(lctx, car, env) {
      const spr = DS.Sprites, def = car.def;
      const hl = def.len / 2, hw = def.wid / 2;
      lctx.save();
      lctx.translate(car.x, car.y);
      lctx.rotate(car.h);
      lctx.globalAlpha = env.headA;
      for (const sg of [-1, 1]) {
        lctx.drawImage(spr.cone, hl - 0.2, sg * (hw - 0.35) - 7, 28, 14);
      }
      lctx.globalAlpha = 1;
      const br = car.brakeOn ? 1 : 0.45;
      lctx.globalAlpha = br;
      const r = car.brakeOn ? 3.2 : 2;
      for (const sg of [-1, 1]) lctx.drawImage(spr.red, -hl - r * 0.6, sg * (hw - 0.3) - r / 2, r * 1.2, r);
      if (car.revOn) { lctx.globalAlpha = 0.8; lctx.drawImage(spr.white, -hl - 5, -2.5, 6, 5); }
      lctx.globalAlpha = 1;
      if (car.setup.glow && car.setup.glow !== 'none') {
        const g = spr.tint(car.setup.glow);
        lctx.globalAlpha = 0.9;
        lctx.drawImage(g, -hl - 1.2, -hw - 1.6, def.len + 2.4, def.wid + 3.2);
        lctx.globalAlpha = 1;
      }
      lctx.restore();
    },

    // Parlama: far camları, stop lambaları
    drawGlow(ctx, car, env) {
      const spr = DS.Sprites, def = car.def;
      const hl = def.len / 2, hw = def.wid / 2;
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.h);
      ctx.globalAlpha = 0.75 * env.headA;
      for (const sg of [-1, 1]) ctx.drawImage(spr.white, hl - 0.6, sg * (hw - 0.35) - 0.5, 1.0, 1.0);
      const br = car.brakeOn ? 1 : 0.5;
      ctx.globalAlpha = br * Math.max(0.5, env.headA);
      const r = car.brakeOn ? 1.3 : 0.8;
      for (const sg of [-1, 1]) ctx.drawImage(spr.red, -hl - r / 2 + 0.1, sg * (hw - 0.3) - r / 2, r, r);
      ctx.restore();
    },

    // Garaj önizlemesi
    drawPreview(g, w, h, def, setup, t) {
      g.clearRect(0, 0, w, h);
      // araç dikey çizildiği için uzunluk yükseklikle, genişlik enle sınırlanır
      const sc = Math.min(h / (def.len + 1.4), w / (def.wid + 2.6));
      g.save();
      g.translate(w / 2, h / 2);
      g.scale(sc, sc);
      g.rotate(-Math.PI / 2 + Math.sin(t * 0.6) * 0.18);
      const car = { x: 0, y: 0, h: 0, steer: Math.sin(t * 0.9) * 0.35, def, setup, p: { a: def.wb * (1 - def.fw), b: def.wb * def.fw }, axf: 0, ayf: Math.sin(t * 0.6) * 4, brakeOn: false };
      g.fillStyle = 'rgba(0,0,0,0.38)';
      g.beginPath(); g.ellipse(0.12, 0.1, def.len * 0.55, def.wid * 0.68, 0, 0, U.TAU); g.fill();
      if (setup.glow && setup.glow !== 'none') {
        g.globalAlpha = 0.65;
        g.drawImage(DS.Sprites.tint(setup.glow), -def.len / 2 - 1, -def.wid / 2 - 1.3, def.len + 2, def.wid + 2.6);
        g.globalAlpha = 1;
      }
      this.drawCar(g, car);
      g.restore();
    },
  });
  void CR;
})();
