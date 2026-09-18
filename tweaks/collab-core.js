/*
 * PolyTrack Tweaks — collaborative editor: core logic.
 *
 * Pure logic, no DOM / three.js / network, so the exact same code runs in the game and in
 * Node simulation tests. Everything that can make two players' tracks diverge is decided here.
 *
 * Model of a session
 * ------------------
 *  - The HOST is the single authority. Every change becomes an "op" with a sequence number and
 *    is sent to every client over an ordered, reliable channel, so every copy applies the same
 *    ops in the same order.
 *  - Each peer keeps a MIRROR: its own copy of the authoritative track (parts, environment, sun,
 *    name, author). The editor's 3D track is only a VIEW of mirror + the peer's own not-yet-
 *    confirmed edits. The view is shared with test drives, so it can be stale; the mirror never is.
 *  - A local edit is applied to the view immediately (stock editor code does that), captured as a
 *    net diff, and sent to the host. The host validates it and broadcasts the final op. The author
 *    then reconciles: rewind its predictions, apply the confirmed op, replay what is still pending.
 *  - Parts are identified by their FULL identity (id, position, rotation, axis, colour, checkpoint
 *    order, start order) and handled as a multiset, so array order never affects any outcome.
 *  - "Same spot" conflicts are per grid tile: a change to a tile that another player modified after
 *    the edit's base sequence number is skipped (atomically for every part on that tile).
 */
(function (root) {
  'use strict';

  const PROTOCOL = 2;
  const MOD_ID = 'polytrack-tweaks-collab-editor';
  const LIMITS = {
    partsPerOp: 200000,
    snapshotParts: 2000000,
    coord: 1 << 24,
    order: 65535,
    nameLength: 64,
  };

  // ---------------------------------------------------------------- parts ----------------------

  function partKey(p) {
    return (
      p.id + '|' + p.x + '|' + p.y + '|' + p.z + '|' + p.rotation + '|' + p.rotationAxis + '|' + p.color +
      '|' + (p.checkpointOrder == null ? '' : p.checkpointOrder) + '|' + (p.startOrder == null ? '' : p.startOrder)
    );
  }

  function clonePart(p) {
    return {
      id: p.id, x: p.x, y: p.y, z: p.z, rotation: p.rotation, rotationAxis: p.rotationAxis, color: p.color,
      checkpointOrder: p.checkpointOrder == null ? null : p.checkpointOrder,
      startOrder: p.startOrder == null ? null : p.startOrder,
    };
  }

  const encodePart = (p) => [p.id, p.x, p.y, p.z, p.rotation, p.rotationAxis, p.color, p.checkpointOrder, p.startOrder];

  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

  /**
   * Validate + normalise one part from untrusted input. Returns a clean part or null.
   * `rules` supplies game knowledge: tilesOf(id, rotation, axis), isStart(id), isCheckpoint(id),
   * colorValid(id, color). Anything the game's setPart would throw on is rejected here instead, so
   * applying an op can never fail half-way.
   */
  function sanitizePart(raw, rules, { allowNullStartOrder = false } = {}) {
    let a = raw;
    if (Array.isArray(raw)) {
      if (raw.length !== 9) return null;
      a = { id: raw[0], x: raw[1], y: raw[2], z: raw[3], rotation: raw[4], rotationAxis: raw[5], color: raw[6],
        checkpointOrder: raw[7], startOrder: raw[8] };
    }
    if (a == null || typeof a !== 'object') return null;
    const { id, x, y, z, rotation, rotationAxis, color } = a;
    if (!isInt(id) || !isInt(x) || !isInt(y) || !isInt(z) || !isInt(rotation) || !isInt(rotationAxis) || !isInt(color)) return null;
    if (Math.abs(x) > LIMITS.coord || Math.abs(z) > LIMITS.coord || y < 0 || y > LIMITS.coord) return null;
    if (rotation < 0 || rotation > 3) return null;
    let tiles;
    try { tiles = rules.tilesOf(id, rotation, rotationAxis); } catch (e) { return null; }
    if (!tiles || !tiles.length) return null;
    for (const t of tiles) if (y + t[1] < 0) return null; // the game throws "Track part below ground"
    try { if (!rules.colorValid(id, color)) return null; } catch (e) { return null; }
    let cp = a.checkpointOrder == null ? null : a.checkpointOrder;
    let so = a.startOrder == null ? null : a.startOrder;
    const isCp = rules.isCheckpoint(id), isSt = rules.isStart(id);
    if (isCp) { if (!isInt(cp) || cp < 0 || cp > LIMITS.order) return null; } else if (cp !== null) return null;
    if (isSt) {
      if (so === null) { if (!allowNullStartOrder) return null; }
      else if (!isInt(so) || so < 0 || so > LIMITS.order) return null;
    } else if (so !== null) return null;
    return { id, x, y, z, rotation, rotationAxis, color, checkpointOrder: cp, startOrder: so };
  }

  function sanitizePartList(list, rules, opts) {
    if (!Array.isArray(list) || list.length > (opts && opts.max || LIMITS.partsPerOp)) return null;
    const out = [];
    for (const raw of list) {
      const p = sanitizePart(raw, rules, opts);
      if (p === null) return null;
      out.push(p);
    }
    return out;
  }

  function sanitizeMeta(raw, rules) {
    if (raw == null || typeof raw !== 'object') return null;
    const str = (v) => (v == null ? null : typeof v === 'string' ? v.slice(0, LIMITS.nameLength) : undefined);
    const name = str(raw.name), author = str(raw.author);
    if (name === undefined || author === undefined) return null;
    if (!rules.environmentValid(raw.environment)) return null;
    if (typeof raw.sun !== 'number' || !Number.isFinite(raw.sun) || raw.sun < -1e6 || raw.sun > 1e6) return null;
    return { name, author, environment: raw.environment, sun: raw.sun };
  }

  // -------------------------------------------------------------- hashing ----------------------

  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  const metaHash = (m) => fnv(JSON.stringify([m.name, m.author, m.environment, m.sun]), 0x9e3779b9);

  // --------------------------------------------------------------- mirror ----------------------

  class Mirror {
    constructor(rules) {
      this.rules = rules;
      this.parts = new Map(); // key -> { p, n }
      this.startOrders = new Map(); // startOrder -> count
      this.tileSeq = new Map(); // "x|y|z" -> { seq, author }   (host only)
      this.tileCache = new Map();
      this.seq = 0;
      this.snapshotSeq = 0;
      this.meta = { name: null, author: null, environment: null, sun: 0 };
      this.lastModified = 0;
      this.hA = 0; this.hB = 0;
      this.size = 0;
    }

    tiles(p) {
      const k = p.id + '|' + p.rotation + '|' + p.rotationAxis;
      let t = this.tileCache.get(k);
      if (!t) { t = this.rules.tilesOf(p.id, p.rotation, p.rotationAxis); this.tileCache.set(k, t); }
      return t;
    }

    tileKeys(p) {
      const out = [];
      for (const t of this.tiles(p)) out.push((p.x + t[0]) + '|' + (p.y + t[1]) + '|' + (p.z + t[2]));
      return out;
    }

    countKey(k) { const e = this.parts.get(k); return e ? e.n : 0; }

    add(p) {
      const k = partKey(p);
      const e = this.parts.get(k);
      if (e) e.n++; else this.parts.set(k, { p: clonePart(p), n: 1 });
      if (p.startOrder != null && this.rules.isStart(p.id)) this.startOrders.set(p.startOrder, (this.startOrders.get(p.startOrder) || 0) + 1);
      this.hA = (this.hA + fnv(k, 0x811c9dc5)) >>> 0;
      this.hB = (this.hB + fnv(k, 0x01000193)) >>> 0;
      this.size++;
    }

    remove(p) {
      const k = partKey(p);
      const e = this.parts.get(k);
      if (!e) return false;
      if (--e.n === 0) this.parts.delete(k);
      if (p.startOrder != null && this.rules.isStart(p.id)) {
        const c = (this.startOrders.get(p.startOrder) || 0) - 1;
        if (c <= 0) this.startOrders.delete(p.startOrder); else this.startOrders.set(p.startOrder, c);
      }
      this.hA = (this.hA - fnv(k, 0x811c9dc5)) >>> 0;
      this.hB = (this.hB - fnv(k, 0x01000193)) >>> 0;
      this.size--;
      return true;
    }

    /** Same rule as the game's getNextStartOrder(): highest start order + 1. */
    nextStartOrder() { let m = -1; for (const k of this.startOrders.keys()) if (k > m) m = k; return m + 1; }

    load(parts, meta) {
      this.parts.clear(); this.startOrders.clear(); this.tileSeq.clear();
      this.hA = 0; this.hB = 0; this.size = 0;
      for (const p of parts) this.add(p);
      this.meta = { name: meta.name, author: meta.author, environment: meta.environment, sun: meta.sun };
    }

    list() {
      const out = [];
      for (const { p, n } of this.parts.values()) for (let i = 0; i < n; i++) out.push(p);
      return out;
    }

    hash() {
      return (this.hA >>> 0).toString(16) + '.' + (this.hB >>> 0).toString(16) + '.' + (metaHash(this.meta) >>> 0).toString(16) + '.' + this.size;
    }

    touch(parts, seq, author) {
      for (const p of parts) for (const t of this.tileKeys(p)) this.tileSeq.set(t, { seq, author });
    }
  }

  /** Hash of an arbitrary part list + meta, computed the same way as Mirror.hash(). */
  function hashOf(parts, meta) {
    let a = 0, b = 0;
    for (const p of parts) { const k = partKey(p); a = (a + fnv(k, 0x811c9dc5)) >>> 0; b = (b + fnv(k, 0x01000193)) >>> 0; }
    return (a >>> 0).toString(16) + '.' + (b >>> 0).toString(16) + '.' + (metaHash(meta) >>> 0).toString(16) + '.' + parts.length;
  }

  // ------------------------------------------------------------- recorder ----------------------

  /**
   * Turns the raw sequence of track-model calls made by stock editor code into a NET diff.
   * (A paste in overlap mode can add, remove and re-add the same part within one action; applying
   * "removed then added" naively would not reproduce that. Net multiset deltas always do.)
   */
  class Recorder {
    constructor() { this.reset(); }
    reset() { this.delta = new Map(); this.whole = false; this.meta = false; this.any = false; }
    add(p) { this._bump(p, +1); }
    remove(p) { this._bump(p, -1); }
    _bump(p, d) {
      const k = partKey(p);
      const e = this.delta.get(k);
      if (e) e.n += d; else this.delta.set(k, { p: clonePart(p), n: d });
      this.any = true;
    }
    markWhole() { this.whole = true; this.any = true; }
    markMeta() { this.meta = true; this.any = true; }
    take() {
      const removed = [], added = [];
      const keys = Array.from(this.delta.keys()).sort();
      for (const k of keys) {
        const { p, n } = this.delta.get(k);
        for (let i = 0; i < -n; i++) removed.push(clonePart(p));
        for (let i = 0; i < n; i++) added.push(clonePart(p));
      }
      const out = { removed, added, whole: this.whole, meta: this.meta };
      this.reset();
      return out;
    }
  }

  // ------------------------------------------------------------ multisets ----------------------

  function counts(list) {
    const m = new Map();
    for (const p of list) { const k = partKey(p); const e = m.get(k); if (e) e.n++; else m.set(k, { p, n: 1 }); }
    return m;
  }
  /** a − b as a multiset list */
  function minus(a, b) {
    const cb = counts(b), out = [];
    for (const p of a) { const e = cb.get(partKey(p)); if (e && e.n > 0) e.n--; else out.push(p); }
    return out;
  }

  // -------------------------------------------------------------- session ----------------------

  /**
   * One per peer. `view` is the rendered track (the editor), `send` delivers a message to the host
   * (clients), `broadcast`/`sendTo` deliver to clients (host). All callbacks are synchronous.
   *
   * view interface:
   *   isLive()            -> boolean  (false while the shared track is being used by a test drive)
   *   removeExact(part)   -> boolean
   *   add(part)           -> boolean
   *   replaceAll(parts, meta)
   *   setMeta(meta, lastModifiedMs)
   *   getMeta()           -> { name, author, environment, sun }
   *   listParts()         -> parts
   *   flush()                              refresh meshes / UI after a batch
   *   highlight(op)                        optional: visualise a teammate's change
   * events: onEvent(type, detail)  types: skipped, hostOnly, historyReset, resynced, desync, error, entryEmpty
   */
  class Session {
    constructor(opts) {
      this.role = opts.role;
      this.myId = opts.myId;
      this.rules = opts.rules;
      this.view = opts.view;
      this.send = opts.send || (() => {});
      this.broadcast = opts.broadcast || (() => {});
      this.sendTo = opts.sendTo || (() => {});
      this.onEvent = opts.onEvent || (() => {});
      this.now = opts.now || (() => Date.now());
      this.mirror = new Mirror(this.rules);
      this.pending = []; // client: local edits not yet confirmed by the host
      this.cid = 0;
      this.lastLocal = null;
      this.viewStale = false;
      this.ended = false;
    }

    get isHost() { return this.role === 'host'; }

    // ---------------- setup
    /** Host: adopt the current editor track as the authoritative state. */
    initHostFromView() {
      this.mirror.load(this.view.listParts(), this.view.getMeta());
      this.mirror.seq = 0; this.mirror.snapshotSeq = 0; this.mirror.lastModified = this.now();
    }

    snapshotMessage() {
      return { t: 'snapshot', seq: this.mirror.seq, meta: this.mirror.meta, lastModified: this.mirror.lastModified,
        parts: this.mirror.list().map(encodePart), hash: this.mirror.hash() };
    }

    // ---------------- local edits (both roles)
    /**
     * diff: { removed, added, whole, meta } from Recorder.take(); tag: { kind, entry }.
     * The view already reflects the diff (stock editor code made the change).
     */
    commitLocal(diff, tag) {
      if (this.ended) return;
      tag = tag || { kind: 'edit', entry: null };
      if (!this.isHost) {
        if (diff.whole) {
          // whole-track actions are host-only; put the track back
          this.rebuildView();
          this.onEvent('hostOnly', { what: 'track' });
          return;
        }
        if (diff.meta) {
          this.view.setMeta(this.mirror.meta, this.mirror.lastModified);
          this.onEvent('hostOnly', { what: 'settings' });
        }
        if (!diff.removed.length && !diff.added.length) return;
        const record = { cid: ++this.cid, kind: tag.kind, entry: tag.entry || null, diff, applied: { removed: diff.removed, added: diff.added }, op: null };
        const entrySeq = tag.entry && typeof tag.entry.__ptSeq === 'number' ? tag.entry.__ptSeq : null;
        const baseSeq = tag.kind !== 'edit' && entrySeq !== null ? Math.min(entrySeq, this.mirror.seq) : this.mirror.seq;
        this.pending.push(record);
        this.lastLocal = record;
        this.send({ t: 'intent', cid: record.cid, kind: tag.kind, baseSeq, removed: diff.removed.map(encodePart), added: diff.added.map(encodePart) });
        return;
      }

      // ---------------- host
      if (diff.whole) {
        this.mirror.load(this.view.listParts(), this.view.getMeta());
        this.mirror.seq++; this.mirror.snapshotSeq = this.mirror.seq; this.mirror.lastModified = this.now();
        this.broadcast(this.snapshotMessage());
        this.lastLocal = null;
        return;
      }
      if (diff.meta) this.hostMeta(this.view.getMeta());
      if (!diff.removed.length && !diff.added.length) return;
      const entrySeq = tag.entry && typeof tag.entry.__ptSeq === 'number' ? tag.entry.__ptSeq : null;
      const baseSeq = tag.kind !== 'edit' && entrySeq !== null ? entrySeq : this.mirror.seq;
      const op = this.processIntent(this.myId, { cid: 0, kind: tag.kind, baseSeq, removed: diff.removed, added: diff.added });
      // Bring the host's own view in line with what was actually accepted.
      if (this.view.isLive() && !this.viewStale) {
        for (const p of minus(diff.added, op.added)) this.view.removeExact(p);
        for (const p of minus(diff.removed, op.removed)) this.view.add(p);
        for (const p of minus(op.removed, diff.removed)) this.view.removeExact(p);
        for (const p of minus(op.added, diff.added)) this.view.add(p);
        this.view.flush();
      } else this.viewStale = true;
      const record = { cid: 0, kind: tag.kind, entry: tag.entry || null, diff, op: null };
      this.lastLocal = record;
      this.confirm(record, op);
      this.broadcast(op);
    }

    /** Stock code pushed an undo/redo entry right after the commit it belongs to. */
    linkEntry(entry) {
      const r = this.lastLocal;
      if (!r || r.entry) return;
      r.entry = entry;
      if (r.op) this.applyConfirm(r);
    }

    confirm(record, op) {
      record.op = op;
      if (record.entry) this.applyConfirm(record);
      if (op.skipped > 0) this.onEvent('skipped', { count: op.skipped, kind: record.kind });
    }

    applyConfirm(r) {
      const e = r.entry, op = r.op;
      if (r.kind === 'undo') { e.added = op.removed.map(clonePart); e.removed = op.added.map(clonePart); }
      else { e.added = op.added.map(clonePart); e.removed = op.removed.map(clonePart); }
      e.__ptSeq = op.seq;
      if (!e.added.length && !e.removed.length) this.onEvent('entryEmpty', { entry: e, kind: r.kind });
    }

    hostMeta(meta) {
      const m = sanitizeMeta(meta, this.rules);
      if (!m) return;
      const cur = this.mirror.meta;
      if (m.name === cur.name && m.author === cur.author && m.environment === cur.environment && m.sun === cur.sun) return;
      this.mirror.meta = m;
      this.mirror.seq++;
      this.mirror.lastModified = this.now();
      this.broadcast({ t: 'meta', seq: this.mirror.seq, meta: m, time: this.mirror.lastModified, hash: this.mirror.hash() });
    }

    // ---------------- host: authoritative processing
    processIntent(author, intent) {
      const m = this.mirror;
      const seq = m.seq + 1;
      const all = intent.removed.concat(intent.added);
      const reject = () => {
        m.seq = seq;
        return { t: 'op', seq, author, cid: intent.cid, kind: intent.kind, removed: [], added: [], time: this.now(), hash: m.hash(), skipped: all.length };
      };
      if (intent.baseSeq < m.snapshotSeq) return reject();

      // tiles another player changed after this edit's base
      const conflict = new Set();
      for (const p of all) for (const t of m.tileKeys(p)) {
        const ts = m.tileSeq.get(t);
        if (ts && ts.seq > intent.baseSeq && ts.author !== author) conflict.add(t);
      }
      const touches = (p) => { for (const t of m.tileKeys(p)) if (conflict.has(t)) return true; return false; };

      let accR, accA;
      for (let guard = 0; guard < 64; guard++) {
        accR = intent.removed.filter((p) => !touches(p));
        // a removal must still be exactly present (with multiplicity); if not, its tiles changed
        let grew = false;
        for (const [k, { p, n }] of counts(accR)) {
          if (m.countKey(k) < n) { for (const t of m.tileKeys(p)) if (!conflict.has(t)) { conflict.add(t); grew = true; } }
        }
        if (!grew) break;
      }
      accA = intent.added.filter((p) => !touches(p));

      for (const p of accR) m.remove(p);
      const finalA = [];
      for (const p0 of accA) {
        const p = clonePart(p0);
        if (this.rules.isStart(p.id) && (p.startOrder == null || m.startOrders.has(p.startOrder))) p.startOrder = m.nextStartOrder();
        m.add(p);
        finalA.push(p);
      }
      m.seq = seq;
      m.touch(accR, seq, author);
      m.touch(finalA, seq, author);
      m.lastModified = this.now();
      return { t: 'op', seq, author, cid: intent.cid, kind: intent.kind, removed: accR, added: finalA, time: m.lastModified,
        hash: m.hash(), skipped: all.length - accR.length - accA.length };
    }

    /** Host: a message from client `from`. Returns false if the client sent garbage. */
    hostReceive(from, msg) {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.t === 'intent') {
        if (!isInt(msg.cid) || !isInt(msg.baseSeq) || typeof msg.kind !== 'string' || !['edit', 'undo', 'redo'].includes(msg.kind)) return false;
        const removed = sanitizePartList(msg.removed, this.rules);
        const added = sanitizePartList(msg.added, this.rules, { allowNullStartOrder: true });
        if (!removed || !added) return false;
        const op = this.processIntent(from, { cid: msg.cid, kind: msg.kind, baseSeq: Math.min(msg.baseSeq, this.mirror.seq), removed, added });
        this.broadcast(op);
        this.applyRemoteToView(op);
        return true;
      }
      if (msg.t === 'resync') { this.sendTo(from, this.snapshotMessage()); return true; }
      if (msg.t === 'meta' || msg.t === 'whole') { this.sendTo(from, this.snapshotMessage()); return true; } // host-only; resend truth
      return false;
    }

    // ---------------- client: host messages
    /** Returns false on a protocol violation (caller should leave the session). */
    clientReceive(msg) {
      if (!msg || typeof msg !== 'object') return false;
      const m = this.mirror;
      if (msg.t === 'snapshot') {
        if (!isInt(msg.seq)) return false;
        const meta = sanitizeMeta(msg.meta, this.rules);
        const parts = sanitizePartList(msg.parts, this.rules, { max: LIMITS.snapshotParts });
        if (!meta || !parts) return false;
        m.load(parts, meta);
        m.seq = msg.seq; m.snapshotSeq = msg.seq;
        m.lastModified = isInt(msg.lastModified) ? msg.lastModified : this.now();
        this.pending = []; this.lastLocal = null;
        this.onEvent('historyReset', {});
        this.rebuildView();
        if (typeof msg.hash === 'string' && msg.hash !== m.hash()) { this.onEvent('desync', { at: 'snapshot' }); this.send({ t: 'resync' }); }
        return true;
      }
      if (msg.t === 'meta') {
        if (!isInt(msg.seq)) return false;
        if (msg.seq <= m.seq) return true;
        if (msg.seq !== m.seq + 1) { this.send({ t: 'resync' }); return true; }
        const meta = sanitizeMeta(msg.meta, this.rules);
        if (!meta) return false;
        m.meta = meta; m.seq = msg.seq;
        m.lastModified = isInt(msg.time) ? msg.time : this.now();
        if (this.view.isLive() && !this.viewStale) { this.view.setMeta(meta, m.lastModified); this.view.flush(); }
        else this.viewStale = true;
        this.checkHash(msg.hash);
        return true;
      }
      if (msg.t === 'op') {
        if (!isInt(msg.seq) || !isInt(msg.author) || !isInt(msg.cid)) return false;
        if (msg.seq <= m.seq) return true; // already covered by a snapshot
        if (msg.seq !== m.seq + 1) { this.send({ t: 'resync' }); return true; }
        const removed = sanitizePartList(msg.removed, this.rules);
        const added = sanitizePartList(msg.added, this.rules);
        if (!removed || !added) return false;
        const op = { seq: msg.seq, author: msg.author, cid: msg.cid, kind: msg.kind, removed, added,
          time: isInt(msg.time) ? msg.time : this.now(), skipped: isInt(msg.skipped) ? msg.skipped : 0 };
        // mirror first — it is the truth regardless of what the view can do right now
        let ok = true;
        for (const p of removed) ok = m.remove(p) && ok;
        for (const p of added) m.add(p);
        m.seq = op.seq; m.lastModified = op.time;
        if (!ok) { this.onEvent('desync', { at: 'op', seq: op.seq }); this.send({ t: 'resync' }); return true; }

        const own = op.author === this.myId && this.pending.length > 0 && this.pending[0].cid === op.cid;
        if (own) {
          const r = this.pending.shift();
          this.reconcileView(op, r);
          this.confirm(r, op);
        } else {
          this.reconcileView(op, null);
          if (op.author !== this.myId && this.view.highlight) this.view.highlight(op);
        }
        this.checkHash(msg.hash);
        return true;
      }
      return false;
    }

    checkHash(h) {
      if (typeof h === 'string' && h !== this.mirror.hash()) {
        this.onEvent('desync', { at: 'hash', seq: this.mirror.seq });
        this.send({ t: 'resync' });
      }
    }

    applyRemoteToView(op) {
      // host view: the op came from a client and is already authoritative
      if (!this.view.isLive() || this.viewStale) { this.viewStale = true; return; }
      for (const p of op.removed) this.view.removeExact(p);
      for (const p of op.added) this.view.add(p);
      this.view.flush();
      if (op.author !== this.myId && this.view.highlight) this.view.highlight(op);
    }

    // ---------------- client view reconciliation
    reconcileView(op, ownRecord) {
      if (!this.view.isLive() || this.viewStale) { this.viewStale = true; return; }
      const v = this.view;
      const stack = ownRecord ? [ownRecord].concat(this.pending) : this.pending;

      if (ownRecord && this.pending.length === 0 && sameLists(ownRecord.applied, op)) return; // prediction was exact
      if (!ownRecord && (stack.length === 0 || !this.intersects(op, stack))) {
        for (const p of op.removed) v.removeExact(p);
        for (const p of op.added) v.add(p);
        v.flush();
        return;
      }
      // rewind every prediction, apply the confirmed op, replay what is still pending
      for (let i = stack.length - 1; i >= 0; i--) {
        const a = stack[i].applied;
        for (const p of a.added) v.removeExact(p);
        for (const p of a.removed) v.add(p);
      }
      for (const p of op.removed) v.removeExact(p);
      for (const p of op.added) v.add(p);
      for (const r of this.pending) {
        const applied = { removed: [], added: [] };
        for (const p of r.diff.removed) if (v.removeExact(p)) applied.removed.push(p);
        for (const p of r.diff.added) if (v.add(p)) applied.added.push(p);
        r.applied = applied;
      }
      v.flush();
    }

    intersects(op, records) {
      const tiles = new Set();
      for (const p of op.removed.concat(op.added)) for (const t of this.mirror.tileKeys(p)) tiles.add(t);
      for (const r of records) for (const p of r.applied.removed.concat(r.applied.added)) {
        for (const t of this.mirror.tileKeys(p)) if (tiles.has(t)) return true;
      }
      return false;
    }

    /** Rebuild the view from mirror + pending predictions (after snapshots, test drives, repairs). */
    rebuildView() {
      if (!this.view.isLive()) { this.viewStale = true; return; }
      this.view.replaceAll(this.mirror.list(), this.mirror.meta);
      this.view.setMeta(this.mirror.meta, this.mirror.lastModified);
      for (const r of this.pending) {
        const applied = { removed: [], added: [] };
        for (const p of r.diff.removed) if (this.view.removeExact(p)) applied.removed.push(p);
        for (const p of r.diff.added) if (this.view.add(p)) applied.added.push(p);
        r.applied = applied;
      }
      this.viewStale = false;
      this.view.flush();
    }

    /** Hash the view should have: mirror plus this peer's own pending predictions. */
    expectedViewHash() {
      let parts = this.mirror.list();
      for (const r of this.pending) { parts = minus(parts, r.applied.removed).concat(r.applied.added); }
      return hashOf(parts, this.mirror.meta);
    }

    /** Periodic safety net: if the view drifted from what it should be (an edit path we did not see), repair it. */
    verifyView() {
      if (!this.view.isLive()) return true;
      if (this.viewStale) { this.rebuildView(); return false; }
      const actual = hashOf(this.view.listParts(), this.view.getMeta());
      if (actual !== this.expectedViewHash()) { this.rebuildView(); this.onEvent('repaired', {}); return false; }
      return true;
    }
  }

  function sameLists(applied, op) {
    if (applied.removed.length !== op.removed.length || applied.added.length !== op.added.length) return false;
    return minus(applied.removed, op.removed).length === 0 && minus(applied.added, op.added).length === 0;
  }

  const api = { PROTOCOL, MOD_ID, LIMITS, partKey, clonePart, encodePart, sanitizePart, sanitizePartList, sanitizeMeta,
    Mirror, Recorder, Session, hashOf, minus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PTCollabCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
