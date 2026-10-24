/*
 * PolyTrack Tweaks — ghosts on and off mid-run, Trackmania-style checkpoint splits, and a session timer.
 *
 * Ghosts: the "Toggle ghosts" key (G unless changed in Settings → Controls → Tweaks: other keys) hides the
 * ghosts you are racing against, or brings them back, at any moment of a run. Hidden ghosts leave
 * no skid marks or smoke and make no sound. The choice holds through restarts and later races until
 * you press the key again (it is not saved when the game closes). Their times still count: the
 * game's Difference, the splits below and the telemetry panel keep comparing against them.
 *
 * Splits: passing a checkpoint pops your time and speed up at the top of the screen, with the
 * difference to the same ghost the game's own Difference box uses (the quickest one, your personal
 * best on a tie) — blue when you are ahead (or faster), red when behind (or slower) — and the same at
 * the finish. In the replay viewer it does this for the focused car against the quickest other car.
 * Settings → Tweaks → Checkpoint splits turns it off.
 *
 * Session timer: how long you have been on this track, in the top right corner of a race. Restarts
 * don't reset it; leaving the track does. Settings → Tweaks → Session timer turns it off.
 */
(function () {
  'use strict';

  const SHOW_MS = 3000;            // how long a split stays up
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtTime = (ms) => (ms == null ? '—' : window.PTRunsCore ? window.PTRunsCore.formatTime(ms) : (ms / 1000).toFixed(3));
  const fmtDelta = (ms) => (ms > 0 ? '+' : ms < 0 ? '−' : '±') + (Math.abs(ms) / 1000).toFixed(3);
  const fmtClock = (ms) => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
  };

  const CSS = `
.pt-split { position:absolute; left:50%; top:22px; z-index:31; display:flex; flex-direction:column; align-items:center; gap:4px;
  transform:translateX(-50%) scale(0.92); opacity:0; pointer-events:none; font-family:ForcedSquare, system-ui, sans-serif;
  color:#fff; transition:opacity 0.12s ease-out, transform 0.12s ease-out; }
.pt-split.low { top:112px; }
.pt-split.show { opacity:1; transform:translateX(-50%) scale(1); }
.pt-split.fade { opacity:0; transition:opacity 0.45s ease-in; }
.pt-split .main { display:flex; align-items:stretch; background:rgba(12,16,38,0.82);
  clip-path:polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%); }
.pt-split .cp { display:flex; align-items:center; padding:0 12px 0 16px; font-size:19px; color:#cfd6ff; background:rgba(255,255,255,0.10); }
.pt-split .time { padding:3px 14px 1px 12px; font-size:36px; line-height:1.15; letter-spacing:1px; }
.pt-split .speed { display:flex; align-items:center; padding:0 18px 0 12px; font-size:21px; color:#dfe4ff; border-left:1px solid rgba(255,255,255,0.15); }
.pt-split .speed small { font-size:13px; opacity:0.7; margin-left:4px; }
.pt-split .deltas { display:flex; gap:6px; }
.pt-split .delta { padding:1px 16px; font-size:27px; line-height:1.2; clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-split .delta.sp { font-size:19px; display:flex; align-items:center; }
.pt-split .delta.ahead { background:#2266dd; }
.pt-split .delta.behind { background:#d33a3a; }
.pt-split .delta.level { background:#5b6178; }
.pt-split .ref { font-size:14px; opacity:0.85; text-shadow:0 0 4px #000, 0 0 2px #000; }

.pt-session { position:absolute; right:12px; top:38px; z-index:30; pointer-events:none; display:flex; align-items:baseline; gap:7px;
  padding:3px 10px; background:rgba(12,16,38,0.55); color:#eef1ff; font-family:ForcedSquare, system-ui, sans-serif;
  clip-path:polygon(6px 0, 100% 0, 100% 100%, 0 100%); }
.pt-session.low { top:84px; }
.pt-session .lbl { font-size:11px; letter-spacing:1px; opacity:0.65; }
.pt-session .t { font-size:20px; }
.pt-session.hidden { display:none; }
`;

  /** The ghost the game measures you against: the quickest, your own best on a tie (its _s). */
  function bestGhost(ghosts) {
    let best = null;
    for (const g of ghosts || []) {
      const t = g.settings && g.settings.time;
      if (!t) continue;
      if (!best || t.numberOfFrames < best.settings.time.numberOfFrames
        || (t.numberOfFrames === best.settings.time.numberOfFrames && g.settings.isSelf)) best = g;
    }
    return best;
  }

  /** A copy of a ghost's times and speeds, so a new personal best replacing it mid-callback can't change them. */
  function snapshot(g) {
    if (!g) return null;
    return { name: g.settings.isSelf ? 'PB' : (g.settings.nickname || 'Ghost'), finish: g.settings.time.numberOfFrames,
      cps: (g.checkpoints || []).map((c) => c.time.numberOfFrames),
      speeds: (g.checkpoints || []).map((c) => (c.speedKmh != null ? c.speedKmh : null)),
      finishSpeed: g.finishSpeedKmh != null ? g.finishSpeedKmh : null };
  }

  const PTRaceHud = {
    ctx: null,
    raf: 0,
    ghostsHidden: false,
    history: [],                // the last splits shown

    init() {
      const st = el('style'); st.id = 'pt-racehud-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => this.onKey(e), true);
    },

    settings() {
      const c = this.ctx;
      try {
        if (!c) return null;
        return c.kind === 'race' ? c.race.__ptRun().settings : c.viewer.__ptReplay().settings;
      } catch { return null; }
    },
    setting(name, fallback) {
      const E = window.__ptSettingEnum, s = this.settings();
      try { return E && s ? s.getSetting(E[name]) : fallback; } catch { return fallback; }
    },
    splitsOn() { return this.setting('TweaksSplits', 'true') !== 'false'; },

    /** Speed the way the speedometer shows it: its units and its number of decimals. */
    speedText(kmh, signed) {
      if (kmh == null || !isFinite(kmh)) return null;
      const imperial = this.setting('ImperialUnitsEnabled', 'false') === 'true';
      const d = Math.max(0, Math.min(6, parseInt(this.setting('TweaksSpeedometerDecimals', '0'), 10) || 0));
      const v = imperial ? kmh / 1.609344 : kmh, k = Math.pow(10, d);
      const t = (Math.trunc(Math.abs(v) * k + 1e-7) / k).toFixed(d);
      return { value: (signed ? (v > 0 ? '+' : v < 0 ? '−' : '±') : '') + t, unit: imperial ? 'mph' : 'km/h' };
    },

    // ---------------------------------------------------------------- lifecycle
    attachRace(race) {
      this.detach();
      this.ctx = { kind: 'race', race, owner: race, car: null, ref: null, startedAt: performance.now(), shownSecond: -1 };
      if (this.ghostsHidden) {
        this.applyGhosts();
        setTimeout(() => this.toast('Ghosts hidden — ' + this.keyLabel() + ' to show them'), 600);
      }
      this.start();
    },

    attachReplay(viewer) {
      this.detach();
      this.ctx = { kind: 'replay', viewer, owner: viewer, entry: null, done: 0, finished: false, frame: -1 };
      this.start();
    },

    detach(owner) {
      const c = this.ctx;
      if (!c || (owner && c.owner !== owner)) return;
      cancelAnimationFrame(this.raf);
      clearTimeout(this.hideTimer); clearTimeout(this.fadeTimer);
      if (this.popup) { this.popup.remove(); this.popup = null; }
      if (this.session) { this.session.remove(); this.session = null; }
      this.ctx = null;
    },

    start() {
      const loop = () => { this.raf = requestAnimationFrame(loop); try { this.tick(); } catch (e) { if (!this.warned) { this.warned = true; console.warn('[racehud]', e); } } };
      this.raf = requestAnimationFrame(loop);
    },

    tick() {
      const c = this.ctx;
      if (!c) return;
      if (c.kind === 'race') {
        const run = c.race.__ptRun();
        if (run.car !== c.car) this.bindCar(run.car);
        this.sessionTick();
      } else this.watchReplay();
    },

    // ---------------------------------------------------------------- the session timer
    sessionTick() {
      const c = this.ctx;
      const on = this.setting('TweaksSessionTimer', 'true') !== 'false';
      if (!on) { if (this.session) this.session.classList.add('hidden'); return; }
      const hud = this.hud();
      if (!hud) return;
      if (!this.session || this.session.parentElement !== hud) {
        if (this.session) this.session.remove();
        const s = el('div', 'pt-session');
        s.appendChild(el('span', 'lbl', 'SESSION'));
        this.sessionTime = el('span', 't', '0:00');
        s.appendChild(this.sessionTime);
        hud.appendChild(s);
        this.session = s;
        c.shownSecond = -1;
      }
      this.session.classList.remove('hidden');
      const ms = performance.now() - c.startedAt, sec = Math.floor(ms / 1000);
      if (sec !== c.shownSecond) {
        c.shownSecond = sec;
        this.sessionTime.textContent = fmtClock(ms);
        // under the speedometer when that sits in the top right corner
        this.session.classList.toggle('low', this.setting('Speedometer', 'bottom') === 'top');
      }
    },

    sessionMs() { const c = this.ctx; return c && c.kind === 'race' ? performance.now() - c.startedAt : null; },

    // ---------------------------------------------------------------- races
    bindCar(car) {
      const c = this.ctx;
      c.car = car;
      this.hideSplit();                                     // a new attempt starts clean
      c.ref = snapshot(bestGhost(c.race.__ptRun().ghosts));
      if (!car) return;
      car.addCheckpointCallback((index) => {
        if (this.ctx !== c || c.car !== car) return;
        const run = c.race.__ptRun();
        const best = bestGhost(run.ghosts);
        if (best) c.ref = snapshot(best);                   // ghosts finish simulating early: complete by now
        const total = this.checkpointCount(run.track);
        const ref = c.ref;
        this.showSplit({ label: (index + 1) + (total ? '/' + total : ''), time: car.getTime().numberOfFrames, speed: car.getSpeedKmh(),
          refTime: ref && ref.cps[index] != null ? ref.cps[index] : null, refSpeed: ref && ref.speeds[index] != null ? ref.speeds[index] : null, refName: ref && ref.name });
      });
      car.addFinishCallback(() => {
        if (this.ctx !== c || c.car !== car) return;
        const t = car.getFinishTime();
        const ref = c.ref;                                   // taken before the game swapped in a new personal best
        this.showSplit({ label: 'Finish', time: t ? t.numberOfFrames : car.getTime().numberOfFrames, speed: car.getSpeedKmh(),
          refTime: ref ? ref.finish : null, refSpeed: ref ? ref.finishSpeed : null, refName: ref && ref.name });
      });
    },

    checkpointCount(track) {
      try { return track.getTotalNumberOfCheckpointIndices(); } catch { return null; }
    },

    // ---------------------------------------------------------------- the replay viewer
    watchReplay() {
      const c = this.ctx;
      const info = c.viewer.__ptReplay();
      if (!info || !info.cars || !info.cars.length) return;
      const e = info.cars[info.focus];
      const s = e.car.getCarState();
      if (!s) return;
      const frame = s.frames;
      const times = e.checkpointTimes.map((t) => t.numberOfFrames);
      const done = times.filter((t) => t <= frame).length;
      const finished = s.finishFrames != null && s.finishFrames <= frame;
      // a split only for checkpoints crossed while playing; a jump or a new focus just catches up
      const playing = c.entry === e && frame > c.frame && frame - c.frame < 250;
      if (playing && this.splitsOn() && (done === c.done + 1 || (finished && !c.finished))) {
        const others = info.cars.filter((x) => x !== e);
        let best = null;
        for (const x of others) {
          if (!best || x.settings.time.numberOfFrames < best.settings.time.numberOfFrames
            || (x.settings.time.numberOfFrames === best.settings.time.numberOfFrames && x.settings.isSelf)) best = x;
        }
        const speedAt = (car, f) => { const st = f != null ? car.replay.getFrame(f) : null; return st ? st.speedKmh : null; };
        const refName = best ? (best.settings.nickname || 'Car') : null;
        if (done === c.done + 1) {
          const total = this.checkpointCount(info.track);
          const refFrame = best && best.checkpointTimes[done - 1] ? best.checkpointTimes[done - 1].numberOfFrames : null;
          this.showSplit({ label: done + (total ? '/' + total : ''), time: times[done - 1], speed: speedAt(e, times[done - 1]),
            refTime: refFrame, refSpeed: best && refFrame != null ? speedAt(best, refFrame) : null, refName });
        } else {
          this.showSplit({ label: 'Finish', time: s.finishFrames, speed: e.finishSpeed != null ? e.finishSpeed : speedAt(e, s.finishFrames),
            refTime: best ? best.settings.time.numberOfFrames : null, refSpeed: best ? best.finishSpeed : null, refName });
        }
      }
      c.entry = e; c.frame = frame; c.done = done; c.finished = finished;
    },

    // ---------------------------------------------------------------- the pop-up
    hideSplit() {
      clearTimeout(this.hideTimer); clearTimeout(this.fadeTimer);
      if (this.popup) this.popup.classList.remove('show', 'fade');
    },

    hud() {
      const c = this.ctx;
      try { return c.kind === 'race' ? c.race.__ptCollab().hud : c.viewer.__ptReplay().hud.element; } catch { return null; }
    },

    showSplit({ label, time, speed, refTime, refSpeed, refName }) {
      if (!this.splitsOn()) return;
      const hud = this.hud();
      if (!hud) return;
      if (!this.popup || this.popup.parentElement !== hud) {
        if (this.popup) this.popup.remove();
        const p = el('div', 'pt-split');
        const main = el('div', 'main');
        this.pCp = el('span', 'cp'); this.pTime = el('span', 'time'); this.pSpeed = el('span', 'speed');
        main.append(this.pCp, this.pTime, this.pSpeed);
        const deltas = el('div', 'deltas');
        this.pDelta = el('div', 'delta'); this.pSpeedDelta = el('div', 'delta sp');
        deltas.append(this.pDelta, this.pSpeedDelta);
        this.pRef = el('div', 'ref');
        p.append(main, deltas, this.pRef);
        hud.appendChild(p);
        this.popup = p;
      }
      const p = this.popup;
      // below the game's timer when that sits at the top
      p.classList.toggle('low', this.setting('Timer', 'bottom') === 'top');
      this.pCp.textContent = label;
      this.pTime.textContent = fmtTime(time);
      const sp = this.speedText(speed, false);
      this.pSpeed.textContent = '';
      if (sp) { this.pSpeed.append(sp.value); this.pSpeed.appendChild(el('small', null, sp.unit)); }
      this.pSpeed.style.display = sp ? '' : 'none';
      let speedDelta = null;
      if (refTime != null) {
        const d = time - refTime;
        this.pDelta.textContent = fmtDelta(d);
        this.pDelta.className = 'delta ' + (d < 0 ? 'ahead' : d > 0 ? 'behind' : 'level');
        this.pDelta.style.display = '';
        this.pRef.textContent = 'vs ' + refName;
        this.pRef.style.display = '';
      } else {
        this.pDelta.style.display = 'none';
        this.pRef.style.display = 'none';
      }
      if (speed != null && refSpeed != null) {
        speedDelta = Math.abs(speed) - Math.abs(refSpeed);
        const t = this.speedText(speedDelta, true);
        this.pSpeedDelta.textContent = t.value + ' ' + t.unit;
        this.pSpeedDelta.className = 'delta sp ' + (speedDelta > 0 ? 'ahead' : speedDelta < 0 ? 'behind' : 'level');
        this.pSpeedDelta.style.display = '';
      } else this.pSpeedDelta.style.display = 'none';
      this.last = { label, time, refTime, refName, delta: refTime != null ? time - refTime : null, speed, refSpeed, speedDelta };
      this.history.push(this.last);
      if (this.history.length > 20) this.history.shift();
      clearTimeout(this.hideTimer); clearTimeout(this.fadeTimer);
      p.classList.remove('fade', 'show');
      void p.offsetWidth;                                   // restart the pop-in when splits come quickly
      p.classList.add('show');
      this.hideTimer = setTimeout(() => {
        p.classList.add('fade');
        this.fadeTimer = setTimeout(() => p.classList.remove('show', 'fade'), 450);
      }, SHOW_MS);
    },

    // ---------------------------------------------------------------- ghosts on and off
    onKey(e) {
      const c = this.ctx;
      if (!c || c.kind !== 'race') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!window.PTKeys || !window.PTKeys.is(e, 'TweaksToggleGhosts') || e.repeat) return;
      e.preventDefault();
      this.ghostsHidden = !this.ghostsHidden;
      this.applyGhosts();
      this.toast(this.ghostsHidden ? 'Ghosts hidden' : 'Ghosts shown');
    },

    applyGhosts() {
      const c = this.ctx;
      if (!c || c.kind !== 'race') return;
      const h = this.ghostsHidden;
      c.race.__ptGhostsHidden = h;
      let run = null;
      try { run = c.race.__ptRun(); } catch { }
      for (const g of (run && run.ghosts) || []) {
        if (!g.car) continue;
        if (typeof g.car.__ptHide === 'function') g.car.__ptHide(h);
        if (h) g.car.audioVolume = 0;
      }
    },

    keyLabel() { return window.PTKeys ? window.PTKeys.label('TweaksToggleGhosts') : 'G'; },
    toast(text) { if (window.PTRuns && window.PTRuns.toast) window.PTRuns.toast(text); },
  };

  window.PTRaceHud = PTRaceHud;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTRaceHud.init());
  else PTRaceHud.init();
})();
