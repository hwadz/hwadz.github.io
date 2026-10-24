/*
 * PolyTrack Tweaks — performance diagnostics.
 *
 * The diagnostics key (F10 unless changed in Settings → Controls → Tweaks) shows a small overlay
 * with what a frame costs and the numbers that would grow if something in the game were leaking:
 * objects and cameras in the 3D scene, draw calls, GPU-side geometries,
 * textures and shader programs, the JavaScript heap, the page's DOM size, and cars in the physics
 * worker. While it is on, it also writes one line a minute to a log you can copy or save.
 *
 * The point: if frames get slower over a long session, the log shows whether something in the game
 * grew alongside (a leak), or whether every count stayed flat while the frame time rose (the
 * machine slowing down — heat, power plan, background load).
 *
 * Nothing is measured or kept while it is off.
 */
(function () {
  'use strict';

  const MAX_LOG = 600;                 // ten hours of one-a-minute samples
  const log = (...a) => console.log('[diagnostics]', ...a);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtDur = (ms) => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
  };

  const CSS = `
/* a readout for finding problems: the game's surface, but fixed-width figures so the columns line up */
.pt-diag { position:absolute; left:8px; top:8px; z-index:70; padding:8px 10px; min-width:300px;
  background:rgba(25, 32, 66, 0.92); color:#fff; font:13px/1.45 Consolas, "Courier New", monospace; font-style:normal;
  pointer-events:auto; white-space:pre; }
.pt-diag.hidden { display:none; }
.pt-diag b { color:#ff5; font-weight:normal; }
.pt-diag .row { display:flex; gap:6px; margin-top:6px; }
.pt-diag button { font:12px Consolas, monospace; padding:2px 8px; background:var(--button-color); color:#fff; border:none; cursor:pointer; }
.pt-diag button:hover { background:var(--button-hover-color); }
`;

  const PTDiag = {
    on: false,
    panel: null,
    text: null,
    startedAt: Date.now(),
    samples: [],
    workerCars: null,
    timer: 0,
    minuteTimer: 0,

    init() {
      const st = document.createElement('style');
      st.id = 'pt-diag-css'; st.textContent = CSS;
      document.head.appendChild(st);
      window.addEventListener('keydown', (e) => {
        if (!window.PTKeys || !window.PTKeys.is(e, 'TweaksDiagnostics')) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      }, true);
    },

    toggle() { if (this.on) this.stop(); else this.start(); },

    start() {
      this.on = true;
      window.__ptFTForce = true;                     // borrow the frame timer behind the pseudo V-Sync readout
      if (!this.panel) this.build();
      this.panel.classList.remove('hidden');
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 1000);
      this.minuteTimer = setInterval(() => this.record(), 60000);
      setTimeout(() => this.record(), 2500);         // a first line once the frame timer has a reading
    },

    stop() {
      this.on = false;
      window.__ptFTForce = false;
      clearInterval(this.timer);
      clearInterval(this.minuteTimer);
      if (this.panel) this.panel.classList.add('hidden');
    },

    build() {
      const p = el('div', 'pt-diag hidden');
      this.text = el('div');
      p.appendChild(this.text);
      const row = el('div', 'row');
      const copy = el('button', null, 'Copy log');
      copy.addEventListener('click', () => this.copy());
      const save = el('button', null, 'Save log');
      save.addEventListener('click', () => this.save());
      const clear = el('button', null, 'Clear');
      clear.addEventListener('click', () => { this.samples = []; this.refresh(); });
      row.append(copy, save, clear);
      p.appendChild(row);
      (document.getElementById('ui') || document.body).appendChild(p);
      this.panel = p;
    },

    /** Everything worth watching, right now. */
    read() {
      const ft = window.__ptFTLast || null;
      const r = window.__ptRenderer;
      const gl = r && r.__ptGL ? r.__ptGL.info : null;
      let objects = 0, cameras = 0;
      try { r.scene.traverse((o) => { objects++; if (o.isCamera) cameras++; }); } catch { objects = cameras = -1; }
      try { if (window.__ptSim && window.__ptSim.__ptSend) window.__ptSim.__ptSend({ __pt: 'info' }); } catch { }
      return {
        at: Date.now(),
        cpu: ft && performance.now() - ft.at < 5000 ? ft.cpu : null,   // a stale reading means the timer stopped
        gpu: ft ? ft.gpu : null,
        interval: ft ? ft.iv : null,
        objects, cameras,
        calls: gl ? gl.render.calls : null,
        triangles: gl ? gl.render.triangles : null,
        geometries: gl ? gl.memory.geometries : null,
        textures: gl ? gl.memory.textures : null,
        programs: gl && gl.programs ? gl.programs.length : null,
        heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
        dom: document.getElementsByTagName('*').length,
        cars: this.workerCars,
      };
    },

    onWorkerInfo(msg) { this.workerCars = typeof msg.cars === 'number' ? msg.cars : null; },

    refresh() {
      if (!this.text) return;
      const s = this.read();
      const n = (v, d = 1) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v));
      const i = (v) => (v == null ? '—' : Math.round(v).toLocaleString());
      this.text.textContent = '';
      const line = (label, value) => {
        const d = el('div');
        d.appendChild(el('b', null, label.padEnd(7)));
        d.appendChild(document.createTextNode(value));
        this.text.appendChild(d);
      };
      line('PT diagnostics', '  (' + (window.PTKeys ? window.PTKeys.label('TweaksDiagnostics') : 'F10') + ' to hide)');
      line('session', fmtDur(Date.now() - this.startedAt));
      line('frame', 'CPU ' + n(s.cpu) + ' ms  GPU ' + n(s.gpu) + ' ms  every ' + n(s.interval) + ' ms');
      line('scene', i(s.objects) + ' objects · ' + i(s.cameras) + ' cameras · ' + i(s.calls) + ' draw calls · ' + i(s.triangles) + ' tris');
      line('gpu', i(s.geometries) + ' geometries · ' + i(s.textures) + ' textures · ' + i(s.programs) + ' shaders');
      line('memory', 'heap ' + n(s.heapMB, 0) + ' MB · DOM ' + i(s.dom) + ' nodes · physics cars ' + i(s.cars));
      line('log', this.samples.length + ' samples, one a minute');
    },

    record() {
      if (!this.on) return;
      this.samples.push(this.read());
      if (this.samples.length > MAX_LOG) this.samples.splice(0, this.samples.length - MAX_LOG);
    },

    /** Tab-separated, one line a minute: pastes straight into a spreadsheet or a message. */
    asText() {
      const cols = ['time', 'session', 'cpu_ms', 'gpu_ms', 'interval_ms', 'objects', 'cameras', 'draw_calls', 'triangles',
        'geometries', 'textures', 'shaders', 'heap_mb', 'dom_nodes', 'physics_cars'];
      const lines = [cols.join('\t')];
      for (const s of this.samples) {
        const v = (x, d = 2) => (x == null ? '' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : String(x));
        lines.push([new Date(s.at).toISOString(), fmtDur(s.at - this.startedAt), v(s.cpu), v(s.gpu), v(s.interval),
          v(s.objects), v(s.cameras), v(s.calls), v(s.triangles), v(s.geometries), v(s.textures), v(s.programs),
          v(s.heapMB, 1), v(s.dom), v(s.cars)].join('\t'));
      }
      return 'PolyTrack Tweaks diagnostics, ' + navigator.userAgent + '\n' + lines.join('\n') + '\n';
    },

    copy() {
      const text = this.asText();
      const done = () => { if (window.PTRuns && window.PTRuns.toast) window.PTRuns.toast('Diagnostics log copied (' + this.samples.length + ' lines)'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => log(text));
      else log(text);
    },

    save() {
      const blob = new Blob([this.asText()], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'polytrack-diagnostics-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
  };

  window.PTDiag = PTDiag;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTDiag.init());
  else PTDiag.init();
})();
