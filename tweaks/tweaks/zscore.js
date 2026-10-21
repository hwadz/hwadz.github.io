/*
 * PolyTrack Tweaks — how strong is a track's world record? (Z-score)
 *
 * A track's z-score is how far its world record is ahead of the best times on its leaderboard,
 * measured in standard deviations of those times:
 *
 *     z = (mean − WR) ÷ σ        over the top 1000 runs (or 100 / 500, chosen in the Z-scores panel)
 *
 * A record that sits right among the other top times scores low; one that is far ahead of everyone
 * scores high — the higher the z, the harder that record is to beat. Every run on a leaderboard gets
 * the same number for itself, (mean − its time) ÷ σ: how many standard deviations it is faster
 * (+) or slower (−) than that mean.
 *
 * Only a fixed top slice can be used: Summer 1 alone has over seven million times. The sample is
 * the same as the game's leaderboard shows by default — verified runs on official and community
 * tracks, every run on others — minus any run the server marks invalid. σ is the population
 * standard deviation of the sample.
 *
 * Where the numbers come from and what it costs: the game's own leaderboard requests, at most 500
 * runs each (the most the server hands out), one at a time with a pause in between, only when you
 * press a button, and kept for a day. Checking every official and community track is two requests
 * per track at the default sample.
 *
 *   - Track selection: a "Z-scores" button (every track at once, ranked); each track's tile shows
 *     its z once known, and the details on hover or keyboard focus.
 *   - Leaderboard: a "Z-score" button for that track (any track, custom ones too), a summary line,
 *     and each run's own z next to its gap to the record.
 */
(function () {
  'use strict';

  const STORE_KEY = 'pt-zscore-v1';
  const PREFS_KEY = 'pt-zscore-prefs-v1';
  const PAGE = 500;                    // the most runs the server hands out per request
  const GAP_MS = 500;                  // pause between two requests
  const TTL = 24 * 3600 * 1000;        // how long a result is good for
  const SAMPLES = [100, 500, 1000];
  const MAX_FAILS = 3;                 // in a row, before a full scan gives up
  const log = (...a) => console.log('[zscore]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // the API hands times back as the game's Time object; frames are milliseconds
  const framesOf = (v) => (v == null ? null : typeof v === 'number' ? v : (typeof v.numberOfFrames === 'number' ? v.numberOfFrames : Number(v)));
  const fmtTime = (ms) => (ms == null ? '—' : window.PTRunsCore ? window.PTRunsCore.formatTime(ms) : (ms / 1000).toFixed(3));
  const fmtSd = (ms) => (ms / 1000).toFixed(3) + ' s';
  const fmtZ = (z) => (z == null || !isFinite(z) ? '—' : z.toFixed(2));
  const fmtSigned = (z) => (z >= 0 ? '+' : '−') + Math.abs(z).toFixed(2);
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  };

  /** The statistics of one sample of times (ms, best first). */
  function score(times) {
    const n = times.length;
    if (n < 2) return { n, mean: n ? times[0] : null, sd: null, z: null };
    let sum = 0;
    for (const t of times) sum += t;
    const mean = sum / n;
    let ss = 0;
    for (const t of times) ss += (t - mean) * (t - mean);
    const sd = Math.sqrt(ss / n);
    const wr = times[0];
    return { n, mean, sd, z: sd > 0 ? (mean - wr) / sd : null, gap2: sd > 0 ? (times[1] - wr) / sd : null };
  }

  const CSS = `
/* tiles: the z in a corner, the details over the thumbnail on hover or keyboard focus */
.track-selection-ui .track > .button > .pt-z-badge { position:absolute; left:12px; top:46px; z-index:2; padding:1px 7px;
  font-size:17px; line-height:1.35; background:rgba(8,12,36,0.62); color:var(--text-color); pointer-events:none; }
.track-selection-ui .track > .button > .pt-z-badge.warm { color:#ffc86b; }
.track-selection-ui .track > .button > .pt-z-badge.hot { color:#ff8a76; }
.track-selection-ui .track > .button > .pt-z-more { position:absolute; left:0; right:0; top:var(--pt-z-top, 40px); height:168px;
  z-index:2; display:none; flex-direction:column; justify-content:center; gap:1px; padding:6px 12px; box-sizing:border-box;
  background:rgba(8,12,36,0.88); color:var(--text-color); font-size:15px; line-height:1.3; text-align:left; white-space:normal;
  pointer-events:none; }
.track-selection-ui .track > .button > .pt-z-more b { font-weight:normal; font-size:19px; color:#ffc86b; }
.track-selection-ui .track > .button > .pt-z-more .dim { opacity:0.7; }
.track-selection-ui .track > .button:hover > .pt-z-more,
.track-selection-ui .track > .button:focus-visible > .pt-z-more { display:flex; }
.track-selection-ui .track > .button:hover > .pt-z-badge,
.track-selection-ui .track > .button:focus-visible > .pt-z-badge { display:none; }
.track-selection-ui > .bar > .button.pt-z-open { margin:8px 12px 8px 0; }

/* leaderboard */
.leaderboard-ui > .pt-z-summary { margin:-4px 10px 8px; min-height:0; font-size:16px; text-align:center; color:var(--text-color); opacity:0.85; }
.leaderboard-ui > .pt-z-summary:empty { display:none; }
.leaderboard-ui > .pt-z-summary b { font-weight:normal; color:#ffc86b; }
.leaderboard-ui > .button-wrapper > .button.pt-z-btn { margin:10px 10px 10px 0; float:right; font-size:20px; line-height:32px; }
.pt-z-entry { font-size:16px; opacity:0.85; color:#c9d3ff; }
#ui .leaderboard-ui > .container > button.main:has(.pt-z-entry:not(:empty)) > div > .name-container { padding-right:165px; }

/* the all-tracks panel */
.pt-z-overlay { position:absolute; left:0; top:0; width:100%; height:100%; z-index:50; display:flex; flex-direction:column;
  background:rgba(20,20,30,0.9); color:var(--text-color); font-family:ForcedSquare, system-ui, sans-serif; pointer-events:auto; }
.pt-z-overlay.hidden { display:none; }
.pt-z-head { display:flex; align-items:center; gap:10px; padding:12px 16px; background:var(--surface-color); flex-wrap:wrap; }
.pt-z-head h1 { margin:0; font-size:28px; font-weight:normal; flex:1; white-space:nowrap; }
.pt-z-head .button { font-size:22px; padding:6px 14px; }
.pt-z-head .sample { display:flex; align-items:center; gap:4px; font-size:18px; }
.pt-z-head .sample button { padding:4px 10px; border:none; background:var(--surface-secondary-color); color:var(--text-color); font:inherit; cursor:pointer; opacity:0.7; }
.pt-z-head .sample button.on { opacity:1; background:var(--button-hover-color, #3a4a9a); }
.pt-z-body { flex:1; overflow-y:auto; padding:14px 16px; }
.pt-z-note { font-size:16px; opacity:0.8; margin:4px 0 10px; max-width:1100px; line-height:1.4; }
.pt-z-progress { height:6px; background:rgba(255,255,255,0.1); margin:6px 0 12px; }
.pt-z-progress > div { height:100%; background:#ffc84a; width:0; transition:width 0.2s linear; }
table.pt-z-table { width:100%; border-collapse:collapse; font-size:17px; }
table.pt-z-table th { text-align:left; opacity:0.7; font-weight:normal; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.15); cursor:pointer; white-space:nowrap; }
table.pt-z-table th:hover { opacity:1; text-decoration:underline; }
table.pt-z-table td { padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.06); white-space:nowrap; }
table.pt-z-table td.z { color:#ffc86b; }
table.pt-z-table tr.old td { opacity:0.55; }
table.pt-z-table td button { padding:0 8px; border:none; background:transparent; color:var(--text-color); font:inherit; opacity:0.6; cursor:pointer; }
table.pt-z-table td button:hover { opacity:1; }
`;

  const PTZScore = {
    cache: {},
    prefs: null,
    tiles: [],            // { button, id } of the track tiles on screen
    rows: [],             // { span, id, frames } of the leaderboard rows on screen
    board: null,          // the leaderboard screen on show
    overlay: null,
    batch: null,
    inflight: new Map(),
    queue: Promise.resolve(),
    lastRequestAt: 0,
    sort: { key: 'z', dir: -1 },

    init() {
      this.prefs = Object.assign({ sample: 1000 }, (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })());
      if (!SAMPLES.includes(this.prefs.sample)) this.prefs.sample = 1000;
      try { this.cache = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { this.cache = {}; }
      const st = el('style'); st.id = 'pt-zscore-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Escape' && this.overlay && !this.overlay.classList.contains('hidden')) { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
      }, true);
    },

    save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.cache)); } catch (e) { log('could not save', e); } },
    savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { } },

    // ---------------------------------------------------------------- results
    /** Results are per leaderboard server and sample size. */
    key(id, sample) { return (window.PTApiBase || 'kodub') + '|' + (sample || this.prefs.sample) + '|' + id; },
    get(id) { return this.cache[this.key(id)] || null; },
    verifiedFor(category) { return category === 'official' || category === 'community'; },

    /** Official and community tracks, in menu order. */
    trackList() {
      const out = [];
      const lib = window.__ptTracks;
      if (!lib) return out;
      try { lib.forEachOfficialTrack((id, g, m) => out.push({ id, name: (m && m.name) || 'Track', type: 'official' })); } catch { }
      try { lib.forEachCommunityTrack((id, g, m) => out.push({ id, name: (m && m.name) || 'Track', type: 'community', group: g })); } catch { }
      return out;
    },

    /** One request at a time, with a pause between them, whoever asks. */
    request(fn) {
      const run = async () => {
        const wait = this.lastRequestAt + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        try { return await fn(); } finally { this.lastRequestAt = Date.now(); }
      };
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => { });
      return p;
    },

    /** The z-score of one track: from the cache when it is recent, else from the leaderboard. */
    compute(track, force) {
      const key = this.key(track.id);
      const have = this.cache[key];
      if (!force && have && Date.now() - have.at < TTL) return Promise.resolve(have);
      if (this.inflight.has(key)) return this.inflight.get(key);
      const p = this.fetchAndScore(track).then((rec) => {
        this.cache[key] = rec;
        this.save();
        this.repaint(track.id);
        return rec;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      return p;
    },

    async fetchAndScore(track) {
      const api = window.__ptApi;
      if (!api || typeof api.getLeaderboard !== 'function') throw new Error('The leaderboard is not available yet.');
      const sample = this.prefs.sample, verified = this.verifiedFor(track.type);
      // the server wants the player's token hash with every leaderboard request, as the game sends it
      let token = '';
      try { token = window.__ptProfiles.getCurrentUserProfile().tokenHash || ''; } catch { }
      const times = [], top = [];
      let total = null;
      for (let skip = 0; skip < sample; skip += PAGE) {
        const amount = Math.min(PAGE, sample - skip);
        const res = await this.request(() => api.getLeaderboard(token, track.id, skip, amount, verified));
        total = res.total;
        for (const e of res.entries) {
          if (e.verifiedState >= 2) continue;                    // invalid, a duplicate, or removed
          const t = framesOf(e.frames);
          if (t == null || !(t > 0)) continue;
          times.push(t);
          if (top.length < 2) top.push({ name: e.nickname, at: e.time instanceof Date ? e.time.getTime() : null });
        }
        if (res.entries.length < amount || skip + amount >= total) break;
      }
      times.sort((a, b) => a - b);
      const s = score(times);
      return {
        id: track.id, name: track.name, type: track.type, sample, verified, total, at: Date.now(),
        n: s.n, mean: s.mean, sd: s.sd, z: s.z, gap2: s.gap2,
        wr: times.length ? times[0] : null, second: times.length > 1 ? times[1] : null,
        wrName: top[0] ? top[0].name : null, wrAt: top[0] ? top[0].at : null,
      };
    },

    /** Where a computed track stands among every computed one (1 = strongest record). */
    rankOf(rec) {
      if (rec.z == null || (rec.type !== 'official' && rec.type !== 'community')) return null;
      const prefix = this.key('', rec.sample);
      const all = Object.keys(this.cache).filter((k) => k.startsWith(prefix)).map((k) => this.cache[k])
        .filter((r) => r.z != null && (r.type === 'official' || r.type === 'community'));
      const sorted = all.map((r) => r.z).sort((a, b) => b - a);
      return { rank: sorted.indexOf(rec.z) + 1, of: sorted.length, top: sorted.indexOf(rec.z) / sorted.length };
    },

    toast(text) { if (window.PTRuns && window.PTRuns.toast) window.PTRuns.toast(text); else log(text); },

    explainError(e) {
      const msg = (e && e.message) || String(e);
      if (/Failed to connect/i.test(msg) && !window.electron && !window.PTApiBase) {
        return 'The official leaderboard only answers the desktop game.';
      }
      return msg;
    },

    // ---------------------------------------------------------------- track tiles
    decorateTile(button, id, category) {
      try {
        if (!button || !id) return;
        this.tiles.push({ button, id });
        this.paintTile(button, this.get(id));
      } catch (e) { log('tile', e); }
    },

    paintTile(button, rec) {
      let badge = button.querySelector(':scope > .pt-z-badge');
      let more = button.querySelector(':scope > .pt-z-more');
      if (!rec || rec.z == null) {
        if (badge) badge.remove();
        if (more) more.remove();
        if (rec && rec.z == null) button.title = 'Z-score: not enough times on this leaderboard';
        return;
      }
      if (!badge) { badge = el('span', 'pt-z-badge'); button.appendChild(badge); }
      if (!more) { more = el('div', 'pt-z-more'); button.appendChild(more); }
      const rank = this.rankOf(rec);
      badge.textContent = 'z ' + fmtZ(rec.z);
      badge.classList.toggle('hot', !!rank && rank.top < 0.1);
      badge.classList.toggle('warm', !!rank && rank.top >= 0.1 && rank.top < 0.33);
      more.textContent = '';
      const head = el('div');
      head.appendChild(el('b', null, 'z ' + fmtZ(rec.z)));
      if (rank) head.appendChild(el('span', 'dim', '  #' + rank.rank + ' of ' + rank.of));
      more.appendChild(head);
      more.appendChild(el('div', null, 'WR ' + fmtTime(rec.wr) + (rec.wrName ? ' — ' + rec.wrName : '')));
      more.appendChild(el('div', null, 'top ' + rec.n + ' mean ' + fmtTime(Math.round(rec.mean))));
      more.appendChild(el('div', null, 'σ ' + fmtSd(rec.sd)));
      if (rec.gap2 != null) more.appendChild(el('div', null, '#2 is ' + rec.gap2.toFixed(2) + 'σ behind'));
      more.appendChild(el('div', 'dim', (rec.verified ? 'verified runs · ' : 'all runs · ') + ago(rec.at)));
      button.removeAttribute('title');
    },

    selectionRefreshed(root) {
      this.tiles = this.tiles.filter((t) => t.button.isConnected);
      try {
        const bar = root && root.querySelector(':scope > .bar');
        if (bar && !bar.querySelector('.pt-z-open')) {
          const b = el('button', 'button pt-z-open');
          b.innerHTML = '<img class="button-icon" src="images/graph.svg"> ';
          b.appendChild(document.createTextNode('Z-scores'));
          b.title = 'How strong each track’s world record is';
          b.addEventListener('click', () => this.open());
          bar.appendChild(b);
        }
      } catch (e) { log('bar', e); }
    },

    // ---------------------------------------------------------------- leaderboard screen
    leaderboardOpened({ root, buttons, trackId, category }) {
      try {
        this.rows = [];
        const summary = el('div', 'pt-z-summary');
        const h3 = root.querySelector(':scope > h3');
        root.insertBefore(summary, h3 ? h3.nextSibling : root.firstChild);
        const b = el('button', 'button pt-z-btn', 'Z-score');
        b.title = 'How strong this track’s world record is, and each run’s z';
        buttons.appendChild(b);
        const name = this.nameOf(trackId);
        const board = { root, trackId, category, summary, button: b, name };
        this.board = board;
        b.addEventListener('click', () => this.runBoard(board, !!this.get(trackId)));
        this.paintBoard(board);
      } catch (e) { log('leaderboard', e); }
    },

    leaderboardClosed(root) {
      if (this.board && this.board.root === root) this.board = null;
      this.rows = [];
    },

    nameOf(id) {
      let name = null;
      try { window.__ptTracks.forEachTrack((tid, m) => { if (tid === id && m && name == null) name = m.name; }); } catch { }
      return name || 'This track';
    },

    async runBoard(board, force) {
      board.summary.textContent = 'Calculating the z-score from the top ' + this.prefs.sample + ' runs…';
      board.button.disabled = true;
      try {
        await this.compute({ id: board.trackId, name: board.name, type: board.category }, force);
      } catch (e) {
        if (this.board === board) board.summary.textContent = 'Could not calculate it: ' + this.explainError(e);
        return;
      } finally { board.button.disabled = false; }
      if (this.board === board) this.paintBoard(board);
    },

    paintBoard(board) {
      const rec = this.get(board.trackId);
      board.button.textContent = rec ? 'Z-score ↻' : 'Z-score';
      board.summary.textContent = '';
      if (!rec) return;
      if (rec.z == null) { board.summary.textContent = 'Not enough times on this leaderboard for a z-score.'; return; }
      board.summary.appendChild(document.createTextNode('WR z-score '));
      board.summary.appendChild(el('b', null, fmtZ(rec.z)));
      board.summary.appendChild(document.createTextNode('  ·  top ' + rec.n + (rec.verified ? ' verified' : '') + ' mean ' + fmtTime(Math.round(rec.mean))
        + '  ·  σ ' + fmtSd(rec.sd) + '  ·  ' + ago(rec.at)));
      board.summary.title = 'z = (mean − world record) ÷ σ over the top ' + rec.n + ' runs. Each run shows its own (mean − time) ÷ σ.';
      for (const r of this.rows) if (r.id === board.trackId) this.paintRow(r, rec);
    },

    decorateRow(row, trackId, time, position) {
      try {
        const t = framesOf(time);
        if (t == null) return;
        let line = row.querySelector('.pt-prof-line');
        if (!line) {
          let slot = row.querySelector('.pt-prof-slot');
          if (!slot) { slot = el('div', 'pt-prof-slot'); row.appendChild(slot); }
          line = el('div', 'pt-prof-line');
          slot.prepend(line);
        }
        const span = el('span', 'pt-z-entry');
        line.appendChild(span);
        const r = { span, id: trackId, frames: t, position };
        this.rows = this.rows.filter((x) => x.span.isConnected);
        this.rows.push(r);
        const rec = this.get(trackId);
        if (rec) this.paintRow(r, rec);
      } catch (e) { log('row', e); }
    },

    paintRow(r, rec) {
      if (!rec || rec.sd == null || !(rec.sd > 0)) { r.span.textContent = ''; return; }
      const z = (rec.mean - r.frames) / rec.sd;
      r.span.textContent = fmtSigned(z) + 'σ';
      r.span.title = Math.abs(z).toFixed(2) + ' standard deviations ' + (z >= 0 ? 'faster' : 'slower') + ' than the mean of the top '
        + rec.n + ' (' + fmtTime(Math.round(rec.mean)) + ', σ ' + fmtSd(rec.sd) + ')';
    },

    /** A track's result changed: its tiles, the leaderboard on show, and the panel follow. */
    repaint(id) {
      const rec = this.get(id);
      this.tiles = this.tiles.filter((t) => t.button.isConnected);
      // a new result can move every other track's rank, so all tiles are repainted
      for (const t of this.tiles) this.paintTile(t.button, t.id === id ? rec : this.get(t.id));
      if (this.board && this.board.trackId === id) this.paintBoard(this.board);
      if (this.overlay && !this.overlay.classList.contains('hidden')) this.renderTable();
    },

    // ---------------------------------------------------------------- every track at once
    open() {
      this.build();
      this.overlay.classList.remove('hidden');
      this.render();
    },

    close() {
      if (this.overlay) this.overlay.classList.add('hidden');
    },

    build() {
      if (this.overlay) return;
      const o = el('div', 'pt-z-overlay hidden');
      const head = el('div', 'pt-z-head');
      head.appendChild(el('h1', null, 'Z-scores'));
      const sample = el('div', 'sample');
      sample.appendChild(el('span', null, 'Top'));
      for (const n of SAMPLES) {
        const b = el('button', null, String(n));
        b.dataset.n = String(n);
        b.addEventListener('click', () => {
          if (this.batch) return this.toast('Stop the calculation before changing the sample.');
          this.prefs.sample = n; this.savePrefs();
          for (const t of this.tiles) if (t.button.isConnected) this.paintTile(t.button, this.get(t.id));
          if (this.board) this.paintBoard(this.board);
          this.render();
        });
        sample.appendChild(b);
      }
      head.appendChild(sample);
      const go = el('button', 'button', 'Calculate all');
      go.addEventListener('click', () => this.runAll(false));
      const again = el('button', 'button', 'Recalculate all');
      again.title = 'Ask again even for tracks calculated in the last day';
      again.addEventListener('click', () => this.runAll(true));
      const stop = el('button', 'button', 'Stop');
      stop.addEventListener('click', () => { if (this.batch) this.batch.stopped = true; });
      const close = el('button', 'button', 'Close');
      close.addEventListener('click', () => this.close());
      head.append(go, again, stop, close);
      o.appendChild(head);
      const body = el('div', 'pt-z-body');
      body.appendChild(el('p', 'pt-z-note',
        'How far each track’s world record is ahead of the best runs on its leaderboard, in standard deviations: '
        + 'z = (mean − WR) ÷ σ over the top runs (verified runs, as the game’s leaderboard shows them). '
        + 'The higher the z, the further the record stands out from everyone else — the harder it is to beat. '
        + 'Compare tracks with the same sample size only.'));
      this.status = el('p', 'pt-z-note');
      body.appendChild(this.status);
      this.bar = el('div', 'pt-z-progress');
      this.bar.appendChild(el('div'));
      body.appendChild(this.bar);
      this.tableHost = el('div');
      body.appendChild(this.tableHost);
      o.appendChild(body);
      (document.getElementById('ui') || document.body).appendChild(o);
      this.overlay = o;
      this.controls = { go, again, stop, sample };
    },

    render() {
      if (!this.overlay) return;
      for (const b of this.controls.sample.querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.n) === this.prefs.sample);
      this.controls.go.disabled = !!this.batch;
      this.controls.again.disabled = !!this.batch;
      this.controls.stop.disabled = !this.batch;
      const tracks = this.trackList();
      const known = tracks.filter((t) => this.get(t.id)).length;
      const b = this.batch;
      if (b) {
        const left = b.total - b.done;
        const eta = b.done ? Math.round(((Date.now() - b.startedAt) / b.done) * left / 1000) : null;
        this.status.textContent = 'Calculating: ' + b.done + ' of ' + b.total + ' tracks' + (b.failed ? ' (' + b.failed + ' failed)' : '')
          + (eta != null && left ? ' · about ' + (eta >= 60 ? Math.round(eta / 60) + ' min' : eta + ' s') + ' left' : '') + '…';
        this.bar.firstChild.style.width = (100 * b.done / Math.max(1, b.total)).toFixed(1) + '%';
      } else {
        this.status.textContent = known + ' of ' + tracks.length + ' official and community tracks calculated (top ' + this.prefs.sample + ').'
          + (this.lastError ? ' Last problem: ' + this.lastError : '');
        this.bar.firstChild.style.width = (100 * known / Math.max(1, tracks.length)).toFixed(1) + '%';
      }
      this.renderTable();
    },

    renderTable() {
      if (!this.tableHost) return;
      const tracks = this.trackList();
      const rows = tracks.map((t) => ({ t, r: this.get(t.id) })).filter((x) => x.r);
      const k = this.sort.key, d = this.sort.dir;
      const val = (x) => {
        switch (k) {
          case 'name': return x.t.name.toLowerCase();
          case 'type': return x.t.type + (x.t.group || '');
          case 'wr': return x.r.wr;
          case 'mean': return x.r.mean;
          case 'sd': return x.r.sd;
          case 'gap2': return x.r.gap2;
          case 'total': return x.r.total;
          case 'at': return x.r.at;
          default: return x.r.z;
        }
      };
      rows.sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return va < vb ? -d : va > vb ? d : 0;
      });
      const table = el('table', 'pt-z-table');
      const thead = el('tr');
      const cols = [['rank', '#'], ['name', 'Track'], ['type', 'Kind'], ['z', 'z'], ['wr', 'World record'], ['mean', 'Mean (top)'],
        ['sd', 'σ'], ['gap2', '#2 behind'], ['total', 'Players'], ['at', 'Updated'], ['', '']];
      for (const [key, label] of cols) {
        const th = el('th', null, label + (key && key === k ? (d < 0 ? ' ▾' : ' ▴') : ''));
        if (key && key !== 'rank') th.addEventListener('click', () => {
          this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : (key === 'name' || key === 'type' ? 1 : -1) };
          this.renderTable();
        });
        thead.appendChild(th);
      }
      table.appendChild(thead);
      rows.forEach(({ t, r }, i) => {
        const tr = el('tr');
        if (Date.now() - r.at > TTL) tr.classList.add('old');
        tr.appendChild(el('td', null, String(i + 1)));
        tr.appendChild(el('td', null, t.name));
        tr.appendChild(el('td', null, t.type === 'community' ? 'community ' + (t.group || '') : t.type));
        tr.appendChild(el('td', 'z', fmtZ(r.z)));
        tr.appendChild(el('td', null, fmtTime(r.wr) + (r.wrName ? '  ' + r.wrName : '')));
        tr.appendChild(el('td', null, r.mean == null ? '—' : fmtTime(Math.round(r.mean))));
        tr.appendChild(el('td', null, r.sd == null ? '—' : fmtSd(r.sd)));
        tr.appendChild(el('td', null, r.gap2 == null ? '—' : fmtSigned(r.gap2) + 'σ'));
        tr.appendChild(el('td', null, r.total == null ? '—' : r.total.toLocaleString()));
        tr.appendChild(el('td', null, ago(r.at)));
        const td = el('td');
        const again = el('button', null, '↻');
        again.title = 'Calculate this track again';
        again.addEventListener('click', () => {
          again.disabled = true;
          this.compute(t, true).catch((e) => this.toast(t.name + ': ' + this.explainError(e))).finally(() => this.render());
        });
        td.appendChild(again);
        tr.appendChild(td);
        table.appendChild(tr);
      });
      this.tableHost.textContent = '';
      if (!rows.length) this.tableHost.appendChild(el('p', 'pt-z-note', 'Nothing calculated yet at this sample size. Press Calculate all.'));
      else this.tableHost.appendChild(table);
    },

    async runAll(force) {
      if (this.batch) return;
      const tracks = this.trackList();
      if (!tracks.length) return this.toast('The track list is not loaded yet.');
      const todo = force ? tracks : tracks.filter((t) => { const r = this.get(t.id); return !r || Date.now() - r.at >= TTL; });
      const b = { total: todo.length, done: 0, failed: 0, stopped: false, startedAt: Date.now() };
      this.batch = b;
      this.lastError = null;
      this.render();
      let fails = 0;
      for (const t of todo) {
        if (b.stopped) break;
        try { await this.compute(t, force); fails = 0; } catch (e) {
          b.failed++; fails++;
          this.lastError = t.name + ': ' + this.explainError(e);
          log('failed', t.name, e);
          if (fails >= MAX_FAILS) { this.lastError = 'stopped after ' + fails + ' failures in a row — ' + this.explainError(e); break; }
        }
        b.done++;
        this.render();
      }
      this.batch = null;
      this.render();
      this.toast(b.stopped ? 'Z-scores: stopped.' : 'Z-scores: ' + (b.done - b.failed) + ' tracks calculated' + (b.failed ? ', ' + b.failed + ' failed.' : '.'));
    },
  };

  PTZScore.score = score;
  window.PTZScore = PTZScore;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTZScore.init());
  else PTZScore.init();
})();
