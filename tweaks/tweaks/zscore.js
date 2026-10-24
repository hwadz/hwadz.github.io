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
 * Where the numbers come from and what it costs: the shared leaderboard cache (tweaks/boards.js) —
 * the game's own leaderboard requests, at most 500 runs each, one at a time with a pause in between,
 * only when you press a button, kept for a day and shared with the global ranking. Checking every
 * official and community track is two requests per track at the default sample.
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
  const TTL = 24 * 3600 * 1000;        // how long a result is good for
  const SAMPLES = [100, 500, 1000];
  const MAX_FAILS = 3;                 // in a row, before a full scan gives up
  const log = (...a) => console.log('[zscore]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
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
.track-selection-ui .track > .button > .pt-z-badge { position:absolute; left:10px; top:44px; z-index:2; padding:2px 10px 2px 8px;
  font-size:18px; line-height:1.2; background-color:var(--surface-tertiary-color); color:var(--text-color); pointer-events:none;
  clip-path:polygon(0 0, 100% 0, calc(100% - 6px) 100%, 0 100%); }
.track-selection-ui .track > .button > .pt-z-badge.warm { color:#ff5; }
.track-selection-ui .track > .button > .pt-z-badge.hot { color:#f55; }
.track-selection-ui .track > .button > .pt-z-more { position:absolute; left:0; right:0; top:var(--pt-z-top, 40px); height:168px;
  z-index:2; display:none; flex-direction:column; justify-content:center; gap:2px; padding:6px 14px; box-sizing:border-box;
  background-color:rgba(17, 32, 82, 0.94); color:var(--text-color); font-size:16px; line-height:1.3; text-align:left; white-space:normal;
  pointer-events:none; }
.track-selection-ui .track > .button > .pt-z-more b { font-weight:normal; font-size:22px; }
.track-selection-ui .track > .button > .pt-z-more .dim { opacity:0.5; }
.track-selection-ui .track > .button:hover > .pt-z-more,
.track-selection-ui .track > .button:focus-visible > .pt-z-more { display:flex; }
.track-selection-ui .track > .button:hover > .pt-z-badge,
.track-selection-ui .track > .button:focus-visible > .pt-z-badge { display:none; }
.track-selection-ui > .bar > .button.pt-z-open { margin:8px 12px 8px 0; }

/* leaderboard: a line under the title like its own "Version" line, and a button like "Only verified" */
.leaderboard-ui > .pt-z-summary { margin:-6px 10px 10px; font-size:18px; text-align:center; color:var(--text-color); opacity:0.75; }
.leaderboard-ui > .pt-z-summary:empty { display:none; }
.leaderboard-ui > .button-wrapper > .button.pt-z-btn { margin:10px 10px 10px 0; float:right; font-size:20px; line-height:32px; }
.leaderboard-ui > .button-wrapper > .button.pt-z-btn > img.button-icon { width:26px; height:26px; margin:-4px 0 0 4px; }
.pt-z-entry { font-size:16px; opacity:0.75; }
#ui .leaderboard-ui > .container > button.main:has(.pt-z-entry:not(:empty)) > div > .name-container { padding-right:165px; }

/* the all-tracks screen */
.pt-z-overlay .pt-z-z { font-size:24px; }
.pt-z-overlay td .pt-dim { margin-left:8px; font-size:0.8em; }
.pt-z-overlay td .button > img { width:18px; height:18px; vertical-align:-3px; }
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
    sort: { key: 'z', dir: -1 },

    init() {
      this.prefs = Object.assign({ sample: 1000 }, (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })());
      if (!SAMPLES.includes(this.prefs.sample)) this.prefs.sample = 1000;
      try { this.cache = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { this.cache = {}; }
      const st = el('style'); st.id = 'pt-zscore-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Escape' && this.ui && this.ui.open) { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
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

    /** The z-score of one track: from the cache when it is recent, else from the leaderboard. */
    compute(track, force) {
      const key = this.key(track.id);
      const have = this.cache[key];
      if (!force && have && Date.now() - have.at < TTL) return Promise.resolve(have);
      if (this.inflight.has(key)) return this.inflight.get(key);
      const p = this.fetchAndScore(track, force).then((rec) => {
        this.cache[key] = rec;
        this.save();
        this.repaint(track.id);
        return rec;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      return p;
    },

    async fetchAndScore(track, force) {
      if (!window.PTBoards) throw new Error('The leaderboard cache is not loaded.');
      const sample = this.prefs.sample, verified = this.verifiedFor(track.type);
      // the runs come from the shared cache (tweaks/boards.js): paced, kept a day, shared with the global ranking
      const board = await window.PTBoards.top(track, sample, { verified, force: !!force });
      const total = board.total;
      const times = [], top = [];
      for (const e of board.entries) {
        if (e.verifiedState >= 2) continue;                      // invalid, a duplicate, or removed
        const t = e.frames;
        if (t == null || !(t > 0)) continue;
        times.push(t);
        if (top.length < 2) top.push({ name: e.nickname, at: e.date });
      }
      times.sort((a, b) => a - b);
      const s = score(times);
      return {
        id: track.id, name: track.name, type: track.type, sample, verified, total, at: board.at,
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

    toast(text) { if (window.PTUI) window.PTUI.toast(text); else log(text); },

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
        // the Play screen's track list only: the editor's Load dialog is the same list, drawn over the editor
        const bar = root && !root.classList.contains('with-background') && root.querySelector(':scope > .bar');
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
        const b = el('button', 'button pt-z-btn');
        window.PTUI.relabel(b, 'Z-score', 'graph.svg', true);
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
      window.PTUI.relabel(board.button, 'Z-score', rec ? 'refresh.svg' : 'graph.svg', true);
      board.summary.textContent = '';
      if (!rec) return;
      if (rec.z == null) { board.summary.textContent = 'Not enough times on this leaderboard for a z-score.'; return; }
      board.summary.appendChild(document.createTextNode('WR z-score '));
      board.summary.appendChild(el('span', null, fmtZ(rec.z)));
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
      if (this.ui && this.ui.open) this.renderTable();
    },

    // ---------------------------------------------------------------- every track at once
    open() {
      this.build();
      this.ui.show();
      this.render();
    },

    close() {
      if (this.ui) this.ui.hide();
    },

    build() {
      if (this.ui) return;
      const U = window.PTUI;
      const shown = (sel) => { const e = document.querySelector(sel); return e && e.offsetParent !== null ? e : null; };
      const P = U.page({ cls: 'pt-z-overlay', title: 'Z-scores', tools: true, onBack: () => this.close(), behind: () => [shown('.track-selection-ui')] });
      this.ui = P;
      this.overlay = P.root;
      P.tools.appendChild(el('span', 'pt-note', 'Sample'));
      const sample = U.choice(SAMPLES.map((n) => [n, 'Top ' + n]), this.prefs.sample, (n) => {
        if (this.batch) { this.toast('Stop the calculation before changing the sample.'); this.render(); return; }
        this.prefs.sample = n; this.savePrefs();
        for (const t of this.tiles) if (t.button.isConnected) this.paintTile(t.button, this.get(t.id));
        if (this.board) this.paintBoard(this.board);
        this.render();
      });
      P.tools.appendChild(sample);
      P.tools.appendChild(el('span', 'pt-note pt-grow', 'Compare tracks with the same sample only: a bigger sample spreads wider and puts the record further out.'));
      this.progress = U.progress();
      P.panel.insertBefore(this.progress.root, P.content);
      const about = el('p', 'pt-note',
        'How far each track’s world record is ahead of the best runs on its leaderboard, in standard deviations: '
        + 'z = (mean − WR) ÷ σ over the top runs (verified runs, as the game’s leaderboard shows them). '
        + 'The higher the z, the further the record stands out from everyone else — the harder it is to beat.');
      P.content.appendChild(about);
      this.tableHost = el('div', 'pt-list-wrap');
      P.content.appendChild(this.tableHost);
      const again = U.button('Recalculate all', 'refresh.svg');
      again.title = 'Ask again even for tracks calculated in the last day';
      again.addEventListener('click', () => this.runAll(true));
      const go = U.button('Calculate all', 'graph.svg');
      go.title = 'Calculate the tracks not calculated yet, or more than a day ago';
      go.addEventListener('click', () => { if (this.batch) this.batch.stopped = true; else this.runAll(false); });
      P.bar.append(el('div', 'pt-grow'), again, go);
      this.controls = { go, again, sample };
    },

    render() {
      if (!this.ui) return;
      const U = window.PTUI;
      for (const b of this.controls.sample.children) b.classList.toggle('selected', b.textContent === 'Top ' + this.prefs.sample);
      U.relabel(this.controls.go, this.batch ? 'Stop' : 'Calculate all', this.batch ? 'cancel.svg' : 'graph.svg');
      this.controls.again.disabled = !!this.batch;
      const tracks = this.trackList();
      const known = tracks.filter((t) => this.get(t.id)).length;
      const b = this.batch;
      if (b) {
        const left = b.total - b.done;
        const eta = b.done ? Math.round(((Date.now() - b.startedAt) / b.done) * left / 1000) : null;
        this.ui.sub.textContent = 'Calculating: ' + b.done + ' of ' + b.total + ' tracks' + (b.failed ? ' (' + b.failed + ' failed)' : '')
          + (eta != null && left ? ' · about ' + (eta >= 60 ? Math.round(eta / 60) + ' min' : eta + ' s') + ' left' : '') + '…';
        this.progress.set(b.done / Math.max(1, b.total));
        this.progress.root.style.display = '';
      } else {
        this.ui.sub.textContent = known + ' of ' + tracks.length + ' official and community tracks calculated (top ' + this.prefs.sample + ').'
          + (this.lastError ? ' Last problem: ' + this.lastError : '');
        this.progress.root.style.display = 'none';
      }
      this.renderTable();
    },

    renderTable() {
      if (!this.tableHost) return;
      const U = window.PTUI;
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
      const table = el('table', 'pt-list pt-z-table');
      const thead = el('tr');
      const cols = [['rank', '#', 'r'], ['name', 'Track'], ['type', 'Kind'], ['z', 'z', 'r'], ['wr', 'World record'], ['mean', 'Mean', 'r'],
        ['sd', 'σ', 'r'], ['gap2', '#2 behind', 'r'], ['total', 'Players', 'r'], ['at', 'Updated', 'r'], ['', '']];
      for (const [key, label, align] of cols) {
        const th = el('th', (align || '') + (key && key !== 'rank' ? ' sort' : '') + (key === k ? ' sorted' : ''), label + (key && key === k ? (d < 0 ? ' ▾' : ' ▴') : ''));
        if (key && key !== 'rank') th.addEventListener('click', () => {
          this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : (key === 'name' || key === 'type' ? 1 : -1) };
          this.renderTable();
        });
        thead.appendChild(th);
      }
      table.appendChild(thead);
      rows.forEach(({ t, r }, i) => {
        const tr = el('tr', Date.now() - r.at > TTL ? 'faded' : null);
        const pos = el('td', 'r');
        pos.appendChild(U.ordinal(i + 1));
        tr.appendChild(pos);
        tr.appendChild(el('td', null, t.name));
        tr.appendChild(el('td', null, t.type === 'community' ? 'community ' + (t.group || '') : t.type));
        tr.appendChild(el('td', 'r pt-z-z', fmtZ(r.z)));
        const wr = el('td', null, fmtTime(r.wr));
        if (r.wrName) wr.appendChild(el('span', 'pt-dim', r.wrName));
        tr.appendChild(wr);
        tr.appendChild(el('td', 'r', r.mean == null ? '—' : fmtTime(Math.round(r.mean))));
        tr.appendChild(el('td', 'r', r.sd == null ? '—' : fmtSd(r.sd)));
        tr.appendChild(el('td', 'r', r.gap2 == null ? '—' : fmtSigned(r.gap2) + 'σ'));
        tr.appendChild(el('td', 'r', r.total == null ? '—' : r.total.toLocaleString()));
        tr.appendChild(el('td', 'r', ago(r.at)));
        const td = el('td', 'r');
        const again = el('button', 'button');
        again.innerHTML = '<img src="images/refresh.svg">';
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
      if (!rows.length) this.tableHost.appendChild(el('p', 'pt-note', 'Nothing calculated yet at this sample size. Press Calculate all.'));
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
