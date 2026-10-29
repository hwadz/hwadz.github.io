/*
 * PolyTrack Tweaks — compare a leaderboard run with yours.
 *
 * Every leaderboard row has a "vs" button (next to "Profile"). It downloads that run's recording
 * the way the game does for its Watch button, and opens the game's replay viewer with your personal
 * best and that run side by side. A panel on the left lists the track section by section — start to
 * the first checkpoint, checkpoint to checkpoint, the last one to the finish — with your time, theirs
 * and the difference, and marks the section the focused car is in. The times come from the viewer's
 * own simulation of both recordings, so they are exact; the rows fill in as it works through them.
 */
(function () {
  'use strict';

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (ms) => (window.PTRunsCore ? window.PTRunsCore.formatTime(ms) : (ms / 1000).toFixed(3));
  const fmtDelta = (ms) => (ms > 0 ? '+' : ms < 0 ? '−' : '±') + (Math.abs(ms) / 1000).toFixed(3);

  const CSS = `
/* the panel: the telemetry panel's look, on the left */
.pt-cmp { position:absolute; left:var(--safe-area-horizontal, 0); top:120px; z-index:2; box-sizing:border-box; width:400px;
  max-height:calc(100% - 420px); display:flex; flex-direction:column; padding:8px 10px 10px; color:var(--text-color);
  background-color:var(--surface-color); opacity:0.94; pointer-events:none; animation:pt-fade 0.16s ease-out;
  clip-path:polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-cmp > .head { display:flex; align-items:baseline; gap:8px; padding:0 4px 6px; }
.pt-cmp > .head > .t { font-size:22px; }
.pt-cmp > .head > .who { flex:1; min-width:0; font-size:16px; opacity:0.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:right; }
.pt-cmp > .rows { overflow:hidden; }
.pt-cmp table { width:100%; border-collapse:separate; border-spacing:0 3px; font-size:17px; }
.pt-cmp th { padding:0 6px; font-weight:normal; font-size:14px; text-align:right; opacity:0.5; white-space:nowrap; }
.pt-cmp th:first-child { text-align:left; }
.pt-cmp td { padding:3px 6px; text-align:right; white-space:nowrap; background-color:var(--surface-tertiary-color); }
.pt-cmp td:first-child { text-align:left; opacity:0.8; }
.pt-cmp tr.now > td { background-color:#2e4182; }
.pt-cmp tr.total > td { background-color:var(--button-color); }
.pt-cmp td.ahead { color:#5f5; }
.pt-cmp td.behind { color:#f55; }
.pt-cmp td.wait { opacity:0.35; }
.pt-cmp > .foot { margin-top:6px; padding:0 4px; font-size:14px; opacity:0.55; }
`;

  const PTCompare = {
    pending: null, viewer: null, panel: null, raf: 0, busy: false,

    init() {
      const st = el('style'); st.id = 'pt-compare-css'; st.textContent = CSS;
      document.head.appendChild(st);
    },

    toast(text) { if (window.PTUI) window.PTUI.toast(text); },

    /** From a leaderboard row: download their run and open both in the replay viewer. */
    async start({ recordingId, nickname, trackId }) {
      if (this.busy) return;
      this.busy = true;
      try {
        const api = window.__ptApi, recs = window.__ptRecords, profiles = window.__ptProfiles, watch = window.__ptWatchReplay;
        if (!api || !recs || !profiles || typeof watch !== 'function') { this.toast('Comparing runs is not available in this build.'); return; }
        if (!trackId) { this.toast('This leaderboard does not say which track it is for.'); return; }
        const mine = recs.getRecord(profiles.profileSlot, trackId);
        if (!mine || !mine.recording) { this.toast('Finish this track first — there is no personal best to compare with.'); return; }
        const track = window.PTRuns && window.PTRuns.loadTrackFor ? await window.PTRuns.loadTrackFor({ track: { id: trackId, name: '' } }) : null;
        if (!track || !track.trackData) { this.toast('This track could not be loaded.'); return; }
        this.toast('Downloading ' + (nickname || 'their') + '’s run…');
        const got = await api.getRecordings([recordingId]);
        const theirs = got && got[0];
        if (!theirs || !theirs.recording) { this.toast('That run could not be downloaded.'); return; }
        const me = profiles.getCurrentUserProfile();
        const settings = [
          { recording: mine.recording, carStyle: me.carStyle, nickname: me.nickname, time: mine.time, isSelf: true },
          { recording: theirs.recording, carStyle: theirs.carStyle, nickname: nickname || 'Them', time: theirs.time, isSelf: false },
        ];
        this.pending = { nickname: nickname || 'Them', at: Date.now() };
        watch(track.metadata, track.trackData, track.type, settings);
      } catch (e) {
        console.error('[compare]', e);
        this.toast('Could not compare: ' + ((e && e.message) || e));
      } finally { this.busy = false; }
    },

    // ---------------------------------------------------------------- in the viewer (racehud.js forwards these)
    attach(viewer) {
      this.detach(this.viewer);
      const p = this.pending;
      this.pending = null;
      if (!p || Date.now() - p.at > 60000) return;
      this.viewer = viewer;
      this.them = p.nickname;
      this.toast('Your personal best against ' + p.nickname + '’s run');
      this.drawn = '';
      const tick = () => { this.raf = requestAnimationFrame(tick); try { this.update(); } catch (e) { if (!this.warned) { this.warned = true; console.warn('[compare]', e); } } };
      this.raf = requestAnimationFrame(tick);
    },

    detach(viewer) {
      if (!this.viewer || (viewer && viewer !== this.viewer)) return;
      cancelAnimationFrame(this.raf);
      if (this.panel) this.panel.remove();
      this.panel = null;
      this.viewer = null;
    },

    /** Section times of one car: as far as the viewer has simulated it. */
    sections(entry, count) {
      const cps = (entry.checkpointTimes || []).map((t) => t.numberOfFrames);
      const finished = entry.finishSpeed != null;
      const marks = cps.slice(0, count);
      if (finished) marks.push(entry.settings.time.numberOfFrames);
      const out = [];
      for (let k = 0; k <= count; k++) out.push(marks[k] != null ? marks[k] - (k ? marks[k - 1] : 0) : null);
      return { out, total: finished ? entry.settings.time.numberOfFrames : null };
    },

    update() {
      let info;
      try { info = this.viewer.__ptReplay(); } catch { return; }
      if (!info || !info.cars || info.cars.length < 2) return;
      const mine = info.cars.find((c) => c.settings.isSelf), theirs = info.cars.find((c) => !c.settings.isSelf);
      if (!mine || !theirs) return;
      let count = 0;
      try { count = info.track.getTotalNumberOfCheckpointIndices(); } catch { count = Math.max(mine.checkpointTimes.length, theirs.checkpointTimes.length); }
      const a = this.sections(mine, count), b = this.sections(theirs, count);
      const focus = info.cars[info.focus];
      let at = -1;
      try { at = focus.car.getCarState().nextCheckpointIndex; } catch { }
      const key = JSON.stringify([a, b, at]);
      if (key === this.drawn) return;
      this.drawn = key;
      if (!this.panel) {
        const hud = info.hud && info.hud.element;
        if (!hud) return;
        this.panel = el('div', 'pt-cmp');
        hud.appendChild(this.panel);
      }
      const p = this.panel;
      p.textContent = '';
      const head = el('div', 'head');
      head.append(el('span', 't', 'Compare'), el('span', 'who', 'you vs ' + this.them));
      p.appendChild(head);
      const table = el('table');
      const hr = el('tr');
      for (const h of ['Section', 'You', this.them, '±']) hr.appendChild(el('th', null, h));
      table.appendChild(hr);
      const point = (k) => (k === 0 ? 'Start' : k === count + 1 ? 'Finish' : 'CP ' + k);
      for (let k = 0; k <= count; k++) {
        const tr = el('tr', k === at ? 'now' : null);
        tr.appendChild(el('td', null, point(k) + ' → ' + point(k + 1)));
        const x = a.out[k], y = b.out[k];
        tr.appendChild(el('td', x == null ? 'wait' : null, x == null ? '…' : fmt(x)));
        tr.appendChild(el('td', y == null ? 'wait' : null, y == null ? '…' : fmt(y)));
        const d = x != null && y != null ? x - y : null;
        tr.appendChild(el('td', d == null ? 'wait' : d < 0 ? 'ahead' : d > 0 ? 'behind' : null, d == null ? '…' : fmtDelta(d)));
        table.appendChild(tr);
      }
      const tt = el('tr', 'total');
      tt.appendChild(el('td', null, 'Whole run'));
      tt.appendChild(el('td', a.total == null ? 'wait' : null, a.total == null ? '…' : fmt(a.total)));
      tt.appendChild(el('td', b.total == null ? 'wait' : null, b.total == null ? '…' : fmt(b.total)));
      const dt = a.total != null && b.total != null ? a.total - b.total : null;
      tt.appendChild(el('td', dt == null ? 'wait' : dt < 0 ? 'ahead' : dt > 0 ? 'behind' : null, dt == null ? '…' : fmtDelta(dt)));
      table.appendChild(tt);
      const rows = el('div', 'rows');
      rows.appendChild(table);
      p.appendChild(rows);
      p.appendChild(el('div', 'foot', '± is your time minus theirs: green where you are quicker.'));
    },
  };

  window.PTCompare = PTCompare;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTCompare.init());
  else PTCompare.init();
})();
