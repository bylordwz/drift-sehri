'use strict';
// Görsel efektler: hazır sprite'lar, parçacıklar (duman, kıvılcım, alev, toz, su), lastik izi katmanı, yağmur
(function () {
  const DS = window.DS, U = DS.U;

  // ---------------- SPRITE'LAR ----------------
  const Sprites = (DS.Sprites = {
    _tint: new Map(),
    _smoke: new Map(),
    init() {
      this.white = this.glow([255, 255, 255]);
      this.sodium = this.glow([255, 176, 84]);
      this.red = this.glow([255, 38, 28]);
      this.cone = this.makeCone();
      this.flame = this.makeFlame();
      this.puffs = [];
      for (let i = 0; i < 4; i++) this.puffs.push(this.makePuff(i));
      this.trees = [];
      for (let i = 0; i < 4; i++) this.trees.push(this.makeTree(i));
    },
    glow(rgb) {
      const S = 128, c = U.canvas(S, S), g = c.getContext('2d');
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      const [r, gg, b] = rgb;
      gr.addColorStop(0, `rgba(${r},${gg},${b},1)`);
      gr.addColorStop(0.18, `rgba(${r},${gg},${b},0.62)`);
      gr.addColorStop(0.45, `rgba(${r},${gg},${b},0.2)`);
      gr.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      return c;
    },
    tint(hex) {
      let c = this._tint.get(hex);
      if (!c) { c = this.glow(U.hex2rgb(hex)); this._tint.set(hex, c); }
      return c;
    },
    makeCone() {
      const W = 256, H = 128, c = U.canvas(W, H), g = c.getContext('2d');
      for (let k = 0; k < 11; k++) {
        const half = 0.44 * (1 - k / 12);
        const gr = g.createRadialGradient(0, H / 2, 0, 0, H / 2, W);
        gr.addColorStop(0, 'rgba(255,246,220,0.95)');
        gr.addColorStop(0.25, 'rgba(255,240,205,0.55)');
        gr.addColorStop(1, 'rgba(255,236,200,0)');
        g.fillStyle = gr;
        g.globalAlpha = 0.13;
        g.beginPath(); g.moveTo(0, H / 2);
        g.lineTo(W, H / 2 - Math.tan(half) * W); g.lineTo(W, H / 2 + Math.tan(half) * W); g.closePath();
        g.fill();
      }
      return c;
    },
    makeFlame() {
      const W = 128, H = 64, c = U.canvas(W, H), g = c.getContext('2d');
      const layer = (len, wid, stops) => {
        g.save(); g.translate(0, H / 2); g.scale(len, wid);
        const gr = g.createRadialGradient(0.15, 0, 0, 0.15, 0, 1);
        stops.forEach(([o, col]) => gr.addColorStop(o, col));
        g.fillStyle = gr; g.beginPath(); g.arc(0.15, 0, 1, 0, U.TAU); g.fill();
        g.restore();
      };
      layer(120, 28, [[0, 'rgba(255,120,30,0.9)'], [0.6, 'rgba(255,60,10,0.45)'], [1, 'rgba(200,20,0,0)']]);
      layer(80, 17, [[0, 'rgba(255,230,120,1)'], [0.7, 'rgba(255,160,40,0.6)'], [1, 'rgba(255,120,20,0)']]);
      layer(34, 9, [[0, 'rgba(230,245,255,1)'], [0.6, 'rgba(140,190,255,0.7)'], [1, 'rgba(80,120,255,0)']]);
      return c;
    },
    makePuff(seed) {
      const S = 128, c = U.canvas(S, S), g = c.getContext('2d');
      const r = U.rng(seed * 7919 + 13);
      for (let k = 0; k < 10; k++) {
        const x = S / 2 + (r() - 0.5) * S * 0.34, y = S / 2 + (r() - 0.5) * S * 0.34, rr = S * (0.17 + r() * 0.17);
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, 'rgba(255,255,255,0.34)');
        gr.addColorStop(0.55, 'rgba(255,255,255,0.13)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, S, S);
      }
      g.globalCompositeOperation = 'destination-in';
      const m = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(0.6, 'rgba(0,0,0,0.85)'); m.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = m; g.fillRect(0, 0, S, S);
      return c;
    },
    smoke(hex) {
      let arr = this._smoke.get(hex);
      if (arr) return arr;
      arr = this.puffs.map((p, i) => {
        const c = U.canvas(p.width, p.height), g = c.getContext('2d');
        g.drawImage(p, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = hex; g.fillRect(0, 0, c.width, c.height);
        g.globalCompositeOperation = 'source-atop';
        const r = U.rng(i * 31 + hex.length);
        for (let k = 0; k < 5; k++) {
          const x = r() * c.width, y = r() * c.height, rr = 20 + r() * 30;
          const gr = g.createRadialGradient(x, y, 0, x, y, rr);
          gr.addColorStop(0, 'rgba(0,0,0,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
        }
        return c;
      });
      this._smoke.set(hex, arr);
      return arr;
    },
    makeTree(v) {
      const S = 128, c = U.canvas(S, S), g = c.getContext('2d');
      const r = U.rng(v * 101 + 7);
      const base = [['#264f22', '#356b2d', '#4a8a3a'], ['#2c5a26', '#3d7a33', '#5b9a44'], ['#1f4a2a', '#2f6a3b', '#4a8a52'], ['#3a5a1f', '#4f7a2a', '#6f9a3a']][v];
      const lobes = [];
      for (let k = 0; k < 9; k++) {
        const a = r() * U.TAU, d = r() * S * 0.22;
        lobes.push([S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, S * (0.17 + r() * 0.1)]);
      }
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (const [x, y, rr] of lobes) { g.beginPath(); g.arc(x + 4, y + 4, rr, 0, U.TAU); g.fill(); }
      for (const [x, y, rr] of lobes) {
        const gr = g.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.1, x, y, rr);
        gr.addColorStop(0, base[2]); gr.addColorStop(0.6, base[1]); gr.addColorStop(1, base[0]);
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, U.TAU); g.fill();
      }
      g.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < 140; k++) {
        g.fillStyle = r() < 0.5 ? 'rgba(255,255,220,0.08)' : 'rgba(0,20,0,0.12)';
        g.beginPath(); g.arc(r() * S, r() * S, 1.5 + r() * 3, 0, U.TAU); g.fill();
      }
      return c;
    },
  });

  // ---------------- LASTİK İZİ KATMANI ----------------
  class SkidLayer {
    constructor() {
      this.res = 8; this.size = 64; this.map = new Map(); this.max = 56; this.clock = 0;
    }
    get(cx, cy, create) {
      const k = cx * 4096 + cy;
      let ch = this.map.get(k);
      if (!ch && create) {
        const px = this.size * this.res;
        const c = U.canvas(px, px);
        ch = { c, g: c.getContext('2d'), cx, cy, used: 0 };
        this.map.set(k, ch);
        if (this.map.size > this.max) {
          let oldK = null, old = Infinity;
          for (const [kk, v] of this.map) if (v.used < old && v !== ch) { old = v.used; oldK = kk; }
          if (oldK !== null) this.map.delete(oldK);
        }
      }
      if (ch) ch.used = ++this.clock;
      return ch;
    }
    seg(x0, y0, x1, y1, w, a, col) {
      const S = this.size;
      const ax = Math.floor((Math.min(x0, x1) - w) / S), bx = Math.floor((Math.max(x0, x1) + w) / S);
      const ay = Math.floor((Math.min(y0, y1) - w) / S), by = Math.floor((Math.max(y0, y1) + w) / S);
      for (let i = ax; i <= bx; i++) {
        for (let j = ay; j <= by; j++) {
          if (i < 0 || j < 0) continue;
          const ch = this.get(i, j, true);
          const g = ch.g;
          g.setTransform(this.res, 0, 0, this.res, -i * S * this.res, -j * S * this.res);
          g.globalAlpha = a; g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        }
      }
    }
    draw(ctx, v) {
      const S = this.size;
      const ax = Math.floor(v.x0 / S), bx = Math.floor(v.x1 / S);
      const ay = Math.floor(v.y0 / S), by = Math.floor(v.y1 / S);
      for (let i = ax; i <= bx; i++) {
        for (let j = ay; j <= by; j++) {
          const ch = this.map.get(i * 4096 + j);
          if (ch) ctx.drawImage(ch.c, i * S, j * S, S, S);
        }
      }
    }
    clear() { this.map.clear(); }
  }

  // ---------------- PARÇACIKLAR ----------------
  class FX {
    constructor() {
      this.smoke = []; this.spark = []; this.flame = []; this.debris = []; this.water = []; this.splash = [];
      this.flash = []; this.jets = [];
      this.skids = new SkidLayer();
      this.maxSmoke = 520; this.maxSpark = 260;
      this.rain = []; this.rainOn = false;
    }
    setQuality(q) {
      this.maxSmoke = [200, 420, 640][q];
      this.maxSpark = [120, 220, 320][q];
      this.q = q;
    }
    clear() {
      this.smoke.length = 0; this.spark.length = 0; this.flame.length = 0; this.debris.length = 0;
      this.water.length = 0; this.splash.length = 0; this.flash.length = 0; this.jets.length = 0;
    }

    puff(x, y, vx, vy, r0, gr, a0, life, col) {
      if (this.smoke.length >= this.maxSmoke) {
        // dolu: sıradaki parçacığı yeniden kullan
        this._ri = ((this._ri || 0) + 1) % this.smoke.length;
        Object.assign(this.smoke[this._ri], { x, y, vx, vy, r: r0, gr, a0, life, t: 0, col, v: (Math.random() * 4) | 0 });
        return;
      }
      this.smoke.push({ x, y, vx, vy, r: r0, gr, a0, life, t: 0, col, v: (Math.random() * 4) | 0 });
    }
    sparks(x, y, vx, vy, n, spread) {
      for (let i = 0; i < n && this.spark.length < this.maxSpark; i++) {
        const a = Math.random() * U.TAU, s = Math.random() * (spread || 6);
        this.spark.push({ x, y, vx: vx * (0.4 + Math.random() * 0.5) + Math.cos(a) * s, vy: vy * (0.4 + Math.random() * 0.5) + Math.sin(a) * s, life: 0.2 + Math.random() * 0.45, t: 0 });
      }
    }
    fire(x, y, ang, scale, vx, vy) {
      this.flame.push({ x, y, ang: ang + (Math.random() - 0.5) * 0.25, len: (0.9 + Math.random() * 0.8) * scale, life: 0.07 + Math.random() * 0.07, t: 0, vx: vx || 0, vy: vy || 0 });
      this.flash.push({ x, y, r: 6 * scale, life: 0.1, t: 0, col: '#ff8a2a' });
      for (let i = 0; i < 3; i++) this.spark.push({ x, y, vx: Math.cos(ang) * (6 + Math.random() * 6) + (vx || 0), vy: Math.sin(ang) * (6 + Math.random() * 6) + (vy || 0), life: 0.15 + Math.random() * 0.15, t: 0 });
    }
    bits(x, y, vx, vy, col, n, size) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * U.TAU, s = 1 + Math.random() * 5;
        this.debris.push({ x, y, vx: vx * 0.6 + Math.cos(a) * s, vy: vy * 0.6 + Math.sin(a) * s, a: Math.random() * 6, w: (Math.random() - 0.5) * 20, s: (size || 0.15) * (0.5 + Math.random()), col, life: 1.5 + Math.random() * 2, t: 0 });
      }
      if (this.debris.length > 220) this.debris.splice(0, this.debris.length - 220);
    }
    jet(x, y, dur) { this.jets.push({ x, y, t: 0, dur }); }

    update(dt) {
      const sm = this.smoke;
      for (let i = sm.length - 1; i >= 0; i--) {
        const p = sm[i];
        p.t += dt;
        if (p.t >= p.life) { sm[i] = sm[sm.length - 1]; sm.pop(); continue; }
        const k = Math.exp(-1.7 * dt);
        p.vx *= k; p.vy *= k;
        p.x += (p.vx + 0.35) * dt; p.y += (p.vy + 0.15) * dt;
        p.r += p.gr * dt * (1 - (p.t / p.life) * 0.7);
      }
      const sp = this.spark;
      for (let i = sp.length - 1; i >= 0; i--) {
        const p = sp[i];
        p.t += dt;
        if (p.t >= p.life) { sp[i] = sp[sp.length - 1]; sp.pop(); continue; }
        const k = Math.exp(-3 * dt);
        p.vx *= k; p.vy *= k; p.x += p.vx * dt; p.y += p.vy * dt;
      }
      for (const arr of [this.flame, this.flash]) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const p = arr[i]; p.t += dt;
          if (p.vx) { p.x += p.vx * dt; p.y += p.vy * dt; }
          if (p.t >= p.life) arr.splice(i, 1);
        }
      }
      const db = this.debris;
      for (let i = db.length - 1; i >= 0; i--) {
        const p = db[i]; p.t += dt;
        if (p.t >= p.life) { db.splice(i, 1); continue; }
        const k = Math.exp(-2.5 * dt);
        p.vx *= k; p.vy *= k; p.w *= k; p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.w * dt;
      }
      // yangın musluğu fıskiyesi
      for (let i = this.jets.length - 1; i >= 0; i--) {
        const j = this.jets[i]; j.t += dt;
        if (j.t > j.dur) { this.jets.splice(i, 1); continue; }
        const n = Math.round(dt * 70 * (1 - j.t / j.dur * 0.5));
        for (let k = 0; k < n; k++) {
          const a = Math.random() * U.TAU, s = 0.8 + Math.random() * 2.6;
          this.water.push({ x: j.x, y: j.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, z: 0.5, vz: 6 + Math.random() * 4 });
        }
      }
      const w = this.water;
      for (let i = w.length - 1; i >= 0; i--) {
        const p = w[i];
        p.vz -= 9.8 * dt; p.z += p.vz * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.z <= 0) {
          if (Math.random() < 0.3) this.splash.push({ x: p.x, y: p.y, t: 0, life: 0.35 });
          w[i] = w[w.length - 1]; w.pop();
        }
      }
      if (w.length > 500) w.splice(0, w.length - 500);
      for (let i = this.splash.length - 1; i >= 0; i--) {
        const s = this.splash[i]; s.t += dt;
        if (s.t > s.life) { this.splash[i] = this.splash[this.splash.length - 1]; this.splash.pop(); }
      }
    }

    // Duman, toz, su (normal karışım, dünya koordinatı)
    drawSmoke(ctx, v) {
      const m = 6;
      for (const p of this.smoke) {
        if (p.x < v.x0 - m || p.x > v.x1 + m || p.y < v.y0 - m || p.y > v.y1 + m) continue;
        const u = p.t / p.life;
        const a = p.a0 * Math.min(1, p.t / 0.1) * Math.pow(1 - u, 1.5);
        if (a < 0.004) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(Sprites.smoke(p.col)[p.v], p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      ctx.globalAlpha = 1;
      if (this.debris.length) {
        for (const p of this.debris) {
          const u = p.t / p.life;
          ctx.globalAlpha = 1 - u * u;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
          ctx.fillStyle = p.col; ctx.fillRect(-p.s, -p.s * 0.6, p.s * 2, p.s * 1.2);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }
      if (this.water.length || this.splash.length) {
        ctx.fillStyle = 'rgba(190,225,255,0.75)';
        ctx.beginPath();
        for (const p of this.water) { const r = 0.06 + p.z * 0.025; ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, U.TAU); }
        ctx.fill();
        ctx.lineWidth = 0.05;
        for (const s of this.splash) {
          const u = s.t / s.life;
          ctx.strokeStyle = `rgba(200,230,255,${0.6 * (1 - u)})`;
          ctx.beginPath(); ctx.arc(s.x, s.y, 0.1 + u * 0.45, 0, U.TAU); ctx.stroke();
        }
        for (const j of this.jets) {
          ctx.globalAlpha = 0.6;
          ctx.drawImage(Sprites.tint('#bfe6ff'), j.x - 1.6, j.y - 1.6, 3.2, 3.2);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Gece: duman ortam ışığını saçar. 'lighten' (en büyük değer) ile ışık haritasını
    // en fazla gri tona kadar yükseltir; üst üste binse de beyaza doymaz, lamba altını karartmaz
    drawSmokeLight(lctx, v) {
      const spr = Sprites.smoke('#8f96ad');
      const prev = lctx.globalCompositeOperation;
      lctx.globalCompositeOperation = 'lighten';
      for (const p of this.smoke) {
        if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) continue;
        const u = p.t / p.life;
        const a = p.a0 * Math.min(1, p.t / 0.1) * Math.pow(1 - u, 1.5) * 1.6;
        if (a < 0.01) continue;
        lctx.globalAlpha = Math.min(1, a);
        lctx.drawImage(spr[p.v], p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      lctx.globalAlpha = 1;
      lctx.globalCompositeOperation = prev;
    }

    // Kıvılcım ve alevler ('lighter')
    drawAdd(ctx) {
      if (this.spark.length) {
        const cols = ['#fff7d6', '#ffc34d', '#ff6a1f'];
        ctx.lineWidth = 0.075; ctx.lineCap = 'round';
        for (let b = 0; b < 3; b++) {
          ctx.beginPath();
          for (const p of this.spark) {
            const u = p.t / p.life;
            if ((u < 0.3 ? 0 : u < 0.6 ? 1 : 2) !== b) continue;
            ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
          }
          ctx.strokeStyle = cols[b]; ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
      for (const f of this.flame) {
        const u = f.t / f.life;
        ctx.globalAlpha = 1 - u * 0.6;
        ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.ang);
        const L = f.len * (0.7 + u * 0.5);
        ctx.drawImage(Sprites.flame, 0, -L * 0.25, L, L * 0.5);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // Gece: anlık ışık parlamaları (ışık haritasına)
    drawFlashes(lctx) {
      for (const f of this.flash) {
        const u = f.t / f.life;
        lctx.globalAlpha = 1 - u;
        lctx.drawImage(Sprites.tint(f.col), f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
      }
      for (const p of this.spark) {
        if (Math.random() < 0.7) continue;
        lctx.globalAlpha = 0.35;
        lctx.drawImage(Sprites.sodium, p.x - 1.2, p.y - 1.2, 2.4, 2.4);
      }
      lctx.globalAlpha = 1;
    }

    // ---- yağmur (ekran koordinatı) ----
    updateRain(dt, W, H, on, q) {
      this.rainOn = on;
      if (!on) { this.rain.length = 0; return; }
      const want = [70, 130, 200][q];
      while (this.rain.length < want) this.rain.push({ x: Math.random() * W, y: Math.random() * H, l: 18 + Math.random() * 26, s: 900 + Math.random() * 600 });
      for (const d of this.rain) {
        d.y += d.s * dt; d.x -= d.s * 0.18 * dt;
        if (d.y > H + 30 || d.x < -30) { d.y = -30 - Math.random() * 60; d.x = Math.random() * (W + 100); }
      }
    }
    drawRain(ctx, dpr) {
      if (!this.rainOn) return;
      ctx.strokeStyle = 'rgba(190,210,235,0.32)';
      ctx.lineWidth = 1.1 * dpr;
      ctx.beginPath();
      for (const d of this.rain) { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * 0.18 * dpr, d.y - d.l * dpr); }
      ctx.stroke();
    }
    rainSplashes(v, dt) {
      if (!this.rainOn) return;
      const n = Math.round(dt * 90);
      for (let i = 0; i < n; i++) this.splash.push({ x: U.lerp(v.x0, v.x1, Math.random()), y: U.lerp(v.y0, v.y1, Math.random()), t: 0, life: 0.3 });
      if (this.splash.length > 400) this.splash.splice(0, this.splash.length - 400);
    }
  }
  DS.FX = FX;
})();
