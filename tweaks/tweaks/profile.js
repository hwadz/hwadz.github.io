/*
 * PolyTrack Tweaks — player profiles from the leaderboard.
 *
 * Every leaderboard row gets a small "Profile" button. Clicking it asks the game's own API where
 * that player stands on every official and community track, then shows the result: how many tracks
 * they are ranked on, records, podiums, their best and typical placings, and the full list.
 *
 * Nothing is fetched until the button is pressed, results are cached for the session, and requests
 * go out a few at a time so one click never floods the server.
 */
(function () {
  'use strict';

  const CONCURRENCY = 5;             // requests in flight at once
  const TOTALS_KEY = 'pt-track-totals-v1';
  const TOTALS_TTL = 24 * 3600 * 1000;      // how long a track's field size is good for
  const RECORD_TTL = 10 * 60 * 1000;        // how long its record time is good for
  const PROFILE_TTL = 5 * 60 * 1000;        // how long a compiled profile is good for
  const log = (...a) => console.log('[profile]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // the API client hands times back as the game's Time object on some paths and a plain number on others
  const frames = (v) => (v == null ? null : typeof v === 'number' ? v : (typeof v.numberOfFrames === 'number' ? v.numberOfFrames : Number(v)));
  const fmtTime = (ms) => (window.PTRunsCore ? window.PTRunsCore.formatTime(frames(ms)) : String(ms));
  const num = (n) => (n == null ? '—' : n.toLocaleString());
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
  const percentile = (p) => (p == null ? '—' : p * 100 < 0.01 ? 'top 1 in ' + compact(1 / p) : 'top ' + (p * 100).toFixed(p * 100 < 1 ? 2 : 1) + '%');

  const CSS = `
/* Top-right of the row: the date sits lower down (the game's .verified-state is absolute with no
   top, so it keeps its flow position under the name) and the checkmark owns the last 24px. The two
   items stack instead of sitting side by side, so they steal as little width from the nickname as
   possible. */
.pt-prof-slot { position:absolute; right:26px; top:6px; display:flex; flex-direction:column; align-items:flex-end;
  gap:3px; line-height:1; pointer-events:none; }
.pt-prof-slot:empty { display:none; }
/* Reserve that width so a long nickname ellipsizes instead of running underneath the button. The
   #ui prefix is needed: the game's leaderboard stylesheet is injected lazily, after ours. */
#ui .leaderboard-ui > .container > button.main > div > .name-container { box-sizing:border-box; padding-right:110px; }
.pt-prof-btn { padding:2px 10px; font-size:15px; line-height:1.2; background:var(--button-color,#2b3570); color:var(--text-color,#eef1ff);
  border:none; cursor:pointer; pointer-events:auto; }
.pt-prof-btn:hover { background:var(--button-hover-color,#3a4a9a); }
.pt-prof-gap { font-size:16px; opacity:0.85; }
.pt-prof-gap.behind { color:#ff8f8f; }
.pt-prof-gap.ahead { color:#8ce58c; }
table.pt-prof-table th.sortable { cursor:pointer; }
table.pt-prof-table th.sortable:hover { opacity:1; text-decoration:underline; }
.pt-prof-overlay { position:absolute; left:0; top:0; width:100%; height:100%; z-index:50; display:flex; flex-direction:column;
  background:rgba(20,20,30,0.88); color:var(--text-color); font-family:ForcedSquare, system-ui, sans-serif; pointer-events:auto; }
.pt-prof-overlay.hidden { display:none; }
.pt-prof-head { display:flex; align-items:center; gap:12px; padding:12px 16px; background:var(--surface-color); }
.pt-prof-head h1 { margin:0; font-size:28px; font-weight:normal; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pt-prof-head img.flag { height:22px; }
.pt-prof-body { flex:1; overflow-y:auto; padding:16px; }
.pt-prof-tiles { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
.pt-prof-tile { background:var(--surface-color); padding:10px 14px; min-width:140px; flex:1 1 140px; }
.pt-prof-tile .v { font-size:26px; }
.pt-prof-tile .k { font-size:15px; opacity:0.75; }
.pt-prof-card { background:var(--surface-color); padding:12px 14px; margin-bottom:14px; }
.pt-prof-card h2 { margin:0 0 10px; font-size:20px; font-weight:normal; }
.pt-prof-bar { display:flex; align-items:center; gap:8px; margin:4px 0; font-size:17px; }
.pt-prof-bar .label { width:120px; opacity:0.8; }
.pt-prof-bar .track { flex:1; height:14px; background:rgba(255,255,255,0.08); }
.pt-prof-bar .fill { display:block; height:100%; min-width:2px; background:#4fb3ff; }
.pt-prof-bar .count { width:60px; text-align:right; }
table.pt-prof-table { width:100%; border-collapse:collapse; font-size:17px; }
table.pt-prof-table th { text-align:left; opacity:0.7; font-weight:normal; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.15); }
table.pt-prof-table td { padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.06); }
.pt-prof-note { font-size:16px; opacity:0.8; margin:6px 0; }
.pt-prof-progress { height:6px; background:rgba(255,255,255,0.1); margin:8px 0 14px; }
.pt-prof-progress > div { height:100%; background:#ffc84a; width:0; transition:width 0.2s linear; }
.pt-prof-gold { color:#ffd34a; }
`;

  const PTProfile = {
    page: new Map(),        // recordingId -> leaderboard entry (carries the userId we need)
    cache: new Map(),       // userId -> compiled profile
    totals: null,           // trackId -> { n: field size, wr: record time, at: when we asked }
    records: {},            // trackId -> record time, for the gap shown on each row
    recordPending: {},
    gapRows: [],            // the gap spans on the leaderboard page currently shown
    current: null,          // whose profile is on screen, so Refresh knows what to re-ask
    sort: { key: 'position', dir: 1 },
    overlay: null,
    run: 0,

    init() {
      const st = document.createElement('style');
      st.id = 'pt-profile-css'; st.textContent = CSS;
      document.head.appendChild(st);
      try { const raw = localStorage.getItem(TOTALS_KEY); this.totals = raw ? JSON.parse(raw) : {}; } catch { this.totals = {}; }
      for (const id in this.totals) if (this.totals[id] && this.totals[id].wr != null) this.records[id] = this.totals[id].wr;
    },

    /** The leaderboard page the game just loaded; entries carry userId, which the rows do not. */
    notePage(entries, trackId) {
      if (typeof trackId === 'string' && trackId !== this.trackId) { this.trackId = trackId; this.gapRows = []; }
      if (!Array.isArray(entries)) return;
      for (const e of entries) if (e && e.id != null) this.page.set(e.id, e);
      if (this.page.size > 400) { const keep = [...this.page.entries()].slice(-200); this.page = new Map(keep); }
      this.gapRows = [];
    },

    /** Adds the profile button and the gap-to-the-record readout to one leaderboard row. */
    decorate(row, recordingId, nickname, position) {
      try {
        if (!row || row.querySelector('.pt-prof-btn')) return;
        const slot = el('div', 'pt-prof-slot');
        const entry = this.page.get(recordingId);
        const theirs = entry ? frames(entry.frames) : null;
        if (position === 1 && theirs != null && this.trackId) this.noteRecord(this.trackId, theirs);
        const gap = el('span', 'pt-prof-gap');
        slot.appendChild(gap);
        if (theirs != null) {
          this.gapRows.push({ span: gap, frames: theirs });
          this.paintGap(gap, theirs);
        }
        const b = el('button', 'pt-prof-btn', 'Profile');
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();          // the row itself selects a run to watch
          const e = this.page.get(recordingId);
          if (!e || !e.userId) return this.toast('That row has no player id to look up.');
          this.open(e.userId, e.nickname || nickname, e.countryCode);
        });
        slot.appendChild(b);
        row.appendChild(slot);
        if (this.trackId) this.ensureRecord(this.trackId);
      } catch (e) { log('could not decorate a row', e); }
    },

    /** How far this run is behind the track's world record. */
    paintGap(span, theirs) {
      const wr = this.records[this.trackId];
      if (wr == null) { span.textContent = ''; return; }
      const delta = theirs - wr;                          // positive: slower than the record
      span.textContent = (delta > 0 ? '+' : '±') + fmtTime(Math.abs(delta));
      span.classList.toggle('behind', delta > 0);
      span.classList.toggle('ahead', delta <= 0);
      span.title = 'Behind the world record';
    },

    /** Remembers a track's record time and fills in any rows that were drawn before we knew it. */
    noteRecord(trackId, wr) {
      if (wr == null || this.records[trackId] === wr) return;
      this.records[trackId] = wr;
      const cached = this.totals[trackId];
      if (cached) { cached.wr = wr; this.saveTotals(); }
      if (trackId === this.trackId) for (const r of this.gapRows) this.paintGap(r.span, r.frames);
    },

    /**
     * Makes sure the track's record time is both known and recent. A known-but-old one is shown
     * straight away and replaced when the fresh answer lands, so the gaps are never blank for long
     * and never silently a day out of date.
     */
    ensureRecord(trackId) {
      if (this.recordPending[trackId]) return;
      const cached = this.totals[trackId];
      const known = cached && cached.wr != null;
      if (known && Date.now() - cached.at < RECORD_TTL) return this.noteRecord(trackId, cached.wr);
      if (known) this.noteRecord(trackId, cached.wr);
      this.recordPending[trackId] = true;
      this.topEntry(trackId).then((top) => {
        if (top) this.noteRecord(trackId, top);
      }).catch(() => {}).then(() => { this.recordPending[trackId] = false; });
    },

    toast(text) { if (window.PTRuns && window.PTRuns.toast) window.PTRuns.toast(text); else log(text); },

    api() {
      const a = window.__ptApi;
      if (!a || typeof a.getLeaderboardUserEntry !== 'function') throw new Error('the leaderboard API is unavailable');
      return a;
    },

    /** Official and community tracks, in menu order. */
    trackList() {
      const out = [];
      const library = window.__ptTracks;
      if (!library || typeof library.forEachTrack !== 'function') return out;
      library.forEachTrack((id, metadata, type) => {
        if (type !== 'official' && type !== 'community') return;
        out.push({ id, name: (metadata && metadata.name) || 'Track', type });
      });
      return out;
    },

    saveTotals() { try { localStorage.setItem(TOTALS_KEY, JSON.stringify(this.totals)); } catch {} },

    /**
     * The top of a track's leaderboard: how many players are on it, and the record time. The field
     * size barely moves, so it is kept for a day; the record can fall any minute, so when a caller
     * needs that (the gap on a leaderboard row) a ten-minute-old answer is re-asked.
     */
    async headFor(trackId, needRecord) {
      const cached = this.totals[trackId];
      const age = cached ? Date.now() - cached.at : Infinity;
      // a cache entry written before this version has no record time in it, so ask once more
      const fresh = cached && cached.n != null && cached.wr != null
        && age < (needRecord ? RECORD_TTL : TOTALS_TTL);
      if (fresh) return cached;
      let token = '';
      try { token = window.__ptProfiles.getCurrentUserProfile().tokenHash; } catch {}
      const res = await this.api().getLeaderboard(token, trackId, 0, 1, false);
      const n = res && typeof res.total === 'number' ? res.total : null;
      const first = res && Array.isArray(res.entries) ? res.entries[0] : null;
      const wr = first ? frames(first.frames != null ? first.frames : first.time) : null;
      const head = { n, wr, at: Date.now() };
      if (n != null || wr != null) this.totals[trackId] = head;
      if (wr != null) this.records[trackId] = wr;
      return head;
    },

    /** How many players are on a track's leaderboard — shared by every profile. */
    async totalFor(track) { return (await this.headFor(track.id, false)).n; },

    /** The record time on a track, for the gap shown on each leaderboard row. */
    async topEntry(trackId) {
      const head = await this.headFor(trackId, true);
      this.saveTotals();
      return head.wr;
    },

    /** Forget a compiled profile, so the next open rebuilds it. */
    invalidate(userId) { if (userId) this.cache.delete(userId); },

    /** Your own time changed, so your own profile is out of date. */
    invalidateSelf() {
      try { this.invalidate(window.__ptProfiles.getCurrentUserProfile().tokenHash); } catch { }
    },

    async open(userId, nickname, countryCode, force) {
      this.build();
      this.overlay.classList.remove('hidden');
      this.current = { userId, nickname, countryCode };
      const run = ++this.run;
      if (force) this.cache.delete(userId);
      const held = this.cache.get(userId);
      // positions move and your own time changes, so a compiled profile is only good for a few minutes
      const cached = held && Date.now() - held.at < PROFILE_TTL ? held : null;
      this.render({ userId, nickname, countryCode, rows: cached ? cached.rows : [], done: !!cached,
        failed: cached ? cached.failed : 0, total: cached ? cached.rows.length : 0, pending: 0,
        cachedAt: cached ? cached.at : null });
      if (cached) return;

      const tracks = this.trackList();
      if (!tracks.length) return this.render({ userId, nickname, countryCode, rows: [], done: true, failed: 0, error: 'The track list is not loaded yet — open Play once, then try again.' });

      const rows = [];
      let failed = 0, finished = 0;
      const queue = tracks.slice();
      const worker = async () => {
        while (queue.length) {
          if (run !== this.run) return;                    // the panel was closed or another profile opened
          const track = queue.shift();
          try {
            const entry = await this.api().getLeaderboardUserEntry(userId, track.id, false);
            if (entry && typeof entry.position === 'number') {
              let total = null;
              try { total = await this.totalFor(track); } catch {}
              rows.push({ track: track.name, type: track.type, id: track.id, position: entry.position,
                frames: frames(entry.time != null ? entry.time : entry.frames), verified: entry.verifiedState, total });
            }
          } catch (e) { failed++; }
          finished++;
          if (run === this.run && (finished % 4 === 0 || !queue.length)) {
            this.render({ userId, nickname, countryCode, rows, done: false, failed, progress: finished / tracks.length, scanned: finished, scannedOf: tracks.length });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, worker));
      if (run !== this.run) return;
      this.saveTotals();
      this.cache.set(userId, { rows, failed, at: Date.now() });
      this.render({ userId, nickname, countryCode, rows, done: true, failed, scanned: tracks.length, scannedOf: tracks.length });
    },

    close() { if (this.overlay) this.overlay.classList.add('hidden'); this.run++; },

    build() {
      if (this.overlay) return;
      const root = document.getElementById('ui') || document.body;
      const o = el('div', 'pt-prof-overlay hidden');
      const head = el('div', 'pt-prof-head');
      head.appendChild(el('h1', null, 'Profile'));
      const refresh = el('button', 'button', 'Refresh');
      refresh.title = 'Ask the leaderboard again (it is cached for a few minutes)';
      refresh.addEventListener('click', () => {
        const c = this.current;
        if (c) this.open(c.userId, c.nickname, c.countryCode, true);
      });
      head.appendChild(refresh);
      const close = el('button', 'button', 'Close');
      close.addEventListener('click', () => this.close());
      head.appendChild(close);
      o.appendChild(head);
      o.appendChild(el('div', 'pt-prof-body'));
      root.appendChild(o);
      this.overlay = o;
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Escape' && this.overlay && !this.overlay.classList.contains('hidden')) { e.stopPropagation(); this.close(); }
      }, true);
    },

    stats(rows) {
      const positions = rows.map((r) => r.position).sort((a, b) => a - b);
      const pct = rows.filter((r) => r.total).map((r) => r.position / r.total);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const median = (a) => (a.length ? (a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2) : null);
      return {
        ranked: rows.length,
        records: rows.filter((r) => r.position === 1).length,
        podiums: rows.filter((r) => r.position <= 3).length,
        top10: rows.filter((r) => r.position <= 10).length,
        top100: rows.filter((r) => r.position <= 100).length,
        top1000: rows.filter((r) => r.position <= 1000).length,
        best: positions.length ? positions[0] : null,
        average: positions.length ? Math.round(sum(positions) / positions.length) : null,
        median: median(positions),
        bestPercentile: pct.length ? Math.min(...pct) : null,
        averagePercentile: pct.length ? sum(pct) / pct.length : null,
        verified: rows.filter((r) => r.verified === 1).length,
        totalTime: sum(rows.map((r) => r.frames || 0)),
        official: rows.filter((r) => r.type === 'official').length,
        community: rows.filter((r) => r.type === 'community').length,
      };
    },

    render(state) {
      if (!this.overlay) return;
      const head = this.overlay.querySelector('.pt-prof-head h1');
      head.textContent = state.nickname || 'Profile';
      const body = this.overlay.querySelector('.pt-prof-body');
      body.textContent = '';

      for (const old of head.parentElement.querySelectorAll('img.flag')) old.remove();
      if (state.countryCode && /^[a-z]{2}$/.test(state.countryCode)) {
        const flag = el('img', 'flag');
        flag.src = 'images/countries/' + state.countryCode + '.svg';
        head.parentElement.insertBefore(flag, head.nextSibling);
      }

      if (state.error) { body.appendChild(el('p', 'pt-prof-note', state.error)); return; }

      if (state.done && state.cachedAt) {
        const age = Math.max(0, Date.now() - state.cachedAt);
        const how = age < 45000 ? 'a moment ago' : Math.round(age / 60000) + ' min ago';
        body.appendChild(el('p', 'pt-prof-note', 'Asked ' + how + '. Press Refresh for the current numbers.'));
      }

      if (!state.done) {
        const bar = el('div', 'pt-prof-progress');
        const fill = el('div');
        fill.style.width = Math.round((state.progress || 0) * 100) + '%';
        bar.appendChild(fill);
        body.appendChild(bar);
        body.appendChild(el('p', 'pt-prof-note', 'Looking this player up on every official and community track… '
          + (state.scanned || 0) + ' of ' + (state.scannedOf || '?') + ' checked.'));
      }

      const s = this.stats(state.rows);
      const tiles = el('div', 'pt-prof-tiles');
      const tile = (k, v, cls) => {
        const t = el('div', 'pt-prof-tile');
        t.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
        t.appendChild(el('div', 'k', k));
        tiles.appendChild(t);
      };
      tile('Tracks ranked', num(s.ranked));
      tile('World records', num(s.records), s.records ? 'pt-prof-gold' : null);
      tile('Podiums', num(s.podiums));
      tile('Top 10', num(s.top10));
      tile('Top 100', num(s.top100));
      tile('Top 1000', num(s.top1000));
      tile('Best placing', s.best != null ? '#' + num(s.best) : '—');
      tile('Typical placing', s.median != null ? '#' + num(Math.round(s.median)) : '—');
      if (s.bestPercentile != null) tile('Best standing', percentile(s.bestPercentile));
      if (s.averagePercentile != null) tile('Typical standing', percentile(s.averagePercentile));
      tile('Official / community', s.official + ' / ' + s.community);
      tile('Verified runs', num(s.verified));
      tile('Their times add up to', fmtTime(s.totalTime));
      body.appendChild(tiles);

      if (state.rows.length) {
        const card = el('div', 'pt-prof-card');
        card.appendChild(el('h2', null, 'Where they place'));
        const buckets = [
          ['World record', (r) => r.position === 1],
          ['Top 3', (r) => r.position > 1 && r.position <= 3],
          ['Top 10', (r) => r.position > 3 && r.position <= 10],
          ['Top 100', (r) => r.position > 10 && r.position <= 100],
          ['Top 1000', (r) => r.position > 100 && r.position <= 1000],
          ['Beyond 1000', (r) => r.position > 1000],
        ];
        const counts = buckets.map(([label, test]) => ({ label, n: state.rows.filter(test).length }));
        const max = Math.max(1, ...counts.map((c) => c.n));
        for (const c of counts) {
          const row = el('div', 'pt-prof-bar');
          row.appendChild(el('span', 'label', c.label));
          const track = el('span', 'track');
          const fill = el('span', 'fill');
          fill.style.width = (c.n / max) * 100 + '%';
          track.appendChild(fill);
          row.appendChild(track);
          row.appendChild(el('span', 'count', String(c.n)));
          card.appendChild(row);
        }
        body.appendChild(card);

        const list = el('div', 'pt-prof-card');
        list.appendChild(el('h2', null, 'Every track they are ranked on'));
        const table = el('table', 'pt-prof-table');
        const header = el('tr');
        const COLUMNS = [
          { key: 'track', label: 'Track', dir: 1, of: (r) => r.track.toLowerCase() },
          { key: 'position', label: 'Placing', dir: 1, of: (r) => r.position },
          { key: 'frames', label: 'Time', dir: 1, of: (r) => r.frames },
          // sorted by standing, not by field size: 10th of 7 000 is a worse result than 100th of 7 million
          { key: 'standing', label: 'Standing', dir: 1, of: (r) => (r.total ? r.position / r.total : Infinity) },
          { key: 'verified', label: 'Verified', dir: -1, of: (r) => (r.verified === 1 ? 1 : 0) },
        ];
        for (const col of COLUMNS) {
          const th = el('th', 'sortable', col.label + (this.sort.key === col.key ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''));
          th.title = 'Sort by ' + col.label.toLowerCase();
          th.addEventListener('click', () => {
            // first click on a column uses the direction that reads best for it, then it flips
            this.sort = this.sort.key === col.key ? { key: col.key, dir: -this.sort.dir } : { key: col.key, dir: col.dir };
            this.render(state);
          });
          header.appendChild(th);
        }
        table.appendChild(header);
        const col = COLUMNS.find((c) => c.key === this.sort.key) || COLUMNS[1];
        const dir = this.sort.dir;
        const sorted = [...state.rows].sort((a, b) => {
          const x = col.of(a), y = col.of(b);
          if (x < y) return -dir;
          if (x > y) return dir;
          return a.position - b.position;          // a stable, meaningful tie-break
        });
        for (const r of sorted) {
          const tr = el('tr');
          tr.appendChild(el('td', null, r.track + (r.type === 'community' ? ' (community)' : '')));
          tr.appendChild(el('td', r.position === 1 ? 'pt-prof-gold' : null, '#' + num(r.position)));
          tr.appendChild(el('td', null, fmtTime(r.frames)));
          tr.appendChild(el('td', null, r.total ? percentile(r.position / r.total) + ' · ' + num(r.total) : '—'));
          tr.appendChild(el('td', null, r.verified === 1 ? 'verified' : ''));
          table.appendChild(tr);
        }
        list.appendChild(table);
        body.appendChild(list);
      } else if (state.done) {
        body.appendChild(el('p', 'pt-prof-note', 'This player is not ranked on any official or community track.'));
      }

      if (state.failed) body.appendChild(el('p', 'pt-prof-note', state.failed + ' track' + (state.failed === 1 ? '' : 's') + ' could not be checked (the server did not answer).'));
    },
  };

  window.PTProfile = PTProfile;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTProfile.init());
  else PTProfile.init();
})();
