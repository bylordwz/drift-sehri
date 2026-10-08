'use strict';
// Yönlendirilmiş kutu (OBB) çarpışma testleri ve impuls çözümü
(function () {
  const DS = window.DS, U = DS.U;
  const C = (DS.Collide = {});

  // o: {x, y, c, s, hl, hw} — c/s: açı kosinüs/sinüsü, hl: yarı uzunluk, hw: yarı genişlik
  // Dönen temas: {px, py, nx, ny, pen} — n, a gövdesini b'den dışarı iten yön
  C.obbObb = (a, b) => {
    let best = null;
    // a'nın köşeleri b'nin içinde mi?
    for (let k = 0; k < 4; k++) {
      const lx0 = k & 1 ? a.hl : -a.hl, ly0 = k & 2 ? a.hw : -a.hw;
      const px = a.x + a.c * lx0 - a.s * ly0;
      const py = a.y + a.s * lx0 + a.c * ly0;
      const dx = px - b.x, dy = py - b.y;
      const lx = b.c * dx + b.s * dy, ly = -b.s * dx + b.c * dy;
      if (Math.abs(lx) < b.hl && Math.abs(ly) < b.hw) {
        const penX = b.hl - Math.abs(lx), penY = b.hw - Math.abs(ly);
        let nx, ny, pen;
        if (penX < penY) {
          const sx = lx < 0 ? -1 : 1;
          nx = b.c * sx; ny = b.s * sx; pen = penX;
        } else {
          const sy = ly < 0 ? -1 : 1;
          nx = -b.s * sy; ny = b.c * sy; pen = penY;
        }
        if (!best || pen > best.pen) best = { px, py, nx, ny, pen };
      }
    }
    // b'nin köşeleri a'nın içinde mi?
    for (let k = 0; k < 4; k++) {
      const lx0 = k & 1 ? b.hl : -b.hl, ly0 = k & 2 ? b.hw : -b.hw;
      const px = b.x + b.c * lx0 - b.s * ly0;
      const py = b.y + b.s * lx0 + b.c * ly0;
      const dx = px - a.x, dy = py - a.y;
      const lx = a.c * dx + a.s * dy, ly = -a.s * dx + a.c * dy;
      if (Math.abs(lx) < a.hl && Math.abs(ly) < a.hw) {
        const penX = a.hl - Math.abs(lx), penY = a.hw - Math.abs(ly);
        let nx, ny, pen;
        if (penX < penY) {
          const sx = lx < 0 ? -1 : 1;
          nx = -a.c * sx; ny = -a.s * sx; pen = penX;
        } else {
          const sy = ly < 0 ? -1 : 1;
          nx = a.s * sy; ny = -a.c * sy; pen = penY;
        }
        if (!best || pen > best.pen) best = { px, py, nx, ny, pen };
      }
    }
    return best;
  };

  const tmpBox = { x: 0, y: 0, c: 1, s: 0, hl: 0, hw: 0 };
  C.obbBox = (o, x0, y0, x1, y1) => {
    tmpBox.x = (x0 + x1) * 0.5; tmpBox.y = (y0 + y1) * 0.5;
    tmpBox.hl = (x1 - x0) * 0.5; tmpBox.hw = (y1 - y0) * 0.5;
    return C.obbObb(o, tmpBox);
  };

  C.obbCircle = (o, cx, cy, r) => {
    const dx0 = cx - o.x, dy0 = cy - o.y;
    const lx = o.c * dx0 + o.s * dy0, ly = -o.s * dx0 + o.c * dy0;
    const qx = U.clamp(lx, -o.hl, o.hl), qy = U.clamp(ly, -o.hw, o.hw);
    const dx = lx - qx, dy = ly - qy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return null;
    let nlx, nly, pen, cx2 = qx, cy2 = qy;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      nlx = -dx / d; nly = -dy / d; pen = r - d;
    } else {
      const px = o.hl - Math.abs(lx), py = o.hw - Math.abs(ly);
      if (px < py) { nlx = lx < 0 ? 1 : -1; nly = 0; pen = px + r; }
      else { nlx = 0; nly = ly < 0 ? 1 : -1; pen = py + r; }
      cx2 = lx; cy2 = ly;
    }
    return {
      px: o.x + o.c * cx2 - o.s * cy2,
      py: o.y + o.s * cx2 + o.c * cy2,
      nx: o.c * nlx - o.s * nly,
      ny: o.s * nlx + o.c * nly,
      pen,
    };
  };

  // Gövde: {x, y, vx, vy, w, m, I}. ovx/ovy: karşı cismin hızı (kinematik)
  // Dönüş: {vn: çarpma hızı (normal), vt: sürtünme yönündeki hız}
  C.resolve = (b, ct, e, mu, ovx, ovy) => {
    const corr = Math.min(ct.pen, 0.6) * 0.92;
    b.x += ct.nx * corr;
    b.y += ct.ny * corr;
    const rx = ct.px - b.x, ry = ct.py - b.y;
    const rvx = b.vx - b.w * ry - (ovx || 0);
    const rvy = b.vy + b.w * rx - (ovy || 0);
    const vn = rvx * ct.nx + rvy * ct.ny;
    const tvx = rvx - vn * ct.nx, tvy = rvy - vn * ct.ny;
    const vt = Math.hypot(tvx, tvy);
    if (vn >= 0) return { vn: 0, vt };
    const invM = 1 / b.m, invI = 1 / b.I;
    const rn = rx * ct.ny - ry * ct.nx;
    const j = (-(1 + e) * vn) / (invM + rn * rn * invI);
    b.vx += j * ct.nx * invM;
    b.vy += j * ct.ny * invM;
    b.w += rn * j * invI;
    if (vt > 1e-4) {
      const tx = tvx / vt, ty = tvy / vt;
      const rt = rx * ty - ry * tx;
      let jt = -vt / (invM + rt * rt * invI);
      jt = U.clamp(jt, -mu * j, mu * j);
      b.vx += jt * tx * invM;
      b.vy += jt * ty * invM;
      b.w += rt * jt * invI;
    }
    return { vn: -vn, vt };
  };

  // İki dinamik gövde: a ve b {x,y,vx,vy,w,m,I}. ct.n a'yı b'den dışarı iter.
  // Konum düzeltmesi ters kütle oranıyla bölünür. Dönen nesne paylaşılır (saklama!).
  // Dönüş: {vn: yaklaşma hızı (normal, > 0 çarpışıyor), vt: teğetsel kayma hızı}
  const R2 = { vn: 0, vt: 0 };
  C.resolve2 = (a, b, ct, e, mu) => {
    const ima = 1 / a.m, imb = 1 / b.m, ia = 1 / a.I, ib = 1 / b.I;
    const sum = ima + imb;
    const corr = Math.min(ct.pen, 0.6) * 0.92;
    const ka = ima / sum, kb = imb / sum;
    a.x += ct.nx * corr * ka; a.y += ct.ny * corr * ka;
    b.x -= ct.nx * corr * kb; b.y -= ct.ny * corr * kb;
    const rax = ct.px - a.x, ray = ct.py - a.y;
    const rbx = ct.px - b.x, rby = ct.py - b.y;
    // temas noktasındaki bağıl hız (a − b)
    const rvx = a.vx - a.w * ray - (b.vx - b.w * rby);
    const rvy = a.vy + a.w * rax - (b.vy + b.w * rbx);
    const vn = rvx * ct.nx + rvy * ct.ny;
    const tvx = rvx - vn * ct.nx, tvy = rvy - vn * ct.ny;
    const vt = Math.sqrt(tvx * tvx + tvy * tvy);
    R2.vt = vt;
    if (vn >= 0) { R2.vn = 0; return R2; }
    const rnA = rax * ct.ny - ray * ct.nx, rnB = rbx * ct.ny - rby * ct.nx;
    const j = (-(1 + e) * vn) / (sum + rnA * rnA * ia + rnB * rnB * ib);
    a.vx += j * ct.nx * ima; a.vy += j * ct.ny * ima; a.w += rnA * j * ia;
    b.vx -= j * ct.nx * imb; b.vy -= j * ct.ny * imb; b.w -= rnB * j * ib;
    if (vt > 1e-4) {
      const tx = tvx / vt, ty = tvy / vt;
      const rtA = rax * ty - ray * tx, rtB = rbx * ty - rby * tx;
      let jt = -vt / (sum + rtA * rtA * ia + rtB * rtB * ib);
      jt = U.clamp(jt, -mu * j, mu * j);
      a.vx += jt * tx * ima; a.vy += jt * ty * ima; a.w += rtA * jt * ia;
      b.vx -= jt * tx * imb; b.vy -= jt * ty * imb; b.w -= rtB * jt * ib;
    }
    R2.vn = -vn;
    return R2;
  };
})();
