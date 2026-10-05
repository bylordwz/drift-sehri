'use strict';
// Görsel efektler: hazır sprite'lar, parçacıklar (duman, kıvılcım, alev, toz, su), lastik izi katmanı, yağmur.
// Performans: duman havuzdan gelir, tek doku atlasından çizilir, alan bütçesiyle sınırlanır ve
// gerektiğinde düşük çözünürlüklü ayrı katmana çizilip tek seferde birleştirilir.
(function () {
  const DS = window.DS, U = DS.U;

  // ---------------- SPRITE'LAR ----------------
  const Sprites = (DS.Sprites = {
    _tint: new Map(),
    _atlas: new Map(),
    init() {
      this.white = this.glow([255, 255, 255]);
      this.sodium = this.glow([255, 176, 84]);
      this.red = this.glow([255, 38, 28]);
      this.cone = this.makeCone();
      this.flame = this.makeFlame();
      this.puffs = [];
      for (let i = 0; i < 4; i++) this.puffs.push(this.makePuff(i));
      // ağaç tepeleri tek atlasda (2x2): ardışık çizimler aynı dokuyu kullanır
      this.treeAtlas = U.canvas(256, 256);
      const tg = this.treeAtlas.getContext('2d');
      for (let i = 0; i < 4; i++) tg.drawImage(this.makeTree(i), (i & 1) * 128, (i >> 1) * 128);
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
    // Renge boyanmış 4 duman varyantı tek 256x256 atlasda
    smokeAtlas(hex) {
      let c = this._atlas.get(hex);
      if (c) return c;
      c = U.canvas(256, 256);
      const g = c.getContext('2d');
      this.puffs.forEach((p, i) => g.drawImage(p, (i & 1) * 128, (i >> 1) * 128));
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = hex; g.fillRect(0, 0, 256, 256);
      g.globalCompositeOperation = 'source-atop';
      const r = U.rng(hex.length * 31 + hex.charCodeAt(1));
      for (let k = 0; k < 20; k++) {
        const x = r() * 256, y = r() * 256, rr = 20 + r() * 30;
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, 'rgba(0,0,0,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
      this._atlas.set(hex, c);
      return c;
    },
    // İlk kullanımda takılma olmasın diye renkleri önceden hazırla
    prewarm(list) { for (const h of list) this.smokeAtlas(h); },
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
  // 64 m'lik parçalar; yalnızca boyanan bölge (kirli kutu) çizilir, tuvaller havuzdan gelir
  class SkidLayer {
    constructor() {
      this.res = 8; this.size = 64; this.map = new Map(); this.max = 56; this.clock = 0; this.free = [];
    }
    configure(res, max) {
      if (res !== this.res) { this.clear(); this.free.length = 0; this.res = res; }
      this.max = max;
      while (this.map.size > this.max) this.evict(null);
    }
    evict(keep) {
      let oldK = null, old = Infinity;
      for (const [kk, v] of this.map) if (v.used < old && v !== keep) { old = v.used; oldK = kk; }
      if (oldK === null) return;
      const ch = this.map.get(oldK);
      this.map.delete(oldK);
      ch.g.setTransform(1, 0, 0, 1, 0, 0);
      ch.g.clearRect(0, 0, ch.c.width, ch.c.height);
      if (this.free.length < 8) this.free.push(ch);
    }
    get(cx, cy) {
      const k = cx * 4096 + cy;
      let ch = this.map.get(k);
      if (!ch) {
        ch = this.free.pop();
        if (!ch) {
          const px = this.size * this.res;
          const c = U.canvas(px, px);
          const g = c.getContext('2d');
          g.lineCap = 'round';
          ch = { c, g };
        }
        ch.cx = cx; ch.cy = cy; ch.x0 = Infinity; ch.y0 = Infinity; ch.x1 = -Infinity; ch.y1 = -Infinity;
        this.map.set(k, ch);
        if (this.map.size > this.max) this.evict(ch);
      }
      ch.used = ++this.clock;
      return ch;
    }
    seg(x0, y0, x1, y1, w, a, col) {
      const S = this.size, R = this.res;
      const ax = Math.floor((Math.min(x0, x1) - w) / S), bx = Math.floor((Math.max(x0, x1) + w) / S);
      const ay = Math.floor((Math.min(y0, y1) - w) / S), by = Math.floor((Math.max(y0, y1) + w) / S);
      for (let i = ax; i <= bx; i++) {
        for (let j = ay; j <= by; j++) {
          if (i < 0 || j < 0) continue;
          const ch = this.get(i, j);
          const g = ch.g;
          g.setTransform(R, 0, 0, R, -i * S * R, -j * S * R);
          g.globalAlpha = a; g.strokeStyle = col; g.lineWidth = w;
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
          // kirli kutu (parça pikseli)
          const ox = i * S, oy = j * S;
          ch.x0 = Math.max(0, Math.min(ch.x0, Math.floor((Math.min(x0, x1) - w - ox) * R) - 1));
          ch.y0 = Math.max(0, Math.min(ch.y0, Math.floor((Math.min(y0, y1) - w - oy) * R) - 1));
          ch.x1 = Math.min(S * R, Math.max(ch.x1, Math.ceil((Math.max(x0, x1) + w - ox) * R) + 1));
          ch.y1 = Math.min(S * R, Math.max(ch.y1, Math.ceil((Math.max(y0, y1) + w - oy) * R) + 1));
        }
      }
    }
    draw(ctx, v) {
      const S = this.size, R = this.res;
      const ax = Math.floor(v.x0 / S), bx = Math.floor(v.x1 / S);
      const ay = Math.floor(v.y0 / S), by = Math.floor(v.y1 / S);
      for (let i = ax; i <= bx; i++) {
        for (let j = ay; j <= by; j++) {
          const ch = this.map.get(i * 4096 + j);
          if (!ch || ch.x1 <= ch.x0 || ch.y1 <= ch.y0) continue;
          const w = ch.x1 - ch.x0, h = ch.y1 - ch.y0;
          ctx.drawImage(ch.c, ch.x0, ch.y0, w, h, i * S + ch.x0 / R, j * S + ch.y0 / R, w / R, h / R);
        }
      }
    }
    clear() {
      for (const ch of this.map.values()) {
        ch.g.setTransform(1, 0, 0, 1, 0, 0);
        ch.g.clearRect(0, 0, ch.c.width, ch.c.height);
        if (this.free.length < 8 && ch.c.width === this.size * this.res) this.free.push(ch);
      }
      this.map.clear();
    }
  }

  // ---------------- PARÇACIKLAR ----------------
  const SPARK_COLS = ['#fff7d6', '#ffc34d', '#ff6a1f'];
  const SPLASH_COLS = ['rgba(200,230,255,0.5)', 'rgba(200,230,255,0.36)', 'rgba(200,230,255,0.22)', 'rgba(200,230,255,0.1)'];

  class FX {
    constructor() {
      this.pool = []; this.ns = 0; this._ri = 0;
      this.spark = []; this.flame = []; this.debris = []; this.water = []; this.flash = []; this.jets = [];
      this.skids = new SkidLayer();
      this.rain = []; this.rainOn = false;
      this.splash = new Float32Array(400 * 3); this.nSplash = 0; this.splashHead = 0; this.splashAcc = 0;
      this.layer = null; this.lg = null; this.sl = null; this.slg = null;
      this.cut = 0.02; this.visSmoke = 0;
      this.setQuality(DS.Quality.TIERS[2]);
    }
    setQuality(Q) {
      this.Q = Q;
      const S = Q.smoke;
      this.S = S;
      while (this.pool.length < S.max) this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, r: 0, gr: 0, a0: 0, life: 1, t: 0, img: null, sx: 0, sy: 0, _a: 0 });
      if (this.ns > S.max) this.ns = S.max;
      this.maxSpark = Q.sparks; this.maxDebris = Q.debris;
      if (this.spark.length > this.maxSpark) this.spark.length = this.maxSpark;
      if (this.debris.length > this.maxDebris) this.debris.splice(0, this.debris.length - this.maxDebris);
      this.skids.configure(Q.skidRes, Q.skidMax);
      this.rainWant = Q.rainLines;
      if (this.rain.length > this.rainWant) this.rain.length = this.rainWant;
      this.splashCap = Q.splashCap; this.splashRate = Q.splashRate;
      if (this.nSplash > this.splashCap) this.nSplash = this.splashCap;
    }
    // Ana tuval boyutu değişince düşük çözünürlüklü katmanları yeniden boyutlandır
    resizeLayers(W, H, lcW, lcH) {
      const s = this.S.layer || 0.5;
      const lw = Math.max(1, Math.ceil(W * s)), lh = Math.max(1, Math.ceil(H * s));
      if (!this.layer) { this.layer = U.canvas(lw, lh); this.lg = this.layer.getContext('2d'); }
      else if (this.layer.width !== lw || this.layer.height !== lh) { this.layer.width = lw; this.layer.height = lh; }
      this.layerS = lw / W;
      const sw = Math.max(1, Math.ceil(lcW * 0.5)), sh = Math.max(1, Math.ceil(lcH * 0.5));
      if (!this.sl) { this.sl = U.canvas(sw, sh); this.slg = this.sl.getContext('2d'); }
      else if (this.sl.width !== sw || this.sl.height !== sh) { this.sl.width = sw; this.sl.height = sh; }
    }
    clear() {
      this.ns = 0; this.spark.length = 0; this.flame.length = 0; this.debris.length = 0;
      this.water.length = 0; this.nSplash = 0; this.flash.length = 0; this.jets.length = 0;
    }

    puff(x, y, vx, vy, r0, gr, a0, life, col) {
      const S = this.S;
      let p;
      if (this.ns < S.max) p = this.pool[this.ns++];
      else {
        // dolu: sıradaki parçacığı yeniden kullan
        this._ri = (this._ri + 1) % this.ns;
        p = this.pool[this._ri];
      }
      const v = (Math.random() * 4) | 0;
      p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.r = Math.min(r0, S.rMax); p.gr = gr;
      p.a0 = a0 * S.aMul; p.life = life; p.t = 0;
      p.img = Sprites.smokeAtlas(col); p.sx = (v & 1) * 128; p.sy = (v >> 1) * 128;
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
      for (let i = 0; i < 3 && this.spark.length < this.maxSpark; i++) this.spark.push({ x, y, vx: Math.cos(ang) * (6 + Math.random() * 6) + (vx || 0), vy: Math.sin(ang) * (6 + Math.random() * 6) + (vy || 0), life: 0.15 + Math.random() * 0.15, t: 0 });
    }
    bits(x, y, vx, vy, col, n, size) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * U.TAU, s = 1 + Math.random() * 5;
        this.debris.push({ x, y, vx: vx * 0.6 + Math.cos(a) * s, vy: vy * 0.6 + Math.sin(a) * s, a: Math.random() * 6, w: (Math.random() - 0.5) * 20, s: (size || 0.15) * (0.5 + Math.random()), col, life: 1.5 + Math.random() * 2, t: 0 });
      }
      if (this.debris.length > this.maxDebris) this.debris.splice(0, this.debris.length - this.maxDebris);
    }
    jet(x, y, dur) { this.jets.push({ x, y, t: 0, dur }); }

    update(dt) {
      const pool = this.pool, rMax = this.S.rMax;
      const k = Math.exp(-1.7 * dt), dx = 0.35 * dt, dy = 0.15 * dt;
      for (let i = this.ns - 1; i >= 0; i--) {
        const p = pool[i];
        p.t += dt;
        if (p.t >= p.life) {
          // ölüyü son canlıyla yer değiştir (nesne havuzda kalır)
          const last = this.ns - 1;
          pool[i] = pool[last]; pool[last] = p; this.ns = last;
          continue;
        }
        p.vx *= k; p.vy *= k;
        p.x += p.vx * dt + dx; p.y += p.vy * dt + dy;
        const r = p.r + p.gr * dt * (1 - (p.t / p.life) * 0.7);
        p.r = r < rMax ? r : rMax;
      }
      const sp = this.spark, ks = Math.exp(-3 * dt);
      for (let i = sp.length - 1; i >= 0; i--) {
        const p = sp[i];
        p.t += dt;
        if (p.t >= p.life) { sp[i] = sp[sp.length - 1]; sp.pop(); continue; }
        p.vx *= ks; p.vy *= ks; p.x += p.vx * dt; p.y += p.vy * dt;
      }
      for (const arr of [this.flame, this.flash]) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const p = arr[i]; p.t += dt;
          if (p.vx) { p.x += p.vx * dt; p.y += p.vy * dt; }
          if (p.t >= p.life) arr.splice(i, 1);
        }
      }
      const db = this.debris, kd = Math.exp(-2.5 * dt);
      for (let i = db.length - 1; i >= 0; i--) {
        const p = db[i]; p.t += dt;
        if (p.t >= p.life) { db.splice(i, 1); continue; }
        p.vx *= kd; p.vy *= kd; p.w *= kd; p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.w * dt;
      }
      // yangın musluğu fıskiyesi
      for (let i = this.jets.length - 1; i >= 0; i--) {
        const j = this.jets[i]; j.t += dt;
        if (j.t > j.dur) { this.jets.splice(i, 1); continue; }
        const n = Math.round(dt * 70 * (1 - (j.t / j.dur) * 0.5) * (this.Q.splashCap ? 1 : 0.5));
        for (let q = 0; q < n; q++) {
          const a = Math.random() * U.TAU, s = 0.8 + Math.random() * 2.6;
          this.water.push({ x: j.x, y: j.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, z: 0.5, vz: 6 + Math.random() * 4 });
        }
      }
      const w = this.water;
      for (let i = w.length - 1; i >= 0; i--) {
        const p = w[i];
        p.vz -= 9.8 * dt; p.z += p.vz * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.z <= 0) {
          if (Math.random() < 0.3) this.addSplash(p.x, p.y);
          w[i] = w[w.length - 1]; w.pop();
        }
      }
      if (w.length > 400) w.splice(0, w.length - 400);
      // su sıçramaları (halka tampon)
      const sb = this.splash;
      for (let i = 0; i < this.nSplash; i++) sb[i * 3 + 2] += dt;
      let i = 0;
      while (i < this.nSplash) {
        if (sb[i * 3 + 2] > 0.32) {
          const l = this.nSplash - 1;
          sb[i * 3] = sb[l * 3]; sb[i * 3 + 1] = sb[l * 3 + 1]; sb[i * 3 + 2] = sb[l * 3 + 2];
          this.nSplash = l;
        } else i++;
      }
    }
    addSplash(x, y) {
      if (!this.splashCap) return;
      let k;
      if (this.nSplash < this.splashCap) k = this.nSplash++;
      else { this.splashHead = (this.splashHead + 1) % this.splashCap; k = this.splashHead; }
      this.splash[k * 3] = x; this.splash[k * 3 + 1] = y; this.splash[k * 3 + 2] = 0;
    }

    // Duman: önce görünürlük/alan hesabı, sonra doğrudan ya da düşük çözünürlüklü katmana çizim
    drawSmoke(ctx, v, M, W, H) {
      const S = this.S, pool = this.pool;
      const z = Math.hypot(M[0], M[1]);
      let area = 0, n = 0;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let i = 0; i < this.ns; i++) {
        const p = pool[i];
        p._a = 0;
        if (p.x + p.r < v.x0 || p.x - p.r > v.x1 || p.y + p.r < v.y0 || p.y - p.r > v.y1) continue;
        const u = 1 - p.t / p.life;
        const a = p.a0 * (p.t < 0.1 ? p.t * 10 : 1) * u * Math.sqrt(u);
        if (a < S.aCut) continue;
        p._a = a;
        const sx = M[0] * p.x + M[2] * p.y + M[4], sy = M[1] * p.x + M[3] * p.y + M[5], rr = p.r * z;
        if (sx + rr < 0 || sx - rr > W || sy + rr < 0 || sy - rr > H) { p._a = 0; continue; }
        area += 4 * rr * rr; n++;
        if (sx - rr < bx0) bx0 = sx - rr;
        if (sy - rr < by0) by0 = sy - rr;
        if (sx + rr > bx1) bx1 = sx + rr;
        if (sy + rr > by1) by1 = sy + rr;
      }
      this.visSmoke = n;
      // alan bütçesi aşılırsa en soluk (çoğunlukla en büyük) bulutlar önce düşer
      const budget = S.budget * W * H;
      this.cut = area > budget ? S.aCut * (area / budget) : S.aCut;
      if (n) {
        const useLayer = this.layer && S.layer > 0 && area > S.layerAt * W * H;
        if (useLayer) {
          const s = this.layerS, lg = this.lg;
          const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
          const x1 = Math.min(W, Math.ceil(bx1)), y1 = Math.min(H, Math.ceil(by1));
          if (x1 > x0 && y1 > y0) {
            const lx0 = Math.floor(x0 * s), ly0 = Math.floor(y0 * s);
            const lx1 = Math.min(this.layer.width, Math.ceil(x1 * s) + 1), ly1 = Math.min(this.layer.height, Math.ceil(y1 * s) + 1);
            lg.setTransform(1, 0, 0, 1, 0, 0);
            lg.globalAlpha = 1;
            lg.clearRect(lx0, ly0, lx1 - lx0, ly1 - ly0);
            lg.setTransform(M[0] * s, M[1] * s, M[2] * s, M[3] * s, M[4] * s, M[5] * s);
            this._drawPuffs(lg);
            lg.globalAlpha = 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(this.layer, lx0, ly0, lx1 - lx0, ly1 - ly0, lx0 / s, ly0 / s, (lx1 - lx0) / s, (ly1 - ly0) / s);
            ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
          }
        } else {
          this._drawPuffs(ctx);
          ctx.globalAlpha = 1;
        }
      }
      this._drawBits(ctx, v, M);
    }
    _drawPuffs(g) {
      const pool = this.pool, cut = this.cut;
      for (let i = 0; i < this.ns; i++) {
        const p = pool[i];
        if (p._a < cut) continue;
        g.globalAlpha = p._a;
        g.drawImage(p.img, p.sx, p.sy, 128, 128, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
    }
    _drawBits(ctx, v, M) {
      if (this.debris.length) {
        const a = M[0], b = M[1], c = M[2], d = M[3], e = M[4], f = M[5];
        for (const p of this.debris) {
          if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) continue;
          const u = p.t / p.life;
          ctx.globalAlpha = 1 - u * u;
          const co = Math.cos(p.a), si = Math.sin(p.a);
          ctx.setTransform(a * co + c * si, b * co + d * si, c * co - a * si, d * co - b * si, a * p.x + c * p.y + e, b * p.x + d * p.y + f);
          ctx.fillStyle = p.col; ctx.fillRect(-p.s, -p.s * 0.6, p.s * 2, p.s * 1.2);
        }
        ctx.setTransform(a, b, c, d, e, f);
        ctx.globalAlpha = 1;
      }
      if (this.water.length) {
        ctx.fillStyle = 'rgba(190,225,255,0.75)';
        ctx.beginPath();
        for (const p of this.water) { const r = 0.06 + p.z * 0.025; ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, U.TAU); }
        ctx.fill();
      }
      if (this.nSplash) {
        const sb = this.splash;
        ctx.lineWidth = 0.05;
        for (let bkt = 0; bkt < 4; bkt++) {
          ctx.beginPath();
          let any = false;
          for (let i = 0; i < this.nSplash; i++) {
            const u = sb[i * 3 + 2] / 0.32;
            if (((u * 4) | 0) !== bkt) continue;
            const x = sb[i * 3], y = sb[i * 3 + 1];
            if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
            const r = 0.1 + u * 0.45;
            ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, U.TAU); any = true;
          }
          if (any) { ctx.strokeStyle = SPLASH_COLS[bkt]; ctx.stroke(); }
        }
      }
      for (const j of this.jets) {
        ctx.globalAlpha = 0.6;
        ctx.drawImage(Sprites.tint('#bfe6ff'), j.x - 1.6, j.y - 1.6, 3.2, 3.2);
        ctx.globalAlpha = 1;
      }
    }

    // Gece: duman ortam ışığını saçar. Bulutlar küçük bir katmanda biriktirilir, ışık haritasına
    // tek bir 'lighten' (en büyük değer) işlemiyle eklenir: beyaza doymaz, lamba altını karartmaz
    drawSmokeLight(lctx, v, M, ls) {
      if (!this.S.light || !this.visSmoke || !this.sl) return;
      const g = this.slg, s = this.sl.width / lctx.canvas.width * ls;
      const img = Sprites.smokeAtlas('#8f96ad');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.sl.width, this.sl.height);
      g.setTransform(M[0] * s, M[1] * s, M[2] * s, M[3] * s, M[4] * s, M[5] * s);
      const pool = this.pool, cut = this.cut;
      for (let i = 0; i < this.ns; i++) {
        const p = pool[i];
        if (p._a < cut) continue;
        g.globalAlpha = Math.min(1, p._a * 1.6);
        g.drawImage(img, p.sx, p.sy, 128, 128, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      g.globalAlpha = 1;
      const prevOp = lctx.globalCompositeOperation;
      lctx.save();
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = 'lighten';
      lctx.drawImage(this.sl, 0, 0, lctx.canvas.width, lctx.canvas.height);
      lctx.restore();
      lctx.globalCompositeOperation = prevOp;
    }

    // Kıvılcım ve alevler ('lighter')
    drawAdd(ctx) {
      if (this.spark.length) {
        ctx.lineWidth = 0.075; ctx.lineCap = 'round';
        for (let b = 0; b < 3; b++) {
          ctx.beginPath();
          for (const p of this.spark) {
            const u = p.t / p.life;
            if ((u < 0.3 ? 0 : u < 0.6 ? 1 : 2) !== b) continue;
            ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
          }
          ctx.strokeStyle = SPARK_COLS[b]; ctx.stroke();
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
      if (this.Q.smoke.light) {
        for (const p of this.spark) {
          if (Math.random() < 0.7) continue;
          lctx.globalAlpha = 0.35;
          lctx.drawImage(Sprites.sodium, p.x - 1.2, p.y - 1.2, 2.4, 2.4);
        }
      }
      lctx.globalAlpha = 1;
    }

    // ---- yağmur (ekran koordinatı) ----
    updateRain(dt, W, H, on) {
      this.rainOn = on;
      if (!on) { this.rain.length = 0; return; }
      while (this.rain.length < this.rainWant) this.rain.push({ x: Math.random() * W, y: Math.random() * H, l: 18 + Math.random() * 26, s: 900 + Math.random() * 600 });
      for (const d of this.rain) {
        d.y += d.s * dt; d.x -= d.s * 0.18 * dt;
        if (d.y > H + 30 || d.x < -30) { d.y = -30 - Math.random() * 60; d.x = Math.random() * (W + 100); }
      }
    }
    drawRain(ctx, dpr) {
      if (!this.rainOn || !this.rain.length) return;
      ctx.strokeStyle = 'rgba(190,210,235,0.32)';
      ctx.lineWidth = Math.max(1, 1.1 * dpr);
      ctx.beginPath();
      for (const d of this.rain) { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * 0.18 * dpr, d.y - d.l * dpr); }
      ctx.stroke();
    }
    rainSplashes(v, dt) {
      if (!this.rainOn || !this.splashRate) return;
      this.splashAcc += dt * this.splashRate;
      while (this.splashAcc >= 1) {
        this.splashAcc -= 1;
        this.addSplash(U.lerp(v.x0, v.x1, Math.random()), U.lerp(v.y0, v.y1, Math.random()));
      }
    }
  }
  DS.FX = FX;
})();
