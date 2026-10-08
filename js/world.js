'use strict';
// Açık şehir orkestratörü (DS.World) — SPEC §2.4–2.9, §2.6.12–2.6.13, §5.4, §5.6, §5.8, §5.9, §8.1.
//  - Bağlam W'yi kurar ve tüm alt sistemlere verir (trafik, yayalar, oyuncu yaya, polis, görevler); her biri
//    eksik olabilir ya da hata verebilir: her çağrı korunur, yaya ve araç kaydı için küçük yedekler vardır.
//  - Oyuncu durum makinesi: foot / enter / car / exit / down / busted / wasted / spray. Binme, inme, araç
//    gaspı (otopark araçları dahil), kendi garaj aracı, hasar (duman, yangın, çizgi film patlaması),
//    sağlık/bayılma, tutuklanma, boyahane, güvenli ev (kayıt + garaj), hurda vinci, telefon/işaret/taksi.
//  - Para (ödül/ceza), drift kasası, gün/gece ortamı, GPS + yol noktası + yön oku, HUD verisi, blipler,
//    kayıt (save.ow), otomatik kayıt, kalite kancaları, ölçüm (prof) ve hata ayıklama API'si (§8.1).
// Şiddet çizgi film: kimse ölmez; yayalar devrilir (yıldızlar), oyuncu "BAYILDIN!" olur.
// Sıcak döngülerde tahsis yok: kalıcı karalama nesneleri, tipli diziler, kayıt havuzu indeksleri.
(function () {
  const DS = window.DS, U = DS.U;
  const PI = Math.PI, TAU = PI * 2;
  const VM = DS.VM || { RAIL: 0, PHYS: 1, PARKED: 2, WRECK: 3, HELD: 4 };
  const PS = DS.PS || { WANDER: 0, WAIT: 1, CROSS: 2, DODGE: 3, FLEE: 4, FALL: 5, DOWN: 6, GETUP: 7, IDLE: 8, COP: 9, WAVE: 10, GOTO: 11, GONE: 255 };
  const PR = DS.PR || { CIV: 0, COP: 1, MISSION: 2, DRIVER: 3 };
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // ---------- ayarlar ----------
  const ENTER_R = 1.8;          // binme menzili (araç kutusuna)
  const ENTER_V = 2.0;          // binilebilir en yüksek araç hızı
  const ENTER_T = 0.6, JACK_T = 0.4, EXIT_T = 0.45;
  const EXIT_V = 3;             // bu hızın üstünde önce otomatik fren
  const BURN_T = 4;             // yangından patlamaya (s)
  const BUSTED_T = 2.6, WASTED_T = 2.8, SPRAY_T = 2;
  const OWN_FAR = 400;          // kendi araç bu kadar uzakta ve görünmezse güvenli eve döner
  const AUTOSAVE_T = 60;
  const LOT_BASE = { glow: 'none', smoke: '#f4f4f4', upg: {}, bar: false, sign: false };
  const SPRAY_COLS = ['#c8102e', '#1d4e9e', '#2f6f4f', '#f2efe6', '#1b1d22', '#ffc400', '#5b2a86', '#7fd1ff', '#ff6a13', '#8a8f98', '#e4007c'];
  const PANTS_PLAYER = '#22262e';
  const ARROW_COL = '#ffd23e';
  const RING_HOME = '#ffb23e', RING_SPRAY = '#c86bff';

  // ---------- gün / gece (§5.9) ----------
  // main.js ENV'i DS.ENV olarak dışa verir; Node testinde yoksa aynı değerlerin kopyası kullanılır
  const ENV0 = {
    day: { sun: { x: 0.42, y: 0.3 }, shadowA: 0.24, light: false, lamps: false, lampA: 0, headA: 0, windows: false },
    sunset: { sun: { x: 1.25, y: 0.62 }, shadowA: 0.3, light: true, ambient: 'rgb(255,176,136)', bldAmb: 'rgb(232,156,120)', lamps: true, lampA: 0.5, headA: 0.45, windows: true, bloom: 0.05 },
    night: { sun: null, shadowA: 0, light: true, ambient: 'rgb(60,68,110)', bldAmb: 'rgb(72,80,122)', lamps: true, lampA: 1, headA: 1, windows: true, bloom: 0.17 },
  };
  const rgbOf = (s) => { const m = String(s).match(/\d+/g) || [255, 255, 255]; return [+m[0], +m[1], +m[2]]; };
  const daySun = (t) => { const a = Math.abs(2 * t - 1); return { x: 0.3 + 0.9 * a, y: 0.28 + 0.34 * a }; };
  // ışıklı evre anahtar durumu
  function lightKey(e, sun, shadowA) {
    return { amb: rgbOf(e.ambient), bld: rgbOf(e.bldAmb), lampA: e.lampA, headA: e.headA, bloom: e.bloom, sun, shadowA };
  }
  function keys(ENV) {
    const S = lightKey(ENV.sunset, ENV.sunset.sun, ENV.sunset.shadowA);
    return {
      // nötr: ışık haritası açık ama beyaz (çarpma etkisiz), lamba/far 0, gündüz güneşi t = 1
      N: { amb: [255, 255, 255], bld: [255, 255, 255], lampA: 0, headA: 0, bloom: 0.001, sun: daySun(1), shadowA: 0.24 },
      S,
      // gece: gün batımı güneşi, gölge alfası 0'a iner (güneş yalnız tam gecede null)
      Nt: lightKey(ENV.night, ENV.sunset.sun, 0),
    };
  }
  const lerp3 = (a, b, u) => 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * u) + ',' + Math.round(a[1] + (b[1] - a[1]) * u) + ',' + Math.round(a[2] + (b[2] - a[2]) * u) + ')';
  function mixLight(a, b, u) {
    const L = U.lerp;
    return {
      light: true, lamps: true, windows: true,
      ambient: lerp3(a.amb, b.amb, u), bldAmb: lerp3(a.bld, b.bld, u),
      lampA: L(a.lampA, b.lampA, u), headA: L(a.headA, b.headA, u), bloom: Math.max(0.001, L(a.bloom, b.bloom, u)),
      sun: { x: L(a.sun.x, b.sun.x, u), y: L(a.sun.y, b.sun.y, u) }, shadowA: L(a.shadowA, b.shadowA, u),
    };
  }
  // saat (0..24) -> yeni ortam nesnesi (tuneEnv _base'i ilk gördüğü nesnede önbellekler: her seferinde yeni nesne)
  function envAt(h, ENV) {
    ENV = ENV || DS.ENV || ENV0;
    h = ((h % 24) + 24) % 24;
    if (h >= 6.5 && h < 18.5) {
      const e = Object.assign({}, ENV.day);
      e.sun = daySun((h - 6.5) / 12); e.shadowA = 0.24;
      return e;
    }
    if (h >= 20.5 || h < 5) return Object.assign({}, ENV.night);
    const K = keys(ENV);
    if (h >= 18.5 && h < 19.25) return mixLight(K.N, K.S, (h - 18.5) / 0.75);
    if (h >= 19.25) return mixLight(K.S, K.Nt, (h - 19.25) / 1.25);
    if (h < 5.75) return mixLight(K.Nt, K.S, (h - 5) / 0.75);
    return mixLight(K.S, K.N, (h - 5.75) / 0.75);
  }

  // ---------- küçük yardımcılar ----------
  const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km');
  // noktadan araç kutusuna uzaklık (kayıt: x, y, h, p.len, p.wid)
  function boxDist(v, x, y) {
    const c = Math.cos(v.h), s = Math.sin(v.h), dx = x - v.x, dy = y - v.y;
    const lx = Math.abs(dx * c + dy * s) - v.p.len * 0.5, ly = Math.abs(-dx * s + dy * c) - v.p.wid * 0.5;
    const ex = lx > 0 ? lx : 0, ey = ly > 0 ? ly : 0;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const defHp = (def) => (def && def.maxHp) || 1000;
  // döndürülmüş dikdörtgen (yedek çizim; ActorSprites yoksa)
  function rectAt(ctx, M, x, y, h, len, wid) {
    const c = Math.cos(h), s = Math.sin(h);
    ctx.setTransform(M[0] * c + M[2] * s, M[1] * c + M[3] * s, -M[0] * s + M[2] * c, -M[1] * s + M[3] * c,
      M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]);
    ctx.fillRect(-len / 2, -wid / 2, len, wid);
  }

  // ======================================================================
  // Yedek oyuncu yaya (DS.Walker yoksa): basit hareket + duvar kayması
  class MiniWalker {
    constructor(W) {
      this.W = W; this.x = 0; this.y = 0; this.h = 0; this.vx = 0; this.vy = 0; this.speed = 0; this.run = false;
      this.phase = 0; this.hp = 100; this.state = 'walk'; this.t = 0; this.hurtT = 99; this.anim = -1;
    }
    reset(x, y, h) { this.x = x; this.y = y; this.h = h || 0; this.vx = this.vy = this.speed = 0; this.state = 'walk'; this.t = 0; this.anim = -1; this.hurtT = 99; }
    regen(dt) { this.hurtT += dt; if (this.hurtT > 8 && this.hp > 0 && this.hp < 100) this.hp = Math.min(100, this.hp + 2 * dt); }
    update(dt, mx, my, run, W) {
      W = W || this.W;
      if (!(dt > 0)) return;
      this.regen(dt); this.t += dt;
      const s = this.state;
      if (s === 'hidden' || s === 'enter' || s === 'exit') { this.vx = this.vy = this.speed = 0; return; }
      if (s === 'down') {
        this.vx *= Math.max(0, 1 - 6 * dt); this.vy *= Math.max(0, 1 - 6 * dt);
        if (this.t >= 1.2) { this.state = 'walk'; this.t = 0; }
      } else {
        const m = Math.min(1, Math.hypot(mx, my)), vmax = run ? 5.5 : 2.2;
        const tvx = m > 0.02 ? (mx / Math.max(m, 1e-6)) * m * vmax : 0, tvy = m > 0.02 ? (my / Math.max(m, 1e-6)) * m * vmax : 0;
        const st = (vmax / 0.12) * dt;
        this.vx = U.approach(this.vx, tvx, st); this.vy = U.approach(this.vy, tvy, st);
        if (m > 0.02) this.h = U.alerp(this.h, Math.atan2(my, mx), Math.min(1, 12 * dt));
        this.run = !!run && m > 0.02;
      }
      const city = W && W.city;
      const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
      if (!city || !city.blocked(nx, this.y, 0.35)) this.x = nx; else this.vx = 0;
      if (!city || !city.blocked(this.x, ny, 0.35)) this.y = ny; else this.vy = 0;
      this.speed = Math.hypot(this.vx, this.vy);
      if (this.speed > 0.05) this.phase += (this.speed * dt) / (this.speed > 3.2 ? 2.2 : 1.3);
    }
    punch() { return -1; }
    hurt(a, ix, iy) {
      if (!(a > 0)) return;
      this.hp = Math.max(0, this.hp - a); this.hurtT = 0;
      if (this.state === 'hidden' || this.state === 'enter' || this.state === 'exit') return;
      this.state = 'down'; this.t = 0; this.vx = ix || 0; this.vy = iy || 0;
    }
    carHit(v, ix, iy) { const d = U.clamp(1.6 * v * v, 6, 100); this.hurt(d, ix, iy); return d; }
    blast(x, y) {
      const dx = this.x - x, dy = this.y - y, d = Math.hypot(dx, dy);
      if (d >= 6) return 0;
      const k = 1 - d / 6, n = d > 1e-3 ? 1 / d : 0;
      this.hurt(60 * k, dx * n * 6 * k, dy * n * 6 * k);
      return 60 * k;
    }
    hitByVehicles() { return null; }
    draw(ctx, W) {
      if (this.state === 'hidden') return;
      const AS = DS.ActorSprites, M = W.M;
      if (AS && AS.drawPed) {
        if (AS.drawPlayerRing) AS.drawPlayerRing(ctx, this.x, this.y, W.t);
        AS.drawPed(ctx, this.x, this.y, this.h, 0, this.speed > 0.2 ? 1 : 0, this.phase, false);
      } else {
        ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
        ctx.fillStyle = '#ff8a1f'; ctx.fillRect(this.x - 0.35, this.y - 0.35, 0.7, 0.7);
      }
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.globalAlpha = 1;
    }
  }

  // ======================================================================
  // Yedek araç kaydı (DS.Traffic yoksa): yalnız park hâlindeki kayıtlar (kendi araç, bırakılan araçlar);
  // oyuncu aracıyla statik temas. §2.6.8 arayüzünün dünya ve yayanın kullandığı alt kümesi.
  class MiniTraffic {
    constructor(W) { this.W = W; this.list = []; this.pool = []; this.count = 0; this._cnt = { n: 0, rail: 0, phys: 0, parked: 0, wreck: 0, held: 0, cops: 0 }; }
    get n() { return this.list.length; }
    setQuality() {}
    reset() { while (this.list.length) this.despawn(this.list[this.list.length - 1]); }
    fill() {}
    spawn(o) {
      o = o || {};
      const def = o.def || (DS.vehById ? DS.vehById('sedan') : DS.CARS[0]);
      const len = def.len || 4.6, wid = def.wid || 1.8, mh = defHp(def);
      let r = null;
      for (let i = 0; i < this.pool.length; i++) if (!this.pool[i].alive) { r = this.pool[i]; break; }
      if (r === null) { r = { idx: this.pool.length }; this.pool.push(r); }
      Object.assign(r, {
        alive: true, mode: VM.PARKED, role: o.role || 'civ', def, setup: o.setup || LOT_BASE,
        p: { a: 0, b: 0, len, wid }, x: o.x || 0, y: o.y || 0, h: o.h || 0, px: o.x || 0, py: o.y || 0, ph: o.h || 0,
        vx: 0, vy: 0, w: 0, speed: 0, v: 0, steer: 0, axf: 0, ayf: 0, brakeOn: false, revOn: false, rpm: def.idle || 800,
        lane: -1, s: 0, dLat: 0, car: null, ctrl: null, hp: mh, maxHp: mh, burnT: -1, driver: false, keep: !!o.keep,
        tag: o.tag !== undefined ? o.tag : null, siren: false, vis: false, hitCD: 0, ak: null,
        _rad: 0.5 * Math.hypot(len, wid) + 0.3, _wt: 0,
      });
      this.list.push(r); this.count = this.list.length;
      return r;
    }
    despawn(v) {
      if (!v || !v.alive) return;
      const i = this.list.indexOf(v);
      if (i >= 0) { this.list[i] = this.list[this.list.length - 1]; this.list.pop(); }
      v.alive = false; v.tag = null; v.keep = false; this.count = this.list.length;
    }
    update(dt, W) {
      for (let i = this.list.length - 1; i >= 0; i--) {
        const r = this.list[i];
        r.vis = W.isVisible(r.x, r.y, r._rad);
        if (r.hitCD > 0) r.hitCD -= dt;
        if (r.mode === VM.WRECK) { r._wt += dt; if (r._wt > 25) this.despawn(r); }
      }
    }
    stepPhys(dt, pc) {
      if (!pc) return;
      const C = DS.Collide, W = this.W;
      for (let i = 0; i < this.list.length; i++) {
        const r = this.list[i], rr = r._rad + 3;
        if (Math.abs(r.x - pc.x) > rr || Math.abs(r.y - pc.y) > rr) continue;
        const B = { x: r.x, y: r.y, c: Math.cos(r.h), s: Math.sin(r.h), hl: r.p.len / 2, hw: r.p.wid / 2 };
        const ct = C.obbObb(pc.obb(), B);
        if (!ct) continue;
        const vn = C.resolve(pc, ct, 0.25, 0.3, 0, 0).vn;
        if (vn > 1 && !(r.hitCD > 0)) { r.hitCD = 0.15; if (W.world && W.world.onVehHit) W.world.onVehHit(null, r, vn, ct.px, ct.py); }
      }
    }
    takeForPlayer(v) {
      if (!v || !v.alive) return null;
      const info = { def: v.def, setup: v.setup, x: v.x, y: v.y, h: v.h, vx: 0, vy: 0, w: 0, hp: v.hp, maxHp: v.maxHp, role: v.role, tag: v.tag, driver: false };
      this.despawn(v);
      return info;
    }
    adoptFromPlayer(car, info) {
      info = info || {};
      const v = this.spawn({ def: car.def, setup: car.setup, x: car.x, y: car.y, h: car.h, role: info.role, keep: info.keep, tag: info.tag });
      if (typeof info.hp === 'number') v.hp = Math.min(v.maxHp, Math.max(0, info.hp));
      return v;
    }
    nearestEnterable(x, y, r) {
      let best = null, bd = r;
      for (let i = 0; i < this.list.length; i++) {
        const v = this.list[i];
        if (v.mode === VM.WRECK) continue;
        const d = boxDist(v, x, y);
        if (d <= bd) { bd = d; best = v; }
      }
      return best;
    }
    toPhys() { return false; }
    toParked(v) { if (v) v.mode = VM.PARKED; }
    toWreck(v) { if (v) { v.mode = VM.WRECK; v.driver = false; v.burnT = -1; v._wt = 0; } }
    hold(v) { if (v) v.mode = VM.HELD; }
    physFree() { return 0; }
    laneBusy() { return false; }
    pullOver() {}
    draw(ctx, W) {
      const AS = DS.ActorSprites, M = W.M;
      for (let i = 0; i < this.list.length; i++) {
        const r = this.list[i];
        if (!r.vis) continue;
        if (AS && AS.drawVehicle) AS.drawVehicle(ctx, r);
        else { ctx.fillStyle = r.mode === VM.WRECK ? '#262626' : r.setup.color || '#888'; rectAt(ctx, M, r.x, r.y, r.h, r.p.len, r.p.wid); }
      }
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    }
    drawSignals() {}
    drawLights() {}
    drawGlow() {}
    counts() {
      const c = this._cnt;
      c.n = this.list.length; c.rail = 0; c.phys = 0; c.parked = 0; c.wreck = 0; c.held = 0; c.cops = 0;
      for (let i = 0; i < this.list.length; i++) { const m = this.list[i].mode; if (m === VM.WRECK) c.wreck++; else if (m === VM.HELD) c.held++; else c.parked++; }
      return c;
    }
  }

  // ======================================================================
  class World {
    constructor(game) {
      this.game = game;
      this.city = game.city;
      this.nav = null; this.traffic = null; this.peds = null; this.walker = null; this.police = null; this.missions = null;
      this.state = 'off'; this.onFoot = false; this.inCar = false;
      this.playerVeh = null;
      this.hud = {
        onFoot: true, inCar: false, money: 0, hp: 100, carHp: -1, stars: 0, starFlash: false, bust: 0, bounty: 0,
        obj: '', objSub: '', timer: -1, prompt: '', enterLabel: '', actLabel: '', zone: '', zoneT: 0, clock: '21:00', mission: false,
      };
      this.msgs = [];
      this.route = { pts: new Float32Array(512), n: 0, len: 0, ver: 0 };
      this.prof = { ai: 0, phys: 0, draw: 0 };
      this.Q = null; this.soft = false;
      this.t = 0; this.dt = 0; this.clock = 21;
      this.ow = null;
      this._built = false; this._loading = false; this._frozen = false;
      this._ownTag = { own: true };
      this._own = null;
      this._ent = null;               // binme işlemi
      this._autoExit = false;
      this._pBurnT = -1;              // oyuncu aracı yangını
      this._pSmk = 0; this._pFire = 0;
      this._fT = 0; this._fine = 0; this._sprayMoved = false; this._sprayArm = true; this._sprayCD = 0;
      this._homeIn = false;
      this._mx = 0; this._my = 0; this._run = false; this._mAct = false; this._mAng = 0; this._latch = 0;
      this._atkPrev = false; this._hornT = 0;
      this._stepK = 0;
      this._lvoice = null; this._lvT = -99;
      this._envKey = ''; this._zoneT = 0; this._zoneName = ''; this._hudT = 1; this._clockMin = -1;
      this._gpsT = 0; this._gx = 1e9; this._gy = 1e9; this._gHas = false; this.wp = null;
      this._ownT = 0; this._saveT = 0; this._chainT = 0;
      this._tmpPrompt = ''; this._tmpPromptT = 0;
      this._physAcc = 0; this._dAcc = 0;
      this._errs = {};
      // binme adayları
      this._candV = null; this._candP = null; this._pk = [];
      this._actKind = 0; this._actIdx = -1;
      // karalama
      this._f = { x: 0, y: 0, h: 0, vx: 0, vy: 0 };
      this._ep = { x: 0, y: 0, h: 0 };
      this._so = { x: 0, y: 0, d: 0, seg: -1, nA: -1, nB: -1, t: 0, edge: -1, lane: -1, s: 0, h: 0 };
      this._exq = [];
      this._lp = new Float32Array(3 * 64);
      this._smk = new Float32Array(256); this._fire = new Float32Array(256); this._byP = new Float32Array(256);
      this._clockStr = '21:00';
      const g = game, W = {
        world: this, game: g, city: g.city, nav: null, fx: g.fx, audio: g.audio,
        traffic: null, peds: null, walker: null, police: null, missions: null,
        Q: null, soft: false,
        t: 0, dt: 0, clock: 21, env: g.env, night: true,
        px: 0, py: 0, ph: 0, pvx: 0, pvy: 0, pspeed: 0,
        onFoot: true, inCar: false, car: null,
        drifting: false, hidden: false,
        cx: 0, cy: 0, viewR: 60, view: g.view, M: g.M, camRot: 0,
        obs: new Float32Array(5 * 24), nObs: 0,
        isVisible: null,
      };
      W.isVisible = (x, y, r) => {
        const v = W.view;
        r = r || 0;
        return x + r >= v.x0 && x - r <= v.x1 && y + r >= v.y0 && y - r <= v.y1;
      };
      this.W = W;
      this.debug = this._makeDebug();
    }

    static defaultSave() {
      return {
        v: 1, clock: 21, hp: 100,
        respect: { kulup: 0, sanayi: 0, merkez: 0 },
        missions: {},
        side: { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0 },
        stats: { stolen: 0, knocked: 0, takedowns: 0, maxStars: 0, bounty: 0, missions: 0, taxi: 0, busted: 0, wasted: 0, driftCash: 0 },
        tut: { foot: false, enter: false, phone: false, map: false },
      };
    }

    // alt sistem hatası: bir kez günlüğe yaz, oyun sürsün
    _err(k, e) {
      if (this._errs[k]) return;
      this._errs[k] = true;
      console.error('[dünya:' + k + ']', e);
    }
    _ui(name, a, b, c) {
      const WU = DS.WorldUI;
      if (WU && typeof WU[name] === 'function') { try { return WU[name](a, b, c); } catch (e) { this._err('ui.' + name, e); } }
      return undefined;
    }
    _au(name, a) {
      const au = this.game.audio;
      if (au && typeof au[name] === 'function') { try { au[name](a); } catch (e) { this._err('audio.' + name, e); } }
    }
    _crime(type, x, y, victim) {
      const p = this.police;
      if (!p) return;
      try { p.crime(type, x, y, victim === undefined ? null : victim); } catch (e) { this._err('police.crime', e); }
    }
    _mev(type, a, b) {
      const m = this.missions;
      if (!m || !m.onEvent) return;
      try { m.onEvent(type, a, b); } catch (e) { this._err('missions.onEvent', e); }
    }
    _panic(x, y, r, s) {
      const p = this.peds;
      if (p && p.panic) { try { p.panic(x, y, r, s); } catch (e) { this._err('peds.panic', e); } }
    }
    get places() { return this.nav ? this.nav.places : null; }

    // ================= YAŞAM DÖNGÜSÜ =================
    // nav yoksa "Şehir hazırlanıyor…" göster, kur, cb(); yükleme sürerken tekrarlar yok sayılır
    ensureNav(cb, fail) {
      if (this.nav) {
        if (!this._built) this._build();
        cb();
        return true;
      }
      if (this._loading) return false;
      if (!DS.Nav) { if (fail) fail(); return false; }
      this._loading = true;
      this._ui('loading', true, 'Şehir hazırlanıyor…');
      setTimeout(() => {
        let ok = false;
        try {
          this.nav = new DS.Nav(this.city);
          this._build();
          ok = true;
        } catch (e) {
          console.error(e);
          this.nav = null;
        }
        this._loading = false;
        this._ui('loading', false);
        if (ok) cb();
        else if (fail) fail();
      }, 30);
      return true;
    }
    get loading() { return this._loading; }

    // alt sistemler bir kez (nav kurulduktan sonra) oluşturulur
    _build() {
      const W = this.W;
      W.nav = this.nav;
      W.Q = this.Q || this.game.Q;
      const mk = (k, C) => {
        if (typeof C !== 'function') return null;
        try { return new C(W); } catch (e) { this._err('ctor.' + k, e); return null; }
      };
      W.traffic = mk('traffic', DS.Traffic) || new MiniTraffic(W);
      W.peds = mk('peds', DS.Peds);
      W.walker = mk('walker', DS.Walker) || new MiniWalker(W);
      W.police = mk('police', DS.Police);
      W.missions = mk('missions', DS.Missions);
      this.traffic = W.traffic; this.peds = W.peds; this.walker = W.walker; this.police = W.police; this.missions = W.missions;
      this._built = true;
      const AS = DS.ActorSprites;
      if (AS && AS.init) { try { AS.init(); } catch (e) { this._err('actors.init', e); } }
      this.setQuality(this.Q || this.game.Q);
    }

    // alt sistemleri sıfırla, save.ow yükle, güvenli evde yaya olarak başla, trafiği/yayaları doldur
    begin() {
      const g = this.game, s = g.save;
      if (!this._built) this._build();
      if (!s.ow || typeof s.ow !== 'object') s.ow = World.defaultSave();
      const ow = (this.ow = s.ow), d = World.defaultSave();
      for (const k of ['respect', 'side', 'stats', 'tut']) ow[k] = Object.assign({}, d[k], ow[k] && typeof ow[k] === 'object' ? ow[k] : {});
      if (!ow.missions || typeof ow.missions !== 'object') ow.missions = {};
      this.t = 0;
      this.clock = typeof ow.clock === 'number' && ow.clock >= 0 && ow.clock < 24 ? ow.clock : 21;
      this._frozen = false;
      this.msgs.length = 0;
      this.wp = null; this.route.n = 0; this.route.len = 0; this.route.ver++;
      this._ent = null; this._autoExit = false; this._pBurnT = -1; this._fT = 0; this._sprayArm = true; this._homeIn = true;
      this._ownT = 0; this._saveT = 0; this._chainT = 0; this._hudT = 1; this._zoneName = ''; this._gHas = false;
      this._lvoice = null; this._lvT = -99; this._atkPrev = false; this._mAct = false;
      this._smk.fill(0); this._fire.fill(0); this._byP.fill(0);
      this._exq.length = 0;
      this.city.restoreAllParked();
      // alt sistemler
      const tr = this.traffic, pd = this.peds, po = this.police, mi = this.missions;
      if (tr) { try { tr.reset(); } catch (e) { this._err('traffic.reset', e); } }
      if (pd) { try { pd.reset(); } catch (e) { this._err('peds.reset', e); } }
      if (po) { try { po.reset(); } catch (e) { this._err('police.reset', e); } }
      if (mi) {
        try { mi.reset(); } catch (e) { this._err('missions.reset', e); }
        try { if (mi.load) mi.load(ow); } catch (e) { this._err('missions.load', e); }
      }
      // yaya oyuncu güvenli evin önünde
      const P = this.places, sh = P.safehouse, sp = sh.walker || sh.spawn;
      const wk = this.walker;
      wk.reset(sp.x, sp.y, sp.h);
      wk.hp = U.clamp(typeof ow.hp === 'number' ? ow.hp : 100, 1, 100);
      wk.state = 'walk';
      // oyuncu aracı nesnesi yayayken kullanılmaz: kendi araç tanımında beklesin
      const car = g.car;
      car.setDef(DS.carById(s.car), g.carSetup(s.car));
      car.reset(sp.x, sp.y, sp.h);
      this.playerVeh = null;
      this._setFlags(false);
      this.state = 'foot';
      // kamera yayaya
      this._snapCamera(sp.x, sp.y, true);
      this.applyEnv(true);
      this._refreshW(0);
      this._spawnOwn();
      if (tr) { try { tr.fill(); } catch (e) { this._err('traffic.fill', e); } }
      // giriş ve görünüm
      const I = g.input;
      I.world = true;
      if (I.setContext) I.setContext('foot');
      const b = document.body.classList;
      b.add('world'); b.add('onfoot');
      this._au('setEngineVol', 0); this._au('setSiren', 0);
      this._hudTick(0);
      if (!ow.tut.foot) {
        ow.tut.foot = true;
        const touch = b.contains('touch');
        this.msg('AÇIK ŞEHİR', 'big', touch ? 'Sol taraf: yürü · BİN: araca bin' : 'WASD yürü · Shift koş · F araca bin · M harita');
      }
      this._refreshRoute(true);
    }

    // her şeyi temizle, park araçlarını geri koy, kaydet; serbest sürüş/tandem eskisi gibi
    end() {
      if (this.state === 'off') return;
      const g = this.game, s = g.save;
      this.saveOw();
      const tr = this.traffic, pd = this.peds, po = this.police, mi = this.missions;
      if (mi) { try { mi.reset(); } catch (e) { this._err('missions.reset', e); } }
      if (po) { try { po.reset(); } catch (e) { this._err('police.reset', e); } }
      if (tr) { try { tr.reset(); } catch (e) { this._err('traffic.reset', e); } }
      if (pd) { try { pd.reset(); } catch (e) { this._err('peds.reset', e); } }
      this.state = 'off';
      this._setFlags(false);
      this.onFoot = false;
      this.playerVeh = null; this._own = null; this._ent = null; this.wp = null; this.route.n = 0;
      // oyuncu aracı tekrar garaj aracı (yoksa serbest sürüş son çalınan araçla sürülür)
      const def = DS.carById(s.car);
      g.car.setDef(def, g.carSetup(s.car));
      g.car.vx = g.car.vy = g.car.w = 0;
      const au = g.audio;
      if (au) {
        this._au('setEngineVol', 1); this._au('setSiren', 0); this._au('horn', false); this._au('setLeaderVoice', null);
        if (au.setVoice) au.setVoice(def.voice);
      }
      g.applySettings();      // env ayarlardan (toMenu önce mode = 'free' yapar)
      const I = g.input;
      I.world = false;
      if (I.setContext) I.setContext('drive');
      const b = document.body.classList;
      for (const c of ['world', 'onfoot', 'mission', 'near-car', 'can-act']) b.remove(c);
      this.city.restoreAllParked();
      g.score.reset();
      this.msgs.length = 0;
      g.persist();
    }

    setQuality(Q) {
      if (!Q) return;
      this.Q = Q;
      const isSoft = DS.Quality && DS.Quality.isSoft;
      this.soft = isSoft ? !!DS.Quality.isSoft() : false;
      this.W.Q = Q; this.W.soft = this.soft;
      if (!this._built) return;
      const sys = [this.traffic, this.peds, this.police, this.missions];
      for (let i = 0; i < sys.length; i++) {
        const o = sys[i];
        if (o && typeof o.setQuality === 'function') { try { o.setQuality(Q); } catch (e) { this._err('setQuality' + i, e); } }
      }
      const AS = DS.ActorSprites;
      if (AS && AS.setQuality) { try { AS.setQuality(Q, this.soft); } catch (e) { this._err('actors.setQuality', e); } }
    }

    // gün/gece ortamı -> game.env (ayar sabitse ENV[wtime]); oyun dakikası değişmedikçe yeniden kurulmaz
    applyEnv(force) {
      const g = this.game, s = g.save.settings, ENV = DS.ENV || ENV0;
      const wt = s.wtime === 'day' || s.wtime === 'sunset' || s.wtime === 'night' ? s.wtime : 'cycle';
      const rain = s.weather === 'rain';
      const key = (wt === 'cycle' ? 'c' + Math.floor(this.clock * 60) : wt) + (rain ? 'r' : '') + (g.Q ? g.Q.tier : '');
      if (!force && key === this._envKey) return;
      this._envKey = key;
      const e = wt === 'cycle' ? envAt(this.clock, ENV) : Object.assign({}, ENV[wt]);
      e.rain = rain;
      if (rain) {
        e.sun = null;
        if (!e.light) Object.assign(e, { light: true, ambient: 'rgb(152,162,184)', bldAmb: 'rgb(122,130,150)', lamps: true, lampA: 0.4, headA: 0.5, windows: true, bloom: 0.04 });
      }
      g.env = e;
      g.tuneEnv();
      g._frozenDone = false;
      this.W.env = e; this.W.night = !!e.light;
    }

    // ================= ODAK / BAĞLAM =================
    focus() {
      const f = this._f, g = this.game;
      if (this.inCar) { const c = g.car; f.x = c.x; f.y = c.y; f.h = c.h; f.vx = c.vx; f.vy = c.vy; }
      else { const w = this.walker; f.x = w.x; f.y = w.y; f.h = w.h; f.vx = w.vx; f.vy = w.vy; }
      return f;
    }
    _setFlags(inCar) {
      this.inCar = inCar; this.onFoot = !inCar;
      this.W.inCar = inCar; this.W.onFoot = !inCar;
    }
    _snapCamera(x, y, onFoot) {
      const g = this.game, cam = g.cam, s = g.save.settings;
      cam.x = x; cam.y = y; cam.rot = 0; cam.vAng = 0; cam.shake = 0;
      const zBase = U.clamp(Math.min(g.cssW || 1280, g.cssH || 720) / 40, 9.5, 18) * (s.zoom || 1);
      if (onFoot) { cam.zoomCss = zBase * 1.35; cam.zoom = cam.zoomCss * (g.dpr || 1); }
      this._viewRect();
    }
    // render() ile aynı görünüm karesi (dünya güncellemesi çizimden önce koşar)
    _viewRect() {
      const g = this.game, cam = g.cam, v = g.view;
      const z = cam.zoom > 0 ? cam.zoom : 10;
      const hd = Math.hypot(g.canvas.width, g.canvas.height) / 2 / z + 2;
      v.x0 = cam.x - hd; v.y0 = cam.y - hd; v.x1 = cam.x + hd; v.y1 = cam.y + hd;
    }
    _refreshW(dt) {
      const g = this.game, W = this.W, cam = g.cam;
      W.t = this.t; W.dt = dt; W.clock = this.clock; W.env = g.env; W.night = !!g.env.light; W.Q = this.Q || g.Q;
      const f = this.focus();
      W.px = f.x; W.py = f.y; W.ph = f.h; W.pvx = f.vx; W.pvy = f.vy; W.pspeed = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
      W.inCar = this.inCar; W.onFoot = !this.inCar; W.car = this.inCar ? g.car : null;
      W.drifting = this.inCar && !!g.score.active;
      W.hidden = this.nav ? this.nav.hideZone(f.x, f.y) : false;
      W.cx = cam.x; W.cy = cam.y;
      W.viewR = Math.hypot(g.canvas.width, g.canvas.height) / 2 / (cam.zoom > 0 ? cam.zoom : 10);
      W.view = g.view; W.M = g.M; W.camRot = cam.rot;
      W.walker = this.walker;
    }

    // ================= GİRİŞ (main.updateWorld adım 1) =================
    preUpdate(dt, inp) {
      if (this.state === 'off') return;
      const g = this.game, I = g.input;
      this.dt = dt;
      const eEnter = I.edge('enter'), eAct = I.edge('act'), eMap = I.edge('map');
      const atk = !!inp.attack && !this._atkPrev;
      this._atkPrev = !!inp.attack;
      if (eMap) { this.openMap(); return; }
      const st = this.state;
      // yaya hareketi: ekran yönlü -> dünya (kamera dönüşü hareket başlarken / 45°'den fazla dönünce kilitlenir)
      const m2 = inp.mx * inp.mx + inp.my * inp.my;
      if (m2 > 0.0025 && (st === 'foot' || st === 'exit')) {
        const a = Math.atan2(inp.my, inp.mx);
        if (!this._mAct || Math.abs(U.wrap(a - this._mAng)) > PI / 4) { this._latch = g.cam.rot; this._mAng = a; }
        this._mAct = true;
        const c = Math.cos(this._latch), s = Math.sin(this._latch);
        this._mx = inp.mx * c + inp.my * s; this._my = -inp.mx * s + inp.my * c;
        this._run = !!inp.run;
      } else { this._mAct = false; this._mx = 0; this._my = 0; this._run = false; }
      if (st === 'foot') {
        if (eEnter) this._tryEnter();
        else if (eAct) this._act();
        else if (atk) this._punch();
      } else if (st === 'car') {
        const car = g.car, pv = this.playerVeh;
        if (eEnter) this._tryExit();
        else if (eAct) this._act();
        if (pv && pv.hp < 0.35 * pv.maxHp) inp.throttle *= 0.85;
        if (this._autoExit) {
          inp.throttle = 0; inp.brake = 1; inp.handbrake = car.speed < 3; inp.steer = 0;
          if (car.speed < 1) { this._autoExit = false; this._doExit(false); }
        }
      }
      // kilitli durumlar: araç durur (el freni debriyajı basar: geri vites sürüşü yok)
      if (this.inCar && (this.state === 'busted' || this.state === 'wasted' || this.state === 'spray')) {
        inp.throttle = 0; inp.brake = 1; inp.handbrake = true; inp.steer = 0; inp.kick = false;
      }
      this._hornIn = this.inCar && this.state === 'car' && !!inp.horn;
    }
    get lockInput() { return this.inCar && (this.state === 'busted' || this.state === 'wasted' || this.state === 'spray' || this._autoExit); }

    // NPC fiziği (120 Hz)
    stepPhys(dt) {
      if (this.state === 'off' || this._frozen || !this.traffic) return;
      const t0 = now();
      try { this.traffic.stepPhys(dt, this.inCar ? this.game.car : null); } catch (e) { this._err('traffic.stepPhys', e); }
      this._physAcc += now() - t0;
    }

    // ================= KARE GÜNCELLEMESİ (§2.7) =================
    update(dt) {
      if (this.state === 'off') return;
      const t0 = now(), g = this.game, W = this.W;
      if (!(dt > 0)) dt = 0;
      this.t += dt; this.dt = dt;
      // a. saat + ortam
      if (!this._frozen) { this.clock += dt / 60; if (this.clock >= 24) this.clock -= 24; }
      this.applyEnv(false);
      // c. oyuncu
      this._updPlayer(dt);
      // b. bağlam
      this._refreshW(dt);
      // d. engeller: önce oyuncu, sonra yoldaki yayalar
      const ob = W.obs;
      if (this.inCar) { const c = g.car; ob[0] = c.x; ob[1] = c.y; ob[2] = c.vx; ob[3] = c.vy; ob[4] = 1.2; }
      else { const w = this.walker; ob[0] = w.x; ob[1] = w.y; ob[2] = w.vx; ob[3] = w.vy; ob[4] = 0.4; }
      W.nObs = 1;
      if (this.peds && this.peds.roadObstacles) { try { W.nObs = 1 + (this.peds.roadObstacles(ob, 1, 23) | 0); } catch (e) { this._err('peds.roadObstacles', e); } }
      // e–h. alt sistemler
      if (!this._frozen) {
        if (this.traffic) { try { this.traffic.update(dt, W); } catch (e) { this._err('traffic.update', e); } }
        if (this.peds) { try { this.peds.update(dt, W); } catch (e) { this._err('peds.update', e); } }
        if (this.police) { try { this.police.update(dt, W); } catch (e) { this._err('police.update', e); } }
        if (this.missions) { try { this.missions.update(dt, W); } catch (e) { this._err('missions.update', e); } }
      }
      // i. yaya çarpmaları  j. oyuncu yayaya çarpan araçlar
      this._pedHits(dt);
      if (!this.inCar && this.state !== 'wasted' && this.walker.hitByVehicles) {
        let v = null;
        try { v = this.walker.hitByVehicles(W); } catch (e) { this._err('walker.hit', e); }
        if (v) {
          const w = this.walker;
          if (g.fx.knock) g.fx.knock(w.x, w.y, PANTS_PLAYER);
          this._au('impact', 2.5);
          g.cam.shake = Math.min(1.2, g.cam.shake + 0.4);
        }
      }
      // k. hasar dumanı/yangın + patlamalar
      this._damageFx(dt);
      // bayılma
      if (this.walker.hp <= 0 && this.state !== 'wasted' && this.state !== 'busted') this._beginWasted();
      // l. GPS
      this._gpsT -= dt;
      this._refreshRoute(false);
      // m. HUD (Q.textHz)
      const hz = (this.Q && this.Q.textHz) || 15;
      this._hudT += dt;
      if (this._hudT >= 1 / hz) { const step = this._hudT; this._hudT = 0; this._hudTick(step); }
      // n. otomatik kayıt, kendi araç
      this._saveT += dt;
      if (this._saveT >= AUTOSAVE_T) { this._saveT = 0; if (g.dirty || this._owDirty) this.autosave(false); }
      this._ownT -= dt;
      if (this._ownT <= 0) { this._ownT = 1; this._checkOwn(); }
      if (this._chainT > 0) this._chainT -= dt;
      // ölçüm
      const ai = now() - t0;
      this.prof.ai = this.prof.ai * 0.9 + ai * 0.1;
      this.prof.phys = this.prof.phys * 0.9 + this._physAcc * 0.1;
      this._physAcc = 0;
    }

    _updPlayer(dt) {
      const g = this.game, wk = this.walker, st = this.state;
      if (this._tmpPromptT > 0) this._tmpPromptT -= dt;
      if (this._sprayCD > 0) this._sprayCD -= dt;
      if (!this.inCar) {
        const free = st === 'foot' || st === 'exit';
        const mx = free ? this._mx : 0, my = free ? this._my : 0;
        try { wk.update(dt, mx, my, free && this._run, this.W); } catch (e) { this._err('walker.update', e); }
        if (st === 'wasted' && wk.state === 'walk') { wk.state = 'down'; wk.t = 0.3; }
        if (st === 'exit' && wk.t >= EXIT_T) { wk.state = 'walk'; wk.t = 0; this.state = 'foot'; }
        if (st === 'enter') this._updEnter(dt);
        // ayak sesi: adım döngüsünün yarısında bir
        if (this.state === 'foot' && wk.speed > 0.3) {
          const k = Math.floor(wk.phase * 2);
          if (k !== this._stepK) { this._stepK = k; this._au('step', !!wk.run); }
        }
        if (this.state === 'foot') this._triggersFoot();
      } else {
        const car = g.car;
        if (wk.regen) wk.regen(dt);
        wk.x = car.x; wk.y = car.y; wk.h = car.h;
        // yanma süresi
        if (this._pBurnT >= 0 && this.state !== 'wasted') {
          this._pBurnT += dt;
          if (this._pBurnT >= BURN_T) { this._explodePlayer(); return; }
        }
        if (this.state === 'car') this._triggersCar(dt);
        // korna: yayalar ürker
        if (this._hornIn) {
          this._hornT -= dt;
          if (this._hornT <= 0) { this._hornT = 0.5; this._panic(car.x, car.y, 6, 0.2); }
        } else this._hornT = 0;
      }
      // zamanlı akışlar
      if (st === 'busted') { this._fT += dt; if (this._fT >= BUSTED_T) this._finishBusted(); }
      else if (st === 'wasted') { this._fT += dt; if (this._fT >= WASTED_T) this._finishWasted(); }
      else if (st === 'spray') {
        this._fT += dt;
        if (this._fT >= SPRAY_T * 0.5 && !this._sprayMoved) this._sprayMid();
        if (this._fT >= SPRAY_T) this._sprayEnd();
      }
    }

    // ================= BİNME / İNME =================
    // en yakın binilebilir: trafik kaydı ya da otopark aracı (this._candV / this._candP)
    _findEnterable(x, y, R) {
      this._candV = null; this._candP = null;
      let bd = R + 1e-6;
      const tr = this.traffic;
      if (tr && tr.nearestEnterable) {
        let v = null;
        try { v = tr.nearestEnterable(x, y, R); } catch (e) { this._err('traffic.nearestEnterable', e); }
        if (v && v.alive && v.mode !== VM.WRECK) { this._candV = v; bd = boxDist(v, x, y); }
      }
      const city = this.city;
      if (city.parkedNear) {
        const n = city.parkedNear(x, y, R, this._pk);
        for (let i = 0; i < n; i++) {
          const p = this._pk[i], b = p.box;
          const d = b ? U.distPointBox(x, y, b.x0, b.y0, b.x1, b.y1) : Math.hypot(x - p.x, y - p.y) - 1;
          if (d < bd) { bd = d; this._candP = p; this._candV = null; }
        }
        this._pk.length = 0;
      }
      return this._candV !== null || this._candP !== null;
    }
    _vehSpeed(v) { return v.mode === VM.RAIL ? v.v : v.speed; }
    _door(v, out) {
      const c = Math.cos(v.h), s = Math.sin(v.h), L = v.p ? v.p.len : 4.5, Wd = v.p ? v.p.wid : 1.8;
      out.x = v.x + c * 0.1 * L + s * (Wd / 2 + 0.45);
      out.y = v.y + s * 0.1 * L - c * (Wd / 2 + 0.45);
      out.h = v.h + PI / 2;
      return out;
    }
    _tryEnter() {
      const wk = this.walker;
      if (wk.state !== 'walk' && wk.state !== 'punch') return;
      if (!this._findEnterable(wk.x, wk.y, ENTER_R)) return;
      const v = this._candV, p = this._candP;
      const e = { veh: v, prop: p, idx: v ? v.idx : -1, tag: v ? v.tag : null, t: 0, dur: ENTER_T, jack: false, popped: false,
        sx: wk.x, sy: wk.y, dx: 0, dy: 0, vx0: 0, vy0: 0, burn: -1 };
      if (v) {
        if (this._vehSpeed(v) > ENTER_V) { this._prompt('Araç çok hızlı', 1.2); return; }
        e.jack = v.driver === true;
        if (e.jack) {
          e.dur = ENTER_T + JACK_T;
          if (this.traffic.hold) { try { this.traffic.hold(v); } catch (er) { this._err('traffic.hold', er); } }
        }
        e.vx0 = v.x; e.vy0 = v.y;
        const d = this._door(v, this._ep);
        e.dx = d.x; e.dy = d.y;
      } else {
        const L = 4.4, c = Math.cos(p.ang), s = Math.sin(p.ang);
        e.dx = p.x + s * 1.35 + c * 0.1 * L; e.dy = p.y - c * 1.35 + s * 0.1 * L;
        e.vx0 = p.x; e.vy0 = p.y;
      }
      this._ent = e;
      wk.state = 'enter'; wk.t = 0; wk.anim = 0;
      this.state = 'enter';
      this._au('door');
    }
    _updEnter(dt) {
      const e = this._ent, wk = this.walker;
      if (!e) { this.state = 'foot'; wk.state = 'walk'; return; }
      e.t += dt;
      // geçerlilik: kayıt yuvası değişmedi, araç uzaklaşmadı
      if (e.veh) {
        const v = e.veh;
        if (!v.alive || v.idx !== e.idx || v.tag !== e.tag || v.mode === VM.WRECK || Math.hypot(v.x - e.vx0, v.y - e.vy0) > 3) { this._cancelEnter(); return; }
      } else if (e.prop.gone) { this._cancelEnter(); return; }
      // kapıya yürü (ilk 0.25 s), sonra binme pozu
      const k = Math.min(1, e.t / 0.25);
      wk.x = U.lerp(e.sx, e.dx, k); wk.y = U.lerp(e.sy, e.dy, k);
      wk.h = Math.atan2(e.vy0 - wk.y, e.vx0 - wk.x);
      const g0 = e.jack ? JACK_T : 0;
      wk.anim = U.sat((e.t - g0) / ENTER_T);
      if (e.jack && !e.popped && e.t >= JACK_T) { e.popped = true; this._popDriver(e.veh, true); }
      if (e.t >= e.dur) this._finishEnter();
    }
    _cancelEnter() {
      const e = this._ent, wk = this.walker;
      this._ent = null;
      if (e && e.veh && e.veh.alive && e.veh.mode === VM.HELD && this.traffic.toParked) {
        try { this.traffic.toParked(e.veh); } catch (er) { this._err('traffic.toParked', er); }
      }
      if (wk.state === 'enter') { wk.state = 'walk'; wk.t = 0; wk.anim = -1; }
      if (this.state === 'enter') this.state = 'foot';
    }
    // gasp: sürücü kapıdan çıkıp kaçar (çizgi film), CARJACK suçu
    _popDriver(v, crime) {
      if (!v) return;
      const pd = this.peds;
      const d = this._door(v, this._ep);
      const c = Math.cos(v.h), s = Math.sin(v.h);
      if (pd && pd.spawnAt) {
        const pal = v.role === 'cop' ? 1 : -1;
        const o = { role: PR.DRIVER, st: PS.FLEE, h: v.h - PI / 2, mx: v.x, my: v.y };
        if (pal >= 0) o.pal = pal;
        try { pd.spawnAt(d.x + c * 1.0 + s * 0.5, d.y + s * 1.0 - c * 0.5, o); } catch (e) { this._err('peds.spawnAt', e); }
      }
      v.driver = false;
      if (crime) {
        this._crime('CARJACK', v.x, v.y);
        this._panic(v.x, v.y, 12, 0.6);
      }
    }
    _finishEnter() {
      const e = this._ent;
      this._ent = null;
      let info = null, lot = false;
      if (e.prop) {
        const p = e.prop;
        if (p.gone) { this._cancelEnter(); return; }
        const ps = DS.CarRender.parkSetup(p.v);
        const def = ps.def, mh = defHp(def);
        info = { def, setup: Object.assign({}, LOT_BASE, ps.setup, { upg: {} }), x: p.x, y: p.y, h: p.ang, vx: 0, vy: 0, w: 0, hp: mh, maxHp: mh, role: 'civ', tag: null, driver: false };
        this.city.takeParked(p);
        lot = true;
      } else {
        const v = e.veh;
        if (!v || !v.alive) { this._cancelEnter(); return; }
        if (e.jack && !e.popped) this._popDriver(v, true);
        e.burn = v.burnT;
        try { info = this.traffic.takeForPlayer(v); } catch (er) { this._err('traffic.takeForPlayer', er); info = null; }
        if (!info) { this._cancelEnter(); return; }
      }
      this._enterCar(info, { jack: e.jack, lot, burn: e.burn });
    }
    // oyuncu araca geçer (animasyonsuz çekirdek)
    _enterCar(info, o) {
      const g = this.game, car = g.car, s = g.save;
      o = o || {};
      const own = info.role === 'player' || info.tag === this._ownTag;
      const def = info.def;
      const setup = own ? g.carSetup(def.id) : Object.assign({}, LOT_BASE, info.setup, { upg: {} });
      car.setDef(def, setup);
      car.reset(info.x, info.y, info.h);
      car.vx = info.vx || 0; car.vy = info.vy || 0; car.w = info.w || 0;
      car.speed = Math.hypot(car.vx, car.vy);
      const mh = info.maxHp || defHp(def);
      this.playerVeh = {
        def, setup, role: own ? 'player' : info.role || 'civ', tag: own ? this._ownTag : info.tag !== undefined ? info.tag : null,
        hp: typeof info.hp === 'number' ? Math.min(mh, info.hp) : mh, maxHp: mh, own, stolen: !own,
      };
      if (own) this._own = null;
      this._pBurnT = typeof o.burn === 'number' && o.burn >= 0 ? o.burn : -1;
      if (this._pBurnT < 0 && this.playerVeh.hp < 0.15 * mh) this._pBurnT = 0;
      this._pSmk = 0; this._pFire = 0;
      g.carFX = g.fxState();
      const wk = this.walker;
      wk.state = 'hidden'; wk.t = 0; wk.anim = -1; wk.x = car.x; wk.y = car.y;
      this.state = 'car';
      this._setFlags(true);
      this._autoExit = false;
      this._sprayArm = true; this._homeIn = true;
      g.score.reset();
      const I = g.input;
      if (I.setContext) I.setContext('drive');
      document.body.classList.remove('onfoot');
      if (g.audio && g.audio.setVoice) { try { g.audio.setVoice(def.voice); } catch (er) { this._err('audio.setVoice', er); } }
      this._au('setEngineVol', 1);
      this._au('door');
      // suçlar ve istatistik
      if (!own) {
        const cls = def.cls || 'sport';
        const mission = info.role === 'mission';
        if (cls === 'cop') this._crime('STEAL_COP_CAR', car.x, car.y);
        else if (!o.jack && !mission) this._crime('STEAL_PARKED', car.x, car.y);
        if (!mission) { this.ow.stats.stolen++; this._owDirty = true; }
      }
      if (this._pBurnT >= 0) this.msg('ARAÇ YANIYOR! İN!', 'big');
      this._mev('enter', this.playerVeh);
      if (s.ow && s.ow.tut && !s.ow.tut.enter && !own) this._prompt('F — İn', 3);
    }
    _tryExit() {
      if (this.state !== 'car') return;
      if (this.game.car.speed > EXIT_V) { this._autoExit = true; return; }
      this._doExit(false);
    }
    // inme noktası: sol kapı, sağ kapı, ön, arka; olmazsa 1 m'lik sarmal (6 m); çarpışıcı içine asla
    _exitPoint(car) {
      const city = this.city, nav = this.nav, out = this._ep;
      const c = Math.cos(car.h), s = Math.sin(car.h), L = car.p.len, Wd = car.p.wid;
      const bx = car.x + c * 0.1 * L, by = car.y + s * 0.1 * L, off = Wd / 2 + 0.6;
      const ok = (x, y) => x > city.x0 + 0.5 && x < city.x1 - 0.5 && y > city.y0 + 0.5 && y < city.y1 - 0.5 &&
        !city.blocked(x, y, 0.4) && !this._vehAt(x, y, 0.45);
      const cand = [
        bx + s * off, by - c * off, car.h - PI / 2,
        bx - s * off, by + c * off, car.h + PI / 2,
        car.x + c * (L / 2 + 0.8), car.y + s * (L / 2 + 0.8), car.h,
        car.x - c * (L / 2 + 0.8), car.y - s * (L / 2 + 0.8), car.h + PI,
      ];
      for (let k = 0; k < 4; k++) {
        if (ok(cand[k * 3], cand[k * 3 + 1])) { out.x = cand[k * 3]; out.y = cand[k * 3 + 1]; out.h = cand[k * 3 + 2]; return out; }
      }
      const r0 = Math.max(L, Wd) / 2;
      for (let r = 1; r <= 6; r++) {
        const R = r0 + r, n = Math.max(8, Math.round(TAU * R));
        for (let k = 0; k < n; k++) {
          const a = car.h + (k / n) * TAU, x = car.x + Math.cos(a) * R, y = car.y + Math.sin(a) * R;
          if ((!nav || nav.walkable(x, y)) && ok(x, y)) { out.x = x; out.y = y; out.h = a; return out; }
        }
      }
      return null;
    }
    _vehAt(x, y, r) {
      const tr = this.traffic;
      if (!tr || !tr.list) return false;
      const L = tr.list;
      for (let i = 0; i < L.length; i++) {
        const v = L[i];
        if (!v.alive) continue;
        const dx = v.x - x, dy = v.y - y, rr = 4 + r;
        if (dx * dx + dy * dy > rr * rr) continue;
        if (boxDist(v, x, y) < r) return true;
      }
      return false;
    }
    // aracı bırak (park kaydı), yaya ol. instant: animasyonsuz
    _doExit(instant) {
      const g = this.game, car = g.car, pv = this.playerVeh;
      const pt = this._exitPoint(car);
      if (!pt) { this._autoExit = false; this._prompt('Çıkış yok — R ile yola dön', 2.5); return false; }
      const px = pt.x, py = pt.y, ph = pt.h;
      const veh = this._leaveCar();
      if (veh && this._pBurnT >= 0) veh.burnT = this._pBurnT;
      car.vx = car.vy = car.w = 0;
      const wk = this.walker;
      wk.reset(px, py, ph);
      this._toFoot();
      if (!instant) { wk.state = 'exit'; wk.t = 0; this.state = 'exit'; }
      this._mev('exit', pv);
      if (this.ow && this.ow.tut) this.ow.tut.enter = true;
      return true;
    }
    // oyuncu aracını trafik kaydına çevir (kendi araç: rol 'player'; çalınan polis aracı etiketsiz)
    _leaveCar() {
      const pv = this.playerVeh, car = this.game.car, tr = this.traffic;
      if (!pv || !tr) return null;
      const tag = pv.own ? this._ownTag : pv.tag && pv.tag.police ? null : pv.tag;
      let veh = null;
      try {
        veh = tr.adoptFromPlayer(car, { role: pv.own ? 'player' : pv.role === 'player' ? 'civ' : pv.role, tag, hp: pv.hp, keep: pv.own || !!tag });
      } catch (e) { this._err('traffic.adoptFromPlayer', e); }
      if (veh && pv.own) this._own = veh;
      return veh;
    }
    _toFoot() {
      const g = this.game;
      this.playerVeh = null;
      this._pBurnT = -1; this._autoExit = false;
      this.state = 'foot';
      this._setFlags(false);
      g.score.reset();
      const I = g.input;
      if (I.setContext) I.setContext('foot');
      document.body.classList.add('onfoot');
      this._au('setEngineVol', 0); this._au('horn', false); this._au('door');
      this._mAct = false; this._atkPrev = true;
    }

    // ================= ETKİLEŞİM =================
    // bağlam: this._actKind 1 telefon, 2 garaj, 3 yan etkinlik, 4 taksi (+ _actIdx)
    _context() {
      const m = this.missions, g = this.game;
      let k = 0, idx = -1;
      if (this.state === 'foot') {
        const wk = this.walker;
        if (m && m.phoneAt) { try { idx = m.phoneAt(wk.x, wk.y, 2.2); } catch (e) { this._err('missions.phoneAt', e); idx = -1; } }
        else idx = this._phoneNear(wk.x, wk.y);
        if (idx >= 0) k = 1;
        else if (this._inHome(wk.x, wk.y)) k = 2;
      } else if (this.state === 'car') {
        const car = g.car, pv = this.playerVeh;
        if (pv && pv.own && this._inHome(car.x, car.y)) k = 2;
        else if (m && car.speed < 10) {
          if (m.markerAt) { try { idx = m.markerAt(car.x, car.y, 6, true); } catch (e) { this._err('missions.markerAt', e); idx = -1; } }
          if (idx >= 0) k = 3;
          else if (m.canTaxi) { let ok = false; try { ok = m.canTaxi(this.W); } catch (e) { this._err('missions.canTaxi', e); } if (ok) k = 4; }
        }
      }
      this._actKind = k; this._actIdx = idx;
      return k;
    }
    _phoneNear(x, y) {
      const P = this.places;
      if (!P || !P.phones) return -1;
      for (let i = 0; i < P.phones.length; i++) {
        const p = P.phones[i];
        const sx = typeof p.sx === 'number' ? p.sx : p.x, sy = typeof p.sy === 'number' ? p.sy : p.y;
        if (Math.hypot(x - sx, y - sy) < 2.2 || Math.hypot(x - p.x, y - p.y) < 2.2) return i;
      }
      return -1;
    }
    _inHome(x, y) {
      const P = this.places, T = P && P.safehouse && P.safehouse.trigger;
      return !!T && x >= T.x0 && x <= T.x1 && y >= T.y0 && y <= T.y1;
    }
    _act() {
      const k = this._context(), m = this.missions;
      if (k === 1) this._openPhone(this._actIdx);
      else if (k === 2) this._openGarage();
      else if (k === 3) {
        const S = DS.SIDE, d = S && S[this._actIdx];
        const id = 'side:' + (d && d.id ? d.id : this._actIdx);
        let ok = false;
        try { ok = !!m.start(id); } catch (e) { this._err('missions.start', e); }
        if (!ok) this._prompt('Bu iş şu an başlatılamıyor', 1.6);
      } else if (k === 4) {
        let ok = false;
        try { ok = !!m.start('taxi'); } catch (e) { this._err('missions.start', e); }
        if (!ok) this._prompt('Bu iş şu an başlatılamıyor', 1.6);
      }
    }
    _openPhone(idx) {
      const m = this.missions;
      let data = null;
      if (m && m.phoneList) { try { data = m.phoneList(idx); } catch (e) { this._err('missions.phoneList', e); } }
      if (!data) data = { phone: idx, crew: { id: '', name: 'ANKESÖRLÜ TELEFON', col: '#38d9ff', respect: 0 }, items: [] };
      if (this.ow) this.ow.tut.phone = true;
      const au = this.game.audio;
      if (au && au.beep) { try { au.beep(660, 0.06, 0.05); } catch (e) { this._err('audio.beep', e); } }
      if (DS.WorldUI && DS.WorldUI.openPhone) this._ui('openPhone', data);
    }
    _openGarage() {
      if (!this.canGarage()) {
        const st = this.police ? this.police.stars : 0;
        this._prompt(st > 0 ? 'Önce polisi atlat' : 'Görev sürerken garaj kapalı', 1.8);
        return;
      }
      const g = this.game;
      this.autosave(true);
      if (!this.inCar) g.car.setDef(DS.carById(g.save.car), g.carSetup(g.save.car));
      if (DS.UI) { DS.UI.prev = 'world'; DS.UI.show('garage'); }
    }
    _punch() {
      const wk = this.walker;
      if (!wk.punch) return;
      try { wk.punch(this.W); } catch (e) { this._err('walker.punch', e); }
    }

    // ================= TETİKLEYİCİLER =================
    _triggersFoot() {
      const wk = this.walker, inH = this._inHome(wk.x, wk.y);
      if (inH && !this._homeIn) this._arriveHome();
      this._homeIn = inH;
    }
    _arriveHome() {
      this.autosave(true);
      this.msg('GÜVENLİ EV', 'mis', 'KAYDEDİLDİ');
    }
    _triggersCar(dt) {
      const g = this.game, car = g.car, pv = this.playerVeh, P = this.places;
      if (!P || !pv) return;
      // güvenli ev (kendi araçla)
      const inH = pv.own && this._inHome(car.x, car.y);
      if (inH && !this._homeIn) this._arriveHome();
      this._homeIn = inH;
      // boyahane
      const T = P.spray && P.spray.trigger;
      if (T) {
        const inside = car.x >= T.x0 && car.x <= T.x1 && car.y >= T.y0 && car.y <= T.y1;
        if (!inside) this._sprayArm = true;
        else if (this._sprayArm && car.speed < 12) { this._sprayArm = false; this._tryRespray(); }
      }
      // hurda vinci (çalma siparişi)
      const cr = P.crane, m = this.missions;
      if (cr && m && car.speed < 3 && Math.hypot(car.x - cr.x, car.y - cr.y) < (cr.r || 7) && this._craneTarget()) this._craneDrop();
    }
    _missionId() {
      const m = this.missions;
      if (!m || m.state !== 'run' || !m.active) return null;
      const a = m.active;
      return a.id || (a.def && a.def.id) || null;
    }
    _craneTarget() {
      const m = this.missions, pv = this.playerVeh;
      if (!m || !pv) return false;
      if (typeof m.craneTarget === 'function') { try { return !!m.craneTarget(pv); } catch (e) { this._err('missions.craneTarget', e); return false; } }
      const id = this._missionId();
      if (!id) return false;
      const a = this.missions.active, type = a.def && a.def.type ? a.def.type : a.type;
      if (type && type !== 'steal') return false;
      if (pv.tag && pv.tag.mission === id) return true;
      return id === 'm2' && pv.def && pv.def.cls === 'taxi';
    }
    // araç vince yüklenir: oyuncu yanında yaya kalır, araç kaydı oluşmaz
    _craneDrop() {
      const g = this.game, car = g.car, pv = this.playerVeh;
      const info = Object.assign({}, pv);
      const pt = this._exitPoint(car);
      const x = pt ? pt.x : car.x, y = pt ? pt.y : car.y, h = pt ? pt.h : car.h;
      car.vx = car.vy = car.w = 0;
      this.walker.reset(x, y, h);
      this._toFoot();
      this._mev('crane', info);
    }

    // ---------- boyahane ----------
    _tryRespray() {
      const g = this.game, pv = this.playerVeh, po = this.police;
      const stars = po ? po.stars : 0;
      if (po && po.seen && stars > 0) { this.msg('Polis görüyor, boyahane kapıyı açmıyor!', 'cop'); return; }
      const undamaged = pv.hp >= pv.maxHp - 0.5;
      const free = (undamaged && stars === 0) || this._respect('sanayi') >= 50;
      const cost = free ? 0 : 300 + 200 * stars;
      if (cost > 0 && !this.charge(cost, 'BOYAHANE')) { this.msg('Yeterli paran yok', 'mis'); return; }
      this.state = 'spray'; this._fT = 0; this._sprayMoved = false;
      this.msg('BOYAHANE', 'big', cost > 0 ? '₺' + U.fmt(cost) : 'Ücretsiz');
      this._au('door');
    }
    _sprayMid() {
      // kapı kapalıyken (ekran kararmış): onar, boya, çıkışa koy
      const g = this.game, car = g.car, pv = this.playerVeh, P = this.places;
      this._sprayMoved = true;
      if (!pv) return;
      pv.hp = pv.maxHp; this._pBurnT = -1;
      if (!pv.own) {
        let col = pv.setup.color;
        for (let k = 0; k < 8 && col === pv.setup.color; k++) col = SPRAY_COLS[(Math.random() * SPRAY_COLS.length) | 0];
        pv.setup = Object.assign({}, pv.setup, { color: col });
        car.setDef(pv.def, pv.setup);
      }
      const ex = P.spray.exit;
      if (ex) { car.reset(ex.x, ex.y, ex.h); this._snapCamera(ex.x, ex.y, false); }
      if (this.police) { try { this.police.clear('respray'); } catch (e) { this._err('police.clear', e); } }
    }
    _sprayEnd() {
      if (!this._sprayMoved) this._sprayMid();
      this.state = 'car';
      this._sprayArm = false;
      this.msg('BOYANDI!', 'big', 'Aranma temizlendi');
      this._au('cash');
      this.autosave(true);
    }

    // ================= HASAR (§5.4) =================
    _growIdx(i) {
      if (i < this._smk.length) return;
      const n = Math.max(i + 1, this._smk.length * 2);
      const gr = (a) => { const b = new Float32Array(n); b.set(a); return b; };
      this._smk = gr(this._smk); this._fire = gr(this._fire); this._byP = gr(this._byP);
    }
    _damagePlayer(d) {
      const pv = this.playerVeh;
      if (!pv || !(d > 0) || this.state === 'spray') return;
      pv.hp = Math.max(0, pv.hp - d);
      if (pv.hp < 0.15 * pv.maxHp && this._pBurnT < 0) {
        this._pBurnT = 0;
        this.msg('ARAÇ YANIYOR! İN!', 'big');
      }
    }
    _damageVeh(v, d, byPlayer) {
      if (!v || !v.alive || v.mode === VM.WRECK || !(d > 0)) return;
      v.hp = Math.max(0, v.hp - d);
      if (byPlayer) { this._growIdx(v.idx); this._byP[v.idx] = this.t + 10; }
      if (v.hp < 0.15 * v.maxHp && v.burnT < 0) v.burnT = 0;
      if (v.role === 'cop' && this.police) { try { this.police.onCopDamaged(v, !!byPlayer); } catch (e) { this._err('police.onCopDamaged', e); } }
    }
    _impactDmg(vn) { return 1.15 * Math.max(0, vn * vn - 6); }

    // duman/yangın yayımı ve patlama zamanlayıcıları (adım k)
    _damageFx(dt) {
      const g = this.game, fx = g.fx, Q = this.Q || {}, rate = Q.dmgSmoke || 2;
      const tr = this.traffic;
      if (tr && tr.list) {
        const L = tr.list;
        for (let i = 0; i < L.length; i++) {
          const r = L[i];
          if (!r.alive || r.mode === VM.WRECK) continue;
          const f = r.hp / (r.maxHp || 1000);
          if (f >= 0.65 && r.burnT < 0) continue;
          if (r.burnT >= 0 && !this._frozen) {
            r.burnT += dt;
            if (r.burnT >= BURN_T && this._exq.indexOf(r) < 0) this._exq.push(r);
          }
          if (!r.vis) continue;
          this._growIdx(r.idx);
          const c = Math.cos(r.h), s = Math.sin(r.h), hx = r.x + c * r.p.len * 0.3, hy = r.y + s * r.p.len * 0.3;
          this._smk[r.idx] += dt * rate;
          if (this._smk[r.idx] >= 1) { this._smk[r.idx] -= 1; if (fx.dmgSmoke) fx.dmgSmoke(hx, hy, r.vx * 0.3, r.vy * 0.3, f < 0.35); }
          if (r.burnT >= 0) {
            this._fire[r.idx] += dt * 6;
            if (this._fire[r.idx] >= 1) { this._fire[r.idx] -= 1; if (fx.burn) fx.burn(hx, hy, r.vx * 0.3, r.vy * 0.3); }
          }
        }
      }
      // oyuncu aracı
      const pv = this.playerVeh;
      if (this.inCar && pv && pv.hp < 0.65 * pv.maxHp) {
        const car = g.car, c = Math.cos(car.h), s = Math.sin(car.h), hx = car.x + c * car.p.len * 0.3, hy = car.y + s * car.p.len * 0.3;
        this._pSmk += dt * rate;
        if (this._pSmk >= 1) { this._pSmk -= 1; if (fx.dmgSmoke) fx.dmgSmoke(hx, hy, car.vx * 0.3, car.vy * 0.3, pv.hp < 0.35 * pv.maxHp); }
        if (this._pBurnT >= 0) {
          this._pFire += dt * 6;
          if (this._pFire >= 1) { this._pFire -= 1; if (fx.burn) fx.burn(hx, hy, car.vx * 0.3, car.vy * 0.3); }
        }
      }
      // patlama kuyruğu
      let guard = 8;
      while (this._exq.length && guard-- > 0) this._explodeVeh(this._exq.pop());
      this._exq.length = 0;
    }
    _explodeVeh(r) {
      if (!r || !r.alive || r.mode === VM.WRECK) return;
      const byP = this._byP[r.idx] > this.t;
      r.hp = 0; r.burnT = -1;
      if (r.role === 'cop' && this.police) { try { this.police.onCopDamaged(r, byP); } catch (e) { this._err('police.onCopDamaged', e); } }
      if (r.driver && r.role !== 'cop') this._popDriver(r, false);
      if (byP && r.role !== 'cop') this._crime('WRECK_CAR', r.x, r.y);
      if (this.traffic.toWreck) { try { this.traffic.toWreck(r); } catch (e) { this._err('traffic.toWreck', e); } }
      this._explode(r.x, r.y, r.setup && r.setup.color, r, byP);
    }
    // çizgi film patlaması: alev, kara duman, enkaz parçaları; yakındaki yayalar devrilir, araçlar hasar alır
    _explode(x, y, col, src, byPlayer, isPlayer) {
      const g = this.game, fx = g.fx, W = this.W;
      if (fx.explode) fx.explode(x, y, col || '#8a8f98');
      const dp = Math.hypot(x - W.px, y - W.py);
      const au = g.audio;
      if (au && au.explosion) { try { au.explosion(U.clamp(1.2 - dp / 120, 0.15, 1.2)); } catch (e) { this._err('audio.explosion', e); } }
      g.cam.shake = Math.min(1.6, g.cam.shake + Math.max(0, 1 - dp / 90));
      const pd = this.peds;
      if (pd && pd.knock) {
        for (let i = 0; i < pd.n; i++) {
          const dx = pd.x[i] - x, dy = pd.y[i] - y, d = Math.sqrt(dx * dx + dy * dy);
          if (d >= 6) continue;
          const k = (2 + 6 * (1 - d / 6)) / Math.max(d, 0.3);
          try { pd.knock(i, dx * k, dy * k, 'blast', 8); } catch (e) { this._err('peds.knock', e); }
        }
      }
      this._panic(x, y, 55, 1.0);
      const tr = this.traffic;
      if (tr && tr.list) {
        const L = tr.list;
        for (let i = 0; i < L.length; i++) {
          const r = L[i];
          if (r === src || !r.alive || r.mode === VM.WRECK) continue;
          const dx = r.x - x, dy = r.y - y;
          if (dx * dx + dy * dy > 25) continue;
          this._damageVeh(r, 300, byPlayer);
          if (r.hp <= 0 && this._chainT <= 0 && this._exq.indexOf(r) < 0) { this._chainT = 2; this._exq.push(r); }
        }
      }
      if (this.inCar && src !== null && Math.hypot(g.car.x - x, g.car.y - y) < 5) this._damagePlayer(300);
      if (!this.inCar && this.walker.blast) {
        let d = 0;
        try { d = this.walker.blast(x, y); } catch (e) { this._err('walker.blast', e); }
        if (d > 0 && fx.knock) fx.knock(this.walker.x, this.walker.y, PANTS_PLAYER);
      }
      this._mev('explode', isPlayer ? null : src);
    }
    // oyuncu içindeyken patlama: enkaz kalır, oyuncu bayılır
    _explodePlayer() {
      const g = this.game, car = g.car, pv = this.playerVeh;
      const x = car.x, y = car.y, col = pv ? pv.setup.color : '#8a8f98';
      const pt = this._exitPoint(car);
      const veh = this._leaveCar();
      if (veh) { veh.hp = 0; if (this.traffic.toWreck) { try { this.traffic.toWreck(veh); } catch (e) { this._err('traffic.toWreck', e); } } }
      car.vx = car.vy = car.w = 0;
      const wk = this.walker;
      wk.reset(pt ? pt.x : x, pt ? pt.y : y, car.h);
      this._toFoot();
      this._explode(x, y, col, veh, false, true);
      wk.hp = 0;
      this._beginWasted();
    }

    // ================= OLAYLAR (§2.5) =================
    onVehHit(a, b, vn, x, y) {
      if (this.state === 'off') return;
      const g = this.game, pc = a === null;
      const ma = pc ? g.car.p.m : (a.def && a.def.mass) || 1300;
      const mb = b ? (b.def && b.def.mass) || 1300 : g.car.p.m;
      const base = this._impactDmg(vn);
      if (base > 0) {
        const mfA = U.clamp((2 * mb) / (ma + mb), 0.4, 1.6), mfB = U.clamp((2 * ma) / (ma + mb), 0.4, 1.6);
        if (pc) { if (this.inCar) this._damagePlayer(base * mfA * 0.6); }
        else this._damageVeh(a, base * mfA, false);
        if (b) this._damageVeh(b, base * mfB, pc);
      }
      const W = this.W, fx = g.fx;
      if (vn > 2 && W.isVisible(x, y, 2) && fx.sparks) fx.sparks(x, y, 0, 0, Math.min(30, Math.round(vn * 2)), 3 + vn * 0.4);
      if (pc) {
        this._au('impact', vn);
        g.cam.shake = Math.min(1.2, g.cam.shake + vn * 0.05);
        if (g.score.impact) g.score.impact(vn);
      } else {
        const d = Math.hypot(x - W.px, y - W.py);
        if (d < 40 && vn > 1.5) this._au('impact', vn * (1 - d / 40));
      }
      if (vn > 4) this._panic(x, y, 15, 0.5);
      // suçlar (oyuncu aracı)
      if (pc && b && this.police && this.inCar) {
        let cop = false;
        try { cop = this.police.isCop(b); } catch (e) { cop = false; }
        if (cop) {
          const car = g.car, dx = b.x - car.x, dy = b.y - car.y, d = Math.hypot(dx, dy) || 1;
          if ((car.vx * dx + car.vy * dy) / d > 2) this._crime('HIT_COP_CAR', x, y, b);
        } else if (vn > 7 && b.driver && b.role !== 'player') this._crime('HIT_CAR', x, y, b);
      }
    }
    onVehWall(veh, vn, kind, x, y) {
      if (this.state === 'off' || !veh) return;
      this._damageVeh(veh, this._impactDmg(vn), false);
      const W = this.W, fx = this.game.fx;
      if (vn > 2 && W.isVisible(x, y, 2) && fx.sparks) fx.sparks(x, y, veh.vx * 0.3, veh.vy * 0.3, Math.min(20, Math.round(vn * 2)), 3);
      const d = Math.hypot(x - W.px, y - W.py);
      if (d < 35 && vn > 2) this._au('impact', vn * (1 - d / 35));
    }
    onPedHit(i, src, speed) {
      const pd = this.peds;
      if (!pd || this.state === 'off') return;
      const g = this.game, x = pd.x[i], y = pd.y[i];
      const pals = DS.PED_PALETTES, pal = pals && pals[pd.pal[i]];
      if (g.fx.knock) g.fx.knock(x, y, pal ? pal.pants : '#2b2f3a');
      const cop = pd.role[i] === PR.COP;
      if (src === 'walker') {
        this._au('punch');
        this._panic(x, y, 12, 0.6);
        this._crime(cop ? 'PUNCH_COP' : 'PED_PUNCH', x, y, i);
        this.ow.stats.knocked++;
      } else if (src === 'blast') {
        // patlama: panik ve suç patlamanın kendisinde
      } else {
        this._panic(x, y, 20, 0.8);
        if (src === null) {
          this._au('impact', Math.min(4, (speed || 4) * 0.35));
          this._crime(cop ? 'KNOCK_COP' : 'PED_KNOCK', x, y, i);
          this.ow.stats.knocked++;
        }
      }
      this._owDirty = true;
    }
    onStars(o, n) {
      if (this.state === 'off') return;
      if (n > o) {
        this._au('jingle', 'star');
        if (o === 0) this.msg('ARANIYOR', 'cop', n + ' yıldız');
        const st = this.ow.stats;
        if (n > st.maxStars) st.maxStars = n;
      }
      this._mev('stars', n);
    }
    onBusted() {
      if (this.state === 'off' || this.state === 'busted' || this.state === 'wasted') return;
      if (this.state === 'enter') this._cancelEnter();
      const po = this.police;
      this._fine = 200 * (po ? po.stars : 0);
      this.state = 'busted'; this._fT = 0; this._autoExit = false;
      this.msg('ENSELENDİN!', 'big', this._fine > 0 ? 'Ceza ₺' + U.fmt(Math.min(this._fine, this.game.save.money)) : '');
      this._au('jingle', 'busted'); this._au('horn', false);
    }
    _finishBusted() {
      const g = this.game;
      const fee = Math.min(this._fine, g.save.money);
      if (fee > 0) this.charge(fee, 'Ceza');
      if (this.police) { try { this.police.clear('busted'); } catch (e) { this._err('police.clear', e); } }
      this._mev('busted');
      this.ow.stats.busted++;
      const P = this.places, r = P.police.respawn || P.police.spawn;
      this._respawnAt(r);
      this.autosave(true);
    }
    _beginWasted() {
      if (this.state === 'off' || this.state === 'wasted') return;
      if (this.state === 'enter') this._cancelEnter();
      this.state = 'wasted'; this._fT = 0; this._autoExit = false;
      const wk = this.walker;
      if (!this.inCar && wk.state !== 'down') { wk.state = 'down'; wk.t = 0; }
      this.msg('BAYILDIN!', 'big', 'Hastaneye kaldırılıyorsun');
      this._au('jingle', 'wasted'); this._au('horn', false);
    }
    _finishWasted() {
      const g = this.game, money = g.save.money;
      const fee = Math.min(money, U.clamp(Math.round(money * 0.1), 100, 1500));
      if (fee > 0) this.charge(fee, 'Hastane');
      if (this.police) { try { this.police.clear('wasted'); } catch (e) { this._err('police.clear', e); } }
      this._mev('wasted');
      this.ow.stats.wasted++;
      this.walker.hp = 100;
      const P = this.places, r = P.hospital.respawn || P.hospital.spawn;
      this._respawnAt(r);
      this.walker.hp = 100;
      this.autosave(true);
    }
    // yaya olarak (x, y, h) noktasında yeniden başla; araçtaysa araç park kaydı olarak kalır
    _respawnAt(p) {
      const g = this.game;
      if (this.inCar) { this._leaveCar(); g.car.vx = g.car.vy = g.car.w = 0; this._toFoot(); }
      const wk = this.walker;
      wk.reset(p.x, p.y, p.h || 0);
      wk.state = 'walk';
      this.state = 'foot';
      this._setFlags(false);
      this._autoExit = false; this._pBurnT = -1;
      g.car.reset(p.x, p.y, p.h || 0);
      this._snapCamera(p.x, p.y, true);
      this._repopulate();
      this._homeIn = this._inHome(p.x, p.y);
    }
    // uzak ışınlama: eski çevredeki sıradan kayıtları bırak, yeni çevreyi doldur
    _repopulate() {
      this._refreshW(0);
      const tr = this.traffic, W = this.W;
      if (!tr || !tr.list) return;
      const R = W.viewR + 75, L = tr.list;
      for (let i = L.length - 1; i >= 0; i--) {
        const r = L[i];
        if (r.keep || r.vis) continue;
        const dx = r.x - W.cx, dy = r.y - W.cy;
        if (dx * dx + dy * dy > R * R) { try { tr.despawn(r); } catch (e) { this._err('traffic.despawn', e); } }
      }
      try { tr.fill(); } catch (e) { this._err('traffic.fill', e); }
    }
    onEscape(bounty) {
      if (this.state === 'off') return;
      const b = Math.round(bounty || 0);
      if (b > 0) { this.reward(b, 'KOVALAMACA ÖDÜLÜ'); this.ow.stats.bounty += b; }
    }
    onTakedown() {
      if (this.state === 'off') return;
      this.ow.stats.takedowns++;
      this._owDirty = true;
    }
    onMissionEnd(r) {
      if (this.state === 'off' || !r) return;
      // ödül, aranma temizliği ve görev istatistikleri görev modülündedir: burada yalnız sonuç + kayıt
      this._au('jingle', r.pass ? 'pass' : 'fail');
      this.autosave(true);
      if (r.kind !== 'taxi' && DS.WorldUI && DS.WorldUI.showResult) this._ui('showResult', r);
      else this.msg(r.pass ? 'GÖREV TAMAM!' : 'GÖREV BAŞARISIZ', 'big', r.note || '');
    }
    msg(text, kind, sub) {
      const m = this.msgs;
      if (m.length >= 12) m.shift();
      m.push({ text: text || '', kind: kind || 'mis', sub: sub || '' });
    }
    reward(amount, reason) {
      const a = Math.round(amount || 0);
      if (!(a > 0)) return;
      const g = this.game;
      g.save.money += a;
      g.dirty = true;
      this.msg('+₺' + U.fmt(a), 'cash', reason || '');
      this._au('cash');
    }
    charge(amount, reason) {
      const a = Math.round(amount || 0);
      const g = this.game;
      if (!(a > 0)) return true;
      if (g.save.money < a) return false;
      g.save.money -= a;
      g.dirty = true;
      this.msg('−₺' + U.fmt(a), 'mis', reason || '');
      return true;
    }
    _respect(crew) {
      const m = this.missions;
      if (m && m.respect && typeof m.respect === 'object' && typeof m.respect[crew] === 'number') return m.respect[crew];
      if (m && typeof m.respect === 'function') { try { const v = m.respect(crew); if (typeof v === 'number') return v; } catch (e) { this._err('missions.respect', e); } }
      const ow = this.ow;
      return ow && ow.respect && typeof ow.respect[crew] === 'number' ? ow.respect[crew] : 0;
    }
    // drift kasası: ₺1 / 10 puan (Kulüp saygınlığı ≥ 50: ×1.2); görevlere 'bank' olayı
    onDriftBank(pts, mult) {
      if (this.state === 'off') return;
      const perk = this._respect('kulup') >= 50 ? 1.2 : 1;
      const cash = Math.round((pts / 10) * perk);
      const g = this.game;
      if (cash > 0) {
        g.save.money += cash;
        g.dirty = true;
        this.ow.stats.driftCash += cash;
        this.msg('+₺' + U.fmt(cash), 'cash', 'DRİFT');
      }
      this._mev('bank', pts, mult);
    }
    // oyuncu aracı şehir engeline / propa çarptı (main.onHit / onBreak)
    onPlayerWall(vn, kind) {
      if (!this.inCar) return;
      this._damagePlayer(this._impactDmg(vn) * 0.6);
      if (vn > 4) { const c = this.game.car; this._panic(c.x, c.y, 15, 0.5); }
    }
    onPropBreak(col) {
      if (!this.inCar || !col) return;
      this._crime('PROPERTY', col.x, col.y);
      this._panic(col.x, col.y, 12, 0.4);
    }

    // ================= YAYA ÇARPMALARI (adım i) =================
    _pedHits(dt) {
      const pd = this.peds;
      if (!pd || !pd.hitTest || !(dt > 0) || pd.n === 0) return;
      const g = this.game, W = this.W;
      try {
        if (this.inCar) {
          const c = g.car;
          if (c.speed > 0.3) pd.hitTest(c.x, c.y, Math.cos(c.h), Math.sin(c.h), c.p.len * 0.5, c.p.wid * 0.5, c.vx, c.vy, dt, null);
        }
        const tr = this.traffic;
        if (tr && tr.list) {
          const L = tr.list, R = W.viewR + 20, R2 = R * R;
          for (let i = 0; i < L.length; i++) {
            const r = L[i];
            if (!r.alive) continue;
            const rail = r.mode === VM.RAIL, sp = rail ? r.v : r.speed;
            if (!(sp > 2)) continue;
            const dx = r.x - W.cx, dy = r.y - W.cy;
            if (dx * dx + dy * dy > R2) continue;
            const c = Math.cos(r.h), s = Math.sin(r.h);
            const vx = rail ? c * sp : r.vx, vy = rail ? s * sp : r.vy;
            pd.hitTest(r.x, r.y, c, s, r.p.len * 0.5, r.p.wid * 0.5, vx, vy, dt, r);
          }
        }
      } catch (e) { this._err('peds.hitTest', e); }
    }

    // ================= KENDİ ARAÇ =================
    _ownValid() { const v = this._own; return !!v && v.alive && v.tag === this._ownTag && v.mode !== VM.WRECK; }
    _spawnOwn() {
      const tr = this.traffic, P = this.places;
      if (!tr || !P) return null;
      const g = this.game, s = g.save, cp = P.safehouse.car || P.safehouse.carSpawn;
      const def = DS.carById(s.car);
      let v = null;
      try {
        v = tr.spawn({ def, setup: g.carSetup(s.car), x: cp.x, y: cp.y, h: cp.h, mode: 'parked', role: 'player', keep: true, driver: false, tag: this._ownTag, force: true });
      } catch (e) { this._err('traffic.spawn', e); }
      this._own = v;
      return v;
    }
    // her zaman var: yok olduysa ya da çok uzakta ve görünmezse güvenli eve döner (1 Hz)
    _checkOwn() {
      if (this.inCar && this.playerVeh && this.playerVeh.own) return;
      if (this.state === 'wasted' || this.state === 'busted') return;
      const v = this._own;
      if (!this._ownValid()) {
        if (v && v.alive && v.tag === this._ownTag) v.tag = null; // enkaz artık sıradan
        this._spawnOwn();
        return;
      }
      const W = this.W, cp = this.places.safehouse.car;
      const d = Math.hypot(v.x - W.px, v.y - W.py);
      if (d > OWN_FAR && !v.vis && !W.isVisible(cp.x, cp.y, 4)) {
        try { this.traffic.despawn(v); } catch (e) { this._err('traffic.despawn', e); }
        this._spawnOwn();
      }
    }
    // garajda araç/parça değişti: kendi aracın kaydını (ya da sürülüyorsa oyuncu aracını) yeniden giydir
    onGarageChange() {
      if (this.state === 'off') return;
      const g = this.game, s = g.save, def = DS.carById(s.car), setup = g.carSetup(s.car);
      const pv = this.playerVeh;
      if (this.inCar && pv && pv.own) {
        const car = g.car;
        car.setDef(def, setup);
        car.gear = Math.min(Math.max(1, car.gear), def.gears.length);
        pv.def = def; pv.setup = setup; pv.maxHp = defHp(def); pv.hp = Math.min(pv.hp, pv.maxHp);
        if (g.audio && g.audio.setVoice) g.audio.setVoice(def.voice);
        return;
      }
      if (!this.inCar) g.car.setDef(def, setup);
      const v = this._own;
      if (this._ownValid()) {
        if (v.def !== def) {
          const x = v.x, y = v.y, h = v.h;
          try { this.traffic.despawn(v); } catch (e) { this._err('traffic.despawn', e); }
          const nv = this.traffic.spawn({ def, setup, x, y, h, mode: 'parked', role: 'player', keep: true, driver: false, tag: this._ownTag, force: true });
          this._own = nv;
        } else { v.setup = setup; v.ak = null; }
      }
    }

    // ================= GPS / YOL NOKTASI =================
    _target(out) {
      const m = this.missions, ob = m && m.objective;
      if (ob && ob.has && typeof ob.x === 'number' && typeof ob.y === 'number') { out.x = ob.x; out.y = ob.y; return true; }
      if (this.wp) { out.x = this.wp.x; out.y = this.wp.y; return true; }
      return false;
    }
    _refreshRoute(force) {
      const nav = this.nav, r = this.route, T = this._so;
      if (!nav) return;
      const has = this._target(T);
      if (!has) {
        if (r.n !== 0) { r.n = 0; r.len = 0; r.ver++; }
        this._gHas = false;
        return;
      }
      const f = this.focus();
      // yol noktasına varıldı
      if (this.wp && T.x === this.wp.x && T.y === this.wp.y && Math.hypot(f.x - T.x, f.y - T.y) < 12) {
        this.wp = null; r.n = 0; r.len = 0; r.ver++; this._gHas = false;
        this.msg('Yol noktasına vardın', 'mis');
        return;
      }
      const moved = !this._gHas || Math.abs(T.x - this._gx) > 2 || Math.abs(T.y - this._gy) > 2;
      if (!force && !moved && this._gpsT > 0) return;
      this._gpsT = 1;
      this._gHas = true; this._gx = T.x; this._gy = T.y;
      try { nav.gps(f.x, f.y, T.x, T.y, r); } catch (e) { this._err('nav.gps', e); r.n = 0; }
      r.ver++;
    }
    setWaypoint(x, y) {
      const nav = this.nav;
      if (!nav) return;
      const o = this._so;
      let px = x, py = y;
      try { if (nav.snap(x, y, o)) { px = o.x; py = o.y; } } catch (e) { this._err('nav.snap', e); }
      this.wp = { x: px, y: py };
      this._gpsT = 0; this._gHas = false;
      this._refreshRoute(true);
    }
    clearWaypoint() {
      this.wp = null;
      this._gHas = false;
      this._refreshRoute(true);
    }

    // ================= HUD + BLİPLER (§2.6.13) =================
    _prompt(text, sec) { this._tmpPrompt = text; this._tmpPromptT = sec || 1.5; this._hudT = 1; }
    _hudTick(step) {
      const h = this.hud, g = this.game, po = this.police, m = this.missions, wk = this.walker, pv = this.playerVeh;
      h.onFoot = !this.inCar; h.inCar = this.inCar;
      h.money = g.save.money;
      h.hp = Math.max(0, Math.round(wk.hp));
      h.carHp = this.inCar && pv ? U.sat(pv.hp / pv.maxHp) : -1;
      h.stars = po ? po.stars | 0 : 0;
      h.starFlash = po ? !!po.flash : false;
      h.bust = po ? po.bust || 0 : 0;
      h.bounty = po ? po.bounty || 0 : 0;
      const running = !!m && m.state === 'run';
      const ob = m && m.objective;
      h.mission = running;
      h.obj = ob && ob.text ? ob.text : '';
      h.timer = ob && typeof ob.timer === 'number' && ob.timer >= 0 ? ob.timer : -1;
      h.objSub = ob && ob.sub ? ob.sub : this.route.n > 1 ? fmtDist(this.route.len) : '';
      // bağlam ipucu ve dokunmatik etiketleri
      let prompt = '', act = '', enter = '';
      const k = this.state === 'foot' || this.state === 'car' ? this._context() : 0;
      if (this.state === 'foot') {
        if (this._findEnterable(wk.x, wk.y, ENTER_R)) { enter = 'BİN'; prompt = 'F — Bin'; }
      } else if (this.state === 'car') enter = 'İN';
      if (k === 1) { act = 'TELEFON'; prompt = 'E — Telefon'; }
      else if (k === 2) { act = 'GARAJ'; prompt = 'E — Garaj'; }
      else if (k === 3) { act = 'BAŞLAT'; prompt = 'E — Başlat'; }
      else if (k === 4) { act = 'TAKSİ'; prompt = 'E — Taksi işi'; }
      if (this._tmpPromptT > 0 && this._tmpPrompt) prompt = this._tmpPrompt;
      h.prompt = prompt; h.actLabel = act; h.enterLabel = enter;
      // bölge adı (değişince 3 s)
      this._zoneT -= step;
      if (this._zoneT <= 0 && this.nav) {
        this._zoneT = 0.5;
        const f = this.focus();
        let z = '';
        try { z = this.nav.district(f.x, f.y) || ''; } catch (e) { z = ''; }
        if (z && z !== this._zoneName) { this._zoneName = z; h.zone = z.toLocaleUpperCase('tr-TR'); h.zoneT = 3; }
      }
      if (h.zoneT > 0) h.zoneT = Math.max(0, h.zoneT - step);
      // saat
      const mn = Math.floor(this.clock * 60) % 1440;
      if (mn !== this._clockMin) {
        this._clockMin = mn;
        const hh = (mn / 60) | 0, mm = mn % 60;
        this._clockStr = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
      }
      h.clock = this._clockStr;
    }
    // out[i] = {x, y, k}; görevlerin blipleri + polis, boyahane, güvenli ev, yol noktası, kendi araç
    blips(out) {
      if (this.state === 'off' || !this.nav) return 0;
      const MAX = 64;
      let n = 0;
      const put = (x, y, k) => {
        if (n >= MAX) return;
        let o = out[n];
        if (!o) o = out[n] = { x: 0, y: 0, k: 0 };
        o.x = x; o.y = y; o.k = k; n++;
      };
      const m = this.missions, P = this.places;
      if (m && m.blips) {
        try { const r = m.blips(out, n); if (typeof r === 'number' && r >= n && r <= MAX) n = r; } catch (e) { this._err('missions.blips', e); }
      } else if (P.phones) for (let i = 0; i < P.phones.length; i++) put(P.phones[i].x, P.phones[i].y, 3);
      if (this.wp) put(this.wp.x, this.wp.y, 7);
      const po = this.police;
      if (po && po.cops) {
        for (let i = 0; i < po.cops.length; i++) {
          const v = po.cops[i];
          if (v && v.alive && v.mode !== VM.WRECK) put(v.x, v.y, 2);
        }
      }
      if (this._ownValid() && !(this.inCar && this.playerVeh && this.playerVeh.own)) put(this._own.x, this._own.y, 8);
      if (P.spray) put(P.spray.x, P.spray.y, 4);
      if (P.safehouse) put(P.safehouse.x, P.safehouse.y, 5);
      return n;
    }
    mapPois() {
      const P = this.places, out = [];
      if (!P) return out;
      if (P.safehouse) out.push({ x: P.safehouse.x, y: P.safehouse.y, k: 5, name: 'Güvenli Ev' });
      if (P.spray) out.push({ x: P.spray.x, y: P.spray.y, k: 4, name: 'Boyahane' });
      if (P.hospital) out.push({ x: P.hospital.x, y: P.hospital.y, k: 0, name: 'Hastane' });
      if (P.police) out.push({ x: P.police.x, y: P.police.y, k: 0, name: 'Karakol' });
      if (P.crane) out.push({ x: P.crane.x, y: P.crane.y, k: 0, name: 'Hurda Vinci' });
      if (P.phones) for (let i = 0; i < P.phones.length; i++) out.push({ x: P.phones[i].x, y: P.phones[i].y, k: 3, name: 'Telefon' });
      const S = DS.SIDE;
      if (S && S.length) {
        for (let i = 0; i < S.length; i++) {
          const s = S[i];
          const x = typeof s.x === 'number' ? s.x : s.pos ? s.pos.x : NaN, y = typeof s.y === 'number' ? s.y : s.pos ? s.pos.y : NaN;
          if (x === x && y === y) out.push({ x, y, k: 6, name: s.name || 'Etkinlik' });
        }
      }
      return out;
    }

    // ================= ARAYÜZ ARAYÜZÜ =================
    openMap() {
      if (this.state === 'off') return;
      if (this.ow) this.ow.tut.map = true;
      this._ui('openMap');
    }
    closeMap() { this._ui('closeMap'); }
    pickMission(id) {
      const m = this.missions;
      if (!m || !m.start) return false;
      let ok = false;
      try { ok = !!m.start(id); } catch (e) { this._err('missions.start', e); ok = false; }
      if (!ok) return false;
      this.closePhone();
      return true;
    }
    closePhone() { this._ui('closePhone'); }
    retryMission() {
      const m = this.missions;
      this.closeResult();
      let ok = false;
      if (m && m.retry) { try { ok = !!m.retry(); } catch (e) { this._err('missions.retry', e); } }
      return ok;
    }
    closeResult() { this._ui('closeResult'); }
    abortMission() {
      const m = this.missions;
      if (m && m.state === 'run' && m.abort) { try { m.abort('abort'); } catch (e) { this._err('missions.abort', e); } }
    }
    canGarage() {
      if (this.state !== 'foot' && this.state !== 'car') return false;
      const pv = this.playerVeh, f = this.focus();
      if (this.inCar && !(pv && pv.own)) return false;
      if (!this._inHome(f.x, f.y)) return false;
      if (this.police && this.police.stars > 0) return false;
      return !(this.missions && this.missions.state === 'run');
    }
    // takıldım: yayayken en yakın yaya şeridine, araçta en yakın yol şeridine
    unstuck() {
      if (this.state === 'off') return false;
      const g = this.game, nav = this.nav;
      if (this.police && this.police.bust > 0) { this._prompt('Polis yanındayken olmaz', 1.6); return false; }
      if (this.inCar) {
        const car = g.car;
        const p = this.city.respawnPoint(car.x, car.y, car.h);
        let x = p.x, y = p.y, h = p.h;
        const o = this._so;
        if (nav) { try { if (nav.nearestLane(x, y, h, 12, 70, o)) { x = o.x; y = o.y; h = o.h; } } catch (e) { this._err('nav.nearestLane', e); } }
        car.reset(x, y, h);
        g.score.reset();
        g.carFX = g.fxState();
        this._autoExit = false;
      } else if (this.state === 'foot' || this.state === 'exit') {
        const wk = this.walker, o = this._so;
        if (nav) { try { if (nav.nearestPedEdge(wk.x, wk.y, o)) { wk.x = o.x; wk.y = o.y; wk.vx = wk.vy = 0; } } catch (e) { this._err('nav.nearestPedEdge', e); } }
      } else return false;
      if (DS.UI && DS.UI.toast) DS.UI.toast('Yola dönüldü', 1200);
      return true;
    }

    // ================= KAYIT =================
    saveOw() {
      const ow = this.ow, g = this.game;
      if (!ow || this.state === 'off') return;
      ow.v = 1;
      ow.clock = Math.round(this.clock * 1000) / 1000;
      ow.hp = U.clamp(Math.round(this.walker ? this.walker.hp : 100), 1, 100);
      const m = this.missions;
      if (m && m.save) { try { m.save(ow); } catch (e) { this._err('missions.save', e); } }
      g.save.ow = ow;
      this._owDirty = false;
    }
    autosave(now2) {
      this._saveT = 0;
      this.saveOw();
      if (now2) this.game.persist(); else this.game.persistSoon();
    }

    // ================= ÇİZİM KANCALARI (§2.8) =================
    drawGround(ctx) {
      if (this.state === 'off') return;
      const t0 = now(), g = this.game, W = this.W, M = g.M, AS = DS.ActorSprites;
      this._dAcc = 0;
      W.M = M; W.view = g.view; W.camRot = g.cam.rot;
      if (AS && AS.beginFrame) { try { AS.beginFrame(ctx, M, g.cam.rot); } catch (e) { this._err('actors.beginFrame', e); } }
      if (this.traffic) { try { this.traffic.drawSignals(ctx, W); } catch (e) { this._err('traffic.drawSignals', e); } }
      if (this.missions && this.missions.drawGround) { try { this.missions.drawGround(ctx, W); } catch (e) { this._err('missions.drawGround', e); } }
      if (AS && AS.drawRing) {
        const P = this.places;
        if (P) {
          const sh = P.safehouse;
          if (sh && (!this.inCar || (this.playerVeh && this.playerVeh.own))) AS.drawRing(ctx, sh.x, sh.y, 2.2, RING_HOME, this.t);
          if (P.spray && this.inCar) AS.drawRing(ctx, P.spray.x, P.spray.y, 3, RING_SPRAY, this.t);
        }
        const Q = this.Q;
        const r = this.route;
        if (Q && Q.chevrons && r.n > 1 && AS.drawChevrons) AS.drawChevrons(ctx, r.pts, r.n, ARROW_COL, this.t);
      }
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.globalAlpha = 1;
      this._dAcc += now() - t0;
    }
    drawActors(ctx) {
      if (this.state === 'off') return;
      const t0 = now(), g = this.game, W = this.W, M = g.M, AS = DS.ActorSprites;
      if (this.peds) { try { this.peds.draw(ctx, W); } catch (e) { this._err('peds.draw', e); } }
      const tr = this.traffic;
      if (tr) {
        if (AS && AS.drawVehicle) { try { tr.draw(ctx, W); } catch (e) { this._err('traffic.draw', e); } }
        else {
          const L = tr.list;
          for (let i = 0; i < L.length; i++) {
            const r = L[i];
            if (!r.vis) continue;
            ctx.fillStyle = r.mode === VM.WRECK ? '#262626' : (r.setup && r.setup.color) || '#888';
            rectAt(ctx, M, r.x, r.y, r.h, r.p.len, r.p.wid);
          }
        }
      }
      if (!this.inCar && this.walker) { try { this.walker.draw(ctx, W); } catch (e) { this._err('walker.draw', e); } }
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.globalAlpha = 1;
      this._dAcc += now() - t0;
    }
    drawAbove(ctx) {
      if (this.state === 'off') return;
      const t0 = now(), g = this.game, W = this.W, M = g.M, AS = DS.ActorSprites;
      if (this.missions && this.missions.drawAbove) { try { this.missions.drawAbove(ctx, W); } catch (e) { this._err('missions.drawAbove', e); } }
      // yön oku (GTA1): oyuncunun yanında, hedefi gösterir
      const T = this._so;
      if (AS && AS.drawArrow && (this.state === 'foot' || this.state === 'car') && this._target(T)) {
        const f = this.focus(), dx = T.x - f.x, dy = T.y - f.y, d = Math.hypot(dx, dy);
        if (d > 15) {
          const ux = dx / d, uy = dy / d, off = this.inCar ? g.car.p.len * 0.5 + 2.4 : 1.7;
          AS.drawArrow(ctx, f.x + ux * off, f.y + uy * off, Math.atan2(uy, ux), this.inCar ? 1.7 : 1, ARROW_COL);
        }
      }
      // boyahane: kapı kapalı karartma
      if (this.state === 'spray') {
        const t = this._fT, a = t < 0.5 ? t / 0.5 : t > SPRAY_T - 0.5 ? (SPRAY_T - t) / 0.5 : 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = U.sat(a);
        ctx.fillStyle = '#05060a';
        ctx.fillRect(0, 0, g.canvas.width, g.canvas.height);
        ctx.globalAlpha = 1;
      }
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.globalAlpha = 1;
      this._dAcc += now() - t0;
    }
    drawLights(lctx, env) {
      if (this.state === 'off' || !this.traffic) return;
      const t0 = now();
      const n = this.Q && typeof this.Q.carLights === 'number' ? this.Q.carLights : 2;
      try { this.traffic.drawLights(lctx, this.W, n); } catch (e) { this._err('traffic.drawLights', e); }
      this._dAcc += now() - t0;
    }
    drawGlow(ctx, env) {
      if (this.state === 'off') return;
      const t0 = now();
      if (this.traffic) { try { this.traffic.drawGlow(ctx, this.W); } catch (e) { this._err('traffic.drawGlow', e); } }
      this._dAcc += now() - t0;
      this.prof.draw = this.prof.draw * 0.9 + this._dAcc * 0.1;
    }

    // PHYS NPC araçlarının 120 Hz pozları arasında ara değer (çizimden önce / sonra)
    lerpPoses(a) {
      const tr = this.traffic;
      this._lpN = 0;
      if (!tr || !tr.list || this.state === 'off') return;
      const L = tr.list;
      if (L.length * 3 > this._lp.length) this._lp = new Float32Array(L.length * 6);
      const lp = this._lp;
      for (let i = 0; i < L.length; i++) {
        const r = L[i];
        lp[i * 3] = r.x; lp[i * 3 + 1] = r.y; lp[i * 3 + 2] = r.h;
        if (r.mode !== VM.PHYS) continue;
        r.x = r.px + (r.x - r.px) * a; r.y = r.py + (r.y - r.py) * a; r.h = U.alerp(r.ph, r.h, a);
      }
      this._lpN = L.length;
    }
    restorePoses() {
      const tr = this.traffic, n = this._lpN || 0;
      if (!tr || !tr.list || n === 0) return;
      const L = tr.list, lp = this._lp;
      for (let i = 0; i < n && i < L.length; i++) {
        const r = L[i];
        if (r.mode !== VM.PHYS) continue;
        r.x = lp[i * 3]; r.y = lp[i * 3 + 1]; r.h = lp[i * 3 + 2];
      }
      this._lpN = 0;
    }

    // ================= SES (main.updateWorld adım 5) =================
    audioFrame(A, dt) {
      const g = this.game, au = g.audio, car = g.car;
      if (this.inCar) {
        A.rpm = car.rpm; A.load = car.limiter > 0 ? 0.2 : car.thr; A.redline = car.p.redline;
        A.slip = Math.max(car.slipR, car.slipF * 0.8); A.speed = car.speed; A.grass = car.surfR === 1 || car.surfF === 1;
        A.scrape = g.scrape; A.turbo = car.p.turbo > 0; A.boost = car.boost;
      } else {
        A.rpm = car.p.idle; A.load = 0; A.redline = car.p.redline; A.slip = 0; A.speed = 0; A.grass = false; A.scrape = 0; A.turbo = false; A.boost = 0;
      }
      A.rain = !!g.env.rain;
      if (!au) return;
      const po = this.police;
      try {
        if (au.setEngineVol) au.setEngineVol(this.inCar ? 1 : 0);
        if (au.setSiren) au.setSiren(po ? po.sirenLevel() : 0);
        if (au.horn) au.horn(!!this._hornIn);
      } catch (e) { this._err('audio.frame', e); }
      // en yakın NPC aracı = ikinci motor sesi (ses değişimi en fazla 2 s'de bir)
      A.ldist = 999; A.lrpm = 0;
      const tr = this.traffic;
      if (!tr || !tr.list) return;
      const L = tr.list, f = this.focus();
      let best = null, bd = 70 * 70;
      for (let i = 0; i < L.length; i++) {
        const r = L[i];
        if (!r.alive || !r.driver || (r.mode !== VM.RAIL && r.mode !== VM.PHYS)) continue;
        const dx = r.x - f.x, dy = r.y - f.y, d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = r; }
      }
      if (best === null) return;
      A.ldist = Math.sqrt(bd);
      const idle = (best.def && best.def.idle) || 800;
      A.lrpm = best.mode === VM.RAIL ? idle + 2200 * U.sat(best.v / 14) : best.rpm || idle;
      const voice = best.def && best.def.voice;
      if (voice && voice !== this._lvoice && this.t - this._lvT > 2 && au.setLeaderVoice) {
        this._lvoice = voice; this._lvT = this.t;
        try { au.setLeaderVoice(voice); } catch (e) { this._err('audio.setLeaderVoice', e); }
      }
    }

    // ================= HATA AYIKLAMA (§8.1) =================
    _teleport(x, y, h) {
      const g = this.game;
      const f = this.focus(), far = Math.hypot(x - f.x, y - f.y) > 100;
      if (this.inCar) {
        const car = g.car;
        car.reset(x, y, typeof h === 'number' ? h : car.h);
        g.score.reset();
        g.carFX = g.fxState();
      } else {
        const wk = this.walker;
        wk.x = x; wk.y = y; if (typeof h === 'number') wk.h = h;
        wk.vx = wk.vy = 0; wk.speed = 0;
      }
      g.cam.x = x; g.cam.y = y;
      this._viewRect();
      if (far) this._repopulate();
      this._homeIn = this._inHome(x, y);
      this._sprayArm = true;
      this._gpsT = 0;
    }
    _makeDebug() {
      const w = this;
      const lvl = (h) => { const T = [0, 50, 150, 400, 900, 1800]; for (let k = 5; k > 0; k--) if (h >= T[k]) return k; return 0; };
      return {
        state() {
          const g = w.game, pv = w.playerVeh, po = w.police, pd = w.peds, tr = w.traffic, m = w.missions, f = w.focus();
          let tc = { n: 0, rail: 0, phys: 0, parked: 0, wreck: 0, cops: 0 };
          if (tr && tr.counts) { const c = tr.counts(); tc = { n: c.n, rail: c.rail, phys: c.phys, parked: c.parked, wreck: c.wreck, cops: c.cops }; }
          const pc = { n: 0, down: 0, cops: 0 };
          if (pd) {
            pc.n = pd.n;
            for (let i = 0; i < pd.n; i++) {
              const s = pd.st[i];
              if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP) pc.down++;
              if (pd.role[i] === PR.COP) pc.cops++;
            }
          }
          const ob = m && m.objective;
          return {
            state: w.state, onFoot: w.onFoot, inCar: w.inCar, x: f.x, y: f.y, h: f.h, speed: Math.hypot(f.vx, f.vy),
            hp: w.walker ? w.walker.hp : 0, carHp: pv ? pv.hp : -1, money: g.save.money,
            stars: po ? po.stars : 0, heat: po ? po.heat : 0, seen: po ? !!po.seen : false, bust: po ? po.bust : 0, bounty: po ? po.bounty : 0,
            t: w.t, traffic: tc, peds: pc,
            mission: { id: w._missionId(), state: m ? m.state : 'idle', obj: ob && ob.text ? ob.text : '' },
            clock: w.clock, light: !!g.env.light, tier: g.Q ? g.Q.tier : -1,
          };
        },
        teleport(x, y, h) { w._teleport(x, y, h); },
        spawnVehicle(id, x, y, h, o) {
          o = o || {};
          const tr = w.traffic;
          if (!tr) return null;
          const def = DS.vehById ? DS.vehById(id) : DS.carById(id);
          let setup = null;
          const TV = DS.TRAFFIC_VARIANTS || [];
          for (let i = 0; i < TV.length; i++) if (TV[i].id === def.id) { setup = DS.variantSetup(i); break; }
          if (!setup) setup = Object.assign({}, LOT_BASE, { color: def.color || '#8a8f98', livery: 'none', wing: false, rim: '#b8b8b8', upg: {} });
          if (o.color) setup = Object.assign({}, setup, { color: o.color });
          const cls = def.cls || 'sport';
          const role = o.role || (cls === 'cop' ? 'cop' : cls === 'taxi' ? 'taxi' : 'civ');
          const mode = o.mode || 'parked';
          const driver = typeof o.driver === 'boolean' ? o.driver : mode !== 'parked';
          return tr.spawn({
            def, setup, x, y, h: typeof h === 'number' ? h : 0, mode, v: o.v || 0, role, keep: o.keep !== false, driver,
            tag: o.tag !== undefined ? o.tag : null, siren: !!o.siren, ctrl: o.ctrl, force: true,
          });
        },
        enter(veh) {
          if (w.state !== 'foot' && w.state !== 'enter' && w.state !== 'exit') return false;
          if (w._ent) w._cancelEnter();
          const tr = w.traffic, wk = w.walker;
          let v = veh;
          if (!v && tr && tr.nearestEnterable) v = tr.nearestEnterable(wk.x, wk.y, 40);
          if (!v || !v.alive || v.mode === VM.WRECK) return false;
          const jack = v.driver === true;
          if (jack) { if (tr.hold) tr.hold(v); w._popDriver(v, true); }
          const burn = v.burnT;
          const info = tr.takeForPlayer(v);
          if (!info) return false;
          w._enterCar(info, { jack, burn });
          return true;
        },
        exit() {
          if (!w.inCar || w.state !== 'car') return false;
          const c = w.game.car;
          c.vx = c.vy = c.w = 0; c.speed = 0;
          return w._doExit(true);
        },
        spawnPed(x, y, o) {
          o = o || {};
          const pd = w.peds;
          if (!pd) return -1;
          const opt = { role: o.role || 'civ' };
          if (typeof o.st === 'number') opt.st = o.st;
          if (typeof o.pal === 'number') opt.pal = o.pal;
          if (typeof o.h === 'number') opt.h = o.h;
          return pd.spawnAt(x, y, opt);
        },
        setStars(n) { if (w.police) { const f = w.focus(); w.police.setStars(n, f.x, f.y); } },
        addHeat(v) {
          const po = w.police;
          if (!po) return;
          const h = Math.max(0, po.heat + (v || 0)), n = lvl(h), f = w.focus();
          if (n !== po.stars) po.setStars(n, f.x, f.y);
          po.heat = h;
        },
        clearWanted() { if (w.police) w.police.clear('debug'); },
        hurt(n) {
          const wk = w.walker;
          if (w.inCar) wk.hp = Math.max(0, wk.hp - (n || 0));
          else wk.hurt(n || 0, 0, 0);
        },
        damageCar(n) { if (w.inCar) w._damagePlayer(n || 0); },
        damageVeh(veh, n) { w._damageVeh(veh, n || 0, true); },
        setClock(h) { w.clock = (((+h || 0) % 24) + 24) % 24; w.applyEnv(true); w._clockMin = -1; w._hudTick(0); },
        setRespect(crew, v) {
          const ow = w.ow || w.game.save.ow;
          if (ow && ow.respect) ow.respect[crew] = v;
          const m = w.missions;
          if (m && m.respect && typeof m.respect === 'object') m.respect[crew] = v;
        },
        giveMoney(n) { const g = w.game; g.save.money += n || 0; g.dirty = true; },
        startMission(id) {
          const m = w.missions;
          if (!m || !m.start) return false;
          return !!m.start(id);
        },
        completeObjective() {
          const m = w.missions;
          if (!m) return false;
          if (typeof m.debugComplete === 'function') return m.debugComplete();
          const ob = m.objective;
          if (ob && ob.has && typeof ob.x === 'number') {
            if (w.inCar) { const c = w.game.car; c.vx = c.vy = c.w = 0; }
            w._teleport(ob.x, ob.y);
            return true;
          }
          return false;
        },
        failMission() { const m = w.missions; if (m && m.abort) m.abort('abort'); },
        freeze(on) { w._frozen = !!on; },
      };
    }
  }

  World.envAt = envAt;
  World.MiniWalker = MiniWalker;
  World.MiniTraffic = MiniTraffic;
  DS.World = World;
})();
