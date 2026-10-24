/*
 * PolyTrack Tweaks — practice tools for the editor's test drive.
 *
 * While you are testing a track you are building, you can slow time down (or speed it up) and keep
 * savestates, so you can try the same corner over and over without driving up to it every time.
 *
 * The speed is set in the editor's top bar, next to Test: type any speed (0.05× to 8×), and
 * optionally a time on the track it lasts until — "0.5× until 12.000" drives the first 12 seconds of
 * every attempt at half speed and the rest at normal speed; "4× until 1:05.000" fast-forwards to the
 * part you want to practise. The keys (Settings → Controls → Tweaks) still change it while you drive.
 *
 * Both only work in the editor's test drive, never in a real race. That is deliberate: a run driven
 * in slow motion produces a perfectly valid recording, so allowing it anywhere a time can be saved
 * or uploaded would be a cheat, not a tweak.
 *
 * The realtime simulation runs in the physics worker on its own clock, so the tools live there:
 *   - the time scale sets how fast simulated time passes against the wall clock, switching at the
 *     exact millisecond the car's time reaches the end time;
 *   - a savestate is a snapshot of the worker's wasm heap (the physics state is all in there),
 *     stored as the pages that differ from a baseline taken on the first save.
 * This file is the main-thread half: the editor control, keys, the readout, and the messages.
 */
(function () {
  'use strict';

  const PREFS_KEY = 'pt-practice-prefs-v1';
  const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  const MIN_SPEED = 0.05, MAX_SPEED = 8;
  const SLOTS = 3;
  const log = (...a) => console.log('[practice]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const loadJSON = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
  const Keys = () => window.PTKeys;

  /** "0.5", ".5", "50%", "2x", "×2" -> 0.5 / 2; null when it isn't a speed. */
  function parseSpeed(text) {
    let t = String(text || '').trim().toLowerCase().replace(/[x×\s]/g, '').replace(',', '.');
    if (!t) return null;
    let pct = false;
    if (t.endsWith('%')) { pct = true; t = t.slice(0, -1); }
    if (!/^\d*\.?\d+$/.test(t)) return null;
    let v = parseFloat(t);
    if (pct) v /= 100;
    if (!(v > 0)) return null;
    return Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, v)) * 1000) / 1000;
  }

  /** "12.5", "0:12.500", "1:02.3" -> milliseconds into the track; '' -> 0 (no end); null when unreadable. */
  function parseUntil(text) {
    const t = String(text || '').trim().replace(',', '.');
    if (!t || t === '-' || t === '—') return 0;
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return null;
    const ms = Math.round(((m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2])) * 1000);
    return ms > 0 ? ms : 0;
  }

  const fmtSpeed = (v) => String(Math.round(v * 1000) / 1000);

  const CSS = `
/* a HUD box on the left edge, like the checkpoint counter */
.pt-prac-panel { position:absolute; left:var(--safe-area-horizontal); top:50%; transform:translateY(-50%); z-index:1; min-width:220px;
  padding:8px 22px 10px 12px; background-color:var(--surface-color); opacity:0.9; color:var(--text-color); font-size:16px; line-height:1.45;
  pointer-events:none; clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 100%, 0 100%); }
.pt-prac-panel.hidden { display:none; }
.pt-prac-panel h3 { margin:0 0 4px; font-size:18px; font-weight:normal; opacity:0.5; }
.pt-prac-panel .speed { display:inline-block; padding:2px 16px 2px 10px; font-size:28px; line-height:1.2; background-color:var(--surface-tertiary-color);
  clip-path:polygon(0 0, calc(100% - 6px) 0, 100% 100%, 0 100%); }
.pt-prac-panel .speed.slow { color:hsl(210, 100%, 65%); }
.pt-prac-panel .speed.fast { color:#ff5; }
.pt-prac-panel .speed small { font-size:16px; color:var(--text-color); opacity:0.5; margin-left:6px; }
.pt-prac-panel .slots { display:flex; gap:4px; margin:6px 0 2px; }
.pt-prac-panel .slot { padding:1px 10px; background-color:var(--surface-tertiary-color); opacity:0.5; }
.pt-prac-panel .slot.filled { opacity:1; }
.pt-prac-panel .slot.active { background-color:var(--button-hover-color); opacity:1; }
.pt-prac-panel .keys { font-size:14px; opacity:0.75; }
.pt-prac-panel .keys .pt-key { font-size:13px; }
.pt-prac-panel .warn { font-size:14px; color:#ff5; }

/* on the editor's second row, after the track name, shaped like it */
.pt-speed { display:inline-flex; align-items:center; gap:4px; vertical-align:top; box-sizing:border-box;
  margin:-1px 0 0 0; padding:0 22px 0 12px; height:var(--pt-speed-h, 60px);
  background-color:var(--surface-secondary-color); clip-path:polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  color:var(--text-color); font-size:22px; pointer-events:auto; }
.pt-speed.active { background-color:var(--button-hover-color); }
.pt-speed > img { width:22px; height:22px; margin-right:2px; opacity:0.85; }
.pt-speed .lbl { opacity:0.75; font-size:17px; }
.pt-speed input { width:2.6em; padding:6px 4px; border:none; outline:none; text-align:center;
  background-color:var(--button-color); color:var(--text-color); font:inherit; }
.pt-speed input.until { width:4.2em; }
.pt-speed:not(.active) button { display:none; }
.pt-speed input.bad { box-shadow:inset 0 0 0 2px #f55; }
.pt-speed input::placeholder { color:var(--text-color); opacity:0.45; }
.pt-speed button { padding:2px 8px; border:none; background:transparent; color:var(--text-color); font:inherit; opacity:0.7; cursor:pointer; }
.pt-speed button:hover { opacity:1; }
`;

  const PTPractice = {
    race: null,
    panel: null,
    bar: null,               // the editor's speed control
    scale: 1,                // the speed set for this test drive
    effective: 1,            // the speed in force right now (1 once the end time has passed)
    slot: 0,
    filled: [],              // which slots hold a state, and how big it is
    loaded: false,           // a savestate was restored during this attempt
    dirtyAttempt: false,
    prefs: null,

    init() {
      this.prefs = Object.assign({ panel: true, speed: 1, until: 0 }, loadJSON(PREFS_KEY, {}));
      if (!(this.prefs.speed >= MIN_SPEED && this.prefs.speed <= MAX_SPEED)) this.prefs.speed = 1;
      if (!(this.prefs.until >= 0)) this.prefs.until = 0;
      const st = document.createElement('style');
      st.id = 'pt-practice-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => this.onKey(e), true);
    },

    savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {} },

    // ---------------------------------------------------------------- lifecycle
    /** The editor started a test drive: this is the one race where the tools are allowed. */
    arm(race) {
      this.race = race;
      this.slot = 0;
      this.filled = [];
      this.loaded = false;
      this.dirtyAttempt = false;
      this.scale = this.prefs.speed;
      this.effective = this.scale;
      this.sendScale();
      this.show();
      this.draw();
    },

    disarm() {
      if (!this.race) return;
      this.race = null;
      this.scale = 1;
      this.effective = 1;
      this.filled = [];
      this.loaded = false;
      this.dirtyAttempt = false;
      this.send({ __pt: 'scale', value: 1 });
      this.send({ __pt: 'release' });        // give the snapshot memory back
      if (this.panel) this.panel.classList.add('hidden');
      this.syncBar();
    },

    /** Called by the statistics module when a new attempt begins (a reset, or a fresh car). */
    noteAttempt() { this.loaded = false; this.dirtyAttempt = false; },

    /** Has this attempt been touched by the practice tools? Then it is not a real run. */
    dirty() { return !!this.race && (this.loaded || this.dirtyAttempt || this.scale !== 1); },

    isArmed() { return !!this.race; },

    // ---------------------------------------------------------------- the worker
    sim() { return window.__ptSim || null; },

    send(msg) {
      const sim = this.sim();
      if (!sim || typeof sim.__ptSend !== 'function') return false;
      try { sim.__ptSend(msg); return true; } catch (e) { log('could not reach the simulation', e); return false; }
    },

    sendScale() {
      const until = this.scale !== 1 && this.prefs.until > 0 ? this.prefs.until : 0;
      this.send({ __pt: 'scale', value: this.scale, until });
    },

    onWorker(msg) {
      switch (msg.__pt) {
        case 'saved':
          this.filled[msg.slot] = { bytes: msg.bytes, frames: msg.frames, base: msg.baseBytes };
          this.toast('Savestate ' + (msg.slot + 1) + ' at ' + this.time(msg.frames));
          this.draw();
          break;
        case 'loaded':
          this.toast('Loaded savestate ' + (msg.slot + 1));
          this.draw();
          break;
        case 'empty':
          this.toast('Savestate ' + (msg.slot + 1) + ' is empty — press ' + this.keyLabel('TweaksPracticeSave') + ' first.');
          break;
        case 'eff':
          if (!this.race) break;
          this.effective = msg.value;
          this.draw();
          break;
        case 'info':
          if (window.PTDiag && window.PTDiag.onWorkerInfo) window.PTDiag.onWorkerInfo(msg);
          break;
        case 'forgot':
          this.filled[msg.slot] = null;
          this.toast(msg.freed ? 'Savestates cleared, memory released.' : 'Savestate ' + (msg.slot + 1) + ' cleared.');
          this.draw();
          break;
        default: break;
      }
    },

    // ---------------------------------------------------------------- actions
    /** The speed for test drives; while one is running, it changes right away. */
    setSpeed(value) {
      const v = Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, value)) * 1000) / 1000;
      this.prefs.speed = v;
      this.savePrefs();
      if (this.race) {
        this.scale = v;
        this.effective = v;
        if (v !== 1) this.dirtyAttempt = true;
        this.sendScale();
        this.draw();
      }
      this.syncBar();
    },

    setUntil(ms) {
      this.prefs.until = ms > 0 ? ms : 0;
      this.savePrefs();
      if (this.race) { this.sendScale(); this.draw(); }
      this.syncBar();
    },

    /** One step along the usual speeds, from wherever a typed speed sits between them. */
    step(direction) {
      const cur = this.race ? this.scale : this.prefs.speed;
      let next;
      if (direction > 0) next = SPEEDS.find((s) => s > cur + 1e-9);
      else next = [...SPEEDS].reverse().find((s) => s < cur - 1e-9);
      if (next == null) next = direction > 0 ? SPEEDS[SPEEDS.length - 1] : SPEEDS[0];
      this.setSpeed(next);
    },

    car() {
      try { return this.race ? this.race.__ptRun().car : null; } catch { return null; }
    },

    save() {
      if (!this.race) return;
      const car = this.car();
      let started = false;
      try { started = !!car && car.getCarState().hasStarted; } catch {}
      if (!started) return this.toast('Start driving before taking a savestate.');
      if (!this.send({ __pt: 'save', slot: this.slot })) this.toast('The simulation is not available.');
    },

    load() {
      if (!this.race) return;
      if (!this.filled[this.slot]) return this.toast('Savestate ' + (this.slot + 1) + ' is empty.');
      const car = this.car();
      if (car) {
        car.__ptTeleport = true;                       // arrive without interpolating from the old spot
        // the run's input recording can no longer describe what happened, so stop recording it
        try { if (typeof car.__ptStopRecording === 'function') car.__ptStopRecording(); } catch {}
      }
      this.loaded = true;
      if (!this.send({ __pt: 'load', slot: this.slot })) this.toast('The simulation is not available.');
    },

    forget() {
      if (!this.race || !this.filled[this.slot]) return;
      this.send({ __pt: 'forget', slot: this.slot });
    },

    cycle() {
      if (!this.race) return;
      this.slot = (this.slot + 1) % SLOTS;
      this.draw();
    },

    // ---------------------------------------------------------------- input
    onKey(e) {
      if (!this.race) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const K = Keys();
      if (!K) return;
      let handled = true;
      if (K.is(e, 'TweaksPracticeSlower')) this.step(-1);
      else if (K.is(e, 'TweaksPracticeFaster')) this.step(1);
      else if (K.is(e, 'TweaksPracticeNormal')) this.setSpeed(1);
      else if (K.is(e, 'TweaksPracticeSave')) this.save();
      else if (K.is(e, 'TweaksPracticeLoad')) this.load();
      else if (K.is(e, 'TweaksPracticeForget')) this.forget();
      else if (K.is(e, 'TweaksPracticeSlot')) this.cycle();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    },

    keyLabel(name) { const K = Keys(); return K ? K.label(name) : '?'; },

    // ---------------------------------------------------------------- the editor's speed control
    /**
     * 112.bundle.js calls this while it builds the editor's top bar (right after the Test button).
     * The control goes on the row below, after the track name: the bar itself has no room to spare.
     */
    editorBar(bar, testButton) {
      try { this.buildBar(bar, testButton); } catch (e) { console.error('[practice] editor speed control', e); }
    },

    buildBar(bar, testButton) {
      const box = el('div', 'pt-speed');
      box.title = 'Practice speed for test drives: type a speed (0.05 to 8), and optionally the time on the track it lasts until.';
      const icon = el('img');
      icon.src = 'images/timer.svg';
      icon.alt = 'Speed';
      box.appendChild(icon);
      const speed = el('input', 'speed');
      speed.type = 'text'; speed.inputMode = 'decimal'; speed.spellcheck = false;
      box.appendChild(speed);
      box.appendChild(el('span', 'lbl', '× until'));
      const until = el('input', 'until');
      until.type = 'text'; until.inputMode = 'decimal'; until.spellcheck = false; until.placeholder = 'end';
      box.appendChild(until);
      const reset = el('button', null, '1×');
      reset.title = 'Back to normal speed';
      box.appendChild(reset);

      const commitSpeed = () => {
        const v = parseSpeed(speed.value);
        if (v == null) { speed.classList.add('bad'); return; }
        speed.classList.remove('bad');
        this.setSpeed(v);
      };
      const commitUntil = () => {
        const v = parseUntil(until.value);
        if (v == null) { until.classList.add('bad'); return; }
        until.classList.remove('bad');
        this.setUntil(v);
      };
      for (const [input, commit] of [[speed, commitSpeed], [until, commitUntil]]) {
        // typing here must not drive the editor (WASD, R, Delete...)
        for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => {
          e.stopPropagation();
          if (type === 'keydown' && (e.key === 'Enter' || e.key === 'Escape')) {
            if (e.key === 'Escape') this.syncBar();
            else commit();
            input.blur();
            e.preventDefault();
          }
        });
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        input.addEventListener('focus', () => input.select());
      }
      reset.addEventListener('click', () => { this.setSpeed(1); this.setUntil(0); });

      // the track name's row is built after the bar, in the same task: place the control once it exists
      const top = bar.parentElement;
      queueMicrotask(() => {
        try {
          const name = top && top.querySelector(':scope > .track-settings-container');
          if (name) name.after(box);
          else if (top) top.appendChild(box);
          else bar.appendChild(box);
          this.syncBar();
        } catch (e) { console.error('[practice] editor speed control', e); }
      });
      this.bar = { box, speed, until };
      this.syncBar();
    },

    syncBar() {
      const b = this.bar;
      if (!b || !b.box.isConnected) return;
      if (document.activeElement !== b.speed) { b.speed.value = fmtSpeed(this.prefs.speed); b.speed.classList.remove('bad'); }
      if (document.activeElement !== b.until) { b.until.value = this.prefs.until > 0 ? this.time(this.prefs.until) : ''; b.until.classList.remove('bad'); }
      b.box.classList.toggle('active', this.prefs.speed !== 1);
    },

    // ---------------------------------------------------------------- readout
    time(frames) { return window.PTRunsCore ? window.PTRunsCore.formatTime(frames) : String(frames); },

    toast(text) {
      if (window.PTRuns && window.PTRuns.toast) window.PTRuns.toast(text);
      else log(text);
    },

    show() {
      if (!this.panel) {
        this.panel = el('div', 'pt-prac-panel hidden');
        (document.getElementById('ui') || document.body).appendChild(this.panel);
      }
      this.panel.classList.toggle('hidden', !this.prefs.panel);
    },

    draw() {
      if (!this.panel || !this.race) return;
      const p = this.panel;
      p.textContent = '';
      p.appendChild(el('h3', null, 'Practice'));
      const now = this.effective;
      const speed = el('div', 'speed', fmtSpeed(now) + '×');
      speed.classList.toggle('slow', now < 1);
      speed.classList.toggle('fast', now > 1);
      if (this.scale !== 1 && this.prefs.until > 0) {
        speed.appendChild(el('small', null, now === this.scale
          ? 'until ' + this.time(this.prefs.until)
          : fmtSpeed(this.scale) + '× until ' + this.time(this.prefs.until)));
      }
      p.appendChild(speed);
      const slots = el('div', 'slots');
      for (let i = 0; i < SLOTS; i++) {
        const s = el('span', 'slot', String(i + 1));
        if (this.filled[i]) s.classList.add('filled');
        if (i === this.slot) s.classList.add('active');
        slots.appendChild(s);
      }
      p.appendChild(slots);
      const here = this.filled[this.slot];
      p.appendChild(el('div', 'keys', here ? 'slot ' + (this.slot + 1) + ': ' + this.time(here.frames) : 'slot ' + (this.slot + 1) + ': empty'));
      const held = this.filled.filter(Boolean);
      if (held.length) {
        const mb = (held[0].base + held.reduce((a, b) => a + b.bytes, 0)) / 1048576;
        const line = el('div', 'keys', 'savestate memory: ' + mb.toFixed(0) + ' MB (freed when you leave, or with ');
        this.appendCaps(line, 'TweaksPracticeForget');
        line.appendChild(document.createTextNode(')'));
        p.appendChild(line);
      }
      const keys = el('div', 'keys');
      const parts = [['TweaksPracticeSlower', 'slower'], ['TweaksPracticeFaster', 'faster'], ['TweaksPracticeNormal', 'normal'],
        ['TweaksPracticeSave', 'save'], ['TweaksPracticeLoad', 'load'], ['TweaksPracticeSlot', 'slot']];
      parts.forEach(([name, what], i) => {
        if (i) keys.appendChild(document.createTextNode('  ·  '));
        this.appendCaps(keys, name);
        keys.appendChild(document.createTextNode(' ' + what));
      });
      p.appendChild(keys);
      if (this.dirty()) p.appendChild(el('div', 'warn', 'practice run — not recorded'));
    },

    appendCaps(parent, name) {
      const K = Keys();
      if (K) parent.appendChild(K.caps(name));
      else parent.appendChild(document.createTextNode('?'));
    },
  };

  PTPractice.parseSpeed = parseSpeed;
  PTPractice.parseUntil = parseUntil;
  window.PTPractice = PTPractice;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTPractice.init());
  else PTPractice.init();
})();
