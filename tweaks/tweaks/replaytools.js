/*
 * PolyTrack Tweaks — replay tools.
 *
 * In the game's replay viewer, next to its play button:
 *   - speed: slow motion down to 0.1×, or 2× (the button steps through them; the "Slower", "Faster"
 *     and "Normal speed" keys of Settings → Controls → Tweaks: replays too). The cars fall silent
 *     away from 1×.
 *   - an A–B loop: the button marks where the loop starts, then where it ends, then turns it off
 *     ("Loop from here" / "Loop to here" / "Loop on/off" keys). Playing past the end jumps back to
 *     the start. The section shows on the timeline.
 *   - a clip of the run being watched (the scissors, or the "Save a clip" key): with a loop set it is
 *     a clip of that section — watching it later plays the section on a loop. It is the same clip as
 *     any other (Statistics → Clips): the whole run's inputs, so it can be raced as a ghost too.
 *
 * The viewer's clock is in main.bundle.js: it asks rate() how fast to run and wrap() where to go
 * next, and its accessor gives a seek and a pause.
 */
(function () {
  'use strict';

  const SPEEDS = [0.1, 0.25, 0.5, 1, 2];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (s) => (window.PTRunsCore ? window.PTRunsCore.formatTime(Math.round(s * 1000)) : s.toFixed(3));
  const speedText = (v) => String(v) + '×';

  const CSS = `
/* in the viewer's bar: buttons like its own */
.time-bar-ui > .pt-rt { display:flex; flex-shrink:0; }
.time-bar-ui > .pt-rt > .button { display:flex; align-items:center; justify-content:center; min-width:62px; margin:0; padding:0 12px;
  font-size:24px; white-space:nowrap; }
.time-bar-ui > .pt-rt > .button > img { width:26px; height:26px; margin:0; }
.time-bar-ui > .pt-rt > .button.on { background-color:var(--button-hover-color); }
.time-bar-ui > .pt-rt > .button.slow { color:#ff5; }
/* the loop on the timeline */
.time-bar-ui .pt-rt-range { position:absolute; top:0; bottom:0; z-index:1; background-color:rgba(255, 255, 85, 0.22);
  border-left:2px solid #ff5; border-right:2px solid #ff5; box-sizing:border-box; pointer-events:none; }
.time-bar-ui .pt-rt-range.open { border-right:none; background-color:transparent; }
.time-bar-ui .pt-rt-range.off { opacity:0.45; }
`;

  const PTReplayTools = {
    viewer: null, speed: 1, a: null, b: null, loop: false, pending: null, ui: null, raf: 0,

    init() {
      const st = el('style'); st.id = 'pt-replaytools-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => this.onKey(e), true);
    },

    // ---------------------------------------------------------------- asked by the viewer's clock
    rate(viewer) { return viewer === this.viewer ? this.speed : 1; },
    wrap(viewer, t) {
      if (viewer !== this.viewer || !this.loop || this.a == null || this.b == null || this.b <= this.a) return t;
      return t >= this.b ? this.a : t;
    },

    info() { try { return this.viewer ? this.viewer.__ptReplay() : null; } catch { return null; } },
    now() { const i = this.info(); return i ? i.time : 0; },

    // ---------------------------------------------------------------- lifecycle (racehud.js forwards these)
    attach(viewer) {
      this.detach(this.viewer);
      this.viewer = viewer;
      this.speed = 1; this.a = null; this.b = null; this.loop = false;
      this.build();
      // a clip of a section: loop it from its start
      const p = this.pending;
      this.pending = null;
      if (p && p.range && Date.now() - p.at < 60000) {
        this.a = p.range.from / 1000; this.b = p.range.to / 1000; this.loop = true;
        const i = this.info();
        if (i && i.seek) i.seek(this.a);
      }
      const tick = () => { this.raf = requestAnimationFrame(tick); this.paint(); };
      this.raf = requestAnimationFrame(tick);
    },

    detach(viewer) {
      if (!this.viewer || (viewer && viewer !== this.viewer)) return;
      cancelAnimationFrame(this.raf);
      if (this.ui) { this.ui.group.remove(); this.ui.range.remove(); }
      this.ui = null;
      this.viewer = null;
      this.speed = 1;
    },

    build() {
      const i = this.info();
      const hud = i && i.hud && i.hud.element;
      const bar = hud && hud.querySelector('.time-bar-ui');
      const track = bar && bar.querySelector(':scope > .bar');
      if (!bar || !track) return;
      const group = el('div', 'pt-rt');
      const speed = el('button', 'button', '1×');
      speed.title = 'Playback speed (click for the next one). Keys: ' + this.keysText(['TweaksReplaySlower', 'TweaksReplayFaster', 'TweaksReplayNormal']);
      speed.addEventListener('click', (e) => { e.stopPropagation(); this.step(+1, true); });
      speed.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.step(-1, true); });
      const loop = el('button', 'button', 'A–B');
      loop.title = 'Loop a section: click once where it starts, again where it ends, again to stop. Keys: ' + this.keysText(['TweaksReplayLoopStart', 'TweaksReplayLoopEnd', 'TweaksReplayLoop']);
      loop.addEventListener('click', (e) => { e.stopPropagation(); this.cycleLoop(); });
      const clip = el('button', 'button');
      const img = el('img'); img.src = 'images/cut.svg'; clip.appendChild(img);
      clip.title = 'Save this run as a clip — the loop as a section, if one is set. Key: ' + this.keysText(['TweaksSaveClip']);
      clip.addEventListener('click', (e) => { e.stopPropagation(); this.saveClip(); });
      group.append(speed, loop, clip);
      bar.insertBefore(group, track);
      const inner = track.firstElementChild || track;
      if (getComputedStyle(inner).position === 'static') inner.style.position = 'relative';
      const range = el('div', 'pt-rt-range pt-hide');
      inner.appendChild(range);
      this.ui = { group, speed, loop, clip, range };
      this.paint();
    },

    keysText(names) {
      const K = window.PTKeys;
      return K ? names.map((n) => K.label(n)).join(' / ') : '';
    },

    /** Keeps the buttons and the marked section in step with what is set. */
    paint() {
      const u = this.ui;
      if (!u) return;
      const t = speedText(this.speed);
      if (u.speed.textContent !== t) u.speed.textContent = t;
      u.speed.classList.toggle('slow', this.speed !== 1);
      const label = this.a == null ? 'A–B' : this.b == null ? 'A–' : 'A–B';
      if (u.loop.textContent !== label) u.loop.textContent = label;
      u.loop.classList.toggle('on', this.a != null);
      const i = this.info();
      const total = i && i.duration ? i.duration : 0;
      if (this.a == null || !total) { u.range.classList.add('pt-hide'); return; }
      const left = Math.max(0, Math.min(1, this.a / total)), right = this.b == null ? left : Math.max(left, Math.min(1, this.b / total));
      u.range.classList.remove('pt-hide');
      u.range.classList.toggle('open', this.b == null);
      u.range.classList.toggle('off', this.b != null && !this.loop);
      u.range.style.left = (left * 100).toFixed(3) + '%';
      u.range.style.width = ((right - left) * 100).toFixed(3) + '%';
    },

    toast(text) { if (window.PTUI) window.PTUI.toast(text, 1800); },

    // ---------------------------------------------------------------- speed
    step(dir, wrapAround) {
      let k = SPEEDS.indexOf(this.speed);
      if (k < 0) k = SPEEDS.indexOf(1);
      k += dir;
      if (wrapAround) k = (k + SPEEDS.length) % SPEEDS.length;
      else k = Math.max(0, Math.min(SPEEDS.length - 1, k));
      this.setSpeed(SPEEDS[k]);
    },
    setSpeed(v) {
      if (v === this.speed) return;
      this.speed = v;
      this.paint();
      this.toast('Speed ' + speedText(v));
    },

    // ---------------------------------------------------------------- the loop
    markStart() {
      const t = this.now();
      this.a = t;
      if (this.b != null && this.b <= t) this.b = null;
      this.loop = this.b != null;
      this.paint();
      this.toast('Loop from ' + fmt(t) + (this.b != null ? ' to ' + fmt(this.b) : ''));
    },
    markEnd() {
      const t = this.now();
      if (this.a == null || this.a >= t) this.a = 0;          // no start before here: from the beginning
      if (t <= this.a) { this.toast('The loop has to end after it starts'); return; }
      this.b = t;
      this.loop = true;
      this.paint();
      this.toast('Looping ' + fmt(this.a) + ' – ' + fmt(this.b));
      const i = this.info();
      if (i && i.seek) i.seek(this.a);
    },
    toggleLoop() {
      if (this.a == null || this.b == null) {
        const i = this.info();
        this.a = this.a ?? 0; this.b = i && i.duration ? i.duration : null;
        if (this.b == null || this.b <= this.a) return;
      }
      this.loop = !this.loop;
      this.paint();
      this.toast(this.loop ? 'Looping ' + fmt(this.a) + ' – ' + fmt(this.b) : 'Loop off');
    },
    /** The button: start here, end here, off. */
    cycleLoop() {
      if (this.a == null) this.markStart();
      else if (this.b == null) this.markEnd();
      else { this.a = null; this.b = null; this.loop = false; this.paint(); this.toast('Loop off'); }
    },

    // ---------------------------------------------------------------- a clip of what is being watched
    saveClip() {
      const R = window.PTRuns, i = this.info();
      if (!R || !i || !i.cars || !i.cars.length) return;
      const e = i.cars[i.focus];
      const total = e.settings && e.settings.time ? e.settings.time.numberOfFrames : 0;
      let loaded = 0;
      try { loaded = e.replay.getLastFrame().numberOfFrames; } catch { }
      if (loaded < total) { this.toast('The run is still loading — try again in a moment'); return; }
      const meta = i.meta || {};
      const md = meta.metadata || {}, td = meta.trackData;
      let id = null;
      try { id = td ? td.getId() : null; } catch { }
      const type = meta.type || 'custom';
      const name = md.name || 'Track';
      const splits = (e.checkpointTimes || []).map((t) => t.numberOfFrames);
      const finished = e.finishSpeed != null;
      if (finished) splits.push(total);
      const clip = {
        track: { id: id || ('custom:' + name), name, author: md.author ?? null, type, key: R.keyForTrack(id, type, name) },
        run: { frames: total, finished, splits, date: Date.now(), maxSpeedKmh: 0 },
        recording: e.settings.recording.serialize(),
        car: { style: e.settings.carStyle && e.settings.carStyle.serialize ? e.settings.carStyle.serialize() : null, nickname: e.settings.nickname || 'Anonymous' },
      };
      if (this.a != null && this.b != null && this.b > this.a) clip.range = { from: Math.round(this.a * 1000), to: Math.round(this.b * 1000) };
      if (type !== 'official' && td) {
        try {
          const code = td.toExportString({ name, author: md.author ?? null, lastModified: md.lastModified || new Date() });
          if (typeof code === 'string' && code.length < 2e6) clip.trackCode = code;
        } catch { }
      }
      const ok = R.storeClip(clip, false);
      this.toast(!ok ? 'Could not save the clip.' : clip.range
        ? 'Clip saved: ' + name + ', ' + fmt(this.a) + ' – ' + fmt(this.b) + ' (Statistics → Clips)'
        : 'Clip saved: ' + window.PTRunsCore.clipLabel(clip) + ' (Statistics → Clips)');
    },

    // ---------------------------------------------------------------- keys
    onKey(e) {
      if (!this.viewer || e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const K = window.PTKeys;
      if (!K) return;
      const act = [['TweaksReplaySlower', () => this.step(-1, false)], ['TweaksReplayFaster', () => this.step(+1, false)],
        ['TweaksReplayNormal', () => this.setSpeed(1)], ['TweaksReplayLoopStart', () => this.markStart()],
        ['TweaksReplayLoopEnd', () => this.markEnd()], ['TweaksReplayLoop', () => this.toggleLoop()]]
        .find(([name]) => K.is(e, name));
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act[1]();
    },
  };

  window.PTReplayTools = PTReplayTools;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTReplayTools.init());
  else PTReplayTools.init();
})();
