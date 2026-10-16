'use strict';
// Prosedürel araç radyosu (tur 2, paket C): 4 müzik istasyonu + "Kapalı".
// Her istasyon tohumlu bir desen üretecidir: şarkı biçimi (giriş / kıta / nakarat / ara), 4–8 ölçülük bölümler,
// her bölümde yeniden seçilen davul / bas / arpej / akor desenleri ve değişen melodi; her şarkıda yeni ton ve
// akor yürüyüşü. Böylece yaklaşık 2 dakika boyunca birebir tekrar etmez.
// Zamanlama "iki saat" yöntemiyle: update() her karede çağrılır ve ses saatine (ctx.currentTime) göre en fazla
// ~120 ms ileriye nota yerleştirir (zamanlanmış nota geri alınamaz; pencere kısa tutulur).
// İşlemci (zayıf PC): Web Audio düğümü üretmek pahalıdır (osilatör + kazanç ≈ 20–30 µs), otomasyon olayı ucuzdur
// (≈ 0.4 µs). Bu yüzden melodik parçalar (bas, melodi, arpej, akor, uzun akor/dem) istasyon oturumu boyunca çalan
// kalıcı seslerdir; nota = yalnız frekans + kazanç zarfı olayları. Davul takımı bir kez (OfflineAudioContext ile
// ayrı iş parçacığında; yoksa JS ile parça parça) pişirilir; her vuruşun (4 adım) davulları JS ile tek tampona
// karıştırılıp desen değişene kadar önbellekte tutulur: vuruş başına tek kaynak düğümü. Eşzamanlı ses sayısı
// kademeye göre ≤ 6 / 8 / 10 / 12, biten düğümler onended ile ayrılır; istasyon değişince eski oturumun tüm ağacı
// kısılıp durdurulur ve koparılır.
// audio.init() öncesi tüm yöntemler güvenle çağrılabilir (ses bağlamı oluşana kadar yalnız durum saklanır).
// audio.silence() çağrıldığında (duraklat / menü / sonuç) radyo da susar (örneğe küçük bir kanca takılır).
(function () {
  const DS = window.DS, U = DS.U;

  const LOOK = 0.11;          // ileri zamanlama penceresi (s); lo-fi insanileştirme ≤ 10 ms ekler (≤ 120 ms)
  const LEVEL = 0.55;         // radyonun ana karışımdaki temel seviyesi (ayar sesiyle çarpılır)
  const FADE_IN = 0.6, FADE_OUT = 0.4;
  const STATIC_T = 0.3;       // istasyon değiştirirken cızırtı süresi
  const NONE = -100;          // melodi dizisinde boş adım
  const MAXV = 12;            // eşzamanlı ses üst sınırı (radioVoices en çok)

  // ---- istasyonlar ----
  const SYN = 0, HOU = 1, LOF = 2, SAZ = 3;
  const STATIONS = [
    { id: 'drift', name: 'Drift FM', bpm: 100, swing: 0, seed: 1986, style: SYN },
    { id: 'sokak', name: 'Sokak Beat', bpm: 124, swing: 0.06, seed: 2424, style: HOU },
    { id: 'lofi', name: 'Lo-Fi Gece', bpm: 82, swing: 0.3, seed: 8282, style: LOF },
    { id: 'saz', name: 'Saz Wave', bpm: 96, swing: 0, seed: 1453, style: SAZ },
    { id: 'off', name: 'Kapalı', off: true },
  ];

  // MIDI -> Hz (tam sayı notalar tablodan, makam aralıkları için kesirli notalar Math.pow ile)
  const MTOF = new Float32Array(128);
  for (let i = 0; i < 128; i++) MTOF[i] = 440 * Math.pow(2, (i - 69) / 12);
  function mtof(m) {
    const i = m | 0;
    return i === m && i >= 0 && i < 128 ? MTOF[i] : 440 * Math.pow(2, (m - 69) / 12);
  }

  // ---- diziler (yarım ses; makamlar 53 koma sisteminden yaklaşık kesirli değerler) ----
  const SC_MIN = [0, 2, 3, 5, 7, 8, 10];
  const SC_DOR = [0, 2, 3, 5, 7, 9, 10];
  const SC_MINP = [0, 3, 5, 7, 10];
  const SC_MAJ = [0, 2, 4, 5, 7, 9, 11];
  const SC_MAJP = [0, 2, 4, 7, 9];
  // Hicaz: dügâhta hicaz dörtlüsü (5+12+5 koma) + nevada rast beşlisi: La Si♭ Do# Re Mi Fa#(−) Sol
  const SC_HICAZ = [0, 1.13, 3.85, 4.98, 7.02, 8.83, 9.96];
  // Hümayun renkli hicaz: üstte buselik (Fa doğal)
  const SC_HUMA = [0, 1.13, 3.85, 4.98, 7.02, 7.92, 9.96];
  // Uşşak: segâh dügâhın ~165 sent üstü (si koma bemol), üstte buselik beşlisi
  const SC_USSAK = [0, 1.65, 2.94, 4.98, 7.02, 7.92, 9.96];

  // ---- akorlar ----
  const Q_M = 0, Q_MAJ = 1, Q_M7 = 2, Q_MAJ7 = 3, Q_D7 = 4, Q_M9 = 5, Q_MAJ9 = 6, Q_SUS = 7, Q_5 = 8, Q_OCT = 9;
  // seslendirme (öncelik sırası: az ses varsa yalnız ilk notalar çalar; 7'li akorlarda kök basta, üstte 3-7 kabuğu)
  const VOICE = [
    [0, 3, 7, 12], [0, 4, 7, 12], [3, 10, 7, 14], [4, 11, 7, 14], [4, 10, 7, 14],
    [3, 10, 14, 7], [4, 11, 14, 7], [5, 10, 7, 14], [0, 7, 12, 19], [0, 12, 24, 19],
  ];
  // arpej tonları (artan)
  const ARP = [
    [0, 3, 7], [0, 4, 7], [0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 10],
    [0, 3, 7, 10, 14], [0, 4, 7, 11, 14], [0, 5, 7, 10], [0, 7], [0, 12],
  ];
  // akor yürüyüşleri: [kök, tür, kök, tür, ...] (SYN/HOU minör ton, LOF majör ton, SAZ dizi derecesi)
  const PROGS = [
    [[0, Q_M, 8, Q_MAJ, 3, Q_MAJ, 10, Q_MAJ], [0, Q_M, 10, Q_MAJ, 8, Q_MAJ, 10, Q_MAJ], [0, Q_M, 5, Q_M, 8, Q_MAJ, 7, Q_MAJ],
      [8, Q_MAJ, 10, Q_MAJ, 0, Q_M, 0, Q_M], [0, Q_M, 8, Q_MAJ, 5, Q_M, 10, Q_MAJ], [0, Q_M, 3, Q_MAJ, 10, Q_MAJ, 8, Q_MAJ],
      [5, Q_M, 8, Q_MAJ, 10, Q_MAJ, 0, Q_M]],
    [[0, Q_M7, 5, Q_M7], [0, Q_M7, 8, Q_MAJ7, 10, Q_D7, 0, Q_M7], [0, Q_M9, 10, Q_SUS], [0, Q_M7, 3, Q_MAJ7, 5, Q_M7, 3, Q_MAJ7],
      [8, Q_MAJ7, 10, Q_MAJ, 0, Q_M7, 0, Q_M7], [0, Q_M9, 5, Q_M7, 3, Q_MAJ7, 10, Q_SUS]],
    [[2, Q_M9, 7, Q_D7, 0, Q_MAJ9, 9, Q_M9], [0, Q_MAJ7, 9, Q_M7, 2, Q_M7, 7, Q_D7], [5, Q_MAJ7, 4, Q_M7, 2, Q_M7, 0, Q_MAJ7],
      [9, Q_M7, 7, Q_SUS, 0, Q_MAJ7, 5, Q_MAJ7], [5, Q_MAJ9, 4, Q_D7, 9, Q_M9, 9, Q_M9], [2, Q_M9, 7, Q_D7, 4, Q_M7, 9, Q_M9],
      [0, Q_MAJ9, 5, Q_MAJ9]],
    // SAZ: derece (0 durak, 1 ikinci derece, 3 güçlü, 5/6 üst dereceler); dem sesi kök + beşli / oktav
    [[0, 0, 0, 0, 1, 0, 0, 0], [0, 0, 3, 0, 1, 0, 0, 0], [0, 0, 6, 0, 0, 0, 1, 0], [3, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 6, 0, 1, 0]],
  ];
  const PROGS_USSAK = [[0, 0, 0, 0, 6, 0, 0, 0], [0, 0, 3, 0, 6, 0, 0, 0], [0, 0, 5, 0, 6, 0, 0, 0], [3, 0, 0, 0, 6, 0, 0, 0]];
  const KEYS = [[57, 54, 52, 55, 59], [57, 53, 55, 52, 56], [60, 62, 63, 65, 58], [57, 50, 52, 55]];

  // ---- katmanlar ----
  const LK = 1, LS = 2, LH = 4, LB = 8, LA = 16, LP = 32, LL = 64, LX = 128;
  // bölüm türü: 0 giriş, 1 kıta, 2 nakarat, 3 ara
  const LAY = [
    [LA | LP, LK | LS | LH | LB | LA, LK | LS | LH | LB | LA | LP | LL, LP | LA | LL],
    [LK | LH, LK | LS | LH | LB, LK | LS | LH | LB | LA | LL, LA | LP | LH],
    [LA | LX, LK | LS | LH | LB | LA | LX, LK | LS | LH | LB | LA | LL | LX, LA | LB | LL | LX],
    [LP | LL, LX | LB | LP | LL, LK | LS | LH | LX | LB | LL, LX | LP | LL],
  ];
  const BUILD = [LB | LH, LB | LS, LK | LH | LB, LX];     // girişin ikinci yarısında eklenenler
  const OPTL = [LH | LP | LA, LH | LL | LB, LH | LL | LB, LH | LP | LB]; // bölüm çeşitlemesinde düşebilenler
  const FORMS = [[0, 1, 2, 1, 2, 3, 2], [0, 1, 1, 2, 3, 2], [0, 2, 1, 2, 3, 1, 2], [1, 2, 3, 1, 2, 2], [0, 1, 2, 3, 2, 2]];
  const SBARS = [[4, 8], [8, 4], [8, 8], [4, 4]];

  // ---- desenler (16 adım; '.' boş, x normal, X vurgulu, o oktav, f beşli, a yaklaşma, D düm, T tek, k ka) ----
  const PK = [
    ['x.......x.......', 'x.......x.x.....', 'x...x...x...x...', 'x.......x......x', 'x......xx.......'],
    ['x...x...x...x...', 'x...x...x...x...', 'x...x...x...x..x'],
    ['x......x..x.....', 'x.........x.....', 'x......x.x......', 'x.x.......x.....', 'x..x......x..x..'],
    ['x.......x.......', 'x...x...x...x...', 'x.....x.x.......'],
  ];
  const PS = [
    ['....x.......x...', '....x.......x...', '....x.......x..x'],
    ['....x.......x...', '....x.......x..x', '....x..x....x...'],
    ['....x.......x...', '....x.......x.k.', '....x..k....x...', '....x.......x..k'],
    ['....x.......x...', '....x.......x.x.'],
  ];
  const PH = [
    ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.', '..x...x...x.x.x.', 'X.x.X.x.X.x.X.x.'],
    ['xxXxxxXxxxXxxxXx', 'x.x.x.x.x.x.x.x.', '.xx..xx..xx..xx.', 'xxxxxxxxxxxxxxxx'],
    ['X.xxX.x.X.xxX.x.', 'X.x.X.x.X.x.X.xx', 'X.xxX.xxX.xxX.xx', 'x.x.x.x.x.x.x.x.'],
    ['..x...x...x...x.', 'x.xxx.xxx.xxx.xx', '..X...X...X...X.'],
  ];
  const POH = ['..x...x...x...x.', '..x...x...x...xx', '..x...x...x.....', '......x.......x.'];
  const PB = [
    ['x.x.x.x.x.x.x.x.', 'x.o.x.o.x.o.x.o.', 'x.xxx.xxx.xxx.xx', 'xxxxxxxxxxxxxxxx', 'x..x..x.x..x..x.', 'x.x.o.x.x.x.o.xo'],
    ['..x...x...x...x.', '..x..x.x..x...x.', '..o...x...o...x.', 'x..x..x...x..x..', '..x.x...x.x..f..'],
    ['x.........x.....', 'x.......f.....a.', 'x.....x...x...a.', 'x.........f..a..', 'x..........x..a.'],
    ['x.......x.......', 'x..x....x..x....', 'x.....x.x.......', 'x.x.x.x.x.x.x.x.', 'x.o.x.o.x.o.x.o.'],
  ];
  const PARP = ['0123', '0213', '01234321', '3210', '0242', '01231234', '0.12.3.2', '0123454321'];
  const PSTAB = ['...x......x.....', '..x....x..x.....', 'x..x..x...x..x..', '...x..x....x..x.', '..x.......x...x.', '.x...x...x...x..'];
  const PKEYS = ['x...............', 'x.......x.......', 'x.....x.........', 'x..........x....', 'x.......x.....x.'];
  const PDARB = ['D.T...T.D...T...', 'D.D...T.D...T...', 'D.T...D.D...T...', 'D...T.T.D...T...', 'D.TkT.TkD.TkT.k.', 'D.kTk.TkD.kTk.Tk'];
  const FILL_D = 'TkTkTkTk';

  const C_X = 1, C_XX = 2, C_O = 3, C_F = 4, C_A = 5, C_D = 6, C_T = 7, C_K = 8;
  const CODE = new Uint8Array(128);
  CODE[120] = C_X; CODE[88] = C_XX; CODE[111] = C_O; CODE[102] = C_F; CODE[97] = C_A;
  CODE[68] = C_D; CODE[84] = C_T; CODE[107] = C_K;
  const FILLC = new Uint8Array(8);
  for (let i = 0; i < 8; i++) FILLC[i] = CODE[FILL_D.charCodeAt(i)];

  // melodi üreteci ayarları (süreler 16'lık adım cinsinden; lo/hi dizi derecesi; mid: ilk ölçü sonu hedefi)
  const LEADC = [
    { durs: [2, 2, 4, 2, 1, 1, 3, 6], rest: 0.18, lo: -2, hi: 9, mid: 4 },
    { durs: [1, 1, 2, 1, 2, 3], rest: 0.35, lo: 0, hi: 7, mid: 2 },
    { durs: [2, 3, 4, 6, 8, 2], rest: 0.45, lo: 0, hi: 8, mid: 4 },
    { durs: [2, 2, 1, 1, 2, 4, 3, 2], rest: 0.1, lo: -2, hi: 9, mid: 3 },
  ];
  const TAKSIM = { durs: [4, 6, 8, 4, 3], rest: 0.15, lo: -1, hi: 8, mid: 3 };

  // karışım: davul kanalı kazancı, bas/akor/melodi süzgeçleri, ses çarpanları, efekt gönderimi, yankı adımı
  const MIX = [
    { d: 0.56, bf: 800, hf: 2600, hq: 1, lf: 3200, vb: 1, vh: 1, vl: 1, fx: 0.32, ds: 3 },
    { d: 0.42, bf: 520, hf: 2200, hq: 2.5, lf: 2600, vb: 1, vh: 1, vl: 1, fx: 0.22, ds: 3 },
    { d: 0.45, bf: 420, hf: 1900, hq: 0.7, lf: 2400, vb: 1, vh: 1, vl: 1, fx: 0.28, ds: 4 },
    { d: 0.55, bf: 650, hf: 1100, hq: 0.7, lf: 3800, vb: 1, vh: 1, vl: 1, fx: 0.26, ds: 3 },
  ];

  // dalga türleri (4+ = PeriodicWave)
  const W_SINE = 0, W_TRI = 1, W_SQ = 2, W_SAW = 3, W_EP = 4, W_SAZ = 5;
  const TYPES = ['sine', 'triangle', 'square', 'sawtooth'];

  // ---- pişirilmiş davul takımı ----
  const K_KICK = 0, K_HAT = 1, K_HATS = 2, K_SNR = 3, K_GSN = 4, K_CLAP = 5, K_OHAT = 6, K_DUM = 7, K_TEK = 8, K_KA = 9, K_RIM = 10, K_CRK = 11;
  const KIT_N = 12;
  const KIT_LEN = [0.3, 0.05, 0.05, 0.24, 0.36, 0.24, 0.26, 0.42, 0.14, 0.1, 0.05, 1.2];

  // Davul takımı parça parça pişirilir (karede en fazla ~1400 örnek): üstel sönümler çarpımla, sabit sinüsler
  // özyinelemeli osilatörle (Math.exp / Math.sin yok), yalnız perdesi kayan davul ve düm Math.sin kullanır.
  // Ziller oyun örnekleme hızında, diğerleri 22.05 kHz'de (yarı maliyet; çalınırken yeniden örneklenir).
  const KIT_SR = 22050;
  function bakeBegin(c, id) {
    const hat = id === K_HAT || id === K_HATS || id === K_OHAT;
    const want = hat ? c.sampleRate : KIT_SR;
    let buf;
    try { buf = c.createBuffer(1, Math.max(32, Math.ceil(KIT_LEN[id] * want)), want); } catch (e) {
      buf = c.createBuffer(1, Math.max(32, Math.ceil(KIT_LEN[id] * c.sampleRate)), c.sampleRate);
    }
    const sr = buf.sampleRate;
    const B = {
      id, i: 0, n: buf.length, sr, buf, d: buf.getChannelData(0), s: (12345 + id * 7919) >>> 0, g: 1,
      p1: 0, p2: 0, hp: 0, prev: 0, lp: 0, lp2: 0, e1: 1, e2: 1, e3: 1, e4: 1, k1: 0, k2: 0, k3: 0, k4: 0,
      a1: 0, b1: 0, c1: 0, a2: 0, b2: 0, c2: 0, a3: 0, b3: 0, c3: 0, bl: 1, tl: 0,
    };
    const dk = (tau) => Math.exp(-1 / (sr * tau));
    const res = (k, f) => { const w = (Math.PI * 2 * f) / sr; B['c' + k] = 2 * Math.cos(w); B['a' + k] = -Math.sin(w); B['b' + k] = 0; };
    switch (id) {
      case K_KICK: B.k1 = dk(0.028); B.k2 = dk(0.11); B.k3 = dk(0.0015); break;
      case K_HAT: B.k1 = dk(0.011); B.g = 0.55; break;
      case K_HATS: B.k1 = dk(0.011); B.g = 0.24; break;
      case K_OHAT: B.k1 = dk(0.07); B.g = 0.38; break;
      case K_SNR: case K_GSN: B.k1 = dk(0.045); B.k2 = dk(0.055); B.k3 = dk(0.5); res(1, 180); res(2, 330); break;
      case K_CLAP: B.k1 = dk(0.004); B.k2 = dk(0.07); B.bl = Math.max(1, Math.round(0.011 * sr)); B.tl = Math.round(0.032 * sr); break;
      case K_DUM: B.k1 = dk(0.03); B.k2 = dk(0.17); B.k3 = dk(0.05); B.k4 = dk(0.004); break;
      case K_TEK: B.k1 = dk(0.032); B.k2 = dk(0.008); B.g = 0.75; res(1, 620); res(2, 1460); res(3, 2380); break;
      case K_KA: B.k1 = dk(0.022); B.k2 = dk(0.008); B.g = 0.42; res(1, 700); res(2, 1650); res(3, 2380); break;
      case K_RIM: B.k1 = dk(0.007); B.k2 = dk(0.004); res(1, 1750); break;
      default: break;
    }
    return B;
  }
  // en fazla max örnek hesapla; parça bitince true
  function bakeRun(B, max) {
    const d = B.d, n = B.n, sr = B.sr, id = B.id, w0 = (Math.PI * 2) / sr, g = B.g;
    const k1 = B.k1, k2 = B.k2, k3 = B.k3, k4 = B.k4, c1 = B.c1, c2 = B.c2, c3 = B.c3;
    let i = B.i, s = B.s, hp = B.hp, prev = B.prev, lp = B.lp, lp2 = B.lp2, p1 = B.p1, p2 = B.p2;
    let e1 = B.e1, e2 = B.e2, e3 = B.e3, e4 = B.e4, a1 = B.a1, b1 = B.b1, a2 = B.a2, b2 = B.b2, a3 = B.a3, b3 = B.b3;
    const end = Math.min(n, i + max);
    for (; i < end; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const nz = s / 2147483648 - 1;
      let x = 0, y;
      switch (id) {
        case K_KICK:
          p1 += w0 * (48 + 120 * e1); e1 *= k1;
          x = Math.sin(p1) * e2 + nz * 0.25 * e3; e2 *= k2; e3 *= k3;
          x *= 1.6; x = (x / (1 + (x < 0 ? -x : x))) * 1.05;
          break;
        case K_HAT: case K_HATS: case K_OHAT: {
          hp = 0.6 * (hp + nz - prev); prev = nz;
          // metalik renk: iki uyumsuz kare dalga (808 tarzı)
          p1 += 5430 / sr; p2 += 7920 / sr;
          const m = (p1 - (p1 | 0) < 0.5 ? 0.25 : -0.25) + (p2 - (p2 | 0) < 0.5 ? 0.2 : -0.2);
          x = (hp * 0.8 + m * 0.35) * e1 * g; e1 *= k1;
          break;
        }
        case K_SNR: case K_GSN:
          hp = 0.7 * (hp + nz - prev); prev = nz;
          x = (b1 + 0.6 * b2) * e1 * 0.35 + hp * e2 * 0.65; e1 *= k1; e2 *= k2;
          y = c1 * b1 - a1; a1 = b1; b1 = y;
          y = c2 * b2 - a2; a2 = b2; b2 = y;
          if (id === K_GSN) {
            // 80'ler "kapılı yankı": uzun gürültü kuyruğu 0.3 s'de birden kesilir
            lp += 0.4 * (nz - lp);
            const t = i / sr, gate = t < 0.3 ? 1 : 1 - (t - 0.3) / 0.05;
            if (gate > 0) x += lp * 0.55 * e3 * gate;
            e3 *= k3;
          }
          x *= 0.85;
          break;
        case K_CLAP:
          hp = 0.75 * (hp + nz - prev); prev = nz;
          lp += 0.6 * (hp - lp);
          if (i < B.tl) { if (i % B.bl === 0) e1 = 1; else e1 *= k1; } else if (i === B.tl) e1 = 1; else e1 *= k2;
          x = lp * e1 * 1.1;
          break;
        case K_DUM: {
          const f = 78 + 40 * e1; e1 *= k1;
          p1 += w0 * f; p2 += w0 * f * 2.3;
          lp += 0.35 * (nz - lp);
          x = Math.sin(p1) * e2 + Math.sin(p2) * 0.25 * e3 + lp * e4 * 0.6; e2 *= k2; e3 *= k3; e4 *= k4;
          x *= 1.4; x = (x / (1 + (x < 0 ? -x : x))) * 1.15;
          break;
        }
        case K_TEK: case K_KA:
          hp = 0.65 * (hp + nz - prev); prev = nz;
          x = ((b1 * 0.35 + b2 * 0.25 + b3 * 0.15) * e1 + hp * e2 * 0.5) * g; e1 *= k1; e2 *= k2;
          y = c1 * b1 - a1; a1 = b1; b1 = y;
          y = c2 * b2 - a2; a2 = b2; b2 = y;
          y = c3 * b3 - a3; a3 = b3; b3 = y;
          break;
        case K_RIM:
          hp = 0.6 * (hp + nz - prev); prev = nz;
          x = b1 * e1 * 0.45 + hp * e2 * 0.3; e1 *= k1; e2 *= k2;
          y = c1 * b1 - a1; a1 = b1; b1 = y;
          break;
        default: {
          // plak cızırtısı: çok kısık hışırtı + seyrek çıtırtılar (döngü)
          lp += 0.14 * (nz - lp);
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          if (s > 4288000000) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; lp2 = (s & 1 ? 1 : -1) * (0.15 + 0.35 * (s / 4294967296)); }
          lp2 *= 0.75;
          x = lp * 0.05 + lp2;
        }
      }
      d[i] = x;
    }
    B.i = i; B.s = s; B.hp = hp; B.prev = prev; B.lp = lp; B.lp2 = lp2; B.p1 = p1; B.p2 = p2;
    B.e1 = e1; B.e2 = e2; B.e3 = e3; B.e4 = e4; B.a1 = a1; B.b1 = b1; B.a2 = a2; B.b2 = b2; B.a3 = a3; B.b3 = b3;
    if (i < n) return false;
    if (id !== K_CRK) {
      // son 6 ms yumuşak kapanış (tık sesi olmasın)
      const f = Math.min(n, Math.ceil(0.006 * sr));
      for (let k = 0; k < f; k++) d[n - 1 - k] *= k / f;
    }
    return true;
  }

  // ---- çevrimdışı takım: aynı tarifler OfflineAudioContext düğümleriyle; ayrı iş parçacığında bir kez işlenir ----
  // (ana iş parçacığında yalnız düğüm kurulumu, karede bir parça). Yoksa JS pişirici (yukarıda) devreye girer.
  const KIT_OFF = new Float64Array(KIT_N);
  let KIT_TOT = 0;
  for (let i = 0; i < KIT_N; i++) { KIT_OFF[i] = KIT_TOT + 0.01; KIT_TOT += KIT_LEN[i] + 0.03; }
  // yumuşak kırpma eğrisi: y = k·x / (1 + k·|x|) · s
  function softCurve(k, sc) {
    const n = 257, cv = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, u = x * k; cv[i] = (u / (1 + (u < 0 ? -u : u))) * sc; }
    return cv;
  }
  function kitPiece(oc, id, noise) {
    const t0 = KIT_OFF[id], len = KIT_LEN[id], sr = oc.sampleRate;
    const pg = oc.createGain();
    if (id !== K_CRK) { pg.gain.setValueAtTime(1, t0 + len - 0.006); pg.gain.linearRampToValueAtTime(0, t0 + len); }
    pg.connect(oc.destination);
    const env = (dst, peak, tc) => { const g = oc.createGain(); g.gain.setValueAtTime(peak, t0); if (tc > 0) g.gain.setTargetAtTime(0, t0, tc); g.connect(dst); return g; };
    const nz = (type, f, q) => {
      const sN = oc.createBufferSource(); sN.buffer = noise; sN.loop = true;
      sN.start(t0, (id * 0.137) % 1.5); sN.stop(t0 + len + 0.01);
      if (!type) return sN;
      const fl = oc.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      sN.connect(fl);
      return fl;
    };
    const osc = (type, f) => { const o = oc.createOscillator(); o.type = type; o.frequency.value = f; o.start(t0); o.stop(t0 + len + 0.01); return o; };
    const shaper = (k, sc) => { const w = oc.createWaveShaper(); w.curve = softCurve(k, sc); w.connect(pg); return w; };
    if (id === K_KICK) {
      const sh = shaper(1.6, 1.05), o = osc('sine', 168);
      o.frequency.setValueAtTime(168, t0); o.frequency.setTargetAtTime(48, t0, 0.028);
      o.connect(env(sh, 1, 0.11));
      nz('highpass', 1500, 0.7).connect(env(sh, 0.25, 0.0015));
    } else if (id === K_HAT || id === K_HATS || id === K_OHAT) {
      // gürültü + iki uyumsuz kare dalga (808 tarzı metalik renk)
      const amp = id === K_HAT ? 0.55 : id === K_HATS ? 0.24 : 0.38, g = env(pg, amp, id === K_OHAT ? 0.07 : 0.011);
      nz('highpass', 6500, 0.7).connect(env(g, 1.3, 0));
      osc('square', 5430).connect(env(g, 0.06, 0));
      osc('square', 7920).connect(env(g, 0.05, 0));
    } else if (id === K_SNR || id === K_GSN) {
      const gt = env(pg, 0.3, 0.045);
      osc('sine', 180).connect(gt);
      osc('sine', 330).connect(env(gt, 0.6, 0));
      nz('highpass', 1000, 0.7).connect(env(pg, 0.9, 0.055));
      if (id === K_GSN) {
        // 80'ler "kapılı yankı": uzun gürültü kuyruğu 0.3 s'de birden kesilir
        const g = oc.createGain(), a = 0.7;
        g.gain.setValueAtTime(a, t0); g.gain.setTargetAtTime(0, t0, 0.5);
        g.gain.setValueAtTime(a * Math.exp(-0.3 / 0.5), t0 + 0.3); g.gain.linearRampToValueAtTime(0, t0 + 0.35);
        g.connect(pg);
        nz('lowpass', 2600, 0.6).connect(g);
      }
    } else if (id === K_CLAP) {
      const g = oc.createGain();
      for (let k = 0; k < 3; k++) { g.gain.setValueAtTime(1.6, t0 + k * 0.011); g.gain.setTargetAtTime(0, t0 + k * 0.011, 0.004); }
      g.gain.setValueAtTime(1.6, t0 + 0.032); g.gain.setTargetAtTime(0, t0 + 0.032, 0.07);
      g.connect(pg);
      nz('bandpass', 1300, 0.9).connect(g);
    } else if (id === K_DUM) {
      const sh = shaper(1.4, 1.15);
      const o1 = osc('sine', 118), o2 = osc('sine', 271);
      o1.frequency.setValueAtTime(118, t0); o1.frequency.setTargetAtTime(78, t0, 0.03);
      o2.frequency.setValueAtTime(271, t0); o2.frequency.setTargetAtTime(179, t0, 0.03);
      o1.connect(env(sh, 1, 0.17)); o2.connect(env(sh, 0.25, 0.05));
      nz('lowpass', 1600, 0.7).connect(env(sh, 0.9, 0.004));
    } else if (id === K_TEK || id === K_KA) {
      const ka = id === K_KA, gg = ka ? 0.42 : 0.75, g = env(pg, gg, ka ? 0.022 : 0.032);
      osc('sine', ka ? 700 : 620).connect(env(g, 0.35, 0));
      osc('sine', ka ? 1650 : 1460).connect(env(g, 0.25, 0));
      osc('sine', 2380).connect(env(g, 0.15, 0));
      nz('highpass', 2000, 0.7).connect(env(pg, 0.7 * gg, 0.008));
    } else if (id === K_RIM) {
      osc('sine', 1750).connect(env(pg, 0.45, 0.007));
      nz('highpass', 2000, 0.7).connect(env(pg, 0.45, 0.004));
    } else {
      // plak cızırtısı: kısık hışırtı + seyrek çıtırtı darbeleri (döngü)
      nz('lowpass', 600, 0.5).connect(env(pg, 0.09, 0));
      const n = Math.ceil(len * sr), ib = oc.createBuffer(1, n, sr), d = ib.getChannelData(0);
      let s = 4242;
      for (let k = 0; k < 40; k++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const at = s % (n - 40), a = (s & 1 ? 1 : -1) * (0.15 + 0.35 * ((s >>> 8) / 16777216));
        let v = a;
        for (let j = 0; j < 30; j++) { d[at + j] += v; v *= 0.75; }
      }
      const src = oc.createBufferSource(); src.buffer = ib; src.connect(pg); src.start(t0);
    }
  }

  const PERF = typeof performance !== 'undefined' && performance.now ? performance : null;
  function now() { return PERF ? PERF.now() : Date.now(); }

  // biten kaynak düğümünü (ve varsa kendi kazancını) ağdan ayır; olay işleyicisinde this = düğüm
  function onEnd() {
    try { this.disconnect(); } catch (e) { /* yok */ }
    const g = this._g;
    if (g) { try { g.disconnect(); } catch (e) { /* yok */ } this._g = null; }
    this.onended = null;
  }
  // bırakılan istasyon oturumunu kopar (kısıldıktan sonra)
  function dropSession(ses) {
    const L = [ses.bus, ses.d, ses.b, ses.h, ses.l];
    for (let i = 0; i < L.length; i++) { try { L[i].disconnect(); } catch (e) { /* yok */ } }
  }

  // parça dalgaları: b bas, l melodi, a arpej, s akor vuruşu / klavye, p uzun akor / dem
  const WAVES = [
    { b: W_SAW, l: W_SAW, a: W_SQ, s: W_SAW, p: W_SAW },
    { b: W_SAW, l: W_SQ, a: W_SQ, s: W_SAW, p: W_SAW },
    { b: W_TRI, l: W_TRI, a: W_TRI, s: W_EP, p: W_SAW },
    { b: W_SAW, l: W_SAZ, a: W_SQ, s: W_SAW, p: W_SAW },
  ];
  // kademe sınıfına (radioVoices 6 / 8 / 10 / 12) göre parça ses sayıları; her istasyonda toplam ≤ sınır:
  // 2 davul döngüsü (ölçü geçişinde üst üste) + bas + melodi + (arpej | akor vuruşu | klavye | dem) + uzun akor + cızırtı
  const PAD_N = [0, 2, 3, 3], STAB_N = [2, 2, 3, 4], KEYS_N = [2, 3, 4, 4], DRONE_N = [1, 2, 2, 2];
  // lo-fi davul insanileştirmesi (sabit tablo: aynı desen aynı tamponu üretir)
  const HUM = new Float32Array([0, 0.004, -0.002, 0.005, 0.001, 0.003, -0.001, 0.006, 0, 0.004, -0.002, 0.003, 0.002, 0.005, -0.001, 0.004]);
  const HUMG = new Float32Array([1, 0.8, 0.95, 0.75, 1, 0.85, 0.9, 0.7, 1, 0.8, 0.95, 0.78, 1, 0.82, 0.9, 0.72]);

  // istasyon durumu (bölüm desenleri tipli dizilerde; bölüm/şarkı üretimi seyrek olaydır)
  function mkState(def, seed) {
    return {
      def, style: def.style, rng: U.rng((def.seed * 7919 + seed) >>> 0), sw: 0,
      song: 0, form: FORMS[0], fi: 99, type: 0, bars: 0, bar: 0, step: 0, lay: 0, layers: 0,
      key: 57, sc: SC_MIN, pr: new Float32Array(8), pq: new Int8Array(8), pn: 4, cb: 1,
      chS: 0, chQ: 0, chD: 0, nxS: 0, fill: false, fillOK: true,
      kick: new Uint8Array(16), snare: new Uint8Array(16), hat: new Uint8Array(16), ohat: new Uint8Array(16),
      perc: new Uint8Array(16), bass: new Uint8Array(16), bassL: new Uint8Array(16),
      harm: new Uint8Array(16), harmL: new Uint8Array(16), arp: new Int8Array(16),
      lead: new Int16Array(32), leadL: new Uint8Array(32), leadSong: -1, trem: false, holdD: 0, holdN: 0,
      sweep: false, tuneIn: true, dVer: 0, dKey: new Float64Array([-1, -1, -1, -1]), dBuf: [null, null, null, null],
    };
  }
  function pick(r, arr) { return arr[(r() * arr.length) | 0]; }
  function pat(dst, s) {
    const n = s.length;
    for (let i = 0; i < 16; i++) dst[i] = CODE[s.charCodeAt(i % n)];
  }
  // her vuruşun bir sonraki vuruşa (ya da ölçü sonuna) kadar uzunluğu
  function lens(src, dst) {
    let next = 16;
    for (let i = 15; i >= 0; i--) { if (src[i]) { dst[i] = next - i; next = i; } else dst[i] = 0; }
  }

  class Radio {
    constructor(audio, seed) {
      this.audio = audio || null;
      this.station = 0;            // başlangıç: Drift FM
      this.vol = 0.6;
      this.active = false;
      this.ready = false;
      this.ctx = null; this.out = null; this.ses = null;
      this.seed = typeof seed === 'number' ? seed | 0 : (Math.random() * 1e6) | 0;
      this.tier = 1;
      this._parts(8);
      this._wantFx = false; this._wantRev = false; this._fxOn = false; this._revOn = false;
      this._st = new Array(STATIONS.length);
      for (let i = 0; i < STATIONS.length; i++) this._st[i] = null;
      this._cur = null; this._run = false; this._offAt = 0;
      this.nextT = 0; this.sd = 0.15;
      this._kit = new Array(KIT_N); this._kitD = new Array(KIT_N); this._kitR = new Float64Array(KIT_N);
      for (let i = 0; i < KIT_N; i++) { this._kit[i] = null; this._kitD[i] = null; }
      this._bakeI = 0; this._bk = null;
      this._kitMode = 0; this._oc = null; this._ocI = 0; this._pw = [null, null]; this._warmI = 0; this._prepped = false;
      this._rd = null; this._rsr = KIT_SR;
      this._j = 1;
      this.mix = MIX[0];
      // audio.silence() (duraklat / menü / sonuç) radyoyu da sustursun
      const au = this.audio;
      if (au && typeof au.silence === 'function') {
        if (!au._radioHook) {
          const orig = au.silence;
          au._radioHook = true;
          au.silence = function () {
            const r = orig.apply(this, arguments);
            const rd = this._radio;
            if (rd && rd.silence) { try { rd.silence(); } catch (e) { /* yok */ } }
            return r;
          };
        }
        au._radio = this;
      }
    }

    // ================= GENEL API =================
    stationName(i) {
      const k = typeof i === 'number' ? i : this.station;
      const d = STATIONS[k];
      return d ? d.name : '';
    }
    // çalıyor mu (araçta, ses açık, istasyon "Kapalı" değil)
    isPlaying() { return this.active && !STATIONS[this.station].off && this.vol > 0; }
    next() { return this._tune(this.station + 1, true); }
    prev() { return this._tune(this.station - 1, true); }
    // sessiz istasyon seçimi (kayıttan yükleme vb.; cızırtı yok)
    setStation(i) { return this._tune(i, false); }

    // araçta: 0.6 s'de açılır; yayayken / duraklatınca / menüde: kısılır. Her kare çağrılabilir (yalnız değişimde iş yapar).
    setActive(on) {
      on = !!on;
      if (on === this.active) return;
      this.active = on;
      if (!this.ready && !this._ensure()) return;
      if (on) { this._activate(); return; }
      const now = this.ctx.currentTime, g = this.out.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, FADE_OUT / 3);
      this._offAt = now + FADE_OUT + 0.15;
    }
    // 0..1 (oyun ana sesiyle çarpılır; audio.master üzerinden geçer)
    setVolume(v) {
      v = typeof v === 'number' && v > 0 ? Math.min(1, v) : 0;
      if (v === this.vol) return;
      this.vol = v;
      if (!this.ready || !this.active) return;
      const now = this.ctx.currentTime, g = this.out.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(LEVEL * v, now, 0.05);
    }
    // T0/T1: daha az ses, yankı/gecikme yok; T2: gecikme; T3: gecikme + kısa yankı. Q.radioVoices varsa onu kullanır.
    setQuality(Q) {
      if (!Q) return;
      const tier = typeof Q.tier === 'number' ? Q.tier : 1;
      let cap = Q.radioVoices > 0 ? Q.radioVoices | 0 : [6, 8, 10, 12][tier] || 8;
      cap = U.clamp(cap, 6, MAXV);
      const fx = tier >= 2, rev = tier >= 3;
      if (cap === this.cap && tier === this.tier && fx === this._wantFx && rev === this._wantRev) return;
      this.tier = tier;
      this._parts(cap);
      this._wantFx = fx; this._wantRev = rev;
      if (!this.ready) return;
      this._applyFx();
      // plak cızırtısına artık yer yoksa durdur
      const s = this.ses;
      if (s && s.crk && !this.crackle) { try { s.crk.stop(this.ctx.currentTime + 0.05); } catch (e) { /* yok */ } s.crk = null; }
    }
    // her şeyi hemen sustur (≤ 0.1 s); sonraki setActive(true) yeniden açar
    silence() {
      this.active = false;
      if (!this.ready) return;
      const now = this.ctx.currentTime, g = this.out.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.025);
      if (this._run) this._kill(now);
      this._offAt = 0;
    }

    // Her kare çağrılır: ses saatine göre en fazla LOOK ileriye nota yerleştirir. Kapalı/sessizken hemen döner.
    // (Ses bağlamı varsa yayayken bir kerelik hazırlık yapılır: davul takımı, tınılar, karıştırıcı ısınması.)
    update(dt) {
      if (!this._prepped) this._prepTick();
      if (!this.active) {
        if (this._run && this.ready && this._offAt > 0 && this.ctx.currentTime >= this._offAt) this._kill(this.ctx.currentTime);
        return;
      }
      if (!this.ready) {
        if (!this._ensure()) return;
        this._activate();
      }
      const c = this.ctx;
      if (c.state !== 'running') return;
      const S = this._cur;
      if (!S || this.vol <= 0 || this.audio.on === false) return;   // ses kapalıyken nota üretme
      const now = c.currentTime;
      if (this.nextT < now) {
        // takılma / arka plan sekmesi: ızgarayı yeniden hizala (geçmişe nota yığma); davullar sonraki vuruşta döner
        this.nextT = now + 0.02;
        const ses = this.ses;
        for (let k = 0; k < 2; k++) { const d = ses.dl[k]; if (d) { try { d.stop(now + 0.03); } catch (e) { /* yok */ } ses.dl[k] = null; } }
      }
      const end = now + LOOK;
      for (let k = 0; k < 8; k++) {
        const ts = this.nextT + ((S.step & 1) ? S.sw : 0);
        if (ts >= end) break;
        this._play(S, this.nextT, ts);
        this.nextT += this.sd;
      }
    }

    // ================= İÇ: ses ağı =================
    _ensure() {
      if (this.ready) return true;
      const au = this.audio;
      if (!au || !au.ctx || !au.master) return false;
      const c = au.ctx;
      this.ctx = c;
      try {
        this.out = c.createGain(); this.out.gain.value = 0;
        this.out.connect(au.master);
        if (!au.noise) {
          const len = c.sampleRate;
          this._noise = c.createBuffer(1, len, c.sampleRate);
          const d = this._noise.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
      } catch (e) {
        this.out = null; this.ctx = null;
        return false;
      }
      this.ready = true;
      this._applyFx();
      return true;
    }
    // bir kerelik hazırlık, karede bir adım: davul takımı -> elektrikli piyano / saz tınıları -> karıştırıcı ısınması
    _prepTick() {
      const c = this.audio && this.audio.ctx;
      if (!c) return;
      if (this._bakeI < KIT_N) { this._kitTick(c); return; }
      if (!this._pw[0]) { this._pwave(0); return; }
      if (!this._pw[1]) { this._pwave(1); return; }
      if (this._warmI < 6) { this._warmMix(); return; }
      this._prepped = true;
    }
    // tını tabloları (ilk kullanımda ya da hazırlıkta; oluşturması pahalı olduğu için tek tek)
    _pwave(k) {
      let w = this._pw[k];
      if (w) return w;
      const c = this.audio.ctx;
      const im = k === 0 ? new Float32Array([0, 1, 0.28, 0.08, 0.05, 0.02, 0.012])
        : new Float32Array([0, 1, 0.8, 0.62, 0.5, 0.42, 0.3, 0.26, 0.2, 0.16, 0.12, 0.1, 0.08]);
      w = this._pw[k] = c.createPeriodicWave(new Float32Array(im.length), im);
      return w;
    }
    // karıştırıcıyı (JIT) önceden ısıt: ilk gerçek vuruş tamponunda büyük sıçrama olmasın
    _warmMix() {
      if (!this._warmD) this._warmD = new Float32Array(2048);
      const d = this._warmD;
      d.fill(0);
      this._rd = d; this._rsr = this._warmI & 1 ? KIT_SR : this._kitR[0];
      for (let id = 0; id < K_CRK; id++) this._mix(id, 0.001 * this._warmI, id & 1 ? 0.94 : 1, 0.5);
      this._rd = null;
      this._warmI++;
    }
    // davul takımı: OfflineAudioContext varsa düğümleri karede bir parça kur ve ayrı iş parçacığında işlet;
    // yoksa JS pişirici (süre bütçeli)
    _kitTick(c) {
      if (this._kitMode === 0) {
        const OAC = typeof window !== 'undefined' ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
        this._kitMode = OAC && this.audio.noise ? 1 : 2;
        if (this._kitMode === 1) {
          try { this._oc = new OAC(1, Math.ceil(KIT_TOT * c.sampleRate), c.sampleRate); } catch (e) { this._kitMode = 2; }
        }
      }
      if (this._kitMode === 2) { this._bakeTick(); return; }
      if (this._kitMode !== 1) return;   // işleniyor: sonucu bekle
      const oc = this._oc;
      try { kitPiece(oc, this._ocI, this.audio.noise); } catch (e) { this._kitMode = 2; this._oc = null; return; }
      if (++this._ocI < KIT_N) return;
      this._kitMode = 3;
      const done = (buf) => this._kitDone(buf);
      const fail = () => { this._kitMode = 2; this._oc = null; };
      try {
        const p = oc.startRendering();
        if (p && p.then) p.then(done, fail); else oc.oncomplete = (e) => done(e.renderedBuffer);
      } catch (e) { fail(); }
    }
    _kitDone(buf) {
      this._oc = null;
      const c = this.audio && this.audio.ctx;
      if (!buf || !c) { this._kitMode = 2; return; }
      const d = buf.getChannelData(0), sr = buf.sampleRate;
      for (let id = 0; id < KIT_N; id++) {
        const a = Math.round(KIT_OFF[id] * sr), n = Math.round(KIT_LEN[id] * sr);
        this._kitD[id] = d.subarray(a, a + n); this._kitR[id] = sr; this._kit[id] = buf;
      }
      // plak cızırtısı döngüsü ayrı bir tampon olarak çalınır
      try {
        const n = this._kitD[K_CRK].length, b = c.createBuffer(1, n, sr);
        if (b.copyToChannel) b.copyToChannel(this._kitD[K_CRK], 0); else b.getChannelData(0).set(this._kitD[K_CRK]);
        this._kit[K_CRK] = b;
      } catch (e) { this._kit[K_CRK] = null; }
      this._bakeI = KIT_N;
      this._kitMode = 4;
    }
    // (yedek) JS pişirici: kare başına süre bütçesi (yayayken 0.03 ms, araçta 0.05 ms) dolana kadar 128'lik örnek
    // blokları; yavaş makinede yalnız daha çok kareye yayılır
    _bakeTick() {
      const c = this.audio && this.audio.ctx;
      if (!c) return;
      const t0 = now(), bud = this.active ? 0.05 : 0.03;
      do {
        let B = this._bk;
        if (!B) { try { B = this._bk = bakeBegin(c, this._bakeI); } catch (e) { this._bakeI = KIT_N; return; } }
        if (bakeRun(B, 128)) {
          const k = this._bakeI;
          this._kit[k] = B.buf; this._kitD[k] = B.d; this._kitR[k] = B.sr;
          this._bakeI++; this._bk = null;
          if (this._bakeI >= KIT_N) return;
        }
      } while (now() - t0 < bud);
    }
    _activate() {
      const now = this.ctx.currentTime, g = this.out.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(LEVEL * this.vol, now, FADE_IN / 3);
      this._offAt = 0;
      if (!this._run) this._begin(now + 0.05);
      else if (this.nextT < now + 0.01) this.nextT = now + 0.02;
    }
    _parts(cap) {
      const k = cap >= 12 ? 3 : cap >= 10 ? 2 : cap >= 8 ? 1 : 0;
      this.cap = cap;
      this.padN = PAD_N[k]; this.stabN = STAB_N[k]; this.keysN = KEYS_N[k]; this.droneN = DRONE_N[k];
      this.crackle = k >= 2; this.tremOK = k >= 1;
    }
    _jit() { this._j = (Math.imul(this._j, 1103515245) + 12345) & 0x7fffffff; return this._j / 0x7fffffff; }

    // istasyon oturumu: kendi kazancı, kanal süzgeçleri ve kalıcı sesleri (değişimde bütün ağaç kısılıp koparılır)
    _mkSession(t, M, style) {
      const c = this.ctx;
      const ses = {
        bus: c.createGain(), d: c.createGain(), b: c.createBiquadFilter(), h: c.createBiquadFilter(), l: c.createBiquadFilter(),
        w: WAVES[style], src: [], dl: [null, null], di: 0, crk: null, vB: null, vL: null, vA: null, vS: null, vP: null,
      };
      ses.bus.gain.setValueAtTime(0, t);
      ses.bus.gain.linearRampToValueAtTime(1, t + 0.03);
      ses.d.gain.value = M.d;
      ses.b.type = 'lowpass'; ses.b.frequency.value = M.bf; ses.b.Q.value = 0.9;
      ses.h.type = 'lowpass'; ses.h.frequency.value = M.hf; ses.h.Q.value = M.hq;
      ses.l.type = 'lowpass'; ses.l.frequency.value = M.lf; ses.l.Q.value = 0.7;
      ses.d.connect(ses.bus); ses.b.connect(ses.bus); ses.h.connect(ses.bus); ses.l.connect(ses.bus);
      ses.bus.connect(this.out);
      if (this._fxOn) { ses.h.connect(this.dIn); ses.l.connect(this.dIn); }
      if (this._revOn) { ses.h.connect(this.rIn); ses.l.connect(this.rIn); }
      return ses;
    }
    _applyFx() {
      const c = this.ctx;
      const fx = this._wantFx, rev = this._wantRev;
      try {
        if (fx && !this.dIn) {
          // gecikme (noktalı sekizlik): giriş -> gecikme -> alçak geçiren -> geri besleme ; ıslak çıkış
          this.dIn = c.createGain(); this.dIn.gain.value = 0.3;
          this.dl = c.createDelay(1.5); this.dl.delayTime.value = 0.45;
          this.dLp = c.createBiquadFilter(); this.dLp.type = 'lowpass'; this.dLp.frequency.value = 2300;
          this.dFb = c.createGain(); this.dFb.gain.value = 0.3;
          this.dWet = c.createGain(); this.dWet.gain.value = 0.55;
          this.dIn.connect(this.dl); this.dl.connect(this.dLp); this.dLp.connect(this.dFb); this.dFb.connect(this.dl);
          this.dLp.connect(this.dWet);
        }
        if (rev && !this.rIn) {
          // kısa oda yankısı (0.8 s, tek kanal, bir kez üretilir)
          const len = Math.ceil(c.sampleRate * 0.8), ir = c.createBuffer(1, len, c.sampleRate), d = ir.getChannelData(0);
          let lp = 0;
          for (let i = 0; i < len; i++) { lp += 0.35 * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.exp(-i / (len * 0.22)); }
          this.rIn = c.createGain(); this.rIn.gain.value = 0.5;
          this.rv = c.createConvolver(); this.rv.buffer = ir;
          this.rWet = c.createGain(); this.rWet.gain.value = 0.35;
          this.rIn.connect(this.rv); this.rv.connect(this.rWet);
        }
      } catch (e) { return; }
      const ses = this.ses;
      if (fx !== this._fxOn && this.dIn) {
        this._fxOn = fx;
        if (fx) {
          this.dWet.connect(this.out);
          if (ses) { ses.h.connect(this.dIn); ses.l.connect(this.dIn); }
        } else {
          // ağdan kopan gecikme düğümleri işlenmez (işlemci harcamaz)
          try { this.dWet.disconnect(); } catch (e) { /* yok */ }
          if (ses) { try { ses.h.disconnect(this.dIn); ses.l.disconnect(this.dIn); } catch (e) { /* yok */ } }
        }
      }
      if (rev !== this._revOn && this.rIn) {
        this._revOn = rev;
        if (rev) {
          this.rWet.connect(this.out);
          if (ses) { ses.h.connect(this.rIn); ses.l.connect(this.rIn); }
        } else {
          try { this.rWet.disconnect(); } catch (e) { /* yok */ }
          if (ses) { try { ses.h.disconnect(this.rIn); ses.l.disconnect(this.rIn); } catch (e) { /* yok */ } }
        }
      }
    }

    // istasyon değiştir (cızırtılı ya da sessiz)
    _tune(i, noisy) {
      const n = STATIONS.length;
      i = (((i | 0) % n) + n) % n;
      if (i === this.station) return this.stationName();
      this.station = i;
      if (!this.ready) return this.stationName();
      const now = this.ctx.currentTime;
      if (this._run) this._kill(now);
      if (this.active) {
        if (noisy) { this._static(now + 0.005); this._begin(now + STATIC_T); } else this._begin(now + 0.05);
      }
      return this.stationName();
    }
    // yeni istasyon oturumu t anında başlar (Kapalı: hiçbir şey)
    _begin(t) {
      const def = STATIONS[this.station];
      this._cur = null;
      if (def.off) { this._run = false; return; }
      let S = this._st[this.station];
      if (!S) S = this._st[this.station] = mkState(def, this.seed);
      else { S.bar = S.bars; S.step = 0; }   // radyo bu arada çalıyordu: yeni bir bölümden gir
      S.tuneIn = true;
      const M = this.mix = MIX[def.style];
      this.sd = 60 / def.bpm / 4;
      S.sw = def.swing * this.sd;
      this.ses = this._mkSession(t, M, def.style);
      if (this.dl) { this.dl.delayTime.setValueAtTime(this.sd * M.ds, t); this.dIn.gain.setValueAtTime(M.fx, t); }
      this.nextT = t;
      this._cur = S;
      this._run = true;
    }
    // çalan her şeyi kıs ve durdur; oturum ağı kısa süre sonra koparılır
    _kill(now) {
      const ses = this.ses, te = now + 0.06;
      if (ses) {
        ses.bus.gain.cancelScheduledValues(now);
        ses.bus.gain.setTargetAtTime(0, now, 0.01);
        const L = ses.src;
        for (let i = 0; i < L.length; i++) { try { L[i].stop(te); } catch (e) { /* yok */ } }
        for (let k = 0; k < 2; k++) { const d = ses.dl[k]; if (d) { try { d.stop(te); } catch (e) { /* yok */ } } }
        if (ses.crk) { try { ses.crk.stop(te); } catch (e) { /* yok */ } }
        setTimeout(() => dropSession(ses), 200);
      }
      this.ses = null; this._cur = null; this._run = false;
    }
    // ayar cızırtısı: süzülmüş gürültü + çıtırtı basamakları + aşağı kayan ıslık (değişimde bir kez)
    _static(t) {
      const c = this.ctx, nb = this.audio.noise || this._noise;
      if (!nb) return;
      const dur = STATIC_T;
      try {
        const src = c.createBufferSource(); src.buffer = nb; src.playbackRate.value = 0.9 + Math.random() * 0.2;
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
        bp.frequency.setValueAtTime(2600, t); bp.frequency.exponentialRampToValueAtTime(900, t + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(0, t);
        for (let k = 0; k < 7; k++) g.gain.setValueAtTime(0.1 + Math.random() * 0.22, t + 0.004 + k * dur / 8);
        g.gain.setTargetAtTime(0, t + dur - 0.06, 0.02);
        src.connect(bp); bp.connect(g); g.connect(this.out);
        src._g = g; src.onended = onEnd;
        src.start(t, Math.random() * Math.max(0, nb.duration - dur - 0.1), dur + 0.02);
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(2900 + Math.random() * 800, t); o.frequency.exponentialRampToValueAtTime(500, t + dur);
        const og = c.createGain(); og.gain.setValueAtTime(0.025, t); og.gain.setTargetAtTime(0, t + dur - 0.08, 0.02);
        o.connect(og); og.connect(this.out);
        o._g = og; o.onended = onEnd;
        o.start(t); o.stop(t + dur + 0.02);
      } catch (e) { /* yok */ }
    }

    // ---- kalıcı sesler: oturum boyunca çalan osilatörler, notalar yalnız otomasyon olayıyla (düğüm üretimi yok) ----
    _wave(o, w) { if (w < 4) o.type = TYPES[w]; else o.setPeriodicWave(this._pwave(w - 4)); }
    _mkVoice(chan, w, n) {
      const c = this.ctx, g = c.createGain(), ses = this.ses, o = new Array(n), t0 = c.currentTime;
      g.gain.value = 0;
      g.connect(chan);
      for (let k = 0; k < n; k++) {
        const x = c.createOscillator();
        this._wave(x, w);
        if (this.tier > 0) x.detune.value = (this._jit() - 0.5) * 9;
        x.connect(g);
        if (k === 0) x._g = g;
        x.onended = onEnd;
        x.start(t0);
        o[k] = x;
        ses.src.push(x);
      }
      return { o, g, n, end: 0, ev: 0 };
    }
    _drop(V, t) {
      const L = this.ses.src;
      for (let k = 0; k < V.n; k++) {
        const x = V.o[k];
        try { x.stop(t); } catch (e) { /* yok */ }
        const i = L.indexOf(x);
        if (i >= 0) L.splice(i, 1);
      }
    }
    // çok olay biriktiren boştaki sesi yenile (tarayıcı geçmiş olayları budamasa bile liste büyümesin)
    _stale(V, now) {
      if (!V || V.ev < 3000 || V.end > now) return false;
      this._drop(V, now);
      return true;
    }
    _renew() {
      const s = this.ses;
      if (!s) return;
      const now = this.ctx.currentTime;
      if (this._stale(s.vB, now)) s.vB = null;
      if (this._stale(s.vL, now)) s.vL = null;
      if (this._stale(s.vA, now)) s.vA = null;
      if (this._stale(s.vS, now)) s.vS = null;
      if (this._stale(s.vP, now)) s.vP = null;
    }
    _vB() { const s = this.ses; return s.vB || (s.vB = this._mkVoice(s.b, s.w.b, 1)); }
    _vL() { const s = this.ses; return s.vL || (s.vL = this._mkVoice(s.l, s.w.l, 1)); }
    _vA() { const s = this.ses; return s.vA || (s.vA = this._mkVoice(s.h, s.w.a, 1)); }
    // akor sesleri: kademe değişince (ses boştaysa) yeni sayıyla yeniden kurulur
    _vS(n) {
      const s = this.ses;
      if (s.vS && s.vS.n !== n && s.vS.end <= this.ctx.currentTime) { this._drop(s.vS, this.ctx.currentTime); s.vS = null; }
      return s.vS || (s.vS = this._mkVoice(s.h, s.w.s, n));
    }
    _vP(n) {
      const s = this.ses;
      if (s.vP && s.vP.n !== n && s.vP.end <= this.ctx.currentTime) { this._drop(s.vP, this.ctx.currentTime); s.vP = null; }
      return s.vP || (s.vP = this._mkVoice(s.h, s.w.p, n));
    }
    // kazanç zarfı: önceki nota hâlâ çalıyorsa 12 ms'de kısılır; kısa saldırı tek basamak (osilatör zaten çalıyor,
    // kazanç ~0'dan sıçrar), uzun saldırı doğrusal; üstel sönüm; gerekiyorsa nota sonunda kapanış
    _env(V, t, v, att, tc, len, rel) {
      const gg = V.g.gain, end = t + len;
      if (V.end > t - 0.004) { gg.cancelScheduledValues(t - 0.012); gg.setTargetAtTime(0, t - 0.012, 0.004); V.ev += 2; }
      if (att > 0.006) { gg.setValueAtTime(0, t); gg.linearRampToValueAtTime(v, t + att); V.ev += 2; } else { gg.setValueAtTime(v, t); V.ev++; }
      if (tc > 0) { gg.setTargetAtTime(0, t + att, tc); V.ev++; }
      if ((tc <= 0 || len - att < tc * 4.5) && end - rel > t + att) { gg.setTargetAtTime(0, end - rel, rel / 4); V.ev++; }
      V.end = end;
    }
    // tek ses (bas, melodi, arpej); bend: başlangıç frekans oranı (50 ms'de hedefe kayar)
    _trig1(V, f, t, v, att, tc, len, bend) {
      const fq = V.o[0].frequency;
      if (V.end > t) fq.cancelScheduledValues(t);
      if (bend && bend !== 1) { fq.setValueAtTime(f * bend, t); fq.exponentialRampToValueAtTime(f, t + 0.05); V.ev += 2; } else { fq.setValueAtTime(f, t); V.ev++; }
      this._env(V, t, v, att, tc, len, Math.min(0.05, len * 0.3));
    }
    // akor: sesin tüm osilatörleri seslendirmenin ilk notalarına (fazlası başa sarar)
    _trigN(V, root, q, t, v, att, tc, len, rel) {
      const Vo = VOICE[q], n = V.n;
      for (let k = 0; k < n; k++) V.o[k].frequency.setValueAtTime(mtof(root + Vo[k % Vo.length]), t);
      V.ev += n;
      this._env(V, t, n > 2 ? v * 0.8 : v, att, tc, len, rel);
    }

    // ---- davullar: vuruş (4 adım) başına tek tampon; pişmiş parçalar JS ile karıştırılır, desen değişene kadar
    // önbellekte (karıştırma işi dörde bölünür: tek karede büyük sıçrama olmaz) ----
    _drums(S, t, beat) {
      const st = S.style, L = S.lay;
      const lay = L & (st === LOF ? (LK | LS | LH) : (LK | LS | LH | LX));
      // dolgu vuruşları: synthwave / house son vuruşta (adım 12–15), darbuka ikinci yarıda (adım 8–15)
      const fillHits = S.fill && (st === SAZ ? beat >= 2 && (L & LX) : beat === 3 && (st === SYN || (st === HOU && (L & LS))));
      if (!lay && !fillHits) return;
      const hq = this.tier >= 2 ? 1 : 0;
      const key = (((S.dVer * 256 + lay) * 2 + (S.fill ? 1 : 0)) * 2 + hq) * 16 + this._bakeI;
      let b = S.dKey[beat] === key ? S.dBuf[beat] : null;
      if (!b) { b = this._render(S, lay, hq, beat); S.dBuf[beat] = b; S.dKey[beat] = key; }
      if (!b) return;
      const ses = this.ses, src = this.ctx.createBufferSource();
      src.buffer = b;
      src.connect(ses.d);
      src.onended = onEnd;
      src.start(t);
      ses.dl[ses.di & 1] = src; ses.di++;
    }
    _render(S, lay, hq, beat) {
      const c = this.ctx, sd = this.sd, sr = hq ? c.sampleRate : KIT_SR;
      let b;
      try { b = c.createBuffer(1, Math.ceil((sd * 4 + 0.45) * sr), sr); } catch (e) { return null; }
      this._rd = b.getChannelData(0); this._rsr = sr;
      const st = S.style, i0 = beat * 4;
      for (let i = i0; i < i0 + 4; i++) {
        const o = (i - i0) * sd + ((i & 1) ? S.sw : 0);
        if (st === SYN) this._dSyn(S, i, lay, o);
        else if (st === HOU) this._dHou(S, i, lay, o);
        else if (st === LOF) this._dLof(S, i, lay, o);
        else this._dSaz(S, i, lay, o);
      }
      this._rd = null;
      return b;
    }
    // pişmiş parçayı ölçü tamponuna kat (hız oranı + doğrusal ara değer)
    _mix(id, off, rate, gain) {
      const s = this._kitD[id];
      if (!s) return;
      const D = this._rd, n = D.length, j0 = Math.round(off * this._rsr);
      if (j0 < 0 || j0 >= n) return;
      const step = (this._kitR[id] * rate) / this._rsr, sl = s.length;
      if (step === 1) {
        const m = Math.min(sl, n - j0);
        for (let j = 0; j < m; j++) D[j0 + j] += s[j] * gain;
        return;
      }
      let p = 0;
      for (let j = j0; j < n; j++, p += step) {
        const q = p | 0;
        if (q + 1 >= sl) break;
        D[j] += (s[q] + (s[q + 1] - s[q]) * (p - q)) * gain;
      }
    }
    _dSyn(S, i, L, o) {
      if ((L & LK) && S.kick[i]) this._mix(K_KICK, o, 1, 1);
      if ((L & LS) && S.snare[i]) this._mix(K_GSN, o, 1, 1);
      else if (S.fill && i >= 12) this._mix(K_SNR, o, 0.95 + (i - 12) * 0.04, 0.75 + (i - 12) * 0.08);
      if ((L & LH) && S.hat[i]) this._mix(K_HAT, o, 1, S.hat[i] === C_XX ? 1 : 0.45);
    }
    _dHou(S, i, L, o) {
      if ((L & LK) && S.kick[i] && !(S.fill && i >= 12)) this._mix(K_KICK, o, 1, 1);
      if (L & LS) {
        if (S.snare[i]) this._mix(K_CLAP, o, 1, 1);
        else if (S.fill && i >= 12) this._mix(K_CLAP, o, 1.05 + (i - 12) * 0.05, 0.7);
      }
      if (L & LH) {
        if (S.ohat[i]) this._mix(K_OHAT, o, 1, 1);
        else if (S.hat[i]) this._mix(K_HAT, o, 1, S.hat[i] === C_XX ? 1 : 0.45);
      }
    }
    _dLof(S, i, L, o) {
      if (S.fill && i >= 14) return;   // ölçü sonu boşluğu ("nefes")
      const h = HUM[i];
      if ((L & LK) && S.kick[i]) this._mix(K_KICK, o, 0.88, 1);
      if (L & LS) {
        const s = S.snare[i];
        if (s === C_K) this._mix(K_RIM, o + h, 1, 0.9); else if (s) this._mix(K_SNR, o + h, 0.78, 1);
      }
      if ((L & LH) && S.hat[i]) this._mix(K_HAT, o + h, 0.94, (S.hat[i] === C_XX ? 0.8 : 0.36) * HUMG[i]);
    }
    _dSaz(S, i, L, o) {
      if ((L & LK) && S.kick[i]) this._mix(K_KICK, o, 1, 1);
      if (L & LX) {
        const c = S.fill && i >= 8 ? FILLC[i - 8] : S.perc[i];
        if (c === C_D) this._mix(K_DUM, o, 1, 1);
        else if (c === C_T) this._mix(K_TEK, o, 1, 1);
        else if (c === C_K) this._mix(K_KA, o, 0.96 + 0.05 * HUMG[i], 1);
      }
      if ((L & LS) && S.snare[i]) this._mix(K_CLAP, o, 1, 0.9);
      if ((L & LH) && S.hat[i]) this._mix(K_HAT, o, 1, S.hat[i] === C_XX ? 1 : 0.45);
    }
    // dizi derecesi -> MIDI (kesirli olabilir)
    _deg(S, d) {
      const sc = S.sc, n = sc.length, o = Math.floor(d / n);
      return sc[d - o * n] + 12 * o;
    }

    // ================= İÇ: müzik =================
    // tg: düz ızgara zamanı (ölçü başı / davul döngüsü), t: salınımlı (swing) nota zamanı
    _play(S, tg, t) {
      const i = S.step;
      if (i === 0) {
        if (S.bar >= S.bars) this._section(S);
        this._barStart(S, tg);
      }
      if ((i & 3) === 0) this._drums(S, tg, i >> 2);
      switch (S.style) {
        case SYN: this._syn(S, i, t); break;
        case HOU: this._hou(S, i, t); break;
        case LOF: this._lof(S, i, t); break;
        default: this._saz(S, i, t); break;
      }
      if (++S.step === 16) { S.step = 0; S.bar++; }
    }

    _song(S) {
      const r = S.rng, st = S.style;
      S.song++;
      S.key = pick(r, KEYS[st]);
      let P;
      if (st === SYN) { S.sc = r() < 0.7 ? SC_MIN : SC_DOR; P = pick(r, PROGS[SYN]); }
      else if (st === HOU) { S.sc = SC_MINP; P = pick(r, PROGS[HOU]); }
      else if (st === LOF) { S.sc = r() < 0.7 ? SC_MAJP : SC_MAJ; P = pick(r, PROGS[LOF]); }
      else {
        const k = r();
        S.sc = k < 0.45 ? SC_HICAZ : k < 0.65 ? SC_HUMA : SC_USSAK;
        P = pick(r, S.sc === SC_USSAK ? PROGS_USSAK : PROGS[SAZ]);
      }
      S.pn = P.length >> 1;
      for (let i = 0; i < S.pn; i++) { S.pr[i] = P[i * 2]; S.pq[i] = P[i * 2 + 1]; }
      S.cb = S.pn === 2 ? (r() < 0.5 ? 1 : 2) : 1;
      S.form = pick(r, FORMS);
      S.fi = 0;
    }
    _section(S) {
      if (S.tuneIn) {
        // istasyona yeni girildi: giriş/ara yerine davullu bir bölümden (kıta / nakarat) başla
        S.tuneIn = false;
        for (let k = 0; k < 10; k++) {
          if (S.fi >= S.form.length) this._song(S);
          const ty = S.form[S.fi];
          if (ty === 1 || ty === 2) break;
          S.fi++;
        }
      }
      if (S.fi >= S.form.length) this._song(S);
      const r = S.rng, st = S.style;
      const type = S.type = S.form[S.fi++];
      const sb = SBARS[type];
      S.bars = r() < 0.5 ? sb[0] : sb[1];
      S.bar = 0;
      let L = LAY[st][type];
      // çeşitleme: bazen isteğe bağlı bir katman düşer
      if (type !== 0 && r() < 0.3) {
        const o = OPTL[st] & L;
        if (o) { let b = 1 << ((r() * 8) | 0); for (let k = 0; k < 8 && !(o & b); k++) b = b === 128 ? 1 : b << 1; L &= ~b; }
      }
      S.layers = L;
      S.fillOK = r() < 0.7;
      S.trem = st === SAZ && this.tremOK && r() < 0.5;
      S.dVer++;
      this._renew();
      S.holdN = 0;
      pat(S.kick, pick(r, PK[st]));
      pat(S.snare, pick(r, PS[st]));
      pat(S.hat, pick(r, PH[st]));
      // küçük rastgele süslemeler (tekrarı kırar)
      if (r() < 0.35) S.hat[15] = S.hat[15] ? 0 : C_X;
      if (r() < 0.25 && !S.kick[14]) S.kick[14] = C_X;
      if (st === HOU) {
        pat(S.ohat, pick(r, POH));
        pat(S.bass, pick(r, PB[HOU]));
        pat(S.harm, pick(r, PSTAB));
        if (r() < 0.4) S.harm[(r() * 16) | 0] = C_XX;
        S.sweep = type === 3;
      } else if (st === SYN) {
        pat(S.bass, pick(r, PB[SYN]));
        const s = pick(r, PARP), rate = r() < 0.75 ? 1 : 2, n = s.length;
        for (let i = 0; i < 16; i++) {
          if (i % rate) { S.arp[i] = -1; continue; }
          const ch = s.charCodeAt(((i / rate) | 0) % n) - 48;
          S.arp[i] = ch >= 0 && ch <= 9 ? ch : -1;
        }
      } else if (st === LOF) {
        pat(S.bass, pick(r, PB[LOF]));
        pat(S.harm, pick(r, PKEYS));
        lens(S.harm, S.harmL);
        if (r() < 0.3) { const k = 1 + ((r() * 7) | 0) * 2; if (!S.kick[k]) S.kick[k] = C_X; }
      } else {
        const B = PB[SAZ];
        pat(S.bass, type === 2 ? B[3 + ((r() * 2) | 0)] : B[(r() * 3) | 0]);
        pat(S.perc, pick(r, PDARB));
        const kp = type === 2 ? 0.3 : 0.15;
        for (let i = 1; i < 16; i += 2) if (!S.perc[i] && r() < kp) S.perc[i] = C_K;
      }
      lens(S.bass, S.bassL);
      // melodi: şarkının ilk melodili bölümünde yeni motif, sonrakilerde çeşitleme
      if (L & LL) {
        if (st === SAZ && type === 0) this._genLead(S, TAKSIM);
        else if (S.leadSong !== S.song) { this._genLead(S, LEADC[st]); S.leadSong = S.song; }
        else this._mutLead(S);
      }
    }
    _genLead(S, C) {
      const r = S.rng, N = S.lead, D = S.leadL, len = S.style === HOU ? 16 : 32;
      N.fill(NONE); D.fill(0);
      let pos = 0, deg = ((r() * 3) | 0) * 2, last = -1;
      while (pos < len) {
        if (pos > 0 && r() < C.rest) { pos += 1 + ((r() * 2) | 0); continue; }
        let d = C.durs[(r() * C.durs.length) | 0];
        if (pos + d > len) d = len - pos;
        N[pos] = deg; D[pos] = d; last = pos;
        pos += d;
        // çoğunlukla adım adım; ilk ölçü sonunda güçlüye, sonda durağa çekim
        let s = r() < 0.6 ? (r() < 0.5 ? -1 : 1) : r() < 0.6 ? (r() < 0.5 ? -2 : 2) : 0;
        const tgt = pos >= len - 5 ? 0 : (pos >= 11 && pos < 16 && len === 32) ? C.mid : -99;
        if (tgt > -99 && r() < 0.65) s = tgt > deg ? 1 : tgt < deg ? -1 : 0;
        deg += s;
        if (deg < C.lo) deg = C.lo + 1;
        if (deg > C.hi) deg = C.hi - 1;
      }
      if (last >= 0) N[last] = 0;
      if (len === 16) { N.copyWithin(16, 0, 16); D.copyWithin(16, 0, 16); }
    }
    _mutLead(S) {
      const r = S.rng, N = S.lead, C = LEADC[S.style];
      for (let k = 0, done = 0; k < 12 && done < 2; k++) {
        const p = (r() * 30) | 0;
        if (N[p] === NONE || N[p] === 0) continue;
        let d = N[p] + (r() < 0.5 ? -1 : 1);
        if (d < C.lo) d = C.lo; else if (d > C.hi) d = C.hi;
        N[p] = d; done++;
      }
    }
    // bölüm ortası çeşitlemesi (8 ölçülük bölümün ikinci yarısı ilkini birebir tekrar etmesin)
    _vary(S) {
      const r = S.rng, st = S.style;
      // zil: bir-iki tek adımı aç/kapa
      for (let k = 0; k < 2; k++) { const p = 1 + ((r() * 8) | 0) * 2; S.hat[p] = S.hat[p] ? 0 : C_X; }
      // davul: ilk vuruş sabit, araya bir vuruş ekle/çıkar (house dörtlüğü bozulmaz, açık zil değişir)
      if (st === HOU) { const p = 2 + ((r() * 4) | 0) * 4 + (r() < 0.5 ? 1 : 0); S.ohat[p] = S.ohat[p] ? 0 : C_X; }
      else { const p = 2 + ((r() * 13) | 0); if (p !== 4 && p !== 8 && p !== 12) S.kick[p] = S.kick[p] ? 0 : C_X; }
      // bas: bir vuruşun rengini değiştir ya da boş adıma vuruş ekle
      const bp = (r() * 16) | 0;
      if (S.bass[bp]) S.bass[bp] = S.bass[bp] === C_X ? (r() < 0.5 ? C_O : C_F) : C_X;
      else if (bp > 0) S.bass[bp] = C_X;
      lens(S.bass, S.bassL);
      if (st === HOU || st === LOF) {
        // akor vuruşu: birini bir adım kaydır ya da ekle
        const hp = 1 + ((r() * 14) | 0);
        if (S.harm[hp] && !S.harm[hp + 1]) { S.harm[hp + 1] = S.harm[hp]; S.harm[hp] = 0; } else if (!S.harm[hp]) S.harm[hp] = C_X;
        if (st === LOF) lens(S.harm, S.harmL);
      } else if (st === SYN) {
        // arpej: desen 1-3 adım döner
        const sh = 1 + ((r() * 3) | 0), a = S.arp;
        for (let k = 0; k < sh; k++) { const f = a[0]; a.copyWithin(0, 1, 16); a[15] = f; }
      } else {
        // darbuka: bir "ka" ekle/çıkar
        const p = 1 + ((r() * 8) | 0) * 2;
        S.perc[p] = S.perc[p] === C_K ? 0 : S.perc[p] ? S.perc[p] : C_K;
      }
      if (S.layers & LL) this._mutLead(S);
      S.dVer++;
    }
    _barStart(S, t) {
      if (S.bars >= 8 && S.bar === (S.bars >> 1)) this._vary(S);
      const ci = ((S.bar / S.cb) | 0) % S.pn, ni = (((S.bar + 1) / S.cb) | 0) % S.pn;
      const newChord = S.bar % S.cb === 0;
      if (S.style === SAZ) {
        S.chD = S.pr[ci];
        S.chS = this._deg(S, S.chD); S.nxS = this._deg(S, S.pr[ni]);
        S.chQ = (S.chD === 0 || S.chD === 3) ? Q_5 : Q_OCT;
      } else {
        // akor kökü -5..6 aralığına (sesler fazla tırmanmasın)
        const a = S.pr[ci], b = S.pr[ni];
        S.chS = a > 6 ? a - 12 : a; S.nxS = b > 6 ? b - 12 : b; S.chQ = S.pq[ci];
      }
      S.fill = S.fillOK && S.bar === S.bars - 1;
      let L = S.layers;
      if (S.type === 0 && S.bar >= (S.bars >> 1)) L |= BUILD[S.style];
      S.lay = L;
      const sd = this.sd, barT = sd * 16, ses = this.ses;
      // uzun akor / dem sesi (akor değişiminde, akor süresince)
      if (newChord && (L & LP)) {
        const len = Math.min(S.cb, S.bars - S.bar) * barT;
        if (S.style === SAZ) this._trigN(this._vP(this.droneN), S.key - 12 + S.chS, S.chQ, t, 0.05, 0.4, 0, len, 0.35);
        else if (this.padN >= 2) this._trigN(this._vP(this.padN), S.key + S.chS, S.chQ, t, S.style === HOU ? 0.03 : 0.035, 0.35, 0, len, 0.4);
      }
      // house arası: akor süzgeci ölçü ölçü açılır
      if (S.style === HOU) {
        const f = S.sweep ? 350 + 3400 * ((S.bar + 1) / S.bars) : this.mix.hf;
        ses.h.frequency.setTargetAtTime(f, t, S.sweep ? barT * 0.4 : 0.05);
      }
      // lo-fi plak cızırtısı (T2+; tek döngü kaynağı)
      if (S.style === LOF && this.crackle && !ses.crk && (L & LX) && this._kit[K_CRK]) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._kit[K_CRK]; src.loop = true;
        src.connect(ses.d); src.onended = onEnd; src.start(t);
        ses.crk = src;
      }
    }

    // ---- Drift FM: synthwave (davullar ölçü tamponunda) ----
    _syn(S, i, t) {
      const L = S.lay, sd = this.sd;
      if ((L & LB) && S.bass[i]) this._bass(S, i, t, 0.21);
      if (L & LA) {
        const k = S.arp[i];
        if (k >= 0) {
          const A = ARP[S.chQ], n = A.length, o = (k / n) | 0;
          this._trig1(this._vA(), MTOF[S.key + 12 + S.chS + A[k - o * n] + 12 * o], t, 0.075, 0.003, sd * 0.22, sd * 0.95, 0);
        }
      }
      if (L & LL) this._lead(S, i, t, 0.065, 0);
    }
    // ---- Sokak Beat: house ----
    _hou(S, i, t) {
      const L = S.lay;
      if ((L & LB) && S.bass[i]) this._bass(S, i, t, 0.17);
      if ((L & LA) && S.harm[i]) this._trigN(this._vS(this.stabN), S.key + S.chS, S.chQ, t, S.harm[i] === C_XX ? 0.05 : 0.038, 0.003, 0.09, 0.24, 0.05);
      if (L & LL) this._lead(S, i, t, 0.035, 0);
    }
    // ---- Lo-Fi Gece: lo-fi hip-hop ----
    _lof(S, i, t) {
      const L = S.lay, sd = this.sd;
      if ((L & LB) && S.bass[i]) this._bass(S, i, t, 0.3);
      if ((L & LA) && S.harm[i]) {
        const len = Math.min(S.harmL[i] * sd, 2.2), j = this._jit();
        this._trigN(this._vS(this.keysN), S.key + S.chS, S.chQ, t + j * 0.01, 0.055 * (0.85 + j * 0.3), 0.012, 0.7, len, 0.12);
      }
      if (L & LL) this._lead(S, i, t, 0.075, 0);
    }
    // ---- Saz Wave: hicaz / uşşak + darbuka ----
    _saz(S, i, t) {
      const L = S.lay;
      if ((L & LB) && S.bass[i]) this._bass(S, i, t, 0.15);
      if (L & LL) this._lead(S, i, t, 0.1, 1);
    }
    _bass(S, i, t, v) {
      const c = S.bass[i];
      let m = S.key - 24 + S.chS;
      if (c === C_O) m += 12;
      else if (c === C_F) m += 7;
      else if (c === C_A) m = S.nxS === S.chS ? m + 7 : S.key - 24 + S.nxS - 1;
      const len = S.bassL[i] * this.sd * 0.92;
      this._trig1(this._vB(), mtof(m), t, c === C_XX ? v * 1.25 : v, 0.004, len * 0.55 + 0.03, len, 0);
    }
    // melodi (tek ses, legato: nota bir sonrakine kadar sürer); saz: bükerek giriş, uzun notada mızrap tremolosu
    _lead(S, i, t, v, saz) {
      const k = ((S.bar & 1) << 4) + i, d = S.lead[k], sd = this.sd;
      if (d === NONE) {
        if (saz && S.holdN > 0) {
          S.holdN--;
          this._trig1(this._vL(), mtof(S.key + 12 + this._deg(S, S.holdD)), t, v * (0.45 + 0.1 * S.holdN), 0.003, sd * 0.5, sd * 0.98, 0);
        }
        return;
      }
      const n = S.leadL[k], f = mtof(S.key + 12 + this._deg(S, d));
      if (saz) {
        S.holdN = 0;
        if (S.trem && n >= 3) {
          // mızrap: uzun notayı 16'lıklarla yeniden çal
          S.holdD = d; S.holdN = n - 1;
          this._trig1(this._vL(), f, t, v, 0.003, sd * 0.6, sd * 0.98, 0.985);
        } else {
          // çarpma: uzun notaya üst komşudan, kısalara hafif alttan bükerek gir
          const up = n >= 4 && this._jit() < 0.4;
          const bend = up ? mtof(S.key + 12 + this._deg(S, d + 1)) / f : 0.985;
          this._trig1(this._vL(), f, t, v, 0.003, Math.min(0.5, n * sd * 0.5), n * sd * 0.98, bend);
        }
        return;
      }
      const len = n * sd * 0.97;
      this._trig1(this._vL(), f, t, v, S.style === LOF ? 0.02 : 0.008, Math.max(0.08, len * 0.7), len, 0);
    }
  }

  Radio.STATIONS = STATIONS;
  DS.RADIO_STATIONS = STATIONS;
  DS.Radio = Radio;
})();
