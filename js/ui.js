'use strict';
// Arayüz: menüler, garaj, ayarlar, oyun içi göstergeler
(function () {
  const DS = window.DS, U = DS.U;
  const $ = (s) => document.querySelector(s);

  const UI = (DS.UI = {
    init(game) {
      this.g = game;
      this.el = {
        hud: $('#hud'), drift: $('#drift'), chain: $('#d-chain'), mult: $('#d-mult'), flag: $('#d-flag'),
        angFill: $('#d-angle-fill'), angNum: $('#d-angle-num'), msgs: $('#msgs'),
        total: $('#h-total'), money: $('#h-money'), gauge: $('#gauge'), mini: $('#minimap'),
        thud: $('#tandem-hud'), tprog: $('#t-prog'), tgap: $('#t-gap-n'), tmark: $('#t-gap-mark'), tscore: $('#t-score-n'),
        count: $('#countdown'), toast: $('#toast'), fps: $('#fps'), controls: $('#controls'),
      };
      this.screens = ['menu', 'garage', 'settings', 'pause', 'result'].reduce((o, id) => { o[id] = $('#' + id); return o; }, {});
      document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        this.g.audio.init();
        this.g.audio.beep(660, 0.05, 0.05);
        this.act(b.dataset.act);
      }));
      $('#btn-pause').addEventListener('click', () => this.g.pause());
      document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => this.tab(t.dataset.tab)));
      this.bindSettings();
      this.shown = 0; this.dispChain = 0; this.bankT = 0; this.bankPts = 0;
      this.gaugeCtx = this.el.gauge.getContext('2d');
      this.miniCtx = this.el.mini.getContext('2d');
      this.sizeCanvases();
      window.addEventListener('resize', () => this.sizeCanvases());
      const markTouch = () => document.body.classList.add('touch');
      if (U.isTouch) markTouch();
      window.addEventListener('touchstart', markTouch, { once: true, passive: true });
      this.prev = null;
      this.updateMenu();
    },

    sizeCanvases() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const c of [this.el.gauge, this.el.mini]) {
        // gizliyken bile CSS boyutunu oku (getBoundingClientRect gizli öğede 0 döner)
        const cs = getComputedStyle(c);
        const w = parseFloat(cs.width) || c._w || 120, h = parseFloat(cs.height) || c._h || 120;
        if (c._w === w && c._h === h && c._dpr === dpr) continue;
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c._dpr = dpr; c._w = w; c._h = h;
      }
      const pv = $('#g-preview');
      if (pv) { const r = pv.getBoundingClientRect(); if (r.width) { pv.width = Math.round(r.width * dpr); pv.height = Math.round(r.height * dpr); } }
    },

    show(id) {
      for (const k in this.screens) this.screens[k].hidden = k !== id;
      this.current = id;
      // tam ekran paneller açıkken oyun göstergelerini gizle
      if (this.g.state === 'play' || this.g.state === 'pause') this.el.hud.hidden = id === 'garage' || id === 'settings';
      if (id === 'garage') { this.buildGarage(); setTimeout(() => this.sizeCanvases(), 0); }
      if (id === 'settings') this.loadSettings();
      if (id === 'menu') this.updateMenu();
    },
    hideAll() { for (const k in this.screens) this.screens[k].hidden = true; this.current = null; },

    act(a) {
      const g = this.g;
      switch (a) {
        case 'free': g.startFree(); break;
        case 'tandem': g.startTandem(); break;
        case 'garage': this.prev = this.current; this.show('garage'); break;
        case 'settings': this.prev = this.current; this.show('settings'); break;
        case 'back':
          g.persist();
          if (this.prev === 'pause') this.show('pause');
          else this.show('menu');
          break;
        case 'resume': g.resume(); break;
        case 'respawn': g.respawn(); g.resume(); break;
        case 'menu': g.toMenu(); break;
      }
    },

    updateMenu() {
      const s = this.g.save;
      $('#m-money').textContent = '₺' + U.fmt(s.money);
      $('#m-best').textContent = U.fmt(s.best);
      $('#m-car').textContent = DS.carById(s.car).name;
    },

    toast(text, ms) {
      const t = this.el.toast;
      t.textContent = text;
      t.classList.add('on');
      clearTimeout(this._tt);
      this._tt = setTimeout(() => t.classList.remove('on'), ms || 2200);
    },

    // ---------------- AYARLAR ----------------
    bindSettings() {
      const s = () => this.g.save.settings;
      const on = (id, key, conv) => {
        const el = $(id);
        el.addEventListener(el.type === 'range' ? 'input' : 'change', async () => {
          const v = el.type === 'checkbox' ? el.checked : conv ? conv(el.value) : el.value;
          s()[key] = v;
          if (key === 'steer' && v === 'tilt') {
            const ok = await this.g.input.enableTilt();
            if (!ok) { s().steer = 'buttons'; el.value = 'buttons'; this.toast('Eğim izni alınamadı, butonlara dönüldü'); }
          }
          this.g.applySettings();
        });
      };
      on('#s-steer', 'steer'); on('#s-sens', 'sens', Number); on('#s-assist', 'assist', Number);
      on('#s-trans', 'trans'); on('#s-cam', 'cam'); on('#s-zoom', 'zoom', Number);
      on('#s-time', 'time'); on('#s-weather', 'weather'); on('#s-quality', 'quality', Number);
      on('#s-sound', 'sound'); on('#s-vol', 'vol', Number); on('#s-fps', 'fps');
    },
    loadSettings() {
      const s = this.g.save.settings;
      $('#s-steer').value = s.steer; $('#s-sens').value = s.sens; $('#s-assist').value = s.assist;
      $('#s-trans').value = s.trans; $('#s-cam').value = s.cam; $('#s-zoom').value = s.zoom;
      $('#s-time').value = s.time; $('#s-weather').value = s.weather; $('#s-quality').value = String(s.quality);
      $('#s-sound').checked = s.sound; $('#s-vol').value = s.vol; $('#s-fps').checked = s.fps;
    },

    // ---------------- GARAJ ----------------
    tab(name) {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
      for (const k of ['cars', 'paint', 'smoke', 'perf']) $('#tab-' + k).hidden = k !== name;
      this.curTab = name;
    },
    buildGarage() {
      const g = this.g, s = g.save;
      $('#g-money').textContent = '₺' + U.fmt(s.money);
      const def = DS.carById(s.car);
      $('#g-name').textContent = def.name;
      $('#g-desc').textContent = def.desc;
      this.buildCars(); this.buildPaint(); this.buildSmoke(); this.buildPerf();
      if (!this.curTab) this.tab('cars');
    },
    buildCars() {
      const g = this.g, s = g.save, box = $('#tab-cars');
      box.innerHTML = '';
      const maxT = Math.max(...DS.CARS.map((c) => c.torque));
      for (const c of DS.CARS) {
        const owned = s.owned.includes(c.id), sel = s.car === c.id;
        const d = document.createElement('div');
        d.className = 'car-card' + (sel ? ' sel' : '');
        const bar = (v) => `<i style="width:${Math.round(v * 100)}%"></i>`;
        d.innerHTML = `
          <div class="cc-head"><b>${c.name}</b><span class="badge">${sel ? 'Seçili' : owned ? 'Sende' : '₺' + U.fmt(c.price)}</span></div>
          <p>${c.desc}</p>
          <div class="cc-stats">
            <span>Tork</span><div class="bar">${bar(c.torque / maxT)}</div><em>${c.torque} N·m${c.turbo ? ' T' : ''}</em>
            <span>Ağırlık</span><div class="bar">${bar(1 - (c.mass - 900) / 800)}</div><em>${c.mass} kg</em>
            <span>Açı</span><div class="bar">${bar((c.steer - 35) / 25)}</div><em>${c.steer}°</em>
            <span>Devir</span><div class="bar">${bar((c.redline - 6000) / 3000)}</div><em>${U.fmt(c.redline)}</em>
          </div>`;
        const btn = document.createElement('button');
        btn.className = 'mini-btn' + (owned ? '' : ' buy');
        btn.textContent = sel ? 'Kullanılıyor' : owned ? 'Seç' : 'Satın al';
        btn.disabled = sel || (!owned && s.money < c.price);
        btn.addEventListener('click', () => {
          if (!owned) {
            if (s.money < c.price) return;
            s.money -= c.price; s.owned.push(c.id);
            this.g.audio.chime();
            this.toast(c.name + ' garajında!');
          }
          s.car = c.id;
          g.selectCar(c.id);
          this.buildGarage();
        });
        d.appendChild(btn);
        box.appendChild(d);
      }
    },
    swatches(list, cur, fn, cls) {
      const w = document.createElement('div');
      w.className = 'swatches ' + (cls || '');
      for (const col of list) {
        const b = document.createElement('button');
        b.className = 'sw' + (col === cur ? ' on' : '');
        b.setAttribute('aria-label', col);
        if (col === 'none') { b.classList.add('none'); b.textContent = 'Yok'; }
        else b.style.background = col;
        b.addEventListener('click', () => fn(col));
        w.appendChild(b);
      }
      return w;
    },
    section(title, node) {
      const sec = document.createElement('div');
      sec.className = 'gsec';
      const h = document.createElement('h4'); h.textContent = title;
      sec.appendChild(h); sec.appendChild(node);
      return sec;
    },
    buildPaint() {
      const g = this.g, setup = g.carSetup(g.save.car), box = $('#tab-paint');
      box.innerHTML = '';
      const upd = () => { g.applyCarSetup(); this.buildPaint(); };
      const paint = this.swatches(DS.PAINTS, setup.color, (c) => { setup.color = c; upd(); });
      const custom = document.createElement('label');
      custom.className = 'sw custom';
      custom.innerHTML = '<span>Özel</span>';
      const inp = document.createElement('input');
      inp.type = 'color'; inp.id = 'g-custom-color'; inp.value = setup.color;
      inp.addEventListener('change', () => { setup.color = inp.value; upd(); });
      custom.appendChild(inp);
      paint.appendChild(custom);
      box.appendChild(this.section('Gövde rengi', paint));
      const lv = document.createElement('div');
      lv.className = 'chips';
      for (const l of DS.LIVERIES) {
        const b = document.createElement('button');
        b.className = 'chip-btn' + (setup.livery === l.id ? ' on' : '');
        b.textContent = l.name;
        b.addEventListener('click', () => { setup.livery = l.id; upd(); });
        lv.appendChild(b);
      }
      box.appendChild(this.section('Kaplama', lv));
      box.appendChild(this.section('Jant', this.swatches(DS.RIMS, setup.rim, (c) => { setup.rim = c; upd(); })));
      const wing = document.createElement('div');
      wing.className = 'chips';
      for (const [v, name] of [[false, 'Yok'], [true, 'Rüzgârlık']]) {
        const b = document.createElement('button');
        b.className = 'chip-btn' + (setup.wing === v ? ' on' : '');
        b.textContent = name;
        b.addEventListener('click', () => { setup.wing = v; upd(); });
        wing.appendChild(b);
      }
      box.appendChild(this.section('Arka kanat', wing));
      box.appendChild(this.section('Alt neon (gece görünür)', this.swatches(DS.GLOWS, setup.glow, (c) => { setup.glow = c; upd(); })));
    },
    buildSmoke() {
      const g = this.g, setup = g.carSetup(g.save.car), box = $('#tab-smoke');
      box.innerHTML = '';
      box.appendChild(this.section('Lastik dumanı rengi', this.swatches(DS.SMOKES, setup.smoke, (c) => { setup.smoke = c; g.applyCarSetup(); this.buildSmoke(); }, 'big')));
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Duman, arka lastikler kaydıkça çıkar. Islak zeminde duman yerine su sisi oluşur.';
      box.appendChild(p);
    },
    buildPerf() {
      const g = this.g, s = g.save, setup = g.carSetup(s.car), box = $('#tab-perf');
      box.innerHTML = '';
      $('#g-money').textContent = '₺' + U.fmt(s.money);
      for (const u of DS.UPGRADES) {
        const lv = setup.upg[u.key] || 0;
        const row = document.createElement('div');
        row.className = 'perf-row';
        const pips = u.levels.map((_, i) => `<i class="${i <= lv ? 'on' : ''}"></i>`).join('');
        const next = u.levels[lv + 1];
        row.innerHTML = `<div class="pr-name"><b>${u.name}</b><small>${u.info} · ${u.levels[lv].label}</small></div><div class="pips">${pips}</div>`;
        const btn = document.createElement('button');
        btn.className = 'mini-btn buy';
        if (next) {
          btn.textContent = '₺' + U.fmt(next.cost);
          btn.disabled = s.money < next.cost;
          btn.addEventListener('click', () => {
            if (s.money < next.cost) return;
            s.money -= next.cost;
            setup.upg[u.key] = lv + 1;
            g.applyCarSetup();
            g.audio.chime();
            this.toast(u.name + ': ' + next.label);
            this.buildPerf();
          });
        } else { btn.textContent = 'Tam'; btn.disabled = true; }
        row.appendChild(btn);
        box.appendChild(row);
      }
      const c = g.car.p;
      const info = document.createElement('p');
      info.className = 'hint';
      info.textContent = `Güncel: ${Math.round(c.torque)} N·m tork, ${Math.round((c.steerMax * 180) / Math.PI)}° direksiyon açısı, tutuş ×${c.mu.toFixed(2)}.`;
      box.appendChild(info);
    },

    // ---------------- KARE GÜNCELLEMESİ ----------------
    frame(dt) {
      const g = this.g;
      if (this.current === 'garage') this.drawPreview();
      if (g.state !== 'play' && g.state !== 'pause') return;
      const sc = g.score;
      // drift kutusu
      if (sc.active) {
        this.dispChain = U.lerp(this.dispChain, sc.chain, 1 - Math.exp(-14 * dt));
        this.el.chain.textContent = U.fmt(this.dispChain);
        this.el.mult.textContent = 'x' + String(+sc.mult.toFixed(2)).replace('.', ',');
        this.el.flag.textContent = sc.prox ? 'YAKIN' : '';
        this.el.drift.classList.add('on');
        this.el.drift.classList.toggle('hot', sc.prox);
        this.el.drift.classList.remove('banked', 'lost');
        this.bankT = 0;
      } else if (this.bankT > 0) {
        this.bankT -= dt;
        if (this.bankT <= 0) this.el.drift.classList.remove('on', 'banked', 'lost', 'hot');
      } else {
        this.el.drift.classList.remove('on', 'hot');
        this.dispChain = 0;
      }
      const ang = U.clamp(sc.angle, 0, 90);
      this.el.angFill.style.transform = `scaleX(${ang / 90})`;
      this.el.angNum.textContent = Math.round(ang) + '°';
      this.el.angFill.classList.toggle('sweet', ang > 30 && ang < 65);
      // mesajlar
      const pump = (arr) => {
        while (arr.length) {
          const m = arr.shift();
          if (m.kind === 'bank') {
            this.el.chain.textContent = m.sub.replace('+', '');
            this.el.drift.classList.add('on', 'banked');
            this.el.flag.textContent = m.text;
            this.bankT = 1.4;
            continue;
          }
          const d = document.createElement('div');
          d.className = 'msg ' + m.kind;
          d.innerHTML = `<b>${m.text}</b>${m.sub ? `<span>${m.sub}</span>` : ''}`;
          this.el.msgs.appendChild(d);
          while (this.el.msgs.children.length > 3) this.el.msgs.firstChild.remove();
          setTimeout(() => d.remove(), 1500);
          if (m.kind === 'bad' && sc.chain === 0) {
            this.el.drift.classList.add('on', 'lost');
            this.el.flag.textContent = m.text;
            this.el.chain.textContent = m.sub || '0';
            this.bankT = 1.1;
          }
        }
      };
      pump(sc.msgs);
      if (g.judge) pump(g.judge.msgs);
      this.el.total.textContent = U.fmt(sc.total);
      this.el.money.textContent = '₺' + U.fmt(g.save.money);
      // tandem
      if (g.mode === 'tandem' && g.judge) {
        const j = g.judge;
        this.el.thud.hidden = false;
        this.el.tprog.style.transform = `scaleX(${j.progress})`;
        this.el.tgap.textContent = Math.max(0, j.gap).toFixed(1) + ' m';
        this.el.tmark.style.left = (U.clamp(j.gap / 30, 0, 1) * 100).toFixed(1) + '%';
        this.el.tmark.classList.toggle('good', j.gap > 1.5 && j.gap <= 9);
        this.el.tscore.textContent = j.live;
        if (j.state === 'count') {
          this.el.count.hidden = false;
          const n = Math.ceil(j.t - 0.4);
          const txt = n > 0 ? String(n) : 'BAŞLA';
          if (this.el.count.textContent !== txt) {
            this.el.count.textContent = txt;
            this.el.count.classList.remove('pop'); void this.el.count.offsetWidth; this.el.count.classList.add('pop');
            g.audio.beep(n > 0 ? 520 : 880, 0.12, 0.08);
          }
        } else this.el.count.hidden = true;
      } else { this.el.thud.hidden = true; this.el.count.hidden = true; }
      this.drawGauge();
      this.drawMini();
      if (g.save.settings.fps) {
        this.el.fps.hidden = false;
        this.el.fps.textContent = Math.round(g.fpsAvg) + ' FPS';
      } else this.el.fps.hidden = true;
    },

    drawGauge() {
      const c = this.el.gauge, g = this.gaugeCtx, car = this.g.car;
      const dpr = c._dpr || 1, w = c._w || 176, h = c._h || 112;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h * 0.66, R = Math.min(w * 0.42, h * 0.6);
      const a0 = Math.PI * 0.82, a1 = Math.PI * 2.18;
      const red = car.p.redline, maxR = Math.ceil(red / 1000 + 0.5) * 1000;
      const ang = (r) => a0 + (a1 - a0) * (r / maxR);
      g.lineCap = 'round';
      g.lineWidth = 7; g.strokeStyle = 'rgba(10,13,20,0.7)';
      g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
      g.lineWidth = 4; g.strokeStyle = 'rgba(255,59,48,0.85)';
      g.beginPath(); g.arc(cx, cy, R, ang(red * 0.92), ang(maxR)); g.stroke();
      const rn = car.rpm;
      g.lineWidth = 4; g.strokeStyle = rn > red * 0.92 ? '#ff3b30' : '#ffb23e';
      g.beginPath(); g.arc(cx, cy, R, a0, ang(Math.min(rn, maxR))); g.stroke();
      g.fillStyle = 'rgba(242,237,227,0.7)';
      g.font = '600 9px "Chakra Petch", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let k = 0; k <= maxR / 1000; k++) {
        const a = ang(k * 1000);
        g.fillText(String(k), cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
      }
      const na = ang(Math.min(rn, maxR));
      g.strokeStyle = '#f2ede3'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx + Math.cos(na) * 8, cy + Math.sin(na) * 8); g.lineTo(cx + Math.cos(na) * (R + 3), cy + Math.sin(na) * (R + 3)); g.stroke();
      const kmh = Math.round(car.speed * 3.6);
      g.fillStyle = '#f2ede3';
      g.font = '400 26px Bungee, Impact, sans-serif';
      g.fillText(String(kmh), cx, cy - 4);
      g.font = '600 9px "Chakra Petch", sans-serif'; g.fillStyle = 'rgba(242,237,227,0.6)';
      g.fillText('km/h', cx, cy + 14);
      const gear = car.gear === -1 ? 'R' : String(car.gear);
      g.fillStyle = car.gear === -1 ? '#ff3b30' : '#ffb23e';
      g.font = '400 16px Bungee, Impact, sans-serif';
      g.fillText(gear, cx + R * 0.95, cy + R * 0.42);
      if (car.p.turbo > 0) {
        g.lineWidth = 3; g.strokeStyle = 'rgba(56,217,255,0.85)';
        g.beginPath(); g.arc(cx, cy, R - 22, Math.PI * 1.2, Math.PI * (1.2 + 0.6 * car.boost)); g.stroke();
      }
    },

    drawMini() {
      const c = this.el.mini, g = this.miniCtx, game = this.g, city = game.city, mini = city.mini;
      if (!mini) return;
      const dpr = c._dpr || 1, w = c._w || 120, h = c._h || 120;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.save();
      g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 2, 0, U.TAU); g.clip();
      g.fillStyle = '#16251a'; g.fillRect(0, 0, w, h);
      const car = game.car, k = 0.42;
      g.translate(w / 2, h / 2);
      g.rotate(game.cam.rot);
      g.scale(k / mini.sc, k / mini.sc);
      g.drawImage(mini.c, -car.x * mini.sc, -car.y * mini.sc);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const toMini = (x, y) => {
        const dx = (x - car.x) * k, dy = (y - car.y) * k, r = game.cam.rot;
        return [w / 2 + dx * Math.cos(r) - dy * Math.sin(r), h / 2 + dx * Math.sin(r) + dy * Math.cos(r)];
      };
      if (game.mode === 'tandem' && game.leader) {
        const [lx, ly] = toMini(game.leader.x, game.leader.y);
        g.fillStyle = '#38d9ff'; g.beginPath(); g.arc(lx, ly, 4, 0, U.TAU); g.fill();
      }
      g.restore();
      g.save();
      g.translate(w / 2, h / 2);
      g.rotate(car.h + game.cam.rot);
      g.fillStyle = '#ffb23e';
      g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -4.5); g.lineTo(-2.5, 0); g.lineTo(-5, 4.5); g.closePath(); g.fill();
      g.restore();
      g.lineWidth = 2; g.strokeStyle = 'rgba(242,237,227,0.35)';
      g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 2, 0, U.TAU); g.stroke();
    },

    drawPreview() {
      const c = $('#g-preview');
      if (!c || !c.width) return;
      const g = c.getContext('2d');
      const s = this.g.save, def = DS.carById(s.car), setup = this.g.carSetup(s.car);
      DS.CarRender.drawPreview(g, c.width, c.height, def, setup, performance.now() / 1000);
    },

    showResult(res, reward) {
      $('#r-title').textContent = res.done ? (res.score >= 65 ? 'Kazandın' : 'Kaybettin') : 'Tur bitmedi';
      $('#r-score').textContent = res.score;
      const set = (id, v) => { $('#r-' + id).style.transform = `scaleX(${U.sat(v)})`; $('#r-' + id + '-n').textContent = Math.round(v * 100); };
      set('prox', res.prox); set('ang', res.ang); set('line', res.line);
      $('#r-note').textContent = res.note || (reward > 0 ? `Ödül: ₺${U.fmt(reward)}. Kazanmak için 65 puan gerekir.` : 'Kazanmak için 65 puan gerekir. Lideri 2–9 metre arayla ve aynı açıyla takip et.');
      this.show('result');
    },
  });
})();
