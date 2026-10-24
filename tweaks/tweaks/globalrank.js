/*
 * PolyTrack Tweaks — a global ranking of every player the leaderboards turn up.
 *
 * How a player is rated (it can't be perfect, and doesn't pretend to be):
 *
 *  1. The top 1000 verified runs of every official and community track are read, through the shared
 *     leaderboard cache (tweaks/boards.js: paced requests, kept a day, shared with the Z-scores).
 *  2. Each of a player's results scores by how far up the whole field of that track it sits:
 *         score = log10(players on the leaderboard ÷ position)
 *     — the number of "orders of magnitude" between them and the field. #1 of 7 million scores 6.85,
 *     #100 of 7 million 4.85, #1 of 30 000 4.48, #1000 of 30 000 1.48. A bigger field is harder to
 *     top, so the same position counts for more on it. Equal times share a place, and runs the
 *     leaderboard marks invalid, duplicate or removed push no one down.
 *  3. A player's rating adds up their results best first, each next one counting 5 % less
 *     (×0.95, ×0.95², …) — the shape osu! uses for its performance points: strong on many tracks
 *     beats strong on one, and the fortieth track still adds a little.
 *
 * Players outside a track's top 1000 aren't found on it, so that track adds nothing for them. Known
 * leanings: popular official tracks have the biggest fields, so they weigh more than community tracks
 * with smaller but often stronger fields; and someone with few runs that all made a top 1000 can sit
 * below someone with many.
 */
(function () {
  'use strict';

  const TOP = 1000;                    // runs read per track
  const DECAY = 0.95;                  // each next result counts this much of the one before
  const PER_PAGE = 100;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtTime = (ms) => (ms == null ? '—' : window.PTRunsCore ? window.PTRunsCore.formatTime(ms) : (ms / 1000).toFixed(3));
  const num = (n) => (n == null ? '—' : n.toLocaleString());
  const topPct = (pos, total) => {
    const p = Number((100 * pos / total).toPrecision(2));   // two significant digits, never in e-notation
    return 'top ' + p.toFixed(p >= 10 ? 0 : p >= 1 ? 1 : Math.min(8, 1 - Math.floor(Math.log10(p)))) + '%';
  };
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  };

  /** Everyone on the given boards, rated and sorted (best first). */
  function rate(boards) {
    const players = new Map();
    for (const b of boards) {
      const total = Math.max(b.total || 0, b.entries.length);
      // runs marked invalid, duplicate or removed push no one down; equal times share a place
      const seen = new Set();
      const valid = b.entries.filter((e) => !(e.verifiedState >= 2) && e.userId && e.pos > 0 && !seen.has(e.userId) && seen.add(e.userId));
      const place = [];
      valid.forEach((e, i) => { place[i] = i > 0 && e.frames != null && e.frames === valid[i - 1].frames ? place[i - 1] : i + 1; });
      valid.forEach((e, i) => {
        let p = players.get(e.userId);
        if (!p) {
          p = { userId: e.userId, nickname: e.nickname || '?', countryCode: e.countryCode, results: [] };
          players.set(e.userId, p);
        }
        const tied = place[i - 1] === place[i] || place[i + 1] === place[i];
        p.results.push({ id: b.id, track: b.name, type: b.type, pos: place[i], tied, total, frames: e.frames, score: Math.log10(total / place[i]) });
      });
    }
    const list = [];
    for (const p of players.values()) {
      p.results.sort((a, b) => b.score - a.score || a.pos - b.pos);
      let r = 0, w = 1;
      for (const x of p.results) { x.weight = w; x.points = x.score * w; r += x.points; w *= DECAY; }
      p.rating = r;
      p.tracks = p.results.length;
      p.wrs = p.results.filter((x) => x.pos === 1).length;
      p.podiums = p.results.filter((x) => x.pos <= 3).length;
      p.top10 = p.results.filter((x) => x.pos <= 10).length;
      p.best = p.results[0];
      list.push(p);
    }
    list.sort((a, b) => b.rating - a.rating || a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' }));
    list.forEach((p, i) => { p.rank = i + 1; });
    return list;
  }

  const CSS = `
.pt-gr-overlay { position:absolute; left:0; top:0; width:100%; height:100%; z-index:50; display:flex; flex-direction:column;
  background:rgb(20,20,30); color:var(--text-color); font-family:ForcedSquare, system-ui, sans-serif; pointer-events:auto; }
.pt-gr-overlay.hidden { display:none; }
.pt-gr-head { display:flex; align-items:center; gap:10px; padding:12px 16px; background:var(--surface-color); flex-wrap:wrap; }
.pt-gr-head h1 { margin:0; font-size:28px; font-weight:normal; flex:1; white-space:nowrap; }
.pt-gr-head .button { font-size:22px; padding:6px 14px; }
.pt-gr-body { flex:1; overflow-y:auto; padding:14px 16px; }
.pt-gr-note { font-size:16px; opacity:0.85; margin:4px 0 10px; max-width:1150px; line-height:1.4; }
.pt-gr-how { font-size:15px; opacity:0.85; margin:0 0 12px; max-width:1150px; line-height:1.45; }
.pt-gr-how summary { cursor:pointer; font-size:16px; }
.pt-gr-progress { height:6px; background:rgba(255,255,255,0.1); margin:6px 0 12px; }
.pt-gr-progress > div { height:100%; background:#ffc84a; width:0; transition:width 0.2s linear; }
.pt-gr-tools { display:flex; gap:8px; align-items:center; margin:0 0 10px; flex-wrap:wrap; }
.pt-gr-tools input { font-family:inherit; font-size:18px; padding:6px 10px; width:260px; background:var(--surface-secondary-color); color:var(--text-color); border:none; }
.pt-gr-tools .button { font-size:18px; padding:5px 12px; }
.pt-gr-tools .pages { margin-left:auto; display:flex; gap:6px; align-items:center; font-size:16px; }
table.pt-gr-table { width:100%; border-collapse:collapse; font-size:17px; }
table.pt-gr-table th { text-align:left; opacity:0.7; font-weight:normal; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.15); white-space:nowrap; }
table.pt-gr-table td { padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.06); white-space:nowrap; }
table.pt-gr-table td.r { text-align:right; } table.pt-gr-table th.r { text-align:right; }
table.pt-gr-table tr.p { cursor:pointer; }
table.pt-gr-table tr.p:hover td { background:rgba(255,255,255,0.06); }
table.pt-gr-table tr.me td { background:rgba(255,200,74,0.14); }
table.pt-gr-table td.rating { color:#ffc84a; }
table.pt-gr-table img.flag { height:14px; margin-right:6px; vertical-align:-1px; }
table.pt-gr-table tr.detail > td { background:rgba(255,255,255,0.04); white-space:normal; padding:8px 12px 12px; }
table.pt-gr-sub { width:100%; border-collapse:collapse; font-size:15px; margin-top:6px; }
table.pt-gr-sub td, table.pt-gr-sub th { padding:2px 6px; border-bottom:1px solid rgba(255,255,255,0.05); }
table.pt-gr-sub th { opacity:0.65; font-weight:normal; text-align:left; }
.pt-gr-bar { display:inline-block; vertical-align:middle; width:80px; height:7px; margin-left:6px; background:rgba(255,255,255,0.08); }
.pt-gr-bar > i { display:block; height:100%; background:#4fb3ff; }
`;

  const PTGlobalRank = {
    overlay: null,
    list: null,               // rated players, best first
    boards: [],
    page: 0,
    query: '',
    open_: null,              // userId whose details are showing
    batch: null,

    init() {
      const st = el('style'); st.id = 'pt-globalrank-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Escape' && this.overlay && !this.overlay.classList.contains('hidden')) {
          e.preventDefault(); e.stopImmediatePropagation(); this.close();
        }
      }, true);
    },

    selectionRefreshed(root) {
      try {
        const bar = root && root.querySelector(':scope > .bar');
        if (!bar || bar.querySelector('.pt-gr-open')) return;
        const b = el('button', 'button pt-gr-open');
        b.innerHTML = '<img class="button-icon" src="images/trophy.svg"> ';
        b.appendChild(document.createTextNode('Ranking'));
        b.title = 'A global ranking of every player found on the official and community leaderboards';
        b.addEventListener('click', () => this.open());
        bar.appendChild(b);
      } catch (e) { console.warn('[globalrank] bar', e); }
    },

    trackList() {
      const out = [];
      const lib = window.__ptTracks;
      if (!lib) return out;
      try { lib.forEachOfficialTrack((id, g, m) => out.push({ id, name: (m && m.name) || 'Track', type: 'official' })); } catch { }
      try { lib.forEachCommunityTrack((id, g, m) => out.push({ id, name: (m && m.name) || 'Track', type: 'community' })); } catch { }
      return out;
    },

    myId() { try { return window.__ptProfiles.getCurrentUserProfile().tokenHash; } catch { return null; } },
    toast(text) { if (window.PTRuns && window.PTRuns.toast) window.PTRuns.toast(text); },

    // ---------------------------------------------------------------- data
    /** Whatever boards are already in the cache: no requests. */
    async loadCached() {
      const B = window.PTBoards;
      if (!B) return [];
      const tracks = this.trackList();
      const recs = await Promise.all(tracks.map((t) => B.cached(t, true).catch(() => null)));
      return recs.map((r, i) => (r ? Object.assign({}, r, { name: tracks[i].name, type: tracks[i].type, entries: r.entries.slice(0, TOP) }) : null)).filter(Boolean);
    },

    recompute(boards) {
      this.list = rate(boards);
      // the players now hold what the page shows; keep only each board's outline, not its 1000 runs
      this.boards = boards.map((b) => ({ id: b.id, name: b.name, type: b.type, total: b.total, at: b.at, n: b.entries.length }));
      this.oldest = boards.reduce((m, b) => Math.min(m, b.at), Infinity);
    },

    /** Reads every track's top runs (what is missing or a day old; `force`: all of them), rating as it goes. */
    async runAll(force) {
      if (this.batch) return;
      const B = window.PTBoards;
      if (!B) return this.toast('The leaderboard cache is not loaded.');
      const tracks = this.trackList();
      if (!tracks.length) return this.toast('The track list is not loaded yet.');
      const b = { total: tracks.length, done: 0, failed: 0, stopped: false, startedAt: Date.now(), requests: B.requests };
      this.batch = b;
      this.lastError = null;
      this.render();
      // boards from earlier stay in the ranking until their track is read again
      const boards = new Map((await this.loadCached()).map((r) => [r.id, r]));
      let fails = 0;
      for (const t of tracks) {
        if (b.stopped) break;
        try {
          const board = await B.top(t, TOP, { verified: true, force });
          boards.set(t.id, Object.assign({}, board, { name: t.name, type: t.type }));
          fails = 0;
        } catch (e) {
          b.failed++; fails++;
          this.lastError = t.name + ': ' + this.explain(e);
          if (fails >= 3) { this.lastError = 'stopped after 3 failures in a row — ' + this.explain(e); break; }
        }
        b.done++;
        if (b.done === 1 || b.done % 5 === 0) this.recompute([...boards.values()]);
        this.render();
      }
      this.recompute([...boards.values()]);
      this.batch = null;
      this.render();
      this.toast(b.stopped ? 'Ranking: stopped.' : 'Ranking: ' + num(this.list.length) + ' players from ' + this.boards.length + ' tracks.');
      this.release();
    },

    explain(e) {
      const msg = (e && e.message) || String(e);
      if (/Failed to connect/i.test(msg) && !window.electron && !window.PTApiBase) return 'The official leaderboard only answers the desktop game.';
      return msg;
    },

    // ---------------------------------------------------------------- the screen
    async open() {
      this.build();
      this.overlay.classList.remove('hidden');
      if (!this.list && !this.batch) {
        this.status.textContent = 'Reading what has been fetched before…';
        this.recompute(await this.loadCached());
      }
      this.render();
    },

    close() {
      if (!this.overlay) return;
      this.overlay.classList.add('hidden');
      this.release();
    },

    /** While the page is shut, lets go of the boards and the list (IndexedDB has them); an update keeps them until it ends. */
    release() {
      if (this.batch || !this.overlay || !this.overlay.classList.contains('hidden')) return;
      this.list = null; this.boards = []; this.open_ = null;
      if (this.tableHost) this.tableHost.textContent = '';
    },

    build() {
      if (this.overlay) return;
      const o = el('div', 'pt-gr-overlay hidden');
      const head = el('div', 'pt-gr-head');
      head.appendChild(el('h1', null, 'Global ranking'));
      const go = el('button', 'button', 'Update');
      go.title = 'Read the tracks not read yet, or read more than a day ago';
      go.addEventListener('click', () => this.runAll(false));
      const again = el('button', 'button', 'Refresh all');
      again.title = 'Read every track again';
      again.addEventListener('click', () => this.runAll(true));
      const stop = el('button', 'button', 'Stop');
      stop.addEventListener('click', () => { if (this.batch) this.batch.stopped = true; });
      const close = el('button', 'button', 'Close');
      close.addEventListener('click', () => this.close());
      head.append(go, again, stop, close);
      o.appendChild(head);

      const body = el('div', 'pt-gr-body');
      this.status = el('p', 'pt-gr-note');
      body.appendChild(this.status);
      this.bar = el('div', 'pt-gr-progress'); this.bar.appendChild(el('div'));
      body.appendChild(this.bar);
      const how = el('details', 'pt-gr-how');
      how.appendChild(el('summary', null, 'How players are rated'));
      for (const line of [
        'Every official and community track’s top ' + TOP + ' verified runs are read. Each result scores by how far up that track’s whole field it sits: log₁₀(players on the leaderboard ÷ position) — #1 of 7 million scores 6.85, #100 of 7 million 4.85, #1 of 30 000 4.48. A bigger field is harder to top, so the same position counts for more on it.',
        'Equal times share a place (two players on the record time both hold it), and runs the leaderboard marks invalid or removed push no one down — so a position here can be a little better than the one the leaderboard shows.',
        'A player’s rating adds their results up best first, each next one counting 5 % less (×0.95, ×0.95², …), the way osu! weighs performance points: strong on many tracks beats strong on one, and the fortieth track still adds a little.',
        'It can’t be perfect. Players outside a track’s top ' + TOP + ' aren’t found on it; popular official tracks have the biggest fields, so they weigh more than smaller community tracks whose players are often stronger; and the leaderboards are only as clean as their verified runs.',
      ]) how.appendChild(el('p', null, line));
      body.appendChild(how);

      const tools = el('div', 'pt-gr-tools');
      const search = el('input');
      search.type = 'text'; search.placeholder = 'Find a player…'; search.spellcheck = false;
      search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.page = 0; this.renderTable(); });
      for (const t of ['keydown', 'keyup', 'keypress']) search.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      const me = el('button', 'button', 'Find me');
      me.addEventListener('click', () => this.findMe());
      this.pages = el('div', 'pages');
      tools.append(search, me, this.pages);
      body.appendChild(tools);
      this.searchBox = search;
      this.tableHost = el('div');
      body.appendChild(this.tableHost);
      o.appendChild(body);
      (document.getElementById('ui') || document.body).appendChild(o);
      this.overlay = o;
      this.controls = { go, again, stop };
    },

    render() {
      if (!this.overlay) return;
      const b = this.batch, tracks = this.trackList().length;
      this.controls.go.disabled = !!b; this.controls.again.disabled = !!b; this.controls.stop.disabled = !b;
      if (b) {
        const left = b.total - b.done;
        const eta = b.done ? Math.round(((Date.now() - b.startedAt) / b.done) * left / 1000) : null;
        this.status.textContent = 'Reading leaderboards: ' + b.done + ' of ' + b.total + ' tracks' + (b.failed ? ' (' + b.failed + ' failed)' : '')
          + (eta != null && left ? ' · about ' + (eta >= 60 ? Math.round(eta / 60) + ' min' : eta + ' s') + ' left' : '')
          + (this.list && this.list.length ? ' · ' + num(this.list.length) + ' players so far' : '') + '…';
        this.bar.firstChild.style.width = (100 * b.done / Math.max(1, b.total)).toFixed(1) + '%';
      } else if (this.list && this.list.length) {
        this.status.textContent = num(this.list.length) + ' players rated from ' + this.boards.length + ' of ' + tracks
          + ' tracks (the top ' + TOP + ' verified runs of each)' + (isFinite(this.oldest) ? ' · oldest data ' + ago(this.oldest) : '')
          + (this.boards.length < tracks ? ' · press Update to read the rest' : '') + (this.lastError ? ' · last problem: ' + this.lastError : '');
        this.bar.firstChild.style.width = (100 * this.boards.length / Math.max(1, tracks)).toFixed(1) + '%';
      } else {
        this.status.textContent = 'Nothing read yet. Update reads the top ' + TOP + ' runs of all ' + tracks + ' official and community tracks — '
          + (2 * tracks) + ' requests, about ' + Math.max(1, Math.round(tracks * 1.7 / 60)) + ' minutes, kept for a day and shared with the Z-scores.'
          + (this.lastError ? ' Last problem: ' + this.lastError : '');
        this.bar.firstChild.style.width = '0';
      }
      this.renderTable();
    },

    filtered() {
      const list = this.list || [];
      if (!this.query) return list;
      return list.filter((p) => p.nickname.toLowerCase().includes(this.query));
    },

    findMe() {
      const id = this.myId();
      const list = this.list || [];
      const i = list.findIndex((p) => p.userId === id);
      if (i < 0) return this.toast(list.length ? 'You aren’t in the top ' + TOP + ' of any track read so far.' : 'Nothing read yet.');
      this.query = ''; this.searchBox.value = '';
      this.page = Math.floor(i / PER_PAGE);
      this.open_ = id;
      this.renderTable();
      const row = this.tableHost.querySelector('tr.me');
      if (row) row.scrollIntoView({ block: 'center' });
    },

    renderTable() {
      if (!this.tableHost) return;
      const rows = this.filtered();
      const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
      this.page = Math.min(this.page, pages - 1);
      this.pages.textContent = '';
      const nav = (label, to, off) => {
        const b = el('button', 'button', label);
        b.disabled = off;
        b.addEventListener('click', () => { this.page = to; this.renderTable(); });
        this.pages.appendChild(b);
      };
      nav('‹', this.page - 1, this.page === 0);
      this.pages.appendChild(el('span', null, 'page ' + (this.page + 1) + ' of ' + pages));
      nav('›', this.page + 1, this.page >= pages - 1);
      this.tableHost.textContent = '';
      if (!rows.length) {
        if (this.list && this.list.length) this.tableHost.appendChild(el('p', 'pt-gr-note', 'No player matches.'));
        return;
      }
      const me = this.myId();
      const table = el('table', 'pt-gr-table');
      table.innerHTML = '<tr><th class="r">#</th><th>Player</th><th class="r">Rating</th><th class="r">Tracks</th><th class="r">WRs</th>'
        + '<th class="r">Top 3</th><th class="r">Top 10</th><th>Best result</th></tr>';
      for (const p of rows.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE)) {
        const tr = el('tr', 'p' + (p.userId === me ? ' me' : ''));
        tr.appendChild(el('td', 'r', String(p.rank)));
        const name = el('td');
        if (p.countryCode) { const f = el('img', 'flag'); f.src = 'images/countries/' + p.countryCode + '.svg'; f.loading = 'lazy'; name.appendChild(f); }
        name.append(p.nickname + (p.userId === me ? ' (you)' : ''));
        tr.appendChild(name);
        tr.appendChild(el('td', 'r rating', p.rating.toFixed(2)));
        tr.appendChild(el('td', 'r', String(p.tracks)));
        tr.appendChild(el('td', 'r', String(p.wrs)));
        tr.appendChild(el('td', 'r', String(p.podiums)));
        tr.appendChild(el('td', 'r', String(p.top10)));
        tr.appendChild(el('td', null, '#' + p.best.pos + ' ' + p.best.track + ' (' + topPct(p.best.pos, p.best.total) + ')'));
        tr.addEventListener('click', () => { this.open_ = this.open_ === p.userId ? null : p.userId; this.renderTable(); });
        table.appendChild(tr);
        if (this.open_ === p.userId) table.appendChild(this.detailRow(p));
      }
      this.tableHost.appendChild(table);
    },

    detailRow(p) {
      const tr = el('tr', 'detail');
      const td = el('td');
      td.colSpan = 8;
      const top = el('div', 'pt-gr-tools');
      top.appendChild(el('span', null, p.nickname + ' — rating ' + p.rating.toFixed(2) + ' from ' + p.tracks + (p.tracks === 1 ? ' track' : ' tracks')
        + (p.tracks > 10 ? ' · the best 10 make up ' + Math.round(100 * p.results.slice(0, 10).reduce((s, x) => s + x.points, 0) / p.rating) + '% of it' : '')));
      if (window.PTProfile && window.PTProfile.open) {
        const prof = el('button', 'button', 'Profile');
        prof.addEventListener('click', (e) => { e.stopPropagation(); window.PTProfile.open(p.userId, p.nickname, p.countryCode); });
        top.appendChild(prof);
      }
      td.appendChild(top);
      const sub = el('table', 'pt-gr-sub');
      sub.innerHTML = '<tr><th>Track</th><th>Position</th><th>Time</th><th>Standing</th><th>Score</th><th>Counts ×</th><th>Points</th></tr>';
      const best = p.results[0] ? p.results[0].score : 1;
      for (const x of p.results.slice(0, 40)) {
        const r = el('tr');
        r.appendChild(el('td', null, x.track));
        r.appendChild(el('td', null, '#' + num(x.pos) + (x.tied ? ' (tied)' : '') + ' of ' + num(x.total)));
        r.appendChild(el('td', null, fmtTime(x.frames)));
        r.appendChild(el('td', null, topPct(x.pos, x.total)));
        const sc = el('td', null, x.score.toFixed(2));
        const bar = el('span', 'pt-gr-bar'); const fill = el('i'); fill.style.width = (100 * x.score / Math.max(best, 1e-9)).toFixed(1) + '%';
        bar.appendChild(fill); sc.appendChild(bar);
        r.appendChild(sc);
        r.appendChild(el('td', null, x.weight.toFixed(3)));
        r.appendChild(el('td', null, x.points.toFixed(2)));
        sub.appendChild(r);
      }
      td.appendChild(sub);
      if (p.results.length > 40) td.appendChild(el('p', 'pt-gr-note', 'and ' + (p.results.length - 40) + ' more tracks, adding ' + p.results.slice(40).reduce((s, x) => s + x.points, 0).toFixed(2) + ' together.'));
      tr.appendChild(td);
      return tr;
    },
  };

  PTGlobalRank.rate = rate;
  window.PTGlobalRank = PTGlobalRank;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTGlobalRank.init());
  else PTGlobalRank.init();
})();
