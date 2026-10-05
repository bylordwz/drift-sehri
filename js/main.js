'use strict';
// Oyun döngüsü, kamera, katmanlı çizim, modlar (menü vitrini, serbest sürüş, tandem)
(function () {
  const DS = window.DS, U = DS.U, C = DS.Collide;
  const SAVE_KEY = 'driftSehri.v1';
  const STEP = 1 / 120;

  const ENV = {
    day: { sun: { x: 0.42, y: 0.3 }, shadowA: 0.24, light: false, lamps: false, lampA: 0, headA: 0, windows: false },
    sunset: { sun: { x: 1.25, y: 0.62 }, shadowA: 0.3, light: true, ambient: 'rgb(255,176,136)', bldAmb: 'rgb(232,156,120)', lamps: true, lampA: 0.5, headA: 0.45, windows: true, bloom: 0.05 },
    night: { sun: null, shadowA: 0, light: true, ambient: 'rgb(60,68,110)', bldAmb: 'rgb(72,80,122)', lamps: true, lampA: 1, headA: 1, windows: true, bloom: 0.17 },
  };

  const Game = (DS.Game = {
    init() {
      this.canvas = document.getElementById('game');
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.lc = U.canvas(4, 4);
      this.lctx = this.lc.getContext('2d', { alpha: false });
      this.save = this.load();
      this.M = [1, 0, 0, 1, 0, 0];
      this.view = { x0: 0, y0: 0, x1: 1, y1: 1 };
      this.cp = { x: 0, y: 0 };
      this.cars = [];
      this.renderScale = 1; this.dpr = 1;
      DS.Sprites.init();
      DS.Sprites.prewarm(['#f4f4f4', '#7a6a45', '#a39373', '#d6dde6', '#cfd8e2', '#8f96ad']);
      this.city = new DS.City(20251005);
      this.city.makeTextures();
      this.city.buildMinimap();
      this.fx = new DS.FX();
      this.audio = new DS.GameAudio();
      this.input = new DS.Input();
      this.input.attach(document.getElementById('controls'));
      this.score = new DS.DriftScore();
      this.score.onBank = (pts) => {
        this.save.money += Math.round(pts / 10);
        this.save.best = Math.max(this.save.best, pts);
        this.save.total += pts;
        this.dirty = true;
        this.audio.chime();
      };
      const def = DS.carById(this.save.car);
      this.car = new DS.Car(def, this.carSetup(def.id));
      this.leader = new DS.Leader(this.city, DS.carById('oni'), {
        color: '#f2efe6', livery: 'stripes', rim: '#d4af37', smoke: '#f4f4f4', wing: true, glow: '#38d9ff', upg: {},
      });
      this.leader.go = true;
      this.spawn = this.leader.path.at(4);
      this.car.reset(this.spawn.x, this.spawn.y, this.spawn.ang);
      this.cam = { x: this.leader.x, y: this.leader.y, rot: -Math.PI / 2 - this.leader.h, zoom: 10, zoomCss: 0, shake: 0, vAng: this.leader.h };
      this.state = 'menu'; this.mode = 'free'; this.judge = null;
      this.time = 0; this.acc = 0; this.last = performance.now() / 1000; this.savedAt = 0;
      this.near = 99; this.nearT = 0; this.scrape = 0; this.fpsAvg = 60;
      this.carFX = this.fxState(); this.leadFX = this.fxState();
      this.wheelBuf = new Float32Array(8);
      this.aud = { rpm: 0, load: 0, redline: 7000, slip: 0, speed: 0, grass: false, scrape: 0, turbo: false, boost: 0, rain: false, ldist: 999, lrpm: 0 };
      this.lastTs = 0; this.lastFrameTs = 0; this.lock30 = false; this._frozenDone = false;
      DS.CarRender.prewarmParked();
      Object.values(this.save.cars).forEach((c) => c && c.smoke && DS.Sprites.smokeAtlas(c.smoke));
      this.autoQ = new DS.Quality.AutoQuality((L, dir) => this.onAutoLevel(L, dir));
      this.ev = {
        hit: (ct, res, kind) => this.onHit(ct, res, kind),
        brk: (col) => this.onBreak(col),
        cone: () => this.audio.impact(1.2),
      };
      DS.UI.init(this);
      this.applySettings();
      this.setupQuality(true);
      window.addEventListener('resize', () => this.resize());
      window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
      document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'play') this.pause(); });
      DS.UI.show('menu');
      requestAnimationFrame((t) => this.loop(t));
    },

    // ---------------- kayıt ----------------
    load() {
      const base = {
        v: 1, money: 5000, best: 0, total: 0, owned: ['hachi'], car: 'hachi', cars: {}, hint: false,
        settings: { steer: 'buttons', sens: 0.6, assist: 0.7, trans: 'auto', cam: 'chase', zoom: 1, time: 'night', weather: 'clear', quality: 'auto', qv: 2, dynres: true, fpsCap: 0, sound: true, vol: 0.8, fps: false },
      };
      const d = U.store.get(SAVE_KEY, null);
      if (!d || d.v !== 1) return base;
      // sürüm kontrolü varsayılanlarla birleştirmeden ÖNCE yapılmalı (varsayılanlar qv:2 içerir)
      const raw = d.settings || {};
      const migrate = raw.qv !== 2;
      d.settings = Object.assign({}, base.settings, raw);
      // eski kayıtlar (Düşük/Orta/Yüksek, masaüstünde varsayılan Yüksek) kasmanın sebebiydi: Otomatik'e geçir
      if (migrate) { d.settings.quality = 'auto'; d.settings.qv = 2; d.settings.dynres = true; delete d.settings.autoLevel; }
      d.owned = Array.isArray(d.owned) && d.owned.length ? d.owned : ['hachi'];
      d.cars = d.cars || {};
      if (!DS.CARS.some((c) => c.id === d.car)) d.car = 'hachi';
      return Object.assign(base, d);
    },
    persist() { clearTimeout(this._pt); U.store.set(SAVE_KEY, this.save); this.dirty = false; },
    persistSoon() { clearTimeout(this._pt); this._pt = setTimeout(() => this.persist(), 400); },
    carSetup(id) {
      if (!this.save.cars[id]) this.save.cars[id] = DS.defaultCarSetup(DS.carById(id));
      const s = this.save.cars[id];
      s.upg = Object.assign({ engine: 0, turbo: 0, tires: 0, angle: 0, diff: 0 }, s.upg || {});
      return s;
    },
    selectCar(id) {
      this.save.car = id;
      const def = DS.carById(id);
      this.car.setDef(def, this.carSetup(id));
      this.car.gear = Math.min(this.car.gear, def.gears.length);
      this.applySettings();
      this.audio.setVoice(def.voice);
      this.persist();
    },
    applyCarSetup() {
      this.car.setDef(this.car.def, this.carSetup(this.car.def.id));
      this.applySettings();
      this.persist();
    },
    applySettings() {
      const s = this.save.settings;
      this.input.mode = s.steer; this.input.sens = s.sens;
      this.car.stab = 4.3 * s.assist;
      this.steerAssist = 0.45 + 0.4 * s.assist;
      this.car.auto = s.trans === 'auto';
      const b = document.body.classList;
      b.toggle('manual', s.trans === 'manual');
      b.toggle('steer-slider', s.steer === 'slider');
      b.toggle('steer-tilt', s.steer === 'tilt');
      this.audio.setOn(s.sound); this.audio.setVol(s.vol);
      const e = Object.assign({}, ENV[s.time] || ENV.night);
      e.rain = s.weather === 'rain';
      if (e.rain) {
        e.sun = null;
        if (s.time === 'day') Object.assign(e, { light: true, ambient: 'rgb(152,162,184)', bldAmb: 'rgb(122,130,150)', lamps: true, lampA: 0.4, headA: 0.5, windows: true, bloom: 0.04 });
      }
      this.env = e;
      this.tuneEnv();
      // kalite modu değiştiyse kademeyi yeniden kur
      const qkey = s.quality + '|' + s.dynres + '|' + s.fpsCap;
      if (this._qReady && this._qkey !== qkey) this.setupQuality(false);
      this._frozenDone = false;
      this.persistSoon();
    },
    // Bloom kapalı kademelerde lamba gücünü ve ortamı biraz artırarak telafi et
    tuneEnv() {
      const e = this.env, Q = this.Q;
      if (!e || !Q) return;
      if (e._base === undefined) e._base = { lampA: e.lampA, ambient: e.ambient };
      const nb = !Q.bloom && e.light;
      e.lampA = e._base.lampA * (nb ? 1.12 : 1);
      if (nb && e._base.ambient) {
        const m = e._base.ambient.match(/\d+/g).map(Number);
        e.ambient = `rgb(${Math.min(255, m[0] * 1.08) | 0},${Math.min(255, m[1] * 1.08) | 0},${Math.min(255, m[2] * 1.08) | 0})`;
      } else e.ambient = e._base.ambient;
    },
    // Kalite modunu kur: Otomatik (tüm merdiven) ya da sabit kademe (+ isteğe bağlı dinamik çözünürlük)
    setupQuality(boot) {
      const s = this.save.settings, L = DS.Quality.LADDER;
      this._qReady = true;
      this._qkey = s.quality + '|' + s.dynres + '|' + s.fpsCap;
      let min = 0, max = L.length - 1, start;
      if (s.quality === 'auto') {
        const g = DS.Quality.guessLevel(s.autoLevel);
        start = g.level;
        if (g.soft && boot && !s.swWarned) {
          s.swWarned = true;
          setTimeout(() => DS.UI.toast('Tarayıcıda donanım hızlandırma kapalı görünüyor. Açarsan oyun çok daha akıcı olur.', 5200), 900);
        }
      } else {
        const t = U.clamp(Number(s.quality) | 0, 0, 3);
        min = L.findIndex((x) => x[0] === t);
        max = min + DS.Quality.TIERS[t].scales.length - 1;
        start = max;
        if (!s.dynres) min = max;
      }
      this.lock30 = false;
      this.autoQ.lock30 = false;
      // otomatik 30 kilidi yalnızca Otomatik modda ve FPS sınırı 'Sınırsız' iken
      this.autoQ.allowLock = s.quality === 'auto' && !Number(s.fpsCap);
      this.autoQ.capMs = Number(s.fpsCap) ? 1000 / Number(s.fpsCap) : 0;
      this.autoQ.setRange(min, max);
      this.autoQ.level = U.clamp(start, min, max);
      this.autoQ.reset(1.2);
      this.applyLevel(this.autoQ.level);
    },
    onAutoLevel(L, dir) {
      if (dir === 'lock30') {
        if (!this.save.settings.fpsCap) {
          if (!this._lockToasted) { this._lockToasted = true; DS.UI.toast('Akıcılık için 30 FPS kilidi açıldı', 2400); }
          this.lock30 = true;
        }
        return;
      }
      if (dir === 'unlock30') { this.lock30 = false; return; }
      this.applyLevel(L);
      if (this.save.settings.quality === 'auto') { this.save.settings.autoLevel = L; this.persistSoon(); }
    },
    applyLevel(L) {
      const [tier, scale] = DS.Quality.LADDER[L];
      const T = DS.Quality.TIERS[tier];
      this.level = L;
      this.Q = Object.assign({ tier, scale }, T);
      this.renderScale = scale;
      const b = document.body.classList;
      for (let i = 0; i < 4; i++) b.toggle('q' + i, i === tier);
      this.city.setQuality(this.Q);
      this.fx.setQuality(this.Q);
      if (DS.UI.setQuality) DS.UI.setQuality(this.Q);
      if (this.audio.setQuality) this.audio.setQuality(this.Q);
      this.tuneEnv();
      this.resize();
    },
    resize() {
      const Q = this.Q;
      if (!Q) return;
      const w = window.innerWidth, h = window.innerHeight;
      // iç çözünürlük = CSS boyutu × min(dpr, kademe sınırı) × ölçek; piksel bütçesini aşarsa küçült
      let r = Math.min(window.devicePixelRatio || 1, Q.dprCap) * this.renderScale;
      const px = w * h * r * r;
      if (px > Q.maxPx) r *= Math.sqrt(Q.maxPx / px);
      r = Math.max(r, 0.3);
      this.dpr = r;
      this.cssW = w; this.cssH = h;
      const cw = Math.max(1, Math.round(w * r)), ch = Math.max(1, Math.round(h * r));
      // tuval boyutunu yalnızca değiştiğinde ata (atama arka belleği temizleyip yeniden ayırır)
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
      if (this._cssW !== w || this._cssH !== h) { this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px'; this._cssW = w; this._cssH = h; }
      const lw = Math.max(1, Math.ceil(cw * Q.lightScale)), lh = Math.max(1, Math.ceil(ch * Q.lightScale));
      if (this.lc.width !== lw || this.lc.height !== lh) { this.lc.width = lw; this.lc.height = lh; }
      this.fx.resizeLayers(cw, ch, lw, lh);
      // donmuş karede kamera güncellenmez: yakınlığı yeni ölçeğe hemen uyarla
      if (this.cam && this.cam.zoomCss) this.cam.zoom = this.cam.zoomCss * this.dpr;
      this._frozenDone = false;
      if (this.autoQ) this.autoQ.reset(0.8);
      if (DS.UI.sizeCanvases) DS.UI.sizeCanvases();
    },

    // ---------------- modlar ----------------
    beginPlay() {
      this.audio.init();
      this.audio.setVoice(this.car.def.voice);
      this.state = 'play';
      document.body.classList.toggle('tandem', this.mode === 'tandem');
      DS.UI.hideAll();
      DS.UI.el.hud.hidden = false;
      DS.UI.sizeCanvases();
      this.input.reset();
      this.score.reset();
      this.acc = 0;
      this.last = performance.now() / 1000;
      this.carFX = this.fxState(); this.leadFX = this.fxState();
      try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* desteklenmiyor */ }
      if (!this.save.hint) {
        this.save.hint = true;
        DS.UI.toast(document.body.classList.contains('touch') ? 'İpucu: gaza hızlı iki kez dokun = debriyaj atma' : 'İpucu: Shift = debriyaj atma, Boşluk = el freni', 4200);
      } else if (this.cssH > this.cssW && document.body.classList.contains('touch')) {
        DS.UI.toast('En iyi deneyim için telefonu yan çevir', 2600);
      }
    },
    startFree() {
      this.mode = 'free'; this.judge = null;
      this.audio.init(); this.audio.setLeaderVoice(null);
      this.car.reset(this.spawn.x, this.spawn.y, this.spawn.ang);
      this.city.resetCones();
      this.beginPlay();
    },
    startTandem() {
      this.mode = 'tandem';
      this.audio.init();
      const L = this.leader;
      L.reset(30); L.go = false;
      const q = L.path.at(21);
      this.car.reset(q.x, q.y, q.ang);
      this.startPose = { x: q.x, y: q.y, h: q.ang };
      this.judge = new DS.TandemJudge(L);
      this.city.resetCones();
      this.fx.clear();
      this.beginPlay();
      this.audio.setLeaderVoice(L.def.voice);
    },
    pause() {
      if (this.state !== 'play') return;
      this.state = 'pause';
      DS.UI.show('pause');
      this.audio.silence();
      this.persist();
    },
    resume() {
      this.state = 'play';
      DS.UI.hideAll();
      DS.UI.el.hud.hidden = false;
      this.input.reset();
      this.last = performance.now() / 1000;
    },
    toMenu() {
      this.state = 'menu'; this.mode = 'free'; this.judge = null;
      DS.UI.el.hud.hidden = true;
      this.audio.silence();
      this.audio.setLeaderVoice(null);
      this.leader.reset(0); this.leader.go = true;
      this.leadFX = this.fxState();
      this.persist();
      DS.UI.show('menu');
    },
    respawn() {
      const p = this.city.respawnPoint(this.car.x, this.car.y, this.car.h);
      this.car.reset(p.x, p.y, p.h);
      this.score.reset();
      this.carFX = this.fxState();
      DS.UI.toast('Yola dönüldü', 1200);
    },
    finishTandem() {
      const r = this.judge.result;
      const reward = r.done ? (r.score >= 65 ? 2500 + r.score * 20 : r.score * 10) : 0;
      this.save.money += reward;
      this.state = 'result';
      this.audio.silence();
      this.persist();
      DS.UI.showResult(r, reward);
      if (r.done && r.score >= 65) this.audio.chime();
    },

    // ---------------- döngü ----------------
    loop(ts) {
      requestAnimationFrame((t) => this.loop(t));
      const s = this.save.settings;
      // FPS sınırı (ayar ya da otomatik 30 kilidi): erken gelen kareyi atla
      const cap = Number(s.fpsCap) || (this.lock30 ? 30 : 0);
      if (cap) {
        // hedef zamana göre adımla: artan süre korunur, 75/144 Hz ekranlarda da ortalama tam 'cap' olur
        const iv = 1000 / cap;
        if (this._capT && ts < this._capT + iv - 2) return;
        this._capT = this._capT && ts - this._capT < 2 * iv ? this._capT + iv : ts;
      } else this._capT = 0;
      const t0 = performance.now();
      const delta = this.lastFrameTs ? ts - this.lastFrameTs : 16.7;
      this.lastFrameTs = ts;
      let dt = delta / 1000;
      if (!(dt > 0)) dt = 1 / 60;
      dt = Math.min(dt, this.Q ? this.Q.dtMax : 0.05);
      this.fpsAvg = U.lerp(this.fpsAvg, 1000 / Math.max(delta, 1), 0.05);
      this.time += dt;
      const frozen = this.state === 'pause' || this.state === 'result' || DS.UI.current === 'garage' || DS.UI.current === 'settings';
      try {
        if (!frozen) {
          if (this.state === 'play') this.updatePlay(dt);
          else if (this.state === 'menu') this.updateAttract(dt);
          if (this.state === 'play' || this.state === 'menu') {
            this.fx.update(dt);
            this.fx.updateRain(dt, this.canvas.width, this.canvas.height, this.env.rain, this.dpr);
            if (this.view) this.fx.rainSplashes(this.view, dt);
          }
          this.drawFrame(dt);
          this._frozenDone = false;
        } else if (!this._frozenDone) {
          // menü/duraklat altında tek bir sabit kare yeter
          this.drawFrame(0);
          this._frozenDone = true;
        }
        DS.UI.frame(dt);
      } catch (e) {
        console.error(e);
      }
      const work = performance.now() - t0;
      if (!frozen && (this.state === 'play' || this.state === 'menu') && !document.hidden) this.autoQ.sample(delta, work, dt);
      if (this.dirty && this.time - this.savedAt > 3) { this.persist(); this.savedAt = this.time; }
    },

    // Fizik adımları arasında ara değer: araçlar bir sonraki adıma doğru yumuşakça çizilir
    drawFrame(dt) {
      const a = U.sat(this.acc / STEP);
      const objs = this.state === 'menu' ? [this.leader] : this.mode === 'tandem' ? [this.leader, this.car] : [this.car];
      for (const o of objs) {
        if (o.px === undefined) continue;
        o._x = o.x; o._y = o.y; o._h = o.h;
        o.x = U.lerp(o.px, o.x, a); o.y = U.lerp(o.py, o.y, a); o.h = U.alerp(o.ph, o.h, a);
      }
      try {
        if (dt > 0) this.updateCamera(dt);
        this.render();
      } finally {
        // çizim hata verse bile gerçek fizik konumu geri yüklensin
        for (const o of objs) {
          if (o._x === undefined) continue;
          o.x = o._x; o.y = o._y; o.h = o._h; o._x = undefined;
        }
      }
    },

    updateAttract(dt) {
      const L = this.leader;
      this.acc += dt;
      let n = 0;
      const cap = this.Q ? this.Q.physCap : 6;
      while (this.acc >= STEP && n < cap) { L.px = L.x; L.py = L.y; L.ph = L.h; L.update(STEP); this.acc -= STEP; n++; }
      if (n >= cap) this.acc = 0;
      this.emitFX(L, dt, this.leadFX);
      if (Math.abs(L.driftA) > 0.3 && Math.random() < dt * 0.9) this.backfire(L, 0.8, true);
    },

    updatePlay(dt) {
      const I = this.input, s = this.save.settings, car = this.car;
      const inp = I.poll(dt, this.time);
      if (I.edge('pause')) { this.pause(); return; }
      if (I.edge('reset')) this.respawn();
      if (I.edge('cam')) { s.cam = s.cam === 'chase' ? 'north' : 'chase'; DS.UI.toast(s.cam === 'chase' ? 'Kamera: takip' : 'Kamera: sabit', 1200); this.persist(); }
      if (I.edge('mute')) { s.sound = !s.sound; this.audio.setOn(s.sound); DS.UI.toast(s.sound ? 'Ses açık' : 'Ses kapalı', 1200); this.persist(); }
      const gu = I.edge('gup'), gd = I.edge('gdn');
      if (!car.auto) { if (gu) car.shiftUp(); if (gd) car.shiftDown(); }

      const tandem = this.mode === 'tandem' && this.judge;
      const counting = tandem && this.judge.state === 'count';
      let kick = inp.kick;
      this.acc += dt;
      let n = 0;
      const cap = this.Q.physCap, L = this.leader;
      while (this.acc >= STEP && n < cap) {
        inp.kick = kick; kick = false;
        car.px = car.x; car.py = car.y; car.ph = car.h;
        if (tandem) { L.px = L.x; L.py = L.y; L.ph = L.h; }
        const hb = inp.handbrake;
        if (counting) inp.handbrake = true;
        car.updateSteer(STEP, inp.steer, this.steerAssist);
        car.step(STEP, inp, this.city, this.env);
        inp.handbrake = hb;
        if (counting) {
          car.x = car.px = this.startPose.x; car.y = car.py = this.startPose.y; car.h = car.ph = this.startPose.h;
          car.vx = car.vy = car.w = 0;
        }
        this.city.collideCar(car, this.ev);
        if (tandem) {
          if (!counting) this.leader.update(STEP, this.judge.gap);
          this.collideLeader();
        }
        this.city.updateCones(STEP);
        this.acc -= STEP; n++;
      }
      if (n >= cap) this.acc = 0;

      this.nearT -= dt;
      if (this.nearT <= 0) { this.near = this.city.nearWall(car, 2); this.nearT = 0.06; }
      this.score.update(dt, car, this.near);
      this.checkClips(dt);
      if (tandem) {
        this.judge.update(dt, car);
        if (this.judge.state === 'done') { this.finishTandem(); return; }
      }
      this.emitFX(car, dt, this.carFX);
      if (tandem) this.emitFX(this.leader, dt, this.leadFX);
      this.handleEvents(car);
      if (tandem && Math.abs(this.leader.driftA) > 0.35 && Math.random() < dt * 0.6) this.backfire(this.leader, 0.8, false);
      this.scrape = Math.max(0, this.scrape - dt * 4);
      const A = this.aud;
      A.rpm = car.rpm; A.load = car.limiter > 0 ? 0.2 : car.thr; A.redline = car.p.redline;
      A.slip = Math.max(car.slipR, car.slipF * 0.8); A.speed = car.speed; A.grass = car.surfR === 1 || car.surfF === 1;
      A.scrape = this.scrape; A.turbo = car.p.turbo > 0; A.boost = car.boost; A.rain = this.env.rain;
      A.ldist = tandem ? Math.hypot(car.x - this.leader.x, car.y - this.leader.y) : 999; A.lrpm = this.leader.rpm;
      this.audio.update(A, dt);
    },

    collideLeader() {
      const ct = C.obbObb(this.car.obb(), this.leader.obb());
      if (!ct) return;
      const res = C.resolve(this.car, ct, 0.3, 0.3, this.leader.vx, this.leader.vy);
      if (res.vn > 0.8) {
        this.judge.contact();
        this.fx.sparks(ct.px, ct.py, this.car.vx * 0.5, this.car.vy * 0.5, Math.round(res.vn * 3), 4);
        this.audio.impact(res.vn);
        this.cam.shake = Math.min(1, this.cam.shake + res.vn * 0.05);
      }
    },

    checkClips(dt) {
      const car = this.car;
      for (const c of this.city.clips) {
        if (c.t > 0) c.t -= dt;
        if (c.cd > 0) { c.cd -= dt; continue; }
        if (!this.score.active) continue;
        if (Math.hypot(car.x - c.x, car.y - c.y) < c.r + 1.2 && this.score.clip(car)) {
          c.t = 1.2; c.cd = 3;
          this.audio.beep(1320, 0.08, 0.06);
        }
      }
    },

    onHit(ct, res, kind) {
      const car = this.car, vn = res.vn;
      if (vn > 1.0) {
        if (kind !== 'tires' && kind !== 'tree') this.fx.sparks(ct.px, ct.py, car.vx * 0.5, car.vy * 0.5, Math.min(40, Math.round(vn * 3)), 4 + vn * 0.5);
        if (vn > 4) this.fx.bits(ct.px, ct.py, car.vx * 0.3, car.vy * 0.3, kind === 'tires' ? '#1a1a1a' : kind === 'tree' ? '#3d7a33' : '#c9ccd1', Math.round(vn / 2), 0.12);
        this.audio.impact(vn);
        this.cam.shake = Math.min(1.2, this.cam.shake + vn * 0.06);
        this.score.impact(vn);
        if (vn > 6 && navigator.vibrate) { try { navigator.vibrate(Math.min(80, vn * 6)); } catch (e) { /* yok */ } }
      }
      if (res.vt > 4 && kind !== 'tires' && kind !== 'tree') {
        this.scrape = Math.min(1, Math.max(this.scrape, res.vt / 18));
        if (Math.random() < 0.6) this.fx.sparks(ct.px, ct.py, car.vx * 0.7, car.vy * 0.7, 2, 2.5);
      }
    },
    onBreak(col) {
      const car = this.car;
      if (col.kind === 'lamp') {
        this.fx.sparks(col.x, col.y, car.vx * 0.4, car.vy * 0.4, 22, 6);
        this.fx.bits(col.x, col.y, car.vx * 0.4, car.vy * 0.4, '#cfe3ef', 10, 0.08);
        this.audio.clang(); this.audio.glass(0.7);
      } else if (col.kind === 'hydrant') {
        this.fx.jet(col.x, col.y, 8);
        this.fx.bits(col.x, col.y, car.vx * 0.5, car.vy * 0.5, '#b8231f', 6, 0.12);
        this.audio.clang();
      } else {
        this.fx.bits(col.x, col.y, car.vx * 0.6, car.vy * 0.6, '#3f6450', 7, 0.16);
        this.fx.bits(col.x, col.y, car.vx * 0.6, car.vy * 0.6, '#d8d2c0', 9, 0.09);
        this.audio.impact(3);
      }
      this.cam.shake = Math.min(1, this.cam.shake + 0.25);
    },

    handleEvents(car) {
      for (const e of car.events) {
        if (e === 'shift') { if (Math.random() < 0.55) this.backfire(car, 0.9); }
        else if (e === 'down') { if (Math.random() < 0.35) this.backfire(car, 0.6); }
        else if (e === 'limiter') { if (Math.random() < 0.4) this.backfire(car, 0.7); }
        else if (e === 'bov') { this.audio.bov(); if (Math.random() < 0.6) this.backfire(car, 0.8); }
        else if (e === 'kick') { this.backfire(car, 1.1); }
        else if (e === 'dump') { this.backfire(car, 0.9); }
      }
      car.events.length = 0;
    },

    backfire(car, s, silent) {
      const def = car.def, c = Math.cos(car.h), si = Math.sin(car.h);
      const sides = def.dual ? [-0.55, 0.55] : [def.exhaust];
      for (const ex of sides) {
        const lx = -def.len / 2 - 0.05, ly = (ex * def.wid) / 2;
        this.fx.fire(car.x + c * lx - si * ly, car.y + si * lx + c * ly, car.h + Math.PI, s, car.vx, car.vy);
      }
      if (!silent) this.audio.pop(s);
    },

    fxState() {
      return { px: [0, 0, 0, 0], py: [0, 0, 0, 0], on: [false, false, false, false], carry: [0, 0, 0, 0], dust: [0, 0, 0, 0] };
    },

    // Lastik dumanı, iz ve toz üretimi
    emitFX(car, dt, st) {
      const W = car.wheels(this.wheelBuf), fx = this.fx, env = this.env;
      const qk = this.Q.smoke.emit;
      const col = car.setup.smoke;
      for (let k = 0; k < 4; k++) {
        const rear = k >= 2;
        const x = W[k * 2], y = W[k * 2 + 1];
        const slip = rear ? car.slipR : car.slipF;
        const inten = U.sat((slip - (rear ? 2 : 2.5)) / 10);
        const surf = rear ? car.surfR || 0 : car.surfF || 0;
        if (inten > 0.02) {
          if (st.on[k]) {
            const a = surf === 0 ? (rear ? 0.1 + inten * 0.32 : 0.06 + inten * 0.2) : 0.14 + inten * 0.22;
            fx.skids.seg(st.px[k], st.py[k], x, y, 0.26, env.rain ? a * 0.5 : a, surf === 0 ? '#0d0d0f' : '#3b2b17');
          }
          st.on[k] = true;
          if (surf === 0 && rear) {
            st.carry[k] += dt * (env.rain ? 10 : 6 + inten * 52) * qk;
            while (st.carry[k] >= 1) {
              st.carry[k] -= 1;
              const r1 = Math.random() - 0.5, r2 = Math.random() - 0.5, r3 = Math.random() - 0.5, r4 = Math.random() - 0.5;
              if (env.rain) fx.puff(x + r1 * 0.4, y + r2 * 0.4, car.vx * 0.25 + r3 * 1.4, car.vy * 0.25 + r4 * 1.4, 0.4, 1.4, 0.16, 0.8, '#d6dde6');
              else fx.puff(x + r1 * 0.45, y + r2 * 0.45, car.vx * 0.18 + r3 * 1.8, car.vy * 0.18 + r4 * 1.8,
                0.45 + Math.random() * 0.3, 1.5 + inten * 2.3 + Math.random(), 0.16 + inten * 0.34, 1.6 + inten * 1.9 + Math.random() * 0.6, col);
            }
          }
        } else st.on[k] = false;
        // çim/çakılda toz
        if (surf !== 0 && car.speed > 4) {
          st.dust[k] += dt * (3 + car.speed * 0.6 + inten * 20) * qk;
          while (st.dust[k] >= 1) {
            st.dust[k] -= 1;
            fx.puff(x, y, car.vx * 0.3 + (Math.random() - 0.5) * 2, car.vy * 0.3 + (Math.random() - 0.5) * 2, 0.35, 1.6, 0.22, 1.1, surf === 1 ? '#7a6a45' : '#a39373');
          }
        }
        // yağmurda su sisi
        if (env.rain && rear && car.speed > 9 && Math.random() < dt * car.speed * 0.5 * qk) {
          fx.puff(x, y, car.vx * 0.4, car.vy * 0.4, 0.3, 1.8, 0.1, 0.7, '#cfd8e2');
        }
        st.px[k] = x; st.py[k] = y;
      }
    },

    // ---------------- kamera ----------------
    updateCamera(dt) {
      const s = this.save.settings, cam = this.cam;
      const tgt = this.state === 'menu' ? this.leader : this.car;
      const sp = Math.hypot(tgt.vx, tgt.vy);
      const vAng = sp > 2.5 ? Math.atan2(tgt.vy, tgt.vx) : tgt.h;
      cam.vAng = U.alerp(cam.vAng, vAng, 1 - Math.exp(-4 * dt));
      const zBase = U.clamp(Math.min(this.cssW, this.cssH) / 40, 9.5, 18) * s.zoom * (this.state === 'menu' ? 0.82 : 1);
      const zt = zBase * U.lerp(1, 0.72, U.smooth(4, 40, sp));
      cam.zoomCss = cam.zoomCss ? U.damp(cam.zoomCss, zt, 2, dt) : zt;
      cam.zoom = cam.zoomCss * this.dpr;
      const chase = s.cam === 'chase';
      const viewH = this.cssH / cam.zoomCss;
      // takip kamerasında araç ekranın alt yarısında; kısa yatay ekranda gösterge üstünde kalacak kadar yukarıda
      const lift = this.cssH < 500 && this.cssW > this.cssH ? 0.07 : 0.15;
      const look = Math.min(sp * 0.3, 12) + (chase ? viewH * lift : 0);
      const tx = tgt.x + Math.cos(cam.vAng) * look, ty = tgt.y + Math.sin(cam.vAng) * look;
      cam.x = U.damp(cam.x, tx, 6, dt); cam.y = U.damp(cam.y, ty, 6, dt);
      const rt = chase ? -Math.PI / 2 - cam.vAng : 0;
      cam.rot = U.alerp(cam.rot, rt, 1 - Math.exp(-(chase ? 2.6 : 4) * dt));
      cam.shake *= Math.exp(-5 * dt);
    },

    // ---------------- çizim ----------------
    render() {
      const ctx = this.ctx, cam = this.cam, env = this.env, Q = this.Q;
      const W = this.canvas.width, H = this.canvas.height;
      const z = cam.zoom, r = cam.rot, cs = Math.cos(r) * z, sn = Math.sin(r) * z;
      const sx = (Math.random() - 0.5) * cam.shake * 0.5, sy = (Math.random() - 0.5) * cam.shake * 0.5;
      const cx = cam.x + sx, cy = cam.y + sy;
      const M = this.M;
      M[0] = cs; M[1] = sn; M[2] = -sn; M[3] = cs; M[4] = W / 2 - (cs * cx - sn * cy); M[5] = H / 2 - (sn * cx + cs * cy);
      const hd = Math.hypot(W, H) / 2 / z + 2;
      const v = this.view;
      v.x0 = cx - hd; v.y0 = cy - hd; v.x1 = cx + hd; v.y1 = cy + hd;
      const cp = this.cp;
      cp.x = cx; cp.y = cy;
      const cars = this.cars;
      cars.length = 0;
      if (this.state === 'menu') cars.push(this.leader);
      else { if (this.mode === 'tandem') cars.push(this.leader); cars.push(this.car); }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      this.city.drawGround(ctx, v, this.time);
      this.fx.skids.draw(ctx, v);
      if (env.rain && Q.tier >= 2) { ctx.fillStyle = 'rgba(22,34,58,0.2)'; ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0); }
      if (env.sun) this.city.drawShadows(ctx, v, env);
      for (const c of cars) DS.CarRender.drawShadow(ctx, c, env);
      this.city.drawLowProps(ctx, v, this.time, M);
      for (const c of cars) DS.CarRender.drawCar(ctx, c);
      this.fx.drawSmoke(ctx, v, M, W, H);
      const tall = this.city.collectTall(v, M, W, H);
      this.city.drawTallProps(ctx, cp, env, tall);
      this.city.drawSolids(ctx, v, cp, env, env.light, M, W, H);

      if (env.light) {
        const l = this.lctx, lw = this.lc.width, lh = this.lc.height, ls = lw / W, lsy = lh / H;
        l.setTransform(1, 0, 0, 1, 0, 0);
        l.globalCompositeOperation = 'source-over';
        l.globalAlpha = 1;
        // düşük kademede yağmur tonu ayrı tam ekran dolgu yerine ortam ışığına katılır
        l.fillStyle = env.rain && Q.tier < 2 ? this.rainAmb(env) : env.ambient;
        l.fillRect(0, 0, lw, lh);
        l.setTransform(M[0] * ls, M[1] * lsy, M[2] * ls, M[3] * lsy, M[4] * ls, M[5] * lsy);
        l.globalCompositeOperation = 'lighter';
        if (env.lamps) this.city.drawLightSources(l, env, tall, M, W, H);
        for (const c of cars) DS.CarRender.drawLights(l, c, env);
        this.fx.drawFlashes(l);
        l.globalCompositeOperation = 'source-over';
        this.fx.drawSmokeLight(l, v, M, W, H);
        this.city.drawSolidsLight(l, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(this.lc, 0, 0, W, H);
        if (Q.bloom) {
          // çarpma yalnızca karartır; ışığın bir kısmını toplayarak aydınlık bölgeleri parlat
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = env.bloom || 0.1;
          ctx.drawImage(this.lc, 0, 0, W, H);
          ctx.globalAlpha = 1;
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      }
      ctx.globalCompositeOperation = 'lighter';
      this.fx.drawAdd(ctx);
      if (env.light) {
        this.city.drawEmissive(ctx, cp, env, this.time, tall);
        for (const c of cars) DS.CarRender.drawGlow(ctx, c, env);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.fx.drawRain(ctx, this.dpr);
    },
    rainAmb(env) {
      if (env._rainAmbSrc !== env.ambient) {
        const m = env.ambient.match(/\d+/g).map(Number);
        env._rainAmb = `rgb(${(m[0] * 0.84) | 0},${(m[1] * 0.86) | 0},${(m[2] * 0.92) | 0})`;
        env._rainAmbSrc = env.ambient;
      }
      return env._rainAmb;
    },
  });

  function boot() {
    const hot = window.claude && window.claude.hot;
    if (hot && typeof hot.ready === 'function') hot.ready(() => Game.init());
    else Game.init();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
