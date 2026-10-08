'use strict';
// Aranma seviyesi ve polis (DS.Police) — SPEC §2.6.9, §5.1.
//  - Isı/tanık modeli: suç (crime) yalnız tanık varsa ısı ekler (polis: görüş hattı, yaya: 4 s sonra ihbar,
//    en fazla 1★). Yıldız = ısı eşiği. En az ★ kuralı suç anında bir kez uygulanır (kalıcı taban yok).
//  - Görüş: her polis (araç ya da yaya) en fazla 4 Hz, karede toplam ≤ 6 ışın (sıralı dağıtım).
//  - Yıldız kaybı: görülmeden kalma süresi (+ ≥2★'da arama çemberi dışı), saklanma bölgesi ×2 hız,
//    takedown (yıldız kadar polis aracı devre dışı -> −1★). Kaçış ödülü onEscape ile ödenir.
//  - Birimler: yıldız başına polis aracı / yaya polis kotası; önce yakındaki devriye polisleri terfi eder,
//    yoksa görüş dışında şeride doğar. Polis aracı tam DS.Car fiziğiyle sürülür (copCtrl):
//    saf takip, akış alanı ile kavşak kavşak rota, ÇARP (≥2★), SIKIŞTIR (yavaş oyuncu), yayaya 8 m kala dur,
//    sıkışınca geri manevra, ≤2★ drift parkına girmez (kapıda bekler), devre dışı kalınca durur.
//  - Tutuklama çubuğu (bust): yalnız ≥1★; dolunca W.world.onBusted() bir kez.
// Çizim yok (siren çubuklarını trafik çizer); ses world üzerinden (sirenLevel).
// Sıcak döngülerde tahsis yok: tipli diziler, yeniden kullanılan geçici nesneler, takas-sil.
(function () {
  const DS = window.DS, U = DS.U;
  const VM = DS.VM || { RAIL: 0, PHYS: 1, PARKED: 2, WRECK: 3, HELD: 4 };
  const PS = DS.PS || { WANDER: 0, WAIT: 1, CROSS: 2, DODGE: 3, FLEE: 4, FALL: 5, DOWN: 6, GETUP: 7, IDLE: 8, COP: 9, WAVE: 10, GOTO: 11, GONE: 255 };
  const PR = DS.PR || { CIV: 0, COP: 1, MISSION: 2, DRIVER: 3 };
  const RAIL = VM.RAIL, PHYS = VM.PHYS, PARKED = VM.PARKED, WRECK = VM.WRECK, HELD = VM.HELD;
  const PI = Math.PI, TAU = PI * 2;
  const INF = 1e9;

  // ---------- ayar tablosu (SPEC §5.1) ----------
  const TH = [0, 50, 150, 400, 900, 1800];          // yıldız ısı eşikleri
  const LOSE_T = [0, 8, 12, 20, 30, 40];             // görülmeden kalma süresi (s): 1★ 8 s, ≥2★ tablo
  const CARS = [0, 1, 2, 3, 4, 5];                   // yıldız başına polis aracı
  const FOOT = [0, 1, 2, 2, 3, 3];                   // yıldız başına yaya polis
  const TORQ = [1, 0.85, 0.95, 1.0, 1.05, 1.12];     // polis tork çarpanı
  const RUBBER = 1.15;                               // oyuncudan > 120 m uzakta lastik bandı
  const VIS_CAR = 70, VIS_FOOT = 40;                 // görüş menzili (oyuncu araçta / yayada)
  const NEAR2 = 25 * 25;                             // ×2 tanık mesafesi
  const LOS_DT = 0.25;                               // polis başına görüş ışını aralığı (4 Hz)
  const RAYS = 6, RR_RAYS = 4;                       // karede toplam ışın; sıralı dağıtımın payı
  const DISABLE_HP = 300;                            // devre dışı eşiği
  const BOUNTY_CAP = 10000;
  const PED_REP_T = 4, PED_R2 = 25 * 25;             // yaya ihbar gecikmesi ve menzili
  const BUST_CAR = 1 / 2.5, BUST_FOOT = 1 / 1.0;     // tutuklama çubuğu dolma hızları
  const ROUTE_OFF = 1.2;   // rota takibinde eksenden sağa kayma (m): sağa çekilen trafiğin solundan geçer
  const RING_R = 9.5;      // göbek çevresinde dolaşma yarıçapı (ada 5.4 m)
  const FOOT_V = [0, 4.5, 4.5, 5.5, 5.5, 5.5];       // yaya polis koşu hızı
  const ANG50 = (50 * PI) / 180;

  // suç tablosu: heat, min (en az ★), ped (yaya tanık olabilir), always (tanıksız da sayılır),
  // vict (kurban polis tanıktır: yanında, ×2), maxS (bu yıldızın üstünde yok sayılır), cap (ısı tavanı)
  const CRIMES = {
    STEAL_PARKED: { heat: 15, min: 0, ped: true },
    CARJACK: { heat: 30, min: 0, ped: true },
    PED_KNOCK: { heat: 35, min: 0, ped: true },
    PED_PUNCH: { heat: 10, min: 0, ped: true },
    HIT_CAR: { heat: 25, min: 0 },
    HIT_COP_CAR: { heat: 50, min: 1, vict: true, maxS: 1 },
    PUNCH_COP: { heat: 100, min: 2, vict: true },
    KNOCK_COP: { heat: 100, min: 2, vict: true },
    STEAL_COP_CAR: { heat: 150, min: 2, always: true },
    WRECK_CAR: { heat: 120, min: 0 },
    TAKEDOWN: { heat: 80, min: 0, always: true, maxS: 1 },
    RECKLESS: { heat: 8, min: 0, cap: 60 },
    PROPERTY: { heat: 5, min: 0, cap: 60 },
  };

  // polis aracı sürüş modları
  const M_CHASE = 0, M_ROUTE = 1, M_RAM = 2, M_BOX = 3, M_STOP = 4, M_GATE = 5, M_LEAVE = 6, M_OFF = 7, M_SEARCH = 8;
  const MODE_NAMES = ['chase', 'route', 'ram', 'box', 'stop', 'gate', 'leave', 'disabled', 'search'];
  // SIKIŞTIR yuvaları (oyuncu çerçevesi: x ileri, y sağ)
  const SLOT_X = [7, -7, 0, 0], SLOT_Y = [0, 0, -3.2, 3.2];

  const level = (h) => { for (let k = 5; k > 0; k--) if (h >= TH[k]) return k; return 0; };
  const qv = (Q, k, d) => (Q && typeof Q[k] === 'number' ? Q[k] : d);
  const wrapA = (a) => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };

  // polis aracı durumu (veh.tag): kayıt havuz yuvası yeniden kullanılınca `veh.tag === st` ile doğrulanır
  function makeSt() {
    return {
      police: true, mode: M_ROUTE, disabled: false, leave: false,
      node: -1, prev: -1, ph: 0, resnapT: 0,
      tx: 0, ty: 0, vdes: 0, arrive: false, stopD: 0,
      cx: 0, cy: 0, cv: INF, cr: 0,
      stuckT: 0, revT: 0, revS: 1, backT: 0, slot: -1, wantBox: false,
      foot: -1, waitT: 0, leaveT: 0, disT: 0, offT: 0, pullT: 0,
      lane: -1, ls: 0, baseTorque: 0, lastThr: 0, lastSteer: 0, sees: false, idx: 0, far: 0,
    };
  }

  class Police {
    constructor(W) {
      this.W = W || null;
      this.nav = W ? W.nav : null;
      this.city = W ? W.city : null;
      // ---- herkese açık durum (HUD / dünya okur) ----
      this.stars = 0; this.heat = 0; this.seen = false; this.unseenT = 0;
      this.lkpX = 0; this.lkpY = 0; this.searchR = 60;
      this.takedowns = 0; this.bounty = 0; this.bust = 0; this.flash = false;
      this.cops = [];
      // ---- kota ----
      this.copMax = 3; this.footMax = 2;
      // ---- iç durum ----
      this._t = 0; this._frame = 0; this._rr = 0; this._rrP = 0;
      this._rays = RAYS; this.raysFrame = 0; this.maxRays = 0;
      this._bustFired = false;
      this._spawnT = 0; this._footSpawnT = 0; this._reckT = 0; this._reckLaneT = 0; this._vmaxHere = 11;
      this._flowT = 0; this._fNode = -1; this._fAvoid = false; this._fVer = 0;
      this._gx = 0; this._gy = 0; this._sirenLvl = 0; this._perkT = 0; this._perk = 1;
      // görüş önbelleği: araç kayıtları havuz indeksine göre
      this._vSee = new Uint8Array(64); this._vNext = new Float32Array(64); this._vChk = new Float32Array(64); this._vMark = new Int32Array(64);
      // yaya polisler uid'ye göre (küçük tablo)
      const PN = 16;
      this._pUid = new Int32Array(PN); this._pSee = new Uint8Array(PN); this._pNext = new Float32Array(PN);
      this._pChk = new Float32Array(PN); this._pMark = new Int32Array(PN);
      // takipteki yaya polisler (uid) + sahip araç
      this._fUid = new Int32Array(8); this._fCar = new Array(8).fill(null); this._fSt = new Array(8).fill(null); this.nFoot = 0;
      this._fBack = new Uint8Array(8);
      // bekleyen yaya ihbarları
      this._rT = new Float32Array(8); this._rV = new Float32Array(8); this._rX = new Float32Array(8); this._rY = new Float32Array(8); this._nRep = 0;
      // akış alanı (kavşak grafiği, 100 düğüm)
      const NN = this.nav ? this.nav.nodes.length : 1;
      this._fNext = new Int16Array(NN).fill(-1); this._fDist = new Float32Array(NN).fill(INF);
      // SIKIŞTIR ataması
      this._boxSlotX = new Float32Array(4); this._boxSlotY = new Float32Array(4); this._boxUsed = new Uint8Array(4);
      // drift parkı kapıları (park dışında, yol üzerinde)
      this._gates = new Float32Array(12); this._nGates = 0;
      this._initGates();
      // geçici nesneler
      this._o = { lane: -1, s: 0, x: 0, y: 0, h: 0, k: 0, d: 0, seg: -1, nA: -1, nB: -1, t: 0 };
      this._o2 = { lane: -1, s: 0, x: 0, y: 0, h: 0, k: 0, d: 0 };
      this._sp = { lane: -1, s: 0, x: 0, y: 0, h: 0 };
      this._so = { def: null, setup: null, lane: -1, s: 0, mode: 'phys', v: 10, role: 'cop', keep: true, ctrl: null, tag: null, siren: true, driver: true };
      this._pedOpt = { role: PR.COP, pal: 1, st: PS.COP, h: 0, tx: 0, ty: 0, mx: 0, my: 0 };
      this._stPool = [];
      this.stats = { rays: 0, spawned: 0, promoted: 0, despawned: 0, footSpawned: 0, takedowns: 0, reports: 0 };
      // polis sürüş denetleyicisi (bir kez; traffic.spawn/toPhys'e verilir)
      this.copCtrl = (veh, dt, out) => this._copCtrl(veh, dt, out);
      this.setQuality(W ? W.Q : null);
    }

    // ================= YAŞAM DÖNGÜSÜ =================
    setQuality(Q) {
      this.copMax = Math.max(0, Math.min(6, qv(Q, 'copMax', 3)));
      this.footMax = Math.max(0, Math.min(8, qv(Q, 'footCops', 2)));
    }

    reset() {
      const W = this.W, tr = W ? W.traffic : null, pd = W ? W.peds : null;
      for (let i = 0; i < this.cops.length; i++) {
        const v = this.cops[i];
        if (tr && v && v.alive && v.tag && v.tag.police) tr.despawn(v);
      }
      this.cops.length = 0;
      if (pd) for (let k = 0; k < this.nFoot; k++) { const i = pd.find(this._fUid[k]); if (i >= 0) pd.remove(i); }
      this.nFoot = 0;
      for (let k = 0; k < 8; k++) { this._fCar[k] = null; this._fSt[k] = null; }
      this.stars = 0; this.heat = 0; this.seen = false; this.unseenT = 0; this.takedowns = 0; this.bounty = 0;
      this.bust = 0; this.flash = false; this._bustFired = false; this._nRep = 0; this.searchR = 60;
      this.lkpX = W ? W.px : 0; this.lkpY = W ? W.py : 0;
      this._spawnT = 0; this._footSpawnT = 0; this._reckT = 0; this._fNode = -1; this._flowT = 0; this._sirenLvl = 0;
      this._vSee.fill(0); this._vNext.fill(0); this._vMark.fill(0); this._pUid.fill(0); this._pMark.fill(0);
      this.raysFrame = 0; this.maxRays = 0;
    }

    // ================= SUÇ VE TANIK MODELİ =================
    // §5.1 tablosu. Dönüş: hemen eklenen ısı (yaya ihbarı bekliyorsa 0)
    crime(type, x, y, victim) {
      const c = CRIMES[type];
      const W = this.W;
      if (!c || !W) return 0;
      if (!(typeof x === 'number' && x === x)) x = W.px;
      if (!(typeof y === 'number' && y === y)) y = W.py;
      if (c.maxS !== undefined && this.stars > c.maxS) return 0;   // ≥2★: polise çarpma / takedown ısı eklemez
      let mult = 0;
      if (c.vict) mult = 2;                                          // kurban polis hep tanık (yanında)
      else {
        mult = this._copWitness(x, y, W.onFoot ? VIS_FOOT : VIS_CAR);
        if (mult === 0 && c.always) mult = 1;
      }
      if (mult > 0) {
        const add = c.heat * mult, old = this.heat;
        if (c.cap) { if (this.heat < c.cap) this.heat = Math.min(this.heat + add, c.cap); }
        else this.heat += add;
        if (c.min > 0 && this.heat < TH[c.min]) this.heat = TH[c.min];
        this.lkpX = x; this.lkpY = y;
        this._apply();
        return this.heat - old;
      }
      if (c.ped && this._pedWitness(x, y) && Math.random() < 0.5 && this._nRep < 8) {
        const k = this._nRep++;
        this._rT[k] = PED_REP_T; this._rV[k] = c.heat * 0.5; this._rX[k] = x; this._rY[k] = y;
      }
      return 0;
    }

    // görevler / hata ayıklama: ısıyı eşiğe ayarla, LKP = (x, y)
    setStars(n, x, y) {
      const W = this.W;
      n = U.clamp(n | 0, 0, 5);
      const old = this.stars;
      this.heat = TH[n];
      this.stars = n;
      this.lkpX = typeof x === 'number' ? x : W ? W.px : 0;
      this.lkpY = typeof y === 'number' ? y : W ? W.py : 0;
      this.unseenT = 0; this.takedowns = 0; this._nRep = 0;
      this.searchR = 60 + 30 * n;
      if (n === 0) { this.bounty = 0; this.bust = 0; this._bustFired = false; this._allLeave(); }
      else this._spawnT = 0; // birimler hemen (görüş dışında) doğsun
      if (old !== n) this._emitStars(old, n);
    }

    // 'respray' | 'mission' | 'busted' | 'wasted' | 'debug': yıldızlar ödülsüz sıfırlanır, polis çekilir
    clear(reason) {
      const old = this.stars;
      this.heat = 0; this.stars = 0; this.bounty = 0; this.takedowns = 0; this.bust = 0; this._bustFired = false;
      this.unseenT = 0; this._nRep = 0; this.flash = false; this.searchR = 60;
      this._allLeave();
      this.lastClear = reason || 'debug';
      if (old !== 0) this._emitStars(old, 0);
    }

    isCop(veh) {
      return !!veh && veh.alive === true && veh.role === 'cop' && veh.driver === true && veh.mode !== WRECK;
    }
    isDisabled(veh) {
      return !!veh && !!veh.tag && veh.tag.police === true && veh.tag.disabled === true;
    }
    sirenLevel() { return this._sirenLvl; }
    modeName(veh) { return veh && veh.tag && veh.tag.police ? MODE_NAMES[veh.tag.mode] : ''; }

    // world hasarı uyguladıktan sonra çağırır; hp ≤ 300 -> devre dışı (takedown)
    onCopDamaged(veh, byPlayer) {
      if (!veh || !veh.alive || veh.role !== 'cop') return;
      const st = veh.tag && veh.tag.police ? veh.tag : null;
      if (st !== null && byPlayer && st.mode === M_RAM) st.backT = 1.5; // temas: geri çekil
      if (!veh.driver || veh.hp > DISABLE_HP) return;
      if (st !== null && st.disabled) return;
      this._disable(veh, st, !!byPlayer);
    }

    // ================= KARE GÜNCELLEMESİ =================
    update(dt, W) {
      if (W) this.W = W; else W = this.W;
      if (!W || !(dt > 0)) return;
      if (dt > 0.1) dt = 0.1;
      if (!this.nav && W.nav) this._bindNav(W);
      this._t += dt; this._frame++;
      // önceki pencerenin ışın sayısı (sıralı + olay ışınları)
      const used = RAYS - this._rays;
      this.raysFrame = used; if (used > this.maxRays) this.maxRays = used;
      this._rays = RAYS;
      this._validate(W, dt);
      this._reports(dt);
      this._observe(dt, W);
      this._wanted(dt, W);
      this._units(dt, W);
      this._flow(dt, W);
      this._assignBox(W);
      for (let i = 0; i < this.cops.length; i++) { const v = this.cops[i]; this._drive(v, v.tag, W, dt); }
      this._foot(dt, W);
      this._bustBar(dt, W);
      this._siren(dt, W);
      this.flash = this.stars > 0 && !this.seen;
      this.searchR = 60 + 30 * this.stars;
    }

    _bindNav(W) {
      this.nav = W.nav; this.city = W.city;
      const NN = this.nav.nodes.length;
      this._fNext = new Int16Array(NN).fill(-1); this._fDist = new Float32Array(NN).fill(INF);
      this._initGates();
    }

    _initGates() {
      const c = this.city;
      if (!c || !c.drift) { this._nGates = 0; return; }
      const d = c.drift, SW = 3.5;
      const ix0 = d.x0 + SW, ix1 = d.x1 - SW, iy0 = d.y0 + SW, iy1 = d.y1 - SW;
      const cy = (iy0 + iy1) / 2, nx1 = ix0 + (ix1 - ix0) * 0.3, nx2 = ix0 + (ix1 - ix0) * 0.7;
      const G = this._gates;
      G[0] = d.x0 - 6; G[1] = cy; G[2] = d.x1 + 6; G[3] = cy;
      G[4] = nx1; G[5] = d.y0 - 6; G[6] = nx2; G[7] = d.y0 - 6;
      G[8] = nx1; G[9] = d.y1 + 6; G[10] = nx2; G[11] = d.y1 + 6;
      this._nGates = 6;
    }
    // drift parkının içindeyse (≤2★) en yakın kapının dışındaki nokta; değilse -1
    _gateFor(x, y, out) {
      const c = this.city;
      if (this.stars > 2 || this._nGates === 0 || !c || !c.inDrift(x, y, 1)) return false;
      const G = this._gates;
      let best = -1, bd = INF;
      for (let k = 0; k < this._nGates; k++) {
        const dx = G[k * 2] - x, dy = G[k * 2 + 1] - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = k; }
      }
      out.x = G[best * 2]; out.y = G[best * 2 + 1];
      return true;
    }

    // ---------- yıldız değişimi ----------
    _apply() {
      const n = level(this.heat);
      if (n > this.stars) {
        const old = this.stars;
        if (old === 0) { this.takedowns = 0; this._spawnT = 0; }
        this.stars = n; this.unseenT = 0;
        this._emitStars(old, n);
      }
    }
    _emitStars(o, n) {
      const wo = this.W ? this.W.world : null;
      if (wo && wo.onStars) wo.onStars(o, n);
    }
    _msg(text, kind, sub) {
      const wo = this.W ? this.W.world : null;
      if (wo && wo.msg) wo.msg(text, kind, sub || '');
    }
    // bir yıldız düşür (kaçış / takedown); 0'a inerse kaçış ödülü
    _loseStar(byTakedown) {
      const old = this.stars;
      if (old <= 0) return;
      const n = old - 1;
      if (n === 0) { this._escape(); return; }
      this.stars = n; this.heat = TH[n]; this.unseenT = 0; this.takedowns = 0;
      this.searchR = 60 + 30 * n;
      if (byTakedown) this._msg('POLİS DEVRE DIŞI!', 'big', 'Bir yıldız düştü');
      else this._msg('ATLATTIN!', 'big', 'Bir yıldız düştü');
      this._emitStars(old, n);
    }
    _escape() {
      const old = this.stars, W = this.W;
      const b = Math.round(this.bounty);
      this.stars = 0; this.heat = 0; this.unseenT = 0; this.takedowns = 0; this.bounty = 0; this.bust = 0; this._bustFired = false;
      this.searchR = 60;
      this._allLeave();
      this._msg('KAÇTIN!', 'big', b > 0 ? 'KOVALAMACA ÖDÜLÜ' : '');
      if (old !== 0) this._emitStars(old, 0);
      const wo = W ? W.world : null;
      if (wo && wo.onEscape) wo.onEscape(b);
    }

    // ---------- devre dışı (takedown) ----------
    _disable(veh, st, byPlayer) {
      const W = this.W, wo = W ? W.world : null;
      veh.siren = false;
      veh.driver = false;          // sürücüsüz sıradan araç (binilebilir; artık birim/tanık değil)
      if (st !== null) {
        st.disabled = true; st.mode = M_OFF; st.disT = 0; st.offT = 0; st.leave = false; st.vdes = 0;
        if (st.foot >= 0) this._orphanFoot(st);
      }
      this.stats.takedowns++;
      if (wo && wo.onTakedown) wo.onTakedown(veh);
      const s = this.stars;
      if (s >= 2) {
        this.takedowns++;
        this.bounty = Math.min(BOUNTY_CAP, this.bounty + 150 * s * this._perk);
        if (this.takedowns >= s) this._loseStar(true);
        else this._msg('POLİS DEVRE DIŞI!', 'cop', 'Devre dışı ' + this.takedowns + '/' + s);
      } else if (byPlayer) {
        this.crime('TAKEDOWN', veh.x, veh.y, veh);
        this._msg('POLİS DEVRE DIŞI!', 'cop', '');
      }
    }

    // ================= DOĞRULAMA =================
    _validate(W, dt) {
      const cops = this.cops, tr = W.traffic;
      for (let i = cops.length - 1; i >= 0; i--) {
        const v = cops[i], st = v ? v.tag : null;
        let ok = !!v && v.alive === true && st !== null && typeof st === 'object' && st.police === true && !!tr;
        if (ok && v.mode === WRECK) { v.keep = false; v.tag = null; v.ctrl = null; ok = false; }
        if (!ok) { this._dropAt(i); continue; }
        // dünya onCopDamaged çağırmadıysa güvenlik ağı
        if (!st.disabled && v.hp <= DISABLE_HP && v.mode !== HELD) this._disable(v, st, false);
      }
    }
    _dropAt(i) {
      const cops = this.cops, v = cops[i];
      if (v && v.tag && v.tag.police) { const st = v.tag; if (st.foot >= 0) this._orphanFoot(st); }
      const last = cops.length - 1;
      if (i !== last) cops[i] = cops[last];
      cops.pop();
    }
    // kaydı bırak (despawn) ve listeden çıkar
    _despawnCop(i) {
      const v = this.cops[i], tr = this.W ? this.W.traffic : null;
      const st = v ? v.tag : null;
      if (st && st.police && st.foot >= 0) this._orphanFoot(st);
      if (st && st.police) this._stPool.push(st);
      if (tr && v && v.alive) tr.despawn(v);
      this.stats.despawned++;
      const cops = this.cops, last = cops.length - 1;
      if (i !== last) cops[i] = cops[last];
      cops.pop();
    }
    _newSt() {
      const st = this._stPool.length ? this._stPool.pop() : makeSt();
      st.mode = M_ROUTE; st.disabled = false; st.leave = false; st.node = -1; st.prev = -1; st.ph = 0; st.resnapT = 0;
      st.tx = 0; st.ty = 0; st.vdes = 0; st.arrive = false; st.stopD = 0; st.cx = 0; st.cy = 0; st.cv = INF; st.cr = 0;
      st.stuckT = 0; st.revT = 0; st.revS = 1; st.backT = 0; st.slot = -1; st.wantBox = false; st.foot = -1; st.waitT = 0;
      st.leaveT = 0; st.disT = 0; st.offT = 0; st.pullT = Math.random() * 0.5; st.lane = -1; st.ls = 0; st.baseTorque = 0;
      st.lastThr = 0; st.lastSteer = 0; st.sees = false; st.idx = 0; st.far = 0;
      return st;
    }
    // bir kaydı polis birimi yap (terfi ya da yeni doğan)
    _adopt(veh) {
      const st = this._newSt();
      veh.tag = st; veh.keep = true; veh.siren = this.stars > 0; veh.ctrl = this.copCtrl;
      if (veh.car !== null) st.baseTorque = veh.car.p.torque;
      this.cops.push(veh);
      return st;
    }
    _allLeave() {
      for (let i = 0; i < this.cops.length; i++) {
        const st = this.cops[i].tag;
        if (!st || !st.police || st.disabled || st.leave) continue;
        st.leave = true; st.leaveT = 0; st.lane = -1; st.mode = M_LEAVE;
        this.cops[i].siren = false;
      }
      for (let k = 0; k < this.nFoot; k++) this._fBack[k] = 1;
    }

    // ================= YAYA İHBARLARI =================
    _reports(dt) {
      for (let k = this._nRep - 1; k >= 0; k--) {
        this._rT[k] -= dt;
        if (this._rT[k] > 0) continue;
        const v = this._rV[k], x = this._rX[k], y = this._rY[k];
        // takas-sil
        const last = --this._nRep;
        this._rT[k] = this._rT[last]; this._rV[k] = this._rV[last]; this._rX[k] = this._rX[last]; this._rY[k] = this._rY[last];
        this.stats.reports++;
        if (this.stars >= 1) this.heat += v;
        else if (this.heat < 60) this.heat = Math.min(this.heat + v, 60);
        this.lkpX = x; this.lkpY = y;
        this._apply();
      }
    }

    // ================= GÖRÜŞ =================
    _isObsVeh(r) {
      return r.alive === true && r.role === 'cop' && r.driver === true && r.mode !== WRECK && r.mode !== HELD &&
        !(r.tag && r.tag.police && r.tag.disabled);
    }
    _vGrow(n) {
      let L = this._vSee.length;
      if (n < L) return;
      while (L <= n) L *= 2;
      const a = new Uint8Array(L); a.set(this._vSee); this._vSee = a;
      const b = new Float32Array(L); b.set(this._vNext); this._vNext = b;
      const c = new Float32Array(L); c.set(this._vChk); this._vChk = c;
      const d = new Int32Array(L); d.set(this._vMark); this._vMark = d;
    }
    // uid için yaya polis görüş yuvası
    _pSlot(uid) {
      const P = this._pUid, N = P.length, f = this._frame;
      let free = -1;
      for (let k = 0; k < N; k++) {
        if (P[k] === uid) return k;
        if (free < 0 && (P[k] === 0 || this._pMark[k] < f - 1)) free = k;
      }
      if (free < 0) return -1;
      P[free] = uid; this._pSee[free] = 0; this._pNext[free] = 0; this._pChk[free] = -1; this._pMark[free] = f;
      return free;
    }
    _ray(x0, y0, x1, y1) {
      this._rays--; this.stats.rays++;
      return this.nav.los(x0, y0, x1, y1);
    }
    // her polis 4 Hz, karede ≤ RR_RAYS ışın (sıralı); this.seen
    _observe(dt, W) {
      const nav = this.nav, tr = W.traffic, pd = W.peds, f = this._frame;
      const R = W.onFoot ? VIS_FOOT : VIS_CAR, R2 = R * R, px = W.px, py = W.py;
      let budget = Math.min(RR_RAYS, this._rays), seen = false;
      if (tr && nav) {
        const list = tr.list, n = list.length;
        if (tr.pool && tr.pool.length > this._vSee.length) this._vGrow(tr.pool.length);
        const start = n > 0 ? this._rr % n : 0;
        this._rr++;
        for (let k = 0; k < n; k++) {
          const r = list[(start + k) % n];
          if (!this._isObsVeh(r)) continue;
          const id = r.idx;
          if (id >= this._vSee.length) this._vGrow(id);
          if (this._vMark[id] < f - 1) { this._vSee[id] = 0; this._vNext[id] = 0; this._vChk[id] = -1; } // yeni gözlemci
          this._vMark[id] = f;
          this._vNext[id] -= dt;
          const dx = r.x - px, dy = r.y - py;
          if (dx * dx + dy * dy > R2) { this._vSee[id] = 0; }
          else if (this._vNext[id] <= 0 && budget > 0) {
            budget--;
            this._vSee[id] = this._ray(r.x, r.y, px, py) ? 1 : 0;
            this._vNext[id] = LOS_DT; this._vChk[id] = this._t;
          }
          if (this._vSee[id]) seen = true;
          if (r.tag && r.tag.police) r.tag.sees = this._vSee[id] === 1;
        }
      }
      if (pd && nav) {
        const n = pd.n, role = pd.role, stA = pd.st;
        const start = n > 0 ? this._rrP % n : 0;
        this._rrP++;
        for (let k = 0; k < n; k++) {
          const i = (start + k) % n;
          if (role[i] !== PR.COP) continue;
          const s = stA[i];
          if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE) continue;
          const slot = this._pSlot(pd.uid[i]);
          if (slot < 0) continue;
          this._pMark[slot] = f;
          this._pNext[slot] -= dt;
          const dx = pd.x[i] - px, dy = pd.y[i] - py;
          if (dx * dx + dy * dy > R2) this._pSee[slot] = 0;
          else if (this._pNext[slot] <= 0 && budget > 0) {
            budget--;
            this._pSee[slot] = this._ray(pd.x[i], pd.y[i], px, py) ? 1 : 0;
            this._pNext[slot] = LOS_DT; this._pChk[slot] = this._t;
          }
          if (this._pSee[slot]) seen = true;
        }
      }
      this.seen = seen;
    }
    // suç anında polis tanığı: 0 yok, 1 görüyor, 2 görüyor ve ≤ 25 m
    _copWitness(x, y, R) {
      const W = this.W, nav = this.nav, tr = W.traffic, pd = W.peds;
      if (!nav) return 0;
      const R2 = R * R, ddx = x - W.px, ddy = y - W.py, nearP = ddx * ddx + ddy * ddy < 16;
      let best = 0;
      if (tr) {
        const list = tr.list;
        for (let k = 0; k < list.length; k++) {
          const r = list[k];
          if (!this._isObsVeh(r)) continue;
          const dx = r.x - x, dy = r.y - y, d2 = dx * dx + dy * dy;
          if (d2 > R2) continue;
          const id = r.idx;
          let ok = false;
          if (nearP && id < this._vSee.length && this._vMark[id] >= this._frame - 1 && this._t - this._vChk[id] < 0.3) ok = this._vSee[id] === 1;
          else if (this._rays > 0) ok = this._ray(r.x, r.y, x, y);
          if (ok) { const m = d2 <= NEAR2 ? 2 : 1; if (m > best) best = m; if (best === 2) return 2; }
        }
      }
      if (pd) {
        const n = pd.n;
        for (let i = 0; i < n; i++) {
          if (pd.role[i] !== PR.COP) continue;
          const s = pd.st[i];
          if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE) continue;
          const dx = pd.x[i] - x, dy = pd.y[i] - y, d2 = dx * dx + dy * dy;
          if (d2 > R2) continue;
          let ok = false;
          const slot = nearP ? this._pFind(pd.uid[i]) : -1;
          if (slot >= 0 && this._t - this._pChk[slot] < 0.3) ok = this._pSee[slot] === 1;
          else if (this._rays > 0) ok = this._ray(pd.x[i], pd.y[i], x, y);
          if (ok) { const m = d2 <= NEAR2 ? 2 : 1; if (m > best) best = m; if (best === 2) return 2; }
        }
      }
      return best;
    }
    _pFind(uid) {
      const P = this._pUid;
      for (let k = 0; k < P.length; k++) if (P[k] === uid) return k;
      return -1;
    }
    // suç yerine 25 m içinde (yerde olmayan) sivil yaya var mı
    _pedWitness(x, y) {
      const pd = this.W ? this.W.peds : null;
      if (!pd) return false;
      for (let i = 0; i < pd.n; i++) {
        if (pd.role[i] === PR.COP) continue;
        const s = pd.st[i];
        if (s === PS.DOWN || s === PS.FALL || s === PS.GONE) continue;
        const dx = pd.x[i] - x, dy = pd.y[i] - y;
        if (dx * dx + dy * dy <= PED_R2) return true;
      }
      return false;
    }

    // ================= ARANMA ZAMANLAYICILARI =================
    _wanted(dt, W) {
      const s = this.stars;
      // merkez saygısı ≥ 50: ödül ×1.25 (saniyede bir okunur)
      this._perkT -= dt;
      if (this._perkT <= 0) { this._perkT = 1; this._perk = this._merkez(W) >= 50 ? 1.25 : 1; }
      if (s === 0) {
        this.unseenT = 0;
        if (this.heat > 0) this.heat = Math.max(0, this.heat - dt);
      } else if (this.seen) {
        this.unseenT = 0;
        this.lkpX = W.px; this.lkpY = W.py;
        this.bounty = Math.min(BOUNTY_CAP, this.bounty + 20 * s * dt * this._perk);
      } else {
        const hide = this.nav ? this.nav.hideZone(W.px, W.py) : !!W.hidden;
        this.unseenT += dt * (hide ? 2 : 1);
        if (s === 1) {
          if (this.unseenT >= LOSE_T[1]) this._escape();
        } else if (this.unseenT >= LOSE_T[s]) {
          const dx = W.px - this.lkpX, dy = W.py - this.lkpY, R = 60 + 30 * s;
          if (dx * dx + dy * dy > R * R) this._loseStar(false);
        }
      }
      this._reckless(dt, W);
    }
    _merkez(W) {
      const ms = W.missions;
      if (ms && ms.respect && typeof ms.respect.merkez === 'number') return ms.respect.merkez;
      const g = W.game, ow = g && g.save ? g.save.ow : null;
      if (ow && ow.respect && typeof ow.respect.merkez === 'number') return ow.respect.merkez;
      return 0;
    }
    // RECKLESS: drift ya da hız > şerit sınırı + 8.3 m/s, gören bir polisin 30 m içinde: 3 s'de 8 ısı (≤ 60)
    _reckless(dt, W) {
      if (!W.inCar || this.heat >= 60) { this._reckT = 0; return; }
      const near = this._seeingCopWithin(W.px, W.py, 30);
      if (!near) { this._reckT = Math.max(0, this._reckT - dt); return; }
      this._reckLaneT -= dt;
      if (this._reckLaneT <= 0) {
        this._reckLaneT = 0.5;
        const o = this._o2;
        this._vmaxHere = this.nav && this.nav.nearestLane(W.px, W.py, W.ph, 10, 1.6, o) ? this.nav.lanes[o.lane].vmax : 11;
      }
      const sp = typeof W.pspeed === 'number' ? W.pspeed : 0;
      if (W.drifting || sp > this._vmaxHere + 8.3) {
        this._reckT += dt;
        if (this._reckT >= 3) { this._reckT -= 3; this.crime('RECKLESS', W.px, W.py, null); }
      }
    }
    _seeingCopWithin(x, y, r) {
      const W = this.W, tr = W.traffic, pd = W.peds, r2 = r * r;
      if (tr) {
        const list = tr.list;
        for (let k = 0; k < list.length; k++) {
          const v = list[k];
          if (!this._isObsVeh(v) || v.idx >= this._vSee.length || !this._vSee[v.idx]) continue;
          const dx = v.x - x, dy = v.y - y;
          if (dx * dx + dy * dy <= r2) return true;
        }
      }
      if (pd) {
        for (let i = 0; i < pd.n; i++) {
          if (pd.role[i] !== PR.COP) continue;
          const dx = pd.x[i] - x, dy = pd.y[i] - y;
          if (dx * dx + dy * dy > r2) continue;
          const slot = this._pFind(pd.uid[i]);
          if (slot >= 0 && this._pSee[slot]) return true;
        }
      }
      return false;
    }

    // ================= BİRİMLER =================
    _units(dt, W) {
      const tr = W.traffic, s = this.stars;
      if (!tr || !this.nav) return;
      const want = Math.min(CARS[s], this.copMax);
      let active = 0;
      const vr = W.viewR || 45;
      for (let i = this.cops.length - 1; i >= 0; i--) {
        const v = this.cops[i], st = v.tag;
        const dx = v.x - W.px, dy = v.y - W.py, d = Math.sqrt(dx * dx + dy * dy);
        st.far = d;
        if (st.disabled) {
          st.disT += dt;
          if (!v.vis && (d > vr + 60 || st.disT > 30)) this._despawnCop(i);
          continue;
        }
        if (st.leave) {
          st.leaveT += dt;
          if (!v.vis && (d > vr + 180 || st.leaveT > 10)) this._despawnCop(i);
          else if (st.leaveT > 90) this._despawnCop(i);
          continue;
        }
        active++;
        // fazla birim (yıldız düştü / kalite): en uzaktaki çekilir
        if (active > want) { st.leave = true; st.leaveT = 0; st.lane = -1; st.mode = M_LEAVE; v.siren = false; active--; continue; }
        // çok uzakta kalmış gereken birim: görünmezse bırak, yakında yenisi doğar
        if (!v.vis && d > vr + 400) { this._despawnCop(i); active--; continue; }
        v.siren = s > 0;
      }
      if (active >= want || s === 0) return;
      this._spawnT -= dt;
      if (this._spawnT > 0) return;
      this._spawnT = 0.5;
      // önce 150 m içindeki devriye polisleri terfi et, sonra doğur (setStars sonrası birden fazla)
      for (let tries = 0; tries < 5 && active < want; tries++) {
        if (this._promote(W) || this._spawn(W)) active++;
        else break;
      }
    }
    _promote(W) {
      const tr = W.traffic, list = tr.list;
      let best = null, bd = 150 * 150;
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        if (r.role !== 'cop' || !r.driver || r.mode === WRECK || r.mode === HELD) continue;
        if (r.tag !== null) continue; // görev ya da başka sahip
        const dx = r.x - W.px, dy = r.y - W.py, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = r; }
      }
      if (best === null) return false;
      if (!tr.toPhys(best, true)) return false;
      this._adopt(best);
      this.stats.promoted++;
      return true;
    }
    _spawn(W) {
      const tr = W.traffic, nav = this.nav, sp = this._sp;
      const vr = W.viewR || 45, r0 = vr + 40, r1 = vr + 140;
      const def = DS.vehById ? DS.vehById('polis') : null;
      if (!def || !DS.variantSetup) return false;
      let ok = false;
      // karakol şeritleri halkadaysa öncelikli
      const P = nav.places && nav.places.police ? nav.places.police.spawns : null;
      if (P) {
        for (let k = 0; k < P.length && !ok; k++) {
          const p = P[k], dx = p.x - W.cx, dy = p.y - W.cy, d2 = dx * dx + dy * dy;
          if (d2 < r0 * r0 || d2 > r1 * r1) continue;
          if (this._spawnFree(W, p.x, p.y)) { sp.lane = p.lane; sp.s = p.s; sp.x = p.x; sp.y = p.y; sp.h = p.h; ok = true; }
        }
      }
      let bestScore = -INF, bl = -1, bs = 0;
      if (!ok) {
        const vx = W.pvx || 0, vy = W.pvy || 0, vm = Math.sqrt(vx * vx + vy * vy);
        const fx = vm > 1 ? vx / vm : 0, fy = vm > 1 ? vy / vm : 0;
        for (let tries = 0; tries < 6; tries++) {
          if (!nav.pickLaneSpawn(W.cx, W.cy, r0, r1, fx, fy, Math.random, sp)) break;
          if (!this._spawnFree(W, sp.x, sp.y)) continue;
          // oyuncuya doğru giden şeritler tercih edilir
          const dx = W.px - sp.x, dy = W.py - sp.y, dl = Math.sqrt(dx * dx + dy * dy) || 1;
          const sc = (Math.cos(sp.h) * dx + Math.sin(sp.h) * dy) / dl;
          if (sc > bestScore) { bestScore = sc; bl = sp.lane; bs = sp.s; }
          if (sc > 0.3) break;
        }
        if (bl < 0) return false;
        sp.lane = bl; sp.s = bs;
      }
      const o = this._so;
      o.def = def; o.setup = DS.variantSetup(6); o.lane = sp.lane; o.s = sp.s; o.v = 10; o.ctrl = this.copCtrl; o.tag = null;
      o.siren = this.stars > 0; o.keep = true; o.driver = true; o.role = 'cop'; o.mode = 'phys';
      const veh = tr.spawn(o);
      o.def = null; o.setup = null;
      if (veh === null) return false;
      if (veh.mode !== PHYS) { tr.despawn(veh); return false; } // fizik yuvası yok: sonra yeniden dene
      this._adopt(veh);
      this.stats.spawned++;
      return true;
    }
    _spawnFree(W, x, y) {
      if (typeof W.isVisible === 'function' && W.isVisible(x, y, 4)) return false;
      const list = W.traffic.list;
      for (let k = 0; k < list.length; k++) {
        const r = list[k], dx = r.x - x, dy = r.y - y;
        if (dx * dx + dy * dy < 625) return false;
      }
      if (W.inCar) { const dx = W.px - x, dy = W.py - y; if (dx * dx + dy * dy < 625) return false; }
      return true;
    }

    // ================= AKIŞ ALANI (≤ 2 Hz) =================
    _flow(dt, W) {
      this._flowT -= dt;
      if (this._flowT > 0 || this.cops.length === 0 || !this.nav) return;
      this._flowT = 0.5;
      let gx = this.seen ? W.px : this.lkpX, gy = this.seen ? W.py : this.lkpY;
      const o = this._o2;
      if (this._gateFor(gx, gy, o)) { gx = o.x; gy = o.y; }
      this._gx = gx; this._gy = gy;
      const tn = this.nav.nodeNear(gx, gy), avoid = this.stars <= 2;
      if (tn !== this._fNode || avoid !== this._fAvoid) {
        this.nav.flowTo(tn, this._fNext, this._fDist, avoid);
        this._fNode = tn; this._fAvoid = avoid; this._fVer++;
      }
    }

    // ================= SIKIŞTIR ATAMASI =================
    // yavaş oyuncu (araçta, < 4 m/s): ön/arka/sol/sağ yuvalar, en yakın önce (açgözlü)
    _assignBox(W) {
      const cops = this.cops;
      let nb = 0;
      const boxOk = this.stars > 0 && W.inCar && (W.pspeed || 0) < 4;
      for (let i = 0; i < cops.length; i++) {
        const v = cops[i], st = v.tag;
        st.slot = -1;
        st.wantBox = boxOk && !st.disabled && !st.leave && v.mode === PHYS && ((st.sees && st.far < 35) || st.far < 18);
        if (st.wantBox) nb++;
      }
      if (nb === 0) return;
      const c = Math.cos(W.ph || 0), s = Math.sin(W.ph || 0);
      const SX = this._boxSlotX, SY = this._boxSlotY, used = this._boxUsed;
      for (let k = 0; k < 4; k++) {
        SX[k] = W.px + c * SLOT_X[k] - s * SLOT_Y[k];
        SY[k] = W.py + s * SLOT_X[k] + c * SLOT_Y[k];
        used[k] = 0;
      }
      const n = Math.min(nb, 4);
      for (let a = 0; a < n; a++) {
        let bc = -1, bk = -1, bd = INF;
        for (let i = 0; i < cops.length; i++) {
          const st = cops[i].tag;
          if (!st.wantBox || st.slot >= 0) continue;
          for (let k = 0; k < 4; k++) {
            if (used[k]) continue;
            const dx = SX[k] - cops[i].x, dy = SY[k] - cops[i].y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; bc = i; bk = k; }
          }
        }
        if (bc < 0) break;
        cops[bc].tag.slot = bk; used[bk] = 1;
      }
    }

    // ================= POLİS ARACI KARARLARI (kare başı) =================
    _drive(veh, st, W, dt) {
      const tr = W.traffic, car = veh.car;
      if (veh.mode !== PHYS || car === null) {
        // park edildiyse (yuva alındı vb.) ve hâlâ birimse fiziğe dön
        if (!st.disabled && !st.leave && veh.mode === PARKED && veh.driver && tr && tr.toPhys(veh, true)) {
          veh.ctrl = this.copCtrl; st.baseTorque = veh.car.p.torque;
        }
        return;
      }
      if (st.baseTorque <= 0) st.baseTorque = car.p.torque;
      const s = this.stars;
      // tork: yıldız çarpanı (+ uzakta lastik bandı)
      car.p.torque = st.baseTorque * TORQ[s > 0 ? s : 1] * (st.far > 120 && !st.leave ? RUBBER : 1);
      if (st.revT <= 0 && st.backT > 0) st.backT -= dt;
      st.arrive = false; st.stopD = 0; st.cv = INF;
      if (st.disabled) {
        st.mode = M_OFF; st.vdes = 0; st.tx = car.x + Math.cos(car.h) * 10; st.ty = car.y + Math.sin(car.h) * 10;
        st.arrive = true;
        if (car.speed < 0.5) st.offT += dt; else st.offT = 0;
        // durdu: fizik yuvasını bırak (sürücüsüz park)
        if (st.offT > 1.5 && tr) { tr.toParked(veh); veh.ctrl = null; }
        return;
      }
      if (st.leave) { this._leaveDrive(veh, st, W, dt); this._stuck(veh, st, dt); return; }
      const px = W.px, py = W.py, pvx = W.pvx || 0, pvy = W.pvy || 0, psp = W.pspeed || 0;
      const d = st.far, o = this._o2;
      const vRoute = 14 + 3 * s;
      // yaya polisi dışarıdaysa ve oyuncu durmuşsa bekle
      if (st.foot >= 0 && (W.onFoot || psp < 4)) {
        st.mode = M_STOP; st.vdes = 0; st.tx = car.x + Math.cos(car.h) * 10; st.ty = car.y + Math.sin(car.h) * 10; st.arrive = true;
        st.waitT = 0;
        return;
      }
      if (st.foot >= 0) { st.waitT += dt; if (st.waitT > 4) this._orphanFoot(st); }
      if (W.onFoot) {
        if ((st.sees && d < 45) || d < 20) {
          // yayaya 8 m kala dur
          st.mode = M_STOP;
          const ux = d > 0.1 ? (px - car.x) / d : Math.cos(car.h), uy = d > 0.1 ? (py - car.y) / d : Math.sin(car.h);
          st.tx = px - ux * 8; st.ty = py - uy * 8;
          if (this._gateFor(px, py, o)) { st.tx = o.x; st.ty = o.y; st.mode = M_GATE; }
          st.vdes = 14; st.arrive = true; st.stopD = 0.8;
        } else this._route(veh, st, W, vRoute);
      } else if (st.slot >= 0) {
        st.mode = M_BOX;
        st.tx = this._boxSlotX[st.slot]; st.ty = this._boxSlotY[st.slot];
        if (this._gateFor(st.tx, st.ty, o)) { st.tx = o.x; st.ty = o.y; st.mode = M_GATE; }
        st.vdes = 12; st.arrive = true; st.stopD = 0.8;
      } else if (s >= 2 && st.sees && d < 15 && !this._inGateZone(px, py)) {
        // ÇARP: oyuncunun arka ortasına, oyuncu hızı + 4
        st.mode = M_RAM;
        const c = Math.cos(W.ph || 0), sn = Math.sin(W.ph || 0), hl = W.car && W.car.p ? W.car.p.len * 0.5 : 2.3;
        st.tx = px - c * hl + pvx * 0.2; st.ty = py - sn * hl + pvy * 0.2;
        st.vdes = st.backT > 0 ? Math.max(0, psp - 3) : psp + 4;
        // temas: geri çekil 1.5 s
        const rr = (car.p.len + 2 * hl) * 0.5 + 0.4;
        if (st.backT <= 0 && d < rr) st.backT = 1.5;
      } else if (st.sees && d < 60) {
        // saf takip: öngörülen konum (+ yan kayma, sıraya dizilmesinler)
        st.mode = M_CHASE;
        const tp = Math.min((d / Math.max(car.speed, 1)), 1.5);
        let tx = px + pvx * tp, ty = py + pvy * tp;
        const lat = (st.idx % 3) - 1;
        if (lat !== 0 && d > 12) { const c = Math.cos(W.ph || 0), sn = Math.sin(W.ph || 0); tx += -sn * 2 * lat; ty += c * 2 * lat; }
        st.tx = tx; st.ty = ty; st.vdes = 45;
        if (this._gateFor(tx, ty, o)) { st.tx = o.x; st.ty = o.y; st.mode = M_GATE; st.arrive = true; st.stopD = 1; st.vdes = 14; }
      } else this._route(veh, st, W, vRoute);
      this._stuck(veh, st, dt);
    }
    _inGateZone(x, y) { return this.stars <= 2 && !!this.city && this.city.inDrift(x, y, 1); }

    // sıkışma: v < 1, gaz verilirken 2 s -> 1.2 s ters direksiyonla geri
    _stuck(veh, st, dt) {
      const car = veh.car;
      if (st.revT > 0) { st.stuckT = 0; return; }
      if (car.speed < 1 && st.lastThr > 0.2 && st.vdes > 2) st.stuckT += dt;
      else st.stuckT = Math.max(0, st.stuckT - dt * 2);
      if (st.stuckT > 2) {
        st.stuckT = 0; st.revT = 1.2;
        st.revS = st.lastSteer > 0.05 ? -1 : st.lastSteer < -0.05 ? 1 : Math.random() < 0.5 ? -1 : 1;
        st.node = -1; // geri çıkınca rotayı yeniden kur
      }
    }

    // ---------- akış alanıyla kavşak kavşak rota ----------
    _route(veh, st, W, vRoute) {
      const nav = this.nav, nodes = nav.nodes, next = this._fNext, car = veh.car;
      st.vdes = vRoute;
      st.mode = this.seen ? M_ROUTE : M_SEARCH;
      if (this._fNode < 0) { st.tx = this._gx; st.ty = this._gy; return; }
      st.resnapT -= W.dt > 0 ? W.dt : 1 / 30;
      if (st.node < 0 || st.resnapT <= 0) this._resnap(veh, st);
      if (st.node < 0) { st.tx = this._gx; st.ty = this._gy; return; }
      let N = nodes[st.node];
      // giriş yönü (eksene oturtulmuş)
      let ix = 0, iy = 0;
      if (st.prev >= 0) { ix = N.x - nodes[st.prev].x; iy = N.y - nodes[st.prev].y; }
      else { ix = N.x - car.x; iy = N.y - car.y; }
      if (Math.abs(ix) >= Math.abs(iy)) { ix = ix >= 0 ? 1 : -1; iy = 0; } else { iy = iy >= 0 ? 1 : -1; ix = 0; }
      const dxN = N.x - car.x, dyN = N.y - car.y, dN = Math.sqrt(dxN * dxN + dyN * dyN);
      // rotadan çok uzaklaştıysa yeniden oturt
      if (dN > 260) { st.node = -1; st.resnapT = 0; st.tx = N.x; st.ty = N.y; return; }
      const M = next[st.node];
      if (M < 0) {
        // hedef kavşak: son yaklaşım doğrudan hedef noktaya; aramada çember içinde rastgele dolaş
        st.tx = this._gx; st.ty = this._gy;
        const dgx = this._gx - car.x, dgy = this._gy - car.y;
        if (!this.seen && dgx * dgx + dgy * dgy < 18 * 18) {
          const nb = this._wander(st.node, st.prev);
          if (nb >= 0) { st.prev = st.node; st.node = nb; st.ph = 0; }
          st.vdes = Math.min(vRoute, 12);
        }
        st.arrive = !this.seen; st.stopD = 2;
        return;
      }
      const Mn = nodes[M];
      let ox = Mn.x - N.x, oy = Mn.y - N.y;
      if (Math.abs(ox) >= Math.abs(oy)) { ox = ox >= 0 ? 1 : -1; oy = 0; } else { oy = oy >= 0 ? 1 : -1; ox = 0; }
      const dot = ix * ox + iy * oy;
      if (N.round) {
        // göbek: adanın sağından (açı azalan yönde) dolaş, çıkış açısına gelince sonraki kavşağa
        if (st.ph === 0) {
          st.tx = N.x - iy * RING_R; st.ty = N.y + ix * RING_R;   // sağ(giriş) = (−iy, ix)
          st.cx = N.x; st.cy = N.y; st.cv = 8; st.cr = 18;
          if (dN < 20) st.ph = 1;
        }
        if (st.ph === 1) {
          const ac = Math.atan2(car.y - N.y, car.x - N.x), ae = Math.atan2(oy, ox);
          let rem = ac - ae; rem -= Math.floor(rem / TAU) * TAU; // 0..2π, azalan açı yönünde kalan
          if (rem < 0.45 || rem > TAU - 0.15) { this._advance(st, M); st.tx = Mn.x; st.ty = Mn.y; return; }
          const ta = ac - Math.min(0.9, rem);
          st.tx = N.x + Math.cos(ta) * RING_R; st.ty = N.y + Math.sin(ta) * RING_R;
          st.cv = 7; st.cx = car.x; st.cy = car.y; st.cr = 0;
        }
        return;
      }
      if (st.ph === 0) {
        st.tx = N.x - iy * ROUTE_OFF; st.ty = N.y + ix * ROUTE_OFF;
        if (dot > 0.7) {
          if (dN < Math.max(N.hx, N.hy) + 2) { this._advance(st, M); }
        } else {
          st.cx = N.x; st.cy = N.y; st.cv = dot < -0.5 ? 4 : 8.5; st.cr = 12;
          if (dN < 15) st.ph = 1;
        }
      }
      if (st.ph === 1) {
        // dönüş çıkış noktası: kavşak kutusunun öbür yanı, sağ şerit
        const hw = ox !== 0 ? N.hx : N.hy;
        const ex = N.x + ox * (hw + 3) - oy * ROUTE_OFF, ey = N.y + oy * (hw + 3) + ox * ROUTE_OFF;
        st.tx = ex; st.ty = ey;
        st.cx = N.x; st.cy = N.y; st.cv = dot < -0.5 ? 4 : 8.5; st.cr = 4;
        const along = (car.x - N.x) * ox + (car.y - N.y) * oy;
        const dex = ex - car.x, dey = ey - car.y;
        if (along > hw || dex * dex + dey * dey < 36) { this._advance(st, M); st.tx = Mn.x - oy * ROUTE_OFF; st.ty = Mn.y + ox * ROUTE_OFF; }
      }
    }
    _advance(st, M) { st.prev = st.node; st.node = M; st.ph = 0; st.cv = INF; }
    // en yakın parçanın iki ucundan akış maliyeti küçük olanı (arkada kalan uca ceza)
    _resnap(veh, st) {
      const nav = this.nav, o = this._o, car = veh.car;
      st.resnapT = 4; st.ph = 0;
      if (!nav.snap(car.x, car.y, o)) { st.node = -1; return; }
      const A = nav.nodes[o.nA], B = nav.nodes[o.nB], D = this._fDist;
      const c = Math.cos(car.h), s = Math.sin(car.h);
      const costA = Math.hypot(A.x - car.x, A.y - car.y) + D[o.nA] + ((A.x - car.x) * c + (A.y - car.y) * s < 0 ? 40 : 0);
      const costB = Math.hypot(B.x - car.x, B.y - car.y) + D[o.nB] + ((B.x - car.x) * c + (B.y - car.y) * s < 0 ? 40 : 0);
      if (A.dead && B.dead) { st.node = -1; return; }
      if (B.dead || (!A.dead && costA <= costB)) { st.node = o.nA; st.prev = o.nB; }
      else { st.node = o.nB; st.prev = o.nA; }
      if (nav.nodes[st.prev].dead) st.prev = -1;
    }
    // arama: bulunduğu kavşaktan (geldiği yön hariç) rastgele komşu; çember içindekiler önce
    _wander(nid, from) {
      const nav = this.nav, N = nav.nodes[nid], R = this.searchR;
      let pick = -1, cnt = 0, pickIn = -1, cntIn = 0;
      for (let k = 0; k < 4; k++) {
        const sid = N.legs[k];
        if (sid < 0) continue;
        const sg = nav.segs[sid], m = sg.A === nid ? sg.B : sg.A;
        if (m === from || nav.nodes[m].dead) continue;
        cnt++; if (Math.random() * cnt < 1) pick = m;
        const dx = nav.nodes[m].x - this.lkpX, dy = nav.nodes[m].y - this.lkpY;
        if (dx * dx + dy * dy < R * R) { cntIn++; if (Math.random() * cntIn < 1) pickIn = m; }
      }
      return pickIn >= 0 ? pickIn : pick >= 0 ? pick : from;
    }

    // ---------- çekilme: şeritleri izleyerek uzaklaş (siren kapalı) ----------
    _leaveDrive(veh, st, W, dt) {
      const nav = this.nav, car = veh.car, o = this._o2;
      st.mode = M_LEAVE; veh.siren = false;
      if (st.lane < 0) {
        if (!nav.nearestLane(car.x, car.y, car.h, 25, 1.75, o)) { st.vdes = 0; st.tx = car.x; st.ty = car.y; st.arrive = true; return; }
        st.lane = o.lane; st.ls = o.s;
      }
      let L = nav.lanes[st.lane];
      // yay konumunu araca göre düzelt (öne/arkaya en fazla 2 m)
      nav.laneAt(st.lane, st.ls, o);
      const dl = (car.x - o.x) * Math.cos(o.h) + (car.y - o.y) * Math.sin(o.h);
      st.ls += U.clamp(dl, -2, 2);
      for (let guard = 0; guard < 4 && st.ls > L.len - 2; guard++) {
        if (!L.next || L.next.length === 0) { st.ls = L.len; break; }
        const nx = L.next[(Math.random() * L.next.length) | 0];
        st.ls -= L.len; if (st.ls < 0) st.ls = 0;
        st.lane = nx; L = nav.lanes[nx];
      }
      nav.laneAt(st.lane, st.ls + 12, o);
      st.tx = o.x; st.ty = o.y;
      // önündeki araçlar için basit fren
      let v = 9;
      const c = Math.cos(car.h), s = Math.sin(car.h), list = W.traffic.list;
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        if (r === veh) continue;
        const dx = r.x - car.x, dy = r.y - car.y;
        if (dx * dx + dy * dy > 400) continue;
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        if (lx > 0 && lx < 18 && ly > -1.8 && ly < 1.8) v = Math.min(v, Math.max(0, (lx - 6) * 0.8));
      }
      if (W.inCar) {
        const dx = W.px - car.x, dy = W.py - car.y, lx = dx * c + dy * s, ly = -dx * s + dy * c;
        if (lx > 0 && lx < 18 && ly > -1.8 && ly < 1.8) v = Math.min(v, Math.max(0, (lx - 6) * 0.8));
      }
      st.vdes = v;
    }

    // ================= YAYA POLİSLER =================
    _orphanFoot(st) {
      for (let k = 0; k < this.nFoot; k++) if (this._fSt[k] === st) { this._fSt[k] = null; this._fCar[k] = null; }
      st.foot = -1; st.waitT = 0;
    }
    _footRemoveAt(k) {
      const st = this._fSt[k];
      if (st !== null && st.foot === this._fUid[k]) { st.foot = -1; st.waitT = 0; }
      const last = --this.nFoot;
      this._fUid[k] = this._fUid[last]; this._fCar[k] = this._fCar[last]; this._fSt[k] = this._fSt[last]; this._fBack[k] = this._fBack[last];
      this._fCar[last] = null; this._fSt[last] = null; this._fBack[last] = 0;
    }
    _footIndexOf(uid) {
      for (let k = 0; k < this.nFoot; k++) if (this._fUid[k] === uid) return k;
      return -1;
    }
    _foot(dt, W) {
      const pd = W.peds;
      if (!pd) { this.nFoot = 0; return; }
      const s = this.stars, px = W.px, py = W.py, psp = W.pspeed || 0;
      const vr = W.viewR || 45;
      // kapı noktası (oyuncu araçtaysa sürücü kapısı)
      let tx = px, ty = py;
      if (W.inCar) {
        const h = W.ph || 0, c = Math.cos(h), sn = Math.sin(h);
        const len = W.car && W.car.p ? W.car.p.len : 4.6, wid = W.car && W.car.p ? W.car.p.wid : 1.8;
        tx = px + c * 0.1 * len + sn * (wid / 2 + 0.6); ty = py + sn * 0.1 * len - c * (wid / 2 + 0.6);
      }
      const chase = s > 0 && (W.onFoot || psp < 4);
      const spd = FOOT_V[s > 0 ? s : 1];
      // başıboş polis yayaları (ör. hata ayıklama ile doğan) da yakındaysa kovalamaya katılır
      if (s > 0 && this.nFoot < 8) {
        for (let i = 0; i < pd.n && this.nFoot < 8; i++) {
          if (pd.role[i] !== PR.COP) continue;
          const dx = pd.x[i] - px, dy = pd.y[i] - py;
          if (dx * dx + dy * dy > 3600) continue;
          const uid = pd.uid[i];
          if (this._footIndexOf(uid) >= 0) continue;
          const k = this.nFoot++;
          this._fUid[k] = uid; this._fCar[k] = null; this._fSt[k] = null; this._fBack[k] = 0;
        }
      }
      for (let k = this.nFoot - 1; k >= 0; k--) {
        const i = pd.find(this._fUid[k]);
        if (i < 0 || pd.role[i] !== PR.COP) { this._footRemoveAt(k); continue; }
        const st = this._fSt[k], car = this._fCar[k];
        const carOk = car !== null && st !== null && car.alive === true && car.tag === st && !st.disabled;
        if (!carOk && st !== null) { this._fSt[k] = null; this._fCar[k] = null; }
        const dx = pd.x[i] - px, dy = pd.y[i] - py, d2 = dx * dx + dy * dy;
        const vis = typeof W.isVisible === 'function' ? W.isVisible(pd.x[i], pd.y[i], 1) : true;
        // aranma bitti ya da çekiliyor: araca dön (yoksa görünmeyince kaybol)
        if (s === 0 || this._fBack[k] || !chase) {
          if (carOk && (s === 0 || this._fBack[k] || !chase)) {
            const ex = car.x, ey = car.y, cx = pd.x[i] - ex, cy = pd.y[i] - ey;
            if (cx * cx + cy * cy < 2.6 * 2.6) { pd.remove(i); this._footRemoveAt(k); continue; }
            pd.seek(i, ex, ey, spd);
          } else if (!vis || d2 > (vr + 40) * (vr + 40)) { pd.remove(i); this._footRemoveAt(k); continue; }
          else if (s > 0 && !chase) pd.seek(i, pd.x[i], pd.y[i], spd);
          if (s === 0 && !vis) { pd.remove(i); this._footRemoveAt(k); continue; }
          if (s > 0 && chase) this._fBack[k] = 0;
          continue;
        }
        // çok uzaklaştı ve görünmüyor: kaldır
        if (!vis && d2 > (vr + 40) * (vr + 40)) { pd.remove(i); this._footRemoveAt(k); continue; }
        pd.seek(i, tx, ty, spd);
      }
      // doğurma: duran polis aracından (oyuncuya 12 m içinde)
      const want = Math.min(FOOT[s], this.footMax);
      this._footSpawnT -= dt;
      if (s === 0 || this.nFoot >= want || this._footSpawnT > 0) return;
      if (!(W.onFoot || psp < 1.5)) return;
      for (let i = 0; i < this.cops.length; i++) {
        const v = this.cops[i], st = v.tag;
        if (st.disabled || st.leave || st.foot >= 0 || !v.driver) continue;
        if (v.speed > 1) continue;
        const dx = v.x - px, dy = v.y - py;
        if (dx * dx + dy * dy > 144) continue;
        const c = Math.cos(v.h), sn = Math.sin(v.h), len = v.p ? v.p.len : 4.8, wid = v.p ? v.p.wid : 1.86;
        const o = this._pedOpt;
        o.h = v.h - PI / 2; o.tx = tx; o.ty = ty; o.mx = v.x; o.my = v.y;
        const uid = pd.spawnAt(v.x + c * 0.1 * len + sn * (wid / 2 + 0.6), v.y + sn * 0.1 * len - c * (wid / 2 + 0.6), o);
        this._footSpawnT = 0.4;
        if (uid < 0) continue;
        const pi = pd.find(uid);
        if (pi >= 0) pd.seek(pi, tx, ty, spd);
        const k = this.nFoot++;
        this._fUid[k] = uid; this._fCar[k] = v; this._fSt[k] = st; this._fBack[k] = 0;
        st.foot = uid; st.waitT = 0;
        this.stats.footSpawned++;
        break;
      }
    }

    // ================= TUTUKLAMA ÇUBUĞU =================
    _bustBar(dt, W) {
      if (this.stars < 1) { this.bust = 0; this._bustFired = false; return; }
      const tr = W.traffic, pd = W.peds, px = W.px, py = W.py;
      let near = false, rate;
      if (W.inCar) {
        rate = BUST_CAR;
        if ((W.pspeed || 0) < 1.5) {
          if (tr) {
            const list = tr.list;
            for (let k = 0; k < list.length && !near; k++) {
              const r = list[k];
              if (!this._isObsVeh(r)) continue;
              const dx = r.x - px, dy = r.y - py;
              if (dx * dx + dy * dy <= 36) near = true;
            }
          }
          if (!near && pd) near = this._copPedWithin(pd, px, py, 6);
        }
      } else {
        rate = BUST_FOOT;
        if (pd) near = this._copPedWithin(pd, px, py, 1.2);
        const wk = W.walker;
        if (!near && tr && wk && wk.state === 'down') {
          const list = tr.list;
          for (let k = 0; k < list.length && !near; k++) {
            const r = list[k];
            if (!this._isObsVeh(r)) continue;
            const dx = px - r.x, dy = py - r.y;
            if (dx * dx + dy * dy > 64) continue;
            const c = Math.cos(r.h), s = Math.sin(r.h);
            const lx = Math.abs(dx * c + dy * s) - r.p.len * 0.5, ly = Math.abs(-dx * s + dy * c) - r.p.wid * 0.5;
            const ex = lx > 0 ? lx : 0, ey = ly > 0 ? ly : 0;
            if (ex * ex + ey * ey <= 6.25) near = true;
          }
        }
      }
      if (near) this.bust = Math.min(1, this.bust + rate * dt);
      else this.bust = Math.max(0, this.bust - 2 * rate * dt);
      if (this.bust >= 1 && !this._bustFired) {
        this._bustFired = true;
        const wo = W.world;
        if (wo && wo.onBusted) wo.onBusted();
      }
      if (this.bust <= 0) this._bustFired = false;
    }
    _copPedWithin(pd, x, y, r) {
      const r2 = r * r;
      for (let i = 0; i < pd.n; i++) {
        if (pd.role[i] !== PR.COP) continue;
        const s = pd.st[i];
        if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE) continue;
        const dx = pd.x[i] - x, dy = pd.y[i] - y;
        if (dx * dx + dy * dy <= r2) return true;
      }
      return false;
    }

    // ================= SİREN =================
    _siren(dt, W) {
      let bd = INF;
      const tr = W.traffic;
      for (let i = 0; i < this.cops.length; i++) {
        const v = this.cops[i], st = v.tag;
        if (!v.siren) continue;
        const dx = v.x - W.cx, dy = v.y - W.cy, d = dx * dx + dy * dy;
        if (d < bd) bd = d;
        // önündeki raylı trafik sağa çeksin (≤ 2 Hz)
        st.pullT -= dt;
        if (st.pullT <= 0 && tr && v.speed > 5) { st.pullT = 0.5; tr.pullOver(v.x, v.y, v.h, 35); }
      }
      if (bd >= INF) { this._sirenLvl = 0; return; }
      const d = Math.sqrt(bd);
      this._sirenLvl = d <= 12 ? 1 : Math.max(0, 1 - (d - 12) / 138);
    }

    // ================= SÜRÜŞ DENETLEYİCİSİ (120 Hz, traffic.stepPhys) =================
    _copCtrl(veh, dt, out) {
      const st = veh.tag, car = veh.car;
      out.kick = false; out.clutch = false; out.handbrake = false;
      if (car === null || st === null || typeof st !== 'object' || st.police !== true) {
        out.throttle = 0; out.brake = 0; out.handbrake = true; out.steer = 0; return;
      }
      if (st.revT > 0) {
        // geri manevra: fren (durunca geri vites = geri gaz), ters direksiyon
        st.revT -= dt;
        out.throttle = 0; out.brake = 1; out.steer = st.revS; st.lastThr = 0;
        if (st.revT <= 0) st.lastSteer = 0;
        return;
      }
      const v = car.speed, c = Math.cos(car.h), s = Math.sin(car.h);
      // geri giderken (geri vites) önce dur
      if (car.gear === -1 && car.vxl < -0.5) { out.throttle = 0.6; out.brake = 0; out.steer = 0; return; }
      const rb = car.p.b, rx = car.x - c * rb, ry = car.y - s * rb;
      const dx = st.tx - rx, dy = st.ty - ry, dist = Math.sqrt(dx * dx + dy * dy);
      const lx = c * dx + s * dy, ly = -s * dx + c * dy;
      const alpha = Math.atan2(ly, lx);
      const Ld = U.clamp(0.6 * v, 5, 22), Lu = Math.max(2, Math.min(Ld, dist));
      const kap = (2 * Math.sin(alpha)) / Lu;
      let steer = U.clamp(Math.atan(car.p.L * kap) / car.p.steerMax, -1, 1);
      let vd = st.vdes;
      if (alpha > PI / 2 || alpha < -PI / 2) { steer = alpha > 0 ? 1 : -1; if (vd > 6) vd = 6; } // hedef arkada: tam kilit, yavaş
      const ak = kap < 0 ? -kap : kap;
      if (ak > 1e-4) { const vk = Math.sqrt(7 / ak); if (vk < vd) vd = vk; }
      if (st.cv < INF) {
        const ex = st.cx - car.x, ey = st.cy - car.y, dC = Math.sqrt(ex * ex + ey * ey);
        const vc = Math.sqrt(st.cv * st.cv + 10 * Math.max(0, dC - st.cr));
        if (vc < vd) vd = vc;
      }
      if (st.arrive) {
        const ex = st.tx - car.x, ey = st.ty - car.y, da = Math.sqrt(ex * ex + ey * ey) - st.stopD;
        const va = da > 0 ? Math.sqrt(6 * da) : 0;
        if (va < vd) vd = va;
      }
      if (vd < 0.4 && v < 1.5) {
        // dur ve bekle (fren tutmak geri vitese geçirir: el freni)
        out.throttle = 0; out.brake = 0; out.handbrake = true; out.steer = steer;
        st.lastThr = 0; st.lastSteer = steer;
        return;
      }
      const u = U.clamp(0.35 * (vd - v), -1, 1);
      out.throttle = u > 0 ? u : 0;
      out.brake = u < 0 ? -u : 0;
      if (out.brake > 0 && v < 1.5) { out.brake = 0; out.handbrake = true; }
      if ((alpha > ANG50 || alpha < -ANG50) && v > 12) out.handbrake = true;
      out.steer = steer;
      st.lastThr = out.throttle; st.lastSteer = steer;
    }
  }

  Police.TH = TH;
  Police.CRIMES = CRIMES;
  Police.MODES = MODE_NAMES;
  DS.Police = Police;
})();
