'use strict';
// Araçlar, parçalar, renk paletleri
(function () {
  const DS = window.DS;

  // Sürüş hissi ayarları (tüm araçlar)
  DS.TUNE = { cr: 1.65, s0: 0.04, s1: 0.2, posK: 1.6 };

  // Tüm uzunluklar metre, kütle kg, tork N·m.
  // fw: ön aksa düşen ağırlık oranı, pos: güç-savrulma (power oversteer) eğilimi
  DS.CARS = [
    {
      id: 'hachi', name: 'HACHI', price: 0,
      desc: 'Hafif hatchback. Az güç ama çok dengeli; drift okulunun klasiği.',
      len: 4.2, wid: 1.64, mass: 960, wb: 2.4, fw: 0.53, cgH: 0.5,
      torque: 172, idle: 900, redline: 7800, gears: [3.59, 2.02, 1.38, 1.0, 0.86], final: 4.3,
      turbo: 0, voice: 'i4', mu: 1.02, steer: 44, pos: 0.3, brake: 9500,
      color: '#f2efe6', num: '86', exhaust: -0.45,
      shape: { nose: 0.16, tail: 0.12, taperF: 0.93, taperR: 0.97, hood: 0.28, wind: 0.13, roof: 0.27, rear: 0.21, cabin: 0.8, popups: true, hatch: true },
    },
    {
      id: 'kumo', name: 'KUMO', price: 8000,
      desc: 'Turbo coupe. Dengeli şasi, kolay drift; sokakların en sevileni.',
      len: 4.52, wid: 1.69, mass: 1180, wb: 2.47, fw: 0.54, cgH: 0.5,
      torque: 285, idle: 850, redline: 7200, gears: [3.32, 1.9, 1.31, 1.0, 0.76], final: 4.1,
      turbo: 0.35, voice: 'i4t', mu: 1.04, steer: 48, pos: 0.32, brake: 11000,
      color: '#c8102e', num: '13', exhaust: 0.5,
      shape: { nose: 0.2, tail: 0.14, taperF: 0.92, taperR: 0.96, hood: 0.34, wind: 0.12, roof: 0.2, rear: 0.11, cabin: 0.78, popups: false },
    },
    {
      id: 'kaze', name: 'KAZE', price: 15000,
      desc: 'Rotary motor, 8600 devir. Çığlık atan sesi ve keskin girişleriyle.',
      len: 4.33, wid: 1.69, mass: 1230, wb: 2.43, fw: 0.5, cgH: 0.48,
      torque: 255, idle: 950, redline: 8600, gears: [3.48, 2.02, 1.39, 1.0, 0.72], final: 4.3,
      turbo: 0.4, voice: 'rotary', mu: 1.05, steer: 48, pos: 0.34, brake: 11500,
      color: '#1d4e9e', num: '7', exhaust: 0.5,
      shape: { nose: 0.22, tail: 0.2, taperF: 0.9, taperR: 0.95, hood: 0.36, wind: 0.13, roof: 0.17, rear: 0.2, cabin: 0.76, popups: true },
    },
    {
      id: 'oni', name: 'ONI', price: 25000,
      desc: 'Uzun dingilli sedan, sıralı 6 turbo. Yüksek hızda tam açı.',
      len: 4.76, wid: 1.76, mass: 1440, wb: 2.73, fw: 0.55, cgH: 0.52,
      torque: 430, idle: 800, redline: 7000, gears: [3.25, 1.96, 1.3, 1.0, 0.75], final: 3.9,
      turbo: 0.45, voice: 'i6', mu: 1.07, steer: 50, pos: 0.32, brake: 13000,
      color: '#1b1d22', num: '100', exhaust: 0.55,
      shape: { nose: 0.14, tail: 0.1, taperF: 0.95, taperR: 0.97, hood: 0.31, wind: 0.13, roof: 0.24, rear: 0.11, cabin: 0.8, popups: false },
    },
    {
      id: 'ronin', name: 'RONIN', price: 40000,
      desc: 'Amerikan V8 kas aracı. Ham tork, dumana boğan arka lastikler.',
      len: 4.8, wid: 1.9, mass: 1560, wb: 2.72, fw: 0.55, cgH: 0.53,
      torque: 540, idle: 750, redline: 6800, gears: [2.66, 1.78, 1.3, 1.0, 0.8], final: 3.73,
      turbo: 0, voice: 'v8', mu: 1.06, steer: 46, pos: 0.3, brake: 14000,
      color: '#2f6f4f', num: '5', exhaust: 0.6, dual: true,
      shape: { nose: 0.12, tail: 0.12, taperF: 0.94, taperR: 0.96, hood: 0.38, wind: 0.12, roof: 0.18, rear: 0.2, cabin: 0.74, popups: false, scoop: true },
    },
  ];
  DS.carById = (id) => DS.CARS.find((c) => c.id === id) || DS.CARS[0];

  // Performans parçaları — seviye 0 her araçta hazır gelir
  DS.UPGRADES = [
    { key: 'engine', name: 'Motor', info: 'Tork artışı', levels: [
      { v: 1.0, label: 'Stok' }, { v: 1.12, label: 'Sokak', cost: 2500 },
      { v: 1.25, label: 'Spor', cost: 5000 }, { v: 1.4, label: 'Yarış', cost: 9000 } ] },
    { key: 'turbo', name: 'Turbo', info: 'Yüksek devirde ek güç', levels: [
      { v: 0, label: 'Stok' }, { v: 0.2, label: 'Küçük', cost: 3500 }, { v: 0.4, label: 'Büyük', cost: 8000 } ] },
    { key: 'tires', name: 'Lastik', info: 'Yol tutuşu', levels: [
      { v: 1.0, label: 'Sokak' }, { v: 1.06, label: 'Yarı slick', cost: 2000 }, { v: 1.12, label: 'Slick', cost: 4500 } ] },
    { key: 'angle', name: 'Açı kiti', info: 'Ek direksiyon açısı', levels: [
      { v: 0, label: 'Stok' }, { v: 8, label: '+8°', cost: 2500 }, { v: 16, label: '+16°', cost: 6000 } ] },
    { key: 'diff', name: 'Diferansiyel', info: 'Arka kayma karakteri', levels: [
      { v: 1.0, label: 'LSD' }, { v: 1.25, label: 'Kaynaklı', cost: 3000 } ] },
  ];

  DS.PAINTS = ['#f2efe6', '#c8102e', '#ff6a13', '#ffc400', '#7ac143', '#1f8a70', '#1d4e9e', '#5b2a86',
    '#e4007c', '#1b1d22', '#8a8f98', '#b5a27a', '#7fd1ff', '#ff8fab'];
  DS.SMOKES = ['#f4f4f4', '#9a9a9a', '#3a3a3a', '#ff3a3a', '#ff8a1f', '#ffd400', '#4cff8a', '#38d9ff',
    '#3a6bff', '#a24bff', '#ff4fd8'];
  DS.RIMS = ['#d9d9d9', '#1a1a1a', '#d4af37', '#ff3a3a', '#38d9ff', '#ffffff'];
  DS.GLOWS = ['none', '#38d9ff', '#ff4fd8', '#7cff6b', '#ffb23e', '#ff3a3a'];
  DS.LIVERIES = [
    { id: 'none', name: 'Düz' },
    { id: 'stripes', name: 'Çift şerit' },
    { id: 'panda', name: 'Panda' },
    { id: 'number', name: 'Yarış no.' },
    { id: 'tiger', name: 'Kaplan' },
    { id: 'split', name: 'İki renk' },
    { id: 'sticker', name: 'Sticker' },
  ];

  DS.RATINGS = [
    [0, 'İYİ'], [1500, 'GÜZEL'], [4000, 'HARİKA'], [9000, 'MÜTHİŞ'], [18000, 'EFSANE'], [35000, 'TANRISAL'],
  ];

  DS.defaultCarSetup = (def) => ({
    color: def.color,
    livery: def.id === 'hachi' ? 'panda' : 'none',
    rim: '#d9d9d9',
    smoke: '#f4f4f4',
    wing: def.id === 'kumo' || def.id === 'kaze',
    glow: 'none',
    upg: { engine: 0, turbo: 0, tires: 0, angle: 0, diff: 0 },
  });
})();
