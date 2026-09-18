/*
 * PolyTrack Tweaks — collaborative editor: game integration.
 *
 *  - Signaling uses Kodub's own multiplayer server protocol (host/join WebSockets, invite codes,
 *    WebRTC offer/answer/ICE relay). The session declares itself as a mod through the protocol's
 *    built-in `mods` / `isModsVanillaCompatible` fields, so vanilla players and vanilla hosts refuse
 *    it cleanly and it can never mix with a race lobby. Stock race multiplayer is not touched.
 *  - Track data travels peer-to-peer on the "reliable" (ordered) data channel; cursors and cameras
 *    on the "unreliable" one.
 *  - All sync decisions live in collab-core.js; this file adapts the editor to it and draws the UI.
 */
(function () {
  'use strict';
  const Core = window.PTCollabCore;
  if (!Core) { console.error('[collab] collab-core.js not loaded'); return; }

  const GAME_VERSION = '0.6.2';
  const MAX_PLAYERS = 8;
  const CHUNK = 12000;
  const PRESENCE_MS = 100;
  const VERIFY_MS = 10000;
  const CAR_MSG = 0x43;          // binary car-state packet on the unreliable channel
  const CAR_SEND_MS = 33;        // while the car is moving
  const CAR_IDLE_MS = 400;       // keep-alive while it sits still (start line, pause menu)
  const DRIVER_STALE_MS = 2500;
  const INTERP_DELAY = 0.15;     // same playback delay as stock multiplayer
  const COLORS = ['#ff6b6b', '#4fb3ff', '#6be675', '#ffc84a', '#c77dff', '#ff8ad8', '#4af0d4', '#ff9f45'];
  const log = (...a) => console.log('[collab]', ...a);

  // ============================================================================ wire ===========

  // Large messages (snapshots after Load/Import, big pastes) are deflated with the game's own pako and sent as
  // binary frames: [0]='Z', [1..4]=message id, [5..8]=frame index, [9..12]=frame count, then the data.
  // Track JSON compresses several-fold, which matters on slow or relayed connections.
  const ZMIN = 16000;
  const ZFRAME = 16000;
  const ZMAX_OUT = 256 * 1024 * 1024;
  const pako = () => (window.__ptPako && window.__ptPako.Ay && window.__ptPako.Ay.Deflate ? window.__ptPako.Ay : null);
  const utf8 = new TextEncoder();
  let nextMessageId = 1;

  /** Encodes a message into wire frames once, so a broadcast compresses a snapshot once for every peer. */
  function encodeFrames(obj) {
    const s = JSON.stringify(obj);
    const z = s.length > ZMIN ? pako() : null;
    const id = nextMessageId++;
    if (nextMessageId > 0x7fffffff) nextMessageId = 1;
    if (z) {
      let bytes = null;
      try { const d = new z.Deflate({ level: 6 }); d.push(utf8.encode(s), true); if (!d.err) bytes = d.result; } catch {}
      if (bytes && bytes.length < s.length) {
        const n = Math.ceil(bytes.length / ZFRAME), frames = [];
        for (let i = 0; i < n; i++) {
          const part = bytes.subarray(i * ZFRAME, (i + 1) * ZFRAME), f = new Uint8Array(13 + part.length), dv = new DataView(f.buffer);
          f[0] = 0x5a; dv.setUint32(1, id, true); dv.setUint32(5, i, true); dv.setUint32(9, n, true);
          f.set(part, 13);
          frames.push(f);
        }
        return frames;
      }
    }
    if (s.length <= CHUNK) return [s];
    const n = Math.ceil(s.length / CHUNK), frames = [];
    for (let i = 0; i < n; i++) frames.push(JSON.stringify({ t: '~', id, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
    return frames;
  }

  /** Reliable channel: ordered queue, transparent chunking/compression of large messages, backpressure. */
  class Channel {
    constructor(dc, onMessage, onClose) {
      this.dc = dc; this.queue = []; this.rx = null; this.zrx = null; this.closed = false;
      dc.bufferedAmountLowThreshold = 1 << 18;
      dc.addEventListener('bufferedamountlow', () => this.flush());
      dc.addEventListener('message', (e) => {
        if (e.data instanceof ArrayBuffer) {
          const m = this.receiveFrame(e.data);
          if (m !== undefined) onMessage(m);
          return;
        }
        if (typeof e.data !== 'string') return;
        if (this.zrx) return this.fail('frame order');
        let m;
        try { m = JSON.parse(e.data); } catch { return this.fail('bad json'); }
        if (m && m.t === '~') {
          if (!Number.isInteger(m.id) || !Number.isInteger(m.i) || !Number.isInteger(m.n) || typeof m.d !== 'string' || m.n < 1 || m.n > 20000) return this.fail('bad chunk');
          if (m.i === 0) this.rx = { id: m.id, n: m.n, parts: [] };
          if (!this.rx || this.rx.id !== m.id || this.rx.parts.length !== m.i) return this.fail('chunk order');
          this.rx.parts.push(m.d);
          if (this.rx.parts.length === this.rx.n) {
            const s = this.rx.parts.join(''); this.rx = null;
            try { m = JSON.parse(s); } catch { return this.fail('bad json'); }
          } else return;
        }
        onMessage(m);
      });
      const done = () => { if (!this.closed) { this.closed = true; onClose(); } };
      dc.addEventListener('close', done);
      dc.addEventListener('error', done);
    }
    fail(why) { log('channel error:', why); try { this.dc.close(); } catch {} }

    /** Returns the decoded message once the last frame arrives, otherwise undefined. */
    receiveFrame(buf) {
      if (this.rx) return void this.fail('frame order');
      const f = new Uint8Array(buf);
      if (f.length < 14 || f[0] !== 0x5a) return void this.fail('bad frame');
      const dv = new DataView(buf), id = dv.getUint32(1, true), i = dv.getUint32(5, true), n = dv.getUint32(9, true);
      if (n < 1 || n > 20000) return void this.fail('bad frame');
      if (i === 0) this.zrx = { id, n, parts: [] };
      if (!this.zrx || this.zrx.id !== id || this.zrx.n !== n || this.zrx.parts.length !== i) return void this.fail('frame order');
      this.zrx.parts.push(f.subarray(13));
      if (this.zrx.parts.length < n) return undefined;
      const parts = this.zrx.parts;
      this.zrx = null;
      const z = pako();
      if (!z) return void this.fail('no inflater');
      const chunks = [];
      let total = 0;
      try {
        const inf = new z.Inflate();
        inf.onData = (c) => { total += c.length; if (total > ZMAX_OUT) throw new Error('too large'); chunks.push(c); };
        for (let k = 0; k < parts.length; k++) inf.push(parts[k], k === parts.length - 1);
        if (inf.err) throw new Error(inf.msg || 'inflate');
      } catch (err) { return void this.fail('inflate: ' + (err && err.message)); }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      try { return JSON.parse(new TextDecoder().decode(out)); } catch { return void this.fail('bad json'); }
    }

    send(obj) { this.sendFrames(encodeFrames(obj)); }
    sendFrames(frames) { for (const f of frames) this.queue.push(f); this.flush(); }
    flush() {
      while (this.queue.length && this.dc.readyState === 'open' && this.dc.bufferedAmount < (1 << 20)) {
        try { this.dc.send(this.queue.shift()); } catch (e) { return this.fail('send'); }
      }
    }
  }

  function makeChannels(pc) {
    const reliable = pc.createDataChannel('reliable', { negotiated: true, id: 0 });
    const unreliable = pc.createDataChannel('unreliable', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    reliable.binaryType = 'arraybuffer'; unreliable.binaryType = 'arraybuffer';
    return { reliable, unreliable };
  }

  const validCarStyle = (s) => (typeof s === 'string' && s.length <= 128 && /^[A-Za-z0-9_\-+/=]*$/.test(s) ? s : null);
  const validCountry = (c) => (typeof c === 'string' && /^[a-z]{2}$/.test(c) ? c : null);

  function api() {
    const a = window.__ptApi;
    if (!a) throw new Error('multiplayer API unavailable');
    return a;
  }

  function sanitizeIce(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const urls = typeof s.urls === 'string' ? [s.urls] : Array.isArray(s.urls) ? s.urls.filter((u) => typeof u === 'string') : [];
      if (!urls.length) continue;
      out.push({ urls, username: typeof s.username === 'string' ? s.username : undefined, credential: typeof s.credential === 'string' ? s.credential : undefined });
    }
    return out;
  }

  // ============================================================================ host net =======

  class HostNet {
    constructor(ctrl) {
      this.ctrl = ctrl; this.peers = new Map(); this.nextId = 1;
      this.ws = null; this.key = null; this.keepalive = null; this.expiry = null;
      this.invite = { state: 'idle', code: null, expiresAt: null, error: null };
    }
    get connectedCount() { let n = 0; for (const p of this.peers.values()) if (p.hello) n++; return n; }

    openInvite(fresh) {
      if (fresh) this.key = null;
      this.closeInviteSocket();
      this.invite = { state: 'loading', code: null, expiresAt: null, error: null };
      this.ctrl.renderUI();
      let ws;
      try { ws = api().createMultiplayerHostWebSocket(); }
      catch (e) { log('host socket could not be created:', e && e.message); this.invite = { state: 'error', error: 'The multiplayer server is unavailable.' }; this.ctrl.renderUI(); return; }
      log('host socket connecting');
      this.ws = ws;
      const send = (o) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(Object.assign({ version: GAME_VERSION }, o)));
      };
      ws.addEventListener('open', () => {
        log('host socket open');
        // Match stock exactly: `key` is always present (null for a fresh invite) — the server rejects it missing.
        send({ type: 'createInvite', key: this.key, nickname: this.ctrl.profile().nickname });
        this.keepalive = setInterval(() => send({ type: 'ping' }), 25000);
      });
      ws.addEventListener('close', (ev) => {
        if (this.ws !== ws) return; // an older socket closing after a renewal
        log('host socket closed; code', ev.code, 'reason', JSON.stringify(ev.reason), 'invite state was', this.invite.state);
        this.ws = null;
        clearInterval(this.keepalive); clearTimeout(this.expiry);
        if (this.invite.state === 'loading') this.invite = { state: 'error', error: "Couldn't reach the multiplayer server." };
        else if (this.invite.state === 'ready') this.invite = { state: 'expired', code: this.invite.code };
        this.ctrl.renderUI();
      });
      ws.addEventListener('message', (ev) => {
        let o;
        try { o = JSON.parse(ev.data); } catch { return; }
        if (!o || typeof o.type !== 'string') return;
        if (o.type === 'error') log('host socket error from server:', o.error);
        switch (o.type) {
          case 'error':
            this.invite = { state: 'error', error: o.error === 'IpLimit' || o.error === 'TotalHostLimit' ? 'The multiplayer server is busy. Try again in a moment.' : 'Server error: ' + String(o.error) };
            this.ctrl.renderUI(); ws.close(); break;
          case 'createInvite':
            if (typeof o.inviteCode !== 'string' || typeof o.key !== 'string') return ws.close();
            this.key = o.key;
            if (typeof o.censoredNickname === 'string') this.ctrl.setHostName(o.censoredNickname);
            this.invite = { state: 'ready', code: o.inviteCode, expiresAt: Number.isInteger(o.timeoutMilliseconds) ? Date.now() + o.timeoutMilliseconds : null, error: null };
            clearTimeout(this.expiry);
            if (Number.isInteger(o.timeoutMilliseconds) && o.timeoutMilliseconds > 0) this.expiry = setTimeout(() => ws.close(), o.timeoutMilliseconds);
            this.ctrl.renderUI(); break;
          case 'joinInvite': this.handleJoin(o, send); break;
          case 'iceCandidate': {
            const p = [...this.peers.values()].find((x) => x.session === o.session);
            if (!p) return;
            if (p.offerSet) { try { p.pc.addIceCandidate(o.candidate == null ? null : new RTCIceCandidate(o.candidate)).catch(() => {}); } catch {} }
            else p.remote.push(o.candidate);
            break;
          }
          case 'joinDisconnect': {
            const p = [...this.peers.values()].find((x) => x.session === o.session && !x.hello);
            if (p) this.dropPeer(p.id, false);
            break;
          }
          default: break; // pong and anything newer
        }
      });
    }

    closeInviteSocket() { if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch {} } clearInterval(this.keepalive); clearTimeout(this.expiry); }

    handleJoin(o, send) {
      const session = o.session;
      if (typeof session !== 'string' || typeof o.offer !== 'string') return;
      const decline = (reason) => send({ type: 'declineJoin', session, reason });
      const mods = Array.isArray(o.mods) ? o.mods : [];
      if (!mods.includes(Core.MOD_ID)) return decline('IncompatibleMods'); // vanilla/race client
      if (typeof o.nickname !== 'string') return decline('MalformedClientData');
      if (this.peers.size + 1 >= MAX_PLAYERS) return decline('SessionFull');
      const id = this.nextId++;
      const pc = new RTCPeerConnection({ iceServers: sanitizeIce(o.iceServers) });
      const { reliable, unreliable } = makeChannels(pc);
      const peer = { id, session, pc, reliable, unreliable, channel: null, name: o.nickname.slice(0, 64), hello: false, offerSet: false, remote: [], closed: false,
        carStyle: validCarStyle(o.carStyle), countryCode: validCountry(o.countryCode) };
      this.peers.set(id, peer);
      const onState = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.dropPeer(id, true); };
      pc.addEventListener('connectionstatechange', onState);
      pc.addEventListener('iceconnectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(pc.iceConnectionState)) this.dropPeer(id, true); });
      pc.onicecandidate = (e) => send({ type: 'iceCandidate', session, candidate: e.candidate });
      peer.channel = new Channel(reliable, (m) => this.ctrl.hostOnMessage(peer, m), () => this.dropPeer(id, true));
      unreliable.addEventListener('message', (e) => this.ctrl.onPresence(id, e.data));
      (async () => {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: o.offer }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'acceptJoin', session, answer: answer.sdp, mods: [Core.MOD_ID], isModsVanillaCompatible: false, clientId: id });
        peer.offerSet = true;
        for (const c of peer.remote) { try { pc.addIceCandidate(c == null ? null : new RTCIceCandidate(c)).catch(() => {}); } catch {} }
        peer.remote.length = 0;
      })().catch(() => { decline('WebRTCError'); this.dropPeer(id, false); });
      // a join that never completes the handshake is dropped
      setTimeout(() => { if (this.peers.get(id) === peer && !peer.hello) this.dropPeer(id, false); }, 30000);
    }

    send(id, msg) { const p = this.peers.get(id); if (p && p.hello && p.channel) p.channel.send(msg); }
    broadcast(msg) {
      let frames = null;
      for (const p of this.peers.values()) if (p.hello && p.channel) { frames = frames || encodeFrames(msg); p.channel.sendFrames(frames); }
    }
    presence(str, exceptId) {
      for (const p of this.peers.values()) if (p.hello && p.id !== exceptId && p.unreliable.readyState === 'open') { try { p.unreliable.send(str); } catch {} }
    }

    dropPeer(id, announce) {
      const p = this.peers.get(id);
      if (!p || p.closed) return;
      p.closed = true;
      this.peers.delete(id);
      try { p.pc.close(); } catch {}
      if (p.hello && announce && !p.kicked) this.ctrl.hostPeerLeft(p);
    }

    kick(id) {
      const p = this.peers.get(id);
      if (!p) return;
      if (p.channel) p.channel.send({ t: 'kicked' });
      p.kicked = true;
      const wasHello = p.hello;
      setTimeout(() => this.dropPeer(id, false), 400);
      if (wasHello) this.ctrl.hostPeerLeft(p, true);
      this.openInvite(true); // new code, so the old one cannot be reused to rejoin
    }

    end() {
      this.broadcast({ t: 'end' });
      const ids = [...this.peers.keys()];
      setTimeout(() => { for (const id of ids) this.dropPeer(id, false); }, 500);
      this.closeInviteSocket();
    }
  }

  // ============================================================================ client net =====

  const JOIN_ERRORS = {
    full: 'That session is full.',
    kicked: 'You were removed from that session.',
    'not-editor': "That code isn't a collaborative editor session.",
    malformed: 'The host rejected the connection.',
    webrtc: "Couldn't connect to the host.",
    expired: 'That invite code has expired.',
    server: "Couldn't reach the multiplayer server.",
    timeout: "Couldn't reach the host.",
  };

  class ClientNet {
    constructor(ctrl) { this.ctrl = ctrl; this.pc = null; this.channel = null; this.unreliable = null; this.ws = null; this.closed = false; }

    async join(code) {
      let iceServers;
      try { iceServers = sanitizeIce(await api().getIceServers()); } catch { throw new Error('server'); }
      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;
      const { reliable, unreliable } = makeChannels(pc);
      this.unreliable = unreliable;
      const profile = this.ctrl.profile();
      await new Promise((resolve, reject) => {
        let settled = false, accepted = false, answerSet = false, localDone = false, remoteDone = false, open = false;
        const remote = [], local = [];
        const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
        const maybeCloseWs = () => { if (open && localDone && remoteDone && this.ws) { try { this.ws.close(); } catch {} } };
        const timer = setTimeout(() => { finish(new Error('timeout')); try { ws.close(); } catch {} }, 30000);
        pc.onicecandidate = (e) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ version: GAME_VERSION, candidate: e.candidate }));
          else local.push(e.candidate);
          if (e.candidate == null) { localDone = true; maybeCloseWs(); }
        };
        const failState = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) finish(new Error('webrtc')); };
        pc.addEventListener('connectionstatechange', failState);
        reliable.addEventListener('open', () => { open = true; finish(); maybeCloseWs(); }, { once: true });

        let ws;
        try { ws = api().createMultiplayerJoinWebSocket(); } catch { return finish(new Error('server')); }
        this.ws = ws;
        (async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const sendJoin = () => {
            ws.send(JSON.stringify({ version: GAME_VERSION, inviteCode: code, offer: offer.sdp, mods: [Core.MOD_ID], isModsVanillaCompatible: false,
              nickname: profile.nickname, countryCode: profile.countryCode, carStyle: profile.carStyle }));
            for (const c of local) ws.send(JSON.stringify({ version: GAME_VERSION, candidate: c }));
            local.length = 0;
          };
          if (ws.readyState === WebSocket.OPEN) sendJoin(); else ws.addEventListener('open', sendJoin, { once: true });
        })().catch(() => finish(new Error('webrtc')));
        ws.addEventListener('close', () => { if (this.ws === ws) this.ws = null; if (!accepted) finish(new Error('server')); });
        ws.addEventListener('message', (ev) => {
          let o;
          try { o = JSON.parse(ev.data); } catch { return; }
          if (!o || typeof o.type !== 'string') return;
          if (o.type === 'acceptJoin') {
            if (typeof o.answer !== 'string' || !Array.isArray(o.mods)) return finish(new Error('malformed'));
            if (!o.mods.includes(Core.MOD_ID)) return finish(new Error('not-editor'));
            accepted = true;
            pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: o.answer })).then(() => {
              answerSet = true;
              for (const c of remote) { try { pc.addIceCandidate(c == null ? null : new RTCIceCandidate(c)).catch(() => {}); } catch {} }
              remote.length = 0;
            }).catch(() => finish(new Error('webrtc')));
          } else if (o.type === 'declineJoin') {
            const map = { SessionFull: 'full', Kicked: 'kicked', IncompatibleMods: 'not-editor', MalformedClientData: 'malformed', WebRTCError: 'webrtc' };
            finish(new Error(map[o.reason] || 'malformed'));
          } else if (o.type === 'iceCandidate') {
            if (o.candidate == null) { remoteDone = true; maybeCloseWs(); }
            if (answerSet) { try { pc.addIceCandidate(o.candidate == null ? null : new RTCIceCandidate(o.candidate)).catch(() => {}); } catch {} }
            else remote.push(o.candidate);
          } else if (o.type === 'error') {
            finish(new Error(o.error === 'ExpiredInvite' ? 'expired' : 'server'));
          }
        });
      });
      this.channel = new Channel(reliable, (m) => this.ctrl.clientOnMessage(m), () => this.ctrl.clientDisconnected());
      unreliable.addEventListener('message', (e) => this.ctrl.onPresence(null, e.data));
      pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.ctrl.clientDisconnected(); });
      setTimeout(() => { if (this.ws) { try { this.ws.close(); } catch {} } }, 15000);
    }

    send(msg) { if (this.channel) this.channel.send(msg); }
    presence(str) { if (this.unreliable && this.unreliable.readyState === 'open') { try { this.unreliable.send(str); } catch {} } }
    close() { this.closed = true; if (this.ws) { try { this.ws.close(); } catch {} } if (this.pc) { try { this.pc.close(); } catch {} } }
  }

  // ============================================================================ adapter ========

  /**
   * Binds the core to the real editor. Captures every change at the track model itself (so no editor
   * code path can bypass sync) and implements the core's view interface.
   */
  class EditorAdapter {
    constructor(ctrl, editor, h) {
      this.ctrl = ctrl; this.editor = editor; this.h = h; this.track = h.track;
      this.rec = new Core.Recorder();
      this.active = false; this.suppress = 0; this.hold = 0; this.tag = null; this.commitQueued = false;
      const pc = h.partConfigs;
      const axes = new Set(h.axes);
      const tileCache = new Map();
      this.rules = {
        tilesOf(id, r, a) {
          if (!axes.has(a)) throw new Error('bad axis');
          const k = id + '|' + r + '|' + a;
          let t = tileCache.get(k);
          if (!t) { t = []; pc.getPart(id).configuration.tiles.rotated(r, a).forEach((x, y, z) => t.push([x, y, z])); tileCache.set(k, t); }
          return t;
        },
        isStart: (id) => { try { return pc.getPart(id).configuration.startOffset != null; } catch { return false; } },
        isCheckpoint: (id) => { try { const d = pc.getPart(id).configuration.detector; return d != null && d.type == h.checkpointDetector; } catch { return false; } },
        colorValid: (id, c) => c === h.defaultColor || pc.getPart(id).colors.has(c),
        environmentValid: (e) => h.environments.includes(e),
      };
      this.view = this.makeView();
      this.instrument();
    }

    recording() { return this.active && this.suppress === 0 && this.h.isEnabled(); }

    scheduleCommit() {
      if (this.commitQueued) return;
      this.commitQueued = true;
      queueMicrotask(() => { this.commitQueued = false; this.commit(); });
    }

    commit() {
      if (!this.active || this.hold > 0 || !this.rec.any || !this.ctrl.session) return;
      const diff = this.rec.take();
      const tag = this.tag || { kind: 'edit', entry: null };
      this.tag = null;
      this.suppress++;
      try { this.ctrl.session.commitLocal(diff, tag); } finally { this.suppress--; }
    }

    instrument() {
      const A = this, t = this.track, proto = Object.getPrototypeOf(t);
      const touched = () => { if (A.active && A.suppress === 0 && !A.h.isEnabled() && A.ctrl.session) A.ctrl.session.viewStale = true; };
      const rec = (p) => { A.rec.add(p); A.scheduleCommit(); };
      this.restore = [];
      const wrap = (name, fn) => { t[name] = fn; this.restore.push(() => { delete t[name]; }); };
      wrap('setPart', function (x, y, z, id, r, a, c, cp, so) {
        const res = proto.setPart.apply(this, arguments);
        if (A.recording()) rec({ id, x, y, z, rotation: r, rotationAxis: a, color: c, checkpointOrder: cp == null ? null : cp, startOrder: so == null ? null : so });
        else touched();
        return res;
      });
      wrap('deleteSpecificPart', function () {
        const r = proto.deleteSpecificPart.apply(this, arguments);
        if (r) { if (A.recording()) { A.rec.remove(r); A.scheduleCommit(); } else touched(); }
        return r;
      });
      for (const name of ['deletePartsAt', 'deletePartsWithin']) {
        wrap(name, function () {
          const list = proto[name].apply(this, arguments);
          if (list && list.length) { if (A.recording()) { for (const p of list) A.rec.remove(p); A.scheduleCommit(); } else touched(); }
          return list;
        });
      }
      wrap('clear', function () {
        if (A.recording()) { A.rec.markWhole(); A.scheduleCommit(); } else touched();
        return proto.clear.apply(this, arguments);
      });
      wrap('loadTrackData', function () {
        if (A.recording()) { A.rec.markWhole(); A.scheduleCommit(); } else touched();
        return proto.loadTrackData.apply(this, arguments);
      });
      wrap('refreshMeshes', function () {
        if (A.recording() && A.rec.any) A.commit(); // stock edit paths refresh right after mutating
        return proto.refreshMeshes.apply(this, arguments);
      });
      // environment is a plain data property on the instance; sunDirection an accessor on the class
      let env = t.environment;
      Object.defineProperty(t, 'environment', { configurable: true, enumerable: true, get: () => env,
        set: (v) => { const ch = v !== env; env = v; if (ch) { if (A.recording()) { A.rec.markMeta(); A.scheduleCommit(); } else touched(); } } });
      this.restore.push(() => { delete t.environment; t.environment = env; });
      const sunDesc = Object.getOwnPropertyDescriptor(proto, 'sunDirection');
      Object.defineProperty(t, 'sunDirection', { configurable: true, get() { return sunDesc.get.call(this); },
        set(v) { sunDesc.set.call(this, v); if (A.recording()) { A.rec.markMeta(); A.scheduleCommit(); } else touched(); } });
      this.restore.push(() => { delete t.sunDirection; });
      // undo/redo entries are linked to the op they belong to (per-player undo needs their seq)
      for (const stack of [this.h.undoStack, this.h.redoStack]) {
        stack.push = function () {
          if (A.recording() && A.rec.any && A.hold === 0) A.commit();
          const r = Array.prototype.push.apply(this, arguments);
          if (A.active && A.ctrl.session) for (const e of arguments) A.ctrl.session.linkEntry(e);
          return r;
        };
        this.restore.push(() => { delete stack.push; });
      }
    }

    uninstall() { for (const f of this.restore.reverse()) f(); this.restore = []; }

    makeView() {
      const A = this, h = this.h, t = this.track;
      const key = Core.partKey;
      return {
        isLive: () => h.isEnabled(),
        removeExact(p) {
          A.suppress++;
          try {
            const back = [];
            let ok = false;
            for (let i = 0; i < 64; i++) {
              const r = t.deleteSpecificPart(p.id, p.x, p.y, p.z, p.rotation, p.rotationAxis);
              if (!r) break;
              if (key(r) === key(p)) { ok = true; break; }
              back.push(r);
            }
            for (const b of back) t.setPart(b.x, b.y, b.z, b.id, b.rotation, b.rotationAxis, b.color, b.checkpointOrder, b.startOrder);
            return ok;
          } finally { A.suppress--; }
        },
        add(p) {
          const q = Core.sanitizePart(p, A.rules);
          if (!q) return false;
          A.suppress++;
          try { t.setPart(q.x, q.y, q.z, q.id, q.rotation, q.rotationAxis, q.color, q.checkpointOrder, q.startOrder); return true; }
          catch (e) { log('add failed', e); return false; }
          finally { A.suppress--; }
        },
        replaceAll(parts) {
          A.suppress++;
          try { t.clear(); for (const q of parts) t.setPart(q.x, q.y, q.z, q.id, q.rotation, q.rotationAxis, q.color, q.checkpointOrder, q.startOrder); }
          finally { A.suppress--; }
        },
        setMeta(meta, lastModified) {
          A.suppress++;
          try {
            if (t.environment !== meta.environment) h.applyEnvironment(meta.environment);
            if (t.sunDirection.toDegrees() !== meta.sun) { t.sunDirection = h.sunFromDegrees(meta.sun); if (t.__ptUpdateShadows) t.__ptUpdateShadows(); }
            const cur = h.getMeta();
            if (cur.name !== meta.name || cur.author !== meta.author) h.setNameAuthor(meta.name, meta.author);
            if (lastModified) h.setLastModified(new Date(lastModified));
            A.ctrl.refreshSettingsDialog(meta);
          } finally { A.suppress--; }
        },
        getMeta: () => { const m = h.getMeta(); return { name: m.name == null ? null : m.name, author: m.author == null ? null : m.author, environment: t.environment, sun: t.sunDirection.toDegrees() }; },
        listParts() {
          const out = [];
          t.getTrackData().forEachPart((x, y, z, id, r, a, c, cp, so) => out.push({ id, x, y, z, rotation: r, rotationAxis: a, color: c, checkpointOrder: cp == null ? null : cp, startOrder: so == null ? null : so }));
          return out;
        },
        flush() { A.suppress++; try { h.refresh(); } finally { A.suppress--; } },
        highlight: (op) => A.ctrl.visuals && A.ctrl.visuals.highlight(op),
      };
    }
  }

  // ============================================================================ visuals ========

  class Visuals {
    constructor(ctrl, h) {
      this.ctrl = ctrl; this.h = h; this.T = h.THREE;
      this.group = new this.T.YJl();
      this.group.name = 'pt-collab';
      h.renderer.scene.add(this.group);
      this.avatars = new Map();
      this.flashes = [];
      this.tmp = new this.T.Pq0();
      this.labels = document.createElement('div');
      this.labels.className = 'pt-collab-labels';
      // the editor root is hidden during a test drive, so labels live one level up, beneath every UI layer
      const host = h.root.parentElement || h.root;
      host.insertBefore(this.labels, host.firstChild);
      const pts = [];
      const apex = [0, 0, -1.8], c = [[-1.1, 0.75, 0.5], [1.1, 0.75, 0.5], [1.1, -0.75, 0.5], [-1.1, -0.75, 0.5]];
      for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; pts.push(apex, a, b); }
      pts.push(c[0], c[2], c[1], c[0], c[3], c[2]);
      this.camGeometry = new this.T.LoY().setFromPoints(pts.map((p) => new this.T.Pq0(p[0], p[1], p[2])));
    }

    material(color, opacity) {
      return new this.T.V9B({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -0.6, side: this.T.$EB });
    }

    partGeometry(id, color) {
      try {
        const part = this.h.partConfigs.getPart(id);
        const env = this.h.track.environment;
        const c = part.colors.get(color) || part.colors.get(this.h.envColors[env]) || part.colors.values().next().value;
        return c ? c.geometry : null;
      } catch { return null; }
    }

    placeMesh(mesh, p) {
      const s = this.h.partSize;
      mesh.position.set(p.x * s, p.y * s, p.z * s);
      mesh.quaternion.copy(this.h.quat(p.rotation, p.rotationAxis));
    }

    avatar(id) {
      let a = this.avatars.get(id);
      if (a) return a;
      const player = this.ctrl.players.get(id);
      const color = player ? player.color : '#ffffff';
      const cam = new this.T.eaF(this.camGeometry, new this.T.V9B({ color, transparent: true, opacity: 0.8, side: this.T.$EB }));
      cam.visible = false;
      const ghost = new this.T.eaF(this.camGeometry, this.material(color, 0.38));
      ghost.visible = false;
      this.group.add(cam); this.group.add(ghost);
      const label = document.createElement('div');
      label.className = 'pt-collab-label';
      label.style.borderColor = color;
      label.textContent = player ? player.name : '?';
      this.labels.appendChild(label);
      a = { id, cam, ghost, label, target: null, ghostKey: null, ghostWanted: false, mode: 'e', lastSeen: 0 };
      this.avatars.set(id, a);
      return a;
    }

    presence(id, m) {
      const a = this.avatar(id);
      a.lastSeen = performance.now();
      const c = m.c;
      if (!a.target) {
        a.cam.position.set(c[0], c[1], c[2]);
        a.cam.quaternion.set(c[3], c[4], c[5], c[6]);
      }
      a.target = { p: new this.T.Pq0(c[0], c[1], c[2]), q: a.cam.quaternion.clone().set(c[3], c[4], c[5], c[6]).normalize(), cursor: m.u, sel: m.s };
      a.mode = m.m === 'd' ? 'd' : 'e';
      const player = this.ctrl.players.get(id);
      if (player && a.label.textContent !== player.name) a.label.textContent = player.name;
      // cursor ghost of the part they are about to place
      if (m.u && m.s && Number.isInteger(m.s.i)) {
        const k = m.s.i + '|' + m.s.c;
        if (k !== a.ghostKey) {
          const g = this.partGeometry(m.s.i, m.s.c);
          if (g) a.ghost.geometry = g;
          a.ghostKey = k;
        }
        this.placeMesh(a.ghost, { x: m.u[0], y: m.u[1], z: m.u[2], rotation: m.s.r, rotationAxis: m.s.a });
        a.ghostWanted = a.ghost.geometry !== this.camGeometry;
      } else a.ghostWanted = false;
    }

    remove(id) {
      const a = this.avatars.get(id);
      if (!a) return;
      this.group.remove(a.cam); this.group.remove(a.ghost);
      a.cam.material.dispose(); a.ghost.material.dispose();
      a.label.remove();
      this.avatars.delete(id);
    }

    highlight(op) {
      const player = this.ctrl.players.get(op.author);
      const color = player ? player.color : '#ffffff';
      const parts = op.added.map((p) => [p, 0.55]).concat(op.removed.map((p) => [p, 0.4]));
      if (!parts.length) return;
      const added = this.material(color, 0.55), removed = this.material('#ff3b3b', 0.4);
      const g = new this.T.YJl();
      let n = 0;
      for (const [p] of parts) {
        if (n++ >= 400) break;
        const geo = this.partGeometry(p.id, p.color);
        if (!geo) continue;
        const mesh = new this.T.eaF(geo, op.added.includes(p) ? added : removed);
        this.placeMesh(mesh, p);
        mesh.scale.setScalar(1.02);
        g.add(mesh);
      }
      this.group.add(g);
      this.flashes.push({ g, mats: [added, removed], start: performance.now(), base: [0.55, 0.4] });
    }

    /**
     * mode: 'editor' (full visuals), 'race' (I am test-driving: camera markers + labels only) or 'hidden'.
     * Teammates who are driving get no camera marker; their car is drawn by Drivers and labelled here.
     */
    update(dt, mode, drivers) {
      const show = mode !== 'hidden';
      this.group.visible = show;
      this.labels.style.display = show ? '' : 'none';
      const now = performance.now();
      for (let i = this.flashes.length - 1; i >= 0; i--) {
        const f = this.flashes[i], k = (now - f.start) / 1400;
        if (k >= 1) { this.group.remove(f.g); f.mats.forEach((m) => m.dispose()); this.flashes.splice(i, 1); continue; }
        f.g.visible = mode === 'editor';
        f.mats.forEach((m, j) => { m.opacity = f.base[j] * (1 - k * k); });
      }
      if (!show) return;
      const cam = this.h.renderer.camera || this.h.camera;
      const box = this.labels.getBoundingClientRect();
      const w = box.width || window.innerWidth, hgt = box.height || window.innerHeight;
      const lerp = 1 - Math.exp(-dt * 14);
      for (const a of this.avatars.values()) {
        const hide = () => { a.cam.visible = false; a.ghost.visible = false; a.label.style.display = 'none'; };
        if (now - a.lastSeen > 5000 || !a.target) { hide(); continue; }
        a.cam.position.lerp(a.target.p, lerp);
        a.cam.quaternion.slerp(a.target.q, lerp);
        if (a.mode === 'd') {
          const pos = mode === 'editor' && drivers ? drivers.labelPosition(a.id, cam) : null; // in a race the car's own name tag shows
          hide();
          if (!pos) continue;
          this.tmp.copy(pos); this.tmp.y += 2.2;
        } else {
          a.ghost.visible = a.ghostWanted && mode === 'editor';
          if (a.cam.position.distanceTo(cam.position) < 15) { a.cam.visible = false; a.label.style.display = 'none'; continue; }
          a.cam.visible = true;
          this.tmp.copy(a.cam.position); this.tmp.y += 3.2;
        }
        this.tmp.project(cam);
        if (this.tmp.z > 1 || this.tmp.z < -1) { a.label.style.display = 'none'; continue; }
        a.label.style.display = '';
        a.label.style.left = ((this.tmp.x + 1) / 2 * w).toFixed(1) + 'px';
        a.label.style.top = ((1 - this.tmp.y) / 2 * hgt).toFixed(1) + 'px';
      }
    }

    dispose() {
      for (const id of [...this.avatars.keys()]) this.remove(id);
      for (const f of this.flashes) { this.group.remove(f.g); f.mats.forEach((m) => m.dispose()); }
      this.flashes = [];
      this.h.renderer.scene.remove(this.group);
      this.camGeometry.dispose();
      this.labels.remove();
    }
  }

  // ============================================================================ drivers ========

  /** Game helpers exposed by the race class hook in main.bundle.js: car class, car-state codec, interpolation. */
  function raceRefs() {
    const R = window.__ptRaceClass;
    try { return R && R.__ptRefs ? R.__ptRefs() : null; } catch { return null; }
  }

  function validCarState(st) {
    if (!st || !Number.isInteger(st.frames) || st.frames < 0 || !st.position || !st.quaternion) return false;
    const p = st.position, q = st.quaternion;
    if (![p.x, p.y, p.z].every((v) => Number.isFinite(v) && Math.abs(v) < 1e7)) return false;
    if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) return false;
    const len = Math.hypot(q.x, q.y, q.z, q.w); // normalised exactly as stock multiplayer does
    if (len === 0) { q.x = 0; q.y = 0; q.z = 0; q.w = 1; } else { q.x /= len; q.y /= len; q.z /= len; q.w /= len; }
    return true;
  }

  /**
   * Teammates who are test-driving, drawn as real game cars (their car style and name tag) and played back
   * the way stock multiplayer plays back opponents: buffered 0.15 s behind and interpolated.
   * The cars live in the shared scene, so the same objects are seen from the editor and from a test drive.
   */
  class Drivers {
    constructor(ctrl, h) { this.ctrl = ctrl; this.h = h; this.T = h.THREE; this.cars = new Map(); this.modes = new Map(); }

    setMode(id, mode) { this.modes.set(id, mode); }

    receive(id, rc, state) {
      let d = this.cars.get(id);
      if (!d) {
        const refs = raceRefs();
        if (!refs || !this.ctrl.players.has(id)) return;
        let car;
        try {
          const T = this.T, p = state.position, q = state.quaternion;
          const start = { position: new T.Pq0(p.x, p.y, p.z), quaternion: new T.PTz(q.x, q.y, q.z, q.w) };
          car = new refs.Car(null, start, null, null, this.h.renderer, this.h.audio, null, null, null, window.__ptSettingsMgr || null, null);
        } catch (e) { log('driver car unavailable:', e && e.message); return; }
        car.audioVolume = 0;
        car.setVisible(false);
        d = { car, time: 0, resetCounter: 0, buf: [], lastSeen: 0, opacity: 1, tagKey: null, styleKey: null };
        this.cars.set(id, d);
        this.applyPlayer(id, d);
      }
      d.lastSeen = performance.now();
      if (rc > d.resetCounter) {
        d.car.setCarState(state, true);
        d.time = state.frames / 1000 - INTERP_DELAY;
        d.buf.length = 0;
        d.resetCounter = rc;
      } else if (rc === d.resetCounter && state.frames / 1000 > d.time) {
        let i = d.buf.length;
        for (let j = 0; j < d.buf.length; j++) if (state.frames < d.buf[j].frames) { i = j; break; }
        d.buf.splice(i, 0, state);
        if (d.buf.length > 240) d.buf.splice(0, d.buf.length - 240);
      }
    }

    applyPlayer(id, d) {
      const p = this.ctrl.players.get(id);
      if (!p) return;
      const tagKey = (p.cc || '') + '|' + p.name;
      if (tagKey !== d.tagKey) { try { d.car.setNameTag(p.cc || null, p.name); } catch {} d.tagKey = tagKey; }
      if (p.cs && p.cs !== d.styleKey) {
        d.styleKey = p.cs;
        const CS = this.ctrl.carStyleClass();
        if (CS) { try { d.car.setCarStyle(CS.deserializeSafe(p.cs)); } catch {} }
      }
    }

    refreshPlayers() {
      for (const [id, d] of this.cars) { if (this.ctrl.players.has(id)) this.applyPlayer(id, d); else this.remove(id); }
    }

    active(id, d, now) { return this.modes.get(id) === 'd' && now - d.lastSeen < DRIVER_STALE_MS; }

    /** mode as in Visuals.update; race = my own test drive's info when mode is 'race'. */
    update(dt, mode, race) {
      const now = performance.now();
      const refs = raceRefs();
      const localPos = mode === 'race' && race && race.car ? race.car.getPosition() : null;
      let unstartedShown = false;
      for (const [id, d] of this.cars) {
        if (!this.ctrl.players.has(id) || now - d.lastSeen > 15000) { this.remove(id); continue; }
        if (mode === 'hidden' || !this.active(id, d, now)) { d.car.setVisible(false); d.car.audioVolume = 0; continue; }
        if (d.buf.length) {
          const ahead = d.buf[d.buf.length - 1].frames / 1000 - d.time, slack = 0.1;
          let t = d.time + dt;
          if (ahead < INTERP_DELAY - slack) t -= 0.5 * slack; else if (ahead > INTERP_DELAY + slack) t += 0.5 * slack;
          const f = Math.floor(1000 * t);
          while (d.buf.length && d.buf[0].frames <= f) d.car.setCarState(d.buf.shift(), false);
          if (d.buf.length && refs) {
            const next = d.buf[0], cur = d.car.getCarState(), span = next.frames - cur.frames;
            if (span > 0) { const k = (f - cur.frames) / span; if (k > 0) d.car.setCarState(refs.interp(cur, next, k), false); }
          }
          d.time = t;
        } else d.time = d.car.getCarState().frames / 1000 - INTERP_DELAY;
        let visible = true, opacity = 1;
        if (localPos) {
          opacity = Math.max(0, Math.min(1, d.car.getPosition().distanceTo(localPos) / 5)); // stock ghost fade near my car
          if (!d.car.hasStarted()) { if (unstartedShown) visible = false; else unstartedShown = true; }
        }
        if (opacity !== d.opacity) { d.car.setOpacity(opacity); d.opacity = opacity; }
        d.car.audioVolume = localPos ? race.ghostVolume || 0 : 0;
        d.car.setVisible(visible);
        d.car.update(dt);
      }
    }

    /** Where to put a coloured label in the editor, or null when the car's own name tag is already showing. */
    labelPosition(id, cam) {
      const d = this.cars.get(id);
      if (!d || !this.active(id, d, performance.now())) return null;
      const pos = d.car.getPosition();
      if (d.car.hasStarted() && pos.distanceTo(cam.position) < 45) return null;
      return pos;
    }

    remove(id) {
      const d = this.cars.get(id);
      if (!d) return;
      try { d.car.dispose(); } catch (e) { console.error(e); }
      this.cars.delete(id);
      this.modes.delete(id);
    }

    dispose() { for (const id of [...this.cars.keys()]) this.remove(id); this.modes.clear(); }
  }

  // ============================================================================ controller =====

  const CSS = `
.pt-collab-panel { position:absolute; top:118px; left:12px; z-index:6; width:340px; max-height:calc(100% - 330px); overflow-y:auto; box-sizing:border-box;
  padding:14px; background:var(--surface-color); color:var(--text-color); pointer-events:auto; font-size:19px; }
.pt-collab-panel.hidden { display:none; }
.pt-collab-panel h2 { margin:0 0 10px; font-size:26px; font-weight:normal; }
.pt-collab-panel .pt-row { display:flex; gap:8px; align-items:center; margin:8px 0; }
.pt-collab-panel .pt-row > .button { margin:0; flex:1; }
.pt-collab-panel input { flex:1; min-width:0; font-size:22px; padding:6px 8px; background:var(--surface-secondary-color); color:var(--text-color); border:none; text-transform:uppercase; }
.pt-collab-panel .pt-note { font-size:16px; opacity:0.8; margin:6px 0; white-space:pre-wrap; }
.pt-collab-panel .pt-error { color:#ff8080; }
.pt-collab-code { font-size:40px; letter-spacing:6px; text-align:center; margin:4px 0; user-select:text; }
.pt-collab-players { margin-top:10px; border-top:2px solid var(--text-color); padding-top:6px; }
.pt-collab-player { display:flex; align-items:center; gap:8px; margin:5px 0; }
.pt-collab-player .pt-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pt-collab-player .button { margin:0; padding:2px 10px; font-size:16px; }
.pt-collab-swatch { width:14px; height:14px; flex:none; }
.pt-collab-labels { position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; overflow:hidden; }
.pt-collab-label { position:absolute; transform:translate(-50%,-100%); font-size:17px; padding:1px 7px; color:#fff; white-space:nowrap;
  background:rgba(20,20,30,0.7); border-bottom:3px solid #fff; }
`;

  const PTCollab = {
    ed: null, h: null, adapter: null, visuals: null, drivers: null, session: null, role: null, net: null,
    race: null, driveCount: 0, lastCarSend: 0, lastCarState: null,
    players: new Map(), myId: 0, hostName: null, inbox: [], loopId: 0, lastPresence: 0, lastVerify: 0, lastEnabled: true,
    ui: null, settingsDialog: null, status: '', statusError: false, joining: false, disabledButtons: [],

    // ------------------------------------------------------------------ editor lifecycle
    attachEditor(ed, h) {
      try {
        if (this.ed) this.detachEditor(this.ed);
        this.ed = ed; this.h = h;
        this.adapter = new EditorAdapter(this, ed, h);
        this.injectCss();
        this.buildUI();
      } catch (e) { console.error('[collab] attach failed', e); }
    },

    detachEditor(ed) {
      if (ed !== this.ed) return;
      try { if (this.session) this.endSession('You left the session.', { save: true, notify: true }); } catch (e) { console.error(e); }
      try { this.adapter && this.adapter.uninstall(); } catch (e) { console.error(e); }
      if (this.ui) { this.ui.button.remove(); this.ui.panel.remove(); }
      this.ui = null; this.adapter = null; this.ed = null; this.h = null;
    },

    // hooks called by the editor code
    beginTestDrive(race) {
      this.race = race; this.driveCount++; this.lastCarState = null; this.lastCarSend = 0;
      if (this.session && this.net) { try { this.sendPresence(); } catch {} }
    },
    endTestDrive(race) {
      if (this.race !== race) return;
      this.race = null;
      if (this.session && this.net) { try { this.sendPresence(); } catch {} } // teammates hide my car right away
    },

    beginUndo(ed, entry) { if (ed === this.ed && this.adapter && this.session) this.adapter.tag = { kind: 'undo', entry }; },
    beginRedo(ed, entry) { if (ed === this.ed && this.adapter && this.session) this.adapter.tag = { kind: 'redo', entry }; },
    holdCommit(ed) { if (ed === this.ed && this.adapter) this.adapter.hold++; },
    releaseCommit(ed) {
      if (ed !== this.ed || !this.adapter || this.adapter.hold === 0) return;
      if (--this.adapter.hold === 0) { this.adapter.commit(); this.drainInbox(); }
    },
    onLocalMeta(ed) { if (ed === this.ed && this.adapter && this.adapter.recording()) { this.adapter.rec.markMeta(); this.adapter.scheduleCommit(); } },
    onTrackSettingsDialog(controls) {
      this.settingsDialog = controls;
      if (this.role === 'client') {
        for (const el of [controls.name, controls.author, controls.sun, ...controls.env]) el.disabled = true;
        const note = document.createElement('p');
        note.className = 'pt-collab-dialog-note';
        note.textContent = 'Only the host can change track settings in a collaborative session.';
        note.style.cssText = 'margin:8px 0 0;font-size:18px;opacity:0.85;';
        controls.name.parentElement.parentElement.appendChild(note);
      }
    },
    refreshSettingsDialog(meta) {
      const c = this.settingsDialog;
      if (!c || !c.name.isConnected) { this.settingsDialog = null; return; }
      c.name.value = meta.name || ''; c.author.value = meta.author || '';
      c.sun.value = String(meta.sun); if (c.sunLabel) c.sunLabel.textContent = String(meta.sun);
      const envs = this.h.environments;
      c.env.forEach((b, i) => { const sel = envs[i] === meta.environment; b.classList.toggle('selected', sel); if (this.role !== 'client') b.disabled = sel; });
    },

    profile() {
      const p = this.h.profiles.getCurrentUserProfile();
      return { nickname: p.nickname, countryCode: p.countryCode == null ? null : p.countryCode, carStyle: p.carStyle.serialize() };
    },
    carStyleClass() { try { return this.h.profiles.getCurrentUserProfile().carStyle.constructor; } catch { return null; } },
    toast(text, good) { try { this.h.showMessage(text, !!good); } catch { log(text); } },

    // ------------------------------------------------------------------ sessions
    makeSession(role, myId) {
      return new Core.Session({
        role, myId, rules: this.adapter.rules, view: this.adapter.view,
        send: (m) => this.net && this.net.send(m),
        broadcast: (m) => this.net && this.net.broadcast(m),
        sendTo: (id, m) => this.net && this.net.send(id, m),
        onEvent: (type, d) => this.onSessionEvent(type, d),
      });
    },

    onSessionEvent(type, d) {
      const h = this.h;
      if (type === 'historyReset') { h.undoStack.length = 0; h.redoStack.length = 0; h.updateHistoryButtons(); }
      else if (type === 'entryEmpty') {
        for (const s of [h.undoStack, h.redoStack]) { const i = s.indexOf(d.entry); if (i >= 0) s.splice(i, 1); }
        h.updateHistoryButtons();
      } else if (type === 'skipped') {
        this.toast(d.kind === 'edit' ? 'Some of that change was skipped: a teammate edited the same spot.' : 'Parts a teammate has since changed were left alone.', false);
      } else if (type === 'hostOnly') {
        this.toast(d.what === 'track' ? 'Only the host can replace the whole track.' : 'Only the host can change track settings.', false);
      } else if (type === 'desync') log('desync detected, resyncing', d);
      else if (type === 'repaired') log('view repaired from mirror');
    },

    startHost() {
      if (this.session || !this.h) return;
      this.flushLocal();
      this.role = 'host'; this.myId = 0;
      this.adapter.rec.reset();
      this.adapter.active = true;
      this.session = this.makeSession('host', 0);
      this.session.initHostFromView();
      this.hostName = this.profile().nickname;
      const me = this.profile();
      this.players = new Map([[0, { id: 0, name: this.hostName, color: COLORS[0], isHost: true, cs: validCarStyle(me.carStyle), cc: validCountry(me.countryCode) }]]);
      this.visuals = new Visuals(this, this.h);
      this.drivers = new Drivers(this, this.h);
      this.net = new HostNet(this);
      this.net.openInvite(false);
      this.startLoop();
      this.status = ''; this.renderUI();
    },

    joinSession(code) {
      if (this.session || this.joining || !this.h) return;
      code = String(code || '').trim().toUpperCase();
      if (!code) return;
      const h = this.h;
      const go = () => {
        this.joining = true; this.status = 'Connecting…'; this.statusError = false; this.renderUI();
        const net = new ClientNet(this);
        this.net = net;
        this.role = 'client';
        net.join(code).then(() => {
          if (this.net !== net) return net.close();
          net.send({ t: 'hello', proto: Core.PROTOCOL, game: GAME_VERSION });
          this.status = 'Downloading track…'; this.renderUI();
          this.welcomeTimer = setTimeout(() => { if (this.joining) this.failJoin('timeout'); }, 30000);
        }).catch((e) => this.failJoin(e && e.message));
      };
      h.root.inert = true;
      h.dialogs.showConfirm('Joining replaces the track in your editor with the host\'s track.\n\nSave your current track first if you want to keep it.',
        h.translator.get('Cancel'), 'Join', () => { h.root.inert = false; }, () => { h.root.inert = false; go(); });
    },

    failJoin(reason) {
      clearTimeout(this.welcomeTimer);
      if (this.net) this.net.close();
      this.net = null; this.joining = false; this.role = null;
      this.status = reason === 'cancel' ? '' : (JOIN_ERRORS[reason] || JOIN_ERRORS.webrtc); this.statusError = reason !== 'cancel';
      this.renderUI();
    },

    endSession(message, { save = true, notify = true } = {}) {
      if (!this.session && !this.joining) return;
      if (this.session && save) this.saveCopy();
      if (this.net) { if (this.role === 'host') this.net.end(); else this.net.close(); }
      if (this.session) this.session.ended = true;
      clearTimeout(this.welcomeTimer);
      this.session = null; this.net = null; this.joining = false; this.role = null;
      this.inbox = [];
      if (this.adapter) { this.adapter.active = false; this.adapter.rec.reset(); this.adapter.tag = null; }
      if (this.visuals) { this.visuals.dispose(); this.visuals = null; }
      if (this.drivers) { this.drivers.dispose(); this.drivers = null; }
      this.players = new Map();
      for (const b of this.disabledButtons) b.disabled = false;
      this.disabledButtons = [];
      cancelAnimationFrame(this.loopId); this.loopId = 0;
      this.status = message || ''; this.statusError = false;
      if (notify && message) this.toast(message, true);
      this.renderUI();
    },

    /** "Everyone keeps a copy": save the current track into Custom tracks under a free name. */
    saveCopy() {
      const h = this.h;
      if (!h) return;
      try {
        const meta = h.getMeta();
        const base = (meta.name || 'Collab track').slice(0, 52);
        let name = base, n = 2;
        while (h.trackManager.checkCustomTrackNameExists(name)) name = base + ' (' + n++ + ')';
        let data;
        if (h.isEnabled() && !this.session.viewStale && this.adapter.hold === 0) data = h.track.getTrackData();
        else {
          const cur = h.track.getTrackData(), TD = cur.constructor, m = this.session.mirror;
          data = new TD(m.meta.environment, h.sunFromDegrees(m.meta.sun));
          let parts = m.list();
          for (const r of this.session.pending) parts = Core.minus(parts, r.applied.removed).concat(r.applied.added);
          for (const p of parts) data.addPart(p.x, p.y, p.z, p.id, p.rotation, p.rotationAxis, p.color, p.checkpointOrder, p.startOrder);
        }
        if (h.trackManager.saveCustomTrack({ name, author: meta.author, lastModified: new Date() }, data)) {
          try { h.storage.tryActivatePersistentStorage(); } catch {}
          this.toast('Saved a copy as "' + name + '"', true);
        }
      } catch (e) { console.error('[collab] save copy failed', e); }
    },

    flushLocal() { if (this.ed && this.ed.__ptFlush) this.ed.__ptFlush(); },

    deliver(fn) { if (this.adapter && this.adapter.hold > 0) this.inbox.push(fn); else fn(); },
    drainInbox() { while (this.inbox.length && (!this.adapter || this.adapter.hold === 0)) this.inbox.shift()(); },

    // ------------------------------------------------------------------ host messages
    hostOnMessage(peer, msg) {
      if (!this.session || this.role !== 'host') return;
      if (!peer.hello) {
        if (!msg || msg.t !== 'hello' || msg.proto !== Core.PROTOCOL) {
          peer.channel.send({ t: 'bye', reason: 'version' });
          setTimeout(() => this.net && this.net.dropPeer(peer.id, false), 300);
          return;
        }
        peer.hello = true;
        const used = new Set([...this.players.values()].map((p) => p.color));
        const color = COLORS.find((c) => !used.has(c)) || COLORS[peer.id % COLORS.length];
        this.players.set(peer.id, { id: peer.id, name: peer.name, color, isHost: false, cs: peer.carStyle, cc: peer.countryCode });
        peer.channel.send({ t: 'welcome', proto: Core.PROTOCOL, you: peer.id, players: this.playerList() });
        peer.channel.send(this.session.snapshotMessage());
        this.net.broadcast({ t: 'players', players: this.playerList() });
        this.toast('"' + peer.name + '" joined', true);
        this.renderUI();
        return;
      }
      this.deliver(() => {
        if (!this.session) return;
        let ok;
        try { ok = this.session.hostReceive(peer.id, msg); } catch (e) { console.error('[collab] host error', e); ok = false; }
        if (!ok) { log('malformed message from', peer.id, msg && msg.t); this.kick(peer.id, true); }
      });
    },

    hostPeerLeft(peer, kicked) {
      this.players.delete(peer.id);
      if (this.visuals) this.visuals.remove(peer.id);
      if (this.drivers) this.drivers.remove(peer.id);
      if (this.net) this.net.broadcast({ t: 'players', players: this.playerList() });
      this.toast('"' + peer.name + '" ' + (kicked ? 'was removed' : 'left'), false);
      this.renderUI();
    },

    kick(id, silent) {
      if (this.role !== 'host' || !this.net) return;
      this.net.kick(id);
      if (!silent) this.renderUI();
    },

    playerList() { return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, isHost: p.isHost, cs: p.cs, cc: p.cc })); },

    // ------------------------------------------------------------------ client messages
    clientOnMessage(msg) {
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'welcome') {
        if (msg.proto !== Core.PROTOCOL || !Number.isInteger(msg.you)) return this.failJoin('malformed');
        clearTimeout(this.welcomeTimer);
        this.flushLocal();
        this.myId = msg.you;
        this.adapter.rec.reset();
        this.adapter.active = true;
        this.session = this.makeSession('client', msg.you);
        this.setPlayers(msg.players);
        this.visuals = new Visuals(this, this.h);
        this.drivers = new Drivers(this, this.h);
        this.joining = false; this.status = '';
        for (const b of this.h.wholeTrackButtons) if (b && !b.disabled) { b.disabled = true; this.disabledButtons.push(b); }
        this.startLoop();
        this.renderUI();
        return;
      }
      if (msg.t === 'players') { this.setPlayers(msg.players); return; }
      if (msg.t === 'kicked') { this.endSession('You were removed from the session. Your copy of the track was saved.'); return; }
      if (msg.t === 'end') { this.endSession('The host ended the session. Your copy of the track was saved.'); return; }
      if (msg.t === 'bye') { this.failJoin('malformed'); return; }
      if (!this.session) return;
      this.deliver(() => {
        if (!this.session) return;
        let ok;
        try { ok = this.session.clientReceive(msg); } catch (e) { console.error('[collab] client error', e); ok = false; }
        if (!ok) this.endSession('Lost sync with the host. Your copy of the track was saved.');
      });
    },

    clientDisconnected() {
      if (this.joining && !this.session) return this.failJoin('webrtc');
      if (this.session && this.role === 'client') this.endSession('The host left the session. Your copy of the track was saved.');
    },

    setPlayers(list) {
      if (!Array.isArray(list)) return;
      const next = new Map();
      for (const p of list) {
        if (!p || !Number.isInteger(p.id) || typeof p.name !== 'string') continue;
        next.set(p.id, { id: p.id, name: p.name.slice(0, 64), color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#ffffff', isHost: !!p.isHost, cs: validCarStyle(p.cs), cc: validCountry(p.cc) });
      }
      if (this.visuals) for (const id of this.visuals.avatars.keys()) if (!next.has(id)) this.visuals.remove(id);
      this.players = next;
      if (this.drivers) this.drivers.refreshPlayers();
      const host = [...next.values()].find((p) => p.isHost);
      if (host) this.hostName = host.name;
      this.renderUI();
    },

    setHostName(name) {
      this.hostName = name;
      const me = this.players.get(0);
      if (me && this.role === 'host') { me.name = name; if (this.net) this.net.broadcast({ t: 'players', players: this.playerList() }); }
      this.renderUI();
    },

    // ------------------------------------------------------------------ presence
    onPresence(fromId, data) {
      if (!this.session) return;
      if (typeof data !== 'string') return this.onCarPacket(fromId, data);
      if (data.length > 512) return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || m.t !== 'p' || !Array.isArray(m.c) || m.c.length !== 7 || !m.c.every(Number.isFinite)) return;
      if (m.u != null && !(Array.isArray(m.u) && m.u.length === 3 && m.u.every(Number.isFinite))) return;
      if (m.s != null && !(m.s && Number.isInteger(m.s.i) && Number.isInteger(m.s.r) && Number.isInteger(m.s.a) && Number.isInteger(m.s.c))) return;
      if (m.m != null && m.m !== 'd') return;
      let id;
      if (this.role === 'host') { id = fromId; m.id = id; this.net.presence(JSON.stringify(m), id); }
      else { if (!Number.isInteger(m.id) || m.id === this.myId) return; id = m.id; }
      if (!this.players.has(id) || !this.visuals) return;
      this.visuals.presence(id, m);
      if (this.drivers) this.drivers.setMode(id, m.m === 'd' ? 'd' : 'e');
    },

    /** Car packet: [0]=CAR_MSG, [1..2]=player id (stamped by the host), [3..6]=reset counter, then the game's own car-state encoding. */
    onCarPacket(fromId, data) {
      if (!this.drivers || !(data instanceof ArrayBuffer) || data.byteLength < 8 || data.byteLength > 2048) return;
      const b = new Uint8Array(data);
      if (b[0] !== CAR_MSG) return;
      let id;
      if (this.role === 'host') { id = fromId; b[1] = id & 255; b[2] = (id >> 8) & 255; }
      else { id = b[1] | (b[2] << 8); if (id === this.myId) return; }
      if (!this.players.has(id)) return;
      const refs = raceRefs();
      if (!refs) return;
      let st;
      try { st = refs.decode(b.slice(7)).carState; } catch { return; }
      if (!validCarState(st)) return;
      const rc = (b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) >>> 0;
      if (this.role === 'host') this.net.presence(b, id);
      this.drivers.receive(id, rc, st);
    },

    sendCar(now, info) {
      const refs = raceRefs();
      const st = info && info.car ? info.car.getCarState() : null;
      if (!refs || !st) return;
      const changed = st !== this.lastCarState;
      if (now - this.lastCarSend < (changed ? CAR_SEND_MS : CAR_IDLE_MS)) return;
      this.lastCarSend = now; this.lastCarState = st;
      const payload = refs.encode(st);
      // a new test drive restarts the race's own counter, so the drive number goes in the high half
      const rc = (((this.driveCount & 0xffff) << 16) | Math.min(info.resetCounter >>> 0, 0xffff)) >>> 0;
      const b = new Uint8Array(7 + payload.length);
      b[0] = CAR_MSG; b[1] = this.myId & 255; b[2] = (this.myId >> 8) & 255;
      b[3] = rc & 255; b[4] = (rc >>> 8) & 255; b[5] = (rc >>> 16) & 255; b[6] = rc >>> 24;
      b.set(payload, 7);
      if (this.role === 'host') this.net.presence(b, -1); else this.net.presence(b);
    },

    sendPresence() {
      const h = this.h, cam = this.race ? (h.renderer.camera || h.camera) : h.camera;
      const r2 = (v) => Math.round(v * 100) / 100;
      const m = { t: 'p', c: [r2(cam.position.x), r2(cam.position.y), r2(cam.position.z), cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w].map((v) => Math.round(v * 1e4) / 1e4) };
      if (this.race) m.m = 'd';
      const cur = h.getCursor(), sel = h.getSelection();
      if (cur && h.isEnabled()) {
        m.u = [r2(cur.x), r2(cur.y), r2(cur.z)];
        if (sel) m.s = { i: sel.id, r: h.getRotation(), a: h.getRotationAxis(), c: h.getColor() };
      }
      const s = JSON.stringify(m);
      if (this.role === 'host') { const hm = Object.assign({ id: 0 }, m); this.net.presence(JSON.stringify(hm), -1); }
      else this.net.presence(s);
    },

    // ------------------------------------------------------------------ frame loop
    startLoop() {
      if (this.loopId) return;
      let last = performance.now();
      const tick = () => {
        this.loopId = requestAnimationFrame(tick);
        if (!this.session || !this.h) return;
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const enabled = this.h.isEnabled();
        if (enabled && !this.lastEnabled) { this.session.verifyView(); this.lastVerify = now; } // back from a test drive
        this.lastEnabled = enabled;
        let info = null;
        if (this.race && !enabled) { try { info = this.race.__ptCollab(); } catch {} }
        const mode = enabled ? 'editor' : info ? 'race' : 'hidden';
        if (this.drivers) { try { this.drivers.update(dt, mode, info); } catch (e) { console.error('[collab] drivers', e); } }
        if (this.visuals) this.visuals.update(dt, mode, this.drivers);
        if (info && this.net) { try { this.sendCar(now, info); } catch (e) { console.error('[collab] send car', e); } }
        if (now - this.lastPresence > PRESENCE_MS && this.net) { this.lastPresence = now; try { this.sendPresence(); } catch {} }
        if (enabled && this.adapter.hold === 0 && !this.adapter.rec.any && now - this.lastVerify > VERIFY_MS) {
          this.lastVerify = now;
          try { this.session.verifyView(); } catch (e) { console.error('[collab] verify failed', e); }
        }
        if (this.ui && this.role === 'host' && this.net && this.net.invite.expiresAt) this.renderInviteTimer();
      };
      this.loopId = requestAnimationFrame(tick);
    },

    // ------------------------------------------------------------------ UI
    injectCss() {
      if (document.getElementById('pt-collab-css')) return;
      const st = document.createElement('style');
      st.id = 'pt-collab-css'; st.textContent = CSS;
      document.head.appendChild(st);
    },

    buildUI() {
      const h = this.h;
      const button = document.createElement('button');
      button.className = 'button';
      button.innerHTML = '<img class="button-icon" src="images/multiplayer.svg"> ';
      button.append(document.createTextNode('Collaborate'));
      button.addEventListener('click', () => { try { h.audio.playUIClick(); } catch {} this.ui.panel.classList.toggle('hidden'); this.renderUI(); });
      h.toolbar.appendChild(button);
      const panel = document.createElement('section');
      panel.className = 'pt-collab-panel hidden';
      h.root.appendChild(panel);
      this.ui = { button, panel };
      this.renderUI();
    },

    renderInviteTimer() {
      const el = this.ui && this.ui.panel.querySelector('.pt-collab-timer');
      if (!el || !this.net || !this.net.invite.expiresAt) return;
      const s = Math.max(0, Math.ceil((this.net.invite.expiresAt - Date.now()) / 1000));
      const txt = 'Code valid for ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      if (el.textContent !== txt) el.textContent = txt;
    },

    renderUI() {
      if (!this.ui) return;
      const { panel, button } = this.ui;
      const count = this.session ? this.players.size : 0;
      const label = count > 1 ? 'Collaborate (' + count + ')' : 'Collaborate';
      if (button.lastChild.textContent !== label) button.lastChild.textContent = label;
      if (panel.classList.contains('hidden')) return;
      panel.textContent = '';
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const btn = (text, onClick, icon) => {
        const b = el('button', 'button');
        if (icon) b.innerHTML = '<img class="button-icon" src="images/' + icon + '.svg"> ';
        b.append(document.createTextNode(text));
        b.addEventListener('click', () => { try { this.h.audio.playUIClick(); } catch {} onClick(); });
        return b;
      };
      const row = (...kids) => { const r = el('div', 'pt-row'); kids.forEach((k) => r.appendChild(k)); return r; };
      panel.appendChild(el('h2', null, 'Collaborate'));

      if (!this.session && !this.joining) {
        panel.appendChild(el('p', 'pt-note', 'Build this track together in real time. Everyone edits the same map; the host controls track settings.'));
        panel.appendChild(row(btn('Host session', () => this.startHost(), 'invite')));
        const input = el('input');
        input.placeholder = 'Invite code'; input.maxLength = 16; input.spellcheck = false;
        const join = btn('Join', () => this.joinSession(input.value));
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.joinSession(input.value); });
        input.addEventListener('keyup', (e) => e.stopPropagation());
        panel.appendChild(row(input, join));
        if (this.status) panel.appendChild(el('p', 'pt-note' + (this.statusError ? ' pt-error' : ''), this.status));
        return;
      }
      if (this.joining) {
        panel.appendChild(el('p', 'pt-note', this.status || 'Connecting…'));
        panel.appendChild(row(btn('Cancel', () => this.failJoin('cancel'), 'cancel')));
        return;
      }
      if (this.role === 'host') {
        const inv = this.net ? this.net.invite : { state: 'idle' };
        if (inv.state === 'ready') {
          panel.appendChild(el('p', 'pt-note', 'Invite code:'));
          panel.appendChild(el('div', 'pt-collab-code', inv.code));
          const copy = btn('Copy', () => { try { navigator.clipboard.writeText(inv.code); this.toast('Invite code copied', true); } catch {} }, 'copy');
          panel.appendChild(row(copy, btn('New code', () => this.net.openInvite(true))));
          if (inv.expiresAt) { panel.appendChild(el('p', 'pt-note pt-collab-timer')); this.renderInviteTimer(); }
        } else if (inv.state === 'loading') panel.appendChild(el('p', 'pt-note', 'Creating invite…'));
        else if (inv.state === 'expired') { panel.appendChild(el('p', 'pt-note', 'The invite code expired. Players already in the session stay connected.')); panel.appendChild(row(btn('New code', () => this.net.openInvite(true)))); }
        else if (inv.state === 'error') { panel.appendChild(el('p', 'pt-note pt-error', inv.error)); panel.appendChild(row(btn('Try again', () => this.net.openInvite(true)))); }
      } else {
        panel.appendChild(el('p', 'pt-note', 'Connected to ' + (this.hostName ? '"' + this.hostName + '"' : 'the host') + '. Only the host can change track settings.'));
      }
      const list = el('div', 'pt-collab-players');
      list.appendChild(el('p', 'pt-note', 'Players (' + this.players.size + '/' + MAX_PLAYERS + ')'));
      for (const p of this.players.values()) {
        const r = el('div', 'pt-collab-player');
        const sw = el('span', 'pt-collab-swatch'); sw.style.background = p.color;
        r.appendChild(sw);
        r.appendChild(el('span', 'pt-name', p.name + (p.isHost ? ' (host)' : '') + (p.id === this.myId ? ' (you)' : '')));
        if (this.role === 'host' && !p.isHost) r.appendChild(btn('Kick', () => this.kick(p.id)));
        list.appendChild(r);
      }
      panel.appendChild(list);
      panel.appendChild(row(btn(this.role === 'host' ? 'End session' : 'Leave session', () =>
        this.endSession(this.role === 'host' ? 'Session ended. A copy of the track was saved.' : 'You left the session. Your copy of the track was saved.'), 'cancel')));
    },
  };

  window.PTCollab = PTCollab;
})();
