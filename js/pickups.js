'use strict';
// Açık şehir: toplanabilir eşyalar (pickup) ve 50 gizli paket.
// - Normal eşyalar (~28): can, zırh, rüşvet rozeti, tamir anahtarı, nitro tüpü, para çantası, kefalet kartı.
//   Yerler nav/şehir geometrisinden bir kez ve deterministik üretilir (U.rng(777)); alındıktan sonra
//   180 s (rüşvet 300 s) içinde yeniden doğar. Etkiyi dünya uygular: W.world.onPickup(tür, değer, x, y)
//   true dönerse tüketilir (ör. can doluyken false → eşya yerinde kalır).
// - Gizli paketler (50): gizli köşelerde (U.rng(4242)); her biri +₺100, her 10'da bir ikramiye,
//   50/50'de büyük ödül. Toplananlar save.ow.pickups.got içinde (base36 bit kümesi) kalıcıdır.
// Performans: güncelleme kare başına yalnız yakın listeyi (≤ birkaç öğe) tarar; tam tarama 0,25 s'de bir;
// kare başına tahsis yok; simgeler bir kez küçük tuvallere pişirilir (görünen öğe başına tek drawImage).
(function () {
  const DS = window.DS, U = DS.U;
  const PI = Math.PI, TAU = PI * 2;

  // ---------------- türler ----------------
  // val: dünyaya giden değer (can/zırh puanı, yıldız, araç HP oranı, nitro süresi, kart adedi)
  // foot/car: yayayken/araçtayken alınabilir mi; resp: yeniden doğma (s); blip: mini harita türü
  const KINDS = [
    { id: 'health', name: 'Can', val: 50, foot: true, car: true, resp: 180, blip: 11, col: '#e8314f', hi: '#ff8a9c', glow: '#ff5a72' },
    { id: 'armor', name: 'Zırh', val: 50, foot: true, car: true, resp: 180, blip: 12, col: '#2f7de1', hi: '#86bcff', glow: '#5aa2ff' },
    { id: 'bribe', name: 'Rüşvet Rozeti', val: 1, foot: true, car: true, resp: 300, blip: 13, col: '#1f3f9e', hi: '#6a8ae6', glow: '#ffd23e' },
    { id: 'wrench', name: 'Tamir Anahtarı', val: 0.5, foot: false, car: true, resp: 180, blip: 14, col: '#ea7d1c', hi: '#ffc27e', glow: '#ffae5a' },
    { id: 'nitro', name: 'Nitro Tüpü', val: 10, foot: false, car: true, resp: 180, blip: 14, col: '#0f97bd', hi: '#7fe6ff', glow: '#5ae0ff' },
    { id: 'cash', name: 'Para Çantası', val: 0, foot: true, car: true, resp: 180, blip: 14, col: '#22914a', hi: '#79dc98', glow: '#6aff9a' },
    { id: 'card', name: 'Kefalet Kartı', val: 1, foot: true, car: true, resp: 180, blip: 14, col: '#8442d0', hi: '#c497ff', glow: '#c88cff' },
  ];
  const KI = {};
  for (let i = 0; i < KINDS.length; i++) KI[KINDS[i].id] = i;
  const CASH = KI.cash, CARD = KI.card;
  DS.PICKUP_KINDS = KINDS;

  // normal eşya yuvaları [tür, yer kategorisi]; kısıtlı kategoriler önce (28 adet)
  const SLOTS = [
    ['nitro', 'drift'], ['wrench', 'aisle'], ['nitro', 'aisle'], ['wrench', 'aisle'],
    ['bribe', 'park'], ['health', 'park'], ['armor', 'park'], ['cash', 'park'], ['bribe', 'park'],
    ['bribe', 'court'], ['health', 'court'], ['armor', 'court'], ['cash', 'court'], ['card', 'court'], ['bribe', 'court'],
    ['bribe', 'ind'], ['health', 'ind'], ['armor', 'ind'], ['cash', 'ind'], ['card', 'ind'],
    ['bribe', 'pcorner'],
    ['health', 'side'], ['health', 'side'], ['health', 'side'], ['armor', 'side'], ['cash', 'side'], ['wrench', 'side'], ['nitro', 'side'],
  ];
  // gizli paket kategorileri (50 adet; sıra = bit indeksi, değiştirilmemeli)
  const PKG_CATS = [
    'court', 'ind', 'parkCorner', 'court', 'pcorner', 'ind', 'driftEdge', 'court', 'parkTree', 'ind',
    'court', 'parkCorner', 'court', 'ind', 'pcorner', 'court', 'driftEdge', 'ind', 'court', 'parkCorner',
    'court', 'ind', 'pcorner', 'court', 'parkTree', 'ind', 'court', 'driftEdge', 'parkCorner', 'court',
    'ind', 'court', 'pcorner', 'ind', 'court', 'parkCorner', 'driftEdge', 'court', 'ind', 'pcorner',
    'court', 'parkCorner', 'ind', 'court', 'parkTree', 'court', 'driftEdge', 'parkCorner', 'pcorner', 'court',
  ];
  const TOTAL = PKG_CATS.length;            // 50

  // ---------------- ayarlar ----------------
  const R_FOOT = 1.2, R_CAR = 2.6;          // normal eşya toplama yarıçapı
  const RP_FOOT = 1.5, RP_CAR = 3;          // gizli paket toplama yarıçapı
  const NEAR = 40, NEAR2 = NEAR * NEAR;     // yakın liste yarıçapı (0,25 s'de 45 m/s ile 11 m)
  const SCAN_T = 0.25;                      // tam tarama aralığı (s)
  const JUMP2 = 15 * 15;                    // bir karede bundan uzun sıçrama = ışınlanma (süpürme yok)
  const REARM_T = 3;                        // reddedilen eşya: çıkıp girmeden ya da bu süre dolmadan tekrar sorulmaz
  const REARM_OUT = 1.5;                    // yarıçap + bu kadar uzaklaşınca yeniden kurulur
  const VIS_WAIT = 30;                      // yeniden doğma görünürken en fazla bu kadar ertelenir
  const BLIP_R2 = 120 * 120;
  const PKG_CASH = 100, PKG_STEP = 1000, PKG_ALL = 50000;
  const EXCL = 9, EXCL2 = EXCL * EXCL;      // özel yerlerden (telefon, güvenli ev, boyahane…) uzaklık
  // çizim
  const ICON_PX = 48, PKG_PX = 32, GLOW_PX = 32;
  const SPR_M = 1.8;                        // normal simge sprite boyu (m); disk ≈ 1,25 m
  const PKG_M = 1.05;                       // paket sprite boyu (m); kasa ≈ 0,72 m
  const GLOW_M = 1.9;                       // ışık haritası parlama yarıçapı (m)
  const FRAMES = 4;                         // parıltı halkası dönüş kareleri (90° simetri / 22,5° adım)
  const OUT = '#14161f';
  const POW2 = new Float64Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) POW2[i] = Math.pow(2, i);
  const MAXV = Math.pow(2, TOTAL) - 1;

  // ---------------- bit kümesi (base36) ----------------
  const encodeBits = (got, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (got[i]) v += POW2[i];
    return v.toString(36);
  };
  // geçersiz/bozuk girdi → boş küme
  const decodeBits = (s, got) => {
    got.fill(0);
    if (typeof s === 'number' && isFinite(s)) s = Math.floor(s).toString(36);
    if (typeof s !== 'string' || !/^[0-9a-z]{1,11}$/.test(s)) return false;
    const v = parseInt(s, 36);
    if (!(v >= 0 && v <= MAXV)) return false;
    for (let i = 0; i < TOTAL; i++) got[i] = Math.floor(v / POW2[i]) % 2;
    return true;
  };

  // ---------------- simgeler (bir kez pişirilir) ----------------
  // simge çizimleri: (cx, cy) merkez, u ölçek (px)
  const GLYPH = {
    health(g, cx, cy, u) {
      g.beginPath();
      g.moveTo(cx, cy + u * 0.9);
      g.bezierCurveTo(cx - u * 1.3, cy - u * 0.02, cx - u * 0.78, cy - u * 1.12, cx, cy - u * 0.42);
      g.bezierCurveTo(cx + u * 0.78, cy - u * 1.12, cx + u * 1.3, cy - u * 0.02, cx, cy + u * 0.9);
      g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
      g.fillStyle = '#e8314f';
      g.fillRect(cx - u * 0.12, cy - u * 0.42, u * 0.24, u * 0.72);
      g.fillRect(cx - u * 0.36, cy - u * 0.18, u * 0.72, u * 0.24);
    },
    armor(g, cx, cy, u) {
      g.beginPath();
      g.moveTo(cx - u * 0.42, cy - u * 0.98);
      g.lineTo(cx - u * 0.14, cy - u * 0.98);
      g.lineTo(cx, cy - u * 0.5);
      g.lineTo(cx + u * 0.14, cy - u * 0.98);
      g.lineTo(cx + u * 0.42, cy - u * 0.98);
      g.lineTo(cx + u * 0.98, cy - u * 0.5);
      g.lineTo(cx + u * 0.7, cy - u * 0.2);
      g.lineTo(cx + u * 0.76, cy + u * 0.92);
      g.lineTo(cx - u * 0.76, cy + u * 0.92);
      g.lineTo(cx - u * 0.7, cy - u * 0.2);
      g.lineTo(cx - u * 0.98, cy - u * 0.5);
      g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
      g.fillStyle = '#2f7de1';
      g.fillRect(cx - u * 0.72, cy + u * 0.18, u * 1.44, u * 0.26);
      g.fillRect(cx - u * 0.08, cy - u * 0.42, u * 0.16, u * 1.3);
    },
    bribe(g, cx, cy, u) {
      // altın polis rozeti: beş köşeli yıldız + mavi göbek
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = -PI / 2 + (k * PI) / 5, r = k & 1 ? u * 0.48 : u * 1.05;
        const x = cx + Math.cos(a) * r, y = cy + 0.06 * u + Math.sin(a) * r;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = '#ffd23e'; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
      g.beginPath(); g.arc(cx, cy + 0.06 * u, u * 0.3, 0, TAU);
      g.fillStyle = '#1f3f9e'; g.fill();
      g.lineWidth = 1; g.strokeStyle = '#fff2b0'; g.stroke();
    },
    wrench(g, cx, cy, u) {
      g.save();
      g.translate(cx, cy);
      g.rotate(-PI / 4);
      g.beginPath();
      g.moveTo(-u * 1.0, -u * 0.17);
      g.lineTo(u * 0.3, -u * 0.17);
      g.arc(u * 0.6, 0, u * 0.46, PI + 0.38, PI - 0.38, false);
      g.lineTo(-u * 1.0, u * 0.17);
      g.closePath();
      g.fillStyle = '#eef1f5'; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
      // ağız (disk rengiyle kesik)
      g.fillStyle = '#ea7d1c';
      g.fillRect(u * 0.66, -u * 0.17, u * 0.5, u * 0.34);
      g.beginPath(); g.arc(-u * 0.82, 0, u * 0.09, 0, TAU); g.fillStyle = OUT; g.fill();
      g.restore();
    },
    nitro(g, cx, cy, u) {
      g.save();
      g.translate(cx, cy);
      g.rotate(0.6);
      // tüp gövdesi
      g.beginPath();
      g.moveTo(-u * 0.36, -u * 0.62);
      g.lineTo(u * 0.36, -u * 0.62);
      g.lineTo(u * 0.36, u * 0.78);
      g.arc(0, u * 0.78, u * 0.36, 0, PI, false);
      g.lineTo(-u * 0.36, -u * 0.62);
      g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
      g.fillStyle = '#0f97bd';
      g.fillRect(-u * 0.36, -u * 0.12, u * 0.72, u * 0.3);
      // vana
      g.fillStyle = '#9aa3ad';
      g.fillRect(-u * 0.2, -u * 0.95, u * 0.4, u * 0.34);
      g.strokeRect(-u * 0.2, -u * 0.95, u * 0.4, u * 0.34);
      g.restore();
      // şimşek
      g.beginPath();
      g.moveTo(cx + u * 0.55, cy - u * 0.35);
      g.lineTo(cx + u * 0.22, cy + u * 0.18);
      g.lineTo(cx + u * 0.48, cy + u * 0.18);
      g.lineTo(cx + u * 0.3, cy + u * 0.78);
      g.lineTo(cx + u * 0.88, cy + u * 0.02);
      g.lineTo(cx + u * 0.6, cy + u * 0.02);
      g.lineTo(cx + u * 0.82, cy - u * 0.35);
      g.closePath();
      g.fillStyle = '#ffe14a'; g.fill();
      g.lineWidth = 1; g.strokeStyle = OUT; g.stroke();
    },
    cash(g, cx, cy, u) {
      // para torbası + ₺ (yazı tipine güvenmeden çizgiyle)
      g.beginPath();
      g.moveTo(cx - u * 0.28, cy - u * 0.62);
      g.lineTo(cx + u * 0.28, cy - u * 0.62);
      g.lineTo(cx + u * 0.12, cy - u * 0.4);
      g.bezierCurveTo(cx + u * 1.05, cy - u * 0.2, cx + u * 1.0, cy + u * 0.95, cx, cy + u * 0.95);
      g.bezierCurveTo(cx - u * 1.0, cy + u * 0.95, cx - u * 1.05, cy - u * 0.2, cx - u * 0.12, cy - u * 0.4);
      g.closePath();
      g.fillStyle = '#f1dfa8'; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
      g.beginPath();
      g.moveTo(cx - u * 0.42, cy - u * 0.98); g.lineTo(cx, cy - u * 0.62); g.lineTo(cx + u * 0.42, cy - u * 0.98);
      g.stroke();
      g.strokeStyle = '#1c7a3c'; g.lineWidth = 2; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - u * 0.12, cy - u * 0.2);
      g.lineTo(cx - u * 0.12, cy + u * 0.66);
      g.quadraticCurveTo(cx + u * 0.42, cy + u * 0.62, cx + u * 0.44, cy + u * 0.2);
      g.moveTo(cx - u * 0.4, cy + u * 0.16); g.lineTo(cx + u * 0.18, cy - u * 0.04);
      g.moveTo(cx - u * 0.4, cy + u * 0.38); g.lineTo(cx + u * 0.18, cy + u * 0.18);
      g.stroke();
      g.lineCap = 'butt';
    },
    card(g, cx, cy, u) {
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.22);
      const w = u * 1.7, h = u * 1.12;
      g.fillStyle = '#ffffff';
      g.fillRect(-w / 2, -h / 2, w, h);
      g.lineWidth = 1.5; g.strokeStyle = OUT;
      g.strokeRect(-w / 2, -h / 2, w, h);
      g.fillStyle = '#8442d0';
      g.fillRect(-w / 2, -h / 2, w, h * 0.26);
      // altın anahtar
      g.fillStyle = '#ffc21a';
      g.beginPath(); g.arc(-w * 0.22, h * 0.14, u * 0.22, 0, TAU); g.fill();
      g.lineWidth = 1; g.stroke();
      g.fillRect(-w * 0.1, h * 0.08, w * 0.42, u * 0.12);
      g.fillRect(w * 0.18, h * 0.08, u * 0.1, u * 0.24);
      g.fillRect(w * 0.27, h * 0.08, u * 0.1, u * 0.18);
      g.beginPath(); g.arc(-w * 0.22, h * 0.14, u * 0.08, 0, TAU); g.fillStyle = '#ffffff'; g.fill();
      g.restore();
    },
  };

  // normal eşya karesi: gölge + renkli disk + beyaz halka + dönen parıltı + simge
  const bakeIcon = (k, f) => {
    const S = ICON_PX, c = U.canvas(S, S), g = c.getContext('2d');
    const d = KINDS[k], cx = S / 2, cy = S / 2 - 1, r = S * 0.355;
    g.fillStyle = 'rgba(8,10,20,0.34)';
    g.beginPath(); g.ellipse(cx + 2, cy + 3.5, r + 0.5, r * 0.9, 0, 0, TAU); g.fill();
    g.fillStyle = d.col;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    // üst-sol parlaklık hilali
    g.fillStyle = d.hi;
    g.beginPath(); g.arc(cx, cy, r - 2.5, PI * 1.02, PI * 1.62); g.arc(cx, cy, r - 6.5, PI * 1.62, PI * 1.02, true); g.closePath(); g.fill();
    g.lineWidth = 2.2; g.strokeStyle = '#ffffff';
    g.beginPath(); g.arc(cx, cy, r - 1.6, 0, TAU); g.stroke();
    g.lineWidth = 1.6; g.strokeStyle = OUT;
    g.beginPath(); g.arc(cx, cy, r + 0.5, 0, TAU); g.stroke();
    // dönen parıltı: 4 kısa yay (90° simetri), kare başına 22,5°
    const a0 = (f * PI) / 8;
    g.strokeStyle = '#ffffff'; g.lineWidth = 2.4; g.lineCap = 'round';
    for (let q = 0; q < 4; q++) {
      const a = a0 + (q * PI) / 2;
      g.beginPath(); g.arc(cx, cy, r + 3.4, a, a + 0.36); g.stroke();
    }
    g.lineCap = 'butt';
    GLYPH[d.id](g, cx, cy, r * 0.6);
    return c;
  };
  // gizli paket: zeytin yeşili küçük kasa + "?"
  const bakeCrate = () => {
    const S = PKG_PX, c = U.canvas(S, S), g = c.getContext('2d');
    const w = 22, x0 = (S - w) / 2, y0 = (S - w) / 2 - 1;
    g.fillStyle = 'rgba(8,10,20,0.34)';
    g.fillRect(x0 + 2, y0 + 3, w, w);
    g.fillStyle = '#6b773a';
    g.fillRect(x0, y0, w, w);
    g.fillStyle = '#58632d';
    g.fillRect(x0 + 2, y0 + 7, w - 4, 1.5);
    g.fillRect(x0 + 2, y0 + 14, w - 4, 1.5);
    g.fillStyle = '#87934f';
    g.fillRect(x0, y0, w, 2); g.fillRect(x0, y0, 2, w);
    g.lineWidth = 1.5; g.strokeStyle = '#2f3716';
    g.strokeRect(x0 + 0.75, y0 + 0.75, w - 1.5, w - 1.5);
    g.font = 'bold 17px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = '#2f3716';
    g.strokeText('?', S / 2, y0 + w / 2 + 1);
    g.fillStyle = '#e9df92';
    g.fillText('?', S / 2, y0 + w / 2 + 1);
    return c;
  };
  // ışık haritası parlaması (gece)
  const bakeGlow = (hex) => {
    const S = GLOW_PX, c = U.canvas(S, S), g = c.getContext('2d');
    const rgb = U.hex2rgb(hex), h = S / 2;
    const gr = g.createRadialGradient(h, h, 0, h, h, h);
    gr.addColorStop(0, U.rgb(rgb[0], rgb[1], rgb[2], 0.95));
    gr.addColorStop(0.35, U.rgb(rgb[0], rgb[1], rgb[2], 0.42));
    gr.addColorStop(1, U.rgb(rgb[0], rgb[1], rgb[2], 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    return c;
  };

  // ---------------- sınıf ----------------
  class Pickups {
    constructor(W) {
      this.W = W;
      this.city = W ? W.city : null;
      this.nav = W ? W.nav : null;
      this.Q = W ? W.Q : null;
      this.glow = false;
      // normal eşyalar
      this.n = 0;
      this.rx = new Float32Array(SLOTS.length);
      this.ry = new Float32Array(SLOTS.length);
      this.rk = new Uint8Array(SLOTS.length);
      this.rc = [];                         // yer kategorisi (test/hata ayıklama)
      this.due = new Float64Array(SLOTS.length);   // 0 = yerinde; > 0 = yeniden doğma zamanı (this.t)
      this.armed = new Uint8Array(SLOTS.length);
      this.rearm = new Float64Array(SLOTS.length);
      // gizli paketler
      this.np = 0;
      this.px = new Float32Array(TOTAL);
      this.py = new Float32Array(TOTAL);
      this.pc = [];
      this.got = new Uint8Array(TOTAL);
      this.nGot = 0;
      // yakın listeler
      this._nr = new Uint8Array(SLOTS.length); this._nnr = 0;
      this._npk = new Uint8Array(TOTAL); this._nnp = 0;
      this.t = 0;
      this._scanT = 0;
      this._ox = 0; this._oy = 0; this._has = false;
      this._qx = 0; this._qy = 0;
      this._cnt = { packages: 0, total: TOTAL };
      this.st = { got: '0', card: 0 };      // canlı ow.pickups (load ile bağlanır)
      this.ow = null;
      this._icons = null; this._crate = null; this._glows = null;
      this.genMs = 0;
      if (this.city && this.nav) {
        const t0 = Date.now();
        try { this._generate(); } catch (e) { console.error(e); }
        this.genMs = Date.now() - t0;
      }
      this.setQuality(this.Q);
      this.reset();
    }

    // ================= YER ÜRETİMİ (bir kez, deterministik) =================
    _generate() {
      const G = this._geo();
      // --- normal eşyalar
      const R = U.rng(777), o = { x: 0, y: 0 };
      const ax = [], ay = [], ak = [];
      for (let s = 0; s < SLOTS.length; s++) {
        const k = KI[SLOTS[s][0]], cat0 = SLOTS[s][1], carOnly = !KINDS[k].foot;
        let ok = false;
        for (let a = 0; a < 600 && !ok; a++) {
          const cat = a < 450 ? cat0 : 'side';
          const relax = a < 150 ? 1 : a < 300 ? 0.6 : 0.35;
          if (!this._cand(cat, R, o, G, carOnly)) continue;
          const x = o.x, y = o.y;
          const clr = carOnly && cat !== 'side' ? 1.3 : 0.8;
          // ucuz denetimler önce: aralık, yüzey/engel, ağaç tacı, en son erişim ışınları
          let bad = false;
          const dAll = 70 * relax, dSame = 160 * relax;
          for (let j = 0; j < ax.length && !bad; j++) {
            const dx = ax[j] - x, dy = ay[j] - y, d2 = dx * dx + dy * dy;
            if (d2 < dAll * dAll || (ak[j] === k && d2 < dSame * dSame)) bad = true;
          }
          if (bad) continue;
          if (!this._valid(x, y, clr, G)) continue;
          if (this._underTree(x, y, G, 1, 0.5)) continue;
          if (!this._reach(x, y, G)) continue;
          ax.push(x); ay.push(y); ak.push(k); this.rc.push(cat);
          ok = true;
        }
      }
      this.n = ax.length;
      for (let i = 0; i < this.n; i++) { this.rx[i] = ax[i]; this.ry[i] = ay[i]; this.rk[i] = ak[i]; }
      // --- gizli paketler
      const P = U.rng(4242);
      const bx = [], by = [];
      for (let s = 0; s < TOTAL; s++) {
        const cat0 = PKG_CATS[s];
        let ok = false;
        for (let a = 0; a < 700 && !ok; a++) {
          const cat = a < 450 ? cat0 : a < 575 ? 'court' : 'ind';
          const relax = a < 150 ? 1 : a < 300 ? 0.65 : 0.4;
          if (!this._cand(cat, P, o, G, false)) continue;
          const x = o.x, y = o.y;
          let bad = false;
          const dP = 35 * relax;
          for (let j = 0; j < bx.length && !bad; j++) { const dx = bx[j] - x, dy = by[j] - y; if (dx * dx + dy * dy < dP * dP) bad = true; }
          for (let j = 0; j < ax.length && !bad; j++) { const dx = ax[j] - x, dy = ay[j] - y; if (dx * dx + dy * dy < 144) bad = true; }
          if (bad) continue;
          if (!this._valid(x, y, 0.6, G)) continue;
          if (this._underTree(x, y, G, 0.45, 0)) continue;
          if (!this._reach(x, y, G)) continue;
          bx.push(x); by.push(y); this.pc.push(cat);
          ok = true;
        }
        if (!ok) { bx.push(NaN); by.push(NaN); this.pc.push(''); }   // indeks kayması olmasın (bit = yuva)
      }
      this.np = TOTAL;
      for (let j = 0; j < TOTAL; j++) { this.px[j] = bx[j]; this.py[j] = by[j]; }
    }

    // statik geometri listeleri (yalnız üretimde)
    _geo() {
      const city = this.city, nav = this.nav, P = nav.places || {};
      const G = { side: [], park: [], parking: [], ind: [], courts: [], drift: null, tx: [], ty: [], tr: [], parkTrees: [], aisles: [], ex: [], ey: [], gone: [] };
      for (const b of city.blocks) {
        if (b.type === 'drift') { G.drift = b; continue; }
        G.side.push(b);
        if (b.type === 'park') G.park.push(b);
        else if (b.type === 'parking') G.parking.push(b);
        else if (b.type === 'ind') G.ind.push(b);
        else if (b.type === 'build') for (const c of b.courts) if (c.x1 - c.x0 > 5 && c.y1 - c.y0 > 5) G.courts.push(c);
      }
      if (!G.drift && city.driftBlock) G.drift = city.driftBlock;
      for (const t of city.tall) if (t.kind === 'tree') { G.tx.push(t.x); G.ty.push(t.y); G.tr.push(t.rc || 2.5); }
      for (const b of G.park) {
        const I = b.inner, list = [];
        for (let i = 0; i < G.tx.length; i++) if (G.tx[i] > I.x0 + 2 && G.tx[i] < I.x1 - 2 && G.ty[i] > I.y0 + 2 && G.ty[i] < I.y1 - 2) list.push(i);
        G.parkTrees.push(list);
      }
      // otopark koridorları (city._parking ile aynı satır düzeni)
      for (const b of G.parking) {
        const I = b.inner, depth = 5.3, aisle = 7.2, ys = [];
        let y = I.y0 + 0.8;
        for (let k = 0; y + depth <= I.y1 - 0.5; k++) {
          if (k % 2 === 0) ys.push(y + depth + aisle / 2);
          y += depth + (k % 2 === 0 ? aisle : 0);
        }
        G.aisles.push(ys);
      }
      // özel yerler: üst üste binmesin (tetikleyiciler, işaretler, telefonlar, etkinlikler)
      const ex = (p) => { if (p && typeof p.x === 'number' && typeof p.y === 'number') { G.ex.push(p.x); G.ey.push(p.y); } };
      const sh = P.safehouse;
      if (sh) {
        ex(sh); ex(sh.walker); ex(sh.car); ex(sh.door);
        if (sh.trigger) ex({ x: (sh.trigger.x0 + sh.trigger.x1) / 2, y: (sh.trigger.y0 + sh.trigger.y1) / 2 });
      }
      if (P.spray) { ex(P.spray); ex(P.spray.exit); ex(P.spray.door); }
      if (P.hospital) { ex(P.hospital); ex(P.hospital.sign); }
      if (P.police) { ex(P.police); ex(P.police.sign); }
      if (P.phones) for (const p of P.phones) { ex(p); ex({ x: p.sx, y: p.sy }); }
      ex(P.crane); ex(P.driftGate);
      if (DS.SIDE) for (const s of DS.SIDE) ex(s);
      // oyuncunun aldığı park araçları (kalıcılar hariç) yine dolu sayılır: üretim oyun durumundan bağımsız
      if (city.parked) for (const p of city.parked) if (p.gone && !p.perm && p.box) G.gone.push(p.box);
      // statik engel sorgusu (kırılmış direk/hidrant da dolu sayılır)
      const q = { x: 0, y: 0, r: 0, hit: false };
      G.q = q;
      G.qfn = (k, col) => {
        if (q.hit) return;
        if (k === 'b') { if (U.distPointBox(q.x, q.y, col.x0, col.y0, col.x1, col.y1) < q.r) q.hit = true; }
        else { const dx = q.x - col.x, dy = q.y - col.y, rr = q.r + col.r; if (dx * dx + dy * dy < rr * rr) q.hit = true; }
      };
      return G;
    }

    // aday nokta (kategoriye göre) → o.x, o.y
    _cand(cat, R, o, G, car) {
      let b, I;
      switch (cat) {
        case 'side': {   // kaldırım: köşelerden (yaya geçitleri) uzak, bordürden içeri
          b = G.side[(R() * G.side.length) | 0];
          const sd = (R() * 4) | 0, len = sd & 1 ? b.y1 - b.y0 : b.x1 - b.x0;
          if (len < 40) return false;
          const s = 14 + R() * (len - 28), d = car ? 0.95 + R() * 0.45 : 1.4 + R() * 0.8;
          if (sd === 0) { o.x = b.x0 + s; o.y = b.y0 + d; }
          else if (sd === 1) { o.x = b.x1 - d; o.y = b.y0 + s; }
          else if (sd === 2) { o.x = b.x1 - s; o.y = b.y1 - d; }
          else { o.x = b.x0 + d; o.y = b.y1 - s; }
          return true;
        }
        case 'park': {
          if (!G.park.length) return false;
          b = G.park[(R() * G.park.length) | 0]; I = b.inner;
          o.x = I.x0 + 3 + R() * (I.x1 - I.x0 - 6); o.y = I.y0 + 3 + R() * (I.y1 - I.y0 - 6);
          return true;
        }
        case 'parkCorner': {
          if (!G.park.length) return false;
          b = G.park[(R() * G.park.length) | 0]; I = b.inner;
          const c = (R() * 4) | 0, dx = 1.2 + R() * 3.6, dy = 1.2 + R() * 3.6;
          o.x = c & 1 ? I.x1 - dx : I.x0 + dx; o.y = c & 2 ? I.y1 - dy : I.y0 + dy;
          return true;
        }
        case 'parkTree': {   // ağaç tacının kenarı: kısmen gizli
          if (!G.park.length) return false;
          const pi = (R() * G.park.length) | 0, list = G.parkTrees[pi];
          if (!list.length) return false;
          const ti = list[(R() * list.length) | 0], a = R() * TAU, d = G.tr[ti] * (0.5 + R() * 0.3);
          o.x = G.tx[ti] + Math.cos(a) * d; o.y = G.ty[ti] + Math.sin(a) * d;
          return true;
        }
        case 'court': {      // bina arkası avlular / ara boşluklar
          if (!G.courts.length) return false;
          const c = G.courts[(R() * G.courts.length) | 0];
          o.x = c.x0 + 1.2 + R() * (c.x1 - c.x0 - 2.4); o.y = c.y0 + 1.2 + R() * (c.y1 - c.y0 - 2.4);
          return true;
        }
        case 'aisle': {      // otopark koridoru (araçla girilebilir)
          if (!G.parking.length) return false;
          const bi = (R() * G.parking.length) | 0, ys = G.aisles[bi];
          if (!ys.length) return false;
          I = G.parking[bi].inner;
          o.y = ys[(R() * ys.length) | 0] + (R() - 0.5) * 1.2; o.x = I.x0 + 4 + R() * (I.x1 - I.x0 - 8);
          return true;
        }
        case 'pcorner': {    // otopark köşesi (park sıralarının dışındaki şerit)
          if (!G.parking.length) return false;
          b = G.parking[(R() * G.parking.length) | 0]; I = b.inner;
          const c = (R() * 4) | 0, dx = 0.7 + R() * 0.5, dy = 0.6 + R() * 2.6;
          o.x = c & 1 ? I.x1 - dx : I.x0 + dx; o.y = c & 2 ? I.y1 - dy : I.y0 + dy;
          return true;
        }
        case 'ind': {        // sanayi: depo arkası, konteyner araları
          if (!G.ind.length) return false;
          b = G.ind[(R() * G.ind.length) | 0]; I = b.inner;
          o.x = I.x0 + 1 + R() * (I.x1 - I.x0 - 2); o.y = I.y0 + 1 + R() * (I.y1 - I.y0 - 2);
          return true;
        }
        case 'drift': {      // drift parkı iç alanı (araç)
          if (!G.drift) return false;
          I = G.drift.inner;
          o.x = I.x0 + 14 + R() * (I.x1 - I.x0 - 28); o.y = I.y0 + 14 + R() * (I.y1 - I.y0 - 28);
          return true;
        }
        case 'driftEdge': {  // drift parkı bariyerlerinin iç dibi
          if (!G.drift) return false;
          I = G.drift.inner;
          const sd = (R() * 4) | 0, off = 1.8 + R() * 0.8;
          const len = sd & 1 ? I.y1 - I.y0 : I.x1 - I.x0, s = 3 + R() * (len - 6);
          if (sd === 0) { o.x = I.x0 + s; o.y = I.y0 + off; }
          else if (sd === 1) { o.x = I.x1 - off; o.y = I.y0 + s; }
          else if (sd === 2) { o.x = I.x0 + s; o.y = I.y1 - off; }
          else { o.x = I.x0 + off; o.y = I.y0 + s; }
          return true;
        }
      }
      return false;
    }

    // yürünebilir, yolda değil, r içinde engel yok (statik), özel yerlerden uzak (erişim: _reach)
    _valid(x, y, r, G) {
      const nav = this.nav, city = this.city;
      if (!(x === x && y === y)) return false;
      if (!nav.walkable(x, y)) return false;
      if (nav.surf(x, y) & 4) return false;
      if (nav.zoneAt(x, y) === 'road') return false;
      if (!this._free(x, y, r, G)) return false;
      if (city.blocked(x, y, Math.min(r, 0.6))) return false;
      for (let i = 0; i < G.ex.length; i++) { const dx = G.ex[i] - x, dy = G.ey[i] - y; if (dx * dx + dy * dy < EXCL2) return false; }
      return true;
    }
    _free(x, y, r, G) {
      const q = G.q;
      q.x = x; q.y = y; q.r = r; q.hit = false;
      this.city.query(x - r, y - r, x + r, y + r, G.qfn);
      if (q.hit) return false;
      for (let i = 0; i < G.gone.length; i++) { const b = G.gone[i]; if (U.distPointBox(x, y, b.x0, b.y0, b.x1, b.y1) < r) return false; }
      return true;
    }
    // dört ana yönden birinde engelsiz (0,35 m) bir hat kaldırıma/yola ulaşıyor mu (kapalı cep olmasın)
    _reach(x, y, G) {
      const nav = this.nav, s0 = nav.surf(x, y);
      if (s0 & 12) return true;             // zaten kaldırımda
      if (s0 & 32) return true;             // drift parkı: kapılardan erişilir
      for (let d = 0; d < 4; d++) {
        const dx = d === 0 ? 1 : d === 1 ? -1 : 0, dy = d === 2 ? 1 : d === 3 ? -1 : 0;
        for (let k = 1; k <= 120; k++) {
          const px = x + dx * k * 0.5, py = y + dy * k * 0.5, s = nav.surf(px, py);
          if (s & 2) break;
          if ((k & 3) === 0 && !this._free(px, py, 0.35, G)) break;   // 2 m'de bir kesin denetim (0,7 m bina araları)
          if (s & 12) return true;
        }
      }
      return false;
    }
    // ağaç tacının altında mı (normal eşyalar görünür kalsın; paketler en fazla yarı gizli)
    _underTree(x, y, G, kr, add) {
      for (let i = 0; i < G.tx.length; i++) {
        const dx = G.tx[i] - x, dy = G.ty[i] - y, rr = G.tr[i] * kr + add;
        if (dx * dx + dy * dy < rr * rr) return true;
      }
      return false;
    }

    // ================= YAŞAM DÖNGÜSÜ =================
    // tüm normal eşyalar yerinde; zamanlayıcılar sıfır (paket durumu load ile gelir)
    reset() {
      this.t = 0;
      this.due.fill(0);
      this.armed.fill(1);
      this.rearm.fill(0);
      this._nnr = 0; this._nnp = 0;
      this._scanT = 0;
      this._has = false;
    }
    // canlı save.ow: ow.pickups = { got: '<base36>', card: 0|1 } (yoksa/bozuksa onarılır)
    load(ow) {
      let p = ow && typeof ow === 'object' ? ow.pickups : null;
      if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
      decodeBits(p.got, this.got);
      for (let j = 0; j < TOTAL; j++) if (!(this.px[j] === this.px[j])) this.got[j] = 0;
      p.got = encodeBits(this.got, TOTAL);
      p.card = p.card === 1 || p.card === true || p.card === '1' ? 1 : 0;
      if (ow && typeof ow === 'object') ow.pickups = p;
      this.st = p;
      this.ow = ow && typeof ow === 'object' ? ow : null;
      this._count();
      this._nnp = 0; this._scanT = 0;
    }
    save(ow) {
      if (!ow || typeof ow !== 'object') return ow;
      const st = this.st;
      st.got = encodeBits(this.got, TOTAL);
      if (ow.pickups !== st) ow.pickups = { got: st.got, card: st.card ? 1 : 0 };
      return ow;
    }
    setQuality(Q) {
      if (Q) this.Q = Q;
      const q = this.Q;
      this.glow = q && typeof q.pickupsGlow === 'boolean' ? q.pickupsGlow : !!(q && (q.tier | 0) >= 1);
    }
    _count() {
      let n = 0;
      for (let j = 0; j < TOTAL; j++) if (this.got[j]) n++;
      this.nGot = n;
      this._cnt.packages = n;
      this._cnt.total = TOTAL;
    }
    count() { return this._cnt; }
    hasCard() { return !!(this.st && this.st.card); }
    // dünya onBusted'da çağırabilir: kart varsa harcar ve true döner
    useCard() {
      if (!this.st || !this.st.card) return false;
      this.st.card = 0;
      return true;
    }

    // ================= GÜNCELLEME =================
    update(dt, W) {
      W = W || this.W;
      if (!W || (this.n === 0 && this.np === 0)) return;
      if (!(dt > 0)) dt = 0;
      else if (dt > 0.25) dt = 0.25;
      this.t += dt;
      const x = W.px, y = W.py;
      if (!(x === x && y === y)) return;
      const wd = W.world;
      const st = wd && typeof wd.state === 'string' ? wd.state : W.inCar ? 'car' : 'foot';
      let jump = !this._has;
      if (!jump) { const jx = x - this._ox, jy = y - this._oy; jump = jx * jx + jy * jy > JUMP2; }
      // not: ondalıklı sayılar satır içi olmayan çağrılara argüman olarak geçmez (kutulama = tahsis)
      this._qx = x; this._qy = y;
      this._scanT -= dt;
      if (this._scanT <= 0 || jump) { this._scanT = SCAN_T; this._scan(W); }
      if (st === 'foot' || st === 'car') {
        const inCar = st === 'car';
        const ox = jump ? x : this._ox, oy = jump ? y : this._oy;
        const sx = x - ox, sy = y - oy, L2 = sx * sx + sy * sy, iL2 = L2 > 1e-8 ? 1 / L2 : 0;
        // normal eşyalar (yakın liste); uzaklık = son kare yolu [o, o+s] parçasına (hızlı araç kaçırmasın)
        const R = inCar ? R_CAR : R_FOOT, R2 = R * R, RO = R + REARM_OUT, RO2 = RO * RO;
        for (let k = 0; k < this._nnr; k++) {
          const i = this._nr[k];
          if (this.due[i] !== 0) continue;
          const d = KINDS[this.rk[i]];
          if (inCar ? !d.car : !d.foot) continue;
          const qx = this.rx[i] - ox, qy = this.ry[i] - oy;
          let u = (qx * sx + qy * sy) * iL2;
          if (u < 0) u = 0; else if (u > 1) u = 1;
          const ex = sx * u - qx, ey = sy * u - qy, d2 = ex * ex + ey * ey;
          if (!this.armed[i]) {
            if (d2 > RO2 || this.t >= this.rearm[i]) this.armed[i] = 1;
            else continue;
          }
          if (d2 <= R2) this._take(i, W);
        }
        // gizli paketler
        const RP = inCar ? RP_CAR : RP_FOOT, RP2 = RP * RP;
        for (let k = 0; k < this._nnp; k++) {
          const j = this._npk[k];
          if (this.got[j]) continue;
          const qx = this.px[j] - ox, qy = this.py[j] - oy;
          let u = (qx * sx + qy * sy) * iL2;
          if (u < 0) u = 0; else if (u > 1) u = 1;
          const ex = sx * u - qx, ey = sy * u - qy;
          if (ex * ex + ey * ey <= RP2) this._takePkg(j, W);
        }
      }
      this._ox = x; this._oy = y; this._has = true;
    }
    // tam tarama (0,25 s'de bir ya da ışınlanmada): yakın listeler, yeniden doğma, yeniden kurma
    _scan(W) {
      const t = this.t, x = this._qx, y = this._qy;
      let m = 0;
      for (let i = 0; i < this.n; i++) {
        const dx = this.rx[i] - x, dy = this.ry[i] - y, d2 = dx * dx + dy * dy;
        if (this.due[i] !== 0 && t >= this.due[i]) {
          // görünürken birden belirmesin (en fazla VIS_WAIT s ertelenir)
          const vis = W.isVisible ? W.isVisible(this.rx[i], this.ry[i], 2) : false;
          if (!vis || t >= this.due[i] + VIS_WAIT) { this.due[i] = 0; this.armed[i] = 1; }
        }
        if (!this.armed[i] && d2 > NEAR2) this.armed[i] = 1;
        if (d2 < NEAR2) this._nr[m++] = i;
      }
      this._nnr = m;
      m = 0;
      for (let j = 0; j < this.np; j++) {
        if (this.got[j]) continue;
        const dx = this.px[j] - x, dy = this.py[j] - y;
        if (dx * dx + dy * dy < NEAR2) this._npk[m++] = j;
      }
      this._nnp = m;
    }
    // normal eşya alındı: etkiyi dünya uygular (para çantası burada)
    _take(i, W) {
      const k = this.rk[i], d = KINDS[k], wd = W.world, x = this.rx[i], y = this.ry[i];
      if (k === CASH) {
        const a = 100 + 10 * ((Math.random() * 31) | 0);   // ₺100–400
        if (wd && typeof wd.reward === 'function') { try { wd.reward(a, 'PARA ÇANTASI'); } catch (e) { console.error(e); } }
        emit(wd, 'cash', a, x, y);
      } else {
        let ok = false;
        // kefalet kartı: en fazla bir tane taşınır
        if (!(k === CARD && this.st && this.st.card) && wd && typeof wd.onPickup === 'function') {
          try { ok = wd.onPickup(d.id, d.val, x, y) === true; } catch (e) { console.error(e); ok = false; }
        }
        if (!ok) { this.armed[i] = 0; this.rearm[i] = this.t + REARM_T; return; }
        if (k === CARD && this.st) this.st.card = 1;
      }
      this.due[i] = this.t + d.resp;
    }
    // gizli paket: +₺100, her 10'da ikramiye, 50/50'de büyük ödül
    _takePkg(j, W) {
      this.got[j] = 1;
      this._count();
      if (this.st) this.st.got = encodeBits(this.got, TOTAL);
      const n = this.nGot, wd = W.world, x = this.px[j], y = this.py[j];
      emit(wd, 'package', n, x, y);
      if (!wd) return;
      const msg = typeof wd.msg === 'function' ? wd.msg.bind(wd) : null;
      const pay = (a, why) => { if (typeof wd.reward === 'function') { try { wd.reward(a, why); } catch (e) { console.error(e); } } };
      try {
        if (n >= TOTAL) {
          if (msg) msg('TÜM PAKETLER!', 'big', TOTAL + '/' + TOTAL + ' · +₺' + U.fmt(PKG_ALL));
          pay(PKG_CASH, 'Gizli paket');
          pay(PKG_ALL, 'TÜM PAKETLER');
        } else if (n % 10 === 0) {
          const b = PKG_STEP * (n / 10);
          if (msg) msg(n + ' PAKET!', 'big', '+₺' + U.fmt(b));
          pay(PKG_CASH, 'Gizli paket');
          pay(b, n + ' PAKET İKRAMİYESİ');
        } else {
          if (msg) msg('GİZLİ PAKET ' + n + '/' + TOTAL, 'good', '');
          pay(PKG_CASH, 'Gizli paket');
        }
      } catch (e) { console.error(e); }
    }

    // ================= ÇİZİM =================
    _ensureIcons() {
      if (this._icons) return true;
      try {
        const ic = [];
        for (let k = 0; k < KINDS.length; k++) for (let f = 0; f < FRAMES; f++) ic.push(bakeIcon(k, f));
        const gl = [];
        for (let k = 0; k < KINDS.length; k++) gl.push(bakeGlow(KINDS[k].glow));
        this._crate = bakeCrate();
        this._glows = gl;
        this._icons = ic;
      } catch (e) {
        console.error(e);
        this._icons = null;
        return false;
      }
      return true;
    }
    // zemin katmanı (world.drawGround): ekran uzayında tamsayı konumlu tek drawImage; ctx M'de bırakılır
    drawGround(ctx, W) {
      W = W || this.W;
      if (!ctx || !W || !W.M || !W.view) return;
      if (!this._icons && !this._ensureIcons()) return;
      const M = W.M, v = W.view, t = this.t;
      const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5];
      const z = Math.sqrt(m0 * m0 + m1 * m1);
      const x0 = v.x0 - 1.5, y0 = v.y0 - 1.5, x1 = v.x1 + 1.5, y1 = v.y1 + 1.5;
      let drew = false;
      // gizli paketler (küçük, parlamasız, animasyonsuz)
      const wp = (PKG_M * z + 0.5) | 0;
      if (wp >= 2) {
        const img = this._crate, h = wp * 0.5;
        for (let j = 0; j < this.np; j++) {
          if (this.got[j]) continue;
          const x = this.px[j], y = this.py[j];
          if (!(x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue;
          if (!drew) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; drew = true; }
          const sx = m0 * x + m2 * y + m4, sy = m1 * x + m3 * y + m5;
          ctx.drawImage(img, (sx - h + 0.5) | 0, (sy - h + 0.5) | 0, wp, wp);
        }
      }
      // normal eşyalar: nabız (ölçek) + dönen parıltı karesi
      const base = SPR_M * z, fr0 = (t * 4) | 0;
      if (base >= 3) {
        const ic = this._icons;
        for (let i = 0; i < this.n; i++) {
          if (this.due[i] !== 0) continue;
          const x = this.rx[i], y = this.ry[i];
          if (!(x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue;
          if (!drew) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; drew = true; }
          const w = (base * (1 + 0.07 * Math.sin(t * 2.6 + i * 1.9)) + 0.5) | 0, h = w * 0.5;
          const sx = m0 * x + m2 * y + m4, sy = m1 * x + m3 * y + m5;
          ctx.drawImage(ic[this.rk[i] * FRAMES + ((fr0 + i) & 3)], (sx - h + 0.5) | 0, (sy - h + 0.5) | 0, w, w);
        }
      }
      if (drew) ctx.setTransform(m0, m1, m2, m3, m4, m5);
    }
    // ışık haritası (gece, Q.pickupsGlow): görünen normal eşyalara küçük renkli parlama; lctx M·lightScale'de
    drawLights(lctx, W) {
      W = W || this.W;
      if (!this.glow || !lctx || !W || !W.view) return;
      if (!this._icons && !this._ensureIcons()) return;
      const v = W.view, t = this.t, gl = this._glows, r = GLOW_M, d = r * 2;
      let any = false;
      for (let i = 0; i < this.n; i++) {
        if (this.due[i] !== 0) continue;
        const x = this.rx[i], y = this.ry[i];
        if (!(x >= v.x0 - r && x <= v.x1 + r && y >= v.y0 - r && y <= v.y1 + r)) continue;
        lctx.globalAlpha = 0.6 + 0.15 * Math.sin(t * 2.6 + i * 1.9);
        lctx.drawImage(gl[this.rk[i]], x - r, y - r, d, d);
        any = true;
      }
      if (any) lctx.globalAlpha = 1;
    }

    // ================= HARİTA =================
    // mini harita: 120 m içindeki normal eşyalar (11 can, 12 zırh, 13 rüşvet, 14 diğer); paketler yok
    blips(out, n) {
      n = n | 0;
      const W = this.W;
      if (!out || !W) return n;
      const x = W.px, y = W.py;
      for (let i = 0; i < this.n && n < 64; i++) {
        if (this.due[i] !== 0) continue;
        const dx = this.rx[i] - x, dy = this.ry[i] - y;
        if (dx * dx + dy * dy > BLIP_R2) continue;
        let b = out[n];
        if (!b) b = out[n] = { x: 0, y: 0, k: 0 };
        b.x = this.rx[i]; b.y = this.ry[i]; b.k = KINDS[this.rk[i]].blip;
        n++;
      }
      return n;
    }
    // tam harita: yerinde olan normal eşyalar
    mapPois(out) {
      out = out || [];
      for (let i = 0; i < this.n; i++) {
        if (this.due[i] !== 0) continue;
        const d = KINDS[this.rk[i]];
        out.push({ x: this.rx[i], y: this.ry[i], k: d.blip, name: d.name });
      }
      return out;
    }

    // ================= TEST / HATA AYIKLAMA =================
    list() {
      const a = [];
      for (let i = 0; i < this.n; i++) a.push({ i, kind: KINDS[this.rk[i]].id, cat: this.rc[i], x: this.rx[i], y: this.ry[i], present: this.due[i] === 0 });
      return a;
    }
    packages() {
      const a = [];
      for (let j = 0; j < this.np; j++) a.push({ j, cat: this.pc[j], x: this.px[j], y: this.py[j], got: !!this.got[j] });
      return a;
    }
  }

  // ses vb. için dünyaya bildir (para/paket: dönüş değeri yok sayılır)
  function emit(wd, kind, value, x, y) {
    if (!wd || typeof wd.onPickup !== 'function') return;
    try { wd.onPickup(kind, value, x, y); } catch (e) { console.error(e); }
  }

  Pickups.TOTAL = TOTAL;
  Pickups.KINDS = KINDS;
  Pickups.encodeBits = encodeBits;
  Pickups.decodeBits = decodeBits;
  DS.Pickups = Pickups;
})();
