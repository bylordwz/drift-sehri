'use strict';
// WebAudio ile sentezlenen sesler: motor, turbo, lastik, rüzgâr, çarpışma, egzoz patlaması
(function () {
  const DS = window.DS, U = DS.U;

  // fmul: ateşleme frekansı çarpanı (rpm/30 tabanlı), r2/r3: ek osilatör oranları
  const VOICES = {
    i4: { fmul: 1, r2: 0.5, g2: 0.35, r3: 2, g3: 0.12, amr: 0.5, amd: 0.25, fb: 520, dist: 26 },
    i4t: { fmul: 1, r2: 0.5, g2: 0.3, r3: 2, g3: 0.14, amr: 0.5, amd: 0.2, fb: 600, dist: 22 },
    i6: { fmul: 1.5, r2: 0.5, g2: 0.2, r3: 3, g3: 0.1, amr: 0.333, amd: 0.12, fb: 780, dist: 18 },
    rotary: { fmul: 1, r2: 1, g2: 0.5, r3: 2, g3: 0.22, amr: 1, amd: 0.32, fb: 950, dist: 48 },
    v8: { fmul: 2, r2: 0.25, g2: 0.5, r3: 1, g3: 0.18, amr: 0.125, amd: 0.42, fb: 380, dist: 40 },
  };

  function distCurve(k) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  class GameAudio {
    constructor() {
      this.ctx = null; this.on = true; this.vol = 0.8; this.ready = false; this._last = {}; this.hz = 60; this.os = '2x';
    }

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      const c = this.ctx;
      this.master = c.createGain();
      this.master.gain.value = this.on ? this.vol : 0;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp); comp.connect(c.destination);
      const len = c.sampleRate * 2;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.loop = (filterType, f, q, gain) => {
        const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
        src.playbackRate.value = 0.8 + Math.random() * 0.4;
        const fl = c.createBiquadFilter(); fl.type = filterType; fl.frequency.value = f; fl.Q.value = q;
        const g = c.createGain(); g.gain.value = gain || 0;
        src.connect(fl); fl.connect(g); g.connect(this.master); src.start();
        return { src, fl, g };
      };
      this.tireA = this.loop('bandpass', 1000, 9, 0);
      this.tireB = this.loop('bandpass', 2300, 12, 0);
      this.wind = this.loop('lowpass', 420, 0.7, 0);
      this.grass = this.loop('lowpass', 260, 0.8, 0);
      this.scrape = this.loop('bandpass', 3300, 3, 0);
      this.rain = this.loop('highpass', 1800, 0.5, 0);
      // lastik ıslığı tonu
      this.sq = c.createOscillator(); this.sq.type = 'triangle'; this.sq.frequency.value = 1050;
      this.sqG = c.createGain(); this.sqG.gain.value = 0;
      this.sq.connect(this.sqG); this.sqG.connect(this.master); this.sq.start();
      // turbo ıslığı
      this.tb = c.createOscillator(); this.tb.type = 'sine'; this.tb.frequency.value = 2000;
      this.tbG = c.createGain(); this.tbG.gain.value = 0;
      this.tb.connect(this.tbG); this.tbG.connect(this.master); this.tb.start();
      this.ready = true;
    }

    // Kademe: parametre güncelleme sıklığı ve dalga şekillendirici örneklemesi
    setQuality(Q) {
      this.hz = Q.audioHz;
      this.os = Q.oversample;
      if (this.eng && this.eng.shaper) this.eng.shaper.oversample = this.os;
      if (this.leng && this.leng.shaper) this.leng.shaper.oversample = this.os;
    }
    // Parametreyi yalnızca anlamlı değiştiyse gönder (her karede otomasyon olayı biriktirmesin)
    st(param, v, tc, key) {
      const last = this._last[key];
      if (last !== undefined && Math.abs(v - last) <= Math.max(0.002, Math.abs(v) * 0.01)) return;
      this._last[key] = v;
      param.setTargetAtTime(v, this.ctx.currentTime, tc);
    }
    makeEngine(voice) {
      const c = this.ctx, vc = VOICES[voice] || VOICES.i4;
      const out = c.createGain(); out.gain.value = 0;
      const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = 3.5; filt.frequency.value = 800;
      const shaper = c.createWaveShaper(); shaper.curve = distCurve(vc.dist); shaper.oversample = this.os || '2x';
      const am = c.createGain(); am.gain.value = 0.75;
      const mk = (type, gain) => {
        const o = c.createOscillator(); o.type = type;
        const g = c.createGain(); g.gain.value = gain;
        o.connect(g); g.connect(shaper); o.start();
        return o;
      };
      const o1 = mk('sawtooth', 0.55), o2 = mk('square', vc.g2), o3 = mk('sawtooth', vc.g3);
      shaper.connect(filt); filt.connect(am); am.connect(out); out.connect(this.master);
      const lfo = c.createOscillator(); lfo.type = 'triangle';
      const lfoG = c.createGain(); lfoG.gain.value = vc.amd;
      lfo.connect(lfoG); lfoG.connect(am.gain); lfo.start();
      return { o1, o2, o3, lfo, filt, out, vc, shaper, nodes: [o1, o2, o3, lfo], id: Math.random() };
    }
    dropEngine(e) {
      if (!e) return;
      try { e.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); } catch (err) { /* yok */ }
      setTimeout(() => { e.nodes.forEach((n) => { try { n.stop(); } catch (err) { /* yok */ } }); try { e.out.disconnect(); } catch (err) { /* yok */ } }, 300);
    }
    setVoice(voice) {
      if (!this.ready) return;
      if (this.eng && this.eng.voice === voice) return;
      this.dropEngine(this.eng);
      this.eng = this.makeEngine(voice);
      this.eng.voice = voice;
    }
    setLeaderVoice(voice) {
      if (!this.ready) return;
      if (this.leng && this.leng.voice === voice) return;
      this.dropEngine(this.leng);
      this.leng = voice ? this.makeEngine(voice) : null;
      if (this.leng) this.leng.voice = voice;
    }

    setOn(on) {
      this.on = on;
      if (this.master) this.master.gain.setTargetAtTime(on ? this.vol : 0, this.ctx.currentTime, 0.05);
    }
    setVol(v) {
      this.vol = v;
      if (this.master && this.on) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
    silence() {
      if (!this.ready) return;
      this._last = {};
      const t = this.ctx.currentTime;
      for (const g of [this.tireA.g, this.tireB.g, this.wind.g, this.grass.g, this.scrape.g, this.sqG, this.tbG]) g.gain.setTargetAtTime(0, t, 0.05);
      if (this.eng) this.eng.out.gain.setTargetAtTime(0, t, 0.08);
      if (this.leng) this.leng.out.gain.setTargetAtTime(0, t, 0.08);
    }

    engineParams(e, rpm, thr, redline, vol) {
      const vc = e.vc, k = e.id;
      const f = Math.max(12, (rpm / 30) * vc.fmul);
      this.st(e.o1.frequency, f, 0.015, k + 'f1');
      this.st(e.o2.frequency, f * vc.r2, 0.015, k + 'f2');
      this.st(e.o3.frequency, f * vc.r3 * 1.004, 0.015, k + 'f3');
      this.st(e.lfo.frequency, f * vc.amr, 0.015, k + 'lf');
      const rn = rpm / redline;
      this.st(e.filt.frequency, vc.fb + thr * 2400 + rn * 1500, 0.03, k + 'fl');
      this.st(e.out.gain, (0.09 + thr * 0.2 + rn * 0.09) * vol, 0.03, k + 'g');
    }

    // Her karede çağrılır; parametreler kademeye göre en fazla audioHz kez gönderilir
    update(s, dt) {
      if (!this.ready || !this.eng) return;
      this._acc = (this._acc || 0) + (dt || 0.016);
      if (this._acc < 1 / (this.hz || 60)) return;
      this._acc = 0;
      if (!this._last) this._last = {};
      const t = this.ctx.currentTime;
      this.engineParams(this.eng, s.rpm, s.load, s.redline, 1);
      const slip = U.sat((s.slip - 1.5) / 9);
      const sp = U.sat(s.speed / 40);
      this.st(this.tireA.g.gain, slip * 0.24, 0.04, 'ta');
      this.st(this.tireB.g.gain, slip * 0.07, 0.04, 'tb');
      this.st(this.tireA.fl.frequency, 880 + sp * 260 + Math.sin(t * 7) * 40, 0.05, 'tf');
      this.st(this.sqG.gain, slip * 0.018, 0.05, 'sq');
      this.st(this.sq.frequency, 980 + sp * 220 + Math.sin(t * 13) * 30, 0.03, 'sf');
      this.st(this.wind.g.gain, sp * sp * 0.12, 0.1, 'wi');
      this.st(this.grass.g.gain, s.grass ? sp * 0.3 : 0, 0.06, 'gr');
      this.st(this.scrape.g.gain, U.sat(s.scrape) * 0.22, 0.03, 'sc');
      this.st(this.tbG.gain, s.turbo ? s.boost * s.load * 0.03 : 0, 0.05, 'tg');
      this.st(this.tb.frequency, 1500 + s.boost * 3300, 0.05, 'tq');
      this.st(this.rain.g.gain, s.rain ? 0.05 : 0, 0.3, 'rn');
      if (this.leng) {
        const v = 1 / (1 + s.ldist / 9);
        this.engineParams(this.leng, s.lrpm, 0.8, 7000, v * 0.8);
      }
    }

    // ---- tek seferlik sesler ----
    burst(dur, type, f, q, gain, decay) {
      const c = this.ctx, t = c.currentTime;
      const src = c.createBufferSource(); src.buffer = this.noise;
      src.playbackRate.value = 0.7 + Math.random() * 0.6;
      const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (decay || dur));
      src.connect(fl); fl.connect(g); g.connect(this.master);
      src.start(t, Math.random() * 1.5, dur + 0.05);
      return fl;
    }
    thump(f, dur, gain) {
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + dur);
      const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
    }
    pop(strength) {
      if (!this.ready) return;
      const s = strength || 1;
      this.burst(0.07, 'lowpass', 1300 + Math.random() * 900, 1, 0.5 * s, 0.09);
      this.thump(65 + Math.random() * 30, 0.12, 0.45 * s);
    }
    bov() {
      if (!this.ready) return;
      const fl = this.burst(0.45, 'bandpass', 1800, 1.4, 0.22, 0.42);
      fl.frequency.exponentialRampToValueAtTime(3400, this.ctx.currentTime + 0.35);
    }
    impact(s) {
      if (!this.ready) return;
      const k = U.sat(s / 14);
      this.burst(0.3, 'lowpass', 500 + k * 900, 0.8, 0.25 + k * 0.6, 0.3);
      this.thump(48, 0.25, 0.3 + k * 0.6);
      if (k > 0.35) this.glass(0.4 * k);
    }
    glass(v) {
      if (!this.ready) return;
      const c = this.ctx;
      for (let i = 0; i < 5; i++) {
        const t = c.currentTime + Math.random() * 0.12;
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 2600 + Math.random() * 3200;
        const g = c.createGain(); g.gain.setValueAtTime(0.0001, c.currentTime);
        g.gain.setValueAtTime(0.08 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.2);
      }
    }
    clang() {
      if (!this.ready) return;
      this.burst(0.25, 'bandpass', 1400, 4, 0.35, 0.25);
      this.thump(180, 0.2, 0.2);
    }
    beep(f, dur, vol) {
      if (!this.ready) return;
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator(); o.type = 'square'; o.frequency.value = f;
      const g = c.createGain(); g.gain.setValueAtTime(vol || 0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
    }
    chime() {
      if (!this.ready) return;
      [880, 1175, 1568].forEach((f, i) => setTimeout(() => this.beep(f, 0.12, 0.06), i * 70));
    }
  }
  DS.GameAudio = GameAudio;
})();
