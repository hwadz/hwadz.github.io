/*
 * Signaling server for the PolyTrack Tweaks collaborative editor.
 *
 * Only job: introduce two browsers to each other. The host opens a socket and gets an invite code; a
 * joiner sends that code with a WebRTC offer; this server passes the offer, the answer and the ICE
 * candidates between them. Once they are connected everything (track data, cursors, cars) flows
 * directly peer-to-peer and this server is out of the picture — it never sees track data.
 *
 * It speaks the same message shapes as Kodub's own signaling server, so the game code is unchanged.
 * A web build points at it through tweaks/collab-config.js; the desktop build keeps using Kodub's.
 *
 *   npm install && npm start          (PORT=8787 by default)
 *
 * Environment:
 *   PORT              port to listen on (default 8787)
 *   INVITE_MINUTES    how long an invite code stays valid (default 60)
 *   MAX_SESSIONS      how many hosts at once (default 200)
 *   ALLOWED_ORIGINS   comma-separated list; empty means any origin may connect
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const INVITE_MS = Math.max(1, Number(process.env.INVITE_MINUTES || 60)) * 60000;
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 200));
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_PENDING_JOINERS = 8;
const MAX_MESSAGE = 96 * 1024;   // an SDP offer is a few KB
const HELLO_MS = 15000;          // a socket that says nothing is dropped
const IDLE_MS = 90000;           // the host pings every 25 s
const MAX_CONNECTIONS_PER_IP = 30;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

/** @type {Map<string, Session>} */ const byCode = new Map();
/** @type {Map<string, Session>} */ const byKey = new Map();
/** @type {Map<string, number>} */ const connectionsPerIp = new Map();

const randomString = (n, alphabet) => {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};
const freshCode = () => { let c; do { c = randomString(8, CODE_ALPHABET); } while (byCode.has(c)); return c; };
const send = (ws, obj) => { if (ws && ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch {} } };
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/** Passed through to the host so it can reach the joiner; the joiner chose them, so keep it small and plain. */
function cleanIceServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 8)) {
    if (!s || typeof s !== 'object') continue;
    const urls = typeof s.urls === 'string' ? [s.urls] : Array.isArray(s.urls) ? s.urls.filter((u) => typeof u === 'string' && u.length <= 200).slice(0, 8) : [];
    if (!urls.length) continue;
    const entry = { urls };
    if (typeof s.username === 'string' && s.username.length <= 200) entry.username = s.username;
    if (typeof s.credential === 'string' && s.credential.length <= 200) entry.credential = s.credential;
    out.push(entry);
  }
  return out;
}

class Session {
  constructor(ws, nickname) {
    this.ws = ws;
    this.key = crypto.randomUUID();
    this.code = freshCode();
    this.nickname = nickname;
    this.joiners = new Map(); // session id -> { ws, accepted }
    byCode.set(this.code, this);
    byKey.set(this.key, this);
    this.arm();
  }
  /** A code lives for INVITE_MINUTES; players already connected are peer-to-peer and unaffected. */
  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { try { this.ws.close(); } catch {} }, INVITE_MS);
  }
  renew() {
    byCode.delete(this.code);
    this.code = freshCode();
    byCode.set(this.code, this);
    this.arm();
  }
  close() {
    clearTimeout(this.timer);
    byCode.delete(this.code);
    byKey.delete(this.key);
    for (const j of this.joiners.values()) { try { j.ws.close(); } catch {} }
    this.joiners.clear();
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('polytrack collab signaling: ok (' + byCode.size + ' open invites)\n');
    return;
  }
  res.writeHead(404).end();
});

const hostServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
const joinServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if ((connectionsPerIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return socket.destroy();
  }
  const wss = path === '/host' ? hostServer : path === '/join' ? joinServer : null;
  if (!wss) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.ip = ip;
    ws.on('close', () => {
      const n = (connectionsPerIp.get(ip) || 1) - 1;
      if (n > 0) connectionsPerIp.set(ip, n); else connectionsPerIp.delete(ip);
    });
    wss.emit('connection', ws, req);
  });
});

/** Keeps a socket only while it is talking: an unused relay socket is dropped. */
function armIdle(ws) {
  clearTimeout(ws.idle);
  ws.idle = setTimeout(() => { try { ws.close(); } catch {} }, IDLE_MS);
}
function onJson(ws, handler) {
  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > MAX_MESSAGE) return ws.close();
    armIdle(ws);
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return ws.close(); }
    if (!msg || typeof msg !== 'object') return ws.close();
    try { handler(msg); } catch (e) { console.error('handler failed:', e && e.message); ws.close(); }
  });
}

hostServer.on('connection', (ws) => {
  let session = null;
  armIdle(ws);
  const hello = setTimeout(() => { if (!session) try { ws.close(); } catch {} }, HELLO_MS);

  onJson(ws, (msg) => {
    switch (msg.type) {
      case 'createInvite': {
        const nickname = str(msg.nickname, 64) || 'Anonymous';
        const key = str(msg.key, 64);
        if (!session) {
          const existing = key ? byKey.get(key) : null;
          if (existing && existing.ws === ws) session = existing;
          else if (existing) { try { existing.ws.close(); } catch {} }
          if (!session) {
            if (byCode.size >= MAX_SESSIONS) { send(ws, { type: 'error', error: 'TotalHostLimit' }); return ws.close(); }
            session = new Session(ws, nickname);
          }
        } else session.renew();
        clearTimeout(hello);
        send(ws, { type: 'createInvite', inviteCode: session.code, key: session.key, timeoutMilliseconds: INVITE_MS, censoredNickname: session.nickname });
        break;
      }
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      case 'acceptJoin': {
        if (!session) return;
        const j = session.joiners.get(str(msg.session, 64));
        if (!j) return;
        j.accepted = true;
        send(j.ws, { type: 'acceptJoin', answer: str(msg.answer, MAX_MESSAGE), mods: Array.isArray(msg.mods) ? msg.mods.slice(0, 16) : [],
          isModsVanillaCompatible: !!msg.isModsVanillaCompatible, clientId: Number.isInteger(msg.clientId) ? msg.clientId : 0 });
        break;
      }
      case 'declineJoin': {
        if (!session) return;
        const id = str(msg.session, 64), j = session.joiners.get(id);
        if (!j) return;
        send(j.ws, { type: 'declineJoin', reason: str(msg.reason, 64) || 'MalformedClientData' });
        session.joiners.delete(id);
        setTimeout(() => { try { j.ws.close(); } catch {} }, 250);
        break;
      }
      case 'iceCandidate': {
        if (!session) return;
        const j = session.joiners.get(str(msg.session, 64));
        if (j) send(j.ws, { type: 'iceCandidate', candidate: msg.candidate == null ? null : msg.candidate });
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => { clearTimeout(hello); clearTimeout(ws.idle); if (session) session.close(); });
  ws.on('error', () => { try { ws.close(); } catch {} });
});

joinServer.on('connection', (ws) => {
  let session = null, id = null;
  armIdle(ws);
  const hello = setTimeout(() => { if (!session) try { ws.close(); } catch {} }, HELLO_MS);

  onJson(ws, (msg) => {
    if (!session) {
      const code = str(msg.inviteCode, 32), offer = str(msg.offer, MAX_MESSAGE);
      if (!code || !offer) return ws.close();
      const found = byCode.get(code.toUpperCase());
      if (!found || found.ws.readyState !== found.ws.OPEN) { send(ws, { type: 'error', error: 'ExpiredInvite' }); return setTimeout(() => ws.close(), 250); }
      if (found.joiners.size >= MAX_PENDING_JOINERS) { send(ws, { type: 'declineJoin', reason: 'SessionFull' }); return setTimeout(() => ws.close(), 250); }
      clearTimeout(hello);
      session = found;
      id = crypto.randomUUID();
      session.joiners.set(id, { ws, accepted: false });
      send(session.ws, {
        type: 'joinInvite', session: id, offer,
        version: str(msg.version, 32) || '0.0.0',
        mods: Array.isArray(msg.mods) ? msg.mods.filter((m) => typeof m === 'string' && m.length <= 128).slice(0, 16) : [],
        isModsVanillaCompatible: !!msg.isModsVanillaCompatible,
        nickname: str(msg.nickname, 64) || 'Anonymous',
        countryCode: str(msg.countryCode, 8),
        carStyle: str(msg.carStyle, 256) || '',
        iceServers: cleanIceServers(msg.iceServers),
      });
      return;
    }
    if ('candidate' in msg) send(session.ws, { type: 'iceCandidate', session: id, candidate: msg.candidate == null ? null : msg.candidate });
  });

  ws.on('close', () => {
    clearTimeout(hello); clearTimeout(ws.idle);
    if (!session) return;
    const j = session.joiners.get(id);
    session.joiners.delete(id);
    // Only tell the host about a joiner that never got an answer; after that they are talking directly.
    if (j && !j.accepted) send(session.ws, { type: 'joinDisconnect', session: id });
  });
  ws.on('error', () => { try { ws.close(); } catch {} });
});

server.listen(PORT, () => {
  console.log('collab signaling listening on ' + PORT +
    ' (invites last ' + Math.round(INVITE_MS / 60000) + ' min, max ' + MAX_SESSIONS + ' hosts' +
    (ALLOWED_ORIGINS.length ? ', origins: ' + ALLOWED_ORIGINS.join(' ') : '') + ')');
});
