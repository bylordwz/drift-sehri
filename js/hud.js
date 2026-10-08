'use strict';
// Açık şehir arayüzü (DS.WorldUI): göstergeler, mini harita katmanı (rota + blipler), tam ekran harita,
// ankesörlü telefon, görev sonucu, yükleme perdesi, büyük orta mesajlar.
// Dünya verisini yalnızca okur (world.hud, world.msgs, world.blips, world.route, world.mapPois, world.focus);
// oyuncu eylemlerini world yöntemleriyle bildirir. DOM'a yalnızca değer değişince yazılır.
(function () {
  const DS = window.DS, U = DS.U;
  const TAU = Math.PI * 2;
  const $ = (s) => document.querySelector(s);

  // değişince yaz yardımcıları (ui.js ile aynı mantık)
  const setT = (el, v) => { if (el._t !== v) { el._t = v; el.textContent = v; } };
  const setC = (el, c, on) => { const k = '_c' + c; if (el[k] !== on) { el[k] = on; el.classList.toggle(c, on); } };
  const setH = (el, v) => { if (el._h !== v) { el._h = v; el.hidden = v; } };
  // gövde sınıfları başka modüllerce de (main/world) değiştirilir: önbellek yerine gerçek durumla karşılaştır
  const setB = (c, on) => { const l = document.body.classList; if (l.contains(c) !== on) l.toggle(c, on); };
  // çubuk dolgusu: sayı 1/400 adımla karşılaştırılır, dize yalnızca değişince kurulur
  const setX = (el, v) => {
    v = Math.round(U.sat(v) * 400) / 400;
    if (el._x !== v) { el._x = v; el.style.transform = 'scaleX(' + v + ')'; }
  };
  const due = (o, k, dt, hz) => {
    const iv = 1 / hz, t = (o[k] || 0) + dt;
    if (t < iv - 0.002) { o[k] = t; return false; }
    o[k] = Math.max(0, Math.min(t - iv, iv));
    return true;
  };

  const BSC = 0.8;            // taban harita çözünürlüğü (px/m)
  const MAXB = 64;            // blip üst sınırı (dizi boyu)
  const MEDAL = ['', 'Bronz', 'Gümüş', 'Altın'];
  const TIER = ['Kolay', 'Orta', 'Zor'];
  const OVER = { map: 1, phone: 1, mresult: 1 };
  // ekip adları (DS.CREWS yüklenmemişse)
  const CREW_N = { kulup: 'Drift Kulübü', sanayi: 'Sanayi Kamyoncuları', merkez: 'Merkez Yarışçıları' };
  // "F — Bin" gibi klavye ipuçları: dokunmatikte bağlamsal düğme aynı işi gösterdiğinden gizlenir
  const KEYHINT = /^[^\s—]{1,6} — /;

  // Blip türleri (§2.6.13): renk, şekil (0 daire, 1 kare, 2 elmas, 3 ev), yarıçap (css px), harita süzgeci
  const BK = [];
  const bk = (k, col, sh, r, f) => { BK[k] = { col, sh, r, f }; };
  bk(1, '#ffd23e', 2, 4.5, 'missions');   // hedef
  bk(2, '#ff3b30', 0, 3, '');             // polis (yanıp söner: kırmızı/mavi)
  bk(3, '#38d9ff', 1, 3, 'phones');       // telefon
  bk(4, '#c86bff', 1, 3.5, 'places');     // boyahane
  bk(5, '#ffb23e', 3, 4, 'places');       // güvenli ev
  bk(6, '#ff4fd8', 0, 3.5, 'side');       // etkinlik
  bk(7, '#f2ede3', 2, 4, '');             // yol noktası
  bk(8, '#5fe0b0', 1, 3, '');             // kendi araç
  bk(9, '#ffd23e', 1, 3.5, 'missions');   // görev aracı
  bk(10, '#ffd23e', 0, 4, 'missions');    // sonraki kontrol noktası
  const BK_DEF = { col: '#d6dde6', sh: 0, r: 3, f: '' };
  // önem sırası (kısıtta önce bunlar); çizim ters sırada (önemli olan üstte)
  const PRIO = [1, 10, 7, 9, 2, 8, 5, 4, 3, 6];
  const PIN = []; PIN[1] = 1; PIN[7] = 1; PIN[10] = 1;
  const POLICE_B = '#2a6bff';
  const CASE = 'rgba(8,10,16,0.9)';

  const WorldUI = (DS.WorldUI = {
    g: null,

    // ---------------- kurulum ----------------
    init(game) {
      this.g = game;
      const q = (s) => $(s);
      const e = (this.el = {
        right: q('#w-right'), stars: q('#w-stars'), bust: q('#w-bust'), bustI: q('#w-bust > i'),
        money: q('#w-money'), hp: q('#w-hp'), hpI: q('#w-hp > i'), carhp: q('#w-carhp'), carhpI: q('#w-carhp > i'),
        bounty: q('#w-bounty'), clock: q('#w-clock'),
        obj: q('#w-obj'), objT: q('#w-obj-t'), objS: q('#w-obj-s'), timer: q('#w-timer'),
        big: q('#w-big'), zone: q('#w-zone'), prompt: q('#w-prompt'),
        msgs: q('#msgs'), loading: q('#w-loading'),
        enter: q('#ctl-enter'), act: q('#ctl-act'),
        map: q('#map'), mapCv: q('#map-canvas'), legend: q('#map-legend'), mapHint: q('#map .map-hint'),
        phone: q('#phone'), phCrew: q('#ph-crew'), phRespI: q('#ph-resp > i'), phRespN: q('#ph-resp-n'), phList: q('#ph-list'),
        mres: q('#mresult'), mrName: q('#mr-name'), mrTitle: q('#mr-title'), mrMedal: q('#mr-medal'), mrReward: q('#mr-reward'),
        mrNote: q('#mr-note'), mrRetry: q('#mresult [data-act="mres-retry"]'), mrClose: q('#mresult [data-act="mres-close"]'),
      });
      if (!e.right) { this.ready = false; return; }
      this.ready = true;
      e.starI = e.stars ? Array.prototype.slice.call(e.stars.querySelectorAll('i')) : [];
      e.bigB = e.big ? e.big.querySelector('b') : null;
      e.bigS = e.big ? e.big.querySelector('span') : null;
      e.enterS = e.enter ? e.enter.querySelector('span') : null;
      e.actS = e.act ? e.act.querySelector('span') : null;
      e.loadT = e.loading ? e.loading.querySelector('b') : null;
      this.body = document.body;
      // blip tamponları (her karede yeniden kullanılır)
      this._bl = [];
      for (let i = 0; i < MAXB; i++) this._bl.push({ x: 0, y: 0, k: 0 });
      this._sx = new Float32Array(MAXB); this._sy = new Float32Array(MAXB);
      this._ux = new Float32Array(MAXB); this._uy = new Float32Array(MAXB);
      this._fl = new Uint8Array(MAXB);
      this._bigQ = []; this._bigT = 0; this._bigFlip = false;
      this._money = null; this._st = -1; this._tsec = -2; this._pop = false;
      this._t = 0;
      this.filt = { missions: true, phones: true, places: true, side: true };
      this.mv = { cx: 0, cy: 0, z: 1.6, fit: 1 };
      this._ptrs = [];
      this._padPrev = [];
      this._kSprite = null;
      // "K" işareti web yazı tipi yüklenmeden çizilmiş olabilir
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { this._kSprite = null; }).catch(() => {});
      this._bindMap();
      this._bindKeys();
      window.addEventListener('resize', () => { if (this.isMapOpen()) { this._sizeMap(); this.mapDirty = true; } });
    },

    world() { const g = this.g; return g && g.world ? g.world : null; },

    // yeni açık şehir oturumu (UI.frame menüden sonraki ilk dünya karesinde çağırır): geçici durumları temizle,
    // göstergeler ilk karede yazılsın
    reset() {
      if (!this.ready) return;
      this._bigQ.length = 0; this._bigT = 0;
      const e = this.el;
      setC(e.big, 'on', false);
      setC(e.zone, 'on', false);
      this._money = null; this._st = -1; this._tsec = -2; this._bo = -1;
      this._tt = 1;
      if (this._wpTimer) { clearTimeout(this._wpTimer); this._wpTimer = 0; }
      this._ptrs.length = 0;
    },

    // ---------------- kare ----------------
    frame(dt) {
      if (!this.ready || !this.g) return;
      this._t += dt;
      const cur = DS.UI.current;
      if (cur && OVER[cur]) this._pad(cur);
      if (cur === 'map') {
        // dünya donuk: harita yalnızca kirlenince (kaydırma/yakınlaşma/yanıp sönme) yeniden çizilir
        this._blinkT = (this._blinkT || 0) + dt;
        if (this._blinkT >= 0.4) { this._blinkT = 0; this._blink = !this._blink; this.mapDirty = true; }
        if (this.mapDirty) this._drawMap();
        return;
      }
      const w = this.world();
      // büyük mesaj sırası
      if (this._bigT > 0) {
        this._bigT -= dt;
        if (this._bigT <= 0) this._nextBig();
      }
      if (!w) return;
      const msgs = w.msgs;
      if (msgs && msgs.length) while (msgs.length) this._msg(msgs.shift());
      const Q = DS.UI.Q || (this.g.Q) || { textHz: 15 };
      if (due(this, '_tt', dt, Q.textHz || 15)) this._hud(w.hud);
    },

    _hud(h) {
      if (!h) return;
      const e = this.el;
      // yıldızlar
      const st = U.clamp(h.stars | 0, 0, 5);
      if (st !== this._st) {
        this._st = st;
        for (let i = 0; i < e.starI.length; i++) setC(e.starI[i], 'on', i < st);
        setC(e.stars, 'none', st === 0);
      }
      setC(e.stars, 'flash', !!h.starFlash && st > 0);
      // kelepçe çubuğu
      const bust = h.bust > 0.002 ? h.bust : 0;
      setH(e.bust, bust <= 0);
      if (bust > 0) setX(e.bustI, bust);
      // para (değişince küçük zıplama)
      const m = Math.round(h.money || 0);
      if (m !== this._money) {
        if (this._money !== null) { this._pop = !this._pop; setC(e.money, 'p1', this._pop); setC(e.money, 'p2', !this._pop); }
        this._money = m;
        setT(e.money, '₺' + U.fmt(m));
      }
      // sağlık
      const hp = U.clamp(h.hp || 0, 0, 100);
      setX(e.hpI, hp / 100);
      setC(e.hp, 'low', hp < 30);
      // araç hasarı
      const ch = h.carHp;
      const noCar = !(ch >= 0);
      setH(e.carhp, noCar);
      if (!noCar) {
        setX(e.carhpI, ch);
        setC(e.carhp, 'mid', ch < 0.65 && ch >= 0.35);
        setC(e.carhp, 'low', ch < 0.35);
      }
      // kovalamaca ödülü
      const bo = Math.round(h.bounty || 0);
      setH(e.bounty, bo <= 0);
      if (bo > 0 && bo !== this._bo) { this._bo = bo; setT(e.bounty, 'Ödül ₺' + U.fmt(bo)); }
      setT(e.clock, h.clock || '');
      // görev satırı + süre
      const obj = h.obj || '';
      setH(e.obj, !obj);
      if (obj) {
        setT(e.objT, obj);
        setT(e.objS, h.objSub || '');
        const tm = h.timer;
        const has = tm >= 0;
        setH(e.timer, !has);
        if (has) {
          const s = Math.ceil(tm);
          if (s !== this._tsec) {
            this._tsec = s;
            const mm = (s / 60) | 0, ss = s % 60;
            setT(e.timer, mm + ':' + (ss < 10 ? '0' : '') + ss);
          }
          setC(e.timer, 'low', tm <= 10);
        }
      }
      // bağlam ipucu, bölge adı
      let pr = h.prompt || '';
      if (pr && KEYHINT.test(pr) && document.body.classList.contains('touch')) pr = '';
      setH(e.prompt, !pr);
      if (pr) setT(e.prompt, pr);
      if (h.zone) setT(e.zone, h.zone);
      setC(e.zone, 'on', h.zoneT > 0 && !!h.zone);
      // dokunmatik düğme etiketleri ve gövde sınıfları
      const onFoot = !!h.onFoot;
      if (e.enterS) setT(e.enterS, h.enterLabel || (onFoot ? 'BİN' : 'İN'));
      if (e.actS) setT(e.actS, h.actLabel || 'ETKİLEŞ');
      setB('near-car', onFoot && !!h.enterLabel);
      setB('can-act', !!h.actLabel);
      setB('mission', !!h.mission);
    },

    // dünya mesajı: 'big' ortada büyük; diğerleri (mis/cop/cash/good) geçici satır
    _msg(m) {
      if (!m) return;
      if (m.kind === 'big') { this.big(m.text, m.sub, m.style || 'big', m.ms); return; }
      const box = this.el.msgs;
      if (!box) return;
      const d = document.createElement('div');
      d.className = 'msg ' + (m.kind || 'mis');
      const b = document.createElement('b');
      b.textContent = m.text || '';
      d.appendChild(b);
      if (m.sub) { const s = document.createElement('span'); s.textContent = m.sub; d.appendChild(s); }
      box.appendChild(d);
      while (box.children.length > 3) box.firstChild.remove();
      setTimeout(() => d.remove(), 1500);
    },

    // ---------------- büyük mesaj ----------------
    big(text, sub, kind, ms) {
      if (!this.ready) return;
      const q = this._bigQ;
      if (q.length >= 4) q.shift();
      q.push({ text: text || '', sub: sub || '', kind: kind || 'big', ms: ms > 0 ? ms : 3000 });
      // sırada bekleyen varsa ekrandaki kısalır
      if (this._bigT > 0) this._bigT = Math.min(this._bigT, 1.2);
      else this._nextBig();
    },
    _nextBig() {
      const e = this.el, m = this._bigQ.shift();
      if (!m) { this._bigT = 0; setC(e.big, 'on', false); return; }
      let k = m.kind;
      if (k === 'big') {
        // stil metinden: ENSELENDİN! polis, BAYILDIN!/BAŞARISIZ kötü, TAMAM iyi
        const t = m.text;
        k = t === 'ENSELENDİN!' ? 'cop' : t === 'BAYILDIN!' || t.indexOf('BAŞARISIZ') >= 0 || t === 'SÜRE DOLDU' ? 'fail' : t === 'GÖREV TAMAM!' || t === 'KAÇTIN!' || t === 'ATLATTIN!' ? 'good' : 'mis';
      }
      e.bigB.textContent = m.text;
      e.bigS.textContent = m.sub;
      e.big.className = 'world-only on ' + k + ((this._bigFlip = !this._bigFlip) ? ' a' : ' b');
      e.big._con = true; // setC önbelleği className ile eşitlensin
      this._bigT = m.ms / 1000;
    },

    // ---------------- yükleme perdesi ----------------
    loading(on, text) {
      const e = this.el;
      if (!e || !e.loading) return;
      if (text && e.loadT) e.loadT.textContent = text;
      else if (on && e.loadT) e.loadT.textContent = 'Şehir hazırlanıyor…';
      e.loading.hidden = !on;
      // taban haritayı yükleme sırasında hazırla (ilk mini harita karesinde takılma olmasın)
      if (!on && this.g && this.g.mode === 'world') this.base();
    },

    // ---------------- taban harita (soluk palet, 0.8 px/m, tembel) ----------------
    base() {
      const g = this.g, city = g && g.city;
      if (!city) return null;
      // applyWorldEdits çalışma zamanında bina ekler: katı sayısı değişirse yeniden kur
      const sig = city.solids.length;
      if (this._base && this._baseSig === sig) return this._base;
      this._baseSig = sig;
      const c = this._base ? this._base.c : U.canvas(city.W * BSC, city.H * BSC);
      const x = c.getContext('2d');
      x.setTransform(BSC, 0, 0, BSC, 0, 0);
      x.fillStyle = '#141a17'; x.fillRect(0, 0, city.W, city.H);
      x.fillStyle = '#596071';
      x.fillRect(city.x0, city.y0, city.x1 - city.x0, city.y1 - city.y0);
      const IN = { build: '#24272e', park: '#244030', parking: '#2f333b', ind: '#2d2b27', drift: '#3b3122' };
      for (const b of city.blocks) {
        x.fillStyle = '#30343c'; x.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        const I = b.inner;
        if (I) { x.fillStyle = IN[b.type] || '#24272e'; x.fillRect(I.x0, I.y0, I.x1 - I.x0, I.y1 - I.y0); }
      }
      x.fillStyle = '#1a1c21';
      for (const s of city.solids) if (s.kind === 'bld' || s.kind === 'ware') x.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
      x.fillStyle = '#3d3528';
      for (const s of city.solids) if (s.kind === 'cont') x.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
      x.fillStyle = '#6b5428';
      for (const t of city.tireIsl) { x.beginPath(); x.arc(t.x, t.y, t.r + 2, 0, TAU); x.fill(); }
      x.fillStyle = '#2a4a33';
      for (const s of city.islands) { x.beginPath(); x.arc(s.x, s.y, s.r + 1, 0, TAU); x.fill(); }
      x.setTransform(1, 0, 0, 1, 0, 0);
      this._base = { c, sc: BSC };
      this._dist = null;
      return this._base;
    },

    // ---------------- mini harita ----------------
    // UI.drawMini çağırır: çember kırpması etkin, dönüşüm dpr ölçekli css px. k: px/m, (fx,fy) merkez, rot = cam.rot
    drawMiniBase(g, w, h, k, fx, fy, rot) {
      const b = this.base();
      if (!b) return false;
      const dpr = g.canvas.width / w, sc = b.sc, s = k / sc;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const a = dpr * s * cs, bb = dpr * s * sn;
      const qx = fx * sc, qy = fy * sc;
      g.setTransform(a, bb, -bb, a, dpr * (w / 2) - (a * qx - bb * qy), dpr * (h / 2) - (bb * qx + a * qy));
      // yalnızca görünen kaynak bölgesi (dönüş için √2 pay)
      const half = (Math.max(w, h) * 0.7072 + 2) / s;
      let x0 = qx - half, y0 = qy - half, x1 = qx + half, y1 = qy + half;
      const cw = b.c.width, ch = b.c.height;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > cw) x1 = cw; if (y1 > ch) y1 = ch;
      if (x1 > x0 && y1 > y0) g.drawImage(b.c, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    },

    // rota + blipler (kalıcı türler kenara iğnelenir) + dönükken kuzey "K" işareti
    drawMiniOverlay(g, w, h, k, fx, fy, rot) {
      const W = this.world();
      if (!W || !this.ready) return;
      const dpr = g.canvas.width / w;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      // rota çoklu çizgisi (dünya koordinatında, kalınlık px/k)
      const r = W.route;
      if (r && r.n > 1 && r.pts) {
        const a = dpr * k * cs, b = dpr * k * sn;
        g.setTransform(a, b, -b, a, dpr * (w / 2) - (a * fx - b * fy), dpr * (h / 2) - (b * fx + a * fy));
        this._routePath(g, r);
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = CASE; g.lineWidth = 8 / k; g.stroke();
        g.strokeStyle = '#ffd23e'; g.lineWidth = 4 / k; g.stroke();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // blipler
      const n = Math.min(MAXB, W.blips ? W.blips(this._bl) | 0 : 0);
      if (n > 0) {
        const hud = W.hud, stars = hud ? hud.stars | 0 : 0;
        const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 2, Rp = R - 6;
        const sx = this._sx, sy = this._sy, ux = this._ux, uy = this._uy, fl = this._fl;
        for (let i = 0; i < n; i++) {
          const bl = this._bl[i];
          const dx = (bl.x - fx) * k, dy = (bl.y - fy) * k;
          let px = dx * cs - dy * sn, py = dx * sn + dy * cs;
          const d = Math.sqrt(px * px + py * py);
          let f = 0;
          if (d > Rp) {
            const kk = bl.k;
            if (PIN[kk] || (kk === 4 && stars >= 1)) {
              const ix = px / d, iy = py / d;
              px = ix * Rp; py = iy * Rp; ux[i] = ix; uy[i] = iy;
              f = 3; // seçilebilir + iğneli
            }
          } else f = 1;
          sx[i] = cx + px; sy[i] = cy + py; fl[i] = f;
        }
        this._select(n, (this.g.Q && this.g.Q.blips) || 8);
        this._drawBlips(g, n, 1);
      }
      // kuzey işareti (kamera dönükken)
      if (Math.abs(U.wrap(rot)) > 0.03) {
        const ks = this._kspr();
        const R = Math.min(w, h) / 2 - 9;
        g.drawImage(ks, w / 2 + sn * R - 6, h / 2 - cs * R - 6, 12, 12);
      }
    },

    _routePath(g, r) {
      const p = r.pts, n = Math.min(r.n, p.length >> 1);
      g.beginPath();
      g.moveTo(p[0], p[1]);
      for (let i = 1; i < n; i++) g.lineTo(p[i * 2], p[i * 2 + 1]);
    },

    // kısıt: önem sırasına göre en fazla 'cap' blip (fl bit 1 seçili, bit 2 iğneli, bit 4 çizilecek)
    _select(n, cap) {
      const fl = this._fl, bl = this._bl;
      let left = cap;
      for (let p = 0; p < PRIO.length && left > 0; p++) {
        const kk = PRIO[p];
        for (let i = 0; i < n && left > 0; i++) if ((fl[i] & 1) && bl[i].k === kk) { fl[i] |= 4; left--; }
      }
      // tabloda olmayan türler sona
      for (let i = 0; i < n && left > 0; i++) if ((fl[i] & 5) === 1 && !BK[bl[i].k]) { fl[i] |= 4; left--; }
    },

    // seçili blipleri türe göre toplu çiz (tür başına bir yol, bir dolgu, bir kontur)
    _drawBlips(g, n, sc) {
      const fl = this._fl, bl = this._bl, sx = this._sx, sy = this._sy, ux = this._ux, uy = this._uy;
      g.lineWidth = 1.2; g.strokeStyle = CASE; g.lineJoin = 'round';
      for (let p = PRIO.length; p >= 0; p--) {
        const kk = p < PRIO.length ? PRIO[p] : -1;
        let any = false;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          if (!(fl[i] & 4)) continue;
          const bk0 = bl[i].k;
          if (kk >= 0 ? bk0 !== kk : BK[bk0]) continue;
          const d = BK[bk0] || BK_DEF, rr = d.r * sc;
          any = true;
          if (fl[i] & 2) this._pinPath(g, sx[i], sy[i], ux[i], uy[i], rr + 1);
          else this._shapePath(g, d.sh, sx[i], sy[i], rr);
        }
        if (!any) continue;
        const d = kk >= 0 ? BK[kk] : BK_DEF;
        g.fillStyle = kk === 2 && (this._t * 4) % 2 > 1 ? POLICE_B : d.col;
        g.fill(); g.stroke();
      }
    },
    _shapePath(g, sh, x, y, r) {
      if (sh === 1) g.rect(x - r, y - r, r * 2, r * 2);
      else if (sh === 2) { g.moveTo(x, y - r - 1); g.lineTo(x + r + 1, y); g.lineTo(x, y + r + 1); g.lineTo(x - r - 1, y); g.closePath(); }
      else if (sh === 3) { g.moveTo(x, y - r - 1.5); g.lineTo(x + r, y - r * 0.2); g.lineTo(x + r, y + r); g.lineTo(x - r, y + r); g.lineTo(x - r, y - r * 0.2); g.closePath(); }
      else { g.moveTo(x + r, y); g.arc(x, y, r, 0, TAU); }
    },
    // dışa bakan üçgen (kenara iğnelenmiş blip)
    _pinPath(g, x, y, ux, uy, r) {
      const px = -uy, py = ux;
      g.moveTo(x + ux * r * 1.5, y + uy * r * 1.5);
      g.lineTo(x - ux * r * 0.7 + px * r, y - uy * r * 0.7 + py * r);
      g.lineTo(x - ux * r * 0.7 - px * r, y - uy * r * 0.7 - py * r);
      g.closePath();
    },
    _kspr() {
      if (this._kSprite) return this._kSprite;
      const c = U.canvas(24, 24), x = c.getContext('2d');
      x.fillStyle = 'rgba(10,13,20,0.85)'; x.beginPath(); x.arc(12, 12, 11, 0, TAU); x.fill();
      x.fillStyle = '#ffb23e'; x.font = '700 15px "Chakra Petch", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('K', 12, 13);
      this._kSprite = c;
      return c;
    },

    // ---------------- tam ekran harita ----------------
    isMapOpen() { return !!(DS.UI && DS.UI.current === 'map'); },
    openMap() {
      if (!this.ready || !this.g) return;
      if (this.isMapOpen()) return;
      DS.UI.show('map');
      this._sizeMap();
      const f = this._focus();
      const mv = this.mv;
      mv.z = 1.8;
      mv.cx = f ? f.x : this.g.city.cx; mv.cy = f ? f.y : this.g.city.cy;
      this._clampMv();
      const W = this.world();
      this._pois = W && W.mapPois ? W.mapPois() || [] : [];
      if (this.el.mapHint) {
        this.el.mapHint.textContent = this.body.classList.contains('touch')
          ? 'Dokun: yol noktası · Çift dokun: yakınlaş · Kaydır: gez'
          : 'Tıkla: yol noktası · Tekerlek: yakınlaş · Sürükle: gez · Esc/M: kapat';
      }
      this._ptrs.length = 0;
      this._blink = true; this._blinkT = 0;
      this._padSnap = true;
      this.mapDirty = true;
      this._drawMap();
    },
    closeMap() {
      if (this._wpTimer) { clearTimeout(this._wpTimer); this._wpTimer = 0; }
      this._ptrs.length = 0;
      if (this.el && this.el.mapCv) this.el.mapCv.classList.remove('drag');
      this._closeScreen('map');
    },
    // UI kaynaklı kapatma (düğme, Esc, kumanda): önce dünya yöntemi (varsayılan closeMap/closePhone/closeResult;
    // 'retryMission' gibi başka bir yöntem de verilebilir), dünya kaplamayı kapatmadıysa kendimiz kapatırız.
    // kind: 'map' | 'phone' | 'mresult'
    requestClose(kind, method) {
      const W = this.world();
      const own = kind === 'map' ? 'closeMap' : kind === 'phone' ? 'closePhone' : 'closeResult';
      const m = method || own;
      try { if (W && typeof W[m] === 'function') W[m](); } catch (err) { console.error(err); }
      if (DS.UI.current === kind) this[own]();
    },
    _closeScreen(id) {
      const UI = DS.UI, g = this.g;
      if (UI.current === id) {
        UI.hideAll();
        if (g && (g.state === 'play' || g.state === 'pause')) UI.el.hud.hidden = false;
      }
      // kaplama açıkken basılan tuşlar kenar olarak kuyrukta kalmasın (Esc → duraklat, M → harita yeniden)
      if (g && g.input) g.input.reset();
    },
    _focus() {
      const W = this.world(), g = this.g;
      if (W && W.focus) return W.focus();
      if (g.focus) return g.focus();
      return g.car;
    },
    _sizeMap() {
      const cv = this.el.mapCv;
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const w = r.width || window.innerWidth, h = r.height || window.innerHeight;
      const Q = this.g.Q;
      const dpr = Math.min(window.devicePixelRatio || 1, Q && Q.hudDpr ? Math.max(1, Q.hudDpr) : 2);
      const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      cv._w = w; cv._h = h; cv._dpr = cw / w;
      cv._left = r.left; cv._top = r.top;
      const city = this.g.city;
      this.mv.fit = Math.min(w / (city.x1 - city.x0 + 40), h / (city.y1 - city.y0 + 40));
      if (!this.mapCtx) this.mapCtx = cv.getContext('2d', { alpha: false });
    },
    _clampMv() {
      const mv = this.mv, city = this.g.city;
      mv.z = U.clamp(mv.z, 1, 4);
      mv.cx = U.clamp(mv.cx, city.x0, city.x1);
      mv.cy = U.clamp(mv.cy, city.y0, city.y1);
    },
    // harita ekran (css px, tuvale göre) <-> dünya (m)
    mapToWorld(px, py, out) {
      const cv = this.el.mapCv, mv = this.mv, s = mv.fit * mv.z;
      out = out || {};
      out.x = mv.cx + (px - cv._w / 2) / s;
      out.y = mv.cy + (py - cv._h / 2) / s;
      return out;
    },
    worldToMap(x, y, out) {
      const cv = this.el.mapCv, mv = this.mv, s = mv.fit * mv.z;
      out = out || {};
      out.x = cv._w / 2 + (x - mv.cx) * s;
      out.y = cv._h / 2 + (y - mv.cy) * s;
      return out;
    },
    _zoomAt(px, py, z) {
      const mv = this.mv, p = this.mapToWorld(px, py, this._tmp || (this._tmp = {}));
      mv.z = U.clamp(z, 1, 4);
      const s = mv.fit * mv.z, cv = this.el.mapCv;
      mv.cx = p.x - (px - cv._w / 2) / s;
      mv.cy = p.y - (py - cv._h / 2) / s;
      this._clampMv();
      this.mapDirty = true;
    },
    _panPx(dx, dy) {
      const mv = this.mv, s = mv.fit * mv.z;
      mv.cx -= dx / s; mv.cy -= dy / s;
      this._clampMv();
      this.mapDirty = true;
    },

    _bindMap() {
      const cv = this.el.mapCv;
      if (!cv) return;
      const P = this._ptrs;
      const loc = (e, o) => { const r = cv.getBoundingClientRect(); o.x = e.clientX - r.left; o.y = e.clientY - r.top; return o; };
      const find = (id) => { for (let i = 0; i < P.length; i++) if (P[i].id === id) return P[i]; return null; };
      const pinchStart = () => {
        const a = P[0], b = P[1];
        this._pd0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this._pz0 = this.mv.z;
        this._pw = this.mapToWorld((a.x + b.x) / 2, (a.y + b.y) / 2, {});
      };
      cv.addEventListener('pointerdown', (e) => {
        if (!this.isMapOpen()) return;
        e.preventDefault();
        if (P.length >= 2) return;
        const p = loc(e, { id: e.pointerId, x: 0, y: 0, x0: 0, y0: 0, t0: performance.now(), moved: false });
        p.x0 = p.x; p.y0 = p.y;
        P.push(p);
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* yok */ }
        if (P.length === 2) { P[0].moved = true; P[1].moved = true; pinchStart(); }
      });
      cv.addEventListener('pointermove', (e) => {
        const p = find(e.pointerId);
        if (!p) return;
        const ox = p.x, oy = p.y;
        loc(e, p);
        if (P.length === 2) {
          const a = P[0], b = P[1];
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          const mv = this.mv;
          mv.z = U.clamp(this._pz0 * d / this._pd0, 1, 4);
          const s = mv.fit * mv.z, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          mv.cx = this._pw.x - (mx - cv._w / 2) / s;
          mv.cy = this._pw.y - (my - cv._h / 2) / s;
          this._clampMv();
          this.mapDirty = true;
          return;
        }
        if (!p.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) { p.moved = true; cv.classList.add('drag'); this._panPx(p.x - p.x0, p.y - p.y0); return; }
        if (p.moved) this._panPx(p.x - ox, p.y - oy);
      });
      const up = (e) => {
        const p = find(e.pointerId);
        if (!p) return;
        P.splice(P.indexOf(p), 1);
        cv.classList.remove('drag');
        if (P.length === 1) { P[0].x0 = P[0].x; P[0].y0 = P[0].y; P[0].moved = true; }
        if (e.type !== 'pointerup' || p.moved || P.length) return;
        if (performance.now() - p.t0 > 450) return;
        this._tap(p.x, p.y);
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', (e) => {
        if (!this.isMapOpen()) return;
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
        this._zoomAt(e.clientX - r.left, e.clientY - r.top, this.mv.z * Math.exp(-dy * 0.0015));
      }, { passive: false });
      cv.addEventListener('contextmenu', (e) => e.preventDefault());
      // açıklama düğmeleri: katman süzgeci
      if (this.el.legend) {
        this.el.legend.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
          const f = b.dataset.f;
          this.filt[f] = !this.filt[f];
          b.classList.toggle('on', this.filt[f]);
          b.setAttribute('aria-pressed', this.filt[f] ? 'true' : 'false');
          this.mapDirty = true;
        }));
      }
    },

    // dokunuş: çift dokunuş = yakınlaş; tek dokunuş (280 ms sonra) = yol noktası koy / üstüne dokununca sil
    _tap(x, y) {
      const now = performance.now();
      if (this._lastTap && now - this._lastTap.t < 320 && Math.hypot(x - this._lastTap.x, y - this._lastTap.y) < 36) {
        if (this._wpTimer) { clearTimeout(this._wpTimer); this._wpTimer = 0; }
        this._lastTap = null;
        const z = this.mv.z >= 3.99 ? 1.8 : this.mv.z * 2;
        this._zoomAt(x, y, z);
        return;
      }
      this._lastTap = { t: now, x, y };
      if (this._wpTimer) clearTimeout(this._wpTimer);
      this._wpTimer = setTimeout(() => { this._wpTimer = 0; this._waypoint(x, y); }, 280);
    },
    _waypoint(x, y) {
      if (!this.isMapOpen()) return;
      const W = this.world();
      if (!W) return;
      // mevcut yol noktasına dokunuş: sil
      const n = Math.min(MAXB, W.blips ? W.blips(this._bl) | 0 : 0), q = this._tmp2 || (this._tmp2 = {});
      for (let i = 0; i < n; i++) {
        if (this._bl[i].k !== 7) continue;
        this.worldToMap(this._bl[i].x, this._bl[i].y, q);
        if (Math.hypot(q.x - x, q.y - y) < 16) {
          if (W.clearWaypoint) W.clearWaypoint();
          this.mapDirty = true;
          return;
        }
      }
      const p = this.mapToWorld(x, y, {});
      const city = this.g.city;
      if (p.x < city.x0 - 10 || p.x > city.x1 + 10 || p.y < city.y0 - 10 || p.y > city.y1 + 10) return;
      if (W.setWaypoint) W.setWaypoint(p.x, p.y);
      if (this.g.audio && this.g.audio.beep) this.g.audio.beep(880, 0.05, 0.04);
      this.mapDirty = true;
    },

    _drawMap() {
      this.mapDirty = false;
      const cv = this.el.mapCv, g = this.mapCtx, b = this.base(), W = this.world();
      if (!cv || !g || !b) return;
      const mv = this.mv, dpr = cv._dpr, Wc = cv._w, Hc = cv._h, s = mv.fit * mv.z;
      const ox = Wc / 2 - mv.cx * s, oy = Hc / 2 - mv.cy * s;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.fillStyle = '#0d1117'; g.fillRect(0, 0, cv.width, cv.height);
      // taban
      const a = (dpr * s) / b.sc;
      g.imageSmoothingEnabled = true;
      g.setTransform(a, 0, 0, a, dpr * ox, dpr * oy);
      g.drawImage(b.c, 0, 0);
      // rota
      const r = W && W.route;
      if (r && r.n > 1 && r.pts) {
        g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
        this._routePath(g, r);
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = CASE; g.lineWidth = 9 / s; g.stroke();
        g.strokeStyle = '#ffd23e'; g.lineWidth = 5 / s; g.stroke();
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      // bölge adları (uzakken)
      if (mv.z < 2.2) {
        const ds = this._districts();
        if (ds.length) {
          g.font = '400 ' + Math.round(13 + mv.z * 3) + 'px Bungee, Impact, sans-serif';
          g.fillStyle = 'rgba(242,237,227,0.32)';
          for (const d of ds) g.fillText(d.name, ox + d.x * s, oy + d.y * s);
        }
      }
      // sabit yerler (isimli)
      const pois = this._pois || [];
      g.font = '600 12px "Chakra Petch", sans-serif';
      g.lineJoin = 'round';
      for (const p of pois) {
        const d = BK[p.k] || BK_DEF;
        if (d.f && !this.filt[d.f]) continue;
        const x = ox + p.x * s, y = oy + p.y * s;
        if (x < -40 || y < -20 || x > Wc + 40 || y > Hc + 20) continue;
        g.beginPath(); this._shapePath(g, d.sh, x, y, d.r * 1.6);
        g.fillStyle = d.col; g.strokeStyle = CASE; g.lineWidth = 1.5; g.fill(); g.stroke();
        if (p.name && (mv.z >= 1.5 || d.f === 'places')) {
          g.lineWidth = 3; g.strokeStyle = 'rgba(8,10,16,0.85)';
          g.strokeText(p.name, x, y - 14); g.fillStyle = '#f2ede3'; g.fillText(p.name, x, y - 14);
        }
      }
      // dinamik blipler (süzgeçli)
      const n = Math.min(MAXB, W && W.blips ? W.blips(this._bl) | 0 : 0);
      const fl = this._fl;
      for (let i = 0; i < n; i++) {
        const bl = this._bl[i], d = BK[bl.k] || BK_DEF;
        const x = ox + bl.x * s, y = oy + bl.y * s;
        this._sx[i] = x; this._sy[i] = y;
        fl[i] = (!d.f || this.filt[d.f]) && x > -10 && y > -10 && x < Wc + 10 && y < Hc + 10 ? 5 : 0;
      }
      if (n) this._drawBlips(g, n, 1.6);
      // oyuncu (yanıp söner)
      const f = this._focus();
      if (f) {
        const x = ox + f.x * s, y = oy + f.y * s;
        g.fillStyle = this._blink ? 'rgba(255,178,62,0.35)' : 'rgba(255,178,62,0.12)';
        g.beginPath(); g.arc(x, y, 14, 0, TAU); g.fill();
        g.translate(x, y); g.rotate(f.h || 0);
        g.fillStyle = '#ffb23e'; g.strokeStyle = CASE; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(9, 0); g.lineTo(-6, -6); g.lineTo(-3, 0); g.lineTo(-6, 6); g.closePath(); g.fill(); g.stroke();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // ölçek: 100 m çubuğu
      const L = 100 * s;
      g.fillStyle = 'rgba(242,237,227,0.7)';
      g.fillRect(16, Hc - 74, L, 3);
      g.textAlign = 'left'; g.font = '600 11px "Chakra Petch", sans-serif';
      g.fillText('100 m', 16, Hc - 84);
    },

    // bölge adlarının merkezleri (nav.district ile blok merkezlerinden; nav yoksa boş)
    _districts() {
      if (this._dist) return this._dist;
      const W = this.world(), nav = W && W.nav, city = this.g.city;
      if (!nav || !nav.district) return [];
      const acc = {};
      for (const b of city.blocks) {
        const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2;
        let n = '';
        try { n = nav.district(x, y); } catch (e) { n = ''; }
        if (!n) continue;
        const a = acc[n] || (acc[n] = { x: 0, y: 0, n: 0 });
        a.x += x; a.y += y; a.n++;
      }
      const out = [];
      for (const k in acc) out.push({ name: k.toLocaleUpperCase('tr-TR'), x: acc[k].x / acc[k].n, y: acc[k].y / acc[k].n });
      this._dist = out;
      return out;
    },

    // ---------------- telefon ----------------
    openPhone(data) {
      if (!this.ready || !data) return;
      const e = this.el, crew = data.crew || {};
      e.phCrew.textContent = crew.name || 'Ankesörlü telefon';
      e.phCrew.style.color = crew.col || '';
      const resp = U.clamp(+crew.respect || 0, 0, 100);
      if (e.phRespI) { e.phRespI.style.transform = 'scaleX(' + resp / 100 + ')'; e.phRespI.style.background = crew.col || ''; }
      if (e.phRespN) e.phRespN.textContent = String(Math.round(resp));
      const list = e.phList;
      list.textContent = '';
      const items = data.items || [];
      let first = null;
      for (const it of items) {
        const d = document.createElement('div');
        const tier = U.clamp(it.tier | 0, 0, 2);
        d.className = 'ph-item t' + tier + (it.locked ? ' locked' : '') + (it.done ? ' done' : '');
        const nm = document.createElement('b'); nm.className = 'ph-name'; nm.textContent = it.name || it.id;
        d.appendChild(nm);
        if (it.brief) { const p = document.createElement('p'); p.className = 'ph-brief'; p.textContent = it.brief; d.appendChild(p); }
        const meta = document.createElement('div'); meta.className = 'ph-meta';
        const tag = (cls, txt) => { const s = document.createElement('span'); s.className = cls; s.textContent = txt; meta.appendChild(s); };
        tag('tr', TIER[tier]);
        const rw = this._fmtReward(it.reward);
        if (rw) tag('rw', rw);
        if (it.done) tag('dn', 'Tamamlandı');
        if (it.medal > 0) tag('md', MEDAL[U.clamp(it.medal | 0, 1, 3)]);
        if (it.locked) tag('lk', it.lockText || 'Kilitli');
        d.appendChild(meta);
        const btn = document.createElement('button');
        btn.className = 'mini-btn' + (it.locked ? '' : ' buy');
        btn.textContent = 'Başla';
        btn.disabled = !!it.locked;
        btn.dataset.id = it.id;
        btn.addEventListener('click', () => this._pick(it.id));
        d.appendChild(btn);
        list.appendChild(d);
        if (!first && !it.locked) first = btn;
      }
      if (!items.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Şu an iş yok. Sonra tekrar ara.'; list.appendChild(p); }
      DS.UI.show('phone');
      this._padSnap = true;
      const fb = first || e.phone.querySelector('[data-act="phone-close"]');
      if (fb) try { fb.focus({ preventScroll: true }); } catch (err) { /* yok */ }
    },
    _fmtReward(r) {
      if (r === undefined || r === null || r === '') return '';
      if (typeof r === 'number') return r > 0 ? '₺' + U.fmt(r) : '';
      if (Array.isArray(r) && r.length) return r.length > 1 ? '₺' + U.fmt(r[0]) + '–' + U.fmt(r[r.length - 1]) : '₺' + U.fmt(r[0]);
      return String(r);
    },
    _pick(id) {
      const W = this.world();
      let ok;
      try { ok = W && W.pickMission ? W.pickMission(id) : false; } catch (err) { console.error(err); ok = false; }
      if (ok === false && !W) return;
      if (ok === false) { DS.UI.toast('Bu iş şu an başlatılamıyor', 1600); return; }
      // dünya telefonu kendisi kapatmadıysa kapatma isteği (dünya bayrağı da güncellensin)
      if (DS.UI.current === 'phone') this.requestClose('phone');
    },
    closePhone() { this._closeScreen('phone'); },

    // ---------------- görev sonucu ----------------
    showResult(r) {
      if (!this.ready || !r) return;
      const e = this.el;
      const pass = !!r.pass;
      e.mres.classList.toggle('fail', !pass);
      e.mrName.textContent = r.name || 'Görev';
      e.mrTitle.textContent = pass ? 'GÖREV TAMAM!' : 'GÖREV BAŞARISIZ';
      const rw = Math.round(r.reward || 0);
      e.mrReward.textContent = rw > 0 ? '+₺' + U.fmt(rw) : '';
      const md = U.clamp(r.medal | 0, 0, 3);
      e.mrMedal.hidden = md === 0;
      e.mrMedal.className = md ? 'm' + md : '';
      e.mrMedal.textContent = MEDAL[md];
      let note = r.note || '';
      const rs = r.respect;
      if (rs && rs.delta) {
        let nm = CREW_N[rs.crew] || rs.crew;
        if (DS.CREWS) for (const c of DS.CREWS) if (c.id === rs.crew) nm = c.name;
        note += (note ? ' · ' : '') + nm + ' saygınlığı ' + (rs.delta > 0 ? '+' : '') + rs.delta;
      }
      e.mrNote.textContent = note;
      e.mrRetry.hidden = !r.canRetry;
      // birincil düğme: başarısızlıkta TEKRAR DENE
      e.mrRetry.classList.toggle('primary', !pass);
      e.mrClose.classList.toggle('primary', pass || !r.canRetry);
      DS.UI.show('mresult');
      this._padSnap = true;
      const fb = !pass && r.canRetry ? e.mrRetry : e.mrClose;
      try { fb.focus({ preventScroll: true }); } catch (err) { /* yok */ }
    },
    closeResult() { this._closeScreen('mresult'); },

    // ---------------- klavye (kaplamalar açıkken) ----------------
    _bindKeys() {
      // yakalama evresi: kaplama tuşları oyun girdisine hiç ulaşmaz (Esc duraklatma kenarı bırakmaz)
      window.addEventListener('keydown', (e) => {
        const cur = DS.UI && DS.UI.current;
        if (!cur || !OVER[cur] || !this.g) return;
        const c = e.code;
        if (cur === 'map') {
          let done = true;
          if (c === 'Escape' || c === 'KeyM' || c === 'Tab') { if (!e.repeat) this.requestClose('map'); }
          else if (c === 'Equal' || c === 'NumpadAdd' || c === 'PageUp') this._zoomAt(this.el.mapCv._w / 2, this.el.mapCv._h / 2, this.mv.z * 1.25);
          else if (c === 'Minus' || c === 'NumpadSubtract' || c === 'PageDown') this._zoomAt(this.el.mapCv._w / 2, this.el.mapCv._h / 2, this.mv.z / 1.25);
          else if (c === 'ArrowLeft' || c === 'KeyA') this._panPx(70, 0);
          else if (c === 'ArrowRight' || c === 'KeyD') this._panPx(-70, 0);
          else if (c === 'ArrowUp' || c === 'KeyW') this._panPx(0, 70);
          else if (c === 'ArrowDown' || c === 'KeyS') this._panPx(0, -70);
          else done = false;
          if (done) { e.preventDefault(); e.stopPropagation(); }
        } else if (c === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          if (!e.repeat) this.requestClose(cur === 'phone' ? 'phone' : 'mresult');
        }
      }, true);
    },

    // ---------------- kumanda (kaplamalar açıkken dünya donuk; girdi yoklanmaz) ----------------
    _pad(cur) {
      const I = this.g.input;
      if (!I || !(I.padCount > 0) || !navigator.getGamepads) return;
      const pads = navigator.getGamepads();
      let gp = null;
      for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
      if (!gp) return;
      const prev = this._padPrev, snap = this._padSnap;
      this._padSnap = false;
      let ed = 0; // basılan düğmelerin bit maskesi (0..15)
      for (let i = 0; i < 16; i++) {
        const bt = gp.buttons[i];
        const p = !!bt && (bt.pressed || bt.value > 0.5);
        if (p && !prev[i] && !snap) ed |= 1 << i;
        prev[i] = p;
      }
      if (cur === 'map') {
        if (ed & ((1 << 1) | (1 << 8) | (1 << 9))) { this.requestClose('map'); return; }
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (Math.abs(ax) > 0.2 || Math.abs(ay) > 0.2) this._panPx(-ax * 9, -ay * 9);
        const zt = (gp.buttons[7] ? gp.buttons[7].value : 0) - (gp.buttons[6] ? gp.buttons[6].value : 0);
        if (Math.abs(zt) > 0.1) this._zoomAt(this.el.mapCv._w / 2, this.el.mapCv._h / 2, this.mv.z * (1 + zt * 0.04));
        if (ed & 1) { const c = this.el.mapCv; this._waypoint(c._w / 2, c._h / 2); }
        return;
      }
      if (!ed) return;
      const scr = cur === 'phone' ? this.el.phone : this.el.mres;
      if (ed & ((1 << 1) | (1 << 9))) { this.requestClose(cur === 'phone' ? 'phone' : 'mresult'); return; }
      const btns = Array.prototype.filter.call(scr.querySelectorAll('button'), (b) => !b.disabled && b.getClientRects().length);
      if (!btns.length) return;
      let i = btns.indexOf(document.activeElement);
      if (ed & 1) { (i >= 0 ? btns[i] : btns[0]).click(); return; }
      if (ed & ((1 << 12) | (1 << 14))) i = i <= 0 ? btns.length - 1 : i - 1;
      else if (ed & ((1 << 13) | (1 << 15))) i = i < 0 || i >= btns.length - 1 ? 0 : i + 1;
      else return;
      try { btns[i].focus({ preventScroll: false }); } catch (err) { /* yok */ }
    },
  });
})();
