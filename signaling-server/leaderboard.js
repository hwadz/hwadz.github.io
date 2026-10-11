/*
 * A leaderboard for the PolyTrack Tweaks web build.
 *
 * Kodub's backend only answers Kodub's own domains, so a site of your own cannot read or write the
 * official leaderboard — that is their access control and this does not try to get around it. This
 * is a *separate* leaderboard: your own server, your own times, nothing to do with theirs.
 *
 * It speaks the same JSON the game's client already parses (the `v6/...` endpoints), so pointing
 * window.PTApiBase at this server is the whole client-side change.
 *
 * What it does NOT do: verify runs. It has no physics, so every entry is reported as Pending and
 * `onlyVerified` is ignored. A time here means "somebody's client said so" — which is fine for a
 * mod leaderboard among people who know that, and is why it is kept visibly separate from Kodub's.
 *
 * Environment:
 *   LEADERBOARD_FILE        where to keep the data (default ./leaderboard.json; "" disables it)
 *   LEADERBOARD_MAX_ENTRIES per-track entry cap (default 5000)
 *   LEADERBOARD_MAX_TRACKS  how many tracks to keep (default 500)
 *   ALLOWED_ORIGINS         comma-separated; also used by the signaling side. Empty means any
 *   ICE_SERVERS             JSON array returned by v6/iceServers (default two public STUN servers)
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = process.env.LEADERBOARD_FILE === '' ? null
  : path.resolve(process.env.LEADERBOARD_FILE || 'leaderboard.json');
const MAX_ENTRIES = Math.max(1, Number(process.env.LEADERBOARD_MAX_ENTRIES || 5000));
const MAX_TRACKS = Math.max(1, Number(process.env.LEADERBOARD_MAX_TRACKS || 500));
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_RECORDING = 10000;        // the client refuses to send 10000 or more
const MAX_FRAMES = 36e5;            // the game's own Recording.maxFrames
const MAX_NICKNAME = 50;
const MAX_CAR_STYLE = 256;
const MAX_BODY = 64 * 1024;
const MAX_IDS = 32;
const SAVE_DEBOUNCE_MS = 250;        // coalesces a burst without risking much on a hard kill
const READS_PER_MINUTE = 240;
const WRITES_PER_MINUTE = 20;
const PENDING = 0;                  // the game's VerifiedState.Pending

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- the store
const store = { nextId: 1, tracks: {}, users: {} };
let saveTimer = null;
let dirty = false;

function load() {
  if (!FILE) return;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      store.nextId = Number.isSafeInteger(data.nextId) && data.nextId > 0 ? data.nextId : 1;
      if (data.tracks && typeof data.tracks === 'object') store.tracks = data.tracks;
      if (data.users && typeof data.users === 'object') store.users = data.users;
    }
    console.log('leaderboard: loaded ' + Object.keys(store.tracks).length + ' tracks from ' + FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('leaderboard: could not read ' + FILE + ': ' + e.message);
  }
}

function save() {
  if (!FILE || !dirty) return;
  dirty = false;
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, FILE);                     // atomic: a crash mid-write cannot truncate the real file
  } catch (e) {
    console.warn('leaderboard: could not write ' + FILE + ': ' + e.message);
  }
}

function queueSave() {
  dirty = true;
  if (!FILE || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

// ---------------------------------------------------------------- helpers
/** Per-IP token buckets, so one client cannot hammer the server or flood the store. */
const buckets = new Map();
function allow(ip, kind) {
  const limit = kind === 'write' ? WRITES_PER_MINUTE : READS_PER_MINUTE;
  const key = kind + ':' + ip;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.at >= 60000) { b = { at: now, n: 0 }; buckets.set(key, b); }
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.at >= 60000) buckets.delete(k);
  b.n += 1;
  return b.n <= limit;
}

const isTrackId = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const clampText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const asCountry = (v) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null);

/**
 * The client builds its POST body by hand and does NOT encode `+` in the recording or car style, so
 * `+` must stay a plus here — which rules out URLSearchParams, where it would become a space.
 */
function parseBody(body) {
  const out = {};
  for (const part of String(body).split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const key = i < 0 ? part : part.slice(0, i);
    const value = i < 0 ? '' : part.slice(i + 1);
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* a stray % stays as it came in */ }
    out[key] = decoded;
  }
  return out;
}

const trackOf = (trackId) => {
  let t = store.tracks[trackId];
  if (!t) {
    if (Object.keys(store.tracks).length >= MAX_TRACKS) return null;
    t = store.tracks[trackId] = {};
  }
  return t;
};

/** Every entry on a track, best first; ties keep whoever got there earlier. */
function ranked(trackId) {
  const t = store.tracks[trackId];
  if (!t) return [];
  return Object.values(t).sort((a, b) => (a.frames - b.frames) || (a.at - b.at));
}

const publicEntry = (e) => ({
  id: e.id,
  userId: e.userId,
  nickname: e.nickname,
  countryCode: e.countryCode ?? null,
  carStyle: e.carStyle,
  frames: e.frames,
  time: new Date(e.at).toISOString(),       // the client reads this as the date the run was driven
  verifiedState: PENDING,
});

function findById(id) {
  for (const trackId of Object.keys(store.tracks)) {
    for (const e of Object.values(store.tracks[trackId])) if (e.id === id) return e;
  }
  return null;
}

// ---------------------------------------------------------------- HTTP
function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length) {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return true;
}

const json = (res, code, value) => {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ICE_SERVERS = (() => {
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS || '');
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through to the default */ }
  return [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['stun:stun.cloudflare.com:3478'] }];
})();

/**
 * Handles the game's `v6/...` endpoints. Returns true when it took the request.
 * `pathname` is the request path with no query string.
 */
async function handle(req, res, pathname, query) {
  if (!pathname.startsWith('/v6/')) return false;
  const route = pathname.slice(4).replace(/\/+$/, '');
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  if (!cors(req, res)) { json(res, 403, { error: 'origin not allowed' }); return true; }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return true; }

  const write = req.method === 'POST';
  if (!allow(ip, write ? 'write' : 'read')) { json(res, 429, { error: 'too many requests' }); return true; }

  try {
    if (route === 'leaderboard' && req.method === 'GET') return leaderboard(res, query);
    if (route === 'leaderboard' && write) return await submit(req, res);
    if (route === 'leaderboardUserEntry' && req.method === 'GET') return userEntry(res, query);
    if (route === 'recordings' && req.method === 'GET') return recordings(res, query);
    if (route === 'user' && req.method === 'GET') return user(res, query);
    if (route === 'user' && write) return await saveUser(req, res);
    if (route === 'iceServers' && req.method === 'GET') { json(res, 200, ICE_SERVERS); return true; }
    // 0.6.3 asks for a Track of the Week on startup; this server runs none, which is a valid answer
    if (route === 'trackOfTheWeek' && req.method === 'GET') {
      json(res, 200, { serverTime: new Date().toISOString(), current: null });
      return true;
    }
    if (route === 'multiplayer/host' || route === 'multiplayer/join') {
      json(res, 501, { error: 'this server does not host multiplayer races' });
      return true;
    }
  } catch (e) {
    console.warn('leaderboard: ' + route + ' failed: ' + e.message);
    json(res, 500, { error: 'server error' });
    return true;
  }
  json(res, 404, { error: 'unknown endpoint' });
  return true;
}

function leaderboard(res, q) {
  const trackId = q.get('trackId');
  if (!isTrackId(trackId)) { json(res, 400, { error: 'bad trackId' }); return true; }
  const skip = Math.max(0, Math.min(1e6, Number(q.get('skip') || 0) | 0));
  const amount = Math.max(1, Math.min(100, Number(q.get('amount') || 20) | 0));
  const me = q.get('userTokenHash');
  const all = ranked(trackId);
  const entries = all.slice(skip, skip + amount).map(publicEntry);
  let userEntry = null;
  if (isHash(me)) {
    const i = all.findIndex((e) => e.userId === me);
    if (i >= 0) userEntry = { position: i + 1, frames: all[i].frames, id: all[i].id, verifiedState: PENDING };
  }
  json(res, 200, { total: all.length, entries, userEntry });
  return true;
}

function userEntry(res, q) {
  const trackId = q.get('trackId');
  const me = q.get('userTokenHash');
  if (!isTrackId(trackId) || !isHash(me)) { json(res, 400, { error: 'bad request' }); return true; }
  const all = ranked(trackId);
  const i = all.findIndex((e) => e.userId === me);
  if (i < 0) { json(res, 200, null); return true; }
  json(res, 200, { position: i + 1, frames: all[i].frames, id: all[i].id, verifiedState: PENDING });
  return true;
}

function recordings(res, q) {
  const ids = String(q.get('ids') || '').split(',').map((s) => Number(s)).filter(Number.isSafeInteger).slice(0, MAX_IDS);
  const out = ids.map((id) => {
    const e = findById(id);
    if (!e) return null;
    return { recording: e.recording, verifiedState: PENDING, frames: e.frames, carStyle: e.carStyle };
  });
  json(res, 200, out);
  return true;
}

function user(res, q) {
  const token = q.get('userToken');
  if (typeof token !== 'string' || !token) { json(res, 400, { error: 'bad userToken' }); return true; }
  const found = store.users[sha256(token)];
  if (!found) { json(res, 200, null); return true; }
  json(res, 200, { nickname: found.nickname, countryCode: found.countryCode ?? null, carStyle: found.carStyle, isVerifier: false });
  return true;
}

async function saveUser(req, res) {
  const body = parseBody(await readBody(req, MAX_BODY));
  const token = body.userToken;
  if (typeof token !== 'string' || !token) { json(res, 400, { error: 'bad userToken' }); return true; }
  const nickname = clampText(body.nickname, MAX_NICKNAME) || 'Anonymous';
  store.users[sha256(token)] = {
    nickname,
    countryCode: asCountry(body.countryCode),
    carStyle: clampText(body.carStyle, MAX_CAR_STYLE),
    at: Date.now(),
  };
  queueSave();
  json(res, 200, {});
  return true;
}

async function submit(req, res) {
  const body = parseBody(await readBody(req, MAX_BODY));
  const trackId = body.trackId;
  const frames = Number(body.frames);
  const recording = body.recording;
  if (!isTrackId(trackId)) { json(res, 400, { error: 'bad trackId' }); return true; }
  if (!Number.isSafeInteger(frames) || frames <= 0 || frames > MAX_FRAMES) { json(res, 400, { error: 'bad frames' }); return true; }
  if (typeof recording !== 'string' || !recording || recording.length >= MAX_RECORDING) { json(res, 400, { error: 'bad recording' }); return true; }
  if (typeof body.userToken !== 'string' || !body.userToken) { json(res, 400, { error: 'bad userToken' }); return true; }

  const userId = sha256(body.userToken);
  const track = trackOf(trackId);
  if (!track) { json(res, 507, { error: 'this server is holding as many tracks as it will' }); return true; }

  const before = ranked(trackId);
  const previousIndex = before.findIndex((e) => e.userId === userId);
  const previous = previousIndex >= 0 ? before[previousIndex] : null;

  // one entry per player per track: the best run, as the game's own records work
  if (previous && previous.frames <= frames) {
    json(res, 200, { uploadId: previous.id, previousPosition: previousIndex + 1, newPosition: previousIndex + 1 });
    return true;
  }

  if (!previous && Object.keys(track).length >= MAX_ENTRIES) {
    const worst = before[before.length - 1];
    if (worst && worst.frames <= frames) {            // the board is full and this run does not make it
      json(res, 200, { uploadId: 0, previousPosition: 0, newPosition: 0 });
      return true;
    }
    if (worst) delete track[worst.userId];
  }

  const nickname = clampText(body.nickname, MAX_NICKNAME) || 'Anonymous';
  const entry = {
    id: store.nextId++,
    userId,
    nickname,
    countryCode: asCountry(body.countryCode),
    carStyle: clampText(body.carStyle, MAX_CAR_STYLE),
    frames,
    recording,
    at: Date.now(),
  };
  track[userId] = entry;
  store.users[userId] = { nickname, countryCode: entry.countryCode, carStyle: entry.carStyle, at: entry.at };
  queueSave();

  const after = ranked(trackId);
  const newPosition = after.findIndex((e) => e.userId === userId) + 1;
  json(res, 200, { uploadId: entry.id, previousPosition: previousIndex + 1, newPosition });
  return true;
}

function summary() {
  const tracks = Object.keys(store.tracks);
  let entries = 0;
  for (const t of tracks) entries += Object.keys(store.tracks[t]).length;
  return { tracks: tracks.length, entries, file: FILE, verifies: false };
}

load();
// A host stopping the service sends SIGTERM; without this the last couple of seconds of times,
// still sitting in the debounce, would be lost.
process.on('exit', () => save());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { save(); process.exit(0); });
}

module.exports = { handle, summary, _internals: { parseBody, sha256, store } };
