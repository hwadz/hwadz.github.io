/*
 * PolyTrack Tweaks — statistics and clips.
 *
 *  - Watches every attempt through the race class hooks (window.PTRuns.raceStarted/raceEnded plus the
 *    read-only __ptRun() accessor) and folds it into the stored statistics.
 *  - Saves runs as clips: the game's own input recording, which is tiny and replays exactly. Clips
 *    can be copied as a code, written to a .ptclip file, and raced against as a ghost.
 *  - All decisions about data live in runs-core.js; this file is the game glue and the screens.
 */
(function () {
  'use strict';
  const Core = window.PTRunsCore;
  if (!Core) { console.error('[runs] runs-core.js not loaded'); return; }

  const STATS_KEY = 'pt-stats-v1';
  const CLIPS_KEY = 'pt-clips-v1';
  const PREFS_KEY = 'pt-runs-prefs-v1';
  const SAVE_DEBOUNCE = 4000;
  const MIN_CLIP_MS = 700;          // ignore instant restarts when recording every run
  const MAX_CLIP_BYTES = 4 << 20;

  const log = (...a) => console.log('[runs]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = Core.formatTime, dur = Core.formatDuration;
  const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + '%';
  const dateStr = (ts) => new Date(ts).toLocaleDateString();

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

  const CHART = { grid: 'rgba(255,255,255,0.12)', text: 'rgba(238,241,255,0.75)', bar: '#4fb3ff', accent: '#ffc84a', warn: '#ff6b6b' };

  function prepare(canvas, height) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '12px ForcedSquare, system-ui, sans-serif';
    return { ctx, width, height };
  }

  function barChart(canvas, values, opts = {}) {
    const { ctx, width, height } = prepare(canvas, opts.height || 160);
    const pad = { l: 44, r: 8, t: 10, b: 22 };
    const max = Math.max(1, ...values.map((v) => v.value));
    const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    ctx.strokeStyle = CHART.grid; ctx.fillStyle = CHART.text;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + plotH * (i / 3);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
      const label = opts.formatY ? opts.formatY(max * (1 - i / 3)) : Math.round(max * (1 - i / 3));
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
.pt-runs-overlay { position:absolute; left:0; top:0; width:100%; height:100%; z-index:40; display:flex; flex-direction:column;
  background:rgba(20,20,30,0.82); color:var(--text-color); font-family:ForcedSquare, system-ui, sans-serif; pointer-events:auto; }
.pt-runs-overlay.hidden { display:none; }
.pt-runs-overlay.screen { background:var(--surface-secondary-color, #171b33); }
.pt-runs-head { display:flex; align-items:center; gap:10px; padding:12px 16px; background:var(--surface-color); }
.pt-runs-head h1 { margin:0; font-size:30px; font-weight:normal; flex:1; }
.pt-runs-tabs { display:flex; gap:6px; }
.pt-runs-tabs button, .pt-runs-head .button { margin:0; }
.pt-runs-tabs button.active { background:var(--button-active-color, #3a4a9a); }
.pt-runs-body { flex:1; overflow-y:auto; padding:16px; }
.pt-runs-tiles { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
.pt-runs-tile { background:var(--surface-color); padding:10px 14px; min-width:150px; flex:1 1 150px; }
.pt-runs-tile .v { font-size:28px; }
.pt-runs-tile .k { font-size:15px; opacity:0.75; }
.pt-runs-card { background:var(--surface-color); padding:12px 14px; margin-bottom:14px; }
.pt-runs-card h2 { margin:0 0 10px; font-size:22px; font-weight:normal; }
.pt-runs-card canvas { width:100%; display:block; }
.pt-runs-two { display:flex; gap:14px; flex-wrap:wrap; }
.pt-runs-two > * { flex:1 1 380px; }
table.pt-runs-table { width:100%; border-collapse:collapse; font-size:17px; }
table.pt-runs-table th { text-align:left; opacity:0.7; font-weight:normal; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.15); }
table.pt-runs-table td { padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.06); }
table.pt-runs-table tr.click { cursor:pointer; }
table.pt-runs-table tr.click:hover td { background:rgba(255,255,255,0.07); }
.pt-runs-row { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
.pt-runs-note { font-size:16px; opacity:0.8; margin:6px 0; white-space:pre-wrap; }
.pt-runs-overlay input, .pt-runs-overlay textarea { font-family:inherit; font-size:17px; padding:6px 8px; background:var(--surface-secondary-color); color:var(--text-color); border:none; }
.pt-runs-overlay textarea { width:100%; min-height:90px; resize:vertical; }
.pt-runs-toast { position:absolute; left:50%; bottom:40px; transform:translateX(-50%); z-index:60; padding:8px 16px; font-size:19px;
  background:var(--surface-color); color:var(--text-color); pointer-events:none; opacity:0; transition:opacity 0.2s ease-out; }
.pt-runs-toast.show { opacity:1; }
`;

  const PTRuns = {
    stats: null, clips: null, prefs: null,
    race: null, info: null, car: null, attempt: null, lastRun: null, resetCounter: -1,
    pendingGhosts: [], overlay: null, tab: 'overview', selectedTrack: null, saveTimer: 0, loopId: 0, lastFrameAt: 0,

    init() {
      this.stats = loadJSON(STATS_KEY, null) || Core.emptyStats();
      this.clips = loadJSON(CLIPS_KEY, null) || [];
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
        this.armPendingGhosts();
      } catch (e) { console.error('[runs] race start', e); }
    },

    raceEnded() {
      try { this.endAttempt(false); } catch (e) { console.error('[runs] race end', e); }
      this.race = null; this.info = null; this.car = null; this.attempt = null;
      this.saveNow();
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
          maxSpeedKmh: 0, lastPosition: null, distance: 0, started: false,
        };
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
        a.splits.push(st.frames);
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
      if (e.code === 'Escape' && this.overlay && !this.overlay.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); this.close(); }
    },

    toast(text) {
      let t = document.querySelector('.pt-runs-toast');
      if (!t) { t = el('div', 'pt-runs-toast'); (document.getElementById('ui') || document.body).appendChild(t); }
      t.textContent = text;
      t.classList.add('show');
      clearTimeout(this._toast);
      this._toast = setTimeout(() => t.classList.remove('show'), 2600);
    },

    // ------------------------------------------------------------------ screen
    open(tab) { this.buildOverlay(); this.tab = tab || this.tab; this.overlay.classList.remove('hidden'); this.render(); },

    /**
     * Opened from the main menu: the menu hides itself and hands us the screen, which is what every
     * other main-menu button does. `hooks.show` puts the menu back when we close.
     */
    openScreen(hooks) {
      this.buildOverlay();
      this.menuHooks = hooks || null;
      try { if (hooks && hooks.hide) hooks.hide(); } catch (e) { console.error('[runs] menu hide', e); }
      this.overlay.classList.add('screen');
      this.open();
    },

    close() {
      if (this.overlay) { this.overlay.classList.add('hidden'); this.overlay.classList.remove('screen'); }
      const hooks = this.menuHooks;
      this.menuHooks = null;
      if (hooks && hooks.show) { try { hooks.show(); } catch (e) { console.error('[runs] menu show', e); } }
      this.saveNow();
    },
    toggle() { if (!this.overlay || this.overlay.classList.contains('hidden')) this.open(); else this.close(); },

    buildOverlay() {
      if (this.overlay) return;
      const root = document.getElementById('ui') || document.body;
      const o = el('div', 'pt-runs-overlay hidden');
      const head = el('div', 'pt-runs-head');
      head.appendChild(el('h1', null, 'Statistics'));
      const tabs = el('div', 'pt-runs-tabs');
      for (const [id, label] of [['overview', 'Overview'], ['tracks', 'Tracks'], ['clips', 'Clips']]) {
        const b = el('button', 'button', label);
        b.dataset.tab = id;
        b.addEventListener('click', () => { this.tab = id; this.selectedTrack = null; this.render(); });
        tabs.appendChild(b);
      }
      head.appendChild(tabs);
      const close = el('button', 'button', 'Close');
      close.addEventListener('click', () => this.close());
      head.appendChild(close);
      o.appendChild(head);
      o.appendChild(el('div', 'pt-runs-body'));
      root.appendChild(o);
      this.overlay = o;
    },

    render() {
      if (!this.overlay) return;
      for (const b of this.overlay.querySelectorAll('.pt-runs-tabs button')) b.classList.toggle('active', b.dataset.tab === this.tab);
      const body = this.overlay.querySelector('.pt-runs-body');
      body.textContent = '';
      if (this.tab === 'overview') this.renderOverview(body);
      else if (this.tab === 'tracks') this.selectedTrack ? this.renderTrack(body, this.selectedTrack) : this.renderTracks(body);
      else this.renderClips(body);
    },

    tiles(parent, items) {
      const wrap = el('div', 'pt-runs-tiles');
      for (const [k, v] of items) {
        const t = el('div', 'pt-runs-tile');
        t.appendChild(el('div', 'v', v));
        t.appendChild(el('div', 'k', k));
        wrap.appendChild(t);
      }
      parent.appendChild(wrap);
    },

    card(parent, title) {
      const c = el('div', 'pt-runs-card');
      if (title) c.appendChild(el('h2', null, title));
      parent.appendChild(c);
      return c;
    },

    renderOverview(body) {
      const s = Core.overallSummary(this.stats);
      this.tiles(body, [
        ['Driving time', dur(s.drivingMs)],
        ['Time in game', dur(s.appMs)],
        ['Attempts', s.attempts.toLocaleString()],
        ['Finishes', s.finishes.toLocaleString()],
        ['Finish rate', pct(s.finishRate)],
        ['Resets', s.resets.toLocaleString()],
        ['Tracks played', String(s.tracksPlayed)],
        ['Distance', (s.distance / 1000).toFixed(1) + ' km'],
      ]);

      const activity = this.card(body, 'Activity (last 30 days)');
      const canvas = el('canvas');
      activity.appendChild(canvas);
      const series = Core.activitySeries(this.stats, 30);
      requestAnimationFrame(() => barChart(canvas, series.map((d) => ({ value: d.attempts, label: d.day.slice(5) })), { height: 150 }));

      const two = el('div', 'pt-runs-two');
      body.appendChild(two);
      const most = this.card(two, 'Most played');
      most.appendChild(this.trackTable(s.mostPlayed));
      const recent = this.card(two, 'Recent runs');
      const table = el('table', 'pt-runs-table');
      table.innerHTML = '<tr><th>Track</th><th>Result</th><th>When</th></tr>';
      for (const r of this.stats.recent.slice(0, 12)) {
        const tr = el('tr');
        tr.appendChild(el('td', null, r.n));
        tr.appendChild(el('td', null, r.f != null ? fmt(r.f) : 'reset at checkpoint ' + r.cp));
        tr.appendChild(el('td', null, new Date(r.t).toLocaleString()));
        table.appendChild(tr);
      }
      recent.appendChild(table);
      if (!this.stats.recent.length) recent.appendChild(el('p', 'pt-runs-note', 'Drive a track and it will show up here.'));
    },

    trackTable(tracks) {
      const table = el('table', 'pt-runs-table');
      table.innerHTML = '<tr><th>Track</th><th>Attempts</th><th>Best</th><th>Finish rate</th><th>Time</th></tr>';
      for (const t of tracks) {
        const tr = el('tr', 'click');
        tr.appendChild(el('td', null, t.name));
        tr.appendChild(el('td', null, String(t.attempts)));
        tr.appendChild(el('td', null, t.bestFrames != null ? fmt(t.bestFrames) : '—'));
        tr.appendChild(el('td', null, pct(t.attempts ? t.finishes / t.attempts : 0)));
        tr.appendChild(el('td', null, dur(t.drivingMs)));
        tr.addEventListener('click', () => { this.tab = 'tracks'; this.selectedTrack = t.id; this.render(); });
        table.appendChild(tr);
      }
      return table;
    },

    renderTracks(body) {
      const all = Object.values(this.stats.tracks).filter((t) => t.attempts > 0);
      const row = el('div', 'pt-runs-row');
      const search = el('input');
      search.placeholder = 'Search tracks';
      row.appendChild(search);
      body.appendChild(row);
      const holder = this.card(body, all.length + ' track' + (all.length === 1 ? '' : 's'));
      const draw = () => {
        holder.textContent = '';
        const q = search.value.trim().toLowerCase();
        const list = all.filter((t) => !q || t.name.toLowerCase().includes(q)).sort((a, b) => b.drivingMs - a.drivingMs);
        holder.appendChild(this.trackTable(list));
        if (!list.length) holder.appendChild(el('p', 'pt-runs-note', 'No tracks match.'));
      };
      search.addEventListener('input', draw);
      draw();
    },

    renderTrack(body, key) {
      const t = Core.trackSummary(this.stats, key);
      if (!t) { this.selectedTrack = null; return this.renderTracks(body); }
      const back = el('button', 'button', '← All tracks');
      back.addEventListener('click', () => { this.selectedTrack = null; this.render(); });
      const row = el('div', 'pt-runs-row');
      row.appendChild(back);
      row.appendChild(el('span', 'pt-runs-note', t.name + '  ·  ' + t.type));
      body.appendChild(row);

      this.tiles(body, [
        ['Best', t.bestFrames != null ? fmt(t.bestFrames) : '—'],
        ['Average finish', t.averageFinish != null ? fmt(t.averageFinish) : '—'],
        ['Last 10 average', t.recentAverage != null ? fmt(t.recentAverage) : '—'],
        ['Theoretical best', t.theoreticalBest != null ? fmt(t.theoreticalBest) : '—'],
        ['Attempts', String(t.attempts)],
        ['Finishes', String(t.finishes)],
        ['Finish rate', pct(t.finishRate)],
        ['Driving time', dur(t.drivingMs)],
        ['Top speed', t.maxSpeedKmh ? Math.round(t.maxSpeedKmh) + ' km/h' : '—'],
        ['Last played', t.lastPlayed ? dateStr(t.lastPlayed) : '—'],
      ]);

      const two = el('div', 'pt-runs-two');
      body.appendChild(two);

      const prog = this.card(two, 'Personal best over time');
      const points = t.progression.map((p, i) => ({ x: i, y: p.f, t: p.t }));
      if (points.length > 1) {
        const pc = el('canvas');
        prog.appendChild(pc);
        requestAnimationFrame(() => lineChart(pc, points, { formatY: fmt, formatX: (i) => dateStr(t.progression[Math.round(i)] ? t.progression[Math.round(i)].t : Date.now()) }));
      } else prog.appendChild(el('p', 'pt-runs-note', 'Finish this track a few times to see your improvement.'));

      const dist = this.card(two, 'Finish times');
      if (t.finishTimes.length > 1) {
        const dc = el('canvas');
        dist.appendChild(dc);
        const min = Math.min(...t.finishTimes), max = Math.max(...t.finishTimes);
        const buckets = 12, span = (max - min) || 1;
        const counts = new Array(buckets).fill(0);
        for (const f of t.finishTimes) counts[Math.min(buckets - 1, Math.floor(((f - min) / span) * buckets))]++;
        requestAnimationFrame(() => barChart(dc, counts.map((c, i) => ({ value: c, label: i === 0 ? fmt(min) : i === buckets - 1 ? fmt(max) : '' })), { height: 150 }));
      } else dist.appendChild(el('p', 'pt-runs-note', 'Not enough finishes yet.'));

      const splits = this.card(body, 'Checkpoint splits');
      if (t.splits.best.length) {
        const table = el('table', 'pt-runs-table');
        table.innerHTML = '<tr><th>Checkpoint</th><th>Best</th><th>Average</th><th>Difference</th></tr>';
        t.splits.best.forEach((best, i) => {
          if (best == null) return;
          const avg = t.averageSplits[i];
          const tr = el('tr');
          tr.appendChild(el('td', null, i === t.splits.best.length - 1 ? 'Finish' : 'Checkpoint ' + (i + 1)));
          tr.appendChild(el('td', null, fmt(best)));
          tr.appendChild(el('td', null, avg != null ? fmt(avg) : '—'));
          tr.appendChild(el('td', null, avg != null ? '+' + fmt(avg - best) : '—'));
          table.appendChild(tr);
        });
        splits.appendChild(table);
      } else splits.appendChild(el('p', 'pt-runs-note', 'No checkpoint times recorded yet.'));

      const resets = this.card(body, 'Where you reset');
      const hc = el('canvas');
      resets.appendChild(hc);
      requestAnimationFrame(() => heatmap(hc, t.resetCells || {}, t.footprint || [], { height: 320 }));
      const byCp = (t.resetByCheckpoint || []).map((v, i) => ({ value: v || 0, label: i === 0 ? 'start' : 'cp ' + i }));
      if (byCp.length) {
        const seg = el('canvas');
        resets.appendChild(el('p', 'pt-runs-note', 'Resets by section of the track:'));
        resets.appendChild(seg);
        requestAnimationFrame(() => barChart(seg, byCp, { height: 140, color: CHART.warn }));
      }
    },

    renderClips(body) {
      const row = el('div', 'pt-runs-row');
      const every = el('button', 'button', (this.prefs.recordEvery ? '☑' : '☐') + ' Record every run');
      every.addEventListener('click', () => { this.prefs.recordEvery = !this.prefs.recordEvery; this.savePrefs(); this.render(); });
      row.appendChild(every);
      const records = el('button', 'button', (this.prefs.clipRecords ? '☑' : '☐') + ' Clip new records');
      records.addEventListener('click', () => { this.prefs.clipRecords = !this.prefs.clipRecords; this.savePrefs(); this.render(); });
      row.appendChild(records);
      const clipNow = el('button', 'button', 'Clip last run');
      clipNow.addEventListener('click', () => this.saveClipNow());
      row.appendChild(clipNow);
      body.appendChild(row);
      const clipNote = el('p', 'pt-runs-note', 'Press ');
      this.appendCaps(clipNote, 'TweaksSaveClip');
      clipNote.appendChild(document.createTextNode(' while driving to save the run so far, or after a run to save the one you just did. '
        + 'New records are clipped automatically, one per track.'));
      body.appendChild(clipNote);
      body.appendChild(this.keysNote());

      const P = window.PTPractice;
      if (P && P.prefs) {
        body.appendChild(el('h2', null, 'Practice tools (editor test drive)'));
        body.appendChild(el('p', 'pt-runs-note',
          'While you are testing a track in the editor you can slow time down or speed it up, and keep savestates. '
          + 'They are deliberately unavailable in a real race: a run driven in slow motion would still produce a valid '
          + 'recording, so a run with the tools used is never saved to your statistics.'));
        const prow = el('div', 'pt-runs-row');
        const panel = el('button', 'button', (P.prefs.panel ? '☑' : '☐') + ' Show the practice readout');
        panel.addEventListener('click', () => { P.prefs.panel = !P.prefs.panel; P.savePrefs(); if (P.show) P.show(); if (P.draw) P.draw(); this.render(); });
        prow.appendChild(panel);
        body.appendChild(prow);
        const pkeys = el('p', 'pt-runs-note', 'The speed is set in the editor, next to Test. While test driving: ');
        [['TweaksPracticeSlower', 'slower'], ['TweaksPracticeFaster', 'faster'], ['TweaksPracticeNormal', 'normal speed'],
          ['TweaksPracticeSave', 'save state'], ['TweaksPracticeLoad', 'load state'], ['TweaksPracticeForget', 'clear state'],
          ['TweaksPracticeSlot', 'next slot']].forEach(([name, what], i) => {
          if (i) pkeys.appendChild(document.createTextNode(',  '));
          this.appendCaps(pkeys, name);
          pkeys.appendChild(document.createTextNode(' ' + what));
        });
        pkeys.appendChild(document.createTextNode('.'));
        body.appendChild(pkeys);
      }

      const imp = this.card(body, 'Import a clip');
      const area = el('textarea');
      area.placeholder = 'Paste a clip code here (starts with ' + Core.CLIP_PREFIX + ')';
      imp.appendChild(area);
      const irow = el('div', 'pt-runs-row');
      const importBtn = el('button', 'button', 'Import code');
      importBtn.addEventListener('click', () => { if (this.importClip(area.value)) area.value = ''; });
      irow.appendChild(importBtn);
      const file = el('input');
      file.type = 'file'; file.accept = '.ptclip,.txt';
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (!f) return;
        f.text().then((text) => this.importClip(text)).catch(() => this.toast('Could not read that file.'));
        file.value = '';
      });
      irow.appendChild(file);
      imp.appendChild(irow);

      const list = this.card(body, this.clips.length + ' clip' + (this.clips.length === 1 ? '' : 's'));
      if (!this.clips.length) { list.appendChild(el('p', 'pt-runs-note', 'No clips yet.')); return; }
      const table = el('table', 'pt-runs-table');
      table.innerHTML = '<tr><th>Track</th><th>Time</th><th>Saved</th><th>Size</th><th></th></tr>';
      for (const c of this.clips) {
        const tr = el('tr');
        tr.appendChild(el('td', null, c.track + (c.kind === 'record' ? ' (record)' : c.auto ? ' (auto)' : '')));
        tr.appendChild(el('td', null, c.finished ? fmt(c.frames) : 'unfinished ' + fmt(c.frames)));
        tr.appendChild(el('td', null, new Date(c.savedAt).toLocaleString()));
        tr.appendChild(el('td', null, (c.code.length / 1024).toFixed(1) + ' KB'));
        const actions = el('td');
        const add = (label, fn) => { const b = el('button', 'button', label); b.style.cssText = 'margin:0 4px 0 0;padding:2px 8px;font-size:15px'; b.addEventListener('click', fn); actions.appendChild(b); };
        add('Watch', () => this.watchClip(c));
        add('Copy', () => { navigator.clipboard.writeText(c.code).then(() => this.toast('Clip code copied — paste it to share.'), () => this.toast('Could not copy.')); });
        add('Save file', () => this.download(c));
        const armed = this.pendingGhosts.some((g) => g.clipId === c.id);
        add(armed ? 'Ghost ✓' : 'Ghost', () => (armed ? this.disarmGhost(c) : this.armGhost(c)));
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

    appendCaps(parent, name) {
      if (window.PTKeys) parent.appendChild(window.PTKeys.caps(name));
      else parent.appendChild(document.createTextNode('?'));
    },
    keysNote() {
      return el('p', 'pt-runs-note', 'Keys are set with the game’s own, in Settings → Controls → Tweaks.');
    },
  };

  window.PTRuns = PTRuns;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTRuns.init());
  else PTRuns.init();
})();
