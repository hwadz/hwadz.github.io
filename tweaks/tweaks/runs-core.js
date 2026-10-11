/*
 * PolyTrack Tweaks — statistics and clips: the logic, with no game or browser in it.
 *
 * Everything here is pure data work so it can be tested in Node: folding an attempt into the stored
 * statistics, summarising them for the screens, and the clip container format.
 *
 * A "clip" is a run stored as the game's own input recording — the same thing ghosts and leaderboard
 * replays are made of — so it is tiny (a few hundred bytes) and replays exactly. The container is
 * documented in README-STATS-AND-CLIPS.md so other mods can read and write it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PTRunsCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATS_VERSION = 1;
  const CLIP_VERSION = 1;
  const CLIP_PREFIX = 'PTCLIP1:';

  // How much history to keep. Everything is capped so the store cannot grow without bound.
  const LIMITS = {
    finishTimes: 500,     // most recent finish times, for averages and the distribution chart
    progression: 200,     // personal-best improvements over time
    resetCells: 3000,     // grid cells in the reset heatmap
    footprint: 8000,      // track outline cells drawn under the heatmap
    days: 400,            // days of activity history
    recentRuns: 60,       // most recent attempts, for the activity list
    clips: 300,
  };

  const GRID = 5;         // heatmap cell size in world units: one track part

  const round = (n, p = 0) => { const f = 10 ** p; return Math.round(n * f) / f; };
  const cell = (x, z) => Math.round(x / GRID) + ',' + Math.round(z / GRID);
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

  /** milliseconds (the game counts a frame as a millisecond) -> "1:23.456" */
  function formatTime(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(Math.round(ms));
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), t = ms % 1000;
    return sign + (m > 0 ? m + ':' + String(s).padStart(2, '0') : String(s)) + '.' + String(t).padStart(3, '0');
  }

  /** a duration in milliseconds -> "3h 12m" */
  function formatDuration(ms) {
    if (!ms || ms < 1000) return '0s';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) { const d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h'; }
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  function emptyStats() {
    return {
      version: STATS_VERSION,
      created: Date.now(),
      totals: { attempts: 0, finishes: 0, resets: 0, drivingMs: 0, appMs: 0, editorMs: 0, sessions: 0, distance: 0 },
      days: {},        // "YYYY-MM-DD" -> { attempts, finishes, drivingMs }
      tracks: {},      // trackId -> track record
      recent: [],      // most recent attempts, newest first
    };
  }

  function emptyTrack(id, name, type) {
    return {
      id, name: name || 'Unknown track', type: type || 'custom',
      attempts: 0, finishes: 0, resets: 0, drivingMs: 0,
      firstPlayed: null, lastPlayed: null,
      bestFrames: null, bestAt: null,
      finishTimes: [], progression: [],
      splits: { best: [], sum: [], count: [], bestSeg: [] },   // per checkpoint index; bestSeg is per section
      resetCells: {}, resetByCheckpoint: [], footprint: null,
      maxSpeedKmh: 0,
    };
  }

  function trimObject(obj, max) {
    const keys = Object.keys(obj);
    if (keys.length <= max) return obj;
    keys.sort((a, b) => obj[b] - obj[a]);
    const out = {};
    for (const k of keys.slice(0, max)) out[k] = obj[k];
    return out;
  }

  /**
   * Folds one finished-or-abandoned attempt into the store.
   * attempt: { trackId, trackName, trackType, startedAt, drivingMs, frames, finished, splits[],
   *            resetPosition{x,y,z}|null, checkpointIndex, maxSpeedKmh, distance, footprint[]? }
   */
  function recordAttempt(stats, attempt) {
    if (!stats || !attempt || !attempt.trackId) return stats;
    const t = stats.tracks[attempt.trackId] || (stats.tracks[attempt.trackId] = emptyTrack(attempt.trackId, attempt.trackName, attempt.trackType));
    if (attempt.trackName) t.name = attempt.trackName;            // a custom track can be renamed
    const ms = Math.max(0, attempt.drivingMs || 0);
    const when = attempt.startedAt || Date.now();

    stats.totals.attempts++;
    stats.totals.drivingMs += ms;
    stats.totals.distance += attempt.distance || 0;
    t.attempts++;
    t.drivingMs += ms;
    t.lastPlayed = when;
    if (!t.firstPlayed) t.firstPlayed = when;
    if (attempt.maxSpeedKmh > t.maxSpeedKmh) t.maxSpeedKmh = round(attempt.maxSpeedKmh, 1);

    const day = stats.days[dayKey(when)] || (stats.days[dayKey(when)] = { attempts: 0, finishes: 0, drivingMs: 0 });
    day.attempts++;
    day.drivingMs += ms;

    if (attempt.finished) {
      stats.totals.finishes++;
      t.finishes++;
      day.finishes++;
      const frames = attempt.frames;
      t.finishTimes.push(frames);
      if (t.finishTimes.length > LIMITS.finishTimes) t.finishTimes.splice(0, t.finishTimes.length - LIMITS.finishTimes);
      if (t.bestFrames == null || frames < t.bestFrames) {
        t.bestFrames = frames;
        t.bestAt = when;
        t.progression.push({ t: when, f: frames });
        if (t.progression.length > LIMITS.progression) t.progression.splice(0, t.progression.length - LIMITS.progression);
      }
    } else {
      stats.totals.resets++;
      t.resets++;
      if (attempt.resetPosition) {
        const key = cell(attempt.resetPosition.x, attempt.resetPosition.z);
        t.resetCells[key] = (t.resetCells[key] || 0) + 1;
        if (Object.keys(t.resetCells).length > LIMITS.resetCells) t.resetCells = trimObject(t.resetCells, LIMITS.resetCells);
      }
      const cp = Math.max(0, attempt.checkpointIndex || 0);
      t.resetByCheckpoint[cp] = (t.resetByCheckpoint[cp] || 0) + 1;
    }

    // splits are cumulative times at each checkpoint; sections are the gaps between them, and the
    // best section times added together are the run this track would give you on a perfect day
    const splits = attempt.splits || [];
    if (!t.splits.bestSeg) t.splits.bestSeg = [];
    for (let i = 0; i < splits.length; i++) {
      const s = splits[i];
      if (!isFinite(s)) continue;
      if (t.splits.best[i] == null || s < t.splits.best[i]) t.splits.best[i] = s;
      t.splits.sum[i] = (t.splits.sum[i] || 0) + s;
      t.splits.count[i] = (t.splits.count[i] || 0) + 1;
      if (attempt.finished || i < splits.length - 1) {          // only sections actually completed
        const seg = i === 0 ? s : s - splits[i - 1];
        if (isFinite(seg) && seg >= 0 && (t.splits.bestSeg[i] == null || seg < t.splits.bestSeg[i])) t.splits.bestSeg[i] = seg;
      }
    }

    if (attempt.footprint && (!t.footprint || !t.footprint.length)) t.footprint = attempt.footprint.slice(0, LIMITS.footprint);

    stats.recent.unshift({
      id: attempt.trackId, n: t.name, t: when, ms, f: attempt.finished ? attempt.frames : null, cp: attempt.checkpointIndex || 0,
    });
    if (stats.recent.length > LIMITS.recentRuns) stats.recent.length = LIMITS.recentRuns;

    const days = Object.keys(stats.days);
    if (days.length > LIMITS.days) { days.sort(); for (const d of days.slice(0, days.length - LIMITS.days)) delete stats.days[d]; }
    return stats;
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  function trackSummary(stats, trackId) {
    const t = stats.tracks[trackId];
    if (!t) return null;
    const times = t.finishTimes;
    const avgSplits = t.splits.sum.map((s, i) => (t.splits.count[i] ? s / t.splits.count[i] : null));
    const segs = t.splits.bestSeg || [];
    const complete = t.finishes > 0 && segs.length === t.splits.best.length && segs.every((x) => x != null);
    const sumOfBest = complete ? segs.reduce((a, b) => a + b, 0) : null;
    return {
      ...t,
      finishRate: t.attempts ? t.finishes / t.attempts : 0,
      averageFinish: mean(times),
      medianFinish: median(times),
      recentAverage: mean(times.slice(-10)),
      worstFinish: times.length ? Math.max(...times) : null,
      averageSplits: avgSplits,
      bestSections: segs,
      theoreticalBest: sumOfBest,
      averageAttemptMs: t.attempts ? t.drivingMs / t.attempts : 0,
    };
  }

  function overallSummary(stats) {
    const tracks = Object.values(stats.tracks);
    const played = tracks.filter((t) => t.attempts > 0);
    const byTime = [...played].sort((a, b) => b.drivingMs - a.drivingMs);
    const byAttempts = [...played].sort((a, b) => b.attempts - a.attempts);
    return {
      ...stats.totals,
      finishRate: stats.totals.attempts ? stats.totals.finishes / stats.totals.attempts : 0,
      tracksPlayed: played.length,
      tracksFinished: played.filter((t) => t.finishes > 0).length,
      mostPlayed: byTime.slice(0, 8),
      mostAttempted: byAttempts.slice(0, 8),
      averageAttemptMs: stats.totals.attempts ? stats.totals.drivingMs / stats.totals.attempts : 0,
      activeDays: Object.keys(stats.days).length,
    };
  }

  /** Days ending today, oldest first, for the activity chart. */
  function activitySeries(stats, days = 30) {
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const rec = stats.days[key] || { attempts: 0, finishes: 0, drivingMs: 0 };
      out.push({ day: key, ...rec });
    }
    return out;
  }

  // ---------------------------------------------------------------- clips

  const b64 = {
    encode(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      const raw = typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
      return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    decode(text) {
      const norm = text.replace(/-/g, '+').replace(/_/g, '/');
      if (typeof atob === 'function') {
        const s = atob(norm + '==='.slice((norm.length + 3) % 4));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
      }
      return new Uint8Array(Buffer.from(norm, 'base64'));
    },
  };

  /**
   * clip: { track:{id,name,author,type}, run:{frames,finished,splits,date,maxSpeedKmh},
   *         recording, car:{style,nickname}, trackCode? }
   * codec: { deflate(Uint8Array)->Uint8Array, inflate(Uint8Array)->Uint8Array }
   */
  function encodeClip(clip, codec) {
    const body = JSON.stringify({ v: CLIP_VERSION, ...clip });
    const bytes = new TextEncoder().encode(body);
    return CLIP_PREFIX + b64.encode(codec.deflate(bytes));
  }

  function decodeClip(text, codec) {
    if (typeof text !== 'string') throw new Error('not a clip');
    const trimmed = text.trim();
    const at = trimmed.indexOf(CLIP_PREFIX);
    if (at < 0) throw new Error('not a clip code');
    const payload = trimmed.slice(at + CLIP_PREFIX.length).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9\-_]+$/.test(payload)) throw new Error('clip code is damaged');
    const json = new TextDecoder().decode(codec.inflate(b64.decode(payload)));
    const clip = JSON.parse(json);
    if (!clip || clip.v !== CLIP_VERSION) throw new Error('unsupported clip version');
    if (!clip.track || typeof clip.track.id !== 'string' || typeof clip.recording !== 'string') throw new Error('clip is missing its run');
    if (clip.recording.length > 4e6) throw new Error('clip is implausibly large');
    return clip;
  }

  /** A short, stable name for a clip file or list entry. */
  function clipLabel(clip) {
    const time = clip.run && clip.run.finished ? formatTime(clip.run.frames) : 'unfinished';
    return (clip.track.name || 'track') + ' — ' + time;
  }

  return {
    STATS_VERSION, CLIP_VERSION, CLIP_PREFIX, LIMITS, GRID,
    emptyStats, emptyTrack, recordAttempt, trackSummary, overallSummary, activitySeries,
    encodeClip, decodeClip, clipLabel, formatTime, formatDuration, dayKey, cell, mean, median,
  };
});
