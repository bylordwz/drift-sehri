'use strict';
// Girdi: klavye, çoklu dokunmatik butonlar, kaydırıcı, eğim (jiroskop), oyun kumandası
(function () {
  const DS = window.DS, U = DS.U;
  const HOLD = { left: 1, right: 1, gas: 1, brake: 1, hand: 1 };
  const EDGE = { gup: 1, gdn: 1 };
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake',
    Space: 'hand',
  };
  const KEYEDGE = {
    ShiftLeft: 'kick', ShiftRight: 'kick', KeyE: 'gup', KeyX: 'gup', KeyQ: 'gdn', KeyZ: 'gdn',
    KeyR: 'reset', KeyP: 'pause', Escape: 'pause', KeyC: 'cam', KeyM: 'mute',
  };

  class Input {
    constructor() {
      this.keys = new Set();
      this.ptr = new Map();
      this.sliderId = null; this.sliderVal = 0; this.sliderEl = null;
      this.tilt = 0; this.tiltOn = false;
      this.mode = 'buttons'; this.sens = 0.6;
      this.dsteer = 0;
      this.out = { steer: 0, throttle: 0, brake: 0, handbrake: false, kick: false };
      this.edges = {};
      this.gasWas = false; this.gasDownT = -9; this.gasUpT = -9;
      this.padPrev = [];
      this.usingPad = false;
      this.els = {};
      this.enabled = true;
    }

    attach(root) {
      this.root = root;
      root.querySelectorAll('[data-ctl]').forEach((el) => { this.els[el.dataset.ctl] = el; });
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        const k = KEYMAP[e.code];
        if (k) { this.keys.add(k); e.preventDefault(); }
        const ed = KEYEDGE[e.code];
        if (ed && !e.repeat) { this.edges[ed] = true; if (ed !== 'pause') e.preventDefault(); }
      });
      window.addEventListener('keyup', (e) => {
        const k = KEYMAP[e.code];
        if (k) this.keys.delete(k);
      });
      window.addEventListener('blur', () => { this.keys.clear(); this.ptr.clear(); this.sliderId = null; this.sliderVal = 0; });

      const down = (e) => {
        const el = e.target.closest && e.target.closest('[data-ctl]');
        if (!el || !this.enabled) return;
        e.preventDefault();
        const ctl = el.dataset.ctl;
        if (ctl === 'slider') {
          this.sliderId = e.pointerId; this.sliderEl = el;
          this.updSlider(e);
        } else if (EDGE[ctl]) {
          this.edges[ctl] = true;
          el.classList.add('on');
          setTimeout(() => el.classList.remove('on'), 140);
        } else {
          this.ptr.set(e.pointerId, ctl);
        }
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* desteklenmiyor */ }
      };
      const move = (e) => {
        if (e.pointerId === this.sliderId) { this.updSlider(e); return; }
        if (!this.ptr.has(e.pointerId)) return;
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const el = hit && hit.closest ? hit.closest('[data-ctl]') : null;
        if (el && HOLD[el.dataset.ctl]) this.ptr.set(e.pointerId, el.dataset.ctl);
      };
      const up = (e) => {
        if (e.pointerId === this.sliderId) { this.sliderId = null; this.sliderVal = 0; this.drawSlider(); }
        this.ptr.delete(e.pointerId);
      };
      root.addEventListener('pointerdown', down);
      root.addEventListener('pointermove', move);
      root.addEventListener('pointerup', up);
      root.addEventListener('pointercancel', up);
      root.addEventListener('lostpointercapture', up);
      root.addEventListener('contextmenu', (e) => e.preventDefault());
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

    held(name) {
      if (this.keys.has(name)) return true;
      for (const v of this.ptr.values()) if (v === name) return true;
      return false;
    }
    edge(name) {
      const v = !!this.edges[name];
      this.edges[name] = false;
      return v;
    }
    clearEdges() { this.edges = {}; }

    poll(dt, now) {
      const o = this.out;
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
      // oyun kumandası
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = pads && Array.from(pads).find((p) => p && p.connected);
      if (gp) {
        const b = (i) => (gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
        const ax = gp.axes[0] || 0;
        const rt = b(7), lt = b(6);
        if (Math.abs(ax) > 0.12 || rt > 0.05 || lt > 0.05 || b(0) || b(1)) this.usingPad = true;
        if (this.usingPad) {
          if (Math.abs(ax) > 0.08) steer = Math.sign(ax) * Math.pow((Math.abs(ax) - 0.08) / 0.92, 1.3);
          gas = Math.max(gas, rt); brake = Math.max(brake, lt);
          hand = hand || b(0) > 0.5 || b(1) > 0.5;
        }
        const ed = (i, name) => { const p = b(i) > 0.5; if (p && !this.padPrev[i]) this.edges[name] = true; this.padPrev[i] = p; };
        ed(5, 'gup'); ed(4, 'gdn'); ed(2, 'kick'); ed(3, 'reset'); ed(9, 'pause'); ed(8, 'cam');
      }
      // gaza çift dokunuş = debriyaj atma
      const gasOn = gas > 0.5;
      let kick = this.edge('kick');
      if (gasOn && !this.gasWas) {
        if (now - this.gasUpT < 0.24 && this.gasUpT - this.gasDownT < 0.24) kick = true;
        this.gasDownT = now;
      } else if (!gasOn && this.gasWas) this.gasUpT = now;
      this.gasWas = gasOn;

      o.steer = steer; o.throttle = gas; o.brake = brake; o.handbrake = hand; o.kick = kick;
      for (const k in HOLD) {
        const el = this.els[k];
        if (el) el.classList.toggle('on', this.held(k));
      }
      return o;
    }

    reset() {
      this.ptr.clear(); this.sliderId = null; this.sliderVal = 0; this.dsteer = 0; this.drawSlider();
      this.clearEdges();
    }
  }
  DS.Input = Input;
})();
