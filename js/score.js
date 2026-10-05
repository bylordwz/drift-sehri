'use strict';
// Drift puanlama: açı × hız × çarpan; geçiş, yakınlık ve klip bonusları; çarpma/spin kombo kaybı
(function () {
  const DS = window.DS, U = DS.U;

  class DriftScore {
    constructor() {
      this.total = 0; this.best = 0;
      this.msgs = [];
      this.reset();
    }
    reset() {
      this.active = false; this.chain = 0; this.mult = 1; this.time = 0; this.grace = 0;
      this.side = 0; this.multT = 0; this.prox = false; this.proxT = 0; this.proxShown = 0;
      this.angle = 0; this.flips = 0;
    }
    msg(text, kind, sub) { this.msgs.push({ text, kind: kind || 'good', sub: sub || '' }); }

    update(dt, car, near) {
      const kmh = car.speed * 3.6;
      const ang = Math.abs(car.beta) * 57.2958;
      this.angle = car.vxl > 0 ? ang : 0;
      const side = Math.sign(car.beta);
      const drifting = kmh > 25 && ang > 12 && ang < 110 && car.vxl > 1.5;
      if (this.active && ang >= 115 && kmh > 12) { this.fail('SPİN!'); return; }
      if (drifting) {
        if (!this.active) {
          this.active = true; this.chain = 0; this.mult = 1; this.time = 0; this.multT = 0;
          this.side = side; this.flips = 0; this.proxShown = 0;
        }
        if (side !== this.side && this.time > 0.35) {
          this.side = side; this.flips++;
          const b = 300 * this.mult;
          this.chain += b;
          this.mult = Math.min(this.mult + 0.5, 8);
          this.msg('GEÇİŞ', 'good', '+' + U.fmt(b));
        }
        this.time += dt; this.grace = 0;
        const af = U.clamp((ang - 10) / 45, 0, 1.35);
        const sf = U.clamp(kmh / 60, 0.35, 2.4);
        let rate = 140 * af * sf;
        this.prox = near < 1.4;
        if (this.prox) {
          rate *= 1.8;
          this.proxT += dt;
          if (this.proxT > 0.3 && this.time - this.proxShown > 1.6) { this.proxShown = this.time; this.msg('YAKIN!', 'hot'); }
        } else this.proxT = 0;
        this.chain += rate * this.mult * dt;
        this.multT += dt;
        if (this.multT > 2.2) { this.multT = 0; this.mult = Math.min(this.mult + 0.25, 8); }
      } else if (this.active) {
        this.prox = false;
        this.grace += dt;
        if (this.grace > 0.9 || kmh < 12) this.bank();
      }
    }

    clip(car) {
      if (!this.active) return false;
      const bonus = 500 * this.mult * U.clamp(this.angle / 40, 0.5, 1.5);
      this.chain += bonus;
      this.msg('KLİP!', 'hot', '+' + U.fmt(bonus));
      return true;
    }

    impact(vn) {
      if (!this.active) return;
      if (vn > 3.4) this.fail('ÇARPTIN!');
      else if (vn > 1.6) { this.chain *= 0.85; this.msg('SÜRTÜNME', 'bad', '−%15'); }
    }

    fail(reason) {
      const lost = Math.round(this.chain);
      this.reset();
      this.msg(reason, 'bad', lost > 0 ? '−' + U.fmt(lost) : '');
      this.onFail && this.onFail(lost);
    }

    bank() {
      const pts = Math.round(this.chain);
      const mult = this.mult;
      this.reset();
      if (pts < 60) return;
      this.total += pts;
      if (pts > this.best) this.best = pts;
      let rating = DS.RATINGS[0][1];
      for (const [th, name] of DS.RATINGS) if (pts >= th) rating = name;
      this.msg(rating, 'bank', '+' + U.fmt(pts));
      this.onBank && this.onBank(pts, mult);
    }
  }
  DS.DriftScore = DriftScore;
})();
