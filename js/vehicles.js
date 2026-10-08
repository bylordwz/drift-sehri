'use strict';
// Açık şehir verileri: araç kadrosu (yalnız çalınabilir), trafik varyantları, yaya paletleri, ortak sabitler
(function () {
  const DS = window.DS;

  // ---------- ortak sabitler (SPEC §2.2) ----------
  DS.VM = { RAIL: 0, PHYS: 1, PARKED: 2, WRECK: 3, HELD: 4 };          // araç kaydı modu
  DS.PS = { WANDER: 0, WAIT: 1, CROSS: 2, DODGE: 3, FLEE: 4, FALL: 5, DOWN: 6, GETUP: 7,
            IDLE: 8, COP: 9, WAVE: 10, GOTO: 11, GONE: 255 };           // yaya durumu
  DS.PR = { CIV: 0, COP: 1, MISSION: 2, DRIVER: 3 };                     // yaya rolü
  DS.POSE = { IDLE: 0, WALK: 1, RUN: 2, FALL: 3, DOWN: 4, PUNCH: 5, GETIN: 6, WAVE: 7, PANIC: 8 }; // çizim pozu

  // ---------- araç kadrosu (SPEC §3.1) ----------
  // DS.Car tanımıyla uyumlu + dünya alanları: cls, value (₺), maxHp, siren. price: null = satın alınamaz.
  // DS.CARS'a EKLENMEZ (park araçlarının modeli DS.CARS.length'e bağlı).
  const SEDAN = { nose: 0.15, tail: 0.13, taperF: 0.94, taperR: 0.96, hood: 0.27, wind: 0.14, roof: 0.27, rear: 0.14, cabin: 0.8, popups: false };
  const SEDAN_GEARS = [3.45, 2.05, 1.38, 1.0, 0.8];
  DS.VEHICLES = [
    {
      id: 'sedan', name: 'SEDAN', price: null, cls: 'car', value: 2500, maxHp: 1000, siren: false,
      desc: 'Sıradan aile sedanı. Yavaş ama sağlam; şehrin her köşesinde bir tane var.',
      len: 4.6, wid: 1.78, mass: 1250, wb: 2.65, fw: 0.57, cgH: 0.55,
      torque: 200, idle: 800, redline: 6200, gears: SEDAN_GEARS.slice(), final: 3.9,
      turbo: 0, voice: 'i4', mu: 0.97, steer: 38, pos: 0.16, brake: 10500,
      color: '#8a8f98', num: '', exhaust: -0.5,
      shape: Object.assign({}, SEDAN),
    },
    {
      id: 'hatch', name: 'HATCH', price: null, cls: 'car', value: 1800, maxHp: 1000, siren: false,
      desc: 'Küçük şehir arabası. Hafif, çevik, park yeri derdi yok.',
      len: 3.95, wid: 1.68, mass: 1020, wb: 2.45, fw: 0.6, cgH: 0.55,
      torque: 150, idle: 850, redline: 6500, gears: [3.6, 2.1, 1.4, 1.03, 0.84], final: 4.1,
      turbo: 0, voice: 'i4', mu: 0.95, steer: 40, pos: 0.12, brake: 9000,
      color: '#c8102e', num: '', exhaust: -0.45,
      shape: { nose: 0.18, tail: 0.1, taperF: 0.92, taperR: 0.97, hood: 0.24, wind: 0.15, roof: 0.33, rear: 0.08, cabin: 0.82, popups: false, hatch: true },
    },
    {
      id: 'taxi', name: 'TAKSİ', price: null, cls: 'taxi', value: 2200, maxHp: 1000, siren: false,
      desc: 'Sarı şehir taksisi. İçine binersen müşteri taşıyıp para kazanabilirsin.',
      len: 4.6, wid: 1.78, mass: 1260, wb: 2.65, fw: 0.57, cgH: 0.55,
      torque: 210, idle: 800, redline: 6200, gears: SEDAN_GEARS.slice(), final: 3.9,
      turbo: 0, voice: 'i4', mu: 0.97, steer: 38, pos: 0.16, brake: 10500,
      color: '#ffc400', num: '', exhaust: -0.5,
      shape: Object.assign({}, SEDAN),
    },
    {
      id: 'polis', name: 'POLİS', price: null, cls: 'cop', value: 6000, maxHp: 1000, siren: true,
      desc: 'Ekip aracı. Güçlü V8, sert fren; çalmak pahalıya patlar.',
      len: 4.85, wid: 1.86, mass: 1560, wb: 2.8, fw: 0.55, cgH: 0.52,
      torque: 440, idle: 800, redline: 6800, gears: [2.9, 1.9, 1.35, 1.0, 0.78], final: 3.6,
      turbo: 0, voice: 'v8', mu: 1.08, steer: 42, pos: 0.24, brake: 15000,
      color: '#f4f6f8', num: '155', exhaust: 0.55, dual: true,
      shape: Object.assign({}, SEDAN, { hood: 0.3, roof: 0.26 }),
    },
    {
      id: 'van', name: 'PANELVAN', price: null, cls: 'van', value: 3000, maxHp: 1000, siren: false,
      desc: 'Kargo minibüsü. Ağır ve hantal ama her şeyi taşır.',
      len: 5.1, wid: 1.98, mass: 2050, wb: 3.2, fw: 0.55, cgH: 0.8,
      torque: 310, idle: 750, redline: 4800, gears: [3.8, 2.2, 1.45, 1.0], final: 4.1,
      turbo: 0.2, voice: 'i6', mu: 0.92, steer: 36, pos: 0.08, brake: 14000,
      color: '#f2efe6', num: '', exhaust: -0.6,
      shape: { nose: 0.06, tail: 0.05, taperF: 0.97, taperR: 0.99, hood: 0.1, wind: 0.1, roof: 0.74, rear: 0.04, cabin: 0.94, popups: false, hatch: true },
    },
    {
      id: 'kamyon', name: 'KAMYON', price: null, cls: 'truck', value: 4000, maxHp: 1400, siren: false,
      desc: 'Sanayi kamyonu. Durdurulamaz bir kütle; virajlarda sabır ister.',
      len: 6.6, wid: 2.3, mass: 4800, wb: 4.0, fw: 0.45, cgH: 1.1,
      torque: 900, idle: 650, redline: 3400, gears: [4.5, 2.6, 1.6, 1.0], final: 3.9,
      turbo: 0.15, voice: 'v8', mu: 0.88, steer: 34, pos: 0.05, brake: 30000,
      color: '#2f6f4f', num: '', exhaust: -0.7,
      shape: { nose: 0.04, tail: 0.03, taperF: 0.98, taperR: 1, hood: 0.08, wind: 0.08, roof: 0.8, rear: 0.04, cabin: 0.96, popups: false, hatch: true },
    },
    {
      id: 'sport', name: 'SPOR', price: null, cls: 'sport', value: 9000, maxHp: 1000, siren: false,
      desc: 'Turbo spor araba. Hızlı, kıvrak, drift için doğmuş.',
      len: 4.45, wid: 1.86, mass: 1380, wb: 2.55, fw: 0.52, cgH: 0.47,
      torque: 390, idle: 900, redline: 7600, gears: [3.1, 2.0, 1.45, 1.12, 0.9], final: 3.8,
      turbo: 0.3, voice: 'i6', mu: 1.06, steer: 46, pos: 0.3, brake: 13500,
      color: '#ff6a13', num: '', exhaust: 0.5, dual: true,
      shape: { nose: 0.2, tail: 0.16, taperF: 0.9, taperR: 0.95, hood: 0.38, wind: 0.13, roof: 0.17, rear: 0.16, cabin: 0.74, popups: false, scoop: true },
    },
  ];

  // Önce kadro, sonra drift araçları; bulunamazsa sedan
  DS.vehById = (id) => {
    for (let i = 0; i < DS.VEHICLES.length; i++) if (DS.VEHICLES[i].id === id) return DS.VEHICLES[i];
    const cars = DS.CARS || [];
    for (let i = 0; i < cars.length; i++) if (cars[i].id === id) return cars[i];
    return DS.VEHICLES[0];
  };

  // ---------- trafik varyantları (SPEC §3.2; sıra önemli, ilk Q.carVariants kullanılır) ----------
  // w: ağırlık; zone: 'ind' | 'drift' | null — doğma noktası o bölgedeyse ağırlık × zm (3)
  const TV = (id, color, w, o) => Object.assign({ id, color, livery: 'none', bar: false, sign: false, w, role: 'civ', zone: null, zm: 1 }, o || {});
  const IND = { zone: 'ind', zm: 3 }, DRIFT = { zone: 'drift', zm: 3 };
  DS.TRAFFIC_VARIANTS = [
    TV('sedan', '#8a8f98', 10),                                                  // 0
    TV('hatch', '#c8102e', 7),                                                   // 1
    TV('taxi', '#ffc400', 6, { livery: 'taksi', sign: true, role: 'taxi' }),     // 2
    TV('sedan', '#1d4e9e', 8),                                                   // 3
    TV('van', '#f2efe6', 5, IND),                                                // 4
    TV('hatch', '#f2efe6', 6),                                                   // 5
    TV('polis', '#f4f6f8', 3, { livery: 'polis', bar: true, role: 'cop' }),      // 6
    TV('sedan', '#1b1d22', 6),                                                   // 7
    TV('kamyon', '#2f6f4f', 3, IND),                                             // 8
    TV('sport', '#ff6a13', 2, DRIFT),                                            // 9
    TV('hatch', '#7fd1ff', 4),                                                   // 10
    TV('sedan', '#b5a27a', 5),                                                   // 11
    TV('kumo', '#5b2a86', 1, DRIFT),                                             // 12 (DS.CARS)
    TV('van', '#8a8f98', 3, IND),                                                // 13
    TV('sedan', '#2f6f4f', 4),                                                   // 14
    TV('hatch', '#ffc400', 3),                                                   // 15
    TV('oni', '#1b1d22', 1, DRIFT),                                              // 16 (DS.CARS)
    TV('sport', '#e4007c', 1, DRIFT),                                            // 17
  ];

  // Varyant başına paylaşılan, dondurulmuş, eksiksiz kurulum (asla değiştirme; renk için kopyala)
  const SETUPS = [];
  DS.variantSetup = (i) => {
    const n = DS.TRAFFIC_VARIANTS.length;
    i = i < 0 || i >= n || i !== (i | 0) ? 0 : i;
    let s = SETUPS[i];
    if (!s) {
      const v = DS.TRAFFIC_VARIANTS[i];
      s = SETUPS[i] = Object.freeze({
        color: v.color, livery: v.livery, wing: false, rim: '#b8b8b8', glow: 'none', smoke: '#f4f4f4',
        upg: Object.freeze({}), bar: v.bar, sign: v.sign,
      });
    }
    return s;
  };

  // ---------- yaya paletleri (SPEC §3.4) ----------
  // 0 oyuncu, 1 polis, 2..17 siviller (ilk Q.pedPalettes sivil kullanılır)
  const P = (skin, shirt, pants, hair, cap, badge) => ({ skin, shirt, pants, hair, cap: cap || null, badge: !!badge });
  DS.PED_PALETTES = [
    P('#e0b48c', '#ff8a1f', '#22262e', '#1b1410'),                     // 0 oyuncu
    P('#d9a77f', '#1f3a6e', '#16233f', '#1b1410', '#14213d', true),    // 1 polis
    P('#f1c9a5', '#c8102e', '#2b2f3a', '#3b2a1e'),                     // 2
    P('#c58c62', '#1d9e74', '#3a3f4b', '#120d0a'),                     // 3
    P('#8d5a3b', '#ffd400', '#1b1d22', '#120d0a'),                     // 4
    P('#e0b48c', '#2e6db2', '#4a3b2a', '#b8862d'),                     // 5
    P('#f1c9a5', '#5b2a86', '#22262e', '#d9d2c5'),                     // 6
    P('#6b4430', '#f2efe6', '#2b2f3a', '#120d0a'),                     // 7
    P('#c58c62', '#ff6a13', '#1b1d22', '#3b2a1e'),                     // 8
    P('#e0b48c', '#38d9ff', '#3a3f4b', '#1b1410'),                     // 9
    P('#8d5a3b', '#ff4fd8', '#2b2f3a', '#120d0a'),                     // 10
    P('#f1c9a5', '#ffd400', '#4a3b2a', '#b8862d'),                     // 11
    P('#e0b48c', '#7ac143', '#22262e', '#1b1410', '#c8102e'),          // 12
    P('#c58c62', '#f2efe6', '#3a3f4b', '#3b2a1e'),                     // 13
    P('#6b4430', '#ff3a3a', '#1b1d22', '#120d0a'),                     // 14
    P('#f1c9a5', '#38d9ff', '#2b2f3a', '#8a5a2b', '#1b1d22'),          // 15
    P('#e0b48c', '#8a8f98', '#4a3b2a', '#d9d2c5'),                     // 16
    P('#8d5a3b', '#b23a2e', '#22262e', '#120d0a'),                     // 17
  ];
})();
