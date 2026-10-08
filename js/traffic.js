'use strict';
// Açık şehir trafiği ve araç kaydı (DS.Traffic) — SPEC §2.3, §2.6.8, §3.3, §5.2.
// Oyuncunun sürdüğü araç dışındaki tüm araçlar (raylı siviller, fizik araçları, polisler, park edilmiş /
// terk edilmiş araçlar, görev araçları, enkazlar) sabit bir havuzdaki kayıtlardır.
//  - RAIL: şerit grafiği üzerinde (lane, s, v, dLat); IDM araç takibi kare başına entegre edilir, karar
//    (sollama, bekçi) Q.aiHz ile kademeli. Kavşaklar: ışık + bağlayıcı rezervasyonu (çatışma maskesi,
//    rütbe önceliği, çıkış alanı). Raylı araçlar birbirine asla çarpmaz (sıralı şerit listeleri + sert sınır).
//  - PHYS: çarpılan araç havuzdan bir DS.Car alır (120 Hz); durulunca şeride döner ya da park edilir.
//  - PARKED / HELD / WRECK: duran kayıtlar (binilebilir / gasp sürüyor / yanmış kabuk).
// Koordinatlar: metre, x doğu, y güney; h: 0 doğu, +PI/2 güney; sürücünün sağı (−sin h, cos h), dLat sağa +.
// Sıcak döngülerde tahsis yok: kayıtlar havuzdan, engeller tipli dizilerde, geçici nesneler yeniden kullanılır.
(function () {
  const DS = window.DS, U = DS.U, C = DS.Collide;
  const VM = DS.VM || { RAIL: 0, PHYS: 1, PARKED: 2, WRECK: 3, HELD: 4 };
  const RAIL = VM.RAIL, PHYS = VM.PHYS, PARKED = VM.PARKED, WRECK = VM.WRECK, HELD = VM.HELD;
  const PI = Math.PI, TAU = PI * 2;
  const BIG = 1e9;
  const BMAX = 8;            // IDM en sert fren (m/s²)
  const LOOK = 40;           // engel ileri bakış (m)
  const MINGAP = 0.4;        // sert sınır: öndeki engelle en az tampon aralığı (m)
  const STOP_OFF = 1.5;      // sanal durma lideri çizginin bu kadar ötesinde (s0 ile tampon çizgiye ~0.5 m kala durur)
  const DEC_PAD = 8;         // karar mesafesi = v²/2b + 8
  const SIB_REAR = 10;       // aynı şeritten ayrılan kardeş bağlayıcıdaki araç, arkası bu kadar ilerleyene dek lider
  const PASS_MAX = 2.8;      // sollama yanal kayması üst sınırı (m)
  const LAT_T = 1.5;         // yanal kayma süresi (smoothstep, s)
  const PULL_LAT = 1.4;      // siren: sağa çekilme (m)
  const YAW_MAX = 0.08;      // yanal kaymada en fazla görsel yönelme (rad)
  const CLAIM_T = 1.0;       // durma çizgisinde bu kadar bekleyen baş araç kavşakta sıra hakkı kazanır
  const E_OK = 0, E_LIGHT = 1, E_CONF = 2, E_EXIT = 3; // kavşak izni sonuçları
  const ANG70 = (70 * PI) / 180, ANG20 = (20 * PI) / 180;
  const K_REC = 1, K_OBS = 2, K_PCAR = 3;                       // engel türleri
  const L_NONE = 0, L_RAIL = 1, L_REC = 2, L_OBS = 3, L_PCAR = 4, L_STOP = 5; // lider türleri
  const TURN_W = { S: 0.6, R: 0.25, L: 0.15, U: 0.001 };
  const SIG_BOX = '#15171c';
  const SIG_COL = ['#ff3b30', '#ffc21a', '#3df07a'];            // kırmızı, sarı, yeşil (light() değeri sırasıyla)
  const SIG_GLOW = ['#ff2a1a', '#ffb000', '#1aff6a'];
  // kavşak köşesindeki lamba başı: bacak (geliş yönü) -> köşe işareti (K: KB, D: KD, G: GD, B: GB)
  const HSX = [-1, 1, 1, -1], HSY = [-1, -1, 1, 1];
  const qv = (Q, k, d) => (Q && typeof Q[k] === 'number' ? Q[k] : d);
  const wrapA = (a) => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };
  const sm01 = (u) => u * u * (3 - 2 * u);

  // ---------- araç–araç teması: 4 eksenli SAT ----------
  // C.obbObb köşe testine dayanır; aynı yönde arkadan çarpmada (dar aracın köşeleri geniş aracın yan
  // kenarına yakın) yanal normal seçip araçları içinden geçirebilir. Burada en az örtüşen eksen seçilir;
  // temas noktası en derindeki köşe (eşit derinlikteki iki köşenin ortası). Çıktı C.obbObb biçiminde:
  // {px, py, nx, ny, pen}, n a'yı b'den dışarı iter. Tahsis yok (out yeniden kullanılır).
  const SATV = new Float64Array(8);
  function satObb(a, b, out) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let best = 1e9, bnx = 0, bny = 0, ref = 0;
    for (let k = 0; k < 4; k++) {
      const o = k < 2 ? a : b;
      const ux = k & 1 ? -o.s : o.c, uy = k & 1 ? o.c : o.s;
      const ra = a.hl * Math.abs(a.c * ux + a.s * uy) + a.hw * Math.abs(-a.s * ux + a.c * uy);
      const rb = b.hl * Math.abs(b.c * ux + b.s * uy) + b.hw * Math.abs(-b.s * ux + b.c * uy);
      const d = dx * ux + dy * uy, ov = ra + rb - Math.abs(d);
      if (ov <= 0) return null;
      if (ov < best - 1e-9) { best = ov; const sg = d > 0 ? -1 : 1; bnx = ux * sg; bny = uy * sg; ref = k < 2 ? 0 : 1; }
    }
    // gömülen kutunun (eksen b'ninse a, a'nınsa b) normal doğrultusunda en derin köşeleri
    const inc = ref === 1 ? a : b, sd = ref === 1 ? -1 : 1; // a köşeleri −n yönünde, b köşeleri +n yönünde derin
    let m1 = -1e9, m2 = -1e9, i1 = 0, i2 = 0;
    for (let k = 0; k < 4; k++) {
      const lx = k & 1 ? inc.hl : -inc.hl, ly = k & 2 ? inc.hw : -inc.hw;
      const px = inc.x + inc.c * lx - inc.s * ly, py = inc.y + inc.s * lx + inc.c * ly;
      SATV[k * 2] = px; SATV[k * 2 + 1] = py;
      const dep = sd * (px * bnx + py * bny);
      if (dep > m1) { m2 = m1; i2 = i1; m1 = dep; i1 = k; } else if (dep > m2) { m2 = dep; i2 = k; }
    }
    let px = SATV[i1 * 2], py = SATV[i1 * 2 + 1];
    if (m1 - m2 < 0.05) { px = (px + SATV[i2 * 2]) * 0.5; py = (py + SATV[i2 * 2 + 1]) * 0.5; }
    out.px = px; out.py = py; out.nx = bnx; out.ny = bny; out.pen = best;
    return out;
  }

  // ---------- kayıt (SPEC §2.3; tüm alanlar her zaman var) ----------
  function makeRec(T, idx) {
    const r = {
      idx, alive: false, mode: PARKED, role: 'civ', def: null, setup: null,
      p: { a: 1.3, b: 1.3, len: 4.6, wid: 1.8 },
      x: 0, y: 0, h: 0, px: 0, py: 0, ph: 0, vx: 0, vy: 0, w: 0, speed: 0,
      steer: 0, axf: 0, ayf: 0, brakeOn: false, revOn: false, rpm: 800,
      lane: -1, s: 0, v: 0, dLat: 0, conn: -1, granted: false, held: -1,
      v0: 11, T: 1.2, s0: 2, a: 1.8, b: 2.5,
      thinkT: 0, waitT: 0, stuckT: 0, honkT: 0, pullT: 0,
      car: null, ev: null, ctrl: null, settleT: 0, recoverT: 0,
      hp: 1000, maxHp: 1000, burnT: -1, driver: true, keep: false, tag: null, siren: false, vis: false, hitCD: 0, ak: null,
      // ---- iç alanlar (yalnız Traffic) ----
      _li: -1, _ah: null, _bh: null, _len: 4.6, _wid: 1.8, _rad: 2.8, _vf: 1, _k: 0,
      _inb: 0, _inbL: -1, _relP: false, _ye: false, _dil: false, _imp: false, _waitR: false, _gw: 0, _wst: -1, _den: -1, _blk: 0, _pullLat: 0,
      _acc: 0, _dl0: 0, _dlT: 0, _dlU: 1, _dlPrev: 0, _passRem: 0, _passTgt: 0, _ost: 0,
      _lk: 0, _lv: 0, _lgap: BIG, _lref: null, _loi: -1, _lpl: false,
      _statT: 0, _physT: 0, _rec: -1, _wreckT: 0, _invT: 0, _parkT: 0, _boostT: 0, _honkN: 0,
      _hw: -3, _wallCD: 0, _d2: 0, _dead: false,
    };
    // şehir çarpışma geri çağrıları (yuva başına bir kez)
    r.ev = {
      hit: (ct, res, kind) => T._wallHit(r, ct, res, kind),
      brk: (col, ct, sp) => T._wallBreak(r, col, sp),
      cone: () => {},
    };
    return r;
  }

  class Traffic {
    constructor(W) {
      this.W = W;
      this.nav = W.nav || null;
      this.city = W.city || null;
      const nav = this.nav, NL = nav ? nav.lanes.length : 0, NN = nav ? nav.nodes.length : 0;
      this.lanes = nav ? nav.lanes : [];
      // şerit başına sıralı raylı araç listesi (çift bağlı: baş = en önde, kuyruk = en arkada)
      this.lHead = new Array(NL).fill(null);
      this.lTail = new Array(NL).fill(null);
      // kavşak rezervasyonları (Nav kalıcı; durum burada, reset() sıfırlar)
      this.occ = new Uint16Array(NL);       // bağlayıcı başına rezervasyon sayısı
      this.amask = new Uint32Array(NN);     // kavşak başına etkin bağlayıcı bit maskesi
      this.inb = new Float32Array(NL);      // şerit girişine ayrılmış (onaylı ama henüz girmemiş) uzunluk
      // sıra hakkı: kavşakta en uzun bekleyen baş araç (çatışan yeni izinleri durdurur; aç kalmayı önler)
      this.claim = new Array(NN).fill(null);
      this.claimC = new Int32Array(NN).fill(-1);
      this.nAct = new Float32Array(NN);     // kavşakta son izin/bırakma zamanı (kavşak hizmet veriyor mu)
      // düz yol şeritleri için yön kosinüs/sinüsü
      this.lc = new Float32Array(NL); this.ls = new Float32Array(NL);
      for (let l = 0; l < NL; l++) { this.lc[l] = Math.cos(this.lanes[l].h); this.ls[l] = Math.sin(this.lanes[l].h); }
      // parça başına yol şeritleri (yanal açıklık denetimi: sollama / kenara çekilme)
      const NS = nav ? nav.segs.length : 0;
      this.segL = new Int32Array(Math.max(1, NS * 4)).fill(-1);
      for (let l = 0; l < (nav ? nav.nRoad : 0); l++) {
        const L = this.lanes[l];
        if (L.seg >= 0) this.segL[L.seg * 4 + (L.dir > 0 ? 0 : 2) + (L.k ? 1 : 0)] = l;
      }
      // şerit başına onu besleyen bağlayıcılar (yanal açıklık denetiminde girişe yaklaşanlar için)
      const fd = [];
      for (let l = 0; l < NL; l++) fd.push([]);
      for (let l = nav ? nav.nRoad : 0; l < NL; l++) fd[this.lanes[l].toLane].push(l);
      this.feed = fd.map((a) => new Int32Array(a));
      this.sigNodes = [];
      if (nav) for (const n of nav.nodes) if (n.signal) this.sigNodes.push(n.id);
      this._sigVis = new Int16Array(Math.max(1, this.sigNodes.length));
      this.pool = []; this.list = []; this.freeRecs = []; this.count = 0;
      this.cars = []; this.carFree = []; this.physN = 0;
      this.Q = null;
      this.qTraffic = 12; this.qPhys = 4; this.qCop = 3; this.aiHz = 8; this.carLights = 2; this.nVar = 8; this.pedPal = 8; this.dtMax = 1 / 15;
      this.t = 0; this.spawnT = 0; this.thinkI = 0;
      // kare başına engel listesi (rayda olmayan kayıtlar + W.obs + oyuncu aracı)
      this.oN = 0; this._oCap = 0;
      this._obsAlloc(96);
      // tarama sonuçları (geçici)
      this._sg = BIG; this._sv = 0; this._sk = L_NONE; this._sr = null; this._si = -1; this._spl = false; this._sc = BIG; this._scv = 0;
      this._ps = 0; this._pl = 0; this._ph = 0;
      this._hx = 0; this._hy = 0; this._dx = 0; this._dy = 0; this._pq = null;
      // geçici nesneler
      this._o = { x: 0, y: 0, h: 0, k: 0, s: 0, lane: -1, d: 0 };
      this._o2 = { x: 0, y: 0, h: 0, k: 0, s: 0, lane: -1, d: 0 };
      this._sp = { lane: -1, s: 0, x: 0, y: 0, h: 0 };
      this._in = { throttle: 0, brake: 0, handbrake: false, steer: 0, kick: false, clutch: false };
      this._ob = { x: 0, y: 0, c: 1, s: 0, hl: 1, hw: 1 };
      this._ct = { px: 0, py: 0, nx: 0, ny: 0, pen: 0 };
      this._hz = new Float32Array(2);                 // eşzamanlı korna yuvaları (en fazla 2)
      this._lr = new Array(16).fill(null); this._ld = new Float32Array(16); // en yakın far seçimi
      this._cnt = { n: 0, rail: 0, phys: 0, parked: 0, wreck: 0, held: 0, cops: 0 };
      this.stats = { spawned: 0, despawned: 0, watchdog: 0, toPhys: 0, toRail: 0, abandoned: 0, honks: 0, grants: 0 };
      this.onConn = null; // test/teşhis kancası: (veh, bağlayıcı) bağlayıcıya girişte
      // trafik denetleyicileri (bir kez oluşturulur; police kendi copCtrl'ünü verir)
      this.civCtrl = (veh, dt, out) => this._civCtrl(veh, dt, out);
      this.recCtrl = (veh, dt, out) => this._recCtrl(veh, dt, out);
      this.setQuality(W.Q || {});
    }

    get n() { return this.list.length; }

    // ================= BÜTÇELER =================
    setQuality(Q) {
      this.Q = Q;
      this.qTraffic = Math.max(0, qv(Q, 'traffic', 12));
      this.qPhys = Math.max(1, qv(Q, 'physCars', 4));
      this.qCop = Math.max(1, qv(Q, 'copMax', 3));
      this.aiHz = Math.max(1, qv(Q, 'aiHz', 8));
      this.carLights = qv(Q, 'carLights', 2);
      this.nVar = Math.max(1, qv(Q, 'carVariants', 8));
      this.pedPal = Math.max(1, qv(Q, 'pedPalettes', 8));
      this.dtMax = qv(Q, 'dtMax', 1 / 15);
      const want = this.qTraffic + this.qCop + 12;
      while (this.pool.length < want) { const r = makeRec(this, this.pool.length); this.pool.push(r); this.freeRecs.push(r); }
    }

    // fizik yuvası sayısı
    physFree() { return Math.max(0, this.qPhys - this.physN); }

    // ================= YAŞAM DÖNGÜSÜ =================
    reset() {
      for (let i = this.list.length - 1; i >= 0; i--) this.despawn(this.list[i]);
      this.lHead.fill(null); this.lTail.fill(null);
      this.occ.fill(0); this.amask.fill(0); this.inb.fill(0);
      this.claim.fill(null); this.claimC.fill(-1); this.nAct.fill(-100);
      this.physN = 0;
      this.carFree.length = 0;
      for (let i = 0; i < this.cars.length; i++) this.carFree.push(this.cars[i]);
      this.thinkI = 0; this.spawnT = 0; this._hz.fill(0); this.oN = 0;
    }

    // dünya başlangıcı: bütçeye kadar hemen doldur (görünür alan dahil)
    fill() {
      const W = this.W;
      if (!this.nav || !W) return;
      const target = this._target(W);
      let amb = 0;
      for (let i = 0; i < this.list.length; i++) if (!this.list[i].keep) amb++;
      for (let tries = 0; tries < target * 10 && amb < target; tries++) if (this._spawnAmbient(W, true)) amb++;
    }

    // ================= KAYIT HAVUZU =================
    _alloc(force) {
      if (this.freeRecs.length) return this.freeRecs.pop();
      if (!force) return null;
      // en uzak görünmez sıradan kaydı boşalt
      let best = null, bd = -1;
      for (let i = 0; i < this.list.length; i++) {
        const r = this.list[i];
        if (r.keep || r.vis) continue;
        if (r._d2 > bd) { bd = r._d2; best = r; }
      }
      if (best !== null) { this.despawn(best); return this.freeRecs.pop(); }
      const r = makeRec(this, this.pool.length);
      this.pool.push(r);
      return r;
    }

    // ortak alanlar: tanım, kurulum, kişilik, durum sıfırlama
    _setup(veh, def, setup, role) {
      veh.def = def; veh.setup = setup; veh.role = role || 'civ';
      const len = def.len || 4.6, wid = def.wid || 1.8;
      veh._len = len; veh._wid = wid; veh._rad = 0.5 * Math.hypot(len, wid) + 0.3;
      const wb = def.wb || len * 0.58, fw = def.fw || 0.55;
      veh.p.len = len; veh.p.wid = wid; veh.p.b = wb * fw; veh.p.a = wb - veh.p.b;
      veh.maxHp = def.maxHp || 1000; veh.hp = veh.maxHp; veh.burnT = -1;
      // sürücü kişiliği (IDM, SPEC §5.2)
      veh._vf = U.rand(0.85, 1.1);
      veh.T = 1.2 * U.rand(0.8, 1.25); veh.s0 = 2;
      const cls = def.cls || 'sport';
      veh.a = cls === 'van' ? 1.3 : cls === 'truck' ? 1.0 : 1.8; veh.b = 2.5;
      veh.v0 = 11 * veh._vf;
      // durum
      veh.mode = PARKED; veh.lane = -1; veh.s = 0; veh.v = 0; veh.dLat = 0; veh.conn = -1; veh.granted = false; veh.held = -1;
      veh.x = 0; veh.y = 0; veh.h = 0; veh.px = 0; veh.py = 0; veh.ph = 0; veh.vx = 0; veh.vy = 0; veh.w = 0; veh.speed = 0;
      veh.steer = 0; veh.axf = 0; veh.ayf = 0; veh.brakeOn = false; veh.revOn = false; veh.rpm = def.idle || 800;
      veh.thinkT = 0; veh.waitT = 0; veh.stuckT = 0; veh.honkT = 0; veh.pullT = 0;
      veh.car = null; veh.ctrl = null; veh.settleT = 0; veh.recoverT = 0;
      veh.driver = true; veh.keep = false; veh.tag = null; veh.siren = false; veh.vis = false; veh.hitCD = 0; veh.ak = null;
      veh._ah = null; veh._bh = null; veh._k = 0; veh._inb = 0; veh._inbL = -1; veh._relP = false; veh._ye = false; veh._dil = false;
      veh._imp = false; veh._waitR = false; veh._gw = 0; veh._wst = -1; veh._den = -1; veh._blk = 0; veh._pullLat = 0; veh._acc = 0; veh._dl0 = 0; veh._dlT = 0; veh._dlU = 1; veh._dlPrev = 0;
      veh._passRem = 0; veh._passTgt = 0; veh._ost = 0; veh._lk = 0; veh._lv = 0; veh._lgap = BIG; veh._lref = null; veh._loi = -1; veh._lpl = false;
      veh._statT = 0; veh._physT = 0; veh._rec = -1; veh._wreckT = 0; veh._invT = 0; veh._parkT = 0; veh._boostT = 0; veh._honkN = 0;
      veh._hw = -3; veh._wallCD = 0; veh._d2 = 0; veh._dead = false;
    }

    _addToList(veh) {
      veh.alive = true;
      veh._li = this.list.length;
      this.list.push(veh);
      this.count = this.list.length;
      this.stats.spawned++;
    }

    // o: {def, setup, x,y,h | lane,s, mode:'rail'|'phys'|'parked', v, role, keep, ctrl, tag, siren, driver}
    spawn(o) {
      o = o || {};
      const veh = this._alloc(!!o.keep || !!o.force);
      if (veh === null) return null;
      const def = o.def || DS.vehById('sedan');
      const setup = o.setup || DS.variantSetup(0);
      this._setup(veh, def, setup, o.role || 'civ');
      veh.keep = !!o.keep;
      veh.tag = o.tag !== undefined ? o.tag : null;
      veh.siren = !!o.siren;
      veh.driver = o.driver !== undefined ? !!o.driver : true;
      this._addToList(veh);
      const nav = this.nav, q = this._o2;
      let lane = -1, s = 0;
      veh.x = typeof o.x === 'number' ? o.x : 0; veh.y = typeof o.y === 'number' ? o.y : 0; veh.h = typeof o.h === 'number' ? o.h : 0;
      if (nav && typeof o.lane === 'number' && o.lane >= 0 && o.lane < this.lanes.length) {
        lane = o.lane; s = typeof o.s === 'number' ? o.s : 0;
        if (this.lanes[lane].conn) { lane = this.lanes[lane].toLane; s = 1; }
        nav.laneAt(lane, s, q);
        veh.x = q.x; veh.y = q.y; veh.h = q.h;
      }
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
      const mode = o.mode || 'rail', v = typeof o.v === 'number' ? o.v : 0;
      if (mode === 'rail') {
        if (lane < 0 && nav && nav.nearestLane(veh.x, veh.y, veh.h, 12, ANG70, q)) { lane = q.lane; s = q.s; }
        if (lane >= 0) {
          this._placeRail(veh, lane, s, v);
          if (o.ctrl) veh.ctrl = o.ctrl;
          return veh;
        }
        return veh; // şerit bulunamadı: park
      }
      if (mode === 'phys') {
        if (this.toPhys(veh, true)) {
          const c = veh.car, ch = Math.cos(veh.h), sh = Math.sin(veh.h);
          c.vx = v * ch; c.vy = v * sh;
          veh.ctrl = o.ctrl !== undefined ? o.ctrl : veh.driver ? this.civCtrl : null;
          this._sync(veh);
        } else if (veh.driver && nav && nav.nearestLane(veh.x, veh.y, veh.h, 12, ANG70, q)) {
          // fizik yuvası yok: raylı başla (çağıran sonra toPhys deneyebilir)
          this._placeRail(veh, q.lane, q.s, v);
          if (o.ctrl) veh.ctrl = o.ctrl;
        }
      }
      return veh;
    }

    despawn(veh) {
      if (!veh || !veh.alive) return;
      if (veh.mode === RAIL) this._unlink(veh);
      this._release(veh);
      if (veh.car !== null) this._freeCar(veh);
      veh.alive = false; veh.tag = null; veh.keep = false; veh.ctrl = null; veh.siren = false; veh.vis = false;
      veh.mode = PARKED; veh.lane = -1; veh._dead = false;
      const list = this.list, i = veh._li, last = list.length - 1;
      if (i >= 0 && i <= last && list[i] === veh) {
        if (i !== last) { const m = list[last]; list[i] = m; m._li = i; }
        list.pop();
      } else {
        const j = list.indexOf(veh);
        if (j >= 0) { const m = list[list.length - 1]; list[j] = m; m._li = j; list.pop(); }
      }
      veh._li = -1;
      this.freeRecs.push(veh);
      this.count = list.length;
      this.stats.despawned++;
    }

    // ================= ŞERİT LİSTELERİ =================
    _link(veh, lane) {
      veh.lane = lane;
      let behind = null, ahead = this.lTail[lane];
      while (ahead !== null && ahead.s < veh.s) { behind = ahead; ahead = ahead._ah; }
      veh._ah = ahead; veh._bh = behind;
      if (ahead !== null) ahead._bh = veh; else this.lHead[lane] = veh;
      if (behind !== null) behind._ah = veh; else this.lTail[lane] = veh;
    }
    _unlink(veh) {
      const l = veh.lane;
      if (l < 0) return;
      const a = veh._ah, b = veh._bh;
      if (a !== null) a._bh = b; else if (this.lHead[l] === veh) this.lHead[l] = b;
      if (b !== null) b._ah = a; else if (this.lTail[l] === veh) this.lTail[l] = a;
      veh._ah = null; veh._bh = null; veh.lane = -1;
    }

    // ================= REZERVASYON =================
    _grant(veh, cid) {
      const Cn = this.lanes[cid];
      this.occ[cid]++;
      this.amask[Cn.node] = (this.amask[Cn.node] | (1 << Cn.bit)) >>> 0;
      veh.held = cid; veh.granted = true; veh._relP = false; veh._gw = 0; veh._den = -1;
      this.nAct[Cn.node] = this.t;
      const amt = veh._len + 3;
      this.inb[Cn.toLane] += amt; veh._inb = amt; veh._inbL = Cn.toLane;
      this.stats.grants++;
    }
    _unhold(veh) {
      const cid = veh.held;
      if (cid < 0) return;
      const Cn = this.lanes[cid];
      if (this.occ[cid] > 0) {
        this.occ[cid]--;
        if (this.occ[cid] === 0) this.amask[Cn.node] = (this.amask[Cn.node] & ~(1 << Cn.bit)) >>> 0;
      }
      this.nAct[Cn.node] = this.t;
      veh.held = -1; veh._relP = false;
    }
    _uninb(veh) {
      const l = veh._inbL;
      if (l < 0) return;
      this.inb[l] -= veh._inb;
      if (this.inb[l] < 0.01) this.inb[l] = 0;
      veh._inbL = -1; veh._inb = 0;
    }
    _release(veh) { this._unhold(veh); this._uninb(veh); veh.granted = false; veh._dil = false; }

    // kavşağa girme izni (SPEC §5.2 mayEnter). Dönüş: E_OK | E_LIGHT (ışık) | E_CONF (çatışma/öncelik) | E_EXIT (çıkış dolu)
    _mayEnter(veh, cid, dStop) {
      const lanes = this.lanes, Cn = lanes[cid], nid = Cn.node, nav = this.nav, nd = nav.nodes[nid], v = veh.v;
      let dil = false;
      if (nd.signal) {
        const st = nav.light(nid, Cn.phase, this.t);
        if (st === 0) return E_LIGHT;
        if (st === 1) {
          if (dStop > 0.3 * v + (v * v) / 6) return E_LIGHT; // durabilir: dur
          dil = true;                                        // ikilem bölgesi: geç
        }
      }
      const cs = nd.conns, imp = veh._imp, conf = Cn.conf;
      // sıra hakkı: daha uzun bekleyen başka bir baş araç çatışan bağlayıcıyı bekliyorsa yeni izin yok
      let mine = false;
      const cl = this.claim[nid];
      if (cl !== null) {
        if (cl === veh) mine = this.t - veh._wst >= CLAIM_T;
        else if (!this._claimOk(cl, nid)) this.claim[nid] = null;
        else if (!imp && this.t - cl._wst >= CLAIM_T && (conf & (1 << lanes[this.claimC[nid]].bit)) !== 0 &&
          !(veh._wst >= 0 && veh._wst <= cl._wst)) return E_CONF;
      }
      if (!imp) {
        if ((conf & this.amask[nid]) !== 0) return E_CONF;
        // sinyalsiz kavşakta yan yol (rütbe 0) ana yoldan (rütbe 1) yaklaşanlara yol verir (sıra hakkı yoksa)
        if (!mine && !nd.signal && !nd.round && Cn.rank === 0) {
          for (let k = 0; k < cs.length; k++) {
            const X = lanes[cs[k]];
            if (X.rank !== 1 || (conf & (1 << X.bit)) === 0) continue;
            const H = this.lHead[X.fromLane];
            if (H === null || H.conn !== X.id || H.granted) continue;
            const dH = lanes[X.fromLane].stopS - H.s - H._len * 0.5;
            if (dH <= 3 * H.v + 6) return E_CONF;
          }
        }
      } else {
        // sabırsız: rezervasyonları yok say, yalnız fiziksel olarak dolu çatışan bağlayıcıları bekle
        for (let k = 0; k < cs.length; k++) {
          const X = lanes[cs[k]];
          if ((conf & (1 << X.bit)) !== 0 && this.lHead[X.id] !== null) return E_CONF;
        }
      }
      // çıkış alanı (yalnız raylı araçlar)
      const T = Cn.toLane, tl = this.lTail[T];
      const rear = tl !== null ? tl.s - tl._len * 0.5 : lanes[T].len + 20;
      if (rear - this.inb[T] < veh._len + 3) return E_EXIT;
      veh._dil = dil;
      return E_OK;
    }
    // sıra hakkı hâlâ geçerli mi: sahibi o kavşağın girişinde, izinsiz, beklemede (ışıklıysa yeşilde)
    _claimOk(c, nid) {
      if (!c.alive || c.mode !== RAIL || c.granted || c._wst < 0 || c.lane < 0 || c.conn !== this.claimC[nid]) return false;
      const L = this.lanes[c.lane];
      if (L.conn || L.to !== nid) return false;
      const nd = this.nav.nodes[nid];
      return !nd.signal || this.nav.light(nid, L.phase, this.t) === 2;
    }

    // dönüş seçimi: S 0.6, R 0.25, L 0.15 (yeniden normalize); U yalnız tek seçenekse. Uzaktaki kavşakta
    // kameraya dönen çıkışlar hafifçe tercih edilir (araçlar baloncukta kalsın).
    _choose(laneId, excl) {
      const L = this.lanes[laneId], nx = L.next;
      if (!nx || nx.length === 0) return -1;
      if (nx.length === 1) return nx[0];
      if (excl === undefined) excl = -1;
      const W = this.W, nd = this.nav.nodes[L.to];
      let far = false, tx = 0, ty = 0;
      if (W) {
        const dx = W.cx - nd.x, dy = W.cy - nd.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d > (W.viewR || 45) + 25) { far = true; tx = dx / d; ty = dy / d; }
      }
      let tot = 0, goal = 0;
      for (let pass = 0; pass < 2; pass++) {
        let acc = 0;
        if (pass === 1) goal = Math.random() * tot;
        for (let k = 0; k < nx.length; k++) {
          const Cn = this.lanes[nx[k]];
          let w = nx[k] === excl ? 0 : TURN_W[Cn.turn] || 0.3;
          if (far) {
            const T = Cn.toLane, dot = this.lc[T] * tx + this.ls[T] * ty;
            if (dot < -0.3) w *= 0.35; else if (dot > 0.3) w *= 1.6;
          }
          if (pass === 0) tot += w;
          else { acc += w; if (w > 0 && acc >= goal) return nx[k]; }
        }
      }
      return nx[nx.length - 1] === excl ? nx[0] : nx[nx.length - 1];
    }

    // ================= RAYLI YERLEŞTİRME =================
    _placeRail(veh, lane, s, v) {
      const L = this.lanes[lane];
      if (s < 0) s = 0; else if (s > L.len) s = L.len;
      veh.mode = RAIL; veh.s = s; veh.v = v > 0 ? v : 0;
      veh.dLat = 0; veh._dl0 = 0; veh._dlT = 0; veh._dlU = 1; veh._dlPrev = 0;
      veh.granted = false; veh.held = -1; veh._relP = false; veh._ye = false; veh._dil = false; veh._imp = false; veh._wst = -1;
      veh.stuckT = 0; veh._passRem = 0; veh.pullT = 0; veh._rec = -1; veh.settleT = 0; veh.recoverT = 0; veh._den = -1;
      this._link(veh, lane);
      veh.v0 = veh._vf * L.vmax;
      veh.conn = L.conn ? -1 : this._choose(lane);
      this._pose(veh, 0);
    }

    // rayda poz: şerit noktası + dLat·sağ; yanal hız yönü hafifçe döndürür (görsel)
    _pose(veh, dt) {
      const o = this._o;
      this.nav.laneAt(veh.lane, veh.s, o);
      const h = o.h, c = Math.cos(h), sn = Math.sin(h), dl = veh.dLat;
      veh.x = o.x - sn * dl; veh.y = o.y + c * dl;
      veh._k = o.k;
      let hv = h;
      if (dt > 0) {
        const rate = (dl - veh._dlPrev) / dt;
        // yanal kaymada hafif yönelme (uzun araçların köşeleri yan şeride taşmasın diye sınırlı)
        if (rate > 0.01 || rate < -0.01) hv += U.clamp(Math.atan2(rate, veh.v > 3 ? veh.v : 3), -YAW_MAX, YAW_MAX) * (veh.v > 1 ? 1 : veh.v);
      }
      veh._dlPrev = dl;
      veh.h = hv;
      veh.vx = c * veh.v; veh.vy = sn * veh.v; veh.speed = veh.v;
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
    }

    // PHYS/PARKED -> RAIL (boş alan varsa). dl: başlangıç yanal kayması (0'a yumuşar)
    _toRail(veh, lane, s, v, dl) {
      const L = this.lanes[lane];
      if (!L || L.conn) return false;
      const hl = veh._len * 0.5;
      if (s < hl + 1) s = hl + 1;
      if (s > L.stopS - hl - 1) return false;
      if (s - hl < this.inb[lane] + 2) return false;
      let behind = null, ahead = this.lTail[lane];
      while (ahead !== null && ahead.s < s) { behind = ahead; ahead = ahead._ah; }
      if (ahead !== null && ahead.s - ahead._len * 0.5 - (s + hl) < 1.5) return false;
      if (behind !== null && s - hl - (behind.s + behind._len * 0.5) < 2 + (behind.v * behind.v) / 8) return false;
      if (veh.mode === PHYS) this._freeCar(veh);
      veh.ctrl = null;
      this._placeRail(veh, lane, s, v);
      if (dl > 0.01 || dl < -0.01) { veh.dLat = dl; veh._dl0 = dl; veh._dlT = 0; veh._dlU = 0; veh._dlPrev = dl; this._pose(veh, 0); }
      this.stats.toRail++;
      return true;
    }

    // ================= MOD GEÇİŞLERİ =================
    _takeCar(def, setup) {
      let car = null;
      if (this.carFree.length) { car = this.carFree.pop(); car.setDef(def, setup); }
      else { car = new DS.Car(def, setup); this.cars.push(car); }
      this.physN++;
      return car;
    }
    _freeCar(veh) {
      const car = veh.car;
      if (car === null) return;
      veh.x = car.x; veh.y = car.y; veh.h = car.h;
      car.events.length = 0;
      this.carFree.push(car);
      veh.car = null;
      this.physN--;
    }
    // yuva gerektiğinde boşaltılacak en eski yerleşmiş sivil fizik aracı
    _physVictim() {
      let best = null, bs = -1;
      for (let i = 0; i < this.list.length; i++) {
        const r = this.list[i];
        if (r.mode !== PHYS || !this._own(r)) continue;
        const sc = r.settleT * 10 + r._physT - r.speed;
        if (sc > bs) { bs = sc; best = r; }
      }
      return best;
    }
    _own(r) { return r.ctrl === null || r.ctrl === this.civCtrl || r.ctrl === this.recCtrl; }

    // RAIL/PARKED/HELD -> PHYS
    toPhys(veh, priority) {
      if (!veh || !veh.alive) return false;
      if (veh.mode === PHYS) return true;
      if (veh.mode === WRECK || !DS.Car) return false;
      if (this.physN >= this.qPhys) {
        if (!priority) return false;
        const vic = this._physVictim();
        if (vic === null || vic === veh) return false;
        this.toParked(vic);
        if (this.physN >= this.qPhys) return false;
      }
      const wasRail = veh.mode === RAIL;
      const v = wasRail ? veh.v : 0, k = veh._k;
      const vmax = wasRail && veh.lane >= 0 ? this.lanes[veh.lane].vmax : 11;
      if (wasRail) { this._unlink(veh); this._release(veh); }
      const car = this._takeCar(veh.def, veh.setup);
      car.reset(veh.x, veh.y, veh.h);
      const c = Math.cos(veh.h), s = Math.sin(veh.h);
      car.vx = v * c; car.vy = v * s; car.w = wasRail ? v * k : 0;
      car.speed = v; car.gear = 1;
      car.rpm = car.p.idle + (2000 * v) / Math.max(1, vmax);
      veh.car = car; veh.mode = PHYS;
      veh.ctrl = veh.driver ? this.civCtrl : null;
      veh.settleT = 0; veh.recoverT = 0; veh._physT = 0; veh._rec = -1;
      veh.dLat = 0; veh._passRem = 0; veh.pullT = 0; veh.conn = -1; veh.granted = false; veh._statT = 0;
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
      this._sync(veh);
      this.stats.toPhys++;
      return true;
    }

    // PHYS -> PARKED (yuvayı bırakır); RAIL/HELD'den de çağrılabilir
    toParked(veh) {
      if (!veh || !veh.alive) return;
      if (veh.mode === PHYS) this._freeCar(veh);
      else if (veh.mode === RAIL) { this._unlink(veh); this._release(veh); }
      this._still(veh, PARKED);
      if (veh.ctrl === this.civCtrl || veh.ctrl === this.recCtrl) veh.ctrl = null;
    }
    // patlama sonrası kabuk: çarpışır, binilmez
    toWreck(veh) {
      if (!veh || !veh.alive) return;
      if (veh.mode === PHYS) this._freeCar(veh);
      else if (veh.mode === RAIL) { this._unlink(veh); this._release(veh); }
      this._still(veh, WRECK);
      veh.driver = false; veh.siren = false; veh.ctrl = null; veh.burnT = -1;
      veh._wreckT = 0; veh._invT = 0;
    }
    // gasp sırasında: dur, HELD
    hold(veh) {
      if (!veh || !veh.alive) return;
      if (veh.mode === PHYS) this._freeCar(veh);
      else if (veh.mode === RAIL) { this._unlink(veh); this._release(veh); }
      this._still(veh, HELD);
    }
    _still(veh, mode) {
      veh.mode = mode; veh.v = 0; veh.vx = 0; veh.vy = 0; veh.w = 0; veh.speed = 0;
      veh.steer = 0; veh.brakeOn = false; veh.revOn = false; veh.axf = 0; veh.ayf = 0;
      veh.lane = -1; veh.conn = -1; veh.granted = false; veh.dLat = 0; veh._passRem = 0; veh.pullT = 0;
      veh._rec = -1; veh._parkT = 0; veh.settleT = 0; veh.recoverT = 0;
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
    }

    // oyuncu bindi: kaydı siler, sürüş bilgisini döner
    takeForPlayer(veh) {
      if (!veh || !veh.alive) return null;
      let vx = 0, vy = 0, w = 0;
      if (veh.mode === PHYS && veh.car !== null) { this._sync(veh); vx = veh.car.vx; vy = veh.car.vy; w = veh.car.w; }
      else if (veh.mode === RAIL) { vx = veh.vx; vy = veh.vy; w = veh.v * veh._k; }
      const info = {
        def: veh.def, setup: veh.setup, x: veh.x, y: veh.y, h: veh.h, vx, vy, w,
        hp: veh.hp, maxHp: veh.maxHp, role: veh.role, tag: veh.tag, driver: veh.driver,
      };
      this.despawn(veh);
      return info;
    }

    // oyuncu indi: aracın pozundan PARKED (hız > 1 m/s ise denetleyicisiz PHYS) kayıt
    adoptFromPlayer(car, info) {
      if (!car) return null;
      info = info || {};
      const vx = car.vx || 0, vy = car.vy || 0, sp = Math.sqrt(vx * vx + vy * vy);
      const veh = this.spawn({
        def: car.def, setup: car.setup, x: car.x, y: car.y, h: car.h, mode: 'parked',
        role: info.role || 'civ', keep: !!info.keep, tag: info.tag !== undefined ? info.tag : null, driver: false, force: true,
      });
      if (veh === null) return null;
      if (typeof info.hp === 'number') veh.hp = Math.min(veh.maxHp, Math.max(0, info.hp));
      if (sp > 1 && this.toPhys(veh, true)) {
        const c = veh.car;
        c.vx = vx; c.vy = vy; c.w = car.w || 0; c.steer = car.steer || 0;
        veh.ctrl = null;
        this._sync(veh);
      }
      return veh;
    }

    // en yakın binilebilir kayıt (enkaz hariç); mesafe noktadan araç kutusuna
    nearestEnterable(x, y, r) {
      let best = null, bd = r;
      const list = this.list;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.mode === WRECK) continue;
        const dx = x - v.x, dy = y - v.y, rr = r + v._rad;
        if (dx * dx + dy * dy > rr * rr) continue;
        const c = Math.cos(v.h), s = Math.sin(v.h);
        const lx = Math.abs(dx * c + dy * s) - v._len * 0.5, ly = Math.abs(-dx * s + dy * c) - v._wid * 0.5;
        const ex = lx > 0 ? lx : 0, ey = ly > 0 ? ly : 0;
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d <= bd) { bd = d; best = v; }
      }
      return best;
    }

    // yayalar için: o bacakta kavşağa dist m'den yakın yaklaşan / geçitteki çıkan / kutudaki araç var mı
    laneBusy(nodeId, leg, dist) {
      const nav = this.nav;
      if (!nav) return false;
      const N = nav.nodes[nodeId];
      if (!N) return false;
      const sid = N.legs[leg];
      if (sid < 0) return false;
      const lanes = this.lanes;
      const ins = N.ins;
      for (let k = 0; k < ins.length; k++) {
        const L = lanes[ins[k]];
        if (L.seg !== sid) continue;
        for (let r = this.lHead[L.id]; r !== null; r = r._bh) {
          if (L.len - r.s - r._len * 0.5 > dist) break;
          if (r.v > 0.5 || r.granted) return true;
        }
      }
      const outs = N.outs;
      for (let k = 0; k < outs.length; k++) {
        const L = lanes[outs[k]];
        if (L.seg !== sid) continue;
        const r = this.lTail[L.id];
        if (r !== null && r.s - r._len * 0.5 < 6) return true;
      }
      const cs = N.conns;
      for (let k = 0; k < cs.length; k++) {
        const Cn = lanes[cs[k]];
        if ((Cn.legIn === leg || Cn.legOut === leg) && this.lHead[Cn.id] !== null) return true;
      }
      const d2 = (dist + 6) * (dist + 6), list = this.list;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.mode !== PHYS || r.speed < 1) continue;
        const dx = r.x - N.x, dy = r.y - N.y;
        if (dx * dx + dy * dy < d2) return true;
      }
      const W = this.W;
      if (W && W.inCar && W.car && (W.pspeed || 0) > 1) {
        const dx = W.car.x - N.x, dy = W.car.y - N.y;
        if (dx * dx + dy * dy < d2) return true;
      }
      return false;
    }

    // siren: r içinde, arkadan yaklaşılan, aynı yönde giden raylı araçlar 3 s sağa çekilir
    pullOver(x, y, h, r) {
      const c = Math.cos(h), s = Math.sin(h), r2 = r * r, list = this.list;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.mode !== RAIL) continue;
        const L = this.lanes[v.lane];
        if (L.conn) continue;
        const dx = v.x - x, dy = v.y - y;
        if (dx * dx + dy * dy > r2) continue;
        if (dx * c + dy * s <= 0) continue;
        if (Math.abs(-dx * s + dy * c) > 12) continue;
        if (Math.abs(wrapA(L.h - h)) > 0.6) continue;
        if (v.pullT <= 0) v._pullLat = v._passRem <= 0 && this._latClear(v, L, PULL_LAT, v.s - v._len - 4, v.s + v._len + 6, 3) ? PULL_LAT : 0;
        v.pullT = 3;
      }
    }

    // ================= KARE GÜNCELLEMESİ =================
    update(dt, W) {
      if (W) this.W = W; else W = this.W;
      if (!this.nav || !W) return;
      if (!(dt > 0)) dt = 0;
      if (dt > this.dtMax) dt = this.dtMax;
      this.t = typeof W.t === 'number' ? W.t : this.t + dt;
      if (this._hz[0] > 0) this._hz[0] -= dt;
      if (this._hz[1] > 0) this._hz[1] -= dt;
      const list = this.list;
      // 0. zamanlayıcılar, görünürlük, kamera uzaklığı
      const cx = W.cx, cy = W.cy;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.hitCD > 0) r.hitCD -= dt;
        if (r._wallCD > 0) r._wallCD -= dt;
        if (r.mode !== RAIL) { if (r.speed < 0.3) r._statT += dt; else r._statT = 0; }
        r.vis = this._isVis(W, r.x, r.y, r._rad + 1.5);
        const dx = r.x - cx, dy = r.y - cy;
        r._d2 = dx * dx + dy * dy;
      }
      // 1. engel listesi
      this._buildObs(W);
      // 2. raylı araçlar: lider, kavşak, IDM, entegrasyon, poz (her kare)
      for (let i = 0; i < list.length; i++) { const r = list[i]; if (r.mode === RAIL) this._stepRail(r, dt); }
      // 3. kademeli düşünme (Q.aiHz)
      const nl = list.length;
      if (nl > 0) {
        let nThink = Math.ceil(nl * this.aiHz * dt);
        if (nThink > nl) nThink = nl;
        for (let k = 0; k < nThink; k++) {
          if (this.thinkI >= nl) this.thinkI = 0;
          const r = list[this.thinkI++];
          if (r.mode === RAIL && !r._dead) this._think(r);
        }
      }
      // 4. diğer modlar
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r._dead) continue;
        if (r.mode === PHYS) this._updPhys(r, dt);
        else if (r.mode === PARKED) this._updParked(r, dt);
        else if (r.mode === WRECK) {
          r._wreckT += dt;
          if (!r.vis) r._invT += dt; else r._invT = 0;
          if (r._wreckT > 25 || r._invT > 10) r._dead = true;
        }
      }
      // fizik bütçesi küçüldüyse: kare başına bir sivili park et
      if (this.physN > this.qPhys) { const vic = this._physVictim(); if (vic !== null) this.toParked(vic); }
      // 5. nüfus: halka dışı silme, fazlalık, doğma
      this._population(dt, W);
    }

    _isVis(W, x, y, r) {
      if (W.isVisible) return W.isVisible(x, y, r);
      const v = W.view;
      if (!v) return false;
      return x + r >= v.x0 && x - r <= v.x1 && y + r >= v.y0 && y - r <= v.y1;
    }

    // ---------- engeller ----------
    _obsAlloc(n) {
      const old = this._oCap;
      const grow = (A, T) => { const a = new T(n); if (A) a.set(A.subarray(0, Math.min(old, n))); return a; };
      this.oX = grow(this.oX, Float32Array); this.oY = grow(this.oY, Float32Array);
      this.oVX = grow(this.oVX, Float32Array); this.oVY = grow(this.oVY, Float32Array);
      this.oH = grow(this.oH, Float32Array); this.oHL = grow(this.oHL, Float32Array); this.oHW = grow(this.oHW, Float32Array);
      this.oK = grow(this.oK, Uint8Array); this.oPl = grow(this.oPl, Uint8Array);
      const ref = new Array(n).fill(null);
      if (this.oRef) for (let i = 0; i < Math.min(old, n); i++) ref[i] = this.oRef[i];
      this.oRef = ref;
      this._oCap = n;
    }
    _buildObs(W) {
      const list = this.list;
      let n = 0;
      const need = list.length + 26;
      if (need > this._oCap) this._obsAlloc(need + 32);
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.mode === RAIL) continue;
        this.oX[n] = r.x; this.oY[n] = r.y; this.oVX[n] = r.vx; this.oVY[n] = r.vy; this.oH[n] = r.h;
        this.oHL[n] = r._len * 0.5; this.oHW[n] = r._wid * 0.5; this.oK[n] = K_REC; this.oPl[n] = 0; this.oRef[n] = r;
        n++;
      }
      let pcx = 1e9, pcy = 1e9;
      const pc = W.inCar ? W.car : null;
      if (pc && pc.p) {
        pcx = pc.x; pcy = pc.y;
        this.oX[n] = pc.x; this.oY[n] = pc.y; this.oVX[n] = pc.vx || 0; this.oVY[n] = pc.vy || 0; this.oH[n] = pc.h;
        this.oHL[n] = pc.p.len * 0.5; this.oHW[n] = pc.p.wid * 0.5; this.oK[n] = K_PCAR; this.oPl[n] = 1; this.oRef[n] = null;
        n++;
      }
      const ob = W.obs, no = Math.min(W.nObs | 0, 24);
      if (ob) {
        for (let k = 0; k < no; k++) {
          const b = k * 5, x = ob[b], y = ob[b + 1];
          if (Math.abs(x - pcx) < 1 && Math.abs(y - pcy) < 1) continue; // oyuncu aracının kopyası
          this.oX[n] = x; this.oY[n] = y; this.oVX[n] = ob[b + 2]; this.oVY[n] = ob[b + 3]; this.oH[n] = 0;
          this.oHL[n] = ob[b + 4]; this.oHW[n] = ob[b + 4]; this.oK[n] = K_OBS; this.oPl[n] = k === 0 && !W.inCar ? 1 : 0; this.oRef[n] = null;
          n++;
        }
      }
      // eski referansları bırak (bir sonraki karede yeniden yazılır)
      for (let i = n; i < this.oN; i++) this.oRef[i] = null;
      this.oN = n;
    }

    // şerit izdüşümü: this._ps (şerit s), this._pl (yanal, sağa +), this._ph (yön). Şeride yakınsa true.
    _proj(L, ox, oy) {
      const p = L.pts;
      if (p.length === 8) {
        const c = this.lc[L.id], s = this.ls[L.id], dx = ox - p[0], dy = oy - p[1];
        this._ps = dx * c + dy * s; this._pl = -dx * s + dy * c; this._ph = L.h;
        return true;
      }
      let bk = 0, bd = 1e18;
      for (let k = 0; k < p.length; k += 4) {
        const ex = ox - p[k], ey = oy - p[k + 1], d = ex * ex + ey * ey;
        if (d < bd) { bd = d; bk = k; }
      }
      const h = p[bk + 2], c = Math.cos(h), s = Math.sin(h), ex = ox - p[bk], ey = oy - p[bk + 1];
      this._ps = p[bk + 3] + ex * c + ey * s; this._pl = -ex * s + ey * c; this._ph = h;
      return bd < 36;
    }

    // Aracın yolu (şerit -> bağlayıcı -> sonraki şerit) üzerindeki en yakın engel (IDM lideri adayı).
    // Sonuç: _sg (tampon aralığı), _sv (hızı), _sk (tür), _sr (kayıt), _si (engel indeksi), _spl (oyuncu mu),
    //        _sc/_scv (kayıt engelleri için sert sınır aralığı / hızı)
    _scan(veh, L) {
      let bg = BIG, bv = 0, bk = L_NONE, br = null, bi = -1, bpl = false, cg = BIG, cv = 0;
      const n = this.oN;
      if (n > 0) {
        const lanes = this.lanes, hl = veh._len * 0.5, hw = veh._wid * 0.5, x = veh.x, y = veh.y, dl = veh.dLat;
        const road = !L.conn, c1 = road ? veh.conn : L.toLane;
        const L1 = c1 >= 0 ? lanes[c1] : null, c2 = road && L1 !== null ? L1.toLane : -1, L2 = c2 >= 0 ? lanes[c2] : null;
        const off1 = L.len - veh.s, off2 = L1 !== null ? off1 + L1.len : BIG;
        const R2 = (LOOK + 10) * (LOOK + 10);
        for (let i = 0; i < n; i++) {
          if (this.oRef[i] === veh) continue;
          const ox = this.oX[i], oy = this.oY[i], dx = ox - x, dy = oy - y;
          if (dx * dx + dy * dy > R2) continue;
          let u = -BIG;
          if (this._proj(L, ox, oy) && this._ps >= veh.s - hl && this._ps <= L.len + 0.5) u = this._ps - veh.s;
          else if (L1 !== null && this._proj(L1, ox, oy) && this._ps >= -0.5 && this._ps <= L1.len + 0.5) u = off1 + this._ps;
          else if (L2 !== null && this._proj(L2, ox, oy) && this._ps >= -0.5 && this._ps <= LOOK) u = off2 + this._ps;
          if (u <= 0 || u > LOOK + 6) continue;
          const kind = this.oK[i];
          let ol, ow, mg;
          if (kind === K_OBS) { ol = this.oHL[i]; ow = ol; mg = 0.4; }
          else {
            const dh = this.oH[i] - this._ph, ca = Math.abs(Math.cos(dh)), sa = Math.abs(Math.sin(dh));
            ol = ca * this.oHL[i] + sa * this.oHW[i]; ow = sa * this.oHL[i] + ca * this.oHW[i]; mg = 0.25;
          }
          const lat = this._pl - dl;
          if (lat >= hw + ow + mg || lat <= -(hw + ow + mg)) continue;
          const g = u - ol - hl;
          let vo = this.oVX[i] * Math.cos(this._ph) + this.oVY[i] * Math.sin(this._ph);
          if (vo < 0) vo = 0;
          if (g < bg) { bg = g; bv = vo; bk = kind === K_REC ? L_REC : kind === K_PCAR ? L_PCAR : L_OBS; br = this.oRef[i]; bi = i; bpl = this.oPl[i] === 1; }
          if (kind === K_REC && g < cg) { cg = g; cv = vo; }
        }
      }
      this._sg = bg; this._sv = bv; this._sk = bk; this._sr = br; this._si = bi; this._spl = bpl; this._sc = cg; this._scv = cv;
    }

    // ---------- raylı adım (her kare) ----------
    _stepRail(veh, dt) {
      const lanes = this.lanes, nav = this.nav;
      let L = lanes[veh.lane];
      const hl = veh._len * 0.5, v = veh.v;
      if (veh.pullT > 0) veh.pullT -= dt;
      if (veh._boostT > 0) veh._boostT -= dt;
      if (veh.honkT > 0) veh.honkT -= dt;
      // ---- 1. raylı lider ----
      let gap = BIG, vl = 0, lk = L_NONE, lref = null, loi = -1, lpl = false, cg = BIG, cv = 0;
      const ah = veh._ah;
      if (ah !== null) {
        gap = ah.s - ah._len * 0.5 - veh.s - hl; vl = ah.v; lk = L_RAIL; lref = ah;
      } else {
        const rem = L.len - veh.s;
        if (!L.conn) {
          const nx = L.next;
          for (let k = 0; k < nx.length; k++) {
            const c = nx[k], t = this.lTail[c];
            if (t !== null) {
              const tr = t.s - t._len * 0.5;
              if (c === veh.conn || tr < SIB_REAR) {
                const g = rem + tr - hl;
                if (g < gap) { gap = g; vl = t.v; lk = L_RAIL; lref = t; }
              }
            } else if (c === veh.conn) {
              const tt = this.lTail[lanes[c].toLane];
              if (tt !== null) {
                const g = rem + lanes[c].len + tt.s - tt._len * 0.5 - hl;
                if (g < gap) { gap = g; vl = tt.v; lk = L_RAIL; lref = tt; }
              }
            }
          }
        } else {
          // aynı giriş şeridinden ayrılan kardeş bağlayıcılar başlangıçta üst üste biner
          const sib = lanes[L.fromLane].next;
          for (let k = 0; k < sib.length; k++) {
            const c = sib[k];
            if (c === veh.lane) continue;
            let t = this.lTail[c];
            while (t !== null && t.s <= veh.s) t = t._ah;
            if (t !== null) {
              const tr = t.s - t._len * 0.5;
              if (tr < SIB_REAR) {
                const g = tr - veh.s - hl;
                if (g < gap) { gap = g; vl = t.v; lk = L_RAIL; lref = t; }
              }
            }
          }
          const tt = this.lTail[L.toLane];
          if (tt !== null) {
            const g = rem + tt.s - tt._len * 0.5 - hl;
            if (g < gap) { gap = g; vl = tt.v; lk = L_RAIL; lref = tt; }
          }
        }
      }
      if (lk === L_RAIL) { cg = gap; cv = vl; }
      // ---- 2. rayda olmayan engeller ----
      this._scan(veh, L);
      if (this._sg < gap) { gap = this._sg; vl = this._sv; lk = this._sk; lref = this._sr; loi = this._si; lpl = this._spl; }
      if (this._sc < cg) { cg = this._sc; cv = this._scv; }
      // ---- 3. kavşak: izin, sarı yeniden değerlendirme, durma çizgisi ----
      if (!L.conn) {
        if (veh.conn >= 0) {
          const dStop = L.stopS - veh.s - hl;
          const dd = (v * v) / (2 * veh.b) + DEC_PAD;
          if (veh.granted && veh.held >= 0) {
            // onaylı ama kutuya girmemiş: sarının başında bir kez yeniden değerlendir
            if (!veh._ye && nav.nodes[L.to].signal) {
              const st = nav.light(L.to, L.phase, this.t);
              if (st !== 2) {
                veh._ye = true;
                if (dStop > 0.3 * v + (v * v) / 6) this._release(veh); else veh._dil = true;
              }
            }
            // izin alındıktan sonra önüne bir engel girdi ve durdu: rezervasyonu tutma
            if (veh.granted) {
              if (v < 0.3 && this._sg < dStop) { veh._gw += dt; if (veh._gw > 2) { this._release(veh); veh._gw = 0; } }
              else veh._gw = 0;
            }
          } else if (ah === null && veh.held < 0 && !veh._relP && dStop <= dd && this._sg >= dStop &&
            this._sg < dStop + 5.1 + lanes[veh.conn].len + 8 && this._sv < 1 && veh._blk < 6) {
            // kavşak kutusunda (ya da çıkışında) duran bir engel var: kutuya girip maskeyi tutma; çizgide
            // bekle, 3 s sonra bir kez başka yöne dön; 6 s sonra yine de gir (içeride yanından geçer)
            const b0 = veh._blk;
            veh._blk += dt;
            if (b0 <= 3 && veh._blk > 3) veh.conn = this._choose(veh.lane, veh.conn);
          } else if (ah === null && veh.held < 0 && !veh._relP && dStop <= dd && this._sg >= dStop) {
            if (!(this._sg < dStop + 5.1 + lanes[veh.conn].len + 8 && this._sv < 1)) veh._blk = 0;
            const e = this._mayEnter(veh, veh.conn, dStop), nid = L.to;
            veh._den = e;
            if (e === E_OK) {
              this._grant(veh, veh.conn);
              if (nav.nodes[nid].signal && nav.light(nid, L.phase, this.t) !== 2) veh._ye = true;
              veh._wst = -1;
              if (this.claim[nid] === veh) this.claim[nid] = null;
            } else if (e === E_CONF) {
              // beklemeye başla, en eskiyse sıra hakkını al
              if (veh._wst < 0) veh._wst = this.t;
              const cl = this.claim[nid];
              if (cl === null || (cl !== veh && (cl._wst > veh._wst || !this._claimOk(cl, nid)))) { this.claim[nid] = veh; this.claimC[nid] = veh.conn; }
            } else {
              if (e === E_LIGHT) veh._wst = -1;
              if (this.claim[nid] === veh) this.claim[nid] = null;
            }
          }
          if (!veh.granted && dStop <= dd + 5) {
            const g = dStop + STOP_OFF;
            if (g < gap) { gap = g; vl = 0; lk = L_STOP; lref = null; loi = -1; lpl = false; }
            if (g < cg) { cg = g; cv = 0; }
          }
        } else {
          const g = L.len - veh.s - hl; // çıkışsız şerit: sonu duvar
          if (g < gap) { gap = g; vl = 0; lk = L_STOP; lref = null; loi = -1; lpl = false; }
          if (g < cg) { cg = g; cv = 0; }
        }
      }
      // ---- 4. IDM ----
      let v0 = veh.v0 * (veh._boostT > 0 ? 1.2 : 1);
      if (!L.conn && veh.conn >= 0) {
        const Cn = lanes[veh.conn];
        let dEnd = L.len - veh.s - hl;
        if (dEnd < 0) dEnd = 0;
        const va = Math.sqrt(Cn.vmax * Cn.vmax + 2 * veh.b * dEnd);
        if (va < v0) v0 = va;
      }
      let freeA;
      if (veh.pullT > 0) freeA = v > 0.2 ? -3.5 : -v / (dt > 1e-3 ? dt : 1e-3); // siren: kenara çek ve dur
      else if (v0 < 0.1) freeA = -veh.b;
      else { const q = v / v0; freeA = veh.a * (q <= 1 ? 1 - q * q * q * q : 1 - q); }
      let acc = freeA;
      if (gap < BIG) {
        const dv = v - vl;
        let ss = v * veh.T + (v * dv) / (2 * Math.sqrt(veh.a * veh.b));
        if (ss < 0) ss = 0;
        ss += veh.s0;
        const r = ss / (gap > 0.2 ? gap : 0.2);
        acc = freeA - veh.a * r * r;
        // acil fren: çarpışmaya kalan süre < 1.2 s
        if (lk !== L_STOP && v > vl + 0.1 && gap / (v - vl) < 1.2) acc = -BMAX;
      }
      if (acc < -BMAX) acc = -BMAX;
      // ---- 5. entegrasyon (balistik) + sert sınır ----
      let ds = v * dt + 0.5 * acc * dt * dt;
      if (ds < 0) ds = 0;
      let nv = v + acc * dt;
      if (nv < 0) nv = 0;
      if (cg < BIG) {
        const mx = cg - MINGAP;
        if (ds > mx) { ds = mx > 0 ? mx : 0; if (nv > cv) nv = cv; }
      }
      veh.v = nv; veh._acc = acc;
      veh.s += ds;
      // ---- 6. şerit geçişleri ----
      while (veh.s > L.len) {
        if (!L.conn) {
          const c = veh.conn;
          if (c < 0 || !veh.granted) { veh.s = L.len; veh.v = 0; break; }
          const rem = veh.s - L.len;
          this._unlink(veh); veh.s = rem; this._link(veh, c);
          veh.v0 = veh._vf * lanes[c].vmax;
          if (this.onConn !== null) this.onConn(veh, lanes[c]);
        } else {
          const T = L.toLane, rem = veh.s - L.len;
          this._unlink(veh); veh.s = rem; this._link(veh, T);
          this._uninb(veh);
          veh._relP = veh.held >= 0;
          veh.granted = false; veh._ye = false; veh._dil = false; veh._imp = false; veh.stuckT = 0; veh._gw = 0; veh._wst = -1; veh._den = -1; veh._blk = 0;
          veh.v0 = veh._vf * lanes[T].vmax;
          veh.conn = this._choose(T);
        }
        L = lanes[veh.lane];
      }
      // arka bağlayıcıdan çıktı: kavşak maskesini bırak
      if (veh._relP && veh.s - hl >= 0) this._unhold(veh);
      // ---- 7. yanal kayma: kenara çekilme / sollama ----
      let tgt = 0;
      if (veh._passRem > 0) {
        veh._passRem -= ds;
        if (veh._passRem > 0) tgt = veh._passTgt; else veh._passRem = 0;
      }
      if (veh.pullT > 0 && !L.conn && veh._passRem <= 0) tgt = veh._pullLat; // sollama ortasında: yalnız fren
      if (tgt - veh._dlT > 1e-3 || veh._dlT - tgt > 1e-3) { veh._dl0 = veh.dLat; veh._dlT = tgt; veh._dlU = 0; }
      if (veh._dlU < 1) {
        veh._dlU += dt / LAT_T;
        if (veh._dlU > 1) veh._dlU = 1;
        veh.dLat = veh._dl0 + (veh._dlT - veh._dl0) * sm01(veh._dlU);
      }
      // ---- 8. poz ----
      this._pose(veh, dt);
      // ---- 9. durum, bekçi zamanlayıcıları, korna ----
      veh._lk = lk; veh._lv = vl; veh._lgap = gap; veh._lref = lref; veh._loi = loi; veh._lpl = lpl;
      // meşru bekleme: kırmızı ışık, kenara çekilme, hizmet veren (son 8 s'de izin/bırakma olan) kavşakta sıra
      // bekleme ve bunların arkasındaki kuyruk; bekçi yalnız gerçekten tıkananları sayar
      let wr = false;
      if (veh.pullT > 0) wr = true;
      else if (lk === L_STOP && !L.conn) {
        if (nav.nodes[L.to].signal && nav.light(L.to, L.phase, this.t) !== 2) wr = true;
        else if (veh._den === E_CONF && this.t - this.nAct[L.to] < 8) wr = true;
      } else if (lk === L_RAIL && lref !== null && lref._waitR && gap < 15) wr = true;
      veh._waitR = wr;
      if (veh.v < 0.3 && !wr) veh.stuckT += dt; else if (veh.v > 1) veh.stuckT = 0;
      if ((lk === L_OBS || lk === L_PCAR) && vl < 0.3) veh._ost += dt; else veh._ost = 0;
      if (lpl && veh.v < 0.5) veh.waitT += dt; else veh.waitT = 0;
      if (veh.honkT <= 0) {
        if (veh.waitT > 1.5) { if (this._honk(veh)) veh.honkT = 6 + 4 * Math.random(); }
        else if (veh._honkN > 0 && this._honk(veh)) { veh._honkN--; veh.honkT = veh._honkN > 0 ? 0.6 : 6 + 4 * Math.random(); }
      }
      // görsel alanlar yalnız görünürken
      if (veh.vis) {
        const k = veh._k, wb = veh.p.a + veh.p.b;
        veh.steer = Math.atan(wb * k); veh.w = veh.v * k;
        veh.brakeOn = acc < -1 || (veh.v < 0.05 && lk !== L_NONE && gap < 3);
        const d = veh.def;
        veh.rpm = (d.idle || 800) + 2600 * Math.min(1, veh.v / 14) + (acc > 0.3 ? 500 : 0);
      } else veh.brakeOn = false;
    }

    // ---------- düşünme (Q.aiHz, kademeli) ----------
    _think(veh) {
      // bekçi: görünmezken 12 s takılı -> sil; görünürken 25 s -> sabırsız
      if (!veh.keep && veh.stuckT > 12 && !veh.vis) { veh._dead = true; this.stats.watchdog++; return; }
      if (veh.stuckT > 25 && veh.vis) veh._imp = true;
      if (veh.pullT <= 0) this._passScan(veh, this.lanes[veh.lane]);
    }

    // Duran (rayda olmayan) engeli sollama: yol merkezine doğru (sola, dLat −) kayma, arka 2 m geçene dek
    _passScan(veh, L) {
      const n = this.oN;
      if (n === 0) return;
      const hl = veh._len * 0.5, hw = veh._wid * 0.5, x = veh.x, y = veh.y;
      const R2 = (LOOK + 10) * (LOOK + 10);
      // en yakın engel (şerit merkezi koridorunda)
      let near = BIG, nearStill = false, req = 0, reqR = 0, end = -BIG;
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
          if (this.oRef[i] === veh) continue;
          const ox = this.oX[i], oy = this.oY[i], dx = ox - x, dy = oy - y;
          if (dx * dx + dy * dy > R2) continue;
          const u = this._pathProj(veh, L, ox, oy);
          if (u <= 0 || u > LOOK) continue;
          const P = this._pq, road = !P.conn, kind = this.oK[i];
          let ol, ow;
          if (kind === K_OBS) { ol = this.oHL[i]; ow = ol; }
          else {
            const dh = this.oH[i] - this._ph, ca = Math.abs(Math.cos(dh)), sa = Math.abs(Math.sin(dh));
            ol = ca * this.oHL[i] + sa * this.oHW[i]; ow = sa * this.oHL[i] + ca * this.oHW[i];
          }
          const lat = this._pl;
          if (Math.abs(lat) >= hw + ow + 0.3) continue;
          // durgun mu (ve durma çizgisinde kuyrukta beklemiyor mu)
          let still;
          if (kind === K_REC) {
            const r = this.oRef[i];
            still = r._statT > 2 && !(road && r.mode === PHYS && r.driver && this._ps > P.stopS - 8);
          } else {
            // oyuncu yolda duruyorsa önce korna, sonra sollama
            still = i === veh._loi && veh._ost > 2 && (this.oPl[i] === 0 || veh.waitT > 2.5) && !(road && this._ps > P.stopS - 8 && this._redAt(P));
          }
          if (pass === 0) {
            if (u < near) { near = u; nearStill = still; if (still) { req = hw + ow + 0.4 - lat; reqR = hw + ow + 0.4 + lat; end = u + ol; } }
          } else if (still && nearStill && u - ol <= end + 10 && u + ol > end) {
            // zincir: arka arkaya duran engeller tek sollamada geçilir
            end = u + ol;
            const rq = hw + ow + 0.4 - lat, rr = hw + ow + 0.4 + lat;
            if (rq > req) req = rq;
            if (rr > reqR) reqR = rr;
            changed = true;
          } else if (!still && nearStill && u - ol <= end + 4 && u > near) {
            nearStill = false; // sollama yolunda hareketli bir şey var
          }
        }
        if (pass === 0 && (!nearStill || near >= BIG)) break;
        if (pass > 0 && !changed) break;
      }
      if (!nearStill || near >= BIG) return;
      // yol merkezine doğru (sola) kayma; 2.8 m'yi aşıyorsa ve yolda yer varsa bordür tarafından (sağdan) geç
      let tgt;
      if (req <= PASS_MAX) tgt = -(req < 0.3 ? 0.3 : req);
      else {
        if (L.conn) return;
        const room = this.nav.segs[L.seg].w * 0.5 - L.d - hw - 0.3;
        if (reqR > room || reqR > PASS_MAX) return; // sığmıyor: bekle (bekçi devreye girer)
        tgt = reqR < 0.3 ? 0.3 : reqR;
      }
      const rem = end + hl + 2;
      if (rem <= veh._passRem && Math.abs(tgt) <= Math.abs(veh._passTgt) + 1e-3 && tgt * veh._passTgt > 0) return; // zaten kapsanıyor
      // karşı/yan şeritte aynı anda kayan (sollayan, kenara çekilen) araçla çakışma: bekle (kutu içinde
      // çatışan bağlayıcılar zaten maskeyle kapalı)
      const tp = rem / (veh.v > 3 ? veh.v : 3) + LAT_T;
      if (!L.conn) { if (!this._latClear(veh, L, tgt, veh.s - hl - 2, veh.s + rem + hl, tp)) return; }
      else {
        const off = L.len - veh.s; // bağlayıcıdan sonraki şeride taşan sollama: o parçayı denetle
        if (rem + hl > off && !this._latClear(veh, this.lanes[L.toLane], tgt, -off - hl - 2, rem - off + hl, tp)) return;
      }
      veh._passTgt = tgt;
      if (rem > veh._passRem) veh._passRem = rem;
    }
    // Aynı parçadaki diğer şeritlerde, [s0, s1] (bu şeridin s'i) boyunca, bu araç dLat = tgt'deyken yanal
    // olarak çakışacak (şimdiki ya da hedef kaymasıyla) raylı araç var mı. tp: karşıdan gelenlerin yaklaşma süresi.
    _latClear(veh, L, tgt, s0, s1, tp) {
      const base = L.seg * 4, my = L.d + tgt;
      for (let k = 0; k < 4; k++) {
        const ol = this.segL[base + k];
        if (ol < 0 || ol === L.id) continue;
        const O = this.lanes[ol], same = O.dir === L.dir, fd = this.feed[ol];
        // o şeritteki araçlar (f = -1) ve şeride giren bağlayıcılardakiler (s, şeridin başına göre negatif)
        for (let f = -1; f < fd.length; f++) {
          const cl = f < 0 ? ol : fd[f], sh = f < 0 ? 0 : this.lanes[cl].len;
          for (let r = this.lTail[cl]; r !== null; r = r._ah) {
            if (r === veh) continue;
            // r'nin kaplayacağı aralık: şimdiki yeri + manevra süresince gideceği yol + kalan sollama mesafesi
            const hl = r._len * 0.5, rs = r.s - sh, ext = r.v * tp + (r._passRem > 0 ? r._passRem : 0);
            if (same) { if (rs + hl + ext < s0 || rs - hl > s1) continue; }
            else { const so = O.len - rs; if (so + hl < s0 || so - hl - ext > s1) continue; }
            const need = (veh._wid + r._wid) * 0.5 + 0.35 + YAW_MAX * 0.5 * (veh._len + r._len);
            // şimdiki kayma, yumuşatma hedefi ve (bu karede verilmiş olabilecek) sollama/çekilme kararı
            const dt3 = r._passRem > 0 ? r._passTgt : r.pullT > 0 ? r._pullLat : r._dlT;
            const sg = same ? 1 : -1;
            if (Math.abs(sg * (O.d + r.dLat) - my) < need || Math.abs(sg * (O.d + r._dlT) - my) < need ||
              Math.abs(sg * (O.d + dt3) - my) < need) return false;
          }
        }
      }
      return true;
    }
    // yol izdüşümü (şu anki parça + sonraki parça): araç merkezinden yol boyu uzaklık; _pl, _ph, _ps ve
    // _pq (izdüşülen şerit) yazılır. Yolda değilse −BIG.
    _pathProj(veh, L, ox, oy) {
      if (this._proj(L, ox, oy) && this._ps >= veh.s - veh._len * 0.5 && this._ps <= L.len + 0.5) { this._pq = L; return this._ps - veh.s; }
      const c1 = L.conn ? L.toLane : veh.conn;
      if (c1 >= 0) {
        const L1 = this.lanes[c1];
        if (this._proj(L1, ox, oy) && this._ps >= -0.5 && this._ps <= (L1.len < LOOK ? L1.len : LOOK) + 0.5) { this._pq = L1; return L.len - veh.s + this._ps; }
      }
      return -BIG;
    }
    _redAt(L) {
      const nd = this.nav.nodes[L.to];
      return nd.signal && this.nav.light(L.to, L.phase, this.t) !== 2;
    }

    _honk(veh) {
      const hz = this._hz, k = hz[0] <= 0 ? 0 : hz[1] <= 0 ? 1 : -1;
      if (k < 0) return false;
      hz[k] = 0.35;
      const W = this.W;
      if (W && W.audio && W.audio.hornNPC) W.audio.hornNPC(Math.hypot(veh.x - W.px, veh.y - W.py));
      this.stats.honks++;
      return true;
    }

    // ---------- PHYS (her kare) ----------
    _updPhys(veh, dt) {
      veh._physT += dt;
      if (veh.speed < 0.5 && Math.abs(veh.w) < 0.3) veh.settleT += dt; else veh.settleT = 0;
      if (!this._own(veh)) return; // polis vb. kendi denetleyicisiyle yönetir
      if (veh._rec >= 0) {
        veh.recoverT += dt;
        const R = this.lanes[veh._rec];
        this._proj(R, veh.x, veh.y);
        const lat = this._pl, s = this._ps, dh = wrapA(veh.h - R.h);
        if (Math.abs(lat) < 1.2 && Math.abs(dh) < ANG20 && s > veh._len * 0.5 + 1 && s < R.stopS - veh._len * 0.5 - 1) {
          if (this._toRail(veh, veh._rec, s, Math.min(veh.speed, 5), lat)) { this._mood(veh); return; }
        }
        if (veh.recoverT > 6) this.toParked(veh);
        return;
      }
      if (veh.settleT >= 1 || veh._physT > 20) {
        if (!veh.driver || veh.role === 'player' || veh.role === 'mission') { this.toParked(veh); return; }
        if (veh.hp < 350 || Math.random() < 0.1) { this._abandon(veh); return; }
        const o = this._o2;
        if (!this.nav.nearestLane(veh.x, veh.y, veh.h, 12, ANG70, o)) { this.toParked(veh); return; }
        if (!veh.vis) {
          // görünmez: doğrudan şeride otur
          if (this._toRail(veh, o.lane, o.s, 0, 0)) this._mood(veh); else this.toParked(veh);
        } else {
          veh._rec = o.lane; veh.recoverT = 0; veh.ctrl = this.recCtrl;
        }
      }
    }
    // kurtarma sonrası ruh hali: %70 hızlanıp uzaklaş, %20 kızgın korna (%10 terk durulmada)
    _mood(veh) {
      if (Math.random() < 0.78) veh._boostT = 10;
      else veh._honkN = 2;
    }
    // sürücü aracı bırakıp kaçar (karikatür); araç binilebilir park kaydı olur
    _abandon(veh) {
      this.toParked(veh);
      veh.driver = false;
      this.stats.abandoned++;
      const W = this.W, pd = W ? W.peds : null;
      if (pd && pd.spawnAt) {
        const c = Math.cos(veh.h), s = Math.sin(veh.h), f = 0.1 * veh._len, l = veh._wid * 0.5 + 0.6;
        const PR = DS.PR || { DRIVER: 3 }, PS = DS.PS || { FLEE: 4 };
        pd.spawnAt(veh.x + c * f + s * l, veh.y + s * f - c * l, { pal: 2 + ((Math.random() * this.pedPal) | 0), role: PR.DRIVER, st: PS.FLEE, h: veh.h - PI / 2 });
      }
    }
    _updParked(veh, dt) {
      veh._parkT += dt;
      // sürücüsü içinde, görünmez sıradan park kaydı: arada bir şeride dönmeyi dene
      if (veh._parkT > 5 && veh.driver && !veh.keep && !veh.vis && veh.role !== 'player' && veh.role !== 'mission') {
        veh._parkT = 3;
        const o = this._o2;
        if (this.nav.nearestLane(veh.x, veh.y, veh.h, 12, ANG70, o)) this._toRail(veh, o.lane, o.s, 0, 0);
      }
    }

    // ---------- nüfus ----------
    _target(W) {
      let f = 1;
      const c = W.clock;
      if (typeof c === 'number' && c >= 1 && c < 5) f = 0.5;
      else if (W.night) f = 0.7;
      if (W.env && W.env.rain) f *= 0.8;
      return Math.max(0, Math.round(this.qTraffic * f));
    }
    _population(dt, W) {
      const list = this.list, far = (W.viewR || 45) + 75, far2 = far * far;
      let amb = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (r._dead) { this.despawn(r); continue; }
        if (r.keep) continue;
        if (!r.vis && r._d2 > far2) { this.despawn(r); continue; }
        amb++;
      }
      const target = this._target(W);
      // fazlalık: kare başına en fazla 2, en uzak görünmezden başlayarak
      for (let k = 0; k < 2 && amb > target; k++) {
        let best = null, bd = -1;
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (r.keep || r.vis) continue;
          if (r._d2 > bd) { bd = r._d2; best = r; }
        }
        if (best === null) break;
        this.despawn(best); amb--;
      }
      this.spawnT += dt;
      if (this.spawnT >= 0.25) {
        this.spawnT = 0;
        for (let k = 0; k < 2 && amb < target; k++) { if (this._spawnAmbient(W, false)) amb++; else break; }
      }
    }
    _spawnAmbient(W, fill) {
      const nav = this.nav, sp = this._sp, vr = W.viewR || 45;
      const r0 = fill ? 0 : vr + 10, r1 = vr + 50;
      let fx = 0, fy = 0;
      const pv = Math.hypot(W.pvx || 0, W.pvy || 0);
      if (pv > 2) { fx = W.pvx / pv; fy = W.pvy / pv; }
      for (let tries = 0; tries < 4; tries++) {
        if (!nav.pickLaneSpawn(W.cx, W.cy, r0, r1, fx, fy, Math.random, sp)) return null;
        if (this._spawnOk(W, sp, fill)) return this._spawnAt(sp);
      }
      return null;
    }
    _spawnOk(W, sp, fill) {
      const L = this.lanes[sp.lane];
      if (L.conn) return false;
      if (!fill && this._isVis(W, sp.x, sp.y, 4)) return false;
      const px = sp.x - W.px, py = sp.y - W.py;
      if (px * px + py * py < 225) return false;
      const list = this.list;
      for (let i = 0; i < list.length; i++) {
        const r = list[i], dx = r.x - sp.x, dy = r.y - sp.y;
        if (dx * dx + dy * dy < 144) return false;
      }
      if (sp.s - 4 < this.inb[sp.lane] + 4) return false;
      return true;
    }
    _spawnAt(sp) {
      const vi = this._pickVariant(sp.x, sp.y);
      const V = DS.TRAFFIC_VARIANTS;
      const veh = this._alloc(false);
      if (veh === null) return null;
      let def, setup, role;
      if (vi >= 0 && V) { const tv = V[vi]; def = DS.vehById(tv.id); setup = DS.variantSetup(vi); role = tv.role || 'civ'; }
      else { def = DS.vehById('sedan'); setup = DS.variantSetup(0); role = 'civ'; }
      this._setup(veh, def, setup, role);
      this._addToList(veh);
      this._placeRail(veh, sp.lane, sp.s, 0);
      const L = this.lanes[sp.lane];
      let v = 0.8 * veh.v0;
      const dStop = L.stopS - sp.s - veh._len * 0.5;
      const vs = Math.sqrt(6 * Math.max(0, dStop - 1));
      if (vs < v) v = vs;
      veh.v = v;
      this._pose(veh, 0);
      return veh;
    }
    _pickVariant(x, y) {
      const V = DS.TRAFFIC_VARIANTS;
      if (!V || !V.length) return -1;
      const n = Math.min(V.length, this.nVar);
      const nav = this.nav, zone = nav.zoneNear ? nav.zoneNear(x, y) : nav.zoneAt(x, y);
      let cops = 0;
      for (let i = 0; i < this.list.length; i++) { const r = this.list[i]; if (r.role === 'cop' && r.driver) cops++; }
      const copOk = cops < this.qCop - 1;
      let tot = 0, goal = 0;
      for (let pass = 0; pass < 2; pass++) {
        let acc = 0;
        if (pass === 1) { if (tot <= 0) return 0; goal = Math.random() * tot; }
        for (let i = 0; i < n; i++) {
          const tv = V[i];
          if (tv.role === 'cop' && !copOk) continue;
          let w = tv.w || 1;
          if (tv.zone && tv.zone === zone) w *= tv.zm || 3;
          if (pass === 0) tot += w;
          else { acc += w; if (acc >= goal) return i; }
        }
      }
      return 0;
    }

    // ================= FİZİK (120 Hz) =================
    stepPhys(dt, playerCar) {
      const W = this.W, list = this.list, city = this.city, env = W ? W.env : null, inp = this._in;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.mode !== PHYS) continue;
        const car = r.car;
        car.px = car.x; car.py = car.y; car.ph = car.h;
        r.px = car.x; r.py = car.y; r.ph = car.h;
        inp.throttle = 0; inp.brake = 0; inp.handbrake = false; inp.steer = 0; inp.kick = false; inp.clutch = false;
        const f = r.ctrl !== null ? r.ctrl : r.driver ? this.civCtrl : null;
        if (f !== null) f(r, dt, inp);
        else if (r._physT > 1.5) inp.handbrake = true; // sürücüsüz: bir süre sonra el freni (kendiliğinden durur)
        car.updateSteer(dt, inp.steer, 0.6);
        car.step(dt, inp, city, env);
        if (city) city.collideCar(car, r.ev);
        car.events.length = 0;
        this._sync(r);
      }
      if (playerCar) this._contacts(playerCar, null);
      for (let i = 0; i < list.length; i++) { const r = list[i]; if (r.mode === PHYS) this._contacts(r.car, r); }
    }
    _sync(r) {
      const c = r.car;
      r.x = c.x; r.y = c.y; r.h = c.h; r.vx = c.vx; r.vy = c.vy; r.w = c.w;
      r.speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
      r.steer = c.steer; r.axf = c.axf; r.ayf = c.ayf; r.brakeOn = c.brakeOn; r.revOn = c.revOn; r.rpm = c.rpm;
    }
    // dinamik gövde (oyuncu aracı ya da NPC fizik aracı) ile diğer kayıtların temasları
    _contacts(body, rec) {
      const list = this.list, W = this.W;
      const br = 0.5 * Math.sqrt(body.p.len * body.p.len + body.p.wid * body.p.wid);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === rec) continue;
        if (rec !== null && o.mode === PHYS && o.idx < rec.idx) continue; // fizik çifti bir kez
        const dx = o.x - body.x, dy = o.y - body.y, rr = br + o._rad;
        if (dx * dx + dy * dy > rr * rr) continue;
        const A = body.obb();
        let B;
        if (o.mode === PHYS) B = o.car.obb();
        else { B = this._ob; B.x = o.x; B.y = o.y; B.c = Math.cos(o.h); B.s = Math.sin(o.h); B.hl = o._len * 0.5; B.hw = o._wid * 0.5; }
        const ct = satObb(A, B, this._ct);
        if (ct === null) continue;
        let vn = 0;
        if (o.mode === PHYS) { vn = C.resolve2(body, o.car, ct, 0.3, 0.3).vn; this._sync(o); }
        else if (o.mode === RAIL) {
          if (this.toPhys(o, false)) { vn = C.resolve2(body, o.car, ct, 0.3, 0.3).vn; this._sync(o); }
          else { vn = C.resolve(body, ct, 0.3, 0.3, o.vx, o.vy).vn; o.v *= 0.5; }
        } else {
          const rel = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
          if (o.mode === PARKED && rel > 2 && this.toPhys(o, false)) { vn = C.resolve2(body, o.car, ct, 0.3, 0.3).vn; this._sync(o); }
          else vn = C.resolve(body, ct, 0.25, 0.3, 0, 0).vn;
        }
        if (rec !== null) this._sync(rec);
        if (vn > 1) {
          const key = rec !== null ? rec.idx : -2;
          if (!(o.hitCD > 0 && o._hw === key)) {
            o.hitCD = 0.15; o._hw = key;
            if (W && W.world && W.world.onVehHit) W.world.onVehHit(rec, o, vn, ct.px, ct.py);
          }
        }
      }
    }
    _wallHit(r, ct, res, kind) {
      if (!(res.vn > 1) || r._wallCD > 0) return;
      r._wallCD = 0.15;
      const W = this.W;
      if (W && W.world && W.world.onVehWall) W.world.onVehWall(r, res.vn, kind, ct.px, ct.py);
    }
    _wallBreak(r, col, sp) {
      const W = this.W;
      if (W && W.world && W.world.onVehWall) W.world.onVehWall(r, sp, col.kind, col.x, col.y);
    }

    // çarpılan sivil: 0.4 s serbest, sonra durana dek tam fren. DS.Car durgunken basılı freni geri vitese
    // çevirir: 1.5 m/s altında (ya da geri viteste) fren yerine el freni.
    _civCtrl(veh, dt, out) {
      out.throttle = 0; out.steer = 0; out.brake = 0; out.handbrake = false;
      if (veh._physT < 0.4) return;
      const car = veh.car;
      if (car !== null && car.speed > 1.5 && car.gear !== -1) out.brake = 1;
      else out.handbrake = true;
    }
    // kurtarma: şerit üzerinde 10 m ilerideki noktaya saf takip, ≤ 5 m/s
    _recCtrl(veh, dt, out) {
      const car = veh.car, R = veh._rec >= 0 ? this.lanes[veh._rec] : null;
      if (car === null || R === null) { out.brake = 1; return; }
      this._proj(R, car.x, car.y);
      const o = this._o2;
      this.nav.laneAt(R.id, this._ps + 10, o);
      const c = Math.cos(car.h), s = Math.sin(car.h), rb = car.p.b;
      const rx = car.x - c * rb, ry = car.y - s * rb;
      const dx = o.x - rx, dy = o.y - ry, ld = Math.max(3, Math.sqrt(dx * dx + dy * dy));
      const alpha = Math.atan2(-s * dx + c * dy, c * dx + s * dy);
      const kap = (2 * Math.sin(alpha)) / ld;
      out.steer = U.clamp(Math.atan(car.p.L * kap) / car.p.steerMax, -1, 1);
      const u = U.clamp(0.35 * (5 - car.speed), -1, 1);
      out.throttle = u > 0 ? u : 0; out.brake = u < 0 ? -u : 0; out.handbrake = false;
    }

    // ================= ÇİZİM =================
    // tüm araçlar (görünürlük elemesi; önce duranlar); sonunda ctx M'e döner
    draw(ctx, W) {
      W = W || this.W;
      const AS = DS.ActorSprites, list = this.list;
      if (AS && AS.drawVehicle) {
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (!r.vis) continue;
            const st = r.mode === PARKED || r.mode === WRECK;
            if ((pass === 0) !== st) continue;
            AS.drawVehicle(ctx, r);
          }
        }
      }
      const M = W.M;
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    }

    _visSignals(W) {
      const nav = this.nav, sig = this.sigNodes, out = this._sigVis;
      let n = 0;
      for (let k = 0; k < sig.length; k++) {
        const N = nav.nodes[sig[k]];
        if (this._isVis(W, N.x, N.y, (N.hx > N.hy ? N.hx : N.hy) + 3)) out[n++] = sig[k];
      }
      return n;
    }
    // lamba başı merkezi ve noktası (bacak l): _hx,_hy kutu merkezi; _dx,_dy renkli nokta
    _head(N, l) {
      const x = N.x + HSX[l] * (N.hx + 1.0), y = N.y + HSY[l] * (N.hy + 1.0);
      this._hx = x; this._hy = y;
      if (l === 0) { this._dx = x; this._dy = y - 0.3; }
      else if (l === 2) { this._dx = x; this._dy = y + 0.3; }
      else if (l === 1) { this._dx = x + 0.3; this._dy = y; }
      else { this._dx = x - 0.3; this._dy = y; }
    }
    // zemin katmanı: görünür sinyalli kavşaklarda 4 lamba başı (koyu kutu + etkin renk noktası)
    drawSignals(ctx, W) {
      if (!this.nav) return;
      W = W || this.W;
      const nv = this._visSignals(W);
      if (nv === 0) return;
      const nav = this.nav, vis = this._sigVis;
      ctx.fillStyle = SIG_BOX;
      ctx.beginPath();
      for (let k = 0; k < nv; k++) {
        const N = nav.nodes[vis[k]];
        for (let l = 0; l < 4; l++) {
          if (N.legs[l] < 0) continue;
          this._head(N, l);
          if (l === 0 || l === 2) ctx.rect(this._hx - 0.25, this._hy - 0.55, 0.5, 1.1);
          else ctx.rect(this._hx - 0.55, this._hy - 0.25, 1.1, 0.5);
        }
      }
      ctx.fill();
      for (let col = 0; col < 3; col++) {
        let any = false;
        for (let k = 0; k < nv; k++) {
          const N = nav.nodes[vis[k]];
          for (let l = 0; l < 4; l++) {
            if (N.legs[l] < 0) continue;
            if (nav.light(N.id, l === 0 || l === 2 ? 0 : 1, this.t) !== col) continue;
            if (!any) { ctx.fillStyle = SIG_COL[col]; ctx.beginPath(); any = true; }
            this._head(N, l);
            ctx.moveTo(this._dx + 0.18, this._dy);
            ctx.arc(this._dx, this._dy, 0.18, 0, TAU);
          }
        }
        if (any) ctx.fill();
      }
    }

    // ışık haritası: en yakın n hareketli aracın farları + görünür çakarlar + sinyal parlamaları
    drawLights(lctx, W, n) {
      W = W || this.W;
      const AS = DS.ActorSprites, list = this.list, env = W.env;
      if (typeof n !== 'number') n = this.carLights;
      if (n > 16) n = 16;
      if (AS && AS.drawVehicleLights && n > 0) {
        const R = this._lr, D = this._ld;
        let m = 0;
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (!r.vis) continue;
          if (!(r.mode === RAIL || (r.mode === PHYS && r.driver))) continue;
          const d = r._d2;
          if (m === n && d >= D[m - 1]) continue;
          let k = m < n ? m++ : m - 1;
          while (k > 0 && D[k - 1] > d) { D[k] = D[k - 1]; R[k] = R[k - 1]; k--; }
          D[k] = d; R[k] = r;
        }
        for (let k = 0; k < m; k++) { AS.drawVehicleLights(lctx, R[k], env); R[k] = null; }
      }
      if (AS && AS.drawSiren) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (r.vis && r.siren && r.mode !== WRECK) AS.drawSiren(lctx, r, this.t);
        }
      }
      const S = DS.Sprites;
      if (this.nav && S && S.tint) {
        const nv = this._visSignals(W);
        if (nv > 0) {
          const nav = this.nav, vis = this._sigVis;
          lctx.globalAlpha = 0.8;
          for (let k = 0; k < nv; k++) {
            const N = nav.nodes[vis[k]];
            for (let l = 0; l < 4; l++) {
              if (N.legs[l] < 0) continue;
              const st = nav.light(N.id, l === 0 || l === 2 ? 0 : 1, this.t);
              this._head(N, l);
              lctx.drawImage(S.tint(SIG_GLOW[st]), this._dx - 1.5, this._dy - 1.5, 3, 3);
            }
          }
          lctx.globalAlpha = 1;
        }
      }
    }

    // 'lighter': polis tavan çakarları (gündüz de)
    drawGlow(ctx, W) {
      W = W || this.W;
      const AS = DS.ActorSprites, list = this.list;
      if (!AS || !AS.drawSirenBar) return;
      let op = null;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.vis || !r.siren || r.mode === WRECK) continue;
        if (op === null) { op = ctx.globalCompositeOperation; ctx.globalCompositeOperation = 'lighter'; }
        AS.drawSirenBar(ctx, r, this.t);
      }
      if (op !== null) {
        ctx.globalCompositeOperation = op;
        ctx.globalAlpha = 1;
        const M = W.M;
        ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      }
    }

    // hata ayıklama / HUD sayaçları (paylaşılan nesne)
    counts() {
      const c = this._cnt, list = this.list;
      c.n = list.length; c.rail = 0; c.phys = 0; c.parked = 0; c.wreck = 0; c.held = 0; c.cops = 0;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.mode === RAIL) c.rail++; else if (r.mode === PHYS) c.phys++; else if (r.mode === PARKED) c.parked++;
        else if (r.mode === WRECK) c.wreck++; else c.held++;
        if (r.role === 'cop' && r.driver) c.cops++;
      }
      return c;
    }
  }

  DS.Traffic = Traffic;
})();
