'use strict';
// Girdi: klavye, çoklu dokunmatik butonlar, kaydırıcı, yüzen joystick, eğim (jiroskop), oyun kumandası.
// Açık şehirde iki bağlam vardır: 'foot' (yaya) ve 'drive' (araç). Bağlam değişince basılı tuş ve
// parmaklar bırakılana kadar yok sayılır (yürürken basılı tutulan W, araca binince gaz olmasın).
(function () {
  const DS = window.DS, U = DS.U;
  const HOLD = { left: 1, right: 1, gas: 1, brake: 1, hand: 1, attack: 1, horn: 1 };
  const EDGE = { gup: 1, gdn: 1, enter: 1, act: 1, map: 1 };
  // dokunmatikte basınca titreşimli geri bildirim alan yeni düğmeler
  const BUZZ = { enter: 1, act: 1, map: 1, attack: 1, horn: 1 };
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake',
    Space: 'hand', ShiftLeft: 'run', ShiftRight: 'run', KeyH: 'horn',
  };
  const KEYEDGE = {
    ShiftLeft: 'kick', ShiftRight: 'kick', KeyE: 'gup', KeyX: 'gup', KeyQ: 'gdn', KeyZ: 'gdn',
    KeyR: 'reset', KeyP: 'pause', Escape: 'pause', KeyC: 'cam', KeyM: 'mute', KeyN: 'mute',
    KeyF: 'enter', Enter: 'enter', NumpadEnter: 'enter',
  };
  // açık şehirde anlamı değişen tuşlar
  const KEYEDGE_W = { KeyE: 'act', KeyM: 'map', Tab: 'map' };
  // yüzen joystick: yarıçap (css px), ölü bölge, koşma eşiği, ana yön yakalama açısı
  const STICK_R = 56, STICK_DEAD = 0.12, STICK_RUN = 0.6, STICK_SNAP = (8 * Math.PI) / 180;
  const PAD_DEAD = 0.15;
  const SQ12 = Math.SQRT1_2;

  class Input {
    constructor() {
      this.codes = new Map();       // basılı fiziksel tuş -> mantıksal ad (KEYMAP)
      this.kc = {};                 // mantıksal ad -> basılı tuş sayısı
      this.ptr = new Map();         // işaretçi -> basılı tutulan kontrol
      this.pc = {};                 // kontrol -> basan işaretçi sayısı
      this.latchK = new Set();      // bağlam değişiminde kilitlenen tuşlar (bırakılana kadar yok)
      this.latchP = new Set();      // bağlam değişiminde kilitlenen işaretçiler
      this.padLatch = [];           // kilitli kumanda düğmeleri
      this.padAxLatch = false;      // kilitli sol çubuk
      this.sliderId = null; this.sliderVal = 0; this.sliderEl = null;
      this.stickId = null; this.stickEl = null; this.stickX = 0; this.stickY = 0; this.stickRun = false;
      this.stickBX = 0; this.stickBY = 0; this.stickZX = 0; this.stickZY = 0; this.stickRunWas = false;
      this.tilt = 0; this.tiltOn = false;
      this.mode = 'buttons'; this.sens = 0.6;
      this.dsteer = 0;
      this.out = { steer: 0, throttle: 0, brake: 0, handbrake: false, kick: false, mx: 0, my: 0, run: false, attack: false, horn: false };
      this.edges = {};
      this.gasWas = false; this.gasDownT = -9; this.gasUpT = -9;
      this.padPrev = [];
      this.usingPad = false;
      this.backDownT = -1; this.backFired = false;
      this.els = {};
      this.enabled = true;
      this.padCount = 0;
      this.onState = {};
      this.world = false;           // açık şehir modunda mı (main ayarlar)
      this.ctx = 'drive';           // 'foot' | 'drive'
    }

    attach(root) {
      this.root = root;
      // kumanda yalnızca bağlıyken yoklanır
      window.addEventListener('gamepadconnected', () => { this.padCount++; });
      window.addEventListener('gamepaddisconnected', () => { this.padCount = Math.max(0, this.padCount - 1); this.usingPad = false; });
      root.querySelectorAll('[data-ctl]').forEach((el) => { this.els[el.dataset.ctl] = el; });
      this.stickBase = document.getElementById('stick-base');
      this.stickKnob = document.getElementById('stick-knob');
      window.addEventListener('keydown', (e) => {
        const tg = e.target, tag = tg && tg.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        const code = e.code;
        const k = KEYMAP[code];
        if (k) {
          if (!this.latchK.has(code) && !this.codes.has(code)) { this.codes.set(code, k); this.kc[k] = (this.kc[k] || 0) + 1; }
          if (k !== 'run') e.preventDefault();
        }
        let ed = (this.world && KEYEDGE_W[code]) || KEYEDGE[code];
        // açık bir menü varken Tab odak gezintisine kalır
        if (code === 'Tab' && DS.UI && DS.UI.current) ed = null;
        if (!ed || e.repeat) return;
        // görünür bir düğme odaktayken Enter o düğmeye aittir (menüde klavyeyle gezinme bozulmasın)
        if (ed === 'enter' && code !== 'KeyF' && tag === 'BUTTON' && tg.getClientRects().length) return;
        this.edges[ed] = true;
        if (ed !== 'pause') e.preventDefault();
      });
      window.addEventListener('keyup', (e) => {
        const code = e.code;
        this.latchK.delete(code);
        const k = this.codes.get(code);
        if (k !== undefined) { this.codes.delete(code); this.kc[k]--; }
      });
      window.addEventListener('blur', () => this.releaseAll());

      const down = (e) => {
        const el = e.target.closest && e.target.closest('[data-ctl]');
        if (!el || !this.enabled) return;
        e.preventDefault();
        const ctl = el.dataset.ctl;
        if (ctl === 'slider') {
          this.sliderId = e.pointerId; this.sliderEl = el;
          this.updSlider(e);
        } else if (ctl === 'stick') {
          if (this.stickId !== null) return;
          this.stickStart(e, el);
        } else if (EDGE[ctl]) {
          this.edges[ctl] = true;
          el.classList.add('on');
          setTimeout(() => el.classList.remove('on'), 140);
        } else {
          this.pset(e.pointerId, ctl);
        }
        if (BUZZ[ctl]) this.buzz();
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* desteklenmiyor */ }
      };
      const move = (e) => {
        const id = e.pointerId;
        if (this.latchP.has(id)) return;
        if (id === this.sliderId) { this.updSlider(e); return; }
        if (id === this.stickId) { this.stickMove(e.clientX, e.clientY); return; }
        if (!this.ptr.has(id)) return;
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const el = hit && hit.closest ? hit.closest('[data-ctl]') : null;
        if (el && HOLD[el.dataset.ctl] && this.ptr.get(id) !== el.dataset.ctl) this.pset(id, el.dataset.ctl);
      };
      const up = (e) => {
        const id = e.pointerId;
        if (this.latchP.delete(id)) return;
        if (id === this.sliderId) { this.sliderId = null; this.sliderVal = 0; this.drawSlider(); }
        if (id === this.stickId) this.stickEnd();
        this.pdel(id);
      };
      root.addEventListener('pointerdown', down);
      root.addEventListener('pointermove', move);
      root.addEventListener('pointerup', up);
      root.addEventListener('pointercancel', up);
      root.addEventListener('lostpointercapture', up);
      root.addEventListener('contextmenu', (e) => e.preventDefault());
      this.stickEnd();
    }

    // basılı tutulan dokunmatik kontrol kaydı (sayaçlı: her karede yineleme yok)
    pset(id, ctl) {
      this.pdel(id);
      this.ptr.set(id, ctl);
      this.pc[ctl] = (this.pc[ctl] || 0) + 1;
    }
    pdel(id) {
      const old = this.ptr.get(id);
      if (old === undefined) return;
      this.ptr.delete(id);
      this.pc[old]--;
    }
    buzz() {
      // ilk dokunuştan önce titreşim engellenir (ve konsola uyarı düşer): yalnızca etkinleştirilmiş sayfada
      try {
        const ua = navigator.userActivation;
        if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate(10);
      } catch (e) { /* desteklenmiyor */ }
    }

    updSlider(e) {
      const r = this.sliderEl.getBoundingClientRect();
      this.sliderVal = U.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      if (Math.abs(this.sliderVal) < 0.06) this.sliderVal = 0;
      this.drawSlider();
    }
    drawSlider() {
      const k = this.els.slider && this.els.slider.querySelector('.knob');
      if (k) k.style.transform = `translateX(${this.sliderVal * 100}%)`;
    }

    // ---------- yüzen joystick ----------
    // Taban, dokunulan noktada belirir (kenarlardan ≥ 64 px); parmak 1.25 R'yi aşarsa taban peşinden gelir.
    stickStart(e, el) {
      this.stickId = e.pointerId; this.stickEl = el;
      const r = el.getBoundingClientRect();
      this.stickZX = r.left; this.stickZY = r.top;
      const vw = window.innerWidth || 800, vh = window.innerHeight || 600;
      this.stickBX = U.clamp(e.clientX, 64, Math.max(64, vw - 64));
      this.stickBY = U.clamp(e.clientY, 64, Math.max(64, vh - 64));
      if (this.stickBase) this.stickBase.classList.add('on');
      this.stickRunWas = false;
      this.stickMove(e.clientX, e.clientY);
    }
    stickMove(cx, cy) {
      let dx = cx - this.stickBX, dy = cy - this.stickBY;
      let d = Math.hypot(dx, dy);
      const lim = STICK_R * 1.25;
      if (d > lim) {
        // taban parmağı izler: vektör kenarda kalır
        const f = (d - lim) / d;
        this.stickBX += dx * f; this.stickBY += dy * f;
        dx = cx - this.stickBX; dy = cy - this.stickBY; d = lim;
      }
      const m = U.clamp(d / STICK_R, 0, 1);
      const mm = U.sat((m - STICK_DEAD) / (1 - STICK_DEAD));
      if (mm <= 0) { this.stickX = 0; this.stickY = 0; this.stickRun = false; }
      else {
        let a = Math.atan2(dy, dx);
        // ana yönlere ±8° yakalama (ızgara şehirde dümdüz yürümek kolay olsun)
        const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(a - q) < STICK_SNAP) a = q;
        const run = mm >= STICK_RUN;
        // yürürken hız sapma ile artar; koşu eşiğinde tam vektör
        const s = run ? 1 : mm / STICK_RUN;
        this.stickX = Math.cos(a) * s; this.stickY = Math.sin(a) * s;
        if (Math.abs(this.stickX) < 1e-6) this.stickX = 0;
        if (Math.abs(this.stickY) < 1e-6) this.stickY = 0;
        this.stickRun = run;
        if (run && !this.stickRunWas) this.buzz();
      }
      this.stickRunWas = this.stickRun;
      this.drawStick(dx, dy, d);
    }
    stickEnd() {
      this.stickId = null; this.stickX = 0; this.stickY = 0; this.stickRun = false; this.stickRunWas = false;
      if (this.stickBase) {
        this.stickBase.classList.remove('on');
        // dinlenme konumu: CSS'teki varsayılan yer (soluk ipucu halkası)
        this.stickBase.style.transform = '';
      }
      if (this.stickKnob) this.stickKnob.style.transform = '';
    }
    drawStick(dx, dy, d) {
      if (!this.stickBase) return;
      const bx = this.stickBX - this.stickZX - STICK_R, by = this.stickBY - this.stickZY - STICK_R;
      this.stickBase.style.transform = `translate(${bx.toFixed(1)}px,${by.toFixed(1)}px)`;
      if (this.stickKnob) {
        const f = d > STICK_R ? STICK_R / d : 1;
        this.stickKnob.style.transform = `translate(${(dx * f).toFixed(1)}px,${(dy * f).toFixed(1)}px)`;
      }
    }

    async enableTilt() {
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') return false;
        }
      } catch (e) { return false; }
      if (!this._tiltBound) {
        this._tiltBound = true;
        window.addEventListener('deviceorientation', (e) => {
          if (e.beta === null || e.gamma === null) return;
          this.tiltOn = true;
          const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
          let t;
          if (ang === 90) t = e.beta;
          else if (ang === -90 || ang === 270) t = -e.beta;
          else t = e.gamma;
          this.tilt = t;
        });
      }
      return true;
    }

    held(name) { return this.kc[name] > 0 || this.pc[name] > 0; }
    edge(name) {
      const v = !!this.edges[name];
      this.edges[name] = false;
      return v;
    }
    clearEdges() { this.edges = {}; }

    // Bağlam değişimi (yaya <-> araç): basılı her şey bırakılana kadar yok sayılır, kenarlar silinir
    setContext(c) {
      this.ctx = c === 'foot' ? 'foot' : 'drive';
      for (const code of this.codes.keys()) this.latchK.add(code);
      this.codes.clear(); this.kc = {};
      for (const id of this.ptr.keys()) this.latchP.add(id);
      this.ptr.clear(); this.pc = {};
      if (this.sliderId !== null) { this.latchP.add(this.sliderId); this.sliderId = null; this.sliderVal = 0; this.drawSlider(); }
      if (this.stickId !== null) { this.latchP.add(this.stickId); this.stickEnd(); }
      for (let i = 0; i < this.padPrev.length; i++) if (this.padPrev[i]) this.padLatch[i] = true;
      this.padAxLatch = true;
      this.backDownT = -1; this.backFired = true;
      this.dsteer = 0; this.gasWas = false;
      this.clearEdges();
      this.syncOn();
    }
    releaseAll() {
      this.codes.clear(); this.kc = {}; this.latchK.clear();
      this.ptr.clear(); this.pc = {}; this.latchP.clear();
      this.sliderId = null; this.sliderVal = 0;
      if (this.stickId !== null) this.stickEnd();
    }

    poll(dt, now) {
      const o = this.out;
      const foot = this.ctx === 'foot';
      const left = this.held('left'), right = this.held('right');
      let gas = this.held('gas') ? 1 : 0, brake = this.held('brake') ? 1 : 0, hand = this.held('hand');
      let steer;
      if (this.mode === 'slider' && this.sliderId !== null) steer = this.sliderVal;
      else if (this.mode === 'tilt' && this.tiltOn && !left && !right) {
        const t = this.tilt;
        steer = Math.abs(t) < 2 ? 0 : U.clamp((t - Math.sign(t) * 2) / 22, -1, 1);
      } else {
        const target = (right ? 1 : 0) - (left ? 1 : 0);
        const rate = target !== 0 ? (Math.sign(target) !== Math.sign(this.dsteer) && this.dsteer !== 0 ? 10 : 2.6 + this.sens * 7) : 12;
        this.dsteer = U.approach(this.dsteer, target, rate * dt);
        steer = this.dsteer;
      }
      // yaya hareketi: ekran yönlü (sağ +x, aşağı +y), çapraz normalize
      let mx = 0, my = 0, run = false, attack = false;
      if (foot) {
        mx = (right ? 1 : 0) - (left ? 1 : 0);
        my = brake - gas;
        if (mx !== 0 && my !== 0) { mx *= SQ12; my *= SQ12; }
        run = this.held('run');
        if (this.stickX !== 0 || this.stickY !== 0) { mx = this.stickX; my = this.stickY; run = run || this.stickRun; }
        attack = hand || this.held('attack');
      }
      // oyun kumandası
      let gp = null, padHorn = false;
      if (this.padCount > 0 && navigator.getGamepads) {
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
      }
      if (gp) {
        const latch = this.padLatch;
        const b = (i) => {
          const v = gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0;
          if (latch[i]) { if (v < 0.1) latch[i] = false; return 0; }
          return v;
        };
        let ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (this.padAxLatch) {
          if (Math.abs(ax) < PAD_DEAD && Math.abs(ay) < PAD_DEAD) this.padAxLatch = false;
          ax = 0; ay = 0;
        }
        const rt = b(7), lt = b(6);
        if (Math.abs(ax) > 0.12 || (foot && Math.abs(ay) > 0.12) || rt > 0.05 || lt > 0.05 || b(0) || b(1)) this.usingPad = true;
        if (this.usingPad) {
          if (foot) {
            // sol çubuk: dairesel ölü bölge, yeniden ölçekli
            const d = Math.hypot(ax, ay);
            if (d > PAD_DEAD) {
              const s = Math.min(1, (d - PAD_DEAD) / (1 - PAD_DEAD)) / d;
              mx = ax * s; my = ay * s;
            }
            run = run || b(0) > 0.5;
            attack = attack || b(1) > 0.5;
          } else {
            if (Math.abs(ax) > 0.08) steer = Math.sign(ax) * Math.pow((Math.abs(ax) - 0.08) / 0.92, 1.3);
            gas = Math.max(gas, rt); brake = Math.max(brake, lt);
            hand = hand || b(0) > 0.5 || b(1) > 0.5;
          }
        }
        const ed = (i, name) => { const p = b(i) > 0.5; if (p && !this.padPrev[i] && name) this.edges[name] = true; this.padPrev[i] = p; };
        if (this.world) {
          ed(5, 'gup'); ed(4, 'gdn'); ed(2, foot ? 'act' : 'kick'); ed(3, 'enter'); ed(9, 'pause'); ed(11, 'cam'); ed(12, 'act');
          // Geri (8): kısa dokunuş = harita, 1 s basılı = kurtar
          const bk = b(8) > 0.5;
          if (bk) {
            if (!this.padPrev[8]) { this.backDownT = now; this.backFired = false; }
            else if (!this.backFired && this.backDownT >= 0 && now - this.backDownT >= 1) { this.edges.reset = true; this.backFired = true; }
          } else if (this.padPrev[8]) {
            if (!this.backFired && this.backDownT >= 0 && now - this.backDownT < 0.5) this.edges.map = true;
            this.backDownT = -1;
          }
          this.padPrev[8] = bk;
          // L3 = korna (araçta)
          padHorn = !foot && b(10) > 0.5;
        } else {
          ed(5, 'gup'); ed(4, 'gdn'); ed(2, 'kick'); ed(3, 'reset'); ed(9, 'pause'); ed(8, 'cam');
        }
      }
      // gaza çift dokunuş = debriyaj atma
      const gasOn = gas > 0.5;
      let kick = this.edge('kick');
      if (gasOn && !this.gasWas) {
        if (now - this.gasUpT < 0.24 && this.gasUpT - this.gasDownT < 0.24) kick = true;
        this.gasDownT = now;
      } else if (!gasOn && this.gasWas) this.gasUpT = now;
      this.gasWas = gasOn;

      if (foot) {
        // yayayken sürüş girdileri sıfır (araç adımı yapılmaz; araca binince temiz başlasın)
        o.steer = 0; o.throttle = 0; o.brake = 0; o.handbrake = false; o.kick = false;
        this.dsteer = 0;
      } else {
        o.steer = steer; o.throttle = gas; o.brake = brake; o.handbrake = hand; o.kick = kick;
      }
      o.mx = mx; o.my = my; o.run = run; o.attack = attack;
      o.horn = this.held('horn') || padHorn;
      this.syncOn();
      return o;
    }

    // dokunmatik basılı tutma düğmelerinin .on görünümü (yalnızca değişince yazılır)
    syncOn() {
      if (!document.body.classList.contains('touch')) return;
      for (const k in HOLD) {
        const el = this.els[k];
        if (!el) continue;
        const on = this.held(k);
        if (this.onState[k] !== on) { this.onState[k] = on; el.classList.toggle('on', on); }
      }
    }

    reset() {
      this.ptr.clear(); this.pc = {}; this.sliderId = null; this.sliderVal = 0; this.dsteer = 0; this.drawSlider();
      if (this.stickId !== null) this.stickEnd();
      this.clearEdges();
    }
  }
  DS.Input = Input;
})();
