/*
 * PolyTrack Tweaks — practice tools for the editor's test drive.
 *
 * While you are testing a track you are building, you can slow time down (or speed it up) and keep
 * savestates, so you can try the same corner over and over without driving up to it every time.
 *
 * Both only work in the editor's test drive, never in a real race. That is deliberate: a run driven
 * in slow motion produces a perfectly valid recording, so allowing it anywhere a time can be saved
 * or uploaded would be a cheat, not a tweak.
 *
 * The realtime simulation runs in the physics worker on its own clock, so the tools live there:
 *   - the time scale multiplies how fast simulated time accumulates against the wall clock;
 *   - a savestate is a snapshot of the worker's wasm heap (the physics state is all in there),
 *     stored as the pages that differ from a baseline taken on the first save.
 * This file is the main-thread half: keys, the readout, and the messages between the two.
 */
(function () {
  'use strict';

  const PREFS_KEY = 'pt-practice-prefs-v1';
  const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const SLOTS = 3;
  const log = (...a) => console.log('[practice]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const loadJSON = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

  const CSS = `
.pt-prac-panel { position:absolute; left:12px; bottom:12px; z-index:35; padding:8px 12px; min-width:210px;
  background:rgba(20,20,30,0.62); color:var(--text-color,#eef1ff); font-family:ForcedSquare, system-ui, sans-serif;
  font-size:16px; line-height:1.45; pointer-events:none; }
.pt-prac-panel.hidden { display:none; }
.pt-prac-panel h3 { margin:0 0 4px; font-size:17px; font-weight:normal; opacity:0.75; }
.pt-prac-panel .speed { font-size:26px; }
.pt-prac-panel .speed.slow { color:#8cd3ff; }
.pt-prac-panel .speed.fast { color:#ffc06b; }
.pt-prac-panel .slots { display:flex; gap:6px; margin:4px 0 2px; }
.pt-prac-panel .slot { padding:1px 8px; background:rgba(255,255,255,0.08); opacity:0.5; }
.pt-prac-panel .slot.filled { opacity:1; background:rgba(120,200,255,0.18); }
.pt-prac-panel .slot.active { outline:1px solid rgba(255,255,255,0.5); }
.pt-prac-panel .keys { font-size:14px; opacity:0.6; }
.pt-prac-panel .warn { font-size:14px; color:#ffd36b; }
`;

  const PTPractice = {
    race: null,
    panel: null,
    scale: 1,
    slot: 0,
    filled: [],              // which slots hold a state, and how big it is
    loaded: false,           // a savestate was restored during this attempt
    dirtyAttempt: false,
    prefs: null,

    init() {
      this.prefs = Object.assign({
        slower: 'BracketLeft', faster: 'BracketRight', normal: 'Backslash',
        save: 'F5', load: 'F6', forget: 'F7', cycle: 'F4', panel: true,
      }, loadJSON(PREFS_KEY, {}));
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
      this.scale = 1;
      this.slot = 0;
      this.filled = [];
      this.loaded = false;
      this.dirtyAttempt = false;
      this.send({ __pt: 'scale', value: 1 });
      this.show();
      this.draw();
    },

    disarm() {
      if (!this.race) return;
      this.race = null;
      this.scale = 1;
      this.filled = [];
      this.loaded = false;
      this.dirtyAttempt = false;
      this.send({ __pt: 'scale', value: 1 });
      this.send({ __pt: 'release' });        // give the snapshot memory back
      if (this.panel) this.panel.classList.add('hidden');
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
          this.toast('Savestate ' + (msg.slot + 1) + ' is empty — press ' + this.keyName(this.prefs.save) + ' first.');
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
    setScale(value) {
      if (!this.race) return;
      this.scale = value;
      this.send({ __pt: 'scale', value });
      if (value !== 1) this.dirtyAttempt = true;
      this.draw();
    },

    step(direction) {
      const i = SPEEDS.indexOf(this.scale);
      const next = i < 0 ? 4 : Math.max(0, Math.min(SPEEDS.length - 1, i + direction));
      this.setScale(SPEEDS[next]);
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
      if (window.PTRuns && window.PTRuns.rebinding) return;
      const p = this.prefs;
      let handled = true;
      switch (e.code) {
        case p.slower: this.step(-1); break;
        case p.faster: this.step(1); break;
        case p.normal: this.setScale(1); break;
        case p.save: this.save(); break;
        case p.load: this.load(); break;
        case p.forget: this.forget(); break;
        case p.cycle: this.cycle(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    },

    keyName(code) {
      if (!code) return '—';
      return code.replace(/^Key|^Digit/, '').replace('BracketLeft', '[').replace('BracketRight', ']').replace('Backslash', '\\');
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
      const speed = el('div', 'speed', (this.scale === 1 ? '1' : String(this.scale)) + '×');
      speed.classList.toggle('slow', this.scale < 1);
      speed.classList.toggle('fast', this.scale > 1);
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
        p.appendChild(el('div', 'keys', 'savestate memory: ' + mb.toFixed(0) + ' MB (freed when you leave, or on '
          + this.keyName(this.prefs.forget) + ')'));
      }
      p.appendChild(el('div', 'keys',
        this.keyName(this.prefs.slower) + ' / ' + this.keyName(this.prefs.faster) + ' speed  ·  ' +
        this.keyName(this.prefs.save) + ' save  ·  ' + this.keyName(this.prefs.load) + ' load  ·  ' +
        this.keyName(this.prefs.cycle) + ' slot'));
      if (this.dirty()) p.appendChild(el('div', 'warn', 'practice run — not recorded'));
    },
  };

  window.PTPractice = PTPractice;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTPractice.init());
  else PTPractice.init();
})();
