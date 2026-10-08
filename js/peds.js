'use strict';
// Açık şehir yayaları (DS.Peds) ve yaya oyuncu (DS.Walker).
// - Yayalar: 64'lük sabit havuz, tipli diziler (SoA), yoğun dizi + takas-sil (swap-remove); dış referanslar
//   kalıcı uid ile tutulur (find). Kaldırım grafiği (nav.ped, CSR) üzerinde yürür: kenar + yön + yol boyu
//   konumu + kişisel yanal kayma (sağa +). Düşünme (karşıdan geçiş izni, kaçınma) Q.aiHz ile kademeli,
//   entegrasyon her kare. Durumlar DS.PS: WANDER, WAIT, CROSS, DODGE, FLEE, FALL, DOWN, GETUP, IDLE, COP,
//   WAVE, GOTO. Şiddet çizgi film: devrilen yaya başında yıldızlarla 3 s yatar, kalkar ve kaçar (kan yok).
// - Walker: oyuncu yaya. Dünya yönlü giriş (döndürmeyi dünya yapar), doğrusal 0.12 s ivmelenme,
//   şehir kutu/daire ve araç OBB itmesi (duvar boyunca kayarak, köşe dürtmesi), yumruk, hasar, yenilenme.
// Sıcak yolda tahsis yok: tipli diziler, kalıcı karalama nesneleri, önceden bağlanmış geri çağrı.
(function () {
  const DS = window.DS, U = DS.U;
  const PI = Math.PI, TAU = PI * 2;
  const PS = DS.PS || { WANDER: 0, WAIT: 1, CROSS: 2, DODGE: 3, FLEE: 4, FALL: 5, DOWN: 6, GETUP: 7, IDLE: 8, COP: 9, WAVE: 10, GOTO: 11, GONE: 255 };
  const PR = DS.PR || { CIV: 0, COP: 1, MISSION: 2, DRIVER: 3 };
  const POSE = DS.POSE || { IDLE: 0, WALK: 1, RUN: 2, FALL: 3, DOWN: 4, PUNCH: 5, GETIN: 6, WAVE: 7, PANIC: 8 };
  const VM_RAIL = DS.VM ? DS.VM.RAIL : 0;

  const CAP = 64;                 // sabit havuz
  const R_PED = 0.35;             // yaya yarıçapı
  const LAT_MAX = 0.35;           // şerit bandı 2.55–3.25 m engelsiz: yanal kayma ±0.35
  const ON2 = 0.36;               // yol noktasına < 0.6 m: şeritte (yol boyu ilerler)
  const ACC = 8, DEC = 10;        // yaya hızlanma / yavaşlama (m/s²)
  const T_FALL = 0.35, T_DOWN = 3.0, T_GETUP = 0.4;
  const FRICT = 6;                // düşerken kayma sürtünmesi (m/s²)
  const DODGE_T = 0.45, DODGE_V = 4.5, DODGE_LOOK = 1.0, DODGE_GAP = 1.6, DODGE_P = 0.7, DODGE_CD = 1.2;
  const SEP_R = 0.9, SEP_W = 1.5;
  const WAIT_MAX = 12, JAY_P = 0.3;
  const STRIDE_W = 1.3, STRIDE_R = 2.2, RUN_V = 2.6;
  const W_CONT = 0.55, W_TURN = 0.25, W_CROSS = 0.15, W_BACK = 0.05;
  const ZONE_F = { build: 1, park: 1.2, parking: 0.7, ind: 0.4, drift: 0.4, road: 1 };
  const LOOK = 0.3;               // serbest harekette ızgara ileri bakışı (m)
  const MAX_THR = 48;             // kaçınma için tehdit (hareketli araç) listesi
  const MAX_RELAY = 4;            // bekleyen çığlık aktarımları

  // bayraklar
  const F_PATH = 1;               // grafiğe bağlı (edge/dir/along geçerli)
  const F_KEEP = 2;               // nüfus yönetimi silmez (polis/görev)
  const F_VIS = 4;                // bu kare görünür
  const F_JAY = 8;                // izinsiz geçiyor
  const F_HURRY = 16;             // ışık döndü: koşarak tamamla
  const F_PATIENT = 32;           // sinyalli geçitte sabırla bekliyor (zaman aşımı yok)
  const F_EXT = 64;               // spawnAt ile dışarıdan doğdu (sürücü, hata ayıklama): yoğunluk azaltması silmez

  const ROLE_BY_NAME = { civ: PR.CIV, cop: PR.COP, mission: PR.MISSION, driver: PR.DRIVER };

  // Araç OBB'sinden daire itme (tahsis yok; sonuç VP'de)
  const VP = { x: 0, y: 0, nx: 0, ny: 0 };
  function vehPush(px, py, r, veh) {
    const p = veh.p, def = veh.def;
    const hl = (p && p.len ? p.len : def && def.len ? def.len : 4.5) * 0.5;
    const hw = (p && p.wid ? p.wid : def && def.wid ? def.wid : 1.8) * 0.5;
    const dx = px - veh.x, dy = py - veh.y, br = hl + hw + r;
    if (dx * dx + dy * dy > br * br) return false;
    const c = Math.cos(veh.h), s = Math.sin(veh.h);
    const lx = c * dx + s * dy, ly = -s * dx + c * dy;
    const qx = lx < -hl ? -hl : lx > hl ? hl : lx, qy = ly < -hw ? -hw : ly > hw ? hw : ly;
    const ex = lx - qx, ey = ly - qy, d2 = ex * ex + ey * ey;
    if (d2 >= r * r) return false;
    let nlx, nly, pen;
    if (d2 > 1e-10) { const d = Math.sqrt(d2); nlx = ex / d; nly = ey / d; pen = r - d; }
    else {
      const ox = hl - Math.abs(lx), oy = hw - Math.abs(ly);
      if (ox < oy) { nlx = lx < 0 ? -1 : 1; nly = 0; pen = ox + r; } else { nlx = 0; nly = ly < 0 ? -1 : 1; pen = oy + r; }
    }
    VP.nx = c * nlx - s * nly; VP.ny = s * nlx + c * nly;
    VP.x = px + VP.nx * pen; VP.y = py + VP.ny * pen;
    return true;
  }

  // traffic.list: canlı kayıt sayısı (count verilmişse onunla sınırlı)
  function listLen(tr) {
    const L = tr.list;
    if (!L) return 0;
    return typeof tr.count === 'number' && tr.count < L.length ? tr.count : L.length;
  }

  // ======================================================================
  class Peds {
    constructor(W) {
      this.W = W || null;
      this.cap = CAP;
      this.n = 0;
      const F = () => new Float32Array(CAP), B = () => new Uint8Array(CAP);
      // SoA (§2.6.7)
      this.x = F(); this.y = F(); this.vx = F(); this.vy = F(); this.h = F(); this.spd = F(); this.phase = F();
      this.st = B(); this.role = B(); this.pal = B(); this.flags = B();
      this.t = F(); this.tt = F();
      this.edge = new Int16Array(CAP); this.dir = new Int8Array(CAP); this.along = F(); this.lat = F();
      this.tx = F(); this.ty = F();
      this.uid = new Int32Array(CAP);
      // iç durum
      this.ws = F(); this.rs = F(); this.ss = F();     // yürüme / koşma / hedef (seek) hızı
      this.cs = F();                                   // yol boyu anlık hız (komut)
      this.lat0 = F();                                 // kişisel yanal kayma
      this.fsx = F(); this.fsy = F(); this.ft = F();   // kaçış kaynağı ve süresi
      this.mvx = F(); this.mvy = F();                  // serbest hareket hızı (kaçınma/düşme)
      this.dcd = F();                                  // kaçınma zarı bekleme süresi
      this.stk = F();                                  // takılma süresi
      this.ret = B();                                  // kaçınma sonrası dönülecek durum
      this.pe = new Int16Array(CAP);                   // gelinen kenar (geri dönüş için)
      this._uidN = 0;
      this._rr = 0;
      this._popT = 0;
      this._fresh = true;
      this._lcx = 0; this._lcy = 0;
      this._frame = 0;
      this._tgt = -1;                                  // son nüfus adımındaki hedef (ara karelerde azaltma için)
      // tehdit listesi (kaçınma): hareketli araçlar
      this._thrF = -1; this._thrN = 0;
      this._thx = new Float32Array(MAX_THR); this._thy = new Float32Array(MAX_THR);
      this._thvx = new Float32Array(MAX_THR); this._thvy = new Float32Array(MAX_THR);
      this._thsp = new Float32Array(MAX_THR); this._thhw = new Float32Array(MAX_THR); this._thhl = new Float32Array(MAX_THR);
      // çığlık aktarımı kuyruğu
      this._rN = 0;
      this._rx = new Float32Array(MAX_RELAY); this._ry = new Float32Array(MAX_RELAY);
      this._rsx = new Float32Array(MAX_RELAY); this._rsy = new Float32Array(MAX_RELAY);
      this._rd = new Float32Array(MAX_RELAY); this._ru = new Int32Array(MAX_RELAY);
      // karalama
      this._cE = new Int32Array(8); this._cC = new Uint8Array(8); this._cW = new Float32Array(8);
      this._vl = new Int16Array(CAP);
      this._o = { edge: -1, t: 0, x: 0, y: 0, d: 0, lane: -1, s: 0, h: 0 };
      // palet renkleri (ActorSprites yoksa yedek çizim için)
      const pals = DS.PED_PALETTES || [];
      this._pcol = [];
      for (let k = 0; k < pals.length; k++) this._pcol.push(pals[k].shirt);
      this.nav = null; this.P = null; this.grid = null; this.GW = 0; this.city = null;
      this.Q = (W && W.Q) || null;
      this._bind(W);
    }

    _bind(W) {
      if (!W) return;
      if (W.nav && W.nav !== this.nav) {
        this.nav = W.nav; this.P = W.nav.ped; this.grid = W.nav.grid; this.GW = W.nav.GW;
      }
      if (W.city) this.city = W.city;
      this.W = W;
    }

    setQuality(Q) { if (Q) this.Q = Q; }

    reset() {
      this.n = 0; this._rN = 0; this._rr = 0; this._popT = 0; this._fresh = true; this._thrF = -1; this._tgt = -1;
    }

    // ---------------- yardımcılar ----------------
    _civPal() {
      const pals = DS.PED_PALETTES;
      const tot = pals ? pals.length - 2 : 0;
      if (tot <= 0) return 0;
      const Q = this.Q;
      const pp = Math.max(1, Math.min(tot, (Q && Q.pedPalettes) || 8));
      return 2 + ((Math.random() * pp) | 0);
    }
    // ızgara: yaya engeli (bit 2) ya da şehir dışı
    _solid(x, y) {
      const c = this.city;
      if (!(x > c.x0 + 0.3 && x < c.x1 - 0.3 && y > c.y0 + 0.3 && y < c.y1 - 0.3)) return true;
      return (this.grid[(y | 0) * this.GW + (x | 0)] & 2) !== 0;
    }
    // serbest yer değiştirme (ızgara kaydırması). 0 tam, 1 yalnız x, 2 yalnız y, 3 engelli
    _moveFree(i, mx, my) {
      const ox = this.x[i], oy = this.y[i];
      const l2 = mx * mx + my * my;
      if (l2 < 1e-12) return 0;
      const nx = ox + mx, ny = oy + my;
      if (this._solid(ox, oy)) { this.x[i] = nx; this.y[i] = ny; return 0; } // engel hücresindeyse kaçışa izin ver
      const l = Math.sqrt(l2), kx = (mx / l) * LOOK, ky = (my / l) * LOOK;
      if (!this._solid(nx + kx, ny + ky)) { this.x[i] = nx; this.y[i] = ny; return 0; }
      if (mx * mx > 1e-12 && !this._solid(nx + (mx > 0 ? LOOK : -LOOK), oy)) { this.x[i] = nx; return 1; }
      if (my * my > 1e-12 && !this._solid(ox, ny + (my > 0 ? LOOK : -LOOK))) { this.y[i] = ny; return 2; }
      return 3;
    }
    // en yakın yaya kenarına bağla; (ax, ay) verilirse o yöne yürüyecek şekilde
    _attach(i, ax, ay, hasAway) {
      const P = this.P, o = this._o;
      if (!this.nav.nearestPedEdge(this.x[i], this.y[i], o)) return false;
      const e = o.edge, a = P.ea[e], b = P.eb[e], L = P.eLen[e];
      const ex = (P.x[b] - P.x[a]) / L, ey = (P.y[b] - P.y[a]) / L;
      let d;
      if (hasAway && ax * ax + ay * ay > 1e-6) d = ex * ax + ey * ay >= 0 ? 1 : -1;
      else d = Math.random() < 0.5 ? 1 : -1;
      this.edge[i] = e; this.dir[i] = d;
      this.along[i] = d > 0 ? o.t * L : (1 - o.t) * L;
      // bulunduğu yanda kal (yanal kayma, yürüme yönünün sağı +)
      const rx = -ey * d, ry = ex * d;
      this.lat[i] = U.clamp((this.x[i] - o.x) * rx + (this.y[i] - o.y) * ry, -LAT_MAX, LAT_MAX);
      this.flags[i] |= F_PATH;
      this.pe[i] = -1; this.stk[i] = 0; this.cs[i] = 0;
      return true;
    }
    // geçit izni: sinyalliyse yaya fazı (en az 4 s yeşil kalmış), değilse şerit boşluğu + oyuncu aracı
    _mayCross(ce, W) {
      const P = this.P, nav = this.nav, node = P.eNode[ce];
      if (node < 0) return true;
      const N = nav.nodes[node], leg = P.eLeg[ce], t = W.t || 0;
      if (N && N.signal) return nav.walkOk(node, leg, t) && nav.walkOk(node, leg, t + 4);
      const tr = W.traffic;
      if (tr && tr.laneBusy && tr.laneBusy(node, leg, 25)) return false;
      if (W.inCar && W.pspeed > 3) {
        const mx = (P.x[P.ea[ce]] + P.x[P.eb[ce]]) * 0.5, my = (P.y[P.ea[ce]] + P.y[P.eb[ce]]) * 0.5;
        const dx = mx - W.px, dy = my - W.py;
        if (dx * dx + dy * dy < 625 && dx * W.pvx + dy * W.pvy > 0) return false;
      }
      return true;
    }

    // ---------------- doğurma / silme ----------------
    _alloc() {
      if (this.n >= CAP) return -1;
      const i = this.n++;
      this.vx[i] = 0; this.vy[i] = 0; this.spd[i] = 0; this.phase[i] = Math.random();
      this.flags[i] = 0; this.t[i] = 0; this.tt[i] = Math.random() * 0.1;
      this.edge[i] = 0; this.dir[i] = 1; this.along[i] = 0; this.lat[i] = 0;
      this.tx[i] = 0; this.ty[i] = 0; this.uid[i] = ++this._uidN;
      this.ws[i] = U.rand(1.1, 1.5); this.rs[i] = U.rand(3.8, 4.5); this.ss[i] = this.ws[i];
      this.cs[i] = 0; this.lat0[i] = U.rand(-LAT_MAX, LAT_MAX);
      this.fsx[i] = 0; this.fsy[i] = 0; this.ft[i] = 0; this.mvx[i] = 0; this.mvy[i] = 0;
      this.dcd[i] = 0; this.stk[i] = 0; this.ret[i] = PS.WANDER; this.pe[i] = -1;
      this.role[i] = PR.CIV; this.pal[i] = 2; this.st[i] = PS.WANDER;
      return i;
    }
    // grafikte bir noktada gezinen sivil (doğma halkası)
    _spawnEdge(e, tt) {
      const i = this._alloc();
      if (i < 0) return -1;
      const P = this.P, a = P.ea[e], b = P.eb[e], L = P.eLen[e];
      const d = Math.random() < 0.5 ? 1 : -1;
      this.edge[i] = e; this.dir[i] = d; this.along[i] = d > 0 ? tt * L : (1 - tt) * L;
      this.lat[i] = this.lat0[i];
      this.flags[i] = F_PATH;
      this.pal[i] = this._civPal();
      const ux = ((P.x[b] - P.x[a]) / L) * d, uy = ((P.y[b] - P.y[a]) / L) * d;
      const al = this.along[i], s = d > 0 ? a : b, la = this.lat[i];
      this.x[i] = P.x[s] + ux * al - uy * la; this.y[i] = P.y[s] + uy * al + ux * la;
      this.h[i] = Math.atan2(uy, ux);
      this.cs[i] = this.ws[i]; this.spd[i] = this.ws[i];
      return i;
    }

    // opts {pal, role, st, h, tx, ty} (+ isteğe bağlı mx,my: ayna merkezi, ör. araç merkezi). uid | -1
    spawnAt(x, y, opts) {
      const W = this.W;
      if (!this.nav || !this.city || !(x === x && y === y)) return -1;
      opts = opts || {};
      let role = opts.role;
      if (typeof role === 'string') role = ROLE_BY_NAME[role] !== undefined ? ROLE_BY_NAME[role] : PR.CIV;
      if (!(role >= 0)) role = PR.CIV;
      if (this.n >= CAP && (role === PR.COP || role === PR.MISSION)) this._evict(W);
      if (this.n >= CAP) return -1;
      // geçerli nokta: çarpışıcı içinde değil
      const c = this.city, o = this._o;
      const ok = (px, py) => px > c.x0 + 0.5 && px < c.x1 - 0.5 && py > c.y0 + 0.5 && py < c.y1 - 0.5 && !c.blocked(px, py, R_PED);
      let px = x, py = y, found = ok(px, py);
      if (!found) {
        // aynalı taraf: verilen merkez (opts.mx, my) ya da noktaya en yakın aracın merkezi (karşı kapı)
        let mx = opts.mx, my = opts.my;
        if (!(typeof mx === 'number' && typeof my === 'number')) {
          mx = undefined;
          const tr = W && W.traffic;
          if (tr && tr.list) {
            let bd = 9;
            for (let k = 0, nl = listLen(tr); k < nl; k++) {
              const v = tr.list[k];
              if (!v || !v.alive) continue;
              const dx = v.x - x, dy = v.y - y, d2 = dx * dx + dy * dy;
              if (d2 < bd) { bd = d2; mx = v.x; my = v.y; }
            }
          }
        }
        if (typeof mx === 'number') { px = 2 * mx - x; py = 2 * my - y; found = ok(px, py); }
      }
      if (!found) {
        for (let k = 0; k < 8 && !found; k++) {
          const a = (k * TAU) / 8;
          px = x + Math.cos(a) * 1.5; py = y + Math.sin(a) * 1.5; found = ok(px, py);
        }
      }
      if (!found && this.nav.nearestPedEdge(x, y, o)) { px = o.x; py = o.y; found = ok(px, py); }
      if (!found) return -1;
      const i = this._alloc();
      if (i < 0) return -1;
      this.x[i] = px; this.y[i] = py;
      this.flags[i] = F_EXT;
      this.role[i] = role;
      this.pal[i] = typeof opts.pal === 'number' ? opts.pal : role === PR.COP ? 1 : this._civPal();
      if (role === PR.COP || role === PR.MISSION) this.flags[i] |= F_KEEP;
      if (role === PR.COP) { this.rs[i] = 4.5; this.ss[i] = 4.5; }
      let st = typeof opts.st === 'number' ? opts.st : role === PR.COP ? PS.COP : PS.WANDER;
      if (st === PS.GONE || st === PS.FALL || st === PS.DOWN || st === PS.GETUP || st === PS.DODGE) st = PS.IDLE;
      this.h[i] = typeof opts.h === 'number' ? opts.h : Math.random() * TAU;
      this.tx[i] = typeof opts.tx === 'number' ? opts.tx : px;
      this.ty[i] = typeof opts.ty === 'number' ? opts.ty : py;
      if (st === PS.WANDER || st === PS.WAIT || st === PS.CROSS) {
        this.st[i] = PS.WANDER;
        if (!this._attach(i, 0, 0, false)) this.st[i] = PS.IDLE;
        else if (this.P.eKind[this.edge[i]] === 1) this.st[i] = PS.CROSS;
      } else if (st === PS.FLEE) {
        this.st[i] = PS.IDLE;
        const sx = W ? W.px : px, sy = W ? W.py : py;
        if (!this._flee(i, sx, sy)) this.st[i] = PS.IDLE;
      } else {
        this.st[i] = st;
      }
      return this.uid[i];
    }

    find(uid) {
      const U2 = this.uid;
      for (let i = 0; i < this.n; i++) if (U2[i] === uid) return i;
      return -1;
    }

    remove(i) {
      if (!(i >= 0 && i < this.n)) return;
      const j = --this.n;
      if (i !== j) {
        this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
        this.h[i] = this.h[j]; this.spd[i] = this.spd[j]; this.phase[i] = this.phase[j];
        this.st[i] = this.st[j]; this.role[i] = this.role[j]; this.pal[i] = this.pal[j]; this.flags[i] = this.flags[j];
        this.t[i] = this.t[j]; this.tt[i] = this.tt[j];
        this.edge[i] = this.edge[j]; this.dir[i] = this.dir[j]; this.along[i] = this.along[j]; this.lat[i] = this.lat[j];
        this.tx[i] = this.tx[j]; this.ty[i] = this.ty[j]; this.uid[i] = this.uid[j];
        this.ws[i] = this.ws[j]; this.rs[i] = this.rs[j]; this.ss[i] = this.ss[j]; this.cs[i] = this.cs[j];
        this.lat0[i] = this.lat0[j]; this.fsx[i] = this.fsx[j]; this.fsy[i] = this.fsy[j]; this.ft[i] = this.ft[j];
        this.mvx[i] = this.mvx[j]; this.mvy[i] = this.mvy[j]; this.dcd[i] = this.dcd[j]; this.stk[i] = this.stk[j];
        this.ret[i] = this.ret[j]; this.pe[i] = this.pe[j];
      }
      this.st[j] = PS.GONE; this.uid[j] = 0;
    }

    // havuz dolu: en uzak görünmez sıradan yayayı bırak
    _evict(W) {
      let best = -1, bd = -1;
      const cx = W ? W.cx : 0, cy = W ? W.cy : 0;
      for (let i = 0; i < this.n; i++) {
        if (this.flags[i] & (F_KEEP | F_VIS)) continue;
        const dx = this.x[i] - cx, dy = this.y[i] - cy, d = dx * dx + dy * dy;
        if (d > bd) { bd = d; best = i; }
      }
      if (best >= 0) this.remove(best);
      return best >= 0;
    }

    // ---------------- olaylar ----------------
    // ix,iy: itme hızı (m/s). FALL -> DOWN -> GETUP -> FLEE (polis: COP). Dünyaya onPedHit bir kez bildirilir.
    knock(i, ix, iy, src, speed) {
      if (!(i >= 0 && i < this.n)) return false;
      const s = this.st[i];
      if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE) return false;
      ix = ix || 0; iy = iy || 0;
      const L = Math.sqrt(ix * ix + iy * iy);
      this.st[i] = PS.FALL; this.t[i] = T_FALL;
      this.mvx[i] = ix; this.mvy[i] = iy;
      this.flags[i] &= ~(F_PATH | F_JAY | F_HURRY | F_PATIENT);
      // kaçış kaynağı: itmenin geldiği yön
      if (L > 1e-3) { this.fsx[i] = this.x[i] - (ix / L) * 4; this.fsy[i] = this.y[i] - (iy / L) * 4; }
      else { this.fsx[i] = this.x[i]; this.fsy[i] = this.y[i]; }
      if (L > 0.3) this.h[i] = Math.atan2(iy, ix) + PI; // geriye doğru düşer
      const W = this.W;
      if (W && W.world && W.world.onPedHit) W.world.onPedHit(i, src === undefined ? null : src, typeof speed === 'number' ? speed : L);
      return true;
    }

    // Hareket eden aracın OBB'si (x,y merkez; c,s yön; hl,hw yarı boyutlar), son dt'deki hareketiyle süpürülmüş.
    // Vurulan (devrilen) yaya sayısı döner; yavaş temas (≤ 2.5 m/s) yayayı yalnızca iter.
    hitTest(x, y, c, s, hl, hw, vx, vy, dt, src) {
      const n0 = this.n;
      if (!n0) return 0;
      dt = dt || 0;
      const vl = vx * c + vy * s, vt = -vx * s + vy * c;
      const HL = hl + Math.abs(vl) * dt * 0.5, HW = hw + Math.abs(vt) * dt * 0.5;
      const cx = x - vx * dt * 0.5, cy = y - vy * dt * 0.5;
      const br = HL + HW + R_PED, br2 = br * br, r2 = R_PED * R_PED;
      const X = this.x, Y = this.y, ST = this.st;
      let cnt = 0;
      for (let i = 0; i < this.n; i++) {
        const st = ST[i];
        if (st === PS.FALL || st === PS.DOWN || st === PS.GETUP || st === PS.GONE) continue;
        const dx = X[i] - cx, dy = Y[i] - cy;
        if (dx * dx + dy * dy > br2) continue;
        const lx = c * dx + s * dy, ly = -s * dx + c * dy;
        const qx = lx < -HL ? -HL : lx > HL ? HL : lx, qy = ly < -HW ? -HW : ly > HW ? HW : ly;
        const ex = lx - qx, ey = ly - qy, d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        let nlx, nly, pen;
        if (d2 > 1e-8) { const d = Math.sqrt(d2); nlx = ex / d; nly = ey / d; pen = R_PED - d; }
        else { nlx = 0; nly = ly >= 0 ? 1 : -1; pen = HW - Math.abs(ly) + R_PED; } // içeride: yana savrulur
        const nx = c * nlx - s * nly, ny = s * nlx + c * nly;
        const rvx = vx - this.vx[i], rvy = vy - this.vy[i];
        const rel = Math.sqrt(rvx * rvx + rvy * rvy);
        if (rel > 2.5) {
          if (this.knock(i, 0.6 * vx + 2 * nx, 0.6 * vy + 2 * ny, src, rel)) cnt++;
        } else {
          // itme: kutudan çıkar (duvara girmeden) ve ~1 m yana adım
          const pm = pen < 1.2 ? pen : 1.2;
          this._moveFree(i, nx * pm, ny * pm);
          if (st === PS.WANDER || st === PS.WAIT || st === PS.CROSS || st === PS.FLEE) {
            this.ret[i] = st; this.st[i] = PS.DODGE; this.t[i] = 0.25;
            this.mvx[i] = nx * 4; this.mvy[i] = ny * 4;
          }
        }
      }
      return cnt;
    }

    // olay darbesi: r içindeki yayalar olasılıkla kaçar; tek bir çığlık aktarımı (r 7, 0.3–0.6 s sonra)
    panic(x, y, r, strength) { this._panic(x, y, r, strength, x, y, 0); }
    _panic(x, y, r, strength, sx, sy, hop) {
      if (!(r > 0)) return;
      const r2 = r * r;
      let scr = -1;
      for (let i = 0; i < this.n; i++) {
        const ro = this.role[i];
        if (ro === PR.COP || ro === PR.MISSION) continue;
        const st = this.st[i];
        if (st === PS.FALL || st === PS.DOWN || st === PS.GETUP || st === PS.GONE) continue;
        const dx = this.x[i] - x, dy = this.y[i] - y, d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const p = Math.min(1, 2 * strength * (1 - Math.sqrt(d2) / r));
        if (Math.random() >= p) continue;
        if (this._flee(i, sx, sy) && scr < 0 && hop === 0) scr = i;
      }
      if (scr >= 0 && this._rN < MAX_RELAY) {
        const k = this._rN++;
        this._rx[k] = this.x[scr]; this._ry[k] = this.y[scr]; this._rsx[k] = sx; this._rsy[k] = sy;
        this._rd[k] = U.rand(0.3, 0.6); this._ru[k] = this.uid[scr];
      }
    }
    _flee(i, sx, sy) {
      const s = this.st[i];
      if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE) return false;
      this.fsx[i] = sx; this.fsy[i] = sy;
      const ft = U.rand(6, 10);
      this.ft[i] = s === PS.FLEE || (s === PS.DODGE && this.ret[i] === PS.FLEE) ? Math.max(this.ft[i], ft) : ft;
      if (s === PS.DODGE) { this.ret[i] = PS.FLEE; return true; }
      if (!(this.flags[i] & F_PATH)) {
        if (!this._attach(i, this.x[i] - sx, this.y[i] - sy, true)) return false;
      } else {
        // şeritteyse kaynaktan uzaklaşan yöne dön
        const P = this.P, e = this.edge[i], d = this.dir[i];
        const a = d > 0 ? P.ea[e] : P.eb[e], b = d > 0 ? P.eb[e] : P.ea[e];
        const ux = P.x[b] - P.x[a], uy = P.y[b] - P.y[a];
        if (ux * (this.x[i] - sx) + uy * (this.y[i] - sy) < 0) {
          this.dir[i] = -d; this.along[i] = P.eLen[e] - this.along[i]; this.lat[i] = -this.lat[i];
        }
      }
      this.st[i] = PS.FLEE;
      this.flags[i] &= ~(F_JAY | F_HURRY | F_PATIENT);
      return true;
    }

    // (x,y)'ye r içinde en yakın ayakta yaya; roleMask: (1 << DS.PR.*) bitleri (0/yok = hepsi)
    nearest(x, y, r, roleMask) {
      let best = -1, bd = r * r;
      for (let i = 0; i < this.n; i++) {
        const st = this.st[i];
        if (st === PS.FALL || st === PS.DOWN || st === PS.GETUP || st === PS.GONE) continue;
        if (roleMask && !((1 << this.role[i]) & roleMask)) continue;
        const dx = this.x[i] - x, dy = this.y[i] - y, d2 = dx * dx + dy * dy;
        if (d2 <= bd) { bd = d2; best = i; }
      }
      return best;
    }

    // yoldaki yayalar (yüzey bit 4): out[(off+k)*5 ..] = [x, y, vx, vy, r]; off ve max kayıt (5'li) birimindedir
    roadObstacles(out, off, max) {
      if (!this.grid || !out) return 0;
      off = off | 0;
      const g = this.grid, GW = this.GW, GH = (this.nav && this.nav.GH) || 0, cap = Math.floor(out.length / 5);
      let k = 0;
      for (let i = 0; i < this.n && k < max && off + k < cap; i++) {
        const st = this.st[i];
        if (st === PS.GONE) continue;
        const x = this.x[i], y = this.y[i];
        if (!(x >= 0 && y >= 0 && x < GW && y < GH)) continue;
        if (!(g[(y | 0) * GW + (x | 0)] & 4)) continue;
        const o = (off + k) * 5;
        out[o] = x; out[o + 1] = y; out[o + 2] = this.vx[i]; out[o + 3] = this.vy[i];
        out[o + 4] = st === PS.DOWN || st === PS.FALL || st === PS.GETUP ? 0.6 : 0.4;
        k++;
      }
      return k;
    }

    // COP/GOTO hedefi (polis, görevler); devrik yayada hedef saklanır, kalkınca kullanılır
    seek(i, tx, ty, speed) {
      if (!(i >= 0 && i < this.n)) return;
      this.tx[i] = tx; this.ty[i] = ty;
      if (typeof speed === 'number' && speed > 0) this.ss[i] = speed;
      const s = this.st[i];
      if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE) return;
      if (s !== PS.COP && s !== PS.GOTO) {
        if (s === PS.DODGE) this.mvx[i] = this.mvy[i] = 0;
        this.st[i] = this.role[i] === PR.COP ? PS.COP : PS.GOTO;
        this.flags[i] &= ~(F_PATH | F_JAY | F_HURRY | F_PATIENT);
      }
    }

    // en fazla (görünür alan dahil) hedef nüfusa kadar hemen doldur (dünya başlangıcı / ışınlama)
    fill(W) {
      W = W || this.W;
      if (!W || !this.nav) return 0;
      this._bind(W);
      const target = this._target(W), o = this._o;
      const amb0 = this._despawnFar(W);
      let amb = amb0, made = 0;
      for (let tries = 0; tries < target * 4 && amb < target && this.n < CAP; tries++) {
        if (!this.nav.pickPedSpawn(W.cx, W.cy, 0, W.viewR + 25, Math.random, o)) break;
        const zf = ZONE_F[this.nav.zoneAt(o.x, o.y)] || 1;
        if (Math.random() > zf / 1.2) continue;
        const dx = o.x - W.px, dy = o.y - W.py;
        if (dx * dx + dy * dy < 36) continue;
        if (this._crowded(o.x, o.y)) continue;
        if (this._spawnEdge(o.edge, o.t) >= 0) { amb++; made++; }
      }
      return made;
    }

    _crowded(x, y) {
      for (let i = 0; i < this.n; i++) {
        const dx = this.x[i] - x, dy = this.y[i] - y;
        if (dx * dx + dy * dy < 2.25) return true;
      }
      return false;
    }

    // ortam yayası hedef sayısı: Q.peds × bölge × saat × yağmur (en çok Q.peds)
    _target(W) {
      const Q = this.Q || W.Q || {};
      const base = typeof Q.peds === 'number' ? Q.peds : 16;
      const zf = ZONE_F[this.nav.zoneNear(W.cx, W.cy)] || 1;
      const ck = W.clock;
      let tf = 1;
      if (typeof ck === 'number' && ck >= 1 && ck < 5) tf = 0.35;
      else if (W.night) tf = 0.6;
      const rf = W.env && W.env.rain ? 0.6 : 1;
      // Q.peds bütçedir (sert sınır): park katsayısı 1.2 onu aşamaz, yalnız doğma dağılımını etkiler
      return Math.max(0, Math.min(CAP, base, Math.round(base * zf * tf * rf)));
    }

    // GONE ve halkanın (viewR + 40) dışındaki görünmez sıradan yayaları sil; kalan sıradan yaya sayısı
    _despawnFar(W) {
      const cx = W.cx, cy = W.cy, R = W.viewR + 40, R2 = R * R;
      let amb = 0;
      for (let i = this.n - 1; i >= 0; i--) {
        if (this.st[i] === PS.GONE) { this.remove(i); continue; }
        if (this.flags[i] & F_KEEP) continue;
        if (!(this.flags[i] & F_VIS)) {
          const dx = this.x[i] - cx, dy = this.y[i] - cy;
          if (dx * dx + dy * dy > R2) { this.remove(i); continue; }
        }
        amb++;
      }
      return amb;
    }

    // kalite/yoğunluk düşünce fazlayı yavaşça sil (her kare ≤ 2, en uzak görünmezden; görünür olan yalnız
    // sert sınır Q.peds aşılıyorsa ve görünmez aday kalmadıysa). Kalan sıradan yaya sayısı döner.
    _shrink(W, amb, target) {
      const cx = W.cx, cy = W.cy;
      const Q = this.Q || W.Q || {}, hard = typeof Q.peds === 'number' ? Q.peds : 16;
      for (let k = 0; k < 2 && amb > target; k++) {
        let best = -1, bd = -1;
        const visOk = amb > hard;
        for (let pass = 0; pass < (visOk ? 2 : 1) && best < 0; pass++) {
          for (let i = 0; i < this.n; i++) {
            const fl = this.flags[i];
            if (fl & (F_KEEP | F_EXT)) continue;
            if (pass === 0 && fl & F_VIS) continue;
            const dx = this.x[i] - cx, dy = this.y[i] - cy, d = dx * dx + dy * dy;
            if (d > bd) { bd = d; best = i; }
          }
        }
        if (best < 0) break;
        this.remove(best); amb--;
      }
      return amb;
    }

    _population(W) {
      const cx = W.cx, cy = W.cy;
      const target = (this._tgt = this._target(W));
      const amb = this._shrink(W, this._despawnFar(W), target);
      this._spawnRing(W, amb, target, cx, cy);
    }
    _spawnRing(W, amb, target, cx, cy) {
      // doğma halkası [viewR+4, viewR+25], adım başına ≤ 2
      const o = this._o;
      for (let k = 0; k < 2 && amb < target && this.n < CAP; k++) {
        if (!this.nav.pickPedSpawn(cx, cy, W.viewR + 4, W.viewR + 25, Math.random, o)) break;
        if (W.isVisible && W.isVisible(o.x, o.y, 1.5)) continue;
        const zf = ZONE_F[this.nav.zoneAt(o.x, o.y)] || 1;
        if (Math.random() > zf / 1.2) continue;
        if (this._crowded(o.x, o.y)) continue;
        if (this._spawnEdge(o.edge, o.t) >= 0) amb++;
      }
    }

    // ---------------- kare güncellemesi ----------------
    update(dt, W) {
      if (!W || !W.nav || !W.city) return;
      this._bind(W);
      if (!(dt > 0)) return;
      this._frame++;
      // kamera sıçradıysa (ışınlama, yeniden doğma) çevreyi yeniden doldur
      const jx = W.cx - this._lcx, jy = W.cy - this._lcy;
      if (jx * jx + jy * jy > 3600) this._fresh = true;
      this._lcx = W.cx; this._lcy = W.cy;
      // görünürlük
      const v = W.view, M = 1.5;
      for (let i = 0; i < this.n; i++) {
        const x = this.x[i], y = this.y[i];
        if (v && x > v.x0 - M && x < v.x1 + M && y > v.y0 - M && y < v.y1 + M) this.flags[i] |= F_VIS;
        else this.flags[i] &= ~F_VIS;
      }
      if (this._fresh) {
        this._fresh = false;
        this.fill(W);
      }
      // çığlık aktarımları
      for (let k = this._rN - 1; k >= 0; k--) {
        this._rd[k] -= dt;
        if (this._rd[k] > 0) continue;
        const j = this.find(this._ru[k]);
        const rx = j >= 0 ? this.x[j] : this._rx[k], ry = j >= 0 ? this.y[j] : this._ry[k];
        const sx = this._rsx[k], sy = this._rsy[k];
        const last = --this._rN;
        this._rx[k] = this._rx[last]; this._ry[k] = this._ry[last]; this._rsx[k] = this._rsx[last];
        this._rsy[k] = this._rsy[last]; this._rd[k] = this._rd[last]; this._ru[k] = this._ru[last];
        this._panic(rx, ry, 7, 0.5, sx, sy, 1);
      }
      // kademeli düşünme
      const n = this.n;
      for (let i = 0; i < n; i++) this.tt[i] += dt;
      if (n > 0) {
        const Q = this.Q || W.Q || {};
        let k = Math.ceil(n * (Q.aiHz || 8) * dt);
        if (k > n) k = n;
        for (let c = 0; c < k; c++) {
          if (this._rr >= this.n) this._rr = 0;
          this._think(this._rr, W);
          this._rr++;
        }
      }
      // entegrasyon
      for (let i = 0; i < this.n; i++) this._step(i, dt, W);
      this._separate(dt, W);
      // nüfus (0.2 s'de bir)
      this._popT -= dt;
      if (this._popT <= 0) {
        this._popT += 0.2;
        if (this._popT < 0) this._popT = 0.2;
        this._population(W);
      } else if (this._tgt >= 0) {
        // ara karelerde yalnız fazlalık azaltma (kare başına ≤ 2)
        let amb = 0;
        for (let i = 0; i < this.n; i++) if (!(this.flags[i] & F_KEEP)) amb++;
        if (amb > this._tgt) this._shrink(W, amb, this._tgt);
      }
    }

    // ---- düşünme: kaçınma zarı, geçit izni, bekleme zaman aşımı ----
    _think(i, W) {
      this.tt[i] = 0;
      const s = this.st[i];
      if ((s === PS.WANDER || s === PS.WAIT || s === PS.CROSS || s === PS.FLEE) && this.dcd[i] <= 0) {
        if (this._dodgeCheck(i, W)) return;
      }
      if (s === PS.WAIT) {
        const ce = this.edge[i];
        if (this._mayCross(ce, W)) {
          this.st[i] = PS.CROSS;
        } else if (this.t[i] > WAIT_MAX && !(this.flags[i] & F_PATIENT)) {
          const node = this.P.eNode[ce], sig = node >= 0 && this.nav.nodes[node].signal;
          if (Math.random() < JAY_P) {
            // sinyalli geçitte kırmızıda asla geçmez: sabırla bekler; sinyalsizde dikkatsizce geçer
            if (sig) this.flags[i] |= F_PATIENT;
            else { this.st[i] = PS.CROSS; this.flags[i] |= F_JAY; }
          } else {
            this._turnBack(i);
          }
        }
      } else if (s === PS.CROSS) {
        const ce = this.edge[i], node = this.P.eNode[ce];
        if (node >= 0 && this.nav.nodes[node].signal && !this.nav.walkOk(node, this.P.eLeg[ce], W.t || 0)) this.flags[i] |= F_HURRY;
      }
    }

    // bekleyen yaya geri döner (geldiği kenardan, yoksa geçit olmayan rastgele bir kenardan)
    _turnBack(i) {
      const P = this.P, ce = this.edge[i];
      const node = this.dir[i] > 0 ? P.ea[ce] : P.eb[ce];
      let f = this.pe[i];
      if (f < 0 || f === ce || P.eKind[f] === 1 || (P.ea[f] !== node && P.eb[f] !== node)) {
        f = -1;
        const s0 = P.eStart[node], s1 = P.eStart[node + 1];
        let m = 0;
        for (let k = s0; k < s1; k++) if (P.eKind[P.adj[k]] !== 1) m++;
        if (m > 0) {
          let r = (Math.random() * m) | 0;
          for (let k = s0; k < s1; k++) if (P.eKind[P.adj[k]] !== 1 && r-- === 0) { f = P.adj[k]; break; }
        }
      }
      if (f < 0) { this.flags[i] |= F_PATIENT; return; }
      this.edge[i] = f; this.dir[i] = P.ea[f] === node ? 1 : -1; this.along[i] = 0;
      this.pe[i] = ce;
      this.st[i] = PS.WANDER; this.t[i] = 0;
      this.flags[i] &= ~(F_JAY | F_HURRY | F_PATIENT);
    }

    // hareketli araçlar (oyuncu aracı + trafik), kare başına bir kez
    _threats(W) {
      if (this._thrF === this._frame) return;
      this._thrF = this._frame;
      let m = 0;
      const TX = this._thx, TY = this._thy, TVX = this._thvx, TVY = this._thvy, TS = this._thsp, THW = this._thhw, THL = this._thhl;
      if (W.inCar && W.pspeed > 2) {
        const car = W.car, p = car && car.p;
        TX[m] = W.px; TY[m] = W.py; TVX[m] = W.pvx; TVY[m] = W.pvy; TS[m] = W.pspeed;
        THW[m] = p && p.wid ? p.wid * 0.5 : 0.95; THL[m] = p && p.len ? p.len * 0.5 : 2.3; m++;
      }
      const tr = W.traffic;
      if (tr && tr.list) {
        const L = tr.list, nl = listLen(tr), R = W.viewR + 45, R2 = R * R;
        for (let k = 0; k < nl && m < MAX_THR; k++) {
          const v = L[k];
          if (!v || !v.alive) continue;
          let vx, vy, sp;
          if (v.mode === VM_RAIL) {
            sp = v.v || 0;
            if (sp < 2) continue;
            vx = Math.cos(v.h) * sp; vy = Math.sin(v.h) * sp;
          } else {
            vx = v.vx || 0; vy = v.vy || 0; sp = Math.sqrt(vx * vx + vy * vy);
            if (sp < 2) continue;
          }
          const dx = v.x - W.cx, dy = v.y - W.cy;
          if (dx * dx + dy * dy > R2) continue;
          const p = v.p;
          TX[m] = v.x; TY[m] = v.y; TVX[m] = vx; TVY[m] = vy; TS[m] = sp;
          THW[m] = p && p.wid ? p.wid * 0.5 : 0.9; THL[m] = p && p.len ? p.len * 0.5 : 2.3; m++;
        }
      }
      this._thrN = m;
    }

    // 1.0 s'lik süpürülmüş yolu 1.6 m'den yakın geçen araç -> %70 yana atılma (2 m, 4.5 m/s, 0.45 s)
    _dodgeCheck(i, W) {
      this._threats(W);
      const m = this._thrN;
      if (!m) return false;
      const x = this.x[i], y = this.y[i];
      for (let k = 0; k < m; k++) {
        const sp = this._thsp[k], ux = this._thvx[k] / sp, uy = this._thvy[k] / sp;
        const rx = x - this._thx[k], ry = y - this._thy[k];
        const al = rx * ux + ry * uy, hl = this._thhl[k];
        if (al < -hl || al > sp * DODGE_LOOK + hl) continue;
        const la = -rx * uy + ry * ux; // aracın sağı +
        const lim = this._thhw[k] + DODGE_GAP;
        if (la > lim || la < -lim) continue;
        this.dcd[i] = DODGE_CD;
        if (Math.random() >= DODGE_P) return false;
        let sg = la > 0.05 ? 1 : la < -0.05 ? -1 : Math.random() < 0.5 ? -1 : 1;
        this.ret[i] = this.st[i]; this.st[i] = PS.DODGE; this.t[i] = DODGE_T;
        this.mvx[i] = -uy * sg * DODGE_V; this.mvy[i] = ux * sg * DODGE_V;
        return true;
      }
      return false;
    }

    // ---- entegrasyon (her kare, her yaya) ----
    _step(i, dt, W) {
      const ox = this.x[i], oy = this.y[i];
      let s = this.st[i];
      if (this.dcd[i] > 0) this.dcd[i] -= dt;
      switch (s) {
        case PS.WANDER: case PS.WAIT: case PS.CROSS: case PS.FLEE:
          if (s === PS.WAIT) this.t[i] += dt;
          if (s === PS.FLEE) {
            this.ft[i] -= dt;
            if (this.ft[i] <= 0) { this.st[i] = s = PS.WANDER; }
          }
          this._follow(i, dt, W);
          break;
        case PS.DODGE:
          this._moveFree(i, this.mvx[i] * dt, this.mvy[i] * dt);
          this.t[i] -= dt;
          if (this.t[i] <= 0) {
            let r = this.ret[i];
            if (r !== PS.WANDER && r !== PS.WAIT && r !== PS.CROSS && r !== PS.FLEE) r = PS.WANDER;
            this.st[i] = r;
            if (!(this.flags[i] & F_PATH)) {
              this.st[i] = PS.IDLE;
              if (r === PS.FLEE) { if (!this._flee(i, this.fsx[i], this.fsy[i])) this.st[i] = PS.IDLE; }
              else if (this._attach(i, 0, 0, false)) this.st[i] = this.P.eKind[this.edge[i]] === 1 ? PS.CROSS : PS.WANDER;
            }
          }
          break;
        case PS.FALL: {
          let vx = this.mvx[i], vy = this.mvy[i];
          const sp = Math.sqrt(vx * vx + vy * vy);
          if (sp > 1e-3) {
            const ns = Math.max(0, sp - FRICT * dt), k = ns / sp;
            vx *= k; vy *= k; this.mvx[i] = vx; this.mvy[i] = vy;
            const r = this._moveFree(i, vx * dt, vy * dt);
            if (r === 3) { this.mvx[i] = 0; this.mvy[i] = 0; }
            else if (r === 1) this.mvy[i] = 0;
            else if (r === 2) this.mvx[i] = 0;
          }
          this.t[i] -= dt;
          if (this.t[i] <= 0) { this.st[i] = PS.DOWN; this.t[i] += T_DOWN; }
          break;
        }
        case PS.DOWN:
          this.t[i] -= dt;
          if (this.t[i] <= 0) { this.st[i] = PS.GETUP; this.t[i] += T_GETUP; }
          break;
        case PS.GETUP:
          this.t[i] -= dt;
          if (this.t[i] <= 0) {
            this.t[i] = 0; this.mvx[i] = 0; this.mvy[i] = 0;
            if (this.role[i] === PR.COP) this.st[i] = PS.COP;
            else {
              this.st[i] = PS.IDLE;
              if (!this._flee(i, this.fsx[i], this.fsy[i])) this.st[i] = PS.IDLE;
            }
          }
          break;
        case PS.COP: case PS.GOTO: {
          const dx = this.tx[i] - ox, dy = this.ty[i] - oy, d2 = dx * dx + dy * dy;
          if (d2 > 0.0625) {
            const d = Math.sqrt(d2), want = this.ss[i];
            let sp = this.cs[i];
            sp = sp < want ? Math.min(want, sp + ACC * dt) : Math.max(want, sp - DEC * dt);
            const step = Math.min(sp * dt, d);
            const r = this._moveFree(i, (dx / d) * step, (dy / d) * step);
            this.cs[i] = r === 3 ? 0 : sp;
            this._vehPushPed(i, W);
          } else {
            this.cs[i] = 0;
            if (s === PS.GOTO) this.st[i] = PS.IDLE;
            else this.h[i] = this._turn(this.h[i], Math.atan2(dy, dx), 10 * dt);
          }
          break;
        }
        case PS.WAVE: {
          // taksi bekleyen yolcu: oyuncuya döner ve el sallar
          this.h[i] = this._turn(this.h[i], Math.atan2(W.py - oy, W.px - ox), 6 * dt);
          this.cs[i] = 0;
          break;
        }
        default: // IDLE
          this.cs[i] = 0;
          break;
      }
      // hız (gözlemlenen) ve yön
      const x = this.x[i], y = this.y[i];
      const vx = (x - ox) / dt, vy = (y - oy) / dt;
      this.vx[i] = vx; this.vy[i] = vy;
      const v2 = vx * vx + vy * vy;
      const sp = Math.sqrt(v2);
      this.spd[i] = sp;
      s = this.st[i];
      if (s === PS.WAIT) {
        // geçit yönüne bak
        const P = this.P, e = this.edge[i], d = this.dir[i];
        const a = d > 0 ? P.ea[e] : P.eb[e], b = d > 0 ? P.eb[e] : P.ea[e];
        this.h[i] = this._turn(this.h[i], Math.atan2(P.y[b] - P.y[a], P.x[b] - P.x[a]), 8 * dt);
      } else if (v2 > 0.04 && s !== PS.FALL && s !== PS.DODGE && s !== PS.DOWN && s !== PS.GETUP) {
        this.h[i] = this._turn(this.h[i], Math.atan2(vy, vx), 10 * dt);
      }
      // yürüyüş evresi yalnız görünürken (mesafe güdümlü)
      if (this.flags[i] & F_VIS) {
        if (s === PS.WAVE) this.phase[i] += dt * 1.6;
        else if (sp > 0.05) this.phase[i] += (sp * dt) / (sp > RUN_V ? STRIDE_R : STRIDE_W);
        if (this.phase[i] > 1000) this.phase[i] -= 1000;
      }
    }

    _turn(h, to, maxd) {
      let d = to - h;
      if (d > PI) d -= TAU * Math.ceil((d - PI) / TAU);
      else if (d < -PI) d += TAU * Math.ceil((-PI - d) / TAU);
      if (d > maxd) d = maxd; else if (d < -maxd) d = -maxd;
      h += d;
      if (h > PI) h -= TAU; else if (h < -PI) h += TAU;
      return h;
    }

    // polis/hedefe giden yaya araç gövdelerinin içinden geçmez (yalnız yakın araçlar)
    _vehPushPed(i, W) {
      const tr = W.traffic;
      if (!tr || !tr.list) return;
      const L = tr.list, nl = listLen(tr);
      for (let k = 0; k < nl; k++) {
        const v = L[k];
        if (!v || !v.alive) continue;
        if (vehPush(this.x[i], this.y[i], R_PED, v)) {
          if (!this._solid(VP.x, VP.y)) { this.x[i] = VP.x; this.y[i] = VP.y; }
        }
      }
    }

    // grafikte yürüme: yol boyu ilerle, düğümde sonraki kenarı seç, yol noktasını izle
    _follow(i, dt, W) {
      const P = this.P, X = P.x, Y = P.y, EA = P.ea, EB = P.eb, EL = P.eLen;
      let s = this.st[i];
      let want;
      if (s === PS.WAIT) want = 0;
      else if (s === PS.FLEE) want = this.rs[i];
      else if (s === PS.CROSS) want = this.flags[i] & F_HURRY ? this.rs[i] * 0.85 : this.ws[i] * 1.3;
      else want = this.ws[i];
      let sp = this.cs[i];
      sp = sp < want ? Math.min(want, sp + ACC * dt) : Math.max(want, sp - DEC * dt);
      // yanal kayma kişisel değerine döner
      this.lat[i] = U.approach(this.lat[i], this.lat0[i], 0.25 * dt);
      let e = this.edge[i], d = this.dir[i], al = this.along[i];
      let a = d > 0 ? EA[e] : EB[e], b = d > 0 ? EB[e] : EA[e];
      let L = EL[e], ux = (X[b] - X[a]) / L, uy = (Y[b] - Y[a]) / L;
      let la = this.lat[i];
      const cx = this.x[i], cy = this.y[i];
      let px = X[a] + ux * al - uy * la, py = Y[a] + uy * al + ux * la;
      let dx = px - cx, dy = py - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < ON2) {
        this.stk[i] = 0;
        if (s !== PS.WAIT) al += sp * dt;
        for (let guard = 0; al >= L && guard < 4; guard++) {
          al -= L;
          const node = b;
          if (s === PS.CROSS) { s = PS.WANDER; this.st[i] = s; this.flags[i] &= ~(F_JAY | F_HURRY | F_PATIENT); }
          const f = s === PS.FLEE ? this._pickFlee(i, node, e, ux, uy) : this._pickNext(node, e, ux, uy);
          if (f === e) { d = -d; this.lat[i] = -this.lat[i]; }
          else { this.pe[i] = e; e = f; d = EA[f] === node ? 1 : -1; }
          this.edge[i] = e; this.dir[i] = d;
          a = d > 0 ? EA[e] : EB[e]; b = d > 0 ? EB[e] : EA[e];
          L = EL[e]; ux = (X[b] - X[a]) / L; uy = (Y[b] - Y[a]) / L;
          if (P.eKind[e] === 1 && s === PS.WANDER) {
            if (this._mayCross(e, W)) { s = PS.CROSS; this.st[i] = s; }
            else { s = PS.WAIT; this.st[i] = s; this.t[i] = 0; al = 0; sp = 0; break; }
          }
        }
        this.along[i] = al;
        la = this.lat[i];
        px = X[a] + ux * al - uy * la; py = Y[a] + uy * al + ux * la;
        dx = px - cx; dy = py - cy;
        const dd = dx * dx + dy * dy, step = (sp * 1.25 + 0.8) * dt;
        if (dd <= step * step) { this.x[i] = px; this.y[i] = py; }
        else { const k = step / Math.sqrt(dd); this.x[i] = cx + dx * k; this.y[i] = cy + dy * k; }
      } else {
        // şeride geri dön (kaçınma, düşme sonrası): ızgara kaydırmalı serbest hareket
        const dist = Math.sqrt(d2), step = Math.min(dist, Math.max(sp, this.ws[i]) * dt);
        const r = this._moveFree(i, (dx / dist) * step, (dy / dist) * step);
        if (r === 3) {
          this.stk[i] += dt;
          if (this.stk[i] > 1.5) {
            // takıldı: görünmüyorsa kaldır, görünüyorsa bulunduğu yerden en yakın kenara yeniden bağlan
            if (!(this.flags[i] & (F_VIS | F_KEEP))) this.st[i] = PS.GONE;
            else if (this._attach(i, this.x[i] - this.fsx[i], this.y[i] - this.fsy[i], s === PS.FLEE)) {
              this.stk[i] = 0;
              if (s === PS.WAIT) this.st[i] = PS.WANDER;
              if (this.P.eKind[this.edge[i]] === 1 && this.st[i] === PS.WANDER) this.st[i] = PS.CROSS;
            }
          }
        } else this.stk[i] = 0;
      }
      this.cs[i] = sp;
    }

    // köşe seçimi: düz 0.55, dönüş 0.25, geçit 0.15, geri 0.05 (mevcutlar arasında yeniden normalize)
    _pickNext(node, e, ux, uy) {
      const P = this.P, X = P.x, Y = P.y, CE = this._cE, CC = this._cC, CW = this._cW;
      const s0 = P.eStart[node], s1 = P.eStart[node + 1];
      let m = 0, nC = 0, nT = 0, nX = 0;
      for (let k = s0; k < s1 && m < 8; k++) {
        const f = P.adj[k];
        let cls;
        if (f === e) cls = 3;
        else if (P.eKind[f] === 1) { cls = 2; nX++; }
        else {
          const o = P.ea[f] === node ? P.eb[f] : P.ea[f];
          const dot = ((X[o] - X[node]) * ux + (Y[o] - Y[node]) * uy) / P.eLen[f];
          if (dot > 0.7) { cls = 0; nC++; } else { cls = 1; nT++; }
        }
        CE[m] = f; CC[m] = cls; m++;
      }
      if (m === 0) return e;
      let tot = 0;
      for (let k = 0; k < m; k++) {
        const c = CC[k];
        const w = c === 0 ? W_CONT / nC : c === 1 ? W_TURN / nT : c === 2 ? W_CROSS / nX : W_BACK;
        CW[k] = w; tot += w;
      }
      let r = Math.random() * tot;
      for (let k = 0; k < m; k++) { r -= CW[k]; if (r <= 0) return CE[k]; }
      return CE[m - 1];
    }
    // kaçarken: kaynaktan en çok uzaklaşan kenar (geçitler izinsiz)
    _pickFlee(i, node, e, ux, uy) {
      const P = this.P, X = P.x, Y = P.y;
      let ax = X[node] - this.fsx[i], ay = Y[node] - this.fsy[i];
      const al = Math.sqrt(ax * ax + ay * ay);
      if (al < 1e-3) { ax = ux; ay = uy; } else { ax /= al; ay /= al; }
      let best = e, bs = -1e9;
      for (let k = P.eStart[node], k1 = P.eStart[node + 1]; k < k1; k++) {
        const f = P.adj[k], o = P.ea[f] === node ? P.eb[f] : P.ea[f];
        const sc = ((X[o] - X[node]) * ax + (Y[o] - Y[node]) * ay) / P.eLen[f] + Math.random() * 0.2;
        if (sc > bs) { bs = sc; best = f; }
      }
      return best;
    }

    // ayrışma: görünür ayakta yayalar (ve yayadaki oyuncu) arası 0.9 m itme
    _separate(dt, W) {
      const VL = this._vl;
      let m = 0;
      for (let i = 0; i < this.n; i++) {
        if (!(this.flags[i] & F_VIS)) continue;
        const s = this.st[i];
        if (s === PS.FALL || s === PS.DOWN || s === PS.GETUP || s === PS.GONE || s === PS.DODGE) continue;
        VL[m++] = i;
      }
      if (!m) return;
      const X = this.x, Y = this.y, k0 = SEP_W * dt;
      for (let a = 0; a < m; a++) {
        const i = VL[a], xi = X[i], yi = Y[i];
        for (let b = a + 1; b < m; b++) {
          const j = VL[b], dx = xi - X[j], dy = yi - Y[j];
          if (dx > SEP_R || dx < -SEP_R || dy > SEP_R || dy < -SEP_R) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 >= SEP_R * SEP_R || d2 < 1e-8) continue;
          const d = Math.sqrt(d2), f = (k0 * (SEP_R - d)) / SEP_R / d * 0.5;
          this._nudge(i, dx * f, dy * f);
          this._nudge(j, -dx * f, -dy * f);
        }
      }
      const wk = W.walker;
      if (W.onFoot && wk && wk.state !== 'hidden') {
        const wx = wk.x, wy = wk.y;
        for (let a = 0; a < m; a++) {
          const i = VL[a], dx = X[i] - wx, dy = Y[i] - wy;
          if (dx > SEP_R || dx < -SEP_R || dy > SEP_R || dy < -SEP_R) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 >= SEP_R * SEP_R || d2 < 1e-8) continue;
          const d = Math.sqrt(d2), f = (k0 * 2 * (SEP_R - d)) / SEP_R / d;
          this._nudge(i, dx * f, dy * f);
        }
      }
    }
    _nudge(i, ox, oy) {
      if (this.flags[i] & F_PATH) {
        // şeritteki yaya: yalnız yanal kayma (şerit bandı engelsiz)
        const P = this.P, e = this.edge[i], d = this.dir[i];
        const a = d > 0 ? P.ea[e] : P.eb[e], b = d > 0 ? P.eb[e] : P.ea[e], L = P.eLen[e];
        const ux = (P.x[b] - P.x[a]) / L, uy = (P.y[b] - P.y[a]) / L;
        const la = this.lat[i] + (-uy * ox + ux * oy) * 2;
        this.lat[i] = la > LAT_MAX ? LAT_MAX : la < -LAT_MAX ? -LAT_MAX : la;
      } else {
        const s = this.st[i];
        if (s === PS.IDLE || s === PS.WAVE) return; // yerinde duranlar (görev yayaları) kımıldamaz
        this._moveFree(i, ox, oy);
      }
    }

    // ---------------- çizim ----------------
    draw(ctx, W) {
      W = W || this.W;
      if (!ctx || !W) return;
      const AS = DS.ActorSprites, v = W.view, M = W.M;
      const hasAS = !!(AS && AS.drawPed);
      const tt = W.t || 0, MG = 1.2;
      for (let i = 0; i < this.n; i++) {
        const s = this.st[i];
        if (s === PS.GONE) continue;
        const x = this.x[i], y = this.y[i];
        if (v && (x < v.x0 - MG || x > v.x1 + MG || y < v.y0 - MG || y > v.y1 + MG)) continue;
        let pose, ph = this.phase[i], flash = false;
        const sp = this.spd[i];
        switch (s) {
          case PS.FALL: pose = POSE.FALL; ph = 1 - this.t[i] / T_FALL; flash = this.t[i] > T_FALL - 0.15; break;
          case PS.DOWN: pose = POSE.DOWN; ph = 1; break;
          case PS.GETUP: pose = POSE.FALL; ph = this.t[i] / T_GETUP; break;
          case PS.FLEE: case PS.DODGE: pose = sp > 0.3 ? POSE.PANIC : POSE.IDLE; break;
          case PS.WAVE: pose = POSE.WAVE; break;
          case PS.WAIT: case PS.IDLE: pose = POSE.IDLE; break;
          default: pose = sp > RUN_V ? POSE.RUN : sp > 0.2 ? POSE.WALK : POSE.IDLE; break;
        }
        if (hasAS) {
          AS.drawPed(ctx, x, y, this.h[i], this.pal[i], pose, ph, flash);
          if (s === PS.DOWN && AS.drawStars) AS.drawStars(ctx, x, y, tt + (this.uid[i] & 7) * 0.13);
        } else {
          ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
          ctx.fillStyle = this._pcol[this.pal[i]] || '#ff8a1f';
          const r = s === PS.DOWN || s === PS.FALL ? 0.45 : 0.3;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
      if (M) ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.globalAlpha = 1;
    }
  }

  // ======================================================================
  // Oyuncu yaya
  const WR = 0.35;                // çarpışma yarıçapı
  const V_WALK = 2.2, V_RUN = 5.5, T_ACC = 0.12, TURN = 4 * PI; // 720°/s
  const PUNCH_R = 1.6, PUNCH_HALF = PI / 6, PUNCH_CD = 0.45, PUNCH_T = 0.25, PUNCH_V = 3.5;
  const DOWN_T = 1.2, NUDGE = 0.25, SUB = 0.2;

  class Walker {
    constructor(W) {
      this.W = W || null;
      this.x = 0; this.y = 0; this.h = 0;
      this.vx = 0; this.vy = 0; this.speed = 0; this.run = false; this.phase = 0;
      this.hp = 100;
      this.state = 'walk';
      this.t = 0;
      this.hurtT = 99;           // son hasardan beri geçen süre (yenilenme 8 s sonra)
      this.punchCD = 0;
      this.anim = -1;            // binme/inme ilerlemesi 0..1 (dünya verir; < 0: t'den hesaplanır)
      this.r = WR;
      // şehir sorgusu geri çağrısı (bir kez bağlanır; iç içe sorgu yok)
      this._cx = 0; this._cy = 0; this._tvx = 0; this._tvy = 0; this._qdt = 0; this._any = false;
      this._cb = (k, col) => this._hit(k, col);
    }

    reset(x, y, h) {
      this.x = x; this.y = y; this.h = typeof h === 'number' ? h : 0;
      this.vx = 0; this.vy = 0; this.speed = 0; this.run = false; this.phase = 0;
      this.state = 'walk'; this.t = 0; this.punchCD = 0; this.anim = -1; this.hurtT = 99;
    }

    // +2 HP/s, son hasardan 8 s sonra (araçtayken de dünya çağırabilir)
    regen(dt) {
      this.hurtT += dt;
      if (this.hurtT > 8 && this.hp > 0 && this.hp < 100) this.hp = Math.min(100, this.hp + 2 * dt);
    }

    // mx,my: dünya yönlü hedef (|m| ≤ 1, döndürmeyi dünya yapar); run: koşu
    update(dt, mx, my, run, W) {
      if (W) this.W = W;
      W = this.W;
      if (!(dt > 0)) return;
      this.regen(dt);
      if (this.punchCD > 0) this.punchCD -= dt;
      this.t += dt;
      const s = this.state;
      if (s === 'hidden' || s === 'enter' || s === 'exit') {
        this.vx = 0; this.vy = 0; this.speed = 0; this.run = false;
        return;
      }
      let tvx = 0, tvy = 0;
      if (s === 'down') {
        // itmeyle kayar, sürtünme 6 m/s²
        const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (sp > 1e-4) { const k = Math.max(0, sp - FRICT * dt) / sp; this.vx *= k; this.vy *= k; }
        this.run = false;
        if (this.t >= DOWN_T) { this.state = 'walk'; this.t = 0; }
      } else {
        if (s === 'punch' && this.t >= PUNCH_T) this.state = 'walk';
        mx = mx || 0; my = my || 0;
        let m = Math.sqrt(mx * mx + my * my);
        if (!(m > 0.02)) { m = 0; mx = 0; my = 0; }
        else if (m > 1) { mx /= m; my /= m; m = 1; }
        const vmax = run ? V_RUN : V_WALK;
        const k = this.state === 'punch' ? vmax * 0.5 : vmax;
        tvx = mx * k; tvy = my * k;
        // doğrusal rampa: 0.12 s'de 0 -> vmax
        const step = (vmax / T_ACC) * dt;
        const dvx = tvx - this.vx, dvy = tvy - this.vy, dl = Math.sqrt(dvx * dvx + dvy * dvy);
        if (dl <= step) { this.vx = tvx; this.vy = tvy; }
        else { this.vx += (dvx / dl) * step; this.vy += (dvy / dl) * step; }
        if (m > 0) {
          let d = Math.atan2(my, mx) - this.h;
          if (d > PI) d -= TAU; else if (d < -PI) d += TAU;
          const md = TURN * dt;
          this.h += d > md ? md : d < -md ? -md : d;
          if (this.h > PI) this.h -= TAU; else if (this.h < -PI) this.h += TAU;
        }
        this.run = !!run && m > 0;
      }
      // alt adımlı hareket + çarpışma çözümü
      const ddx = this.vx * dt, ddy = this.vy * dt, dist = Math.sqrt(ddx * ddx + ddy * ddy);
      const ns = Math.max(1, Math.ceil(dist / SUB)), sdt = dt / ns;
      for (let k = 0; k < ns; k++) {
        this.x += this.vx * sdt; this.y += this.vy * sdt;
        this._collide(W, tvx, tvy, sdt);
      }
      this.speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (this.speed > 0.05) {
        this.phase += (this.speed * dt) / (this.speed > 3.2 ? STRIDE_R : STRIDE_W);
        if (this.phase > 1000) this.phase -= 1000;
      }
    }

    _collide(W, tvx, tvy, dt) {
      if (!W) return;
      this._tvx = tvx; this._tvy = tvy; this._qdt = dt;
      // araçlar (önce): OBB itme
      const tr = W.traffic;
      if (tr && tr.list) {
        const L = tr.list, nl = listLen(tr);
        for (let k = 0; k < nl; k++) {
          const v = L[k];
          if (!v || !v.alive) continue;
          if (vehPush(this.x, this.y, WR, v)) {
            this.x = VP.x; this.y = VP.y;
            const vn = this.vx * VP.nx + this.vy * VP.ny;
            if (vn < 0) { this.vx -= vn * VP.nx; this.vy -= vn * VP.ny; }
          }
        }
      }
      // şehir kutuları/daireleri (duvar kazanır)
      const city = W.city;
      if (!city) return;
      this._cx = this.x; this._cy = this.y;
      const m = WR + 0.05;
      for (let it = 0; it < 3; it++) {
        this._any = false;
        city.query(this._cx - m, this._cy - m, this._cx + m, this._cy + m, this._cb);
        if (!this._any) break;
      }
      this.x = this._cx; this.y = this._cy;
    }

    // şehir sorgusu geri çağrısı: daire–kutu / daire–daire itme, kayma ve köşe dürtmesi
    _hit(k, col) {
      const r = WR;
      let cx = this._cx, cy = this._cy, nx, ny, pen;
      if (k === 'b') {
        const qx = cx < col.x0 ? col.x0 : cx > col.x1 ? col.x1 : cx;
        const qy = cy < col.y0 ? col.y0 : cy > col.y1 ? col.y1 : cy;
        const dx = cx - qx, dy = cy - qy, d2 = dx * dx + dy * dy;
        if (d2 >= r * r) return;
        if (d2 > 1e-12) { const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; pen = r - d; }
        else {
          const l = cx - col.x0, rr = col.x1 - cx, t = cy - col.y0, b = col.y1 - cy;
          const mn = Math.min(l, rr, t, b);
          if (mn === l) { nx = -1; ny = 0; } else if (mn === rr) { nx = 1; ny = 0; } else if (mn === t) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
          pen = mn + r;
        }
        cx += nx * pen; cy += ny * pen;
        // köşe dürtmesi: yüze dik yürürken yüzün ucuna < 0.25 m ise köşeden dolaştır
        const tvx = this._tvx, tvy = this._tvy, tv2 = tvx * tvx + tvy * tvy;
        if (tv2 > 0.01) {
          const tv = Math.sqrt(tv2), into = -(tvx * nx + tvy * ny) / tv;
          if (into > 0.7) {
            const step = tv * this._qdt;
            if (ny === 0 && nx !== 0 && cy >= col.y0 && cy <= col.y1) {
              const e0 = cy - col.y0, e1 = col.y1 - cy;
              if (e0 < NUDGE && e0 <= e1) cy -= Math.min(step, NUDGE - e0 + r);
              else if (e1 < NUDGE) cy += Math.min(step, NUDGE - e1 + r);
            } else if (nx === 0 && ny !== 0 && cx >= col.x0 && cx <= col.x1) {
              const e0 = cx - col.x0, e1 = col.x1 - cx;
              if (e0 < NUDGE && e0 <= e1) cx -= Math.min(step, NUDGE - e0 + r);
              else if (e1 < NUDGE) cx += Math.min(step, NUDGE - e1 + r);
            }
          }
        }
      } else {
        if (col.broken) return;
        const dx = cx - col.x, dy = cy - col.y, rr = r + col.r, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) return;
        if (d2 > 1e-12) { const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; pen = rr - d; }
        else { nx = 1; ny = 0; pen = rr; }
        cx += nx * pen; cy += ny * pen;
      }
      const vn = this.vx * nx + this.vy * ny;
      if (vn < 0) { this.vx -= vn * nx; this.vy -= vn * ny; }
      this._cx = cx; this._cy = cy;
      this._any = true;
    }

    // 0.45 s bekleme; 1.6 m, 60° koni (±30°). Vurursa Peds.knock (onPedHit 'walker'). Yaya indeksi | -1
    punch(W) {
      if (W) this.W = W;
      W = this.W;
      if (this.punchCD > 0 || (this.state !== 'walk' && this.state !== 'punch')) return -1;
      this.punchCD = PUNCH_CD; this.state = 'punch'; this.t = 0;
      const P = W && W.peds;
      if (!P) return -1;
      let best = -1, bs = 1e9;
      const ch = Math.cos(this.h), sh = Math.sin(this.h), r2 = PUNCH_R * PUNCH_R, ccone = Math.cos(PUNCH_HALF);
      for (let i = 0; i < P.n; i++) {
        const st = P.st[i];
        if (st === PS.FALL || st === PS.DOWN || st === PS.GETUP || st === PS.GONE) continue;
        const dx = P.x[i] - this.x, dy = P.y[i] - this.y, d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2);
        const cs = d > 1e-3 ? (dx * ch + dy * sh) / d : 1;
        if (cs < ccone) continue;
        const sc = d + (1 - cs) * 2;
        if (sc < bs) { bs = sc; best = i; }
      }
      if (best < 0) return -1;
      const dx = P.x[best] - this.x, dy = P.y[best] - this.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1e-3) this.h = Math.atan2(dy, dx);
      const ix = Math.cos(this.h) * PUNCH_V, iy = Math.sin(this.h) * PUNCH_V;
      return P.knock(best, ix, iy, 'walker', PUNCH_V) ? best : -1;
    }

    // hasar: hp düşer, 1.2 s yerde, itme hızı (ix, iy)
    hurt(amount, ix, iy) {
      if (!(amount > 0)) return;
      this.hp = Math.max(0, this.hp - amount);
      this.hurtT = 0;
      const s = this.state;
      if (s === 'hidden' || s === 'enter' || s === 'exit') return;
      this.state = 'down'; this.t = 0;
      this.vx = ix || 0; this.vy = iy || 0;
    }

    // araç çarpması (§5.3): hasar clamp(1.6·vrel², 6, 100), 1.2 s yerde; uygulanan hasar
    carHit(vrel, ix, iy) {
      const dmg = U.clamp(1.6 * vrel * vrel, 6, 100);
      this.hurt(dmg, ix, iy);
      return dmg;
    }
    // patlama (§5.3): 6 m içinde 60·(1 − d/6), dışarı itme; uygulanan hasar
    blast(x, y) {
      const dx = this.x - x, dy = this.y - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 6) return 0;
      const k = 1 - d / 6, dmg = 60 * k, v = 6 * k;
      const nx = d > 1e-3 ? dx / d : 1, ny = d > 1e-3 ? dy / d : 0;
      this.hurt(dmg, nx * v, ny * v);
      return dmg;
    }
    // Hareketli araç yayaya çarptı mı (dünya adımı j, trafik güncellemesinden sonra): temas normali boyunca
    // yaklaşma hızı > 2.5 m/s ise carHit uygulanır ve çarpan kayıt döner (yoksa null)
    hitByVehicles(W) {
      W = W || this.W;
      const s = this.state;
      if (!W || s === 'hidden' || s === 'down' || s === 'enter' || s === 'exit') return null;
      const tr = W.traffic;
      if (!tr || !tr.list) return null;
      const L = tr.list, nl = listLen(tr);
      for (let k = 0; k < nl; k++) {
        const v = L[k];
        if (!v || !v.alive) continue;
        let cvx, cvy;
        if (v.mode === VM_RAIL) { const sp = v.v || 0; if (sp < 2.5) continue; cvx = Math.cos(v.h) * sp; cvy = Math.sin(v.h) * sp; }
        else { cvx = v.vx || 0; cvy = v.vy || 0; if (cvx * cvx + cvy * cvy < 6.25) continue; }
        if (!vehPush(this.x, this.y, WR + 0.15, v)) continue;
        const vn = (cvx - this.vx) * VP.nx + (cvy - this.vy) * VP.ny;
        if (vn <= 2.5) continue;
        this.carHit(vn, 0.6 * cvx + 2 * VP.nx, 0.6 * cvy + 2 * VP.ny);
        return v;
      }
      return null;
    }

    draw(ctx, W) {
      W = W || this.W;
      if (!ctx || !W || this.state === 'hidden') return;
      const AS = DS.ActorSprites, M = W.M, tt = W.t || 0;
      let pose, ph = this.phase, stars = false;
      const s = this.state;
      if (s === 'down') {
        const t = this.t;
        if (t < 0.3) { pose = POSE.FALL; ph = t / 0.3; }
        else if (t < DOWN_T - 0.3) { pose = POSE.DOWN; ph = 1; stars = true; }
        else { pose = POSE.FALL; ph = Math.max(0, (DOWN_T - t) / 0.3); }
      } else if (s === 'punch') { pose = POSE.PUNCH; ph = this.t / PUNCH_T; }
      else if (s === 'enter') { pose = POSE.GETIN; ph = this.anim >= 0 ? this.anim : Math.min(1, this.t / 0.6); }
      else if (s === 'exit') { pose = POSE.GETIN; ph = this.anim >= 0 ? this.anim : 1 - Math.min(1, this.t / 0.45); }
      else pose = this.speed > 3.2 ? POSE.RUN : this.speed > 0.2 ? POSE.WALK : POSE.IDLE;
      if (AS && AS.drawPed) {
        if (AS.drawPlayerRing) AS.drawPlayerRing(ctx, this.x, this.y, tt);
        AS.drawPed(ctx, this.x, this.y, this.h, 0, pose, ph, false);
        if (stars && AS.drawStars) AS.drawStars(ctx, this.x, this.y, tt);
      } else if (M) {
        ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
        ctx.fillStyle = '#ff8a1f';
        ctx.fillRect(this.x - 0.35, this.y - 0.35, 0.7, 0.7);
      }
      if (M) ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.globalAlpha = 1;
    }
  }

  DS.Peds = Peds;
  DS.Walker = Walker;
})();
