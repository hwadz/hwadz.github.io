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
 *
 * Live difference: the game's Difference box, while you drive, shows your elapsed time minus the
 * record's whole time — a number that only means something at the finish. With this on it shows how
 * far ahead (green, −) or behind (red, +) of that same record you are at the point of the track you
 * are on, updated every frame: where the record's ghost was nearest to your car (in the same section
 * between checkpoints), and when it was there. At the finish it is the game's own exact difference.
 * It needs the record's ghost (Settings → Ghost car on), which it reads positions from; without one
 * the box shows the game's number. Settings → Tweaks → Live difference turns it off.
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
/* a split hangs from the top edge like the game's own timer, and drops in */
.pt-split { position:absolute; left:50%; top:0; z-index:31; display:flex; flex-direction:column; align-items:center;
  line-height:1; color:var(--text-color); pointer-events:none; opacity:0; transform:translate(-50%, -100%);
  transition:transform 0.15s ease-out, opacity 0.15s ease-out; }
.pt-split.low { top:108px; transform:translate(-50%, -8px); }
.pt-split.show { opacity:1; transform:translate(-50%, 0); }
.pt-split.show.fade { opacity:0; transition:opacity 0.45s ease-in; }
.pt-split > .main { display:flex; align-items:center; gap:6px; padding:8px 10px; background-color:var(--surface-color); opacity:0.9;
  clip-path:polygon(0 0, 100% 0, calc(100% - 8px) 100%, 8px 100%); }
.pt-split.low > .main { clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-split .cp { padding:0 8px 0 14px; font-size:26px; opacity:0.75; }
.pt-split .time, .pt-split .speed { padding:4px 16px; background-color:var(--surface-tertiary-color);
  clip-path:polygon(0 0, 100% 0, calc(100% - 6px) 100%, 6px 100%); }
.pt-split .time { font-size:40px; }
.pt-split .speed { font-size:28px; }
.pt-split .speed small { margin-left:0.25em; font-size:0.5em; opacity:0.5; }
.pt-split .deltas { display:flex; align-items:baseline; gap:24px; margin-top:6px; }
.pt-split .delta, .pt-split .ref { text-shadow:1px 1px 1px var(--surface-color), -1px 1px 1px var(--surface-color), -1px -1px 1px var(--surface-color), 1px -1px 1px var(--surface-color); }
.pt-split .delta { font-size:32px; }
.pt-split .delta.sp { font-size:24px; }
.pt-split .delta.ahead { color:#5f5; }
.pt-split .delta.behind { color:#f55; }
.pt-split .ref { margin-top:4px; font-size:18px; opacity:0.8; }

/* the session timer: a box in the top right corner, like the speedometer when it sits up there */
.pt-session { position:absolute; right:var(--safe-area-horizontal); top:0; z-index:30; padding:8px 10px; line-height:1;
  color:var(--text-color); background-color:var(--surface-color); opacity:0.9; pointer-events:none;
  clip-path:polygon(0 0, 100% 0, 100% 100%, 8px 100%); }
.pt-session > div { display:flex; align-items:baseline; gap:8px; padding:5px 12px 5px 18px; background-color:var(--surface-tertiary-color);
  clip-path:polygon(0 0, 100% 0, 100% 100%, 6px 100%); }
.pt-session .lbl { font-size:16px; opacity:0.5; }
.pt-session .t { font-size:28px; }
.pt-session.hidden { display:none; }
/* the game's "loading ghosts" line lives in that corner too: under the timer while it is up */
body.pt-session-on .ghost-loading-ui:not(.down) { top:52px; }
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

  /**
   * Where a ghost was at every millisecond of its run. Its replay keeps each frame compressed, so the
   * positions are read out once, a slice per frame, into plain arrays the live difference can search.
   */
  class GhostPath {
    constructor(ghost) {
      this.ghost = ghost;
      this.replay = ghost.replay;
      this.n = ghost.settings.time.numberOfFrames + 1;
      this.x = new Float32Array(this.n); this.y = new Float32Array(this.n); this.z = new Float32Array(this.n);
      this.done = 0;
    }
    /** Reads the frames the ghost has simulated since last time, for at most `ms` of this frame. */
    advance(ms) {
      const rep = this.replay && this.replay.replay;
      if (!rep || this.done >= this.n) return;
      const last = Math.min(this.n - 1, rep.getLastFrame().numberOfFrames);
      const until = performance.now() + ms;
      while (this.done <= last) {
        const s = rep.getFrame(this.done);
        if (!s) break;
        const i = this.done++;
        this.x[i] = s.position.x; this.y[i] = s.position.y; this.z[i] = s.position.z;
        if ((this.done & 63) === 0 && performance.now() > until) break;
      }
    }
    /** The ghost's frames that belong to section `seg` (between checkpoint seg and seg + 1). */
    section(seg) {
      const cps = this.ghost.checkpoints || [];
      if (seg > cps.length) return null;
      const lo = seg === 0 ? 0 : cps[seg - 1].time.numberOfFrames;
      const hi = seg < cps.length ? cps[seg].time.numberOfFrames : this.n - 1;
      return [lo, Math.min(hi, this.done - 1)];
    }
  }

  const NEAR = 15 * 15;            // m²: further than this from the last match, look through the whole section again

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
      // the replay tools and the run comparison live in the same viewer
      for (const m of [window.PTReplayTools, window.PTCompare]) {
        try { if (m && m.attach) m.attach(viewer); } catch (e) { console.error('[racehud] replay attach', e); }
      }
    },

    detach(owner) {
      const c = this.ctx;
      if (!c || (owner && c.owner !== owner)) return;
      if (c.kind === 'replay') {
        for (const m of [window.PTReplayTools, window.PTCompare]) {
          try { if (m && m.detach) m.detach(c.viewer); } catch (e) { console.error('[racehud] replay detach', e); }
        }
      }
      cancelAnimationFrame(this.raf);
      clearTimeout(this.hideTimer); clearTimeout(this.fadeTimer);
      if (this.popup) { this.popup.remove(); this.popup = null; }
      if (this.session) { this.session.remove(); this.session = null; }
      document.body.classList.remove('pt-session-on');
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
      if (!on) { if (this.session) this.session.classList.add('hidden'); document.body.classList.remove('pt-session-on'); return; }
      const hud = this.hud();
      if (!hud) return;
      if (!this.session || this.session.parentElement !== hud) {
        if (this.session) this.session.remove();
        const s = el('div', 'pt-session');
        const box = el('div');
        box.appendChild(el('span', 'lbl', 'Session'));
        this.sessionTime = el('span', 't', '0:00');
        box.appendChild(this.sessionTime);
        s.appendChild(box);
        hud.appendChild(s);
        this.session = s;
        c.shownSecond = -1;
      }
      this.session.classList.remove('hidden');
      document.body.classList.add('pt-session-on');
      const ms = performance.now() - c.startedAt, sec = Math.floor(ms / 1000);
      if (sec !== c.shownSecond) {
        c.shownSecond = sec;
        this.sessionTime.textContent = fmtClock(ms);
        // under the speedometer when that sits in the top right corner
        const sp = document.querySelector('.speedometer-ui.up');
        this.session.style.top = sp && sp.offsetParent !== null ? sp.offsetHeight + 'px' : '0px';
      }
    },

    sessionMs() { const c = this.ctx; return c && c.kind === 'race' ? performance.now() - c.startedAt : null; },

    // ---------------------------------------------------------------- races
    bindCar(car) {
      const c = this.ctx;
      c.car = car;
      c.k = -1; c.seg = -1; c.live = null;                  // the live difference starts again from the start
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

    // ---------------------------------------------------------------- the live difference
    liveOn() { return this.setting('TweaksLiveDelta', 'true') !== 'false'; },

    /**
     * Asked by the game's timer every frame while you race: how many ms you are behind (+) or ahead
     * (−) of `record` at this point of the track, or null to let the box show the game's own number.
     */
    liveDifference(car, record) {
      const c = this.ctx;
      if (!c || c.kind !== 'race' || !record || !this.liveOn()) return null;
      let run;
      try { run = c.race.__ptRun(); } catch { return null; }
      if (!car || car !== run.car || car.hasFinished()) return null;
      const g = bestGhost(run.ghosts);
      if (!g || !g.replay || !g.replay.replay || g.settings.time.numberOfFrames !== record.numberOfFrames) return null;
      const st = car.getCarState();
      if (!st || !st.position) return null;
      if (!st.hasStarted || st.frames === 0) { c.live = null; return 0; }
      if (!c.path || c.path.ghost !== g || c.path.replay !== g.replay) { c.path = new GhostPath(g); c.k = -1; }
      c.path.advance(1.5);
      const f = this.matchFrame(c, st);
      if (f == null) return c.live != null ? c.live : null;     // between matches, keep the last one up
      c.live = Math.round(st.frames - f);
      return c.live;
    },

    /** The ghost's (fractional) frame at the point of its run nearest the car, in the car's section. */
    matchFrame(c, st) {
      const P = c.path, seg = st.nextCheckpointIndex;
      const range = P.section(seg);
      if (!range || range[1] < range[0]) return null;
      const [lo, hi] = range;
      const px = st.position.x, py = st.position.y, pz = st.position.z;
      const X = P.x, Y = P.y, Z = P.z;
      let best = -1, bd = Infinity;
      const scan = (a, b) => {
        for (let k = a; k <= b; k++) {
          const dx = X[k] - px, dy = Y[k] - py, dz = Z[k] - pz, d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = k; }
        }
      };
      // near the last match first (the ghost moves on by about as much as the car does each frame);
      // a new section, a reset or a shortcut means looking through the whole section
      if (c.seg === seg && c.k >= lo && c.k <= hi) scan(Math.max(lo, c.k - 250), Math.min(hi, c.k + 750));
      if (best < 0 || bd > NEAR) { best = -1; bd = Infinity; scan(lo, hi); }
      if (best < 0) return null;
      c.k = best; c.seg = seg;
      // the car is between two of the ghost's frames: on the side of the neighbour it projects onto
      const along = (a, b) => {
        const vx = X[b] - X[a], vy = Y[b] - Y[a], vz = Z[b] - Z[a], l = vx * vx + vy * vy + vz * vz;
        if (!l) return 0;
        const t = ((px - X[a]) * vx + (py - Y[a]) * vy + (pz - Z[a]) * vz) / l;
        return t < 0 ? 0 : t > 1 ? 1 : t;
      };
      if (best < hi) { const t = along(best, best + 1); if (t > 0) return best + t; }
      if (best > lo) return best - 1 + along(best - 1, best);
      return best;
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
