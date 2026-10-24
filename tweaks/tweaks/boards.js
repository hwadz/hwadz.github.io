/*
 * PolyTrack Tweaks — the top of each leaderboard, fetched once and shared.
 *
 * Z-scores and the global ranking both need the best runs of many leaderboards. They get them from
 * here: through the game's own leaderboard client, at most 500 runs a request (the most the server
 * hands out), one request at a time with half a second between them, and only when a button asks.
 * What came back is kept for a day in IndexedDB, so restarting the game doesn't ask again, and not in
 * memory (a full read of every track is tens of megabytes; memory only stands in when IndexedDB is
 * unavailable). A request for more runs than are kept only fetches the part that is missing.
 */
(function () {
  'use strict';

  const PAGE = 500;                    // the most runs the server hands out per request
  const GAP_MS = 500;                  // pause between two requests
  const TTL = 24 * 3600 * 1000;        // how long a board is good for
  const DB_NAME = 'pt-boards', STORE = 'tops';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const framesOf = (v) => (v == null ? null : typeof v === 'number' ? v : (typeof v.numberOfFrames === 'number' ? v.numberOfFrames : Number(v)));

  const PTBoards = {
    TTL,
    mem: new Map(),                    // used only when IndexedDB is unavailable
    inflight: new Map(),
    queue: Promise.resolve(),
    lastRequestAt: 0,
    dbp: null,
    requests: 0,                       // how many requests went out this session

    base() { return window.PTApiBase || 'kodub'; },
    key(id, verified) { return this.base() + '|' + (verified ? 'v' : 'a') + '|' + id; },

    /** One request at a time, with a pause between them, whoever asks. */
    request(fn) {
      const run = async () => {
        const wait = this.lastRequestAt + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        this.requests++;
        try { return await fn(); } finally { this.lastRequestAt = Date.now(); }
      };
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => { });
      return p;
    },

    // ---------------------------------------------------------------- storage
    db() {
      if (this.dbp) return this.dbp;
      this.dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
      return this.dbp;
    },
    async read(key) {
      const db = await this.db();
      if (!db) return this.mem.get(key) || null;
      return new Promise((resolve) => {
        try {
          const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    },
    async write(key, rec) {
      const db = await this.db();
      if (!db) { this.mem.set(key, rec); return; }
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(rec, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch { resolve(); }
      });
    },

    /** A board that is already here, without asking the server (null if there is none). */
    async cached(track, verified) { return this.read(this.key(track.id, verified)); },

    fresh(rec) { return !!rec && Date.now() - rec.at < TTL; },

    // ---------------------------------------------------------------- fetching
    /**
     * The best `n` runs of a track's leaderboard, best first:
     * { id, total, at, complete, entries: [{ pos, userId, nickname, countryCode, frames, verifiedState, date }] }.
     * `verified` asks for verified runs only (the game's default for official and community tracks).
     */
    async top(track, n, { verified = true, force = false } = {}) {
      const key = this.key(track.id, verified);
      while (this.inflight.has(key)) { try { await this.inflight.get(key); } catch { } }
      let rec = await this.read(key);
      if (!force && this.fresh(rec) && (rec.complete || rec.entries.length >= n)) return this.slice(rec, n);
      const p = this.fetch(track, n, verified, force || !this.fresh(rec) ? null : rec);
      this.inflight.set(key, p);
      try { rec = await p; } finally { this.inflight.delete(key); }
      await this.write(key, rec);
      return this.slice(rec, n);
    },

    slice(rec, n) { return rec.entries.length <= n ? rec : Object.assign({}, rec, { entries: rec.entries.slice(0, n) }); },

    async fetch(track, n, verified, have) {
      const api = window.__ptApi;
      if (!api || typeof api.getLeaderboard !== 'function') throw new Error('The leaderboard is not available yet.');
      // the server wants the player's token hash with every leaderboard request, as the game sends it
      let token = '';
      try { token = window.__ptProfiles.getCurrentUserProfile().tokenHash || ''; } catch { }
      const entries = have ? have.entries.slice() : [];
      let total = have ? have.total : null, complete = false;
      for (let skip = entries.length; skip < n; skip += PAGE) {
        const amount = Math.min(PAGE, n - skip);
        const res = await this.request(() => api.getLeaderboard(token, track.id, skip, amount, verified));
        total = res.total;
        res.entries.forEach((e, i) => {
          entries.push({ pos: skip + i + 1, userId: e.userId, nickname: e.nickname, countryCode: e.countryCode || null,
            frames: framesOf(e.frames), verifiedState: e.verifiedState, date: e.time instanceof Date ? e.time.getTime() : null });
        });
        if (res.entries.length < amount || skip + amount >= total) { complete = true; break; }
      }
      return { id: track.id, name: track.name, type: track.type, verified, total, at: have ? have.at : Date.now(), complete, entries };
    },
  };

  window.PTBoards = PTBoards;
})();
