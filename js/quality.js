'use strict';
// Grafik kalitesi: 4 kademe + çözünürlük ölçeği, otomatik ayarlayıcı ve açılış tahmini.
// Ölçümler (yazılım çizimi, yavaş CPU) maliyetin piksel boyamada olduğunu gösterdi: çözünürlük,
// duman örtüşmesi, zemin desenleri ve tam ekran ışık birleştirmeleri en büyük kalemler.
(function () {
  const DS = window.DS, U = DS.U;

  // T0 Çok düşük · T1 Düşük · T2 Orta · T3 Yüksek
  const TIERS = [
    {
      name: 'Çok düşük', dprCap: 1, scales: [0.5, 0.6, 0.7], maxPx: 0.6e6,
      lightScale: 0.25, bloom: false, flatGround: true, decals: 0, windows: 0, roofDetail: false, shadows: 0,
      smoke: { max: 70, rMax: 3, aCut: 0.03, emit: 0.3, aMul: 1.35, budget: 1, layer: 0.5, layerAt: 0, light: false },
      sparks: 60, debris: 60, skidRes: 4, skidMax: 16, flood: 40, rainLines: 40, splashRate: 0, splashCap: 0,
      dtMax: 1 / 15, physCap: 8, gaugeHz: 20, miniHz: 10, textHz: 15, hudDpr: 1, audioHz: 20, oversample: 'none',
    },
    {
      name: 'Düşük', dprCap: 1, scales: [0.6, 0.72, 0.85], maxPx: 1.0e6,
      lightScale: 0.33, bloom: false, flatGround: false, decals: 1, windows: 1, roofDetail: false, shadows: 1,
      smoke: { max: 140, rMax: 4.5, aCut: 0.025, emit: 0.5, aMul: 1.2, budget: 2, layer: 0.5, layerAt: 0, light: true },
      sparks: 120, debris: 100, skidRes: 6, skidMax: 24, flood: 40, rainLines: 70, splashRate: 30, splashCap: 120,
      dtMax: 1 / 20, physCap: 6, gaugeHz: 30, miniHz: 15, textHz: 20, hudDpr: 1, audioHz: 30, oversample: '2x',
    },
    {
      name: 'Orta', dprCap: 1.5, scales: [0.75, 0.87, 1.0], maxPx: 2.1e6,
      lightScale: 0.5, bloom: true, flatGround: false, decals: 2, windows: 2, roofDetail: true, shadows: 2,
      smoke: { max: 260, rMax: 6, aCut: 0.02, emit: 0.7, aMul: 1.1, budget: 3.5, layer: 0.5, layerAt: 1.5, light: true },
      sparks: 220, debris: 160, skidRes: 8, skidMax: 40, flood: 52, rainLines: 130, splashRate: 60, splashCap: 250,
      dtMax: 1 / 20, physCap: 6, gaugeHz: 30, miniHz: 30, textHz: 30, hudDpr: 1.5, audioHz: 30, oversample: '2x',
    },
    {
      name: 'Yüksek', dprCap: 2, scales: [0.9, 1.0], maxPx: 4.2e6,
      lightScale: 0.5, bloom: true, flatGround: false, decals: 2, windows: 3, roofDetail: true, shadows: 3,
      smoke: { max: 420, rMax: 8, aCut: 0.012, emit: 1, aMul: 1, budget: 8, layer: 0.5, layerAt: 5, light: true },
      sparks: 320, debris: 220, skidRes: 8, skidMax: 56, flood: 52, rainLines: 200, splashRate: 90, splashCap: 400,
      dtMax: 1 / 20, physCap: 6, gaugeHz: 60, miniHz: 30, textHz: 60, hudDpr: 2, audioHz: 60, oversample: '2x',
    },
  ];

  // Otomatik mod merdiveni: önce kademe içinde çözünürlük, sonra özellikler düşer
  const LADDER = [];
  TIERS.forEach((t, ti) => t.scales.forEach((s) => LADDER.push([ti, s])));

  // Tarayıcı çizimi yazılımla (GPU'suz) mı yapıyor?
  function softwareRendering() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: true });
      if (!gl) {
        const c2 = document.createElement('canvas');
        const gl2 = c2.getContext('webgl');
        if (gl2) { const lose = gl2.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
        return true;
      }
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return /swiftshader|llvmpipe|basic render|software/i.test(r);
    } catch (e) {
      return false;
    }
  }

  // Kaydedilmiş seviye yoksa donanıma göre başlangıç seviyesi
  function guessLevel(saved) {
    const hc = navigator.hardwareConcurrency || 4;
    const dm = navigator.deviceMemory || 8;
    let g = 6; // Orta, ölçek 0.75
    if (hc <= 4 || dm <= 4 || U.isTouch) g = 3;
    if (hc <= 2 || dm <= 2) g = 1;
    const dpr = window.devicePixelRatio || 1;
    if (window.innerWidth * window.innerHeight * dpr * dpr > 3.5e6) g -= 1;
    const soft = softwareRendering();
    if (soft) g = 0;
    g = U.clamp(g, 0, LADDER.length - 1);
    if (typeof saved === 'number' && saved >= 0) g = Math.min(saved, soft ? 5 : g + 2);
    return { level: U.clamp(g, 0, LADDER.length - 1), soft };
  }

  // Kare süresini izler; histerezisle seviye düşürür / yükseltir
  class AutoQuality {
    constructor(onChange) {
      this.onChange = onChange;
      this.d = new Float32Array(120);
      this.w = new Float32Array(120);
      this.tmp = new Float32Array(120);
      this.upWait = new Float32Array(LADDER.length).fill(4);
      this.min = 0; this.max = LADDER.length - 1;
      this.level = 0;
      this.reset(1);
      this.lastUpT = -99; this.lastUpLevel = -1; this.t = 0; this.stableT = 0;
      this.slowFloor = 0; this.lock30 = false;
      this.lockT = 0; this.lockWait = 20; this.unlockAt = -99; this.failedProbes = 0; this.upSinceUnlock = true;
      this.allowLock = true; this.capMs = 0;
    }
    setRange(min, max) { this.min = min; this.max = max; this.level = U.clamp(this.level, min, max); }
    reset(cool) {
      this.n = 0; this.i = 0; this.cool = cool === undefined ? 0.8 : cool;
      this.evalT = 0; this.goodT = 0; this.bad = 0;
    }
    pct(arr, m, q) {
      const t = this.tmp;
      for (let k = 0; k < m; k++) t[k] = arr[(this.i - 1 - k + 240) % 120];
      const s = t.subarray(0, m).sort();
      return s[Math.min(m - 1, Math.floor(q * (m - 1) + 0.5))];
    }
    // delta: rAF aralığı (ms), work: karede harcanan iş (ms), dt: saniye
    sample(delta, work, dt) {
      this.t += dt;
      this.stableT += dt;
      if (this.stableT > 60) { for (let k = 0; k < this.upWait.length; k++) this.upWait[k] = Math.max(4, this.upWait[k] * 0.5); this.stableT = 0; }
      // kilit çözüldükten sonra 30 s sorunsuz geçtiyse başarısız deneme sayacını sıfırla
      if (!this.lock30 && this.failedProbes && this.t - this.unlockAt > 30) this.failedProbes = 0;
      // 30 kilidi kalıcı değil: belli aralıklarla aynı seviyede kaldırıp yeniden dene
      if (this.lock30) {
        this.lockT += dt;
        if (this.lockT >= this.lockWait) {
          this.lock30 = false; this.lockT = 0; this.unlockAt = this.t; this.upSinceUnlock = false;
          this.reset(0.6);
          this.onChange(this.level, 'unlock30');
          return;
        }
      }
      if (this.cool > 0) { this.cool -= dt; return; }
      if (!(delta > 0) || delta > 250) return;
      this.d[this.i] = delta; this.w[this.i] = work;
      this.i = (this.i + 1) % 120; this.n = Math.min(120, this.n + 1);
      this.evalT += dt;
      if (this.evalT < 0.5 || this.n < 30) return;
      const span = this.evalT;
      this.evalT = 0;
      const m = Math.min(this.n, 60);
      const p50 = this.pct(this.d, m, 0.5), p90 = this.pct(this.d, m, 0.9);
      const wp90 = this.pct(this.w, m, 0.9);
      // Hedef kare süresi o anki (aşırı yüklü olabilecek) kare aralığından tahmin edilmez:
      // kilitsizken 60 FPS (daha yükseği kovalanmaz), kilitliyken 30 FPS, kullanıcı sınırı varsa o
      const T = this.lock30 ? 33.33 : Math.max(16.67, this.capMs || 0);
      let miss = 0, sum = 0;
      for (let k = 0; k < m; k++) { const x = this.d[(this.i - 1 - k + 240) % 120]; sum += x; if (x > 1.5 * T) miss++; }
      miss /= m;
      // sınırlı modda yüksek tazelemeli ekran kare aralığını titretir (ör. 144 Hz'de 60: 13.9/20.8 ms):
      // orada ortalama tutuyorsa iyi say
      const steady = p90 <= 1.1 * T || ((this.capMs || this.lock30) && sum / m <= 1.03 * T && p90 <= 1.3 * T);
      const L = this.level;
      // kötü
      if (p50 > 2.0 * T && L > this.min) return this.change(L - 2, 'down');
      if (p90 > 1.25 * T && miss > 0.15) {
        this.bad++;
        if (this.bad >= 2 && L > this.min) {
          // ana iş parçacığı darboğazsa çözünürlük yetmez: bir alt kademenin en üst seviyesine in
          if (wp90 > 0.75 * T) {
            const tier = LADDER[L][0];
            let nl = L - 1;
            for (let k = L - 1; k >= this.min; k--) { if (LADDER[k][0] < tier) { nl = k; break; } }
            return this.change(nl, 'down');
          }
          return this.change(L - 1, 'down');
        }
        // en alt seviyede hâlâ 30-55 FPS arasında sallanıyorsa sabit 30 daha akıcıdır
        // (30'un altındaysa kilit işe yaramaz: hiç kilitleme, bildirim de gösterme)
        if (this.allowLock && !this.lock30 && L === this.min && this.bad >= 4 && p50 > 1.1 * T && p50 < 2.1 * T) {
          if (this.unlockAt > -99 && !this.upSinceUnlock) this.failedProbes = (this.failedProbes || 0) + 1;
          this.lockWait = Math.min(160, 20 * Math.pow(2, this.failedProbes || 0));
          this.lock30 = true; this.lockT = 0;
          this.reset(0.6);
          this.onChange(L, 'lock30');
        }
        this.goodT = 0;
        return;
      }
      this.bad = 0;
      // iyi — kilitliyken yükseltme yok (kilit kalkınca 60 FPS hedefi zaten bu seviyede başarısızdı)
      if (!this.lock30 && steady && miss < 0.03 && wp90 < 0.5 * T) {
        this.goodT += span;
        const next = L + 1;
        if (next <= this.max && this.goodT >= this.upWait[next]) { this.upSinceUnlock = true; return this.change(next, 'up'); }
      } else this.goodT = 0;
    }
    change(nl, dir) {
      nl = U.clamp(nl, this.min, this.max);
      if (nl === this.level) return;
      if (dir === 'down' && this.t - this.lastUpT < 8 && this.lastUpLevel >= 0) {
        this.upWait[this.lastUpLevel] = Math.min(60, this.upWait[this.lastUpLevel] * 2);
      }
      if (dir === 'up') { this.lastUpT = this.t; this.lastUpLevel = nl; }
      this.level = nl;
      this.stableT = 0;
      this.reset(1);
      this.onChange(nl, dir);
    }
  }

  DS.Quality = { TIERS, LADDER, guessLevel, softwareRendering, AutoQuality };
})();
