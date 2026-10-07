'use strict';
// Açık dünya aktör çizimi (DS.ActorSprites): NPC araçları, yayalar, zemin işaretleri, ok ve çakarlar.
// - Araçlar: gövde + gölge tek "pişmiş" bitmapte (CarRender.build), çizimde tek drawImage.
// - GPU yolu: bileşik setTransform (M · T(x,y) · R(h)) + drawImage (drawParked deseni, save/restore yok).
// - Yazılım (soft) yolu: önceden döndürülmüş kareler, tamsayı cihaz pikseline ölçeksiz blit; kareler
//   tembel ve kare başına bütçeyle (actorBudgetMs) üretilir, bütçe aşılırsa o çizim GPU yoluna düşer.
// - Yakınlaştırma kovası: zb = 1.15^round(ln zEff / ln 1.15), ±%8 histerezis; kova içinde zEff/zb ölçeği.
// - Bayt sınırlı LRU önbellek (Q.spriteMB, dokunmatik cihazda yarısı).
// Kurallar: shadowBlur / filter yok, kare başına rgba() dizesi yok, sıcak yolda tahsis yok.
// Çağıranlar bir çizim grubundan sonra ctx.setTransform(M…) ile dönüşümü geri kurar (burada birim kalabilir).
(function () {
  const DS = window.DS, U = DS.U;
  const TAU = Math.PI * 2;
  const MB = 1048576;
  const CAR_N = 64;                 // araç açı sayısı (yazılım yolu)
  const PXP = 40;                   // yaya GPU kareleri: piksel/m
  const PK = 1.5;                   // yaya büyütmesi (okunurluk)
  const ZSTEP = 1.15, LZS = Math.log(ZSTEP), HYST = Math.log(1.08);
  const MARGIN = 0.2;               // pişmiş araç bitmap kenar payı (m): aynalar ve gölge kayması sığar
  const SHADOW = 'rgba(8,10,20,0.35)';
  const SIL = 'rgba(12,12,16,0.85)';  // yaya alt silueti
  const STAR = '#ffe14d', RING = '#ff8a1f', INK = '#16181c';
  const WRECK_COL = '#262626';
  const RED_BAR = '#ff3030', BLUE_BAR = '#3a7bff';
  const now = () => performance.now();

  const POSE = DS.POSE || { IDLE: 0, WALK: 1, RUN: 2, FALL: 3, DOWN: 4, PUNCH: 5, GETIN: 6, WAVE: 7, PANIC: 8 };
  const VM_WRECK = DS.VM ? DS.VM.WRECK : 3;
  // DS.PED_PALETTES (vehicles.js) yoksa çökmemek için tek yedek palet
  const FALLBACK_PAL = [{ skin: '#e0b48c', shirt: '#ff8a1f', pants: '#22262e', hair: '#1b1410', cap: null, badge: false }];

  // yaya poz türleri (kare yuvaları)
  const K_WALK = 0, K_RUN = 1, K_IDLE = 2, K_PANIC = 3, K_WAVE = 4, K_PUNCH = 5, K_FALL = 6, K_DOWN = 7;
  const R_STAND = 0.5, R_LIE = 0.7;   // poz yarıçapı (büyütme öncesi m)

  // ---------------- yaya çizim tarifi (yapım anında, metre, +x = bakış yönü, büyütme öncesi) ----------------
  // Parçalar: [x, y, rx, ry, açı, renkKodu] — renk 0 pantolon, 1 gömlek, 2 ten (el), 3 ten (baş)
  function pedParts(kind, u, out) {
    out.length = 0;
    const add = (x, y, rx, ry, a, c) => out.push([x, y, rx, ry, a, c]);
    if (kind === K_FALL || kind === K_DOWN) {
      // devrilme: gövde -x yönünde uzar, kollar açılır, baş +x'te
      const t = u;
      const L = U.lerp;
      add(L(0, -0.33, t), L(-0.11, -0.09, t), L(0.11, 0.24, t), L(0.065, 0.075, t), 0, 0);
      add(L(0, -0.33, t), L(0.11, 0.09, t), L(0.11, 0.24, t), L(0.065, 0.075, t), 0, 0);
      const ax = L(0, 0.2, t), ay = L(0.27, 0.34, t), aa = L(0, 0.75, t);
      add(ax, -ay, 0.11, 0.065, -aa, 1);
      add(ax, ay, 0.11, 0.065, aa, 1);
      add(ax + Math.cos(aa) * 0.1, -ay - Math.sin(aa) * 0.1, 0.045, 0.045, 0, 2);
      add(ax + Math.cos(aa) * 0.1, ay + Math.sin(aa) * 0.1, 0.045, 0.045, 0, 2);
      add(L(0, 0.1, t), 0, L(0.15, 0.24, t), L(0.26, 0.2, t), 0, 1);
      add(L(0.03, 0.42, t), 0, 0.11, 0.11, 0, 3);
      return { lean: 0, hx: L(0.03, 0.42, t), lying: t };
    }
    const s = Math.sin(u * TAU);
    const run = kind === K_RUN || kind === K_PANIC;
    const fa = kind === K_IDLE || kind === K_WAVE || kind === K_PUNCH ? 0 : run ? 0.28 : 0.2;
    const aa = kind === K_IDLE || kind === K_WAVE || kind === K_PUNCH ? 0 : run ? 0.25 : 0.18;
    const lean = run ? 0.03 : 0;
    // ayaklar (pantolon)
    add(s * fa, -0.11, 0.11, 0.065, 0, 0);
    add(-s * fa, 0.11, 0.11, 0.065, 0, 0);
    // kollar (gömlek) + eller (ten)
    if (kind === K_PANIC) {
      // panik: kollar 60° dışa açık (havada), hafif çırpınma
      for (let sg = -1; sg <= 1; sg += 2) {
        const a = sg * (1.05 + 0.25 * s * sg);
        const dx = Math.cos(a), dy = Math.sin(a);
        add(lean + dx * 0.1, sg * 0.22 + dy * 0.1, 0.11, 0.065, a, 1);
        add(lean + dx * 0.21, sg * 0.22 + dy * 0.21, 0.05, 0.05, 0, 2);
      }
    } else {
      // sol kol
      add(-s * aa, -0.27, 0.11, 0.065, 0, 1);
      add(-s * aa + 0.09, -0.27, 0.045, 0.045, 0, 2);
      if (kind === K_WAVE) {
        // el sallama: sağ kol öne-yana kalkık, iki kare arasında sallanır
        const a = u < 0.5 ? 0.45 : 1.0;
        const dx = Math.cos(a), dy = Math.sin(a);
        add(dx * 0.1, 0.22 + dy * 0.1, 0.11, 0.065, a, 1);
        add(dx * 0.22, 0.22 + dy * 0.22, 0.058, 0.058, 0, 2);
      } else if (kind === K_PUNCH) {
        if (u < 0.5) {
          // geri çekilmiş yumruk
          add(-0.08, 0.28, 0.11, 0.065, 0, 1);
          add(0.01, 0.28, 0.05, 0.05, 0, 2);
        } else {
          // uzanmış kol: omuzdan (+0.32, +0.12) noktasına
          const a = Math.atan2(0.12 - 0.22, 0.32);
          add(0.16, 0.17, 0.165, 0.065, a, 1);
          add(0.32, 0.12, 0.06, 0.06, 0, 2);
        }
      } else {
        add(s * aa, 0.27, 0.11, 0.065, 0, 1);
        add(s * aa + 0.09, 0.27, 0.045, 0.045, 0, 2);
      }
    }
    // gövde ve baş
    add(lean, 0, 0.15, 0.26, 0, 1);
    add(lean + 0.03, 0, 0.11, 0.11, 0, 3);
    return { lean, hx: lean + 0.03, lying: 0 };
  }

  const PARTS = [];
  // birleşik yol için ayrı alt yol: elipsin başlangıç noktasından başla (araya çizgi girmesin)
  function ellipseSub(g, p, grow) {
    const rx = p[2] + grow;
    g.moveTo(p[0] + rx * Math.cos(p[4]), p[1] + rx * Math.sin(p[4]));
    g.ellipse(p[0], p[1], rx, p[3] + grow, p[4], 0, TAU);
  }
  // g: dönüşümü (döndürme · ölçek · PK) kurulmuş bağlam; grow: siluet büyütmesi (büyütme öncesi m)
  function paintPed(g, P, kind, u, grow, flash) {
    const info = pedParts(kind, u, PARTS);
    const lying = info.lying;
    // temas gölgesi
    g.fillStyle = '#000000'; g.globalAlpha = 0.25;
    g.beginPath(); g.ellipse(U.lerp(0.05, 0.0, lying), 0.05, U.lerp(0.3, 0.66, lying), U.lerp(0.36, 0.36, lying), 0, 0, TAU); g.fill();
    g.globalAlpha = 1;
    // tek koyu alt siluet (tüm parçaların birleşimi, büyütülmüş)
    g.fillStyle = SIL;
    g.beginPath();
    for (const p of PARTS) ellipseSub(g, p, grow);
    g.fill();
    if (flash) {
      // vuruş parlaması: beyaz siluet
      g.fillStyle = '#ffffff';
      g.beginPath();
      for (const p of PARTS) ellipseSub(g, p, 0);
      g.fill();
      return;
    }
    const cols = [P.pants, P.shirt, P.skin, P.skin];
    for (const p of PARTS) {
      g.fillStyle = cols[p[5]];
      g.beginPath(); g.ellipse(p[0], p[1], p[2], p[3], p[4], 0, TAU); g.fill();
    }
    // omuz parlaklığı
    if (!lying) {
      g.fillStyle = '#ffffff'; g.globalAlpha = 0.22;
      g.beginPath(); g.ellipse(info.lean + 0.04, -0.06, 0.07, 0.14, 0, 0, TAU); g.fill();
      g.globalAlpha = 1;
    }
    // saç / şapka (başın arka yarısı)
    const hx = info.hx;
    if (P.cap) {
      g.fillStyle = P.cap;
      g.beginPath(); g.arc(hx - 0.01, 0, 0.112, 0, TAU); g.fill();
      g.fillStyle = U.shade(P.cap, -0.3);
      g.fillRect(hx + 0.05, -0.075, 0.09, 0.15);
      if (P.badge) { g.fillStyle = '#f4f1ea'; g.beginPath(); g.arc(hx - 0.02, 0, 0.032, 0, TAU); g.fill(); }
    } else if (lying) {
      g.fillStyle = P.hair;
      g.beginPath(); g.arc(hx + 0.01, 0, 0.105, -Math.PI * 0.55, Math.PI * 0.55); g.fill();
    } else {
      g.fillStyle = P.hair;
      g.beginPath(); g.arc(hx - 0.03, 0, 0.105, Math.PI * 0.45, Math.PI * 1.55); g.fill();
    }
  }

  // ---------------- tekil ----------------
  const AS = {
    POSE,
    _ready: false,

    init() {
      if (!this._ready) {
        this._ready = true;
        this.vmap = new Map();        // araç anahtarı -> giriş
        this.pset = [];               // palet indeksi -> yaya kümesi
        this.pobj = new Map();        // palet nesnesi -> yaya kümesi
        this.bytes = 0; this.nFrames = 0; this.built = 0; this.fno = 0;
        this.buildMs = 0; this.maxBuildMs = 0; this._bud = 0;
        this.prerot = false; this.budget = 2; this.maxBytes = 14 * MB;
        this.pedF = 4; this.pedA = 16; this.tier = 0;
        this.zb = 0; this.zs = 1; this.zEff = 1; this.rot = 0;
        this.m0 = 1; this.m1 = 0; this.m2 = 0; this.m3 = 1; this.m4 = 0; this.m5 = 0;
        this.cw = 1; this.ch = 1; this.ctx = null;
        this._gR = null; this._gB = null;
        this._layout();
      }
      // patlama/hasar dumanı atlasları ilk kullanımda takılmasın
      const S = DS.Sprites;
      if (S && S.puffs && S.prewarm) S.prewarm(['#3a3a3a', '#d6dde6']);
    },

    // Kalite: prerot = Q.prerot || soft; bütçe Q.actorBudgetMs; LRU Q.spriteMB (dokunmatikte yarısı)
    setQuality(Q, soft) {
      if (!this._ready) this.init();
      Q = Q || {};
      const prerot = !!(Q.prerot || soft);
      this.budget = Q.actorBudgetMs > 0 ? Q.actorBudgetMs : 2;
      this.maxBytes = (Q.spriteMB > 0 ? Q.spriteMB : 14) * MB * (U.isTouch ? 0.5 : 1);
      this.tier = Q.tier | 0;
      const F = Q.pedFrames === 8 ? 8 : 4;
      const A = Q.pedAngles > 0 ? Q.pedAngles | 0 : 16;
      if (F !== this.pedF || A !== this.pedA) {
        // kare yerleşimi değişti: yaya önbellekleri geçersiz
        this.pedF = F; this.pedA = A;
        this._layout();
        this._dropPeds();
      }
      if (prerot !== this.prerot) {
        this.prerot = prerot;
        if (!prerot) this._dropRot();
      }
      if (this.bytes > this.maxBytes) this._evict();
    },

    // Kare başı: dönüşüm, yakınlaştırma kovası, yapım bütçesi
    beginFrame(ctx, M, camRot) {
      if (!this._ready) this.init();
      this.ctx = ctx;
      this.m0 = M[0]; this.m1 = M[1]; this.m2 = M[2]; this.m3 = M[3]; this.m4 = M[4]; this.m5 = M[5];
      if (ctx && ctx.canvas) { this.cw = ctx.canvas.width; this.ch = ctx.canvas.height; }
      const z = Math.hypot(M[0], M[1]);
      // ekran açısı M'den türetilir (GPU yolu ile birebir aynı); M bozuksa camRot kullanılır
      this.rot = z > 0 ? Math.atan2(M[1], M[0]) : camRot || 0;
      this.zEff = z > 0 ? z : 1;
      if (!(this.zb > 0) || Math.abs(Math.log(this.zEff / this.zb)) > HYST) {
        this.zb = Math.pow(ZSTEP, Math.round(Math.log(this.zEff) / LZS));
      }
      this.zs = this.zEff / this.zb;
      this._bud = this.budget;
      this.buildMs = 0;
      this.fno++;
    },

    // ================= ARAÇLAR =================
    _vehEntry(veh) {
      const st = veh.setup, def = veh.def;
      const wreck = veh.mode === VM_WRECK;
      let e = veh.ak ? this.vmap.get(veh.ak) : undefined;
      if (e === undefined || e.def !== def || e.col !== st.color || e.liv !== st.livery || e.bar !== !!st.bar ||
        e.sign !== !!st.sign || e.wing !== !!st.wing || e.wreck !== wreck) {
        const key = def.id + '|' + st.color + '|' + st.livery + '|' + (st.bar ? 1 : 0) + '|' + (st.sign ? 1 : 0) +
          (st.wing ? '|k' : '') + (wreck ? '|w' : '');
        veh.ak = key;
        e = this.vmap.get(key);
        if (e === undefined) {
          if (this._bud <= 0) return null;
          e = this._buildVeh(key, def, st, wreck);
        }
      }
      return e;
    },

    _buildVeh(key, def, st, wreck) {
      const t0 = now();
      const s2 = wreck ? { color: WRECK_COL, livery: 'none', wing: !!st.wing, bar: !!st.bar, sign: !!st.sign, rim: '#3a3a3a' } : st;
      const spr = DS.CarRender.build(def, s2);
      const PX = DS.CarRender.PX;
      const L = def.len, Wd = def.wid;
      // tuval boyutu tam piksel: merkez tam olarak bw/2, bh/2
      const pw = Math.ceil((L + 2 * MARGIN) * PX), ph = Math.ceil((Wd + 2 * MARGIN) * PX);
      const c = U.canvas(pw, ph), g = c.getContext('2d');
      g.setTransform(PX, 0, 0, PX, pw / 2, ph / 2);
      g.fillStyle = SHADOW;
      g.fillRect(-L / 2 + 0.1, -Wd / 2 + 0.05, L, Wd);
      g.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.c.width / PX, spr.c.height / PX);
      if (wreck) {
        // kömürleşmiş kabuk: %30 siyah örtü (yalnızca dolu piksellere)
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'source-atop';
        g.globalAlpha = 0.3; g.fillStyle = '#000000'; g.fillRect(0, 0, pw, ph);
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      }
      spr.c.width = 0; // ara tuval artık gerekmez
      const bw = pw / PX, bh = ph / PX;
      const e = {
        key, kind: 0, def, col: st.color, liv: st.livery, bar: !!st.bar, sign: !!st.sign, wing: !!st.wing, wreck,
        c, w: bw, h: bh, r: 0.5 * Math.hypot(bw, bh),
        hl: L / 2, hr: (Wd / 2) * (def.shape ? def.shape.taperR : 1),
        bytes: pw * ph * 4, used: this.fno, rs: null,
      };
      this.vmap.set(key, e);
      this.bytes += e.bytes;
      this._spent(t0);
      if (this.bytes > this.maxBytes) this._evict();
      return e;
    },

    _rotSet(e, n) {
      let rs = e.rs;
      if (rs) {
        // eski kova: kareleri bırak, diziyi yeniden kullan
        this._freeRot(rs);
        rs.zb = this.zb;
      } else {
        rs = e.rs = { zb: this.zb, f: new Array(n).fill(null), bytes: 0, n: 0 };
      }
      return rs;
    },
    _freeRot(rs) {
      const f = rs.f;
      for (let i = 0; i < f.length; i++) if (f[i]) { f[i].width = 0; f[i] = null; }
      this.bytes -= rs.bytes; this.nFrames -= rs.n;
      rs.bytes = 0; rs.n = 0;
    },

    _buildCarFrame(e, rs, k) {
      const t0 = now();
      const zb = this.zb, a = (k * TAU) / CAR_N;
      const ca = Math.cos(a), sa = Math.sin(a), aca = Math.abs(ca), asa = Math.abs(sa);
      const fw = Math.ceil((aca * e.w + asa * e.h) * zb) + 2;
      const fh = Math.ceil((asa * e.w + aca * e.h) * zb) + 2;
      const c = U.canvas(fw, fh), g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      const PX = DS.CarRender.PX, s = zb / PX;
      g.setTransform(ca * s, sa * s, -sa * s, ca * s, fw / 2, fh / 2);
      g.drawImage(e.c, -e.c.width / 2, -e.c.height / 2);
      rs.f[k] = c;
      const b = fw * fh * 4;
      rs.bytes += b; rs.n++; this.bytes += b; this.nFrames++;
      this._spent(t0);
      if (this.bytes > this.maxBytes) this._evict();
      return c;
    },

    // veh: {x, y, h, def, setup, mode, brakeOn, ak}
    drawVehicle(ctx, veh) {
      const e = this._vehEntry(veh);
      const x = veh.x, y = veh.y;
      const m0 = this.m0, m1 = this.m1, m2 = this.m2, m3 = this.m3;
      const sx = m0 * x + m2 * y + this.m4, sy = m1 * x + m3 * y + this.m5;
      if (e === null) {
        // bütçe bitti ve sprite yok: tek kare için düz gövde dikdörtgeni
        const co = Math.cos(veh.h), si = Math.sin(veh.h), L = veh.def.len, Wd = veh.def.wid;
        ctx.setTransform(m0 * co + m2 * si, m1 * co + m3 * si, m2 * co - m0 * si, m3 * co - m1 * si, sx, sy);
        ctx.fillStyle = veh.mode === VM_WRECK ? WRECK_COL : veh.setup.color;
        ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
        return;
      }
      e.used = this.fno;
      const rr = e.r * this.zEff;
      if (sx < -rr || sy < -rr || sx > this.cw + rr || sy > this.ch + rr) return;
      if (this.prerot) {
        let k = Math.round(((veh.h + this.rot) * CAR_N) / TAU) % CAR_N;
        if (k < 0) k += CAR_N;
        const rs = e.rs !== null && e.rs.zb === this.zb ? e.rs : this._rotSet(e, CAR_N);
        let fr = rs.f[k];
        if (fr === null && this._bud > 0) fr = this._buildCarFrame(e, rs, k);
        if (fr !== null) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const zs = this.zs;
          if (zs > 0.996 && zs < 1.004) {
            ctx.drawImage(fr, (sx - fr.width / 2 + 0.5) | 0, (sy - fr.height / 2 + 0.5) | 0);
          } else {
            const dw = (fr.width * zs + 0.5) | 0, dh = (fr.height * zs + 0.5) | 0;
            ctx.drawImage(fr, (sx - dw / 2 + 0.5) | 0, (sy - dh / 2 + 0.5) | 0, dw, dh);
          }
          // stop lambaları karedeki (nicemlenmiş) açıyla hizalı
          if (veh.brakeOn && !e.wreck) this._brake(ctx, e, (k * TAU) / CAR_N - this.rot, sx, sy);
          return;
        }
      }
      const co = Math.cos(veh.h), si = Math.sin(veh.h);
      ctx.setTransform(m0 * co + m2 * si, m1 * co + m3 * si, m2 * co - m0 * si, m3 * co - m1 * si, sx, sy);
      ctx.drawImage(e.c, -e.w / 2, -e.h / 2, e.w, e.h);
      if (veh.brakeOn && !e.wreck) {
        ctx.fillStyle = '#ff2a2a';
        ctx.fillRect(-e.hl + 0.05, e.hr - 0.46, 0.13, 0.34);
        ctx.fillRect(-e.hl + 0.05, -e.hr + 0.12, 0.13, 0.34);
      }
    },
    _brake(ctx, e, h, sx, sy) {
      const co = Math.cos(h), si = Math.sin(h), m0 = this.m0, m1 = this.m1, m2 = this.m2, m3 = this.m3;
      ctx.setTransform(m0 * co + m2 * si, m1 * co + m3 * si, m2 * co - m0 * si, m3 * co - m1 * si, sx, sy);
      ctx.fillStyle = '#ff2a2a';
      ctx.fillRect(-e.hl + 0.05, e.hr - 0.46, 0.13, 0.34);
      ctx.fillRect(-e.hl + 0.05, -e.hr + 0.12, 0.13, 0.34);
    },

    // Işık haritası (göreli dönüşüm: M·lightScale korunur): tek birleşik far konisi + 2 küçük stop parlaması
    drawVehicleLights(lctx, veh, env) {
      if (veh.mode === VM_WRECK) return;
      const S = DS.Sprites;
      if (!S || !S.cone) return;
      const def = veh.def, hl = def.len / 2, hw = def.wid / 2;
      lctx.save();
      lctx.translate(veh.x, veh.y);
      lctx.rotate(veh.h);
      const ha = env && env.headA !== undefined ? env.headA : 1;
      lctx.globalAlpha = ha;
      lctx.drawImage(S.cone, hl - 0.3, -6, 22, 12);
      if (veh.brakeOn) {
        lctx.globalAlpha = 1;
        lctx.drawImage(S.red, -hl - 1.6, hw - 0.3 - 1.2, 3, 2.4);
        lctx.drawImage(S.red, -hl - 1.6, -hw + 0.3 - 1.2, 3, 2.4);
      } else if (this.tier >= 1) {
        // sönük arka lambalar (en düşük kademede yok)
        lctx.globalAlpha = 0.4;
        lctx.drawImage(S.red, -hl - 1.0, hw - 0.3 - 0.8, 2, 1.6);
        lctx.drawImage(S.red, -hl - 1.0, -hw + 0.3 - 0.8, 2, 1.6);
      }
      lctx.globalAlpha = 1;
      lctx.restore();
    },

    _glows() {
      if (!this._gR && DS.Sprites && DS.Sprites.tint) {
        this._gR = DS.Sprites.tint('#ff2a2a');
        this._gB = DS.Sprites.tint('#2a6bff');
      }
      return this._gR !== null;
    },

    // Işık haritası: 7 m kırmızı/mavi parlama, 3 Hz dönüşümlü
    drawSiren(lctx, veh, t) {
      if (!this._glows()) return;
      const rx = DS.CarRender.roofX(veh.def);
      const on = (t * 3) % 1 < 0.5;
      lctx.save();
      lctx.translate(veh.x, veh.y);
      lctx.rotate(veh.h);
      lctx.globalAlpha = on ? 0.95 : 0.2;
      lctx.drawImage(this._gR, rx - 3.5, -0.3 - 3.5, 7, 7);
      lctx.globalAlpha = on ? 0.2 : 0.95;
      lctx.drawImage(this._gB, rx - 3.5, 0.3 - 3.5, 7, 7);
      lctx.globalAlpha = 1;
      lctx.restore();
    },

    // Ana tuval 'lighter' geçişi: tavanda iki küçük parlak dikdörtgen (dönüşümlü)
    drawSirenBar(ctx, veh, t) {
      const rx = DS.CarRender.roofX(veh.def);
      const on = (t * 3) % 1 < 0.5;
      const co = Math.cos(veh.h), si = Math.sin(veh.h), x = veh.x, y = veh.y;
      const m0 = this.m0, m1 = this.m1, m2 = this.m2, m3 = this.m3;
      ctx.setTransform(m0 * co + m2 * si, m1 * co + m3 * si, m2 * co - m0 * si, m3 * co - m1 * si,
        m0 * x + m2 * y + this.m4, m1 * x + m3 * y + this.m5);
      ctx.globalAlpha = on ? 1 : 0.22;
      ctx.fillStyle = RED_BAR; ctx.fillRect(rx - 0.13, -0.5, 0.26, 0.4);
      ctx.globalAlpha = on ? 0.22 : 1;
      ctx.fillStyle = BLUE_BAR; ctx.fillRect(rx - 0.13, 0.1, 0.26, 0.4);
      ctx.globalAlpha = 1;
    },

    // ================= YAYALAR =================
    _layout() {
      const F = this.pedF;
      this.sWalk = 0; this.sRun = F; this.sIdle = 2 * F; this.sPanic = 2 * F + 1;
      this.sWave = 3 * F + 1; this.sPunch = 3 * F + 3; this.sFall = 3 * F + 5; this.sDown = 3 * F + 8;
      this.nS = 3 * F + 9;
    },
    // yuva -> poz türü ve evre
    _slotKind(s) {
      const F = this.pedF;
      if (s < F) { this._u = s / F; return K_WALK; }
      if (s < 2 * F) { this._u = (s - F) / F; return K_RUN; }
      if (s === 2 * F) { this._u = 0; return K_IDLE; }
      if (s <= 3 * F) { this._u = (s - 2 * F - 1) / F; return K_PANIC; }
      if (s < 3 * F + 3) { this._u = (s - 3 * F - 1) * 0.5; return K_WAVE; }
      if (s < 3 * F + 5) { this._u = (s - 3 * F - 3) * 0.5; return K_PUNCH; }
      if (s < 3 * F + 8) { this._u = [0.3, 0.6, 0.85][s - 3 * F - 5]; return K_FALL; }
      this._u = 1; return K_DOWN;
    },
    _pedSet(pal) {
      let set;
      if (typeof pal === 'number') {
        set = this.pset[pal];
        if (set === undefined) {
          const pals = DS.PED_PALETTES && DS.PED_PALETTES.length ? DS.PED_PALETTES : FALLBACK_PAL;
          set = this._newPedSet(pals[((pal % pals.length) + pals.length) % pals.length]);
          this.pset[pal] = set;
        }
      } else {
        set = this.pobj.get(pal);
        if (set === undefined) { set = this._newPedSet(pal || FALLBACK_PAL[0]); this.pobj.set(pal, set); }
      }
      return set;
    },
    _newPedSet(P) {
      return { kind: 1, P, base: new Array(this.nS * 2).fill(null), rs: null, bytes: 0, n: 0, used: this.fno };
    },
    _buildPedFrame(set, slot, flash, zpx, ang) {
      const t0 = now();
      const kind = this._slotKind(slot), u = this._u;
      const Rm = (kind === K_FALL || kind === K_DOWN ? R_LIE : R_STAND) * PK;
      const S = Math.ceil(2 * Rm * zpx) + 2;
      const c = U.canvas(S, S), g = c.getContext('2d');
      const k = zpx * PK, ca = Math.cos(ang) * k, sa = Math.sin(ang) * k;
      g.setTransform(ca, sa, -sa, ca, S / 2, S / 2);
      // alt siluet yaklaşık 1 cihaz pikseli büyür
      paintPed(g, set.P, kind, u, Math.max(1 / k, 0.02), flash);
      const b = S * S * 4;
      set.bytes += b; set.n++; this.bytes += b; this.nFrames++;
      this._spent(t0);
      if (this.bytes > this.maxBytes) this._evict();
      return c;
    },
    _pedSlot(pose, phase) {
      const fr = phase - Math.floor(phase);
      switch (pose) {
        case POSE.WALK: return this.sWalk + ((fr * this.pedF) | 0);
        case POSE.RUN: return this.sRun + ((fr * this.pedF) | 0);
        case POSE.PANIC: return this.sPanic + ((fr * this.pedF) | 0);
        case POSE.WAVE: return this.sWave + (fr < 0.5 ? 0 : 1);
        case POSE.PUNCH: return this.sPunch + (phase < 0.3 ? 0 : 1);
        case POSE.FALL: return this.sFall + (phase <= 0 ? 0 : phase >= 1 ? 2 : Math.min(2, (phase * 3) | 0));
        case POSE.DOWN: return this.sDown;
        default: return this.sIdle; // IDLE, GETIN
      }
    },

    // pose: DS.POSE; phase: yürüyüş evresi (tur) ya da düşme/binme ilerlemesi 0..1; flash: vuruş parlaması
    drawPed(ctx, x, y, h, pal, pose, phase, flash) {
      const set = this._pedSet(pal);
      set.used = this.fno;
      const m0 = this.m0, m1 = this.m1, m2 = this.m2, m3 = this.m3;
      const sx = m0 * x + m2 * y + this.m4, sy = m1 * x + m3 * y + this.m5;
      const rr = R_LIE * PK * this.zEff;
      if (sx < -rr || sy < -rr || sx > this.cw + rr || sy > this.ch + rr) return;
      const slot = this._pedSlot(pose, phase || 0) + (flash ? this.nS : 0);
      const sc = pose === POSE.GETIN ? 1 - 0.3 * (phase < 0 ? 0 : phase > 1 ? 1 : phase) : 1;
      if (this.prerot) {
        const A = this.pedA;
        let k = Math.round(((h + this.rot) * A) / TAU) % A;
        if (k < 0) k += A;
        let rs = set.rs;
        if (rs === null || rs.zb !== this.zb) rs = this._pedRot(set);
        const idx = slot * A + k;
        let fr = rs.f[idx];
        if (fr === null && this._bud > 0) {
          fr = rs.f[idx] = this._buildPedFrame(set, slot >= this.nS ? slot - this.nS : slot, slot >= this.nS, this.zb, (k * TAU) / A);
        }
        if (fr !== null) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const zs = this.zs * sc;
          if (zs > 0.996 && zs < 1.004) {
            ctx.drawImage(fr, (sx - fr.width / 2 + 0.5) | 0, (sy - fr.height / 2 + 0.5) | 0);
          } else {
            const dw = (fr.width * zs + 0.5) | 0;
            ctx.drawImage(fr, (sx - dw / 2 + 0.5) | 0, (sy - dw / 2 + 0.5) | 0, dw, dw);
          }
          return;
        }
      }
      // GPU yolu (ya da bütçe aşımında yedek): döndürülmemiş taban kare + bileşik dönüşüm
      let fr = set.base[slot];
      if (fr === null) {
        if (this._bud <= 0) {
          // bütçe yok: tek kare için gömlek renginde nokta
          ctx.setTransform(m0, m1, m2, m3, this.m4, this.m5);
          ctx.fillStyle = set.P.shirt;
          ctx.fillRect(x - 0.3, y - 0.3, 0.6, 0.6);
          return;
        }
        fr = set.base[slot] = this._buildPedFrame(set, slot >= this.nS ? slot - this.nS : slot, slot >= this.nS, PXP, 0);
      }
      const co = Math.cos(h) * sc, si = Math.sin(h) * sc;
      ctx.setTransform(m0 * co + m2 * si, m1 * co + m3 * si, m2 * co - m0 * si, m3 * co - m1 * si, sx, sy);
      const half = fr.width / PXP / 2;
      ctx.drawImage(fr, -half, -half, half * 2, half * 2);
    },
    _pedRot(set) {
      const n = this.nS * 2 * this.pedA;
      let rs = set.rs;
      if (rs !== null) {
        const f = rs.f;
        let b = 0, c = 0;
        for (let i = 0; i < f.length; i++) if (f[i] !== null) { b += f[i].width * f[i].height * 4; c++; f[i].width = 0; f[i] = null; }
        set.bytes -= b; set.n -= c; this.bytes -= b; this.nFrames -= c;
        if (f.length !== n) rs.f = new Array(n).fill(null);
        rs.zb = this.zb;
      } else {
        rs = set.rs = { zb: this.zb, f: new Array(n).fill(null) };
      }
      return rs;
    },

    // Baygın yaya: 3 sarı nokta, 0.35 m yörünge, 2 tur/s (dünya dönüşümüyle)
    drawStars(ctx, x, y, t) {
      ctx.setTransform(this.m0, this.m1, this.m2, this.m3, this.m4, this.m5);
      ctx.fillStyle = STAR;
      const b = t * 2 * TAU;
      for (let k = 0; k < 3; k++) {
        const a = b + (k * TAU) / 3;
        ctx.fillRect(x + Math.cos(a) * 0.35 - 0.1, y + Math.sin(a) * 0.35 - 0.1, 0.2, 0.2);
      }
    },

    // Oyuncunun ayağının altında turuncu halka (kalabalıkta görünürlük)
    drawPlayerRing(ctx, x, y, t) {
      ctx.setTransform(this.m0, this.m1, this.m2, this.m3, this.m4, this.m5);
      ctx.globalAlpha = 0.55 + 0.25 * Math.sin(t * 5);
      ctx.strokeStyle = RING;
      ctx.lineWidth = 0.12;
      ctx.beginPath(); ctx.arc(x, y, 0.85, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    },

    // ================= İŞARETLER =================
    // Zemin halkası (görev noktası / kontrol noktası): soluk dolgu, kenar ve içten dışa nabız
    drawRing(ctx, x, y, r, col, t) {
      ctx.setTransform(this.m0, this.m1, this.m2, this.m3, this.m4, this.m5);
      const lw = Math.max(0.25, r * 0.06), p = (t * 0.8) % 1;
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.globalAlpha = 0.16;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.85; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(x, y, r - lw / 2, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 0.6 * (1 - p); ctx.lineWidth = lw * 0.6;
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r * (0.25 + 0.7 * p)), 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    },

    // Hedef işareti (çatıların üstünde, ekran uzayında): hedefi gösteren zıplayan ok
    drawBeacon(ctx, x, y, col, t) {
      const sx = this.m0 * x + this.m2 * y + this.m4, sy = this.m1 * x + this.m3 * y + this.m5;
      const z = Math.max(this.zEff, 9);
      const bob = (0.6 + 0.35 * (0.5 + 0.5 * Math.sin(t * 5))) * z;
      const w = 0.9 * z, hgt = 1.5 * z;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.moveTo(sx, sy - bob);
      ctx.lineTo(sx - w, sy - bob - hgt);
      ctx.lineTo(sx - w * 0.38, sy - bob - hgt);
      ctx.lineTo(sx - w * 0.38, sy - bob - hgt * 1.7);
      ctx.lineTo(sx + w * 0.38, sy - bob - hgt * 1.7);
      ctx.lineTo(sx + w * 0.38, sy - bob - hgt);
      ctx.lineTo(sx + w, sy - bob - hgt);
      ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = Math.max(1.5, 0.12 * z); ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineJoin = 'miter';
      ctx.setTransform(this.m0, this.m1, this.m2, this.m3, this.m4, this.m5);
    },

    // GPS zemin okları: rota boyunca her 6 m'de 1.2×0.6 m üçgen, %35 alfa, en fazla 20 (ileri akar)
    drawChevrons(ctx, pts, n, col, t) {
      if (!pts || n < 2) return;
      ctx.setTransform(this.m0, this.m1, this.m2, this.m3, this.m4, this.m5);
      const m0 = this.m0, m1 = this.m1, m2 = this.m2, m3 = this.m3, m4 = this.m4, m5 = this.m5;
      const pad = 2 * this.zEff, W = this.cw + pad, H = this.ch + pad;
      ctx.fillStyle = col; ctx.globalAlpha = 0.35;
      ctx.beginPath();
      let next = 3 + ((t * 4) % 6), along = 0, cnt = 0;
      for (let i = 0; i < n - 1 && cnt < 20; i++) {
        const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3];
        const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
        if (L < 1e-6) continue;
        const ux = dx / L, uy = dy / L;
        while (next <= along + L && cnt < 20) {
          const d = next - along, px = x0 + ux * d, py = y0 + uy * d;
          next += 6; cnt++;
          const sx = m0 * px + m2 * py + m4, sy = m1 * px + m3 * py + m5;
          if (sx < -pad || sy < -pad || sx > W || sy > H) continue;
          ctx.moveTo(px + ux * 0.3, py + uy * 0.3);
          ctx.lineTo(px - ux * 0.3 - uy * 0.6, py - uy * 0.3 + ux * 0.6);
          ctx.lineTo(px - ux * 0.05, py - uy * 0.05);
          ctx.lineTo(px - ux * 0.3 + uy * 0.6, py - uy * 0.3 - ux * 0.6);
          ctx.closePath();
        }
        along += L;
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    },

    // Oyuncunun önünde yüzen sarı ok (GTA1): (x, y) ok merkezi, ang hedef yönü
    drawArrow(ctx, x, y, ang, scale, col) {
      const k = scale > 0 ? scale : 1;
      const co = Math.cos(ang) * k, si = Math.sin(ang) * k;
      const m0 = this.m0, m1 = this.m1, m2 = this.m2, m3 = this.m3;
      ctx.setTransform(m0 * co + m2 * si, m1 * co + m3 * si, m2 * co - m0 * si, m3 * co - m1 * si,
        m0 * x + m2 * y + this.m4, m1 * x + m3 * y + this.m5);
      ctx.beginPath();
      ctx.moveTo(0.9, 0); ctx.lineTo(-0.35, 0.65); ctx.lineTo(-0.05, 0); ctx.lineTo(-0.35, -0.65);
      ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 0.1; ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineJoin = 'miter';
      ctx.setTransform(m0, m1, m2, m3, this.m4, this.m5);
    },

    // ================= ÖNBELLEK =================
    _spent(t0) {
      const d = now() - t0;
      this._bud -= d; this.buildMs += d; this.built++;
      if (this.buildMs > this.maxBuildMs) this.maxBuildMs = this.buildMs;
    },
    // En uzun süredir kullanılmayan girişten başlayarak: önce döndürülmüş kareler, sonra bütünü
    _evict() {
      const lim = this.maxBytes * 0.9;
      let guard = 256;
      while (this.bytes > lim && guard-- > 0) {
        let best = null, bu = Infinity;
        for (const e of this.vmap.values()) if (e.used < this.fno && e.used < bu) { bu = e.used; best = e; }
        for (let i = 0; i < this.pset.length; i++) {
          const s = this.pset[i];
          if (s !== undefined && s.used < this.fno && s.used < bu) { bu = s.used; best = s; }
        }
        for (const s of this.pobj.values()) if (s.used < this.fno && s.used < bu) { bu = s.used; best = s; }
        if (best === null) break;
        if (best.kind === 0) {
          if (best.rs !== null && best.rs.n > 0) this._freeRot(best.rs);
          else { this.vmap.delete(best.key); this.bytes -= best.bytes; best.c.width = 0; best.rs = null; }
        } else this._freePedSet(best);
      }
    },
    _freePedSet(s) {
      for (let i = 0; i < s.base.length; i++) if (s.base[i] !== null) { s.base[i].width = 0; s.base[i] = null; }
      if (s.rs !== null) { const f = s.rs.f; for (let i = 0; i < f.length; i++) if (f[i] !== null) { f[i].width = 0; f[i] = null; } }
      this.bytes -= s.bytes; this.nFrames -= s.n;
      s.bytes = 0; s.n = 0; s.rs = null;
      // küme dizide kalır (boş); sonraki kullanımda kareler yeniden üretilir
      s.used = this.fno;
    },
    _dropPeds() {
      for (let i = 0; i < this.pset.length; i++) if (this.pset[i] !== undefined) this._freePedSet(this.pset[i]);
      for (const s of this.pobj.values()) this._freePedSet(s);
      this.pset = []; this.pobj = new Map();
    },
    _dropRot() {
      for (const e of this.vmap.values()) if (e.rs !== null) { this._freeRot(e.rs); e.rs = null; }
      const drop = (s) => {
        if (s === undefined || s.rs === null) return;
        const f = s.rs.f;
        let b = 0, c = 0;
        for (let i = 0; i < f.length; i++) if (f[i] !== null) { b += f[i].width * f[i].height * 4; c++; f[i].width = 0; f[i] = null; }
        s.bytes -= b; s.n -= c; this.bytes -= b; this.nFrames -= c; s.rs = null;
      };
      for (let i = 0; i < this.pset.length; i++) drop(this.pset[i]);
      for (const s of this.pobj.values()) drop(s);
    },

    // contextrestored sonrası: tüm önbellekler tembelce yeniden kurulur
    clear() {
      if (!this._ready) { this.init(); return; }
      for (const e of this.vmap.values()) { e.c.width = 0; if (e.rs !== null) this._freeRot(e.rs); }
      this.vmap.clear();
      this._dropPeds();
      this.bytes = 0; this.nFrames = 0;
      this._gR = null; this._gB = null;
      this.zb = 0;
    },

    stats() {
      return {
        bytes: this._ready ? this.bytes : 0, frames: this._ready ? this.nFrames : 0, built: this._ready ? this.built : 0,
        buildMs: this._ready ? this.buildMs : 0, maxBuildMs: this._ready ? this.maxBuildMs : 0,
        entries: this._ready ? this.vmap.size : 0, zb: this._ready ? this.zb : 0, prerot: !!this.prerot,
      };
    },
  };

  DS.ActorSprites = AS;
})();
