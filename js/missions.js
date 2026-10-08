'use strict';
// Görevler, yan işler ve ekipler (SPEC §2.6.11, §5.5).
// Ankesörlü telefonlardan 12 hikâye görevi (3 ekip × 4), yan etkinlik işaretleri (3 drift, 2 yarış) ve
// taksi işi. Görev türleri: teslimat (kırılgan dahil), sipariş/çalma (hurda vinci), drift (madalya),
// kontrol noktalı yarış (madalya), polisten kaçış, taksi. Hedef/sayaç/başarısızlık, saygınlık + kapılar
// + rakip cezası + tekrar oynama, TEKRAR DENE, telefon listesi, işaretler, blipler, zemin çizimi, kayıt (ow).
// Dünya (world.js) olayları onEvent ile iletir; para W.world.reward ile ödenir, sonuç W.world.onMissionEnd ile bildirilir.
(function () {
  const DS = window.DS, U = DS.U;
  const PI = Math.PI;

  // ---------------- ekipler ----------------
  DS.CREWS = [
    { id: 'kulup', name: 'Drift Kulübü', col: '#38d9ff', phones: [1, 2, 11, 5] },
    { id: 'sanayi', name: 'Sanayi Kamyoncuları', col: '#ffb23e', phones: [6, 7, 0, 3] },
    { id: 'merkez', name: 'Merkez Yarışçıları', col: '#ff4fd8', phones: [4, 10, 8, 9] },
  ];

  // ---------------- hikâye görevleri (§5.5) ----------------
  // Konum tanımları L = [v, i, j, dir, k, f] nav.lanePoint ile çözülür (x, y: tohum 20251005 için denetim değerleri).
  DS.MISSIONS = [
    { id: 'k1', crew: 'kulup', tier: 0, phone: 1, type: 'drift', name: 'Isınma Turu',
      brief: 'Göbek bölgesinde 90 saniyede drift puanı topla. Bronz için 6.000 puan gerekir.',
      zone: { x: 417, y: 392, r: 170 }, time: 90, medals: [6000, 12000, 20000], reward: [600, 900, 1200] },
    { id: 'k2', crew: 'kulup', tier: 0, phone: 2, type: 'delivery', name: 'Lastik Teslimatı',
      brief: 'Panelvanı al, lastikleri süre dolmadan atölyeye teslim et.',
      veh: 'van', at: [0, 8, 2, 1, 0, 0.35], ax: 968.45, ay: 298.25, dest: [1, 3, 5, 1, 0, 0.5], dx: 414.12, dy: 658.5, reward: 900 },
    { id: 'k3', crew: 'kulup', tier: 1, phone: 11, type: 'race', name: 'Gece Yarışı',
      brief: 'Kulübün gece parkuru: başlangıç halkasına bir araçla gel, kontrol noktalarından geçerek süre dolmadan bitir.',
      wps: [[6, 4], [6, 8], [8, 8], [8, 4], [6, 4]], reward: [1800, 2100, 2500] },
    { id: 'k4', crew: 'kulup', tier: 2, phone: 5, type: 'escape', name: 'Kulüp Baskını',
      brief: 'Polis kulübü bastı! 3 yıldızla başlıyorsun: yıldızlardan kurtul ya da drift parkı kapısına ulaş.',
      stars: 3, dest: { x: 744, y: 292, r: 10 }, destName: 'drift parkı kapısı', time: 150, reward: 3500 },
    { id: 's1', crew: 'sanayi', tier: 0, phone: 6, type: 'delivery', name: 'Yedek Parça',
      brief: 'Panelvanla yedek parçaları süre dolmadan depoya teslim et.',
      veh: 'van', at: [1, 1, 6, 1, 0, 0.4], ax: 182.75, ay: 758.4, dest: [1, 2, 2, 1, 0, 0.5], dx: 298.75, dy: 341.5, reward: 800 },
    { id: 's2', crew: 'sanayi', tier: 0, phone: 7, type: 'steal', name: 'Sipariş: Spor Araba',
      brief: 'Otoparktaki kırmızı spor arabayı al ve hurda vincine götür. Hasar ödülü düşürür.',
      veh: 'sport', color: '#c8102e', pos: { x: 680, y: 755, h: PI }, reward: 1200 },
    { id: 's3', crew: 'sanayi', tier: 1, phone: 0, type: 'delivery', name: 'Kırılgan Kargo',
      brief: 'Cam kargo! Panelvanı 250 hasardan fazla almadan teslim et.',
      veh: 'van', at: [1, 1, 1, 1, 0, 0.6], ax: 182.75, ay: 253.4, dest: [0, 7, 8, 1, 0, 0.5], dx: 874.5, dy: 928.25, fragile: 250, reward: 2200 },
    { id: 's4', crew: 'sanayi', tier: 2, phone: 3, type: 'steal', name: 'Polis Aracı Siparişi',
      brief: 'Karakolun yanındaki boş polis aracını çal ve hurda vincine götür. Polis peşine düşecek.',
      veh: 'polis', at: [1, 6, 3, 1, 1, 0.6], ax: 717.04, ay: 456.4, reward: 4500 },
    { id: 'm1', crew: 'merkez', tier: 0, phone: 4, type: 'race', name: 'Merkez Turu',
      brief: 'Merkez parkuru: başlangıç halkasına bir araçla gel, kontrol noktalarından geçerek turu tamamla.',
      wps: [[4, 3], [4, 6], [6, 6], [6, 3], [4, 3]], reward: [700, 1000, 1200] },
    { id: 'm2', crew: 'merkez', tier: 0, phone: 10, type: 'steal', name: 'Sipariş: Taksi',
      brief: 'Herhangi bir taksi bul ve hurda vincine teslim et. Hasar ödülü düşürür.',
      veh: 'taxi', cls: 'taxi', at: [0, 4, 7, -1, 0, 0.5], ax: 559.5, ay: 813.75, reward: 1000 },
    { id: 'm3', crew: 'merkez', tier: 1, phone: 8, type: 'drift', name: 'Kalabalık Gösteri',
      brief: 'Merkezde kalabalığa 90 saniyelik drift şovu yap. Bronz için 10.000 puan gerekir.',
      zone: { x: 559.5, y: 556, r: 200 }, time: 90, medals: [10000, 18000, 30000], reward: [1500, 2000, 2500] },
    { id: 'm4', crew: 'merkez', tier: 2, phone: 9, type: 'escape', name: 'Büyük Kaçış',
      brief: '4 yıldızla başlıyorsun! Telefonun yanındaki siyah spor arabaya atla, güvenli eve kaç ya da polisi atlat.',
      stars: 4, dest: 'safehouse', destName: 'güvenli ev', time: 180, reward: 5000,
      veh: 'sport', color: '#1b1d22', at: [0, 8, 9, -1, 1, 0.5], ax: 981.5, ay: 1021.29 },
  ];

  // ---------------- yan etkinlik işaretleri (§5.5) ----------------
  DS.SIDE = [
    { id: 'd1', type: 'drift', name: 'Göbek Drifti', brief: '90 saniyede bölgede drift puanı topla.',
      x: 414.12, y: 337.55, zone: { x: 417, y: 392, r: 170 }, time: 90, medals: [8000, 15000, 25000], reward: [500, 1000, 2000] },
    { id: 'd2', type: 'drift', name: 'Sanayi Drifti', brief: '90 saniyede sanayi bölgesinde drift puanı topla.',
      x: 136.5, y: 821.25, zone: { x: 200, y: 860, r: 160 }, time: 90, medals: [8000, 15000, 25000], reward: [500, 1000, 2000] },
    { id: 'd3', type: 'drift', name: 'Drift Parkı Şov', brief: '90 saniyede drift parkında şov yap.',
      x: 744, y: 292, h: 0, zone: { park: true }, time: 90, medals: [8000, 15000, 25000], reward: [500, 1000, 2000] },
    { id: 'r1', type: 'race', name: 'Çevre Yolu', brief: 'Çevre yolunda tam tur: kontrol noktalarından geçerek süre dolmadan bitir.',
      at: [0, 0, 0, 1, 1, 0.3], x: 119.5, y: 90.71, h: 0, wps: [[0, 0], [9, 0], [9, 9], [0, 9], [0, 0]], reward: [500, 1000, 2000] },
    { id: 'r2', type: 'race', name: 'Batı Turu', brief: 'Batı semtinde göbekten geçen kısa tur.',
      at: [0, 1, 1, 1, 0, 0.5], x: 244.5, y: 199.25, h: 0, wps: [[1, 1], [3, 1], [3, 4], [1, 4], [1, 1]], reward: [500, 1000, 2000] },
  ];

  // telefon noktaları (nav.places yoksa yedek; §5.5)
  const PHONES_FB = [[248, 285.4], [552, 186.4], [978, 285.4], [359, 598.4], [552, 490.4], [876, 598.4],
    [248, 808.4], [458, 915.4], [764, 1016.4], [978, 1016.4], [667, 700.4], [764, 490.4]];
  const CRANE_FB = { x: 182.75, y: 871, r: 7 };
  const SAFE_FB = { x0: 448, y0: 248.2, x1: 452, y1: 255.4 };

  const GATE = [0, 30, 50];              // saygınlık kapıları (sarı ≥ 30, kırmızı ≥ 50)
  const RESP_PASS = [15, 25, 35];        // ilk geçişte saygınlık
  const RIVAL_PEN = 5, REPLAY_RESP = 5, REPLAY_PAY = 0.25, MIN_COND = 0.4;
  const DELIV_R = 8, SLOW = 3, CP_R = 10, MARK_R = 6, TAXI_R = 6, TAXI_SLOW = 2;
  const MEDAL_N = ['', 'Bronz', 'Gümüş', 'Altın'];
  const COL_TGT = '#ffd23e', COL_SIDE = '#ff4fd8', COL_ZONE = '#ffd23e';
  const TIER_LOCK = ['', 'Saygınlık 30 gerekli', 'Saygınlık 50 gerekli'];
  // başarısızlık notları
  const NOTE = {
    timer: 'Süre doldu.', abort: 'Görevi bıraktın.', busted: 'Enselendin.', wasted: 'Bayıldın.',
    vehicle: 'Görev aracı yok oldu.', lost: 'Görev aracı kayboldu.', fragile: 'Kargo kırıldı: araç çok hasar aldı.',
    exit: 'Taksiden indin, seri sıfırlandı.', hp: 'Taksi çok hasarlı.', medal: 'Madalya için yeterli puan yok.',
  };

  const d2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  // nokta–doğru parçası uzaklığının karesi (hızlı araç kontrol noktasını atlamasın)
  const segD2 = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return d2(px, py, ax + dx * t, ay + dy * t);
  };
  const fmtDist = (d) => (d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km');
  const fmtTime = (s) => {
    const m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1).replace('.', ',');
  };
  const fmtN = (n) => (U.fmt ? U.fmt(n) : String(Math.round(n)));
  const round5 = (v) => Math.round(v / 5) * 5;

  const MISSION_BY = {};
  for (const m of DS.MISSIONS) MISSION_BY[m.id] = m;
  const SIDE_BY = {};
  for (const s of DS.SIDE) SIDE_BY[s.id] = s;
  const CREW_BY = {};
  for (const c of DS.CREWS) CREW_BY[c.id] = c;
  const rivalOf = (crew) => {
    const L = DS.CREWS;
    for (let i = 0; i < L.length; i++) if (L[i].id === crew) return L[(i + 1) % L.length].id;
    return '';
  };
  const TAXI_DEF = { id: 'taxi', name: 'Taksi işi', type: 'taxi', brief: 'Yolcuları al, süre dolmadan götür.' };

  // varsayılan kayıt alt nesneleri (§5.8)
  const defaultOw = () => ({
    respect: { kulup: 0, sanayi: 0, merkez: 0 }, missions: {}, side: { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0 },
    stats: { missions: 0, taxi: 0 },
  });
  const num = (v, d) => (typeof v === 'number' && v === v && isFinite(v) ? v : d);

  class Missions {
    constructor(W) {
      this.W = W || null;
      this.nav = W && W.nav ? W.nav : null;
      this.state = 'idle';            // 'idle' | 'run' | 'pass' | 'fail'
      this.active = null;             // { def, kind, type, t, step, timer, ... }
      this.objective = { text: '', sub: '', x: 0, y: 0, has: false, timer: -1, kind: '' };
      this.result = null;             // son sonuç nesnesi
      this.last = null;               // son başlatılan iş kimliği (TEKRAR DENE)
      this.ow = defaultOw();
      this._o = { x: 0, y: 0, h: 0, s: 0, k: 0, d: 0, lane: -1, edge: -1, t: 0 };
      this._o2 = { x: 0, y: 0, h: 0, s: 0, k: 0, d: 0, lane: -1, edge: -1, t: 0 };
      this._gps = { pts: new Float32Array(512), n: 0, len: 0 };
      this._rt = new Int16Array(128);
      this._subT = 0;
      this._left = [];                // bırakılan görev araçları {veh, def} (TEKRAR DENE'de silinir)
      this.phones = [];               // { i, x, y, sx, sy, crew, mission }
      this.sides = [];                // { def, x, y, h }
      this.crane = CRANE_FB;
      this.safe = SAFE_FB;
      this._places();
    }

    // ---------------- yerler ----------------
    _places() {
      const nav = this.nav, P = nav && nav.places ? nav.places : null, o = this._o;
      this.phones.length = 0;
      for (let i = 0; i < 12; i++) {
        const p = P && P.phones && P.phones[i] ? P.phones[i] : null;
        const x = p ? p.x : PHONES_FB[i][0], y = p ? p.y : PHONES_FB[i][1];
        let crew = null, mission = null;
        for (const c of DS.CREWS) if (c.phones.indexOf(i) >= 0) crew = c;
        for (const m of DS.MISSIONS) if (m.phone === i) mission = m;
        this.phones.push({ i, x, y, sx: p && typeof p.sx === 'number' ? p.sx : x, sy: p && typeof p.sy === 'number' ? p.sy : y - 1.2, crew, mission });
      }
      if (P && P.crane) this.crane = { x: P.crane.x, y: P.crane.y, r: P.crane.r || 7 };
      if (P && P.safehouse && P.safehouse.trigger) this.safe = P.safehouse.trigger;
      this.sides.length = 0;
      for (const s of DS.SIDE) {
        let x = s.x, y = s.y, h = typeof s.h === 'number' ? s.h : 0;
        if (nav && s.at && nav.lanePoint(s.at, o) >= 0) { x = o.x; y = o.y; h = o.h; }
        else if (nav && typeof s.h !== 'number' && nav.nearestLane(x, y, NaN, 8, PI, o)) h = o.h;
        this.sides.push({ def: s, x, y, h });
      }
    }
    _driftRect() {
      const c = this.W && this.W.city;
      return c && c.drift ? c.drift : { x0: 736, y0: 186, x1: 1033, y1: 398 };
    }
    // bölge testi: daire {x,y,r} ya da drift parkı dikdörtgeni
    _inZone(z, x, y) {
      if (!z) return false;
      if (z.park) { const r = this._driftRect(); return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; }
      return d2(x, y, z.x, z.y) <= z.r * z.r;
    }
    // bölgenin GPS hedefi (drift parkı: kapı/işaret noktası)
    _zoneTarget(a) {
      const z = a.zone;
      if (z.park) { a.gx = a.mx; a.gy = a.my; } else { a.gx = z.x; a.gy = z.y; }
    }
    _lp(desc, fx, fy, out) {
      const nav = this.nav;
      if (nav && desc && nav.lanePoint(desc, out) >= 0) return out;
      out.x = fx; out.y = fy; out.h = 0;
      return out;
    }

    // ---------------- kayıt ----------------
    reset() {
      if (this.active) this._cleanup(this.active, false);
      this._dropLeftovers(true);
      this.state = 'idle';
      this.active = null;
      this.result = null;
      this.last = null;
      this._clearObj();
    }
    load(ow) {
      if (!ow || typeof ow !== 'object') ow = defaultOw();
      // ow.missions: id -> { done, medal, best, tries } (yalnız düz nesne kabul edilir)
      const m = ow.missions && typeof ow.missions === 'object' && !Array.isArray(ow.missions) ? ow.missions : {};
      const mm = {};
      for (const k in m) {
        if (!MISSION_BY[k] || !m[k] || typeof m[k] !== 'object') continue;
        const e = m[k];
        mm[k] = { done: !!e.done, medal: U.clamp(num(e.medal, 0) | 0, 0, 3), best: typeof e.best === 'number' && isFinite(e.best) ? e.best : null, tries: Math.max(0, num(e.tries, 0) | 0) };
      }
      ow.missions = mm;
      const r = ow.respect && typeof ow.respect === 'object' ? ow.respect : {};
      ow.respect = r;
      for (const c of DS.CREWS) r[c.id] = U.clamp(num(r[c.id], 0), 0, 100);
      const s = ow.side && typeof ow.side === 'object' ? ow.side : {};
      ow.side = s;
      for (const d of DS.SIDE) s[d.id] = U.clamp(num(s[d.id], 0) | 0, 0, 3);
      if (!ow.stats || typeof ow.stats !== 'object') ow.stats = {};
      ow.stats.missions = Math.max(0, num(ow.stats.missions, 0) | 0);
      ow.stats.taxi = Math.max(0, num(ow.stats.taxi, 0) | 0);
      this.ow = ow;
    }
    save(ow) {
      if (!ow || typeof ow !== 'object') return ow;
      const src = this.ow;
      if (ow === src) return ow; // canlı nesne: alanlar zaten güncel
      const mm = {};
      for (const k in src.missions) { const e = src.missions[k]; mm[k] = { done: e.done, medal: e.medal, best: e.best, tries: e.tries }; }
      ow.missions = mm;
      ow.respect = Object.assign({}, src.respect);
      ow.side = Object.assign({}, src.side);
      if (!ow.stats || typeof ow.stats !== 'object') ow.stats = {};
      ow.stats.missions = src.stats.missions | 0;
      ow.stats.taxi = src.stats.taxi | 0;
      return ow;
    }
    // canlı saygınlık nesnesi {kulup, sanayi, merkez} (polis Merkez ödül çarpanı için okur)
    get respect() { return this.ow.respect; }
    respectOf(crew) { return num(this.ow.respect[crew], 0); }
    _addRespect(crew, d) {
      if (!crew || !d) return;
      this.ow.respect[crew] = U.clamp(this.respectOf(crew) + d, 0, 100);
    }
    _prog(id) {
      let e = this.ow.missions[id];
      if (!e) e = this.ow.missions[id] = { done: false, medal: 0, best: null, tries: 0 };
      return e;
    }
    isLocked(def) { return !!def && def.tier > 0 && this.respectOf(def.crew) < GATE[def.tier]; }

    // ---------------- etkileşim noktaları ----------------
    phoneAt(x, y, r) {
      const r2 = r * r;
      let best = -1, bd = r2;
      for (let i = 0; i < this.phones.length; i++) {
        const p = this.phones[i], d = d2(x, y, p.x, p.y);
        if (d <= bd) { bd = d; best = i; }
      }
      return best;
    }
    // yan etkinlik işareti: araçta, < 10 m/s, görev yokken
    markerAt(x, y, r, inCar) {
      if (!inCar || this.state === 'run') return -1;
      const W = this.W;
      if (W && typeof W.pspeed === 'number' && W.pspeed >= 10) return -1;
      const r2 = r * r;
      for (let i = 0; i < this.sides.length; i++) { const s = this.sides[i]; if (d2(x, y, s.x, s.y) <= r2) return i; }
      return -1;
    }
    phoneList(phoneIdx) {
      const p = this.phones[phoneIdx];
      if (!p) return { phone: phoneIdx, crew: { id: '', name: 'Ankesörlü telefon', col: '#38d9ff', respect: 0 }, items: [] };
      const c = p.crew;
      const crew = { id: c.id, name: c.name, col: c.col, respect: this.respectOf(c.id) };
      const items = [];
      const m = p.mission;
      if (m) {
        const pr = this.ow.missions[m.id], done = !!(pr && pr.done), medal = pr ? pr.medal | 0 : 0;
        let locked = false, lockText = '';
        if (this.isLocked(m)) { locked = true; lockText = TIER_LOCK[m.tier]; }
        else if (this.state === 'run') { locked = true; lockText = 'Önce mevcut işi bitir'; }
        let reward = m.reward, brief = m.brief;
        if (done) {
          reward = Array.isArray(m.reward) ? m.reward.map((v) => Math.round(v * REPLAY_PAY)) : Math.round(m.reward * REPLAY_PAY);
          brief = m.brief + ' Tekrar: ödülün %25\'i' + (Array.isArray(m.reward) ? ' + madalya farkı' : '') + ', +5 saygınlık.';
        }
        items.push({ id: m.id, name: m.name, brief, tier: m.tier, reward, locked, lockText, done, medal });
      }
      return { phone: phoneIdx, crew, items };
    }
    canTaxi(W) {
      W = W || this.W;
      if (!W || this.state === 'run' || !W.inCar) return false;
      const pv = W.world ? W.world.playerVeh : null;
      return !!(pv && pv.def && pv.def.cls === 'taxi');
    }
    // dünya için: bu oyuncu aracı vince teslim edilebilir mi (çalma görevi hedefi)
    craneTarget(pv) {
      const a = this.active;
      if (this.state !== 'run' || !a || a.type !== 'steal' || !pv) return false;
      if (a.def.cls) return !!(pv.def && pv.def.cls === a.def.cls);
      return this._mine(pv.tag, a);
    }

    // ---------------- başlatma ----------------
    start(id) {
      const W = this.W;
      if (this.state === 'run' || !W || typeof id !== 'string') return false;
      let def = null, kind = 'story';
      if (id === 'taxi') { if (!this.canTaxi(W)) return false; def = TAXI_DEF; kind = 'taxi'; }
      else if (id.indexOf('side:') === 0) { def = SIDE_BY[id.slice(5)] || null; kind = 'side'; }
      else { def = MISSION_BY[id] || null; if (def && this.isLocked(def)) return false; }
      if (!def) return false;
      const need = def.type === 'delivery' || def.type === 'steal' || (def.type === 'escape' && def.veh);
      if (need && !(W.traffic && W.traffic.spawn)) return false;
      if (def.type === 'escape' && !(W.police && W.police.setStars)) return false;
      if ((def.type === 'race' || def.type === 'taxi') && !this.nav) return false;
      if (kind !== 'taxi') this._dropLeftovers(false);
      const a = {
        def, id, kind, type: def.type, t: 0, step: '', timer: -1, tag: null, veh: null, spawned: false, lostT: 0, hp0: 1000,
        sx: W.px, sy: W.py, sh: W.ph || 0, mx: 0, my: 0, gx: 0, gy: 0, zone: null, dest: null, rect: null,
        score: 0, cdT: 0, runT: 0, cps: null, nodes: null, cp: 0, len: 0, limit: 0, lx: W.px, ly: W.py, armed: false, entered: false,
        pUid: -1, has: false, rx: 0, ry: 0, tx: 0, ty: 0, boardT: 0, fare: 0, rideLen: 0, streak: 0, earned: 0, spawnT: 0,
        rh: 0, vdef: null,
      };
      // başlangıç pozu (TEKRAR DENE ışınlaması)
      if (kind === 'story') {
        const ph = this.phones[def.phone];
        if (ph) { a.sx = ph.sx; a.sy = ph.sy; a.sh = PI / 2; }
      } else if (kind === 'side') {
        const s = this.sides[DS.SIDE.indexOf(def)];
        if (s) { a.sx = s.x; a.sy = s.y; a.sh = s.h; a.mx = s.x; a.my = s.y; }
      }
      this.active = a;
      this.state = 'run';
      this.result = null;
      this.last = id;
      this._subT = 0;
      this._clearObj();
      let ok = true;
      switch (def.type) {
        case 'delivery': ok = this._startDelivery(a, W); break;
        case 'steal': ok = this._startSteal(a, W); break;
        case 'drift': ok = this._startDrift(a, W); break;
        case 'race': ok = this._startRace(a, W); break;
        case 'escape': ok = this._startEscape(a, W); break;
        case 'taxi': ok = this._startTaxi(a, W); break;
        default: ok = false;
      }
      if (!ok) {
        this._cleanup(a, false);
        this.active = null; this.state = 'idle'; this._clearObj();
        return false;
      }
      if (kind === 'story') this._prog(def.id).tries++;
      if (W.world && W.world.msg) W.world.msg(def.name, 'mis', kind === 'story' ? CREW_BY[def.crew].name : kind === 'side' ? 'Yan etkinlik' : 'Taksi');
      this.update(0, W);
      return true;
    }

    _startDelivery(a, W) {
      const d = a.def, o = this._lp(d.at, d.ax, d.ay, this._o);
      const vx = o.x, vy = o.y, vh = o.h;
      const q = this._lp(d.dest, d.dx, d.dy, this._o2);
      a.dest = { x: q.x, y: q.y, r: DELIV_R };
      let len = 0;
      if (this.nav) len = this.nav.gps(vx, vy, a.dest.x, a.dest.y, this._gps) ? this._gps.len : 0;
      if (!(len > 0)) len = (Math.abs(vx - a.dest.x) + Math.abs(vy - a.dest.y)) * 1.1;
      a.len = len;
      a.limit = len / 11 + 20;
      a.tag = { mission: d.id };
      if (!this._spawnVeh(a, W, d.veh, d.color, vx, vy, vh)) return false;
      a.hp0 = a.veh.hp;
      a.step = 'veh';
      return true;
    }
    _startSteal(a, W) {
      const d = a.def;
      a.tag = { mission: d.id };
      a.dest = { x: this.crane.x, y: this.crane.y, r: this.crane.r || 7 };
      if (d.cls) { // m2: en yakın canlı taksi işaretlenir, yoksa park hâlinde doğar
        if (!this._markTaxi(a, W)) return false;
      } else {
        let x, y, h;
        if (d.pos) { x = d.pos.x; y = d.pos.y; h = d.pos.h; }
        else { const o = this._lp(d.at, d.ax, d.ay, this._o); x = o.x; y = o.y; h = o.h; }
        if (!this._spawnVeh(a, W, d.veh, d.color, x, y, h)) return false;
      }
      a.step = 'find';
      return true;
    }
    _startDrift(a, W) {
      const d = a.def;
      a.zone = d.zone;
      if (a.kind === 'story') { a.mx = d.zone.park ? 744 : d.zone.x; a.my = d.zone.park ? 292 : d.zone.y; }
      this._zoneTarget(a);
      a.step = 'go';
      return true;
    }
    _startRace(a, W) {
      const nav = this.nav, d = a.def, rt = this._rt, nodes = [];
      for (let s = 0; s < d.wps.length - 1; s++) {
        const m = nav.route(d.wps[s][0] * 10 + d.wps[s][1], d.wps[s + 1][0] * 10 + d.wps[s + 1][1], rt);
        if (!m) return false;
        for (let q = 0; q < m; q++) if (!(nodes.length && nodes[nodes.length - 1] === rt[q])) nodes.push(rt[q]);
      }
      if (nodes.length < 2) return false;
      let len = 0;
      for (let q = 1; q < nodes.length; q++) {
        const A = nav.nodes[nodes[q - 1]], B = nav.nodes[nodes[q]];
        len += Math.hypot(B.x - A.x, B.y - A.y);
      }
      a.nodes = nodes;
      a.cps = new Int16Array(nodes.length - 1);
      for (let q = 1; q < nodes.length; q++) a.cps[q - 1] = nodes[q];
      a.len = len;
      a.limit = len / 14 + 10;
      if (a.kind === 'story') {
        const n0 = nav.nodes[nodes[0]], n1 = nav.nodes[nodes[1]];
        a.mx = n0.x; a.my = n0.y;
        a.rh = Math.atan2(n1.y - n0.y, n1.x - n0.x);
      } else a.rh = a.sh;
      a.step = 'start';
      return true;
    }
    _startEscape(a, W) {
      const d = a.def;
      if (d.dest === 'safehouse') {
        const t = this.safe;
        a.rect = { x0: t.x0 - 1, y0: t.y0 - 1, x1: t.x1 + 1, y1: t.y1 + 1 };
        a.dest = { x: (t.x0 + t.x1) / 2, y: (t.y0 + t.y1) / 2, r: 5 };
      } else {
        let dx = d.dest.x, dy = d.dest.y;
        const P = this.nav && this.nav.places;
        if (d.id === 'k4' && P && P.driftGate) { dx = P.driftGate.x; dy = P.driftGate.y; }
        a.dest = { x: dx, y: dy, r: d.dest.r };
      }
      if (d.veh) {
        a.tag = { mission: d.id };
        const o = this._lp(d.at, d.ax, d.ay, this._o);
        if (!this._spawnVeh(a, W, d.veh, d.color, o.x, o.y, o.h)) return false;
      }
      a.timer = d.time;
      a.step = 'run';
      W.police.setStars(d.stars, W.px, W.py);
      a.armed = W.police.stars > 0;
      return true;
    }
    _startTaxi(a, W) {
      a.step = 'seek';
      a.spawnT = 0;
      this._spawnPassenger(a, W);
      return true;
    }

    // ---------------- araç yardımcıları ----------------
    _setup(id, color) {
      const V = DS.TRAFFIC_VARIANTS || [];
      let vi = 0;
      for (let i = 0; i < V.length; i++) if (V[i].id === id) { vi = i; break; }
      const base = DS.variantSetup ? DS.variantSetup(vi) : null;
      const s = Object.assign({ color: '#8a8f98', livery: 'none', wing: false, rim: '#b8b8b8', glow: 'none', smoke: '#f4f4f4', upg: {}, bar: false, sign: false }, base || {});
      if (color) s.color = color;
      return s;
    }
    // bir noktadaki sıradan (keep olmayan) araçları kaldır: görev aracı üst üste doğmasın
    _clearSpot(W, x, y, r) {
      const tr = W.traffic;
      if (!tr || !tr.list || !tr.despawn) return;
      const L = tr.list, r2 = r * r;
      for (let k = L.length - 1; k >= 0; k--) {
        const v = L[k];
        if (v && v.alive && !v.keep && d2(v.x, v.y, x, y) < r2) tr.despawn(v);
      }
    }
    _spawnVeh(a, W, id, color, x, y, h) {
      const tr = W.traffic;
      if (!tr || !tr.spawn) return false;
      this._clearSpot(W, x, y, 5.5);
      const def = DS.vehById ? DS.vehById(id) : { id };
      const veh = tr.spawn({ def, setup: this._setup(id, color), x, y, h, mode: 'parked', role: 'mission', keep: true, driver: false, tag: a.tag, siren: false, v: 0 });
      if (!veh) return false;
      veh.keep = true; veh.tag = a.tag; veh.driver = false; veh.siren = false;
      a.veh = veh; a.spawned = true; a.vdef = def;
      return true;
    }
    // m2: en yakın uygun taksiyi işaretle (keep + tag), yoksa park hâlinde doğur
    _markTaxi(a, W) {
      const tr = W.traffic;
      if (!tr) return false;
      const VM = DS.VM, L = tr.list || [];
      let best = null, bd = Infinity;
      for (let k = 0; k < L.length; k++) {
        const v = L[k];
        if (!v || !v.alive || v.tag || !v.def || v.def.cls !== a.def.cls || (VM && v.mode === VM.WRECK)) continue;
        const d = d2(v.x, v.y, W.px, W.py);
        if (d < bd) { bd = d; best = v; }
      }
      if (best) { best.keep = true; best.tag = a.tag; a.veh = best; a.spawned = false; a.vdef = best.def; return true; }
      const o = this._lp(a.def.at, a.def.ax, a.def.ay, this._o);
      return this._spawnVeh(a, W, a.def.veh, null, o.x, o.y, o.h);
    }
    _pv(W) { return W && W.world ? W.world.playerVeh : null; }
    _inTarget(a, W) {
      if (!W.inCar) return false;
      const pv = this._pv(W);
      if (!pv) return false;
      if (a.def.cls) return !!(pv.def && pv.def.cls === a.def.cls);
      return this._mine(pv.tag, a);
    }
    // bu etiket etkin görevin mi (kimlik ya da görev kimliği; bitişte etiketler null yapılır)
    _mine(tag, a) { return !!(tag && a.tag && (tag === a.tag || tag.mission === a.def.id)); }
    // görev aracının kaydı (oyuncu içinde değilken): havuz yuvası yeniden kullanılmış olabilir -> alive + tag denetimi
    _findVeh(a, W) {
      const v = a.veh;
      if (v && v.alive && this._mine(v.tag, a)) return v;
      a.veh = null;
      const tr = W.traffic;
      if (!tr || !tr.list || !a.tag) return null;
      const L = tr.list;
      for (let k = 0; k < L.length; k++) { const r = L[k]; if (r && r.alive && this._mine(r.tag, a)) { a.veh = r; return r; } }
      return null;
    }
    _busy(W) {
      const st = W.world ? W.world.state : '';
      return st === 'enter' || st === 'exit';
    }
    // araç bulunamadı: binme/inme geçişinde değilse 2 s sonra başarısız
    _lost(a, dt, W) {
      if (this._busy(W)) { a.lostT = 0; return false; }
      a.lostT += dt;
      if (a.lostT > 2) { this._fail('lost'); return true; }
      return false;
    }
    _isWreck(v) { return !!(v && DS.VM && v.mode === DS.VM.WRECK); }

    // ---------------- güncelleme ----------------
    update(dt, W) {
      if (this.state !== 'run') return;
      W = W || this.W;
      const a = this.active;
      if (!a || !W) { this.state = 'idle'; return; }
      a.t += dt;
      switch (a.type) {
        case 'delivery': this._updDelivery(a, dt, W); break;
        case 'steal': this._updSteal(a, dt, W); break;
        case 'drift': this._updDrift(a, dt, W); break;
        case 'race': this._updRace(a, dt, W); break;
        case 'escape': this._updEscape(a, dt, W); break;
        case 'taxi': this._updTaxi(a, dt, W); break;
      }
      a.lx = W.px; a.ly = W.py;
      if (this.state !== 'run') return;
      // alt satır (mesafe/puan) 4 Hz: dize üretimi kare başına değil
      this._subT -= dt;
      if (this._subT <= 0) { this._subT = 0.25; this._sub(a, W); }
    }
    _clearObj() {
      const o = this.objective;
      o.text = ''; o.sub = ''; o.x = 0; o.y = 0; o.has = false; o.timer = -1; o.kind = '';
    }
    _obj(text, x, y, has, kind) {
      const o = this.objective;
      o.text = text; o.x = x; o.y = y; o.has = has; o.kind = kind;
    }
    _sub(a, W) {
      const o = this.objective;
      let s = '';
      if (a.type === 'drift' && (a.step === 'run' || a.step === 'count')) {
        const m = a.def.medals;
        let k = 0;
        while (k < 3 && a.score >= m[k]) k++;
        s = 'Puan ' + fmtN(a.score) + (k < 3 ? ' · ' + MEDAL_N[k + 1] + ' ' + fmtN(m[k]) : ' · Altın!');
      } else if (a.type === 'race' && a.step === 'run') {
        s = 'Kontrol ' + Math.min(a.cp + 1, a.cps.length) + '/' + a.cps.length;
      } else if (a.type === 'taxi' && a.step === 'ride') {
        s = fmtDist(Math.sqrt(d2(W.px, W.py, o.x, o.y))) + ' · ₺' + fmtN(a.fare) + (a.streak ? ' · seri ' + a.streak : '');
      } else if (o.has) {
        const R = W.world && W.world.route;
        const d = R && R.len > 0 && R.n > 1 ? R.len : Math.sqrt(d2(W.px, W.py, o.x, o.y));
        s = fmtDist(d);
        if (a.type === 'escape') s += ' · ya da yıldızlardan kurtul';
      }
      o.sub = s;
    }

    _updDelivery(a, dt, W) {
      const inV = this._inTarget(a, W);
      let veh = null;
      if (!inV) {
        veh = this._findVeh(a, W);
        if (!veh) { if (this._lost(a, dt, W)) return; }
        else a.lostT = 0;
        if (this._isWreck(veh)) { this._fail('vehicle'); return; }
      } else { a.lostT = 0; a.entered = true; }
      if (a.def.fragile) {
        const pv = this._pv(W);
        const hp = inV ? (pv && typeof pv.hp === 'number' ? pv.hp : a.hp0) : veh ? veh.hp : a.hp0;
        if (a.hp0 - hp > a.def.fragile) { this._fail('fragile'); return; }
      }
      if (a.step === 'veh') {
        if (inV) { a.step = 'drive'; a.timer = a.limit; }
        else { this._obj('Araca bin', veh ? veh.x : this.objective.x, veh ? veh.y : this.objective.y, !!veh || this.objective.has, 'veh'); return; }
      }
      a.timer -= dt;
      if (a.timer <= 0) { a.timer = 0; this.objective.timer = 0; this._timeout(); return; }
      this.objective.timer = a.timer;
      if (inV) {
        a.step = 'drive';
        this._obj('Kargoyu teslim et', a.dest.x, a.dest.y, true, 'dest');
        if (d2(W.px, W.py, a.dest.x, a.dest.y) < a.dest.r * a.dest.r && W.pspeed < SLOW) {
          this._pass({ base: a.def.reward, note: 'Kargo teslim edildi.' });
        }
      } else {
        a.step = 'back';
        this._obj('Araca geri dön', veh ? veh.x : this.objective.x, veh ? veh.y : this.objective.y, !!veh, 'veh');
      }
    }

    _updSteal(a, dt, W) {
      const inV = this._inTarget(a, W);
      if (inV) {
        a.lostT = 0; a.entered = true; a.step = 'crane';
        this._obj('Vince götür', a.dest.x, a.dest.y, true, 'dest');
        return;
      }
      let veh = this._findVeh(a, W);
      if (!veh) {
        if (a.def.cls) { if (!this._busy(W) && this._markTaxi(a, W)) veh = a.veh; }
        else if (this._lost(a, dt, W)) return;
      } else a.lostT = 0;
      if (this._isWreck(veh)) { this._fail('vehicle'); return; }
      a.step = 'find';
      this._obj(a.entered ? 'Araca geri dön' : 'Hedef aracı bul', veh ? veh.x : this.objective.x, veh ? veh.y : this.objective.y, !!veh, 'veh');
    }

    _countdown(a, dt, W) {
      a.cdT -= dt;
      if (a.cdT <= 0) {
        a.step = 'run'; a.runT = 0;
        if (W.world && W.world.msg) W.world.msg('BAŞLA', 'big', a.def.name);
        return true;
      }
      return false;
    }
    _beginCount(a, W) {
      a.step = 'count'; a.cdT = 3;
      if (W.world && W.world.msg) W.world.msg('HAZIR', 'big', a.def.name);
    }

    _updDrift(a, dt, W) {
      const inZ = this._inZone(a.zone, W.px, W.py);
      if (a.step === 'go') {
        if (W.inCar && inZ) this._beginCount(a, W);
        else { this._obj('Bölgeye bir araçla git', a.gx, a.gy, true, 'zone'); this.objective.timer = -1; return; }
      }
      if (a.step === 'count') {
        this._obj('HAZIR', 0, 0, false, 'zone');
        this.objective.timer = -1;
        if (!this._countdown(a, dt, W)) return;
        a.timer = a.def.time; a.score = 0;
      }
      a.timer -= dt;
      if (a.timer <= 0) { a.timer = 0; this.objective.timer = 0; this._finishDrift(a, W); return; }
      this.objective.timer = a.timer;
      if (inZ) this._obj('DRİFT ÇILGINLIĞI', a.gx, a.gy, false, 'zone');
      else this._obj('Bölgeye geri dön', a.gx, a.gy, true, 'zone');
    }
    _finishDrift(a, W) {
      const m = a.def.medals;
      let medal = 0;
      while (medal < 3 && a.score >= m[medal]) medal++;
      if (medal === 0) { this._fail('medal', 'Puan ' + fmtN(a.score) + ' — ' + NOTE.medal); return; }
      this._pass({ base: a.def.reward[medal - 1], medal, best: a.score, bestHigh: true, note: 'Puan ' + fmtN(a.score) + ' · ' + MEDAL_N[medal] + ' madalya' });
    }

    _updRace(a, dt, W) {
      const nav = this.nav;
      if (a.step === 'start') {
        if (W.inCar && d2(W.px, W.py, a.mx, a.my) < CP_R * CP_R) this._beginCount(a, W);
        else {
          this._obj(W.inCar ? 'Başlangıç halkasına git' : 'Bir araçla başlangıç halkasına git', a.mx, a.my, true, 'start');
          this.objective.timer = -1;
          return;
        }
      }
      if (a.step === 'count') {
        this._obj('HAZIR', a.mx, a.my, false, 'start');
        this.objective.timer = -1;
        if (!this._countdown(a, dt, W)) return;
        a.cp = 0; a.timer = a.limit;
      }
      a.runT += dt;
      a.timer = a.limit - a.runT;
      if (a.timer <= 0) { a.timer = 0; this.objective.timer = 0; this._timeout(); return; }
      this.objective.timer = a.timer;
      let nd = nav.nodes[a.cps[a.cp]];
      const jump = d2(a.lx, a.ly, W.px, W.py) > 3600; // ışınlama: süpürme yok, yalnız nokta testi
      const dd = jump ? d2(nd.x, nd.y, W.px, W.py) : segD2(nd.x, nd.y, a.lx, a.ly, W.px, W.py);
      if (W.inCar && dd < CP_R * CP_R) {
        a.cp++;
        if (a.cp >= a.cps.length) { this._finishRace(a, W); return; }
        nd = nav.nodes[a.cps[a.cp]];
      }
      this._obj(W.inCar ? (a.cp === a.cps.length - 1 ? 'Bitişe git' : 'Kontrol noktasından geç') : 'Bir araca bin', nd.x, nd.y, true, 'cp');
    }
    _finishRace(a, W) {
      const T = a.runT, L = a.len;
      const medal = T <= L / 20 ? 3 : T <= L / 17 ? 2 : 1;
      this._pass({ base: a.def.reward[medal - 1], medal, best: T, bestHigh: false, note: 'Süre ' + fmtTime(T) + ' · ' + MEDAL_N[medal] + ' madalya' });
    }

    _updEscape(a, dt, W) {
      a.timer -= dt;
      if (a.timer <= 0) { a.timer = 0; this.objective.timer = 0; this._timeout(); return; }
      this.objective.timer = a.timer;
      const pol = W.police, x = W.px, y = W.py;
      const atDest = a.rect ? x >= a.rect.x0 && x <= a.rect.x1 && y >= a.rect.y0 && y <= a.rect.y1 : d2(x, y, a.dest.x, a.dest.y) < a.dest.r * a.dest.r;
      if (atDest) { this._pass({ base: a.def.reward, note: 'Hedefe ulaştın: ' + a.def.destName + '.' }); return; }
      const ws = W.world ? W.world.state : '';
      if (pol && pol.stars > 0) a.armed = true;
      else if (pol && a.armed && ws !== 'busted' && ws !== 'wasted') { this._pass({ base: a.def.reward, note: 'Polisi atlattın.' }); return; }
      // m4: yayayken siyah spor araba gösterilir
      if (a.tag && W.onFoot) {
        const v = this._findVeh(a, W);
        if (v && !this._isWreck(v)) { this._obj('Siyah spor arabaya bin ve kaç', v.x, v.y, true, 'veh'); return; }
      }
      this._obj(a.def.id === 'm4' ? 'Güvenli eve kaç' : 'Drift parkı kapısına kaç', a.dest.x, a.dest.y, true, 'dest');
    }

    _updTaxi(a, dt, W) {
      const pv = this._pv(W);
      if (!W.inCar || !pv || !pv.def || pv.def.cls !== 'taxi') { if (!this._busy(W)) this._fail('exit'); return; }
      if (typeof pv.hp === 'number' && pv.hp < 300) { this._fail('hp'); return; }
      const peds = W.peds;
      if (a.step === 'seek') {
        this.objective.timer = -1;
        if (!a.has) {
          a.spawnT -= dt;
          if (a.spawnT <= 0) this._spawnPassenger(a, W);
          this._obj('Yolcu aranıyor', 0, 0, false, 'pickup');
          return;
        }
        // yolcu hâlâ bekliyor mu (devrildi/kaçtı/silindi -> yeni yolcu)
        if (a.pUid >= 0 && peds) {
          const i = peds.find(a.pUid), PS = DS.PS;
          if (i < 0 || (PS && peds.st[i] !== PS.WAVE && peds.st[i] !== PS.IDLE && peds.st[i] !== PS.GOTO)) {
            if (i >= 0) peds.remove(i);
            a.pUid = -1; a.has = false; a.spawnT = 1;
            if (W.world && W.world.msg) W.world.msg('Yolcu vazgeçti', 'mis', 'Yeni yolcu aranıyor');
            return;
          }
        }
        this._obj('Yolcuyu al', a.rx, a.ry, true, 'pickup');
        if (d2(W.px, W.py, a.rx, a.ry) < TAXI_R * TAXI_R && W.pspeed < TAXI_SLOW) {
          a.step = 'board'; a.boardT = 0.6;
          if (peds && a.pUid >= 0) { const i = peds.find(a.pUid); if (i >= 0) peds.seek(i, W.px, W.py, 1.4); }
        }
        return;
      }
      if (a.step === 'board') {
        this._obj('Yolcu biniyor', a.rx, a.ry, false, 'pickup');
        a.boardT -= dt;
        if (a.boardT > 0) return;
        this._removePassenger(a, W);
        if (!this._pickDest(a, W)) { a.step = 'seek'; a.has = false; a.spawnT = 0.5; return; }
        a.step = 'ride';
        a.timer = a.rideLen / 9 + 10;
        if (W.world && W.world.msg) W.world.msg('Yolcu bindi', 'mis', 'Ücret ₺' + fmtN(a.fare));
      }
      // ride
      a.timer -= dt;
      if (a.timer <= 0) { a.timer = 0; this.objective.timer = 0; this._timeout(); return; }
      this.objective.timer = a.timer;
      this._obj('Yolcuyu bırak', a.tx, a.ty, true, 'drop');
      if (d2(W.px, W.py, a.tx, a.ty) < TAXI_R * TAXI_R && W.pspeed < TAXI_SLOW) {
        const w = W.world;
        a.streak++; a.earned += a.fare;
        if (w && w.reward) w.reward(a.fare, 'Taksi ücreti');
        if (a.streak % 5 === 0) {
          a.earned += 500;
          if (w && w.reward) w.reward(500, 'Taksi serisi');
          if (w && w.msg) w.msg('SERİ BONUSU', 'good', a.streak + ' yolcu üst üste');
        }
        this.ow.stats.taxi = (this.ow.stats.taxi | 0) + 1;
        a.step = 'seek'; a.has = false; a.spawnT = 0.8; a.timer = -1;
        this.objective.timer = -1;
        this._obj('Yolcu aranıyor', 0, 0, false, 'pickup');
      }
    }
    _spawnPassenger(a, W) {
      const nav = this.nav, o = this._o, q = this._o2;
      a.has = false;
      if (!nav) return false;
      let ok = nav.pickPedSpawn(W.px, W.py, 60, 150, Math.random, o) || nav.pickPedSpawn(W.px, W.py, 40, 260, Math.random, o);
      if (!ok) { a.spawnT = 1; return false; }
      const px = o.x, py = o.y;
      if (nav.nearestLane(px, py, NaN, 30, PI, q)) { a.rx = q.x; a.ry = q.y; } else { a.rx = px; a.ry = py; }
      a.pUid = -1;
      const peds = W.peds;
      if (peds && peds.spawnAt) {
        const PR = DS.PR, PS = DS.PS;
        const uid = peds.spawnAt(px, py, { role: PR ? PR.MISSION : 'mission', st: PS ? PS.WAVE : 10, h: Math.atan2(a.ry - py, a.rx - px) });
        a.pUid = uid >= 0 ? uid : -1;
      }
      a.has = true;
      return true;
    }
    _removePassenger(a, W) {
      const peds = W && W.peds;
      if (peds && a.pUid >= 0) { const i = peds.find(a.pUid); if (i >= 0) peds.remove(i); }
      a.pUid = -1;
    }
    _pickDest(a, W) {
      const nav = this.nav, o = this._o;
      if (!nav.pickLaneSpawn(W.px, W.py, 250, 600, 0, 0, Math.random, o) && !nav.pickLaneSpawn(W.px, W.py, 150, 800, 0, 0, Math.random, o)) return false;
      a.tx = o.x; a.ty = o.y;
      let len = nav.gps(W.px, W.py, a.tx, a.ty, this._gps) ? this._gps.len : 0;
      if (!(len > 0)) len = Math.abs(W.px - a.tx) + Math.abs(W.py - a.ty);
      a.rideLen = len;
      a.fare = U.clamp(round5(60 + 0.25 * len), 60, 250);
      return true;
    }

    // ---------------- olaylar ----------------
    onEvent(type, x, y) {
      const W = this.W, a = this.active;
      if (this.state !== 'run' || !a || !W) return;
      switch (type) {
        case 'bank':
          if (a.type === 'drift' && a.step === 'run' && W.inCar && this._inZone(a.zone, W.px, W.py) && x > 0) a.score += x;
          break;
        case 'busted': this._fail('busted'); break;
        case 'wasted': this._fail('wasted'); break;
        case 'exit':
          if (a.type === 'taxi') this._fail('exit');
          else this.update(0, W);
          break;
        case 'enter': this.update(0, W); break;
        case 'explode': {
          const veh = x;
          if (veh) { if (this._mine(veh.tag, a)) this._fail('vehicle'); }
          else if (a.type === 'taxi' || this._inTarget(a, W)) this._fail('vehicle');
          break;
        }
        case 'crane': {
          if (a.type !== 'steal' || !x) break;
          const info = x;
          const ok = a.def.cls ? !!(info.def && info.def.cls === a.def.cls) : this._mine(info.tag, a);
          if (!ok) break;
          const max = info.maxHp || (info.def && info.def.maxHp) || 1000;
          const cond = U.clamp((typeof info.hp === 'number' ? info.hp : max) / max, 0, 1);
          const c = Math.max(MIN_COND, cond);
          a.veh = null; // araç dünya tarafından vinçte yok edildi
          if (W.world && W.world.msg) W.world.msg('Vince yüklendi', 'mis', 'Durum %' + Math.round(cond * 100));
          this._pass({ base: Math.round(a.def.reward * c), note: 'Araç vince yüklendi · durum %' + Math.round(cond * 100) + '.' });
          break;
        }
        case 'stars':
          if (a.type === 'escape') { if (x > 0) a.armed = true; }
          break;
      }
    }

    // hata ayıklama (debug.completeObjective): etkin görevi hemen geçir (drift/yarış bronz)
    debugComplete() {
      const a = this.active, W = this.W;
      if (this.state !== 'run' || !a) return false;
      switch (a.type) {
        case 'drift': a.score = Math.max(a.score, a.def.medals[0]); this._finishDrift(a, W); break;
        case 'race': a.runT = a.limit - 1; this._finishRace(a, W); break;
        case 'steal': {
          const pv = this._pv(W);
          this.onEvent('crane', pv && this._inTarget(a, W) ? Object.assign({}, pv) : { def: a.vdef, tag: a.tag, hp: 1000, maxHp: 1000 });
          break;
        }
        case 'taxi': if (a.step === 'ride') { a.tx = W.px; a.ty = W.py; } return true;
        default: this._pass({ base: a.def.reward, note: 'Hedef tamamlandı.' });
      }
      return true;
    }
    abort(reason) {
      if (this.state !== 'run' || !this.active) return;
      this._fail(reason || 'abort');
    }
    retry() {
      const W = this.W, id = this.last;
      if (!id || !W) return false;
      if (this.state === 'run' && this.active) { this._cleanup(this.active, false); this.active = null; this.state = 'idle'; }
      this._dropLeftovers(true);
      if (id === 'taxi') return this.start('taxi');
      const def = id.indexOf('side:') === 0 ? SIDE_BY[id.slice(5)] : MISSION_BY[id];
      if (!def) return false;
      // başlangıç koşulları: aranma temizlenir, oyuncu başlangıca ışınlanır (ücretsiz)
      if (W.police && W.police.clear && W.police.stars > 0) W.police.clear('mission');
      let x, y, h;
      if (id.indexOf('side:') === 0) { const s = this.sides[DS.SIDE.indexOf(def)]; x = s.x; y = s.y; h = s.h; }
      else { const p = this.phones[def.phone]; x = p.sx; y = p.sy; h = PI / 2; }
      if (W.inCar && this.nav) {
        if (def.type === 'race' && id.indexOf('side:') !== 0) {
          // araçtaki oyuncu: yarışın başlangıç kavşağına
          const nav = this.nav, n0 = nav.nodes[def.wps[0][0] * 10 + def.wps[0][1]], n1 = nav.nodes[def.wps[1][0] * 10 + def.wps[1][1]];
          const hh = Math.atan2(n1.y - n0.y, n1.x - n0.x);
          if (nav.nearestLane(n0.x, n0.y, hh, 40, 1.2, this._o)) { x = this._o.x; y = this._o.y; h = this._o.h; } else { x = n0.x; y = n0.y; h = hh; }
        } else if (id.indexOf('side:') !== 0 && this.nav.nearestLane(x, y, NaN, 60, PI, this._o)) {
          x = this._o.x; y = this._o.y; h = this._o.h; // araçla kaldırıma değil, en yakın şeride
        }
        this._clearSpot(W, x, y, 5);
      }
      const dbg = W.world && W.world.debug;
      if (dbg && dbg.teleport) dbg.teleport(x, y, h);
      return this.start(id);
    }

    // ---------------- bitiş ----------------
    _timeout() {
      const W = this.W;
      if (W && W.world && W.world.msg) W.world.msg('SÜRE DOLDU', 'big', '');
      this._fail('timer');
    }
    _fail(reason, noteOverride) {
      const W = this.W, a = this.active;
      if (this.state !== 'run' || !a) return;
      this._cleanup(a, true);
      let canRetry = true;
      if (a.kind === 'taxi') {
        const pv = this._pv(W);
        canRetry = !!(W && W.inCar && pv && pv.def && pv.def.cls === 'taxi' && !(pv.hp < 300));
      }
      const note = noteOverride || NOTE[reason] || String(reason);
      const r = {
        id: a.kind === 'side' ? 'side:' + a.def.id : a.def.id, name: a.def.name, pass: false,
        reward: a.kind === 'taxi' ? a.earned : 0, medal: 0,
        note: a.kind === 'taxi' && a.earned > 0 ? note + ' Kazanç ₺' + fmtN(a.earned) + '.' : note,
        canRetry, respect: { crew: a.def.crew || '', delta: 0 }, kind: a.kind, reason,
      };
      this._finish(r);
    }
    _pass(o) {
      const W = this.W, a = this.active;
      if (this.state !== 'run' || !a) return;
      const def = a.def, medalType = Array.isArray(def.reward);
      const medal = o.medal | 0;
      let pay = Math.max(0, Math.round(o.base || 0)), replay = false, prevMedal = 0;
      let crew = '', delta = 0;
      const ow = this.ow;
      if (a.kind === 'story') {
        const pr = this._prog(def.id);
        replay = pr.done; prevMedal = pr.medal | 0;
        pr.done = true;
        if (medal > pr.medal) pr.medal = medal;
        if (typeof o.best === 'number') pr.best = pr.best === null ? o.best : o.bestHigh ? Math.max(pr.best, o.best) : Math.min(pr.best, o.best);
        crew = def.crew;
        if (!replay) {
          delta = RESP_PASS[def.tier];
          this._addRespect(crew, delta);
          if (def.tier >= 1) this._addRespect(rivalOf(crew), -RIVAL_PEN);
        } else { delta = REPLAY_RESP; this._addRespect(crew, delta); }
      } else if (a.kind === 'side') {
        prevMedal = ow.side[def.id] | 0;
        replay = prevMedal > 0;
        if (medal > prevMedal) ow.side[def.id] = medal;
      }
      if (replay) {
        const up = medalType && medal > prevMedal ? Math.max(0, def.reward[medal - 1] - (prevMedal > 0 ? def.reward[prevMedal - 1] : 0)) : 0;
        pay = Math.round(pay * REPLAY_PAY) + up;
      }
      ow.stats.missions = (ow.stats.missions | 0) + 1;
      this._cleanup(a, true);
      if (pay > 0 && W.world && W.world.reward) W.world.reward(pay, def.name);
      // görev geçişi aranmayı temizler
      if (W.police && W.police.clear && W.police.stars > 0) W.police.clear('mission');
      let note = o.note || '';
      if (replay) note += (note ? ' ' : '') + 'Tekrar oynama: ödülün %25\'i' + (medalType ? ' + madalya farkı.' : '.');
      if (a.kind === 'story' && !replay && def.tier >= 1) {
        const rv = CREW_BY[rivalOf(crew)];
        if (rv) note += (note ? ' ' : '') + rv.name + ' saygınlığı -' + RIVAL_PEN + '.';
      }
      const r = {
        id: a.kind === 'side' ? 'side:' + def.id : def.id, name: def.name, pass: true, reward: pay, medal, note,
        canRetry: medalType, respect: { crew, delta }, kind: a.kind, reason: 'pass',
      };
      this._finish(r);
    }
    _finish(r) {
      const W = this.W;
      this.state = r.pass ? 'pass' : 'fail';
      this.active = null;
      this._clearObj();
      this.result = r;
      if (W && W.world && W.world.onMissionEnd) W.world.onMissionEnd(r);
    }
    // görev araçlarını bırak, yolcuyu kaldır. keepLeft: bırakılan araç TEKRAR DENE'de silinmek üzere hatırlanır
    _cleanup(a, keepLeft) {
      const W = this.W;
      if (!a) return;
      const v = a.veh;
      if (v && v.alive && this._mine(v.tag, a)) {
        v.keep = false; v.tag = null;
        if (a.spawned) {
          if (keepLeft) this._left.push({ veh: v, def: v.def });
          else if (W && W.traffic && W.traffic.despawn) W.traffic.despawn(v);
        }
      } else if (a.tag && W && W.traffic && W.traffic.list) {
        // önbellek geçersizse listede ara (yuva yeniden kullanılmış olabilir)
        const L = W.traffic.list;
        for (let k = L.length - 1; k >= 0; k--) {
          const r = L[k];
          if (r && r.alive && this._mine(r.tag, a)) {
            r.keep = false; r.tag = null;
            if (a.spawned) { if (keepLeft) this._left.push({ veh: r, def: r.def }); else if (W.traffic.despawn) W.traffic.despawn(r); }
          }
        }
      }
      a.veh = null;
      // oyuncu görev aracındaysa etiket kaldırılır (indiğinde kalıcı 'keep' kaydı oluşmasın)
      const pv = this._pv(W);
      if (pv && this._mine(pv.tag, a)) pv.tag = null;
      if (a.type === 'taxi') this._removePassenger(a, W);
    }
    // all: TEKRAR DENE (hepsi silinir); değilse yalnız görünmeyenler silinir, görünenler sıradan park aracı kalır
    _dropLeftovers(all) {
      const W = this.W, tr = W && W.traffic;
      for (const e of this._left) {
        const v = e.veh;
        if (tr && tr.despawn && v && v.alive && v.tag === null && v.role === 'mission' && v.def === e.def && (all || !v.vis)) tr.despawn(v);
      }
      this._left.length = 0;
    }

    // ---------------- blipler ve çizim ----------------
    _put(out, n, x, y, k) {
      if (n >= 64) return n;
      let b = out[n];
      if (!b) b = out[n] = { x: 0, y: 0, k: 0 };
      b.x = x; b.y = y; b.k = k;
      return n + 1;
    }
    blips(out, n) {
      n = n | 0;
      if (!out) return n;
      const a = this.active;
      if (this.state !== 'run' || !a) {
        for (let i = 0; i < this.phones.length; i++) n = this._put(out, n, this.phones[i].x, this.phones[i].y, 3);
        for (let i = 0; i < this.sides.length; i++) n = this._put(out, n, this.sides[i].x, this.sides[i].y, 6);
        return n;
      }
      const o = this.objective;
      if (a.type === 'race' && a.step === 'run') {
        if (o.has) n = this._put(out, n, o.x, o.y, 10);
        return n;
      }
      if (a.type === 'escape') {
        n = this._put(out, n, a.dest.x, a.dest.y, 1);
        if (a.tag && this.W && this.W.onFoot && a.veh && a.veh.alive && this._mine(a.veh.tag, a)) n = this._put(out, n, a.veh.x, a.veh.y, 9);
        return n;
      }
      if (o.has) n = this._put(out, n, o.x, o.y, o.kind === 'veh' ? 9 : 1);
      return n;
    }
    drawGround(ctx, W) {
      W = W || this.W;
      const AS = DS.ActorSprites;
      if (!ctx || !W || !AS || !AS.drawRing) return;
      const t = W.t || 0, a = this.active;
      if (this.state !== 'run' || !a) {
        for (let i = 0; i < this.phones.length; i++) {
          const p = this.phones[i];
          if (W.isVisible(p.x, p.y, 2)) AS.drawRing(ctx, p.x, p.y, 1.4, p.crew ? p.crew.col : COL_TGT, t);
        }
        for (let i = 0; i < this.sides.length; i++) {
          const s = this.sides[i];
          if (W.isVisible(s.x, s.y, MARK_R)) AS.drawRing(ctx, s.x, s.y, MARK_R, COL_SIDE, t);
        }
        return;
      }
      const o = this.objective;
      switch (a.type) {
        case 'delivery':
        case 'steal':
          if ((a.step === 'drive' || a.step === 'crane') && W.isVisible(a.dest.x, a.dest.y, a.dest.r)) AS.drawRing(ctx, a.dest.x, a.dest.y, a.dest.r, COL_TGT, t);
          break;
        case 'escape':
          if (W.isVisible(a.dest.x, a.dest.y, a.dest.r)) AS.drawRing(ctx, a.dest.x, a.dest.y, a.dest.r, COL_TGT, t);
          break;
        case 'race':
          if (a.step === 'start' || a.step === 'count') { if (W.isVisible(a.mx, a.my, CP_R)) AS.drawRing(ctx, a.mx, a.my, CP_R, COL_TGT, t); }
          else if (a.step === 'run') {
            const nav = this.nav, n1 = nav.nodes[a.cps[a.cp]];
            if (W.isVisible(n1.x, n1.y, CP_R)) AS.drawRing(ctx, n1.x, n1.y, CP_R, COL_TGT, t);
            if (a.cp + 1 < a.cps.length) { const n2 = nav.nodes[a.cps[a.cp + 1]]; if (W.isVisible(n2.x, n2.y, CP_R)) AS.drawRing(ctx, n2.x, n2.y, CP_R * 0.6, COL_SIDE, t); }
          }
          break;
        case 'drift':
          this._drawZone(ctx, W, a);
          break;
        case 'taxi':
          if ((a.step === 'seek' && a.has) || a.step === 'board') { if (W.isVisible(a.rx, a.ry, TAXI_R)) AS.drawRing(ctx, a.rx, a.ry, TAXI_R, COL_TGT, t); }
          else if (a.step === 'ride' && W.isVisible(a.tx, a.ty, TAXI_R)) AS.drawRing(ctx, a.tx, a.ty, TAXI_R, COL_TGT, t);
          break;
      }
    }
    // drift bölgesinin sınırı (yalnız sınır görüş alanına yakınsa): ince yarı saydam çizgi
    _drawZone(ctx, W, a) {
      const z = a.zone;
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = COL_ZONE;
      ctx.lineWidth = 0.6;
      if (z.park) {
        const r = this._driftRect();
        if (W.isVisible((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, Math.max(r.x1 - r.x0, r.y1 - r.y0) / 2 + 4)) ctx.strokeRect(r.x0 + 1, r.y0 + 1, r.x1 - r.x0 - 2, r.y1 - r.y0 - 2);
      } else {
        const dc = Math.sqrt(d2(W.cx, W.cy, z.x, z.y)), vr = W.viewR || 60;
        if (dc + vr > z.r && dc - vr < z.r) { ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, PI * 2); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
    }
    drawAbove(ctx, W) {
      W = W || this.W;
      const AS = DS.ActorSprites, o = this.objective;
      if (!ctx || !W || !AS || !AS.drawBeacon || this.state !== 'run' || !o.has) return;
      if (W.isVisible(o.x, o.y, 4)) AS.drawBeacon(ctx, o.x, o.y, COL_TGT, W.t || 0);
    }
  }

  DS.Missions = Missions;
})();
