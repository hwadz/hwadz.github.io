/*
 * PolyTrack Tweaks — telemetry.
 *
 * A small panel on the right of the screen while you drive, and in the replay viewer for whichever car
 * is focused there. Every value has a picture for reading at a glance and an exact number next to it:
 *
 *   - speed, and the car's acceleration along and across itself (a g-circle);
 *   - the inputs, and the steering angle;
 *   - per wheel: suspension length and how far it is compressed, grip, and whether it touches the ground;
 *   - the car's attitude against the direction it is travelling: the total angle between the nose and
 *     the travel direction, and its yaw, pitch and roll parts;
 *   - the last checkpoint: your time there and every ghost's (in a replay, every other car's), ordered
 *     by that time — earlier first, alphabetical on a tie — with each one's difference to yours;
 *   - air time, wheels on the ground, top speed and distance of the run, the last hit, rotation rate,
 *     position.
 *
 * Settings → Tweaks → Telemetry turns it off. It is built as a data layer (what was measured) and a view (how it
 * is drawn), so the look can change without touching the measuring.
 *
 * Where the numbers come from: the physics worker sends the car's state for every simulated
 * millisecond (position, rotation, per-wheel suspension length and velocity, ground contact, skid
 * info, steering, inputs, checkpoint count). Velocity is not part of it, so it is taken from two
 * positions 8 ms apart (it agrees with the game's own speed to 0.01 %), rotation rate from two
 * rotations, and acceleration from two velocities 25 ms apart. Conventions follow the game's own replay
 * graphs: grip is the wheel's skid info (100 % = full grip, 0 % in the air), suspension in centimetres.
 */
(function () {
  'use strict';

  // measured on world-record replays (tests/ui-selftest.js, role physprobe)
  const SUSP_FREE = 0.12;          // m: a wheel's suspension length when it hangs free
  const WHEEL_RADIUS = 0.333;      // m
  const G = 9.81;                  // m/s² per g
  const W_VEL = 8;                 // ms between the two positions a velocity comes from
  const W_ACC = 25;                // ms between the two velocities an acceleration comes from
  const TEXT_MS = 66;              // how often the numbers are rewritten
  const DRAW_MS = 15;              // and the drawings: at most about 60 times a second
  const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];
  const RAD = 180 / Math.PI;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmtTime = (ms) => (ms == null ? '—' : window.PTRunsCore ? window.PTRunsCore.formatTime(ms) : (ms / 1000).toFixed(3));
  const signed = (v, d) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '−' : v > 0 ? '+' : '±') + Math.abs(v).toFixed(d));
  const fixed = (v, d) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));
  const settingsEnum = () => window.__ptSettingEnum;

  // ---------------------------------------------------------------- vectors
  /** (x, y, z) rotated by quaternion q. */
  function qrot(q, x, y, z) {
    const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z;
    return { x: ix * q.w - iw * q.x - iy * q.z + iz * q.y, y: iy * q.w - iw * q.y - iz * q.x + ix * q.z, z: iz * q.w - iw * q.z - ix * q.y + iy * q.x };
  }
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
  const len = (a) => Math.hypot(a.x, a.y, a.z);
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  /** The car's own axes in the world: forward (+z), up (+y), left (+x). */
  const axesOf = (q) => ({ F: qrot(q, 0, 0, 1), U: qrot(q, 0, 1, 0), L: qrot(q, 1, 0, 0) });

  /** Velocity (m/s, world) between two states, or null when they are not a few ms apart on one run. */
  function velocity(a, b) {
    if (!a || !b) return null;
    const dt = (a.frames - b.frames) / 1000;
    if (!(dt > 0) || dt > 0.1) return null;
    const v = scale(sub(a.position, b.position), 1 / dt);
    return len(v) > 300 ? null : v;                       // over 1000 km/h: a teleport (reset, savestate)
  }

  /** Angular velocity (rad/s, world) between two states. */
  function spin(a, b) {
    if (!a || !b) return null;
    const dt = (a.frames - b.frames) / 1000;
    if (!(dt > 0) || dt > 0.1) return null;
    const q1 = a.quaternion, q0 = b.quaternion;
    // q1 * conj(q0)
    let w = q1.w * q0.w + q1.x * q0.x + q1.y * q0.y + q1.z * q0.z;
    let x = -q1.w * q0.x + q1.x * q0.w - q1.y * q0.z + q1.z * q0.y;
    let y = -q1.w * q0.y + q1.y * q0.w - q1.z * q0.x + q1.x * q0.z;
    let z = -q1.w * q0.z + q1.z * q0.w - q1.x * q0.y + q1.y * q0.x;
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
    const s = Math.hypot(x, y, z);
    if (s < 1e-9) return { x: 0, y: 0, z: 0 };
    const angle = 2 * Math.atan2(s, w);
    return scale({ x, y, z }, angle / s / dt);
  }

  // ---------------------------------------------------------------- what a run did so far
  /** Distance, top speed, air time and hits, fed one state at a time in frame order. */
  class Tally {
    constructor() { this.reset(); }
    reset() {
      this.prev = null; this.dist = 0; this.top = 0;
      this.airSince = -1;                                 // frame the wheels last left the ground, -1 while on it
      this.lastAir = 0;                                   // ms, the last completed time in the air
      this.hitFrame = -1; this.hitSize = 0;
    }
    add(s) {
      const p = this.prev;
      if (p && s.frames === p.frames + 1 && s.hasStarted) {
        const d = len(sub(s.position, p.position));
        if (d < 1) this.dist += d;                        // a metre in a millisecond is a teleport, not driving
      }
      if (s.hasStarted && Math.abs(s.speedKmh) > this.top) this.top = Math.abs(s.speedKmh);
      const on = s.wheelContact[0] || s.wheelContact[1] || s.wheelContact[2] || s.wheelContact[3];
      if (on) {
        if (this.airSince >= 0) { this.lastAir = s.frames - this.airSince; this.airSince = -1; }
      } else if (this.airSince < 0 && s.hasStarted) this.airSince = s.frames;
      let hit = 0;
      for (const i of s.collisionImpulses) if (Math.abs(i) > hit) hit = Math.abs(i);
      if (hit > 1) { this.hitFrame = s.frames; this.hitSize = hit; }
      this.prev = s;
    }
    view(frame) {
      return { dist: this.dist, top: this.top, air: this.airSince >= 0 ? frame - this.airSince : 0, lastAir: this.lastAir,
        hitAgo: this.hitFrame >= 0 ? frame - this.hitFrame : null, hitSize: this.hitSize };
    }
  }

  /** The same, kept for every frame of a replay so any moment of it can be looked at. */
  class ReplayTally {
    constructor(entry) {
      this.entry = entry;
      const cap = (entry.settings && entry.settings.time ? entry.settings.time.numberOfFrames : 60000) + 10002;
      this.cap = cap;
      this.dist = new Float64Array(cap); this.top = new Float32Array(cap);
      this.airSince = new Int32Array(cap); this.lastAir = new Int32Array(cap);
      this.hitFrame = new Int32Array(cap); this.hitSize = new Float32Array(cap);
      this.done = 0;
      this.t = new Tally();
    }
    /** Reads the frames the replay has simulated since last time, for at most `ms` of this frame. */
    advance(ms) {
      const until = performance.now() + ms;
      const last = Math.min(this.entry.replay.getLastFrame().numberOfFrames, this.cap - 1);
      while (this.done <= last) {
        const s = this.entry.replay.getFrame(this.done);
        if (!s) break;
        this.t.add(s);
        const i = this.done, t = this.t;
        this.dist[i] = t.dist; this.top[i] = t.top; this.airSince[i] = t.airSince; this.lastAir[i] = t.lastAir;
        this.hitFrame[i] = t.hitFrame; this.hitSize[i] = t.hitSize;
        this.done++;
        if ((this.done & 127) === 0 && performance.now() > until) break;
      }
    }
    view(frame) {
      if (frame < 0 || frame >= this.done) return null;
      const a = this.airSince[frame], h = this.hitFrame[frame];
      return { dist: this.dist[frame], top: this.top[frame], air: a >= 0 ? frame - a : 0, lastAir: this.lastAir[frame],
        hitAgo: h >= 0 ? frame - h : null, hitSize: this.hitSize[frame] };
    }
  }

  /** The last states the player's car was given, by frame. */
  class History {
    constructor(size) { this.buf = new Array(size); this.size = size; this.n = 0; }
    clear() { this.n = 0; }
    push(s) { this.buf[this.n % this.size] = s; this.n++; }
    last() { return this.n ? this.buf[(this.n - 1) % this.size] : null; }
    at(frame) {
      const last = this.last();
      if (!last) return null;
      const back = last.frames - frame;
      if (back < 0 || back >= Math.min(this.n, this.size)) return null;
      const s = this.buf[(this.n - 1 - back) % this.size];
      return s && s.frames === frame ? s : null;
    }
  }

  // ---------------------------------------------------------------- where the data comes from
  /** A race (or an editor test drive): the player's car, and the ghosts it races against. */
  class RaceSource {
    constructor(race) { this.race = race; this.kind = 'race'; this.car = null; this.hist = new History(64); this.tally = new Tally(); this.cps = []; }
    run() { try { return this.race.__ptRun(); } catch { return null; } }
    hud() { try { return this.race.__ptCollab().hud; } catch { return null; } }
    sync() {
      const run = this.run();
      if (!run) return false;
      if (run.car !== this.car) this.bind(run.car);
      return !!this.car;
    }
    bind(car) {
      if (this.car && this.car.__ptRec === this.rec) this.car.__ptRec = null;
      this.car = car; this.hist.clear(); this.tally.reset(); this.cps = [];
      if (!car) return;
      this.rec = (s) => this.onState(s);
      car.__ptRec = this.rec;
      try { const s = car.getCarState(); if (s) this.onState(s); } catch { }
    }
    unbind() { if (this.car && this.car.__ptRec === this.rec) this.car.__ptRec = null; this.car = null; }
    onState(s) {
      const last = this.hist.last();
      if (last && s.frames <= last.frames) {               // time went back: a savestate was loaded
        this.hist.clear(); this.tally.reset();
        this.cps.length = Math.min(this.cps.length, s.nextCheckpointIndex);
      }
      this.hist.push(s);
      this.tally.add(s);
      while (this.cps.length < s.nextCheckpointIndex) this.cps.push(s.frames);
    }
    focus() {
      const s = this.car && this.car.getCarState();
      if (!s) return null;
      return { name: 'You', you: true, state: s, at: (n) => this.hist.at(n), tally: this.tally.view(s.frames), cps: this.cps, finish: s.finishFrames };
    }
    rivals() {
      const run = this.run();
      const out = [];
      for (const g of (run && run.ghosts) || []) {
        const st = g.settings || {};
        out.push({ name: st.isSelf ? 'Personal best' : (st.nickname || 'Ghost'), self: !!st.isSelf,
          cps: (g.checkpoints || []).map((c) => c.time.numberOfFrames), finish: st.time ? st.time.numberOfFrames : null });
      }
      return out;
    }
    checkpointCount() { try { return this.run().track.getTotalNumberOfCheckpointIndices(); } catch { return null; } }
    settings() { try { return this.run().settings; } catch { return null; } }
  }

  /** The replay viewer: the focused car, and every other car in the replay. */
  class ReplaySource {
    constructor(viewer) { this.viewer = viewer; this.kind = 'replay'; this.tallies = new Map(); }
    info() { try { return this.viewer.__ptReplay(); } catch { return null; } }
    hud() { const i = this.info(); return i && i.hud ? i.hud.element : null; }
    sync() {
      const i = this.info();
      if (!i || !i.cars || !i.cars.length) return false;
      const e = i.cars[i.focus];
      let t = this.tallies.get(e);
      if (!t) { t = new ReplayTally(e); this.tallies.set(e, t); }
      t.advance(2);
      return true;
    }
    focus() {
      const i = this.info();
      const e = i.cars[i.focus];
      const s = e.car.getCarState();
      if (!s) return null;
      const t = this.tallies.get(e);
      const cps = e.checkpointTimes.map((x) => x.numberOfFrames);
      return { name: e.settings.nickname || 'Car', you: !!e.settings.isSelf, state: s, at: (n) => (n >= 0 ? e.replay.getFrame(n) : null),
        tally: t ? t.view(s.frames) : null, cps, finish: s.finishFrames != null ? s.finishFrames : null, entry: e };
    }
    rivals() {
      const i = this.info();
      const out = [];
      i.cars.forEach((e, k) => {
        if (k === i.focus) return;
        out.push({ name: (e.settings.nickname || 'Car') + (e.settings.isSelf ? ' (you)' : ''), self: !!e.settings.isSelf,
          cps: e.checkpointTimes.map((x) => x.numberOfFrames), finish: e.settings.time ? e.settings.time.numberOfFrames : null });
      });
      return out;
    }
    checkpointCount() { try { return this.info().track.getTotalNumberOfCheckpointIndices(); } catch { return null; } }
    settings() { try { return this.info().settings; } catch { return null; } }
  }

  // ---------------------------------------------------------------- measuring
  /** Everything the panel shows, for the focused car at its current frame. */
  function measure(f) {
    const s = f.state, n = s.frames;
    const m = { frame: n, speed: Math.abs(s.speedKmh), started: s.hasStarted, controls: s.controls, steering: s.steering * RAD,
      position: s.position, wheels: [], tally: f.tally };
    const ax = axesOf(s.quaternion);
    const s1 = f.at(n - W_VEL);
    const v = velocity(s, s1);
    m.v = v;
    if (v && len(v) > 1) {
      const sp = len(v), vf = dot(v, ax.F), vl = dot(v, ax.L), vu = dot(v, ax.U);
      m.total = Math.acos(clamp(vf / sp, -1, 1)) * RAD;
      m.yaw = Math.atan2(vl, vf) * RAD;                                  // + : nose right of the travel direction
      m.pitch = Math.atan2(-vu, Math.hypot(vf, vl)) * RAD;               // + : nose above it
      const nrm = scale(v, 1 / sp), up = { x: 0, y: 1, z: 0 };
      const a = sub(up, scale(nrm, dot(up, nrm))), b = sub(ax.U, scale(nrm, dot(ax.U, nrm)));
      if (len(a) > 0.05 && len(b) > 0.05) m.roll = Math.atan2(dot(cross(a, b), nrm), dot(a, b)) * RAD;   // + : right side down
      m.travel = { f: vf / sp, l: vl / sp, u: vu / sp };
    }
    const w = spin(s, s1);
    if (w) { m.yawRate = -dot(w, ax.U) * RAD; m.pitchRate = -dot(w, ax.L) * RAD; m.rollRate = dot(w, ax.F) * RAD; }
    const s2 = f.at(n - W_ACC), s3 = f.at(n - W_ACC - W_VEL);
    const v0 = velocity(s2, s3);
    if (v && v0) {
      const acc = scale(sub(v, v0), 1000 / (n - s2.frames));
      m.long = dot(acc, ax.F) / G;
      m.lat = -dot(acc, ax.L) / G;                                        // + : towards the car's right
    }
    let down = 0;
    for (let i = 0; i < 4; i++) {
      const on = !!s.wheelContact[i], L = s.wheelSuspensionLength[i], rot = s.wheelDeltaRotation[i];
      if (on) down++;
      const skidLimit = Math.pow(Math.min(1, Math.abs(rot) / 0.08), 3) * 0.5;    // the game draws skid marks below this
      m.wheels.push({ on, length: L, comp: (SUSP_FREE - L) / SUSP_FREE, vel: s.wheelSuspensionVelocity[i],
        grip: on ? s.wheelSkidInfo[i] : null, sliding: on && s.wheelSkidInfo[i] < skidLimit, spin: rot * 1000 * WHEEL_RADIUS * 3.6 });
    }
    m.down = down;
    return m;
  }

  /** The checkpoint table: the focused car's last checkpoint, and everyone's time there. */
  function standings(f, rivals, total) {
    const s = f.state, now = s.frames;
    const done = f.cps.filter((t) => t <= now).length;
    const finished = f.finish != null && f.finish <= now;
    const stage = finished ? { label: 'Finish', key: 'finish' } : done > 0 ? { label: 'Checkpoint ' + done + (total ? ' / ' + total : ''), key: done - 1 } : { label: 'Start', key: null };
    const mine = finished ? f.finish : done > 0 ? f.cps[done - 1] : null;
    const rows = [{ name: f.name, you: true, time: mine }];
    for (const r of rivals) {
      const t = stage.key === 'finish' ? r.finish : stage.key == null ? null : (r.cps[stage.key] != null ? r.cps[stage.key] : null);
      rows.push({ name: r.name, you: false, self: r.self, time: t, diff: mine != null && t != null ? mine - t : null });
    }
    // earlier first; a tie, or no time at all, goes alphabetical
    rows.sort((a, b) => {
      if (a.time != null && b.time != null && a.time !== b.time) return a.time - b.time;
      if ((a.time == null) !== (b.time == null)) return a.time == null ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return { stage, mine, rows };
  }

  // ---------------------------------------------------------------- the panel
  const CSS = `
.pt-tm { position:absolute; right:10px; top:50%; transform:translateY(-50%); z-index:30; width:286px; box-sizing:border-box;
  padding:6px 9px 8px; background:rgba(14,18,42,0.68); color:#eef1ff; font-family:ForcedSquare, system-ui, sans-serif;
  font-size:13px; line-height:1.3; pointer-events:none; border-left:3px solid rgba(255,200,74,0.85); contain:layout paint; }
.pt-tm.hidden { display:none; }
.pt-tm .hd { display:flex; align-items:baseline; gap:6px; font-size:11px; letter-spacing:1px; }
.pt-tm .hd .ttl { color:#ffc84a; }
.pt-tm .hd .who { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:0.85; letter-spacing:0; font-size:12px; }
.pt-tm .hd .clock { font-size:12px; letter-spacing:0; }
.pt-tm .sec { margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.13); }
.pt-tm .row { display:flex; align-items:center; gap:7px; }
.pt-tm .lbl { font-size:10px; opacity:0.6; letter-spacing:0.5px; }
.pt-tm .dim { opacity:0.6; }
.pt-tm canvas { display:block; flex:none; }
.pt-tm .speed { font-size:22px; line-height:1.05; }
.pt-tm .speed small { font-size:11px; opacity:0.7; margin-left:3px; }
.pt-tm .kv { display:grid; grid-template-columns:auto 1fr auto 1fr; column-gap:6px; row-gap:1px; font-size:12px; align-items:baseline; }
.pt-tm .kv > .v { text-align:right; white-space:nowrap; }
.pt-tm .keys { display:grid; grid-template-columns:repeat(3,15px); grid-template-rows:repeat(2,15px); gap:2px; flex:none; }
.pt-tm .key { display:flex; align-items:center; justify-content:center; font-size:9px; background:rgba(255,255,255,0.09); color:#cfd6ff; }
.pt-tm .key.on { background:#ffc84a; color:#14182c; }
.pt-tm .key.up { grid-column:2; grid-row:1; } .pt-tm .key.left { grid-column:1; grid-row:2; }
.pt-tm .key.down { grid-column:2; grid-row:2; } .pt-tm .key.right { grid-column:3; grid-row:2; }
.pt-tm .key.reset { grid-column:3; grid-row:1; font-size:8px; }
.pt-tm .steer { flex:1; }
.pt-tm .bar { position:relative; height:6px; margin-top:3px; background:rgba(255,255,255,0.1); }
.pt-tm .bar > i { position:absolute; top:0; bottom:0; background:#8cd3ff; }
.pt-tm .bar > b { position:absolute; left:50%; top:-2px; bottom:-2px; width:1px; background:rgba(255,255,255,0.45); }
.pt-tm table { border-collapse:collapse; font-size:12px; flex:1; }
.pt-tm td { padding:0 0 0 6px; white-space:nowrap; text-align:right; }
.pt-tm td:first-child { text-align:left; padding-left:0; opacity:0.7; }
.pt-tm th { font-weight:normal; font-size:10px; opacity:0.6; text-align:right; padding:0 0 1px 6px; }
.pt-tm th:first-child { text-align:left; padding-left:0; }
.pt-tm .slide { color:#ff8a76; }
.pt-tm .air { opacity:0.45; }
.pt-tm .angles { display:grid; grid-template-columns:repeat(4,1fr); gap:3px; text-align:center; }
.pt-tm .angles canvas { margin:0 auto; }
.pt-tm .angles .v { font-size:12px; }
.pt-tm .cphd { display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px; }
.pt-tm .cphd .t { color:#ffc84a; }
.pt-tm .cp { display:grid; grid-template-columns:12px 1fr 58px 50px 30px; column-gap:4px; font-size:12px; line-height:16px; align-items:center; }
.pt-tm .cp > span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pt-tm .cp > .t, .pt-tm .cp > .d { text-align:right; }
.pt-tm .cp.you { color:#ffc84a; }
.pt-tm .cp .d.slower { color:#ff8a76; } .pt-tm .cp .d.faster { color:#7be08a; }
.pt-tm .cp .g { position:relative; height:6px; background:rgba(255,255,255,0.06); }
.pt-tm .cp .g > i { position:absolute; top:0; bottom:0; }
.pt-tm .cp .g > i.slower { right:50%; background:#ff8a76; } .pt-tm .cp .g > i.faster { left:50%; background:#7be08a; }
.pt-tm .cp .g > b { position:absolute; left:50%; top:-1px; bottom:-1px; width:1px; background:rgba(255,255,255,0.4); }
`;

  /** A text node that is only rewritten when its value changes. */
  class Field {
    constructor(parent, cls, text) { this.node = el('span', cls, text || ''); parent.appendChild(this.node); this.value = text || ''; }
    set(text) { if (text !== this.value) { this.value = text; this.node.textContent = text; } }
  }

  /** A small canvas drawn at the screen's pixel density. */
  function canvas(w, h) {
    const c = el('canvas');
    const k = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    const g = c.getContext('2d');
    g.scale(k, k);
    return { c, g, w, h };
  }

  const gripColour = (grip) => {
    if (grip == null) return 'rgba(255,255,255,0.12)';
    const t = clamp(grip, 0, 1);
    return 'hsl(' + Math.round(t * 120) + ',75%,55%)';                 // red (no grip) → green (full)
  };

  class Panel {
    constructor(hud) {
      if (!document.getElementById('pt-tm-css')) { const st = el('style'); st.id = 'pt-tm-css'; st.textContent = CSS; document.head.appendChild(st); }
      const root = this.root = el('div', 'pt-tm');
      const hd = el('div', 'hd');
      hd.appendChild(el('span', 'ttl', 'TELEMETRY'));
      this.who = new Field(hd, 'who');
      this.clock = new Field(hd, 'clock');
      root.appendChild(hd);

      // motion: speed, g-circle, rates
      const mo = el('div', 'sec row');
      this.gc = canvas(54, 54); mo.appendChild(this.gc.c);
      const mv = el('div'); mv.style.flex = '1';
      const sp = el('div', 'speed');
      this.speed = new Field(sp, '');
      const u = el('small'); sp.appendChild(u);
      this.speedUnit = new Field(u, '');
      mv.appendChild(sp);
      const kv = el('div', 'kv');
      const pair = (label) => { kv.appendChild(el('span', 'lbl', label)); return new Field(kv, 'v'); };
      this.fLong = pair('LONG'); this.fLat = pair('LAT');
      this.fYawRate = pair('TURN'); this.fDown = pair('WHEELS');
      mv.appendChild(kv);
      mo.appendChild(mv);
      root.appendChild(mo);

      // inputs and steering
      const ip = el('div', 'sec row');
      const keys = el('div', 'keys');
      this.keys = {};
      for (const [k, t] of [['up', '▲'], ['left', '◀'], ['down', '▼'], ['right', '▶'], ['reset', 'R']]) { const n = el('span', 'key ' + k, t); keys.appendChild(n); this.keys[k] = n; }
      ip.appendChild(keys);
      const st = el('div', 'steer');
      const sl = el('div', 'row'); sl.style.justifyContent = 'space-between';
      sl.appendChild(el('span', 'lbl', 'STEERING'));
      this.fSteer = new Field(sl, '');
      st.appendChild(sl);
      const bar = el('div', 'bar'); this.steerBar = el('i'); bar.appendChild(this.steerBar); bar.appendChild(el('b')); st.appendChild(bar);
      ip.appendChild(st);
      root.appendChild(ip);

      // wheels: suspension and grip
      const wh = el('div', 'sec row');
      this.car = canvas(56, 80); wh.appendChild(this.car.c);
      const tb = el('table');
      const head = el('tr');
      for (const h of ['', 'SUSP', 'COMP', 'GRIP']) head.appendChild(el('th', null, h));
      tb.appendChild(head);
      this.wheelRows = WHEEL_NAMES.map((name) => {
        const tr = el('tr');
        tr.appendChild(el('td', null, name));
        const cells = [el('td'), el('td'), el('td')];
        for (const c of cells) tr.appendChild(c);
        tb.appendChild(tr);
        return { tr, susp: new Field(cells[0]), comp: new Field(cells[1]), grip: new Field(cells[2]), cls: '' };
      });
      wh.appendChild(tb);
      root.appendChild(wh);

      // attitude against the travel direction
      const an = el('div', 'sec');
      const al = el('div', 'row'); al.style.justifyContent = 'space-between';
      al.appendChild(el('span', 'lbl', 'CAR VS TRAVEL DIRECTION'));
      an.appendChild(al);
      const grid = el('div', 'angles');
      this.angle = {};
      for (const [k, label] of [['total', 'TOTAL'], ['yaw', 'YAW'], ['pitch', 'PITCH'], ['roll', 'ROLL']]) {
        const cell = el('div');
        const cv = canvas(46, 34); cell.appendChild(cv.c);
        cell.appendChild(el('div', 'lbl', label));
        const v = el('div', 'v'); cell.appendChild(v);
        this.angle[k] = { cv, f: new Field(v, '') };
        grid.appendChild(cell);
      }
      an.appendChild(grid);
      root.appendChild(an);

      // checkpoints
      const cp = el('div', 'sec');
      const ch = el('div', 'cphd');
      this.cpStage = new Field(ch, ''); this.cpTime = new Field(ch, 't');
      cp.appendChild(ch);
      this.cpList = el('div'); cp.appendChild(this.cpList);
      this.cpRows = [];
      root.appendChild(cp);

      // the rest
      const ot = el('div', 'sec kv');
      const other = (label) => { ot.appendChild(el('span', 'lbl', label)); return new Field(ot, 'v'); };
      this.fAir = other('AIR'); this.fHit = other('LAST HIT');
      this.fTop = other('TOP'); this.fDist = other('DIST');
      this.fPitchRate = other('PITCH/S'); this.fRollRate = other('ROLL/S');
      root.appendChild(ot);
      const pos = el('div', 'kv');
      pos.style.gridTemplateColumns = 'auto 1fr';
      pos.appendChild(el('span', 'lbl', 'POS'));
      this.fPos = new Field(pos, 'v');
      root.appendChild(pos);

      hud.appendChild(root);
      this.trail = [];
    }

    dispose() { this.root.remove(); }
    show(on) { this.root.classList.toggle('hidden', !on); }

    // ---- every frame: the drawings
    draw(m) {
      this.drawG(m); this.drawCar(m); this.drawAngles(m);
      const k = m.controls || {};
      for (const key in this.keys) this.keys[key].classList.toggle('on', !!k[key]);
      const st = clamp(m.steering / 30, -1, 1);                        // the bar's ends are ±30°
      const left = (st >= 0 ? 50 - st * 50 : 50).toFixed(1) + '%', width = (Math.abs(st) * 50).toFixed(1) + '%';
      if (left !== this.steerLeft) { this.steerLeft = left; this.steerBar.style.left = left; }
      if (width !== this.steerWidth) { this.steerWidth = width; this.steerBar.style.width = width; }
    }

    drawG(m) {
      // rings at 1, 2, 4 and 6 g on a square-root scale: everyday cornering keeps room to move, and the
      // 5 g of a fast banked turn still fits
      const { g, w, h } = this.gc, cx = w / 2, cy = h / 2, R = w / 2 - 2, full = 6;
      const radius = (gs) => Math.sqrt(Math.min(gs, full) / full) * R;
      g.clearRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1;
      for (const r of [1, 2, 4, 6]) { g.beginPath(); g.arc(cx, cy, radius(r), 0, 2 * Math.PI); g.stroke(); }
      g.beginPath(); g.moveTo(cx, 2); g.lineTo(cx, h - 2); g.moveTo(2, cy); g.lineTo(w - 2, cy); g.stroke();
      if (m.long == null) { this.trail.length = 0; return; }
      const mag = Math.hypot(m.lat, m.long), k = mag > 1e-6 ? radius(mag) / mag : 0;
      const x = cx + m.lat * k, y = cy - m.long * k;
      this.trail.push(x, y);
      if (this.trail.length > 40) this.trail.splice(0, 2);
      g.strokeStyle = 'rgba(255,200,74,0.35)'; g.beginPath();
      for (let i = 0; i < this.trail.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, this.trail[i], this.trail[i + 1]);
      g.stroke();
      g.fillStyle = '#ffc84a'; g.beginPath(); g.arc(x, y, 3, 0, 2 * Math.PI); g.fill();
    }

    drawCar(m) {
      const { g, w, h } = this.car;
      g.clearRect(0, 0, w, h);
      const bx = 14, by = 6, bw = w - 28, bh = h - 12;
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.rect(bx, by, bw, bh); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(bx + 4, by + 8); g.lineTo(bx + bw / 2, by + 2); g.lineTo(bx + bw - 4, by + 8); g.stroke();   // the nose
      const ww = 9, wh = 22;
      const spots = [[bx - ww - 2, by + 4], [bx + bw + 2, by + 4], [bx - ww - 2, by + bh - wh - 4], [bx + bw + 2, by + bh - wh - 4]];
      for (let i = 0; i < 4; i++) {
        const wd = m.wheels[i], [x, y] = spots[i];
        g.save();
        g.translate(x + ww / 2, y + wh / 2);
        if (i < 2) g.rotate(-m.steering / RAD);                           // front wheels follow the steering
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-ww / 2, -wh / 2, ww, wh);
        const c = clamp(wd.comp, 0, 1);
        g.fillStyle = gripColour(wd.grip);
        g.fillRect(-ww / 2, wh / 2 - c * wh, ww, c * wh);                 // fill height: suspension compression
        g.setLineDash(wd.on ? [] : [2, 2]);
        g.strokeStyle = wd.sliding ? '#ff8a76' : wd.on ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
        g.strokeRect(-ww / 2 + 0.5, -wh / 2 + 0.5, ww - 1, wh - 1);
        g.restore();
      }
    }

    drawAngles(m) {
      const ok = m.travel != null;
      // total: a dial from 0° (straight on) to 180° (backwards)
      {
        const { g, w, h } = this.angle.total.cv, cx = w / 2, cy = h - 4, R = 16;
        g.clearRect(0, 0, w, h);
        g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.beginPath(); g.arc(cx, cy, R, Math.PI, 2 * Math.PI); g.stroke();
        if (ok) {
          const t = clamp(m.total / 180, 0, 1);
          g.strokeStyle = t < 0.1 ? '#7be08a' : t < 0.3 ? '#ffc84a' : '#ff8a76';
          g.beginPath(); g.arc(cx, cy, R, Math.PI, Math.PI + t * Math.PI); g.stroke();
        }
      }
      // yaw from above, pitch from the side, roll from behind: the travel direction is the fixed arrow
      const view = (key, angle, draw) => {
        const { g, w, h } = this.angle[key].cv, cx = w / 2, cy = h / 2;
        g.clearRect(0, 0, w, h);
        g.strokeStyle = 'rgba(140,211,255,0.85)'; g.fillStyle = 'rgba(140,211,255,0.85)'; g.lineWidth = 1.5;
        draw.arrow(g, cx, cy, w, h);
        if (angle == null) return;
        g.save(); g.translate(cx, cy); g.rotate(angle / RAD);
        g.fillStyle = 'rgba(255,255,255,0.22)'; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1;
        draw.car(g);
        g.restore();
      };
      view('yaw', ok ? m.yaw : null, {
        arrow: (g, cx, cy, w, h) => { g.beginPath(); g.moveTo(cx, h - 2); g.lineTo(cx, 2); g.stroke(); g.beginPath(); g.moveTo(cx, 1); g.lineTo(cx - 3, 6); g.lineTo(cx + 3, 6); g.fill(); },
        car: (g) => { g.beginPath(); g.rect(-5, -11, 10, 22); g.fill(); g.stroke(); g.beginPath(); g.moveTo(-5, -6); g.lineTo(0, -11); g.lineTo(5, -6); g.stroke(); },
      });
      view('pitch', ok ? -m.pitch : null, {
        arrow: (g, cx, cy, w) => { g.beginPath(); g.moveTo(2, cy); g.lineTo(w - 2, cy); g.stroke(); g.beginPath(); g.moveTo(w - 1, cy); g.lineTo(w - 6, cy - 3); g.lineTo(w - 6, cy + 3); g.fill(); },
        car: (g) => { g.beginPath(); g.moveTo(-12, 3); g.lineTo(12, 3); g.lineTo(12, 0); g.lineTo(4, -2); g.lineTo(-4, -5); g.lineTo(-12, -4); g.closePath(); g.fill(); g.stroke();
          g.beginPath(); g.arc(-8, 4, 2.5, 0, 2 * Math.PI); g.arc(8, 4, 2.5, 0, 2 * Math.PI); g.stroke(); },
      });
      view('roll', ok && m.roll != null ? m.roll : null, {
        arrow: (g, cx, cy, w, h) => { g.setLineDash([2, 2]); g.beginPath(); g.moveTo(cx, h - 2); g.lineTo(cx, 2); g.stroke(); g.setLineDash([]); },
        car: (g) => { g.beginPath(); g.rect(-11, -5, 22, 8); g.fill(); g.stroke(); g.beginPath(); g.rect(-6, -10, 12, 5); g.stroke();
          g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(-13, 1, 4, 5); g.fillRect(9, 1, 4, 5); },
      });
    }

    // ---- a few times a second: the numbers
    text(m, f, src, cps) {
      const imperial = this.imperial;
      const spd = imperial ? m.speed / 1.609344 : m.speed;
      this.who.set(f.name);
      this.clock.set(fmtTime(m.frame));
      this.speed.set(spd.toFixed(2));
      this.speedUnit.set(imperial ? 'mph' : 'km/h');
      this.fLong.set(m.long == null ? '—' : signed(m.long, 2) + ' g');
      this.fLat.set(m.lat == null ? '—' : signed(m.lat, 2) + ' g');
      this.fYawRate.set(m.yawRate == null ? '—' : signed(m.yawRate, 0) + '°/s');
      this.fDown.set(m.down + ' / 4');
      const sd = m.steering;
      this.fSteer.set(Math.abs(sd) < 0.05 ? '0.0°' : Math.abs(sd).toFixed(1) + '° ' + (sd > 0 ? 'L' : 'R'));
      for (let i = 0; i < 4; i++) {
        const wd = m.wheels[i], row = this.wheelRows[i];
        row.susp.set((wd.length * 100).toFixed(2) + ' cm');
        row.comp.set(Math.round(wd.comp * 100) + '%');
        row.grip.set(wd.grip == null ? (m.started ? 'air' : '—') : (wd.grip * 100).toFixed(1) + '%');
        const cls = wd.sliding ? 'slide' : wd.on || !m.started ? '' : 'air';
        if (cls !== row.cls) { row.cls = cls; row.tr.className = cls; }
      }
      const deg = (v) => (v == null ? '—' : signed(v, 1) + '°');
      this.angle.total.f.set(m.total == null ? '—' : m.total.toFixed(1) + '°');
      this.angle.yaw.f.set(deg(m.yaw));
      this.angle.pitch.f.set(deg(m.pitch));
      this.angle.roll.f.set(deg(m.roll));

      // checkpoints
      this.cpStage.set(cps.stage.label);
      this.cpTime.set(cps.mine == null ? '' : fmtTime(cps.mine));
      const rows = cps.rows;
      while (this.cpRows.length < rows.length) {
        const r = el('div', 'cp');
        const o = { node: r, rank: new Field(r, 'dim'), name: new Field(r), time: new Field(r, 't'), diff: new Field(r, 'd'), cls: '' };
        const gbar = el('span', 'g'); o.bar = el('i'); gbar.appendChild(o.bar); gbar.appendChild(el('b')); r.appendChild(gbar);
        this.cpList.appendChild(r); this.cpRows.push(o);
      }
      while (this.cpRows.length > rows.length) this.cpRows.pop().node.remove();
      const scaleMs = Math.max(100, ...rows.map((r) => (r.diff != null ? Math.abs(r.diff) : 0)));
      rows.forEach((r, i) => {
        const o = this.cpRows[i];
        const cls = r.you ? 'cp you' : 'cp';
        if (cls !== o.cls) { o.cls = cls; o.node.className = cls; }
        o.rank.set(r.time != null ? String(i + 1) : '');
        o.name.set(r.name);
        o.time.set(r.time == null ? '—' : fmtTime(r.time));
        const slower = r.diff != null && r.diff > 0, faster = r.diff != null && r.diff < 0;
        o.diff.set(r.you ? '' : r.diff == null ? '' : (r.diff > 0 ? '+' : r.diff < 0 ? '−' : '±') + (Math.abs(r.diff) / 1000).toFixed(3));
        o.diff.node.className = 'd' + (slower ? ' slower' : faster ? ' faster' : '');
        o.bar.className = slower ? 'slower' : faster ? 'faster' : '';
        o.bar.style.width = r.diff == null || r.you ? '0' : (Math.min(1, Math.abs(r.diff) / scaleMs) * 50).toFixed(1) + '%';
      });

      // the rest
      const t = m.tally;
      this.fAir.set(!t ? '…' : t.air > 0 ? (t.air / 1000).toFixed(2) + ' s' : t.lastAir > 0 ? 'last ' + (t.lastAir / 1000).toFixed(2) + ' s' : '0.00 s');
      this.fHit.set(!t ? '…' : t.hitAgo == null ? '—' : Math.round(t.hitSize) + ' · ' + (t.hitAgo / 1000).toFixed(1) + ' s ago');
      this.fTop.set(!t ? '…' : (imperial ? (t.top / 1.609344).toFixed(1) + ' mph' : t.top.toFixed(1) + ' km/h'));
      this.fDist.set(!t ? '…' : imperial ? (t.dist / 1609.344).toFixed(3) + ' mi' : t.dist >= 1000 ? (t.dist / 1000).toFixed(3) + ' km' : t.dist.toFixed(1) + ' m');
      this.fPitchRate.set(m.pitchRate == null ? '—' : signed(m.pitchRate, 0) + '°/s');
      this.fRollRate.set(m.rollRate == null ? '—' : signed(m.rollRate, 0) + '°/s');
      const p = m.position;
      this.fPos.set(p.x.toFixed(2) + ', ' + p.y.toFixed(2) + ', ' + p.z.toFixed(2));
    }
  }

  // ---------------------------------------------------------------- lifecycle
  const PTTelemetry = {
    ctx: null,                  // { src, owner, panel }
    raf: 0,
    lastText: 0,
    lastDraw: 0,
    lastState: null,

    enabled(src) {
      const E = settingsEnum(), s = (src && src.settings()) || window.__ptSettingsMgr;
      if (!E || !s) return true;
      try { return s.getSetting(E.TweaksTelemetry) !== 'false'; } catch { return true; }
    },

    attachRace(race) { this.attach(new RaceSource(race), race); },
    attachReplay(viewer) { this.attach(new ReplaySource(viewer), viewer); },

    attach(src, owner) {
      this.detach();
      this.ctx = { src, owner, panel: null, viewer: src.kind === 'replay' ? owner : null };
      this.last = null; this.lastState = null; this.lastText = 0; this.lastDraw = 0;
      const loop = () => { this.raf = requestAnimationFrame(loop); this.tick(); };
      this.raf = requestAnimationFrame(loop);
    },

    detach(owner) {
      const c = this.ctx;
      if (!c || (owner && c.owner !== owner)) return;
      cancelAnimationFrame(this.raf);
      if (c.src.unbind) c.src.unbind();
      if (c.panel) c.panel.dispose();
      this.ctx = null;
    },

    tick() {
      const c = this.ctx;
      if (!c) return;
      try {
        const on = this.enabled(c.src);
        if (!on) {
          if (c.panel) c.panel.show(false);
          if (c.src.unbind && c.src.car) c.src.unbind();     // stop listening to the car while it's off
          return;
        }
        if (!c.src.sync()) return;
        if (!c.panel) {
          const hud = c.src.hud();
          if (!hud) return;
          c.panel = new Panel(hud);
        }
        c.panel.show(true);
        const f = c.src.focus();
        if (!f) return;
        // redraw at most 60 times a second, and only when the car's state changed (nothing while paused)
        const now = performance.now();
        const fresh = f.state !== this.lastState;
        if (fresh && now - this.lastDraw >= DRAW_MS) {
          this.lastDraw = now;
          this.lastState = f.state;
          this.last = measure(f);
          c.panel.draw(this.last);
        }
        const m = this.last;
        if (!m) return;
        if (now - this.lastText >= TEXT_MS) {
          this.lastText = now;
          let imperial = false;
          try { const E = settingsEnum(); imperial = c.src.settings().getSetting(E.ImperialUnitsEnabled) === 'true'; } catch { }
          c.panel.imperial = imperial;
          const cps = standings(f, c.src.rivals(), c.src.checkpointCount());
          this.lastStandings = cps;
          c.panel.text(m, f, c.src, cps);
        }
      } catch (e) {
        if (!this.warned) { this.warned = true; console.warn('[telemetry]', e); }
      }
    },
  };

  PTTelemetry.measure = measure;
  PTTelemetry.standings = standings;
  window.PTTelemetry = PTTelemetry;
})();
