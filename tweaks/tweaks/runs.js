/*
 * PolyTrack Tweaks — statistics and clips.
 *
 *  - Watches every attempt through the race class hooks (window.PTRuns.raceStarted/raceEnded plus the
 *    read-only __ptRun() accessor) and folds it into the stored statistics.
 *  - Saves runs as clips: the game's own input recording, which is tiny and replays exactly. Clips
 *    can be copied as a code, written to a .ptclip file, and raced against as a ghost.
 *  - All decisions about data live in runs-core.js; this file is the game glue and the screens.
 *  - The track page: Statistics and Notes buttons, and a summary of your last session on that track
 *    (attempts, finishes, your best then against your personal best, time spent) when you come back
 *    to it from a race. Settings → Tweaks → Session summary turns the summary off.
 */
(function () {
  'use strict';
  const Core = window.PTRunsCore;
  if (!Core) { console.error('[runs] runs-core.js not loaded'); return; }

  const STATS_KEY = 'pt-stats-v1';
  const CLIPS_KEY = 'pt-clips-v1';
  const PREFS_KEY = 'pt-runs-prefs-v1';
  const NOTES_KEY = 'pt-notes-v1';
  const SAVE_DEBOUNCE = 4000;
  const SESSION_SHOWN_FOR = 30 * 60 * 1000;   // the last session stays on its track's page this long
  const MIN_CLIP_MS = 700;          // ignore instant restarts when recording every run
  const MAX_CLIP_BYTES = 4 << 20;

  const log = (...a) => console.log('[runs]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = Core.formatTime, dur = Core.formatDuration;
  const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + '%';
  const dateStr = (ts) => new Date(ts).toLocaleDateString();
  const ago = (ts) => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    let unit = [60, 'minute'];
    for (const u of [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']]) if (s >= u[0]) unit = u;
    const n = Math.floor(s / unit[0]);
    return n + ' ' + unit[1] + (n === 1 ? '' : 's') + ' ago';
  };

  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { log('could not read ' + key, e); return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { log('could not write ' + key + ' (storage full?)', e); return false; }
  }

  const pako = () => (window.__ptPako && window.__ptPako.Ay ? window.__ptPako.Ay : null);
  const codec = {
    deflate(bytes) {
      const z = pako();
      if (!z) return bytes;
      const d = new z.Deflate({ level: 6 });
      d.push(bytes, true);
      if (d.err) throw new Error('compression failed');
      return d.result;
    },
    inflate(bytes) {
      const z = pako();
      if (!z) return bytes;
      const inf = new z.Inflate();
      inf.push(bytes, true);
      if (inf.err) throw new Error('this clip could not be read');
      return inf.result;
    },
  };

  const refs = () => {
    const R = window.__ptRaceClass;
    try { return R && R.__ptRefs ? R.__ptRefs() : null; } catch { return null; }
  };

  // ============================================================================ charts =========

  // the colours and lettering of the game's own Graphs panel (its first series is hsl(210, 100%, 65%))
  const CHART = { grid: 'rgba(0, 0, 0, 0.4)', text: '#fff', bar: 'hsl(210, 100%, 65%)', accent: 'hsl(210, 100%, 65%)', warn: '#f55' };

  function prepare(canvas, height) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '12px ForcedSquare, Arial, sans-serif';
    return { ctx, width, height };
  }

  function barChart(canvas, values, opts = {}) {
    const { ctx, width, height } = prepare(canvas, opts.height || 160);
    const pad = { l: 44, r: 8, t: 10, b: 22 };
    const top = Math.max(1, ...values.map((v) => v.value));
    const step = opts.formatY ? top / 3 : Math.ceil(top / 3);    // counts get whole-number gridlines
    const max = step * 3;
    const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    ctx.strokeStyle = CHART.grid; ctx.fillStyle = CHART.text;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + plotH * (i / 3);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
      const label = opts.formatY ? opts.formatY(max * (1 - i / 3)) : step * (3 - i);
      ctx.fillText(String(label), 4, y + 4);
    }
    const bw = plotW / Math.max(1, values.length);
    values.forEach((v, i) => {
      const h = (v.value / max) * plotH;
      ctx.fillStyle = v.color || opts.color || CHART.bar;
      ctx.fillRect(pad.l + i * bw + bw * 0.15, pad.t + plotH - h, Math.max(1, bw * 0.7), h);
    });
    ctx.fillStyle = CHART.text;
    values.forEach((v, i) => {
      if (!v.label) return;
      const x = pad.l + i * bw + bw / 2;
      const w = ctx.measureText(v.label).width;
      if (i === 0 || i === values.length - 1 || values.length <= 12) ctx.fillText(v.label, Math.min(width - w - 2, Math.max(pad.l, x - w / 2)), height - 6);
    });
  }

  function lineChart(canvas, points, opts = {}) {
    const { ctx, width, height } = prepare(canvas, opts.height || 180);
    if (!points.length) return;
    const pad = { l: 60, r: 10, t: 12, b: 22 };
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX || 1, spanY = (maxY - minY) || Math.max(1, maxY * 0.1);
    const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const px = (x) => pad.l + ((x - minX) / spanX) * plotW;
    const py = (y) => pad.t + plotH - ((y - minY) / spanY) * plotH;
    ctx.strokeStyle = CHART.grid; ctx.fillStyle = CHART.text;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + plotH * (i / 3), value = minY + spanY * (1 - i / 3);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
      ctx.fillText(opts.formatY ? opts.formatY(value) : String(Math.round(value)), 4, y + 4);
    }
    ctx.strokeStyle = opts.color || CHART.accent; ctx.lineWidth = 2; ctx.beginPath();
    points.forEach((p, i) => { const X = px(p.x), Y = py(p.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.stroke();
    ctx.fillStyle = opts.color || CHART.accent;
    points.forEach((p) => { ctx.beginPath(); ctx.arc(px(p.x), py(p.y), 3, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = CHART.text;
    if (opts.formatX) {
      const first = opts.formatX(minX), last = opts.formatX(maxX);
      ctx.fillText(first, pad.l, height - 6);
      ctx.fillText(last, width - pad.r - ctx.measureText(last).width, height - 6);
    }
  }

  /** Top-down view of the track with reset positions burned in. */
  function heatmap(canvas, cells, footprint, opts = {}) {
    const { ctx, width, height } = prepare(canvas, opts.height || 300);
    const keys = Object.keys(cells);
    if (!keys.length && (!footprint || !footprint.length)) {
      ctx.fillStyle = CHART.text; ctx.fillText('No resets recorded yet.', 10, 24); return;
    }
    const pts = [];
    for (const k of keys) { const [x, z] = k.split(',').map(Number); pts.push({ x, z, n: cells[k] }); }
    const foot = (footprint || []).map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; });
    const all = pts.concat(foot);
    const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x));
    const minZ = Math.min(...all.map((p) => p.z)), maxZ = Math.max(...all.map((p) => p.z));
    const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
    const scale = Math.min((width - 20) / spanX, (height - 20) / spanZ);
    const ox = (width - spanX * scale) / 2 - minX * scale;
    const oz = (height - spanZ * scale) / 2 - minZ * scale;
    const size = Math.max(2, scale * Core.GRID);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (const p of foot) ctx.fillRect(ox + p.x * scale - size / 2, oz + p.z * scale - size / 2, size, size);
    const max = Math.max(...pts.map((p) => p.n), 1);
    for (const p of pts) {
      const heat = p.n / max;
      ctx.fillStyle = 'rgba(' + Math.round(255) + ',' + Math.round(200 - 160 * heat) + ',' + Math.round(80 - 60 * heat) + ',' + (0.35 + 0.65 * heat) + ')';
      const r = size * (0.8 + heat * 1.6);
      ctx.beginPath(); ctx.arc(ox + p.x * scale, oz + p.z * scale, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = CHART.text;
    ctx.fillText('brighter = more resets', 8, height - 8);
  }

  // ============================================================================ controller ====

  const CSS = `
.pt-runs-overlay canvas { display:block; width:100%; }
.track-info-ui .pt-track-tools { display:flex; justify-content:center; gap:10px; margin:-6px 12px 16px; }
.track-info-ui .pt-track-tools > .button { margin:0; padding:6px 18px; font-size:22px; white-space:nowrap; }
.track-info-ui .pt-track-tools > .button > img.button-icon { width:24px; height:24px; margin:-4px 2px 0 -4px; }
.track-info-ui .pt-track-tools > .button > small { margin-left:8px; font-size:15px; opacity:0.6; }
.track-info-ui .pt-track-tools > .pt-track-notes.has > small { opacity:1; color:#ff5; }

/* your last session on this track, under the personal best */
.track-info-ui .pt-session-card { position:relative; margin:-4px 16px 16px; padding:8px 12px 10px; text-align:left; color:var(--text-color);
  background-color:var(--surface-tertiary-color); animation:pt-fade 0.16s ease-out; }
.pt-session-card .head { display:flex; align-items:baseline; gap:10px; font-size:18px; opacity:0.75; }
.pt-session-card .head > .grow { flex:1; }
.pt-session-card .head > button { padding:0 6px; font-size:16px; line-height:1.2; background:none; border:none; color:var(--text-color); cursor:pointer; opacity:0.8; }
.pt-session-card .head > button:hover { opacity:1; }
.pt-session-card .line { margin-top:4px; font-size:18px; }
.pt-session-card .big { font-size:22px; }
.pt-session-card .ahead { color:#5f5; }
.pt-session-card .behind { color:#f55; }
.pt-session-card .dim { opacity:0.6; }

/* notes */
.pt-notes-overlay textarea.pt-notes-text { display:block; min-height:340px; padding:12px 14px; font-size:20px; line-height:1.45;
  word-break:normal; overflow-wrap:anywhere; }
`;

  const PTRuns = {
    stats: null, clips: null, prefs: null, notes: null,
    race: null, info: null, car: null, attempt: null, lastRun: null, resetCounter: -1,
    session: null, lastSession: null,
    pendingGhosts: [], overlay: null, tab: 'overview', selectedTrack: null, saveTimer: 0, loopId: 0, lastFrameAt: 0,

    init() {
      this.stats = loadJSON(STATS_KEY, null) || Core.emptyStats();
      this.clips = loadJSON(CLIPS_KEY, null) || [];
      this.notes = loadJSON(NOTES_KEY, null) || {};
      this.prefs = Object.assign({ recordEvery: false, clipRecords: true }, loadJSON(PREFS_KEY, {}));
      this.stats.totals.sessions = (this.stats.totals.sessions || 0) + 1;
      this.injectCss();
      window.addEventListener('keydown', (e) => this.onKey(e), true);
      let odd = false;
      const tick = () => { this.loopId = requestAnimationFrame(tick); odd = !odd; if (odd) this.sample(); };
      this.loopId = requestAnimationFrame(tick);
      setInterval(() => { this.stats.totals.appMs += 10000; this.queueSave(); }, 10000);
      log('statistics ready:', this.stats.totals.attempts, 'attempts,', this.clips.length, 'clips');
    },

    injectCss() {
      if (document.getElementById('pt-runs-css')) return;
      const st = document.createElement('style');
      st.id = 'pt-runs-css'; st.textContent = CSS;
      document.head.appendChild(st);
    },

    queueSave() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => { saveJSON(STATS_KEY, this.stats); }, SAVE_DEBOUNCE);
    },
    saveNow() { clearTimeout(this.saveTimer); saveJSON(STATS_KEY, this.stats); },
    saveClips() { saveJSON(CLIPS_KEY, this.clips); },
    savePrefs() { saveJSON(PREFS_KEY, this.prefs); },

    // ------------------------------------------------------------------ race lifecycle
    raceStarted(race) {
      try {
        this.race = race;
        this.info = race.__ptRun();
        this.car = null; this.attempt = null; this.resetCounter = -1;
        this.track = this.identify(this.info);
        const rec = this.stats.tracks[this.track.key];
        // a session is one visit to a track: restarts are part of it, leaving ends it
        this.session = { key: this.track.key, id: this.track.id, name: this.track.name, type: this.track.type,
          t0: performance.now(), attempts: 0, finishes: 0, best: null, editor: false,
          pbBefore: this.gameBest(this.track.id) ?? (rec ? rec.bestFrames : null) };
        this.armPendingGhosts();
      } catch (e) { console.error('[runs] race start', e); }
    },

    raceEnded() {
      try { this.endAttempt(false); } catch (e) { console.error('[runs] race end', e); }
      try { this.endSession(); } catch (e) { console.error('[runs] session end', e); }
      this.race = null; this.info = null; this.car = null; this.attempt = null;
      this.saveNow();
    },

    /** Your personal best on a track as the game keeps it (it predates these statistics). */
    gameBest(id) {
      try {
        const R = window.__ptRecords, P = window.__ptProfiles;
        const t = R && P && id ? R.getRecordTime(P.profileSlot, id) : null;
        return t ? t.numberOfFrames : null;
      } catch { return null; }
    },

    /** The track has been left: what that visit came to, for its page and the recently played list. */
    endSession() {
      const s = this.session;
      this.session = null;
      if (!s || s.editor || (window.PTPractice && window.PTPractice.race && window.PTPractice.race === this.race)) return;
      if (window.PTTrackList && window.PTTrackList.notePlayed) window.PTTrackList.notePlayed(s.key, s.type);
      if (!s.attempts) return;
      s.ms = performance.now() - s.t0;
      s.endedAt = Date.now();
      s.pbAfter = this.gameBest(s.id) ?? (this.stats.tracks[s.key] ? this.stats.tracks[s.key].bestFrames : null);
      this.lastSession = s;
    },

    /** Custom tracks change id whenever they are edited, so group those by name instead. */
    identify(info) {
      let id = null, name = 'Unknown track', author = null, type = (info && info.type) || 'custom';
      try { id = info.trackData.getId(); } catch {}
      try { name = info.metadata.name || name; author = info.metadata.author ?? null; } catch {}
      const key = type === 'custom' ? 'custom:' + name : (id || 'custom:' + name);
      return { key, id, name, author, type };
    },

    footprintOf(trackData) {
      const seen = new Set();
      try {
        trackData.forEachPart((x, y, z) => {
          if (seen.size >= Core.LIMITS.footprint) return;
          seen.add(Core.cell(x * 5, z * 5));
        });
      } catch {}
      return [...seen];
    },

    // ------------------------------------------------------------------ sampling
    sample() {
      if (!this.race) return;
      // the editor's test drive is a race too, but not a session on a track
      if (this.session && !this.session.editor && window.PTPractice && window.PTPractice.race === this.race) this.session.editor = true;
      let info;
      try { info = this.race.__ptRun(); } catch { return; }
      const car = info.car;
      if (!car) return;
      let st;
      try { st = car.getCarState(); } catch { return; }

      if (car !== this.car || info.resetCounter !== this.resetCounter) {
        this.endAttempt(false);
        this.car = car;
        this.resetCounter = info.resetCounter;
        this.attempt = {
          startedAt: Date.now(), frames: 0, splits: [], cp: 0, finished: false, recorded: false,
          maxSpeedKmh: 0, lastPosition: null, distance: 0, started: false, exact: [],
        };
        // the exact millisecond of each checkpoint: this sampling runs every other frame, the car's
        // own checkpoint event fires on the simulated frame that crossed it
        const att = this.attempt;
        try { car.addCheckpointCallback((i) => { if (this.attempt === att) att.exact[i] = car.getTime().numberOfFrames; }); } catch {}
        if (window.PTPractice && window.PTPractice.noteAttempt) window.PTPractice.noteAttempt();
      }
      const a = this.attempt;
      if (!a) return;
      a.frames = st.frames;
      if (st.hasStarted) a.started = true;
      if (st.speedKmh > a.maxSpeedKmh) a.maxSpeedKmh = st.speedKmh;
      if (st.position) {
        if (a.lastPosition) {
          const dx = st.position.x - a.lastPosition.x, dy = st.position.y - a.lastPosition.y, dz = st.position.z - a.lastPosition.z;
          a.distance += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        a.lastPosition = { x: st.position.x, y: st.position.y, z: st.position.z };
      }
      while (st.nextCheckpointIndex > a.cp) {
        a.splits.push(a.exact[a.cp] != null ? a.exact[a.cp] : st.frames);
        a.cp++;
      }
      if (st.finishFrames != null && !a.finished) {
        a.finished = true;
        a.finishFrames = st.finishFrames;
        a.splits.push(st.finishFrames);
        this.endAttempt(true);
      }
    },

    /** Closes the current attempt: folds it into the statistics and keeps its recording for clipping. */
    endAttempt(finished) {
      const a = this.attempt;
      if (!a || a.recorded || !this.track) return;
      if (!a.started || a.frames < 200) { if (!finished) this.attempt = null; return; }
      // a run driven with the editor's practice tools is not a real attempt: slowed time or a
      // restored savestate makes both the time and the recording meaningless
      if (window.PTPractice && window.PTPractice.dirty && window.PTPractice.dirty()) {
        a.recorded = true;
        if (!finished) this.attempt = null;
        return;
      }
      a.recorded = true;
      const t = this.track;
      const track = this.stats.tracks[t.key];
      const previousBest = track ? track.bestFrames : null;
      const attempt = {
        trackId: t.key, trackName: t.name, trackType: t.type,
        startedAt: a.startedAt, drivingMs: a.finished ? a.finishFrames : a.frames,
        frames: a.finished ? a.finishFrames : a.frames,
        finished: a.finished, splits: a.splits.slice(0, 64),
        resetPosition: a.finished ? null : a.lastPosition,
        checkpointIndex: a.cp, maxSpeedKmh: a.maxSpeedKmh, distance: a.distance,
        footprint: track && track.footprint ? null : this.footprintOf(this.info.trackData),
      };
      Core.recordAttempt(this.stats, attempt);
      this.queueSave();
      const s = this.session;
      if (s) {
        s.attempts++;
        if (a.finished) { s.finishes++; if (s.best == null || attempt.frames < s.best) s.best = attempt.frames; }
      }
      // your own leaderboard entry just changed, so a profile compiled earlier is stale
      if (a.finished && (previousBest == null || attempt.frames < previousBest)
        && window.PTProfile && window.PTProfile.invalidateSelf) window.PTProfile.invalidateSelf();

      // keep the run so it can be clipped, and clip it now if every run is being recorded
      const recording = (() => { try { return this.car.getRecording(); } catch { return null; } })();
      if (recording) {
        this.lastRun = { recording, track: t, frames: attempt.frames, finished: a.finished, splits: attempt.splits, maxSpeedKmh: a.maxSpeedKmh, at: Date.now(), trackData: this.info.trackData };
        const isRecord = a.finished && (previousBest == null || attempt.frames < previousBest);
        if (this.prefs.recordEvery && attempt.drivingMs >= MIN_CLIP_MS) this.storeClip(this.buildClip(this.lastRun), true);
        else if (this.prefs.clipRecords && isRecord) {
          const clip = this.buildClip(this.lastRun);
          if (this.storeClip(clip, true, 'record')) {
            // one record clip per track: the old one is no longer your best
            const keep = this.clips.find((c) => c.kind === 'record' && c.trackKey === t.key);
            this.clips = this.clips.filter((c) => c.kind !== 'record' || c.trackKey !== t.key || c === keep);
            this.saveClips();
            this.toast('New record on "' + t.name + '" — clip saved (' + fmt(attempt.frames) + ')');
          }
        }
      }
      if (!finished) this.attempt = null;
    },

    // ------------------------------------------------------------------ clips
    buildClip(run) {
      const car = (() => {
        try {
          const style = this.car && this.car.getCarStyle ? this.car.getCarStyle() : null;
          return { style: style ? style.serialize() : null, nickname: this.nickname() };
        } catch { return { style: null, nickname: this.nickname() }; }
      })();
      const clip = {
        track: { id: run.track.id, name: run.track.name, author: run.track.author, type: run.track.type, key: run.track.key },
        run: { frames: run.frames, finished: run.finished, splits: run.splits, date: run.at, maxSpeedKmh: Math.round(run.maxSpeedKmh) },
        recording: run.recording.serialize(),
        car,
      };
      // a track the other player may not have: carry the track itself so the clip stands alone
      if (run.track.type !== 'official' && run.trackData) {
        try {
          const code = run.trackData.toExportString({ name: run.track.name, author: run.track.author, lastModified: new Date(run.at) });
          if (typeof code === 'string' && code.length < 2e6) clip.trackCode = code;
        } catch {}
      }
      return clip;
    },

    myProfile() {
      try { return window.__ptProfiles ? window.__ptProfiles.getCurrentUserProfile() : null; } catch { return null; }
    },
    nickname() { const p = this.myProfile(); return (p && p.nickname) || 'Anonymous'; },

    /** The key that saves a clip: the run in progress if you are driving, otherwise the last one. */
    saveClipNow() {
      if (window.PTReplayTools && window.PTReplayTools.viewer) return window.PTReplayTools.saveClip();
      let run = null;
      const a = this.attempt;
      if (a && a.started && !a.recorded && this.car) {
        try { run = { recording: this.car.getRecording(), track: this.track, frames: a.frames, finished: false, splits: a.splits.slice(), maxSpeedKmh: a.maxSpeedKmh, at: Date.now(), trackData: this.info.trackData }; } catch {}
      }
      if (!run) run = this.lastRun;
      if (!run || !run.recording) return this.toast('Nothing to clip yet — drive a run first.');
      let clip;
      try { clip = this.buildClip(run); } catch (e) { console.error(e); return this.toast('Could not build that clip.'); }
      const stored = this.storeClip(clip, false);
      this.toast(stored ? 'Clip saved: ' + Core.clipLabel(clip) : 'Could not save the clip.');
    },

    storeClip(clip, quiet, kind) {
      let code;
      try { code = Core.encodeClip(clip, codec); } catch (e) { console.error('[runs] clip encode', e); return false; }
      if (code.length > MAX_CLIP_BYTES) { if (!quiet) this.toast('That run is too long to store as a clip.'); return false; }
      const entry = {
        id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        savedAt: Date.now(), label: Core.clipLabel(clip), track: clip.track.name, trackKey: clip.track.key || clip.track.id,
        frames: clip.run.frames, finished: clip.run.finished, auto: !!quiet, kind: kind || null, code,
        range: clip.range && clip.range.to > clip.range.from ? { from: clip.range.from, to: clip.range.to } : null,
      };
      this.clips.unshift(entry);
      while (this.clips.length > Core.LIMITS.clips) this.clips.pop();
      this.saveClips();
      if (this.overlay && this.tab === 'clips') this.render();
      return true;
    },

    importClip(text) {
      let clip;
      try { clip = Core.decodeClip(text, codec); } catch (e) { return this.toast(e.message || 'That is not a clip code.'); }
      const ok = this.storeClip(clip, false);
      if (ok) this.toast('Imported: ' + Core.clipLabel(clip));
      return ok;
    },

    /** Arms a clip to appear as a ghost the next time that track is started. */
    armGhost(entry) {
      let clip;
      try { clip = Core.decodeClip(entry.code, codec); } catch (e) { return this.toast('This clip could not be read.'); }
      this.pendingGhosts = this.pendingGhosts.filter((g) => g.key !== (clip.track.key || clip.track.id));
      this.pendingGhosts.push({ key: clip.track.key || clip.track.id, clip, clipId: entry.id });
      if (this.race && this.track && this.track.key === (clip.track.key || clip.track.id)) this.armPendingGhosts();
      if (this.overlay && this.tab === 'clips') this.render();
      this.toast('Armed as a ghost on "' + clip.track.name + '" — start that track to race it. (Ghost cars must be on in Settings.)');
    },

    /**
     * Called by the game as a race is created: hands back the ghost list with any armed clips added.
     * Ghost cars are built inside the constructor, so this is the only moment a clip can join a race.
     */
    ghostsFor(trackData, type, metadata, base) {
      const list = Array.isArray(base) ? base.slice() : [];
      try {
        if (!this.pendingGhosts.length) return list;
        const key = this.identify({ trackData, type, metadata }).key;
        for (const pending of this.pendingGhosts) {
          if (pending.key !== key) continue;
          const settings = this.ghostSettings(pending.clip);
          if (settings) { list.push(settings); pending.preloaded = true; log('clip racing as a ghost on', pending.clip.track.name); }
        }
      } catch (e) { console.error('[runs] ghosts', e); }
      return list;
    },

    ghostSettings(clip) {
      const r = refs();
      if (!r || !r.Recording || !r.Time) return null;
      try {
        const recording = r.Recording.deserialize(clip.recording);
        if (!recording) throw new Error('recording could not be read');
        return {
          recording, time: new r.Time(clip.run.frames),
          carStyle: this.carStyleFrom(clip.car && clip.car.style),
          nickname: (clip.car && clip.car.nickname) || 'Clip',
          isSelf: false,
        };
      } catch (e) { log('ghost could not be prepared', e); return null; }
    },

    /** Opens the game's own replay viewer with this clip playing. */
    async watchClip(entry) {
      let clip;
      try { clip = Core.decodeClip(entry.code, codec); } catch (e) { return this.toast('This clip could not be read.'); }
      const watch = window.__ptWatchReplay;
      if (typeof watch !== 'function') return this.toast('Replays are not available in this build.');
      const settings = this.ghostSettings(clip);
      if (!settings) return this.toast('This clip could not be prepared for playback.');
      this.toast('Loading "' + clip.track.name + '"…');
      // a section is played on a loop from its start (replaytools.js picks this up as the viewer opens)
      if (window.PTReplayTools) window.PTReplayTools.pending = clip.range ? { range: clip.range, at: Date.now() } : null;
      let track;
      try { track = await this.loadTrackFor(clip); } catch (e) { console.error('[runs] watch', e); }
      if (!track || !track.trackData) return this.toast('You do not have "' + clip.track.name + '", and this clip does not carry it.');
      this.close();
      try { watch(track.metadata, track.trackData, track.type, [settings]); }
      catch (e) { console.error('[runs] watch', e); this.toast('The replay viewer could not be opened.'); }
    },

    /** The clip's track: from your own library if you have it, otherwise from the clip itself. */
    async loadTrackFor(clip) {
      const library = window.__ptTracks;
      if (library && typeof library.forEachTrack === 'function') {
        const entries = [];
        library.forEachTrack((id, metadata, type, environment, load) => entries.push({ id, metadata, type, load }));
        const hit = (clip.track.id && entries.find((e) => e.id === clip.track.id))
          || entries.find((e) => e.metadata && e.metadata.name === clip.track.name);
        if (hit && typeof hit.load === 'function') {
          const loaded = await hit.load();
          if (loaded && loaded.trackData) return { metadata: loaded.trackMetadata || hit.metadata, trackData: loaded.trackData, type: hit.type };
        }
      }
      const r = refs();
      if (clip.trackCode && r && r.TrackData && typeof r.TrackData.fromExportString === 'function') {
        const parsed = r.TrackData.fromExportString(clip.trackCode);
        if (parsed && parsed.trackData) return { metadata: parsed.trackMetadata, trackData: parsed.trackData, type: clip.track.type === 'official' ? 'custom' : (clip.track.type || 'custom') };
      }
      return null;
    },

    disarmGhost(entry) {
      this.pendingGhosts = this.pendingGhosts.filter((g) => g.clipId !== entry.id);
      this.render();
      this.toast('Ghost removed.');
    },

    armPendingGhosts() {
      if (!this.race || !this.info || !this.track || !this.pendingGhosts.length) return;
      const r = refs();
      if (!r || !r.Recording || !r.Time) return;
      for (const pending of this.pendingGhosts) {
        if (pending.key !== this.track.key || pending.race === this.race) continue;
        if (pending.preloaded) { pending.preloaded = false; pending.race = this.race; continue; }  // already in the list the race was built with
        const settings = this.ghostSettings(pending.clip);
        if (!settings) continue;
        pending.race = this.race;
        this.info.ghosts.push({ car: null, carId: null, hasEnded: false, loadedFrames: 0, maxFrames: 0, settings, replay: null, checkpoints: [], finishSpeedKmh: null });
        log('clip added to the running race; it appears after the next restart');
      }
    },

    carStyleFrom(serialized) {
      const p = this.myProfile();
      const mine = p && p.carStyle;
      if (!mine) return null;
      try { return serialized ? mine.constructor.deserializeSafe(serialized) : mine; } catch { return mine; }
    },

    // ------------------------------------------------------------------ input + menu
    onKey(e) {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const K = window.PTKeys;
      if (K && K.is(e, 'TweaksSaveClip')) { e.preventDefault(); this.saveClipNow(); return; }
      if (K && K.is(e, 'TweaksStatistics')) { e.preventDefault(); this.toggle(); return; }
      if (e.code === 'Escape' && this.page && this.page.open) { e.preventDefault(); e.stopPropagation(); this.back(); }
    },

    toast(text) {
      if (window.PTUI) window.PTUI.toast(text);
      else log(text);
    },

    // ------------------------------------------------------------------ screen
    open(tab) {
      this.buildOverlay();
      if (tab) { this.tab = tab; this.selectedTrack = null; }
      this.fromTrackPage = false;
      this.page.show();
      this.render();
    },

    /**
     * Opened from the main menu: the menu hides itself and hands us the screen, which is what every
     * other main-menu button does. `hooks.show` puts the menu back when we close.
     */
    openScreen(hooks) {
      this.buildOverlay();
      this.menuHooks = hooks || null;
      try { if (hooks && hooks.hide) hooks.hide(); } catch (e) { console.error('[runs] menu hide', e); }
      this.open();
    },

    close() {
      if (this.page) this.page.hide();
      const hooks = this.menuHooks;
      this.menuHooks = null;
      if (hooks && hooks.show) { try { hooks.show(); } catch (e) { console.error('[runs] menu show', e); } }
      this.saveNow();
    },

    /** Back (and Escape) go up one level: from a track to the list of tracks, otherwise out. */
    back() {
      if (this.tab === 'tracks' && this.selectedTrack && !this.fromTrackPage) { this.selectedTrack = null; this.render(); return; }
      this.close();
    },
    toggle() { if (!this.page || !this.page.open) this.open(); else this.close(); },

    /** Straight to one track's page of the Statistics screen; Back returns to wherever it came from. */
    openTrack(key) {
      this.buildOverlay();
      this.tab = 'tracks';
      this.selectedTrack = key;
      this.page.show();
      this.fromTrackPage = true;
      this.render();
    },

    /** The statistics key the game's track page stands for (custom tracks go by name, as attempts do). */
    keyForTrack(id, category, name) { return category === 'custom' ? 'custom:' + name : (id || 'custom:' + name); },

    /** The track page (main.bundle.js) asks for this under Personal best. */
    trackPageButton(container, { id, category, name }) {
      try {
        const key = this.keyForTrack(id, category, name);
        const rec = this.stats && this.stats.tracks[key];
        const row = el('div', 'pt-track-tools');
        const b = el('button', 'button pt-track-stats');
        const icon = el('img', 'button-icon');
        icon.src = 'images/graph.svg';
        b.append(icon, ' Statistics');
        b.appendChild(el('small', null, rec ? rec.attempts + (rec.attempts === 1 ? ' attempt' : ' attempts') : 'not driven yet'));
        // like the game's Watch button: there but greyed out until there is something to show
        b.disabled = !rec;
        b.title = rec ? 'Your best times between checkpoints, and everything else recorded on this track' : 'Drive this track once and its statistics appear here';
        b.addEventListener('click', () => { if (this.stats.tracks[key]) this.openTrack(key); });
        row.appendChild(b);
        const notes = el('button', 'button pt-track-notes');
        const nicon = el('img', 'button-icon');
        nicon.src = 'images/list.svg';
        notes.append(nicon, ' Notes');
        const note = this.noteFor(key);
        notes.appendChild(el('small', null, note ? '●' : ''));
        notes.classList.toggle('has', !!note);
        notes.title = note ? note.slice(0, 200) : 'Your own notes on this track: lines, tricks, what to try next';
        notes.addEventListener('click', () => this.openNotes(key, name));
        row.appendChild(notes);
        container.appendChild(row);
        if (window.PTTrackList) window.PTTrackList.trackPageStar(container, key);
        this.sessionCard(container, key);
      } catch (e) { console.error('[runs] track page button', e); }
    },

    // ------------------------------------------------------------------ your last session on a track
    sessionSummaryOn() {
      try {
        const E = window.__ptSettingEnum, S = window.__ptSettingsMgr;
        return !(E && S) || S.getSetting(E.TweaksSessionSummary) !== 'false';
      } catch { return true; }
    },

    sessionCard(container, key) {
      const s = this.lastSession;
      if (!s || s.key !== key || s.dismissed || Date.now() - s.endedAt > SESSION_SHOWN_FOR || !this.sessionSummaryOn()) return;
      const card = el('div', 'pt-session-card');
      const head = el('div', 'head');
      head.appendChild(el('span', null, 'Last session'));
      head.appendChild(el('span', 'grow'));
      head.appendChild(el('span', 'dim', dur(s.ms)));
      const close = el('button', null, '✕');
      close.title = 'Hide';
      close.addEventListener('click', () => { s.dismissed = true; card.remove(); });
      head.appendChild(close);
      card.appendChild(head);
      card.appendChild(el('div', 'line', s.attempts + (s.attempts === 1 ? ' attempt' : ' attempts') + ' · '
        + s.finishes + (s.finishes === 1 ? ' finish' : ' finishes')));
      const best = el('div', 'line');
      if (s.best == null) best.textContent = 'No finish this time.';
      else {
        best.append('Best ', el('span', 'big', fmt(s.best)), ' ');
        const was = s.pbBefore;
        if (was == null) best.appendChild(el('span', 'ahead', 'your first finish'));
        else if (s.best < was) best.appendChild(el('span', 'ahead', 'new personal best, −' + fmt(was - s.best)));
        else if (s.best === was) best.appendChild(el('span', null, 'equals your personal best'));
        else best.appendChild(el('span', 'behind', '+' + fmt(s.best - was) + ' on your personal best'));
      }
      card.appendChild(best);
      container.appendChild(card);
    },

    // ------------------------------------------------------------------ notes
    noteFor(key) { const n = this.notes && this.notes[key]; return n && n.text && n.text.trim() ? n.text : ''; },

    saveNote(key, name, text) {
      if (text.trim()) this.notes[key] = { text, name, at: Date.now() };
      else delete this.notes[key];
      saveJSON(NOTES_KEY, this.notes);
    },

    openNotes(key, name) {
      if (!this.notesPage) {
        const shown = (sel) => { const e = document.querySelector(sel); return e && e.offsetParent !== null ? e : null; };
        this.notesPage = window.PTUI.page({
          cls: 'pt-notes-overlay', title: 'Notes',
          onBack: () => this.closeNotes(),
          behind: () => [shown('.track-info-ui')],
        });
        const area = el('textarea', 'pt-notes-text');
        area.spellcheck = true;
        area.placeholder = 'Lines, tricks, where you lose time, what to try next…';
        // typing here must not drive the game
        for (const t of ['keydown', 'keyup', 'keypress']) area.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
        area.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeNotes(); } });
        let timer = 0;
        area.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => this.saveNote(this.notesKey, this.notesName, area.value), 400);
          this.notesPage.bar.querySelector('.pt-status').textContent = 'Saving…';
          clearTimeout(this.notesSavedTimer);
          this.notesSavedTimer = setTimeout(() => { this.notesPage.bar.querySelector('.pt-status').textContent = 'Saved on this computer'; }, 450);
        });
        this.notesArea = area;
        const card = window.PTUI.card(this.notesPage.content, null);
        card.appendChild(area);
        card.appendChild(el('p', 'pt-note', 'Saved as you type, on this computer only. Each track has its own notes.'));
        const status = el('span', 'pt-status');
        this.notesPage.bar.appendChild(status);
      }
      this.notesKey = key; this.notesName = name;
      this.notesPage.title.textContent = name || 'Notes';
      this.notesPage.sub.textContent = 'Your notes';
      this.notesArea.value = this.noteFor(key);
      this.notesPage.bar.querySelector('.pt-status').textContent = '';
      this.notesPage.show();
      setTimeout(() => this.notesArea.focus(), 0);
    },

    closeNotes() {
      if (!this.notesPage || !this.notesPage.open) return;
      this.saveNote(this.notesKey, this.notesName, this.notesArea.value);
      this.notesPage.hide();
      // the track page's button shows whether there is a note
      for (const b of document.querySelectorAll('.track-info-ui .pt-track-notes')) {
        const has = !!this.noteFor(this.notesKey);
        b.classList.toggle('has', has);
        const small = b.querySelector('small'); if (small) small.textContent = has ? '●' : '';
        b.title = has ? this.noteFor(this.notesKey).slice(0, 200) : 'Your own notes on this track: lines, tricks, what to try next';
      }
    },

    buildOverlay() {
      if (this.page) return;
      const shown = (sel) => { const e = document.querySelector(sel); return e && e.offsetParent !== null ? e : null; };
      this.page = window.PTUI.page({
        cls: 'pt-runs-overlay',
        title: 'Statistics',
        tabs: [['overview', 'Overview'], ['tracks', 'Tracks'], ['clips', 'Clips']],
        onTab: (id) => { this.tab = id; this.selectedTrack = null; this.fromTrackPage = false; this.render(); },
        onBack: () => this.back(),
        // it takes the place of the screen it was opened from, as the game's own screens do
        behind: () => [shown('.track-selection-ui'), shown('.track-info-ui')],
      });
      this.overlay = this.page.root;
    },

    render() {
      if (!this.page) return;
      const P = this.page;
      const view = this.tab + '|' + (this.tab === 'tracks' ? this.selectedTrack || '' : '');
      const fresh = view !== this.view;
      this.view = view;
      const scroll = P.content.scrollTop;
      P.setTab(this.tab);
      P.title.textContent = 'Statistics';
      P.sub.textContent = '';
      const body = P.content;
      body.textContent = '';
      if (this.tab === 'overview') this.renderOverview(body);
      else if (this.tab === 'tracks') this.selectedTrack ? this.renderTrack(body, this.selectedTrack) : this.renderTracks(body);
      else this.renderClips(body);
      // a new view starts at the top and fades in; the same view redrawn keeps its place
      if (fresh) { body.scrollTop = 0; P.swap(); } else body.scrollTop = scroll;
    },

    chart(card, height) {
      const canvas = el('canvas');
      canvas.style.height = height + 'px';
      card.appendChild(canvas);
      return canvas;
    },

    renderOverview(body) {
      const U = window.PTUI;
      const s = Core.overallSummary(this.stats);
      U.tiles(body, [
        ['Driving time', dur(s.drivingMs)],
        ['Time in game', dur(s.appMs)],
        ['Attempts', s.attempts.toLocaleString()],
        ['Finishes', s.finishes.toLocaleString()],
        ['Finish rate', pct(s.finishRate)],
        ['Resets', s.resets.toLocaleString()],
        ['Tracks played', String(s.tracksPlayed)],
        ['Distance', (s.distance / 1000).toFixed(1) + ' km'],
      ]);

      const activity = U.card(body, 'Activity', 'attempts a day, the last 30 days');
      const canvas = this.chart(activity, 150);
      const series = Core.activitySeries(this.stats, 30);
      requestAnimationFrame(() => barChart(canvas, series.map((d) => ({ value: d.attempts, label: d.day.slice(5) })), { height: 150 }));

      const two = el('div', 'pt-cols');
      body.appendChild(two);
      const most = U.card(two, 'Most played');
      if (s.mostPlayed.length) most.appendChild(this.trackTable(s.mostPlayed, true));
      else most.appendChild(el('p', 'pt-note', 'Nothing driven yet.'));
      const recent = U.card(two, 'Recent runs');
      if (this.stats.recent.length) {
        const table = U.list(['Track', ['Result', 'r'], ['When', 'r']], 'pt-runs-table');
        for (const r of this.stats.recent.slice(0, 12)) {
          const tr = el('tr', r.f != null ? null : 'faded');
          tr.appendChild(el('td', null, r.n));
          tr.appendChild(el('td', 'r', r.f != null ? fmt(r.f) : 'reset at CP ' + r.cp));
          tr.appendChild(el('td', 'r', ago(r.t)));
          table.appendChild(tr);
        }
        recent.appendChild(table);
      } else recent.appendChild(el('p', 'pt-note', 'Drive a track and it will show up here.'));
    },

    trackTable(tracks, compact) {
      const U = window.PTUI;
      const table = U.list(compact ? ['Track', ['Attempts', 'r'], ['Best', 'r']]
        : ['Track', ['Attempts', 'r'], ['Best', 'r'], ['Finish rate', 'r'], ['Driving', 'r']], 'pt-runs-table');
      for (const t of tracks) {
        const tr = el('tr', 'click');
        tr.appendChild(el('td', null, t.name));
        tr.appendChild(el('td', 'r', String(t.attempts)));
        tr.appendChild(el('td', 'r', t.bestFrames != null ? fmt(t.bestFrames) : '—'));
        if (!compact) {
          tr.appendChild(el('td', 'r', pct(t.attempts ? t.finishes / t.attempts : 0)));
          tr.appendChild(el('td', 'r', dur(t.drivingMs)));
        }
        tr.addEventListener('click', () => { this.tab = 'tracks'; this.selectedTrack = t.id; this.fromTrackPage = false; this.render(); });
        table.appendChild(tr);
      }
      return table;
    },

    renderTracks(body) {
      const U = window.PTUI;
      const all = Object.values(this.stats.tracks).filter((t) => t.attempts > 0);
      const holder = el('div', 'pt-list-wrap');
      const draw = (q) => {
        holder.textContent = '';
        q = (q || '').trim().toLowerCase();
        const list = all.filter((t) => !q || t.name.toLowerCase().includes(q)).sort((a, b) => b.drivingMs - a.drivingMs);
        if (list.length) holder.appendChild(this.trackTable(list));
        else holder.appendChild(el('p', 'pt-note', all.length ? 'No track matches.' : 'Drive a track and it will show up here.'));
      };
      const row = el('div', 'pt-row');
      row.appendChild(U.search('Search your tracks…', draw));
      row.appendChild(el('span', 'pt-note', all.length + (all.length === 1 ? ' track driven' : ' tracks driven')));
      body.append(row, holder);
      draw('');
    },

    renderTrack(body, key) {
      const U = window.PTUI;
      const t = Core.trackSummary(this.stats, key);
      if (!t) { this.selectedTrack = null; return this.renderTracks(body); }
      const kinds = { official: 'Official track', community: 'Community track', custom: 'Custom track' };
      this.page.title.textContent = t.name;
      this.page.sub.textContent = (kinds[t.type] || 'Track') + ' · your statistics';

      U.tiles(body, [
        ['Best', t.bestFrames != null ? fmt(t.bestFrames) : '—'],
        ['Average finish', t.averageFinish != null ? fmt(t.averageFinish) : '—'],
        ['Last 10 average', t.recentAverage != null ? fmt(t.recentAverage) : '—'],
        ['Theoretical best', t.theoreticalBest != null ? fmt(t.theoreticalBest) : '—'],
        ['Attempts', String(t.attempts)],
        ['Finishes', String(t.finishes)],
        ['Finish rate', pct(t.finishRate)],
        ['Driving time', dur(t.drivingMs)],
        ['Top speed', t.maxSpeedKmh ? Math.round(t.maxSpeedKmh) + ' km/h' : '—'],
        ['Last played', t.lastPlayed ? ago(t.lastPlayed) : '—'],
      ]);

      const two = el('div', 'pt-cols');
      body.appendChild(two);
      const prog = U.card(two, 'Personal best over time');
      const points = t.progression.map((p, i) => ({ x: i, y: p.f, t: p.t }));
      if (points.length > 1) {
        const pc = this.chart(prog, 180);
        requestAnimationFrame(() => lineChart(pc, points, { formatY: fmt, formatX: (i) => dateStr(t.progression[Math.round(i)] ? t.progression[Math.round(i)].t : Date.now()) }));
      } else prog.appendChild(el('p', 'pt-note', 'Finish this track a few times to see your improvement.'));

      const dist = U.card(two, 'Finish times');
      if (t.finishTimes.length > 1) {
        const dc = this.chart(dist, 150);
        const min = Math.min(...t.finishTimes), max = Math.max(...t.finishTimes);
        const buckets = 12, span = (max - min) || 1;
        const counts = new Array(buckets).fill(0);
        for (const f of t.finishTimes) counts[Math.min(buckets - 1, Math.floor(((f - min) / span) * buckets))]++;
        requestAnimationFrame(() => barChart(dc, counts.map((c, i) => ({ value: c, label: i === 0 ? fmt(min) : i === buckets - 1 ? fmt(max) : '' })), { height: 150 }));
      } else dist.appendChild(el('p', 'pt-note', 'Not enough finishes yet.'));

      // best times between checkpoints: each section on its own, and where your best run loses time
      const secs = U.card(body, 'Best times between checkpoints');
      const sections = t.bestSections || [];
      if (sections.length) {
        const n = sections.length, finishLast = t.finishes > 0 && n === t.splits.best.length;
        const point = (i) => (i === 0 ? 'Start' : i === n && finishLast ? 'Finish' : 'CP ' + i);
        const losses = sections.map((best, i) => (t.pbSections && t.pbSections[i] != null && best != null ? t.pbSections[i] - best : null));
        const worst = Math.max(1, ...losses.filter((x) => x != null));
        const table = U.list(['Section', ['Best', 'r'], ['Average', 'r'], ['In your best run', 'r'], ['Your best run loses', 'r']], 'pt-runs-table pt-runs-sections');
        sections.forEach((best, i) => {
          const tr = el('tr');
          tr.appendChild(el('td', null, point(i) + ' → ' + point(i + 1)));
          tr.appendChild(el('td', 'r pt-good', best != null ? fmt(best) : '—'));
          const avg = t.averageSections ? t.averageSections[i] : null;
          tr.appendChild(el('td', 'r', avg != null ? fmt(avg) : '—'));
          const pb = t.pbSections ? t.pbSections[i] : null;
          tr.appendChild(el('td', 'r', pb != null ? fmt(pb) : '—'));
          const lossCell = el('td', 'r');
          const loss = losses[i];
          if (loss != null) {
            lossCell.append(loss > 0 ? '+' + fmt(loss) : '±0.000');
            lossCell.appendChild(U.meter(loss / worst, true));
          } else lossCell.textContent = '—';
          tr.appendChild(lossCell);
          table.appendChild(tr);
        });
        const total = el('tr', 'total');
        total.appendChild(el('td', null, 'Whole run'));
        total.appendChild(el('td', 'r pt-good', t.theoreticalBest != null ? fmt(t.theoreticalBest) : '—'));
        total.appendChild(el('td', 'r', t.averageFinish != null ? fmt(t.averageFinish) : '—'));
        total.appendChild(el('td', 'r', t.bestFrames != null ? fmt(t.bestFrames) : '—'));
        const gave = t.bestFrames != null && t.theoreticalBest != null ? t.bestFrames - t.theoreticalBest : null;
        total.appendChild(el('td', 'r', gave == null ? '—' : gave > 0 ? '+' + fmt(gave) : '±0.000'));
        table.appendChild(total);
        secs.appendChild(table);
        secs.appendChild(el('p', 'pt-note', 'Best: your quickest time on that section in any run, finished or not. Added up, they make the whole-run best'
          + ' (the theoretical best). The last column is how much your personal best gave away on each section against your own best there.'
          + (t.pbSections ? '' : ' Your personal best predates this table: set a new one to fill that column.')));
      } else secs.appendChild(el('p', 'pt-note', 'No sections recorded yet — pass a checkpoint and they appear here.'));

      const splits = U.card(body, 'Checkpoint splits');
      if (t.splits.best.length) {
        const table = U.list(['Checkpoint', ['Best', 'r'], ['Average', 'r'], ['Average behind best', 'r']], 'pt-runs-table');
        t.splits.best.forEach((best, i) => {
          if (best == null) return;
          const avg = t.averageSplits[i];
          const tr = el('tr');
          tr.appendChild(el('td', null, i === t.splits.best.length - 1 && t.finishes > 0 ? 'Finish' : 'Checkpoint ' + (i + 1)));
          tr.appendChild(el('td', 'r', fmt(best)));
          tr.appendChild(el('td', 'r', avg != null ? fmt(avg) : '—'));
          tr.appendChild(el('td', 'r', avg == null ? '—' : avg > best ? '+' + fmt(avg - best) : '±0.000'));
          table.appendChild(tr);
        });
        splits.appendChild(table);
      } else splits.appendChild(el('p', 'pt-note', 'No checkpoint times recorded yet.'));

      const resets = U.card(body, 'Where you reset', 'brighter means more resets');
      const hc = this.chart(resets, 320);
      requestAnimationFrame(() => heatmap(hc, t.resetCells || {}, t.footprint || [], { height: 320 }));
      const byCp = (t.resetByCheckpoint || []).map((v, i) => ({ value: v || 0, label: i === 0 ? 'start' : 'cp ' + i }));
      if (byCp.length) {
        resets.appendChild(el('p', 'pt-note', 'Resets in each section of the track:'));
        const seg = this.chart(resets, 140);
        requestAnimationFrame(() => barChart(seg, byCp, { height: 140, color: CHART.warn }));
      }
    },

    renderClips(body) {
      const U = window.PTUI;
      const row = el('div', 'pt-row');
      row.appendChild(U.toggle('Record every run', this.prefs.recordEvery, (on) => { this.prefs.recordEvery = on; this.savePrefs(); }));
      row.appendChild(U.toggle('Clip new records', this.prefs.clipRecords, (on) => { this.prefs.clipRecords = on; this.savePrefs(); }));
      row.appendChild(el('div', 'pt-grow'));
      const clipNow = U.button('Clip last run', 'video.svg');
      clipNow.addEventListener('click', () => this.saveClipNow());
      row.appendChild(clipNow);
      body.appendChild(row);
      const clipNote = el('p', 'pt-note');
      clipNote.append('Press ', U.keys('TweaksSaveClip'), ' while driving to save the run so far, or after a run to save the one you just did. '
        + 'New records are clipped automatically, one per track. Keys are set in Settings → Controls → Tweaks: other keys.');
      body.appendChild(clipNote);

      const P = window.PTPractice;
      if (P && P.prefs) {
        body.appendChild(el('h3', 'pt-heading', 'Practice tools (editor test drive)'));
        body.appendChild(el('p', 'pt-note',
          'While you are testing a track in the editor you can slow time down or speed it up, and keep savestates. '
          + 'They are deliberately unavailable in a real race: a run driven in slow motion would still produce a valid '
          + 'recording, so a run with the tools used is never saved to your statistics.'));
        const prow = el('div', 'pt-row');
        prow.appendChild(U.toggle('Show the practice readout', !!P.prefs.panel, (on) => {
          P.prefs.panel = on; P.savePrefs(); if (P.show) P.show(); if (P.draw) P.draw();
        }));
        body.appendChild(prow);
        const pkeys = el('p', 'pt-note', 'The speed is set in the editor, next to Test. While test driving: ');
        [['TweaksPracticeSlower', 'slower'], ['TweaksPracticeFaster', 'faster'], ['TweaksPracticeNormal', 'normal speed'],
          ['TweaksPracticeSave', 'save state'], ['TweaksPracticeLoad', 'load state'], ['TweaksPracticeForget', 'clear state'],
          ['TweaksPracticeSlot', 'next slot']].forEach(([name, what], i) => {
          if (i) pkeys.appendChild(document.createTextNode(',  '));
          pkeys.append(U.keys(name), ' ' + what);
        });
        pkeys.appendChild(document.createTextNode('.'));
        body.appendChild(pkeys);
      }

      const imp = U.card(body, 'Import a clip');
      const area = el('textarea');
      area.placeholder = 'Paste a clip code here (it starts with ' + Core.CLIP_PREFIX + ')';
      area.spellcheck = false;
      for (const t of ['keydown', 'keyup', 'keypress']) area.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      imp.appendChild(area);
      const irow = el('div', 'pt-row');
      irow.style.margin = '10px 0 0';
      const importBtn = U.button('Import code', 'import.svg');
      importBtn.addEventListener('click', () => { if (this.importClip(area.value)) area.value = ''; });
      irow.append(importBtn, U.fileButton('Open a .ptclip file', '.ptclip,.txt', (text) => this.importClip(text)));
      imp.appendChild(irow);

      const list = U.card(body, 'Your clips', this.clips.length ? this.clips.length + ' saved' : null);
      if (!this.clips.length) { list.appendChild(el('p', 'pt-note', 'No clips yet.')); return; }
      const table = U.list(['Track', ['Time', 'r'], ['Saved', 'r'], ['Size', 'r'], ''], 'pt-runs-table');
      for (const c of this.clips) {
        const tr = el('tr');
        const name = el('td', null, c.track);
        if (c.kind === 'record' || c.auto) name.appendChild(el('span', 'pt-dim', c.kind === 'record' ? '  record' : '  auto'));
        if (c.range) name.appendChild(el('span', 'pt-dim', '  section ' + fmt(c.range.from) + '–' + fmt(c.range.to)));
        tr.appendChild(name);
        tr.appendChild(el('td', 'r', c.finished ? fmt(c.frames) : 'unfinished ' + fmt(c.frames)));
        tr.appendChild(el('td', 'r', ago(c.savedAt)));
        tr.appendChild(el('td', 'r', (c.code.length / 1024).toFixed(1) + ' KB'));
        const actions = el('td', 'r');
        const add = (label, fn, on) => { const b = el('button', 'button' + (on ? ' selected' : ''), label); b.addEventListener('click', fn); actions.appendChild(b); };
        add('Watch', () => this.watchClip(c));
        add('Copy', () => { navigator.clipboard.writeText(c.code).then(() => this.toast('Clip code copied — paste it to share.'), () => this.toast('Could not copy.')); });
        add('Save', () => this.download(c));
        const armed = this.pendingGhosts.some((g) => g.clipId === c.id);
        add(armed ? 'Ghost ✓' : 'Ghost', () => (armed ? this.disarmGhost(c) : this.armGhost(c)), armed);
        add('Delete', () => { this.clips = this.clips.filter((x) => x.id !== c.id); this.saveClips(); this.render(); });
        tr.appendChild(actions);
        table.appendChild(tr);
      }
      list.appendChild(table);
    },

    download(entry) {
      try {
        const blob = new Blob([entry.code], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (entry.track || 'clip').replace(/[^\w\- ]+/g, '') + ' ' + (entry.finished ? fmt(entry.frames) : 'unfinished') + '.ptclip';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) { this.toast('Could not save that file.'); }
    },
  };

  window.PTRuns = PTRuns;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTRuns.init());
  else PTRuns.init();
})();
