/*
 * PolyTrack Tweaks — ghosts on and off mid-run, and Trackmania-style checkpoint splits.
 *
 * Ghosts: the "Toggle ghosts" key (G unless changed in Settings → Controls → Tweaks) hides the
 * ghosts you are racing against, or brings them back, at any moment of a run. Hidden ghosts leave
 * no skid marks or smoke and make no sound. The choice holds through restarts and later races until
 * you press the key again (it is not saved when the game closes). Their times still count: the
 * game's Difference, the splits below and the telemetry panel keep comparing against them.
 *
 * Splits: passing a checkpoint pops your time up at the top of the screen, with the difference to the
 * same ghost the game's own Difference box uses (the quickest one, your personal best on a tie) in a
 * blue box when you are ahead and a red one when you are behind — and the same at the finish. In the
 * replay viewer it does this for the focused car against the quickest other car. Settings →
 * Checkpoint splits turns it off.
 */
(function () {
  'use strict';

  const SHOW_MS = 3000;            // how long a split stays up
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtTime = (ms) => (ms == null ? '—' : window.PTRunsCore ? window.PTRunsCore.formatTime(ms) : (ms / 1000).toFixed(3));
  const fmtDelta = (ms) => (ms > 0 ? '+' : ms < 0 ? '−' : '') + (Math.abs(ms) / 1000).toFixed(3);

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
.pt-split .time { padding:3px 18px 1px 12px; font-size:36px; line-height:1.15; letter-spacing:1px; }
.pt-split .delta { padding:1px 16px; font-size:27px; line-height:1.2; clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-split .delta.ahead { background:#2266dd; }
.pt-split .delta.behind { background:#d33a3a; }
.pt-split .delta.level { background:#5b6178; }
.pt-split .ref { font-size:14px; opacity:0.85; text-shadow:0 0 4px #000, 0 0 2px #000; }
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

  /** A copy of a ghost's times, so a new personal best replacing it mid-callback can't change them. */
  function snapshot(g) {
    if (!g) return null;
    return { name: g.settings.isSelf ? 'PB' : (g.settings.nickname || 'Ghost'), finish: g.settings.time.numberOfFrames,
      cps: (g.checkpoints || []).map((c) => c.time.numberOfFrames) };
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
    splitsOn() {
      const E = window.__ptSettingEnum, s = this.settings();
      try { return !E || !s || s.getSetting(E.TweaksSplits) !== 'false'; } catch { return true; }
    },

    // ---------------------------------------------------------------- lifecycle
    attachRace(race) {
      this.detach();
      this.ctx = { kind: 'race', race, owner: race, car: null, ref: null };
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
      } else this.watchReplay();
    },

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
        const ref = c.ref, refTime = ref && ref.cps[index] != null ? ref.cps[index] : null;
        this.showSplit({ label: (index + 1) + (total ? '/' + total : ''), time: car.getTime().numberOfFrames, refTime, refName: ref && ref.name });
      });
      car.addFinishCallback(() => {
        if (this.ctx !== c || c.car !== car) return;
        const t = car.getFinishTime();
        const ref = c.ref;                                   // taken before the game swapped in a new personal best
        this.showSplit({ label: 'Finish', time: t ? t.numberOfFrames : car.getTime().numberOfFrames, refTime: ref ? ref.finish : null, refName: ref && ref.name });
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
      if (playing && this.splitsOn()) {
        const others = info.cars.filter((x) => x !== e);
        const best = bestGhost(others.map((x) => ({ settings: x.settings, checkpoints: x.checkpointTimes.map((t) => ({ time: t })) })));
        const ref = snapshot(best);
        if (done === c.done + 1) {
          const total = this.checkpointCount(info.track);
          this.showSplit({ label: done + (total ? '/' + total : ''), time: times[done - 1], refTime: ref && ref.cps[done - 1] != null ? ref.cps[done - 1] : null, refName: ref && ref.name });
        } else if (finished && !c.finished) {
          this.showSplit({ label: 'Finish', time: s.finishFrames, refTime: ref ? ref.finish : null, refName: ref && ref.name });
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

    showSplit({ label, time, refTime, refName }) {
      if (!this.splitsOn()) return;
      const hud = this.hud();
      if (!hud) return;
      if (!this.popup || this.popup.parentElement !== hud) {
        if (this.popup) this.popup.remove();
        const p = el('div', 'pt-split');
        const main = el('div', 'main');
        this.pCp = el('span', 'cp'); this.pTime = el('span', 'time');
        main.append(this.pCp, this.pTime);
        this.pDelta = el('div', 'delta'); this.pRef = el('div', 'ref');
        p.append(main, this.pDelta, this.pRef);
        hud.appendChild(p);
        this.popup = p;
      }
      const p = this.popup;
      // below the game's timer when that sits at the top
      let low = false;
      try { const E = window.__ptSettingEnum; low = this.settings().getSetting(E.Timer) === 'top'; } catch { }
      p.classList.toggle('low', low);
      this.pCp.textContent = label;
      this.pTime.textContent = fmtTime(time);
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
      this.last = { label, time, refTime, refName, delta: refTime != null ? time - refTime : null };
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
