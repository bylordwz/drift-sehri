'use strict';
// Ortak yardımcılar: matematik, rastgelelik, renk, kayıt
(function () {
  const DS = (window.DS = window.DS || {});
  const U = (DS.U = {});
  const PI = Math.PI, TAU = PI * 2;
  U.PI = PI;
  U.TAU = TAU;

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.smooth = (e0, e1, v) => {
    const t = U.sat((v - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  U.approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
  U.wrap = (a) => {
    a = (a + PI) % TAU;
    if (a < 0) a += TAU;
    return a - PI;
  };
  U.alerp = (a, b, t) => a + U.wrap(b - a) * t;
  U.sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
  U.damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

  // Mulberry32 — tohumlu, tekrarlanabilir rastgele sayı
  U.rng = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  U.rand = (a, b) => a + Math.random() * (b - a);
  U.hash = (x, y) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  U.canvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  };

  U.hex2rgb = (hex) => {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  U.rgb = (r, g, b, a) =>
    a === undefined
      ? `rgb(${r | 0},${g | 0},${b | 0})`
      : `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  // f > 0 açar, f < 0 koyulaştırır
  U.shade = (hex, f, a) => {
    const [r, g, b] = U.hex2rgb(hex);
    if (f >= 0) return U.rgb(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f, a);
    return U.rgb(r * (1 + f), g * (1 + f), b * (1 + f), a);
  };
  U.luma = (hex) => {
    const [r, g, b] = U.hex2rgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  };

  U.store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : d;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        /* depolama kapalı olabilir */
      }
    },
  };

  U.fmt = (n) => Math.round(n).toLocaleString('tr-TR');
  U.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Nokta ile eksen hizalı kutu arası mesafe
  U.distPointBox = (px, py, x0, y0, x1, y1) => {
    const dx = Math.max(x0 - px, 0, px - x1);
    const dy = Math.max(y0 - py, 0, py - y1);
    return Math.hypot(dx, dy);
  };
})();
