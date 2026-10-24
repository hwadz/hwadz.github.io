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
.pt-gr-overlay td.rating { font-size:24px; }
.pt-gr-overlay td .pt-dim { margin-left:8px; font-size:0.8em; }
.pt-gr-overlay tr.detail > td { height:auto; padding:12px 16px 14px; white-space:normal; background-color:var(--surface-tertiary-color); }
.pt-gr-overlay tr.detail table.pt-list { margin-top:8px; font-size:18px; border-spacing:0 3px; }
.pt-gr-overlay tr.detail table.pt-list td { height:30px; }
.pt-gr-overlay .pt-gr-head { display:flex; align-items:center; gap:12px; font-size:20px; }
.pt-gr-overlay .pt-gr-head > span { flex:1 1 auto; }
.pt-gr-overlay .pt-gr-how { display:none; }
.pt-gr-overlay.how .pt-gr-how { display:block; }
.track-selection-ui > .bar > .button.pt-gr-open { margin:8px 12px 8px 0; }
`;

  const PTGlobalRank = {
    overlay: null,
    ui: null,                 // the screen (tweaks/ui.js)
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
        if (e.code === 'Escape' && this.ui && this.ui.open) {
          e.preventDefault(); e.stopImmediatePropagation(); this.close();
        }
      }, true);
    },

    selectionRefreshed(root) {
      try {
        // the Play screen's track list only: the editor's Load dialog is the same list, drawn over the editor
        if (!root || root.classList.contains('with-background')) return;
        const bar = root.querySelector(':scope > .bar');
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
    toast(text) { if (window.PTUI) window.PTUI.toast(text); },

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
      this.ui.show();
      if (!this.list && !this.batch) {
        this.ui.sub.textContent = 'Reading what has been fetched before…';
        this.recompute(await this.loadCached());
      }
      this.render();
    },

    close() {
      if (!this.ui) return;
      this.ui.hide();
      this.release();
    },

    /** While the page is shut, lets go of the boards and the list (IndexedDB has them); an update keeps them until it ends. */
    release() {
      if (this.batch || !this.ui || this.ui.open) return;
      this.list = null; this.boards = []; this.open_ = null;
      if (this.tableHost) this.tableHost.textContent = '';
    },

    build() {
      if (this.ui) return;
      const U = window.PTUI;
      const shown = (sel) => { const e = document.querySelector(sel); return e && e.offsetParent !== null ? e : null; };
      const P = U.page({
        cls: 'pt-gr-overlay', title: 'Global ranking', tools: true, pager: true,
        onBack: () => this.close(),
        behind: () => [shown('.track-selection-ui')],
      });
      this.ui = P;
      this.overlay = P.root;

      const search = U.search('Find a player…', (v) => { this.query = v.trim().toLowerCase(); this.page = 0; this.renderTable(); });
      this.searchBox = search.input;
      const me = U.button('Find me', 'pin.svg');
      me.title = 'Jump to your own place in the ranking';
      me.addEventListener('click', () => this.findMe());
      P.tools.append(search, me);
      this.progress = U.progress();
      P.panel.insertBefore(this.progress.root, P.content);

      const how = U.card(P.content, 'How players are rated');
      how.classList.add('pt-gr-how');
      for (const line of [
        'Every official and community track’s top ' + TOP + ' verified runs are read. Each result scores by how far up that track’s whole field it sits: log₁₀(players on the leaderboard ÷ position) — #1 of 7 million scores 6.85, #100 of 7 million 4.85, #1 of 30 000 4.48. A bigger field is harder to top, so the same position counts for more on it.',
        'Equal times share a place (two players on the record time both hold it), and runs the leaderboard marks invalid or removed push no one down — so a position here can be a little better than the one the leaderboard shows.',
        'A player’s rating adds their results up best first, each next one counting 5 % less (×0.95, ×0.95², …), the way osu! weighs performance points: strong on many tracks beats strong on one, and the fortieth track still adds a little.',
        'It can’t be perfect. Players outside a track’s top ' + TOP + ' aren’t found on it; popular official tracks have the biggest fields, so they weigh more than smaller community tracks whose players are often stronger; and the leaderboards are only as clean as their verified runs.',
      ]) how.appendChild(el('p', 'pt-note', line));
      this.tableHost = el('div', 'pt-list-wrap');
      P.content.appendChild(this.tableHost);

      const howBtn = U.button('How it works', 'help.svg');
      howBtn.addEventListener('click', () => {
        const on = P.root.classList.toggle('how');
        howBtn.classList.toggle('selected', on);
        if (on) P.content.scrollTop = 0;
      });
      const again = U.button('Refresh all', 'refresh.svg');
      again.title = 'Read every track again, even the ones read today';
      again.addEventListener('click', () => this.runAll(true));
      const go = U.button('Update', 'import.svg');
      go.title = 'Read the tracks not read yet, or read more than a day ago';
      go.addEventListener('click', () => { if (this.batch) this.batch.stopped = true; else this.runAll(false); });
      P.bar.append(howBtn, el('div', 'pt-grow'), again, go);
      this.controls = { go, again };
    },

    render() {
      if (!this.ui) return;
      const U = window.PTUI;
      const b = this.batch, tracks = this.trackList().length;
      U.relabel(this.controls.go, b ? 'Stop' : 'Update', b ? 'cancel.svg' : 'import.svg');
      this.controls.again.disabled = !!b;
      const sub = this.ui.sub;
      if (b) {
        const left = b.total - b.done;
        const eta = b.done ? Math.round(((Date.now() - b.startedAt) / b.done) * left / 1000) : null;
        sub.textContent = 'Reading leaderboards: ' + b.done + ' of ' + b.total + ' tracks' + (b.failed ? ' (' + b.failed + ' failed)' : '')
          + (eta != null && left ? ' · about ' + (eta >= 60 ? Math.round(eta / 60) + ' min' : eta + ' s') + ' left' : '')
          + (this.list && this.list.length ? ' · ' + num(this.list.length) + ' players so far' : '') + '…';
        this.progress.set(b.done / Math.max(1, b.total));
        this.progress.root.style.display = '';
      } else if (this.list && this.list.length) {
        sub.textContent = num(this.list.length) + ' players from ' + this.boards.length + ' of ' + tracks + ' tracks (the top ' + TOP + ' verified runs of each)'
          + (isFinite(this.oldest) ? ' · oldest data ' + ago(this.oldest) : '')
          + (this.boards.length < tracks ? ' · Update reads the rest' : '') + (this.lastError ? ' · last problem: ' + this.lastError : '');
        this.progress.root.style.display = 'none';
      } else {
        sub.textContent = 'Nothing read yet — Update reads the top ' + TOP + ' runs of all ' + tracks + ' official and community tracks: '
          + (2 * tracks) + ' requests, about ' + Math.max(1, Math.round(tracks * 1.7 / 60)) + ' minutes, kept for a day and shared with the Z-scores.'
          + (this.lastError ? ' Last problem: ' + this.lastError : '');
        this.progress.root.style.display = 'none';
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
      const row = this.tableHost.querySelector('tr.self');
      if (row) row.scrollIntoView({ block: 'center' });
    },

    renderTable() {
      if (!this.tableHost) return;
      const U = window.PTUI;
      const rows = this.filtered();
      const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
      this.page = Math.min(this.page, pages - 1);
      U.pager(this.ui.pages, this.page, pages, (to) => { this.page = to; this.renderTable(); this.ui.content.scrollTop = 0; });
      this.tableHost.textContent = '';
      if (!rows.length) {
        if (this.list && this.list.length) this.tableHost.appendChild(el('p', 'pt-note', 'No player matches.'));
        return;
      }
      const me = this.myId();
      const table = U.list([['#', 'r'], 'Player', ['Rating', 'r'], ['Tracks', 'r'], ['WRs', 'r'], ['Top 3', 'r'], ['Top 10', 'r'], 'Best result'], 'pt-gr-table');
      for (const p of rows.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE)) {
        const tr = el('tr', 'click' + (p.userId === me ? ' self' : '') + (this.open_ === p.userId ? ' open' : ''));
        const pos = el('td', 'r');
        pos.appendChild(U.ordinal(p.rank));
        tr.appendChild(pos);
        const name = el('td');
        if (p.countryCode) { const f = el('img', 'flag'); f.src = 'images/countries/' + p.countryCode + '.svg'; f.loading = 'lazy'; name.appendChild(f); }
        name.append(p.nickname);
        if (p.userId === me) name.appendChild(el('span', 'pt-dim', 'you'));
        tr.appendChild(name);
        tr.appendChild(el('td', 'r rating', p.rating.toFixed(2)));
        tr.appendChild(el('td', 'r', String(p.tracks)));
        tr.appendChild(el('td', 'r' + (p.wrs ? ' pt-gold' : ''), String(p.wrs)));
        tr.appendChild(el('td', 'r', String(p.podiums)));
        tr.appendChild(el('td', 'r', String(p.top10)));
        const best = el('td', null, p.best.track);
        best.appendChild(el('span', 'pt-dim', '#' + p.best.pos + ' · ' + topPct(p.best.pos, p.best.total)));
        tr.appendChild(best);
        tr.addEventListener('click', () => { this.open_ = this.open_ === p.userId ? null : p.userId; this.renderTable(); });
        table.appendChild(tr);
        if (this.open_ === p.userId) table.appendChild(this.detailRow(p));
      }
      this.tableHost.appendChild(table);
    },

    detailRow(p) {
      const U = window.PTUI;
      const tr = el('tr', 'detail');
      const td = el('td');
      td.colSpan = 8;
      const head = el('div', 'pt-gr-head');
      head.appendChild(el('span', null, p.nickname + ' — rating ' + p.rating.toFixed(2) + ' from ' + p.tracks + (p.tracks === 1 ? ' track' : ' tracks')
        + (p.tracks > 10 ? ' · the best 10 make up ' + Math.round(100 * p.results.slice(0, 10).reduce((s, x) => s + x.points, 0) / p.rating) + '% of it' : '')));
      if (window.PTProfile && window.PTProfile.open) {
        const prof = U.button('Profile', 'helmet.svg');
        prof.classList.add('small');
        prof.addEventListener('click', (e) => { e.stopPropagation(); window.PTProfile.open(p.userId, p.nickname, p.countryCode); });
        head.appendChild(prof);
      }
      td.appendChild(head);
      const sub = U.list(['Track', ['Position', 'r'], ['Time', 'r'], ['Standing', 'r'], ['Score', 'r'], ['Counts ×', 'r'], ['Points', 'r']]);
      const best = p.results[0] ? p.results[0].score : 1;
      for (const x of p.results.slice(0, 40)) {
        const r = el('tr');
        r.appendChild(el('td', null, x.track));
        r.appendChild(el('td', 'r', '#' + num(x.pos) + (x.tied ? ' (tied)' : '') + ' of ' + num(x.total)));
        r.appendChild(el('td', 'r', fmtTime(x.frames)));
        r.appendChild(el('td', 'r', topPct(x.pos, x.total)));
        const sc = el('td', 'r', x.score.toFixed(2));
        sc.appendChild(U.meter(x.score / Math.max(best, 1e-9)));
        r.appendChild(sc);
        r.appendChild(el('td', 'r', x.weight.toFixed(3)));
        r.appendChild(el('td', 'r', x.points.toFixed(2)));
        sub.appendChild(r);
      }
      td.appendChild(sub);
      if (p.results.length > 40) td.appendChild(el('p', 'pt-note', 'and ' + (p.results.length - 40) + ' more tracks, adding ' + p.results.slice(40).reduce((s, x) => s + x.points, 0).toFixed(2) + ' together.'));
      tr.appendChild(td);
      return tr;
    },
  };

  PTGlobalRank.rate = rate;
  window.PTGlobalRank = PTGlobalRank;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTGlobalRank.init());
  else PTGlobalRank.init();
})();
