/*
 * PolyTrack Tweaks — the track list.
 *
 * Thumbnails as they come into view: a custom track's thumbnail is a picture the game draws from
 * every block of the track (a big track takes a tenth of a second or more). The game drew all of
 * them whenever it built the list — on the loading screen, for tracks nobody was about to look at.
 * Now each tile starts with an empty frame of the same size, and the thumbnail is drawn when the tile
 * comes within 400 px of being on screen, one at a time in the browser's idle moments, fading in the
 * way the official tracks' pictures do.
 *
 * Favourites and recently played: every tile has a star (in its corner on hover, always once it is a
 * favourite; the track page has one too). Each list starts with a "Favourites" group and a "Recently
 * played" group, made of copies of the tracks' own tiles — clicking one opens the track as its tile
 * does. Recently played is the last tracks you raced in that list, newest first.
 *
 * Filters: a bar at the top of each list shows every track, only the ones you have not driven yet
 * (no personal best and no attempt recorded) or only the ones you have a personal best on, and
 * orders each group as the game does or by the z-score of its world record (how far ahead of the
 * other top times it is: low first means the softest records first; see zscore.js).
 */
(function () {
  'use strict';

  const schedule = window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 120 }) : (fn) => setTimeout(fn, 16);

  const PTLazyThumbs = {
    observers: new Map(),          // scroll container → its IntersectionObserver
    queue: [],
    busy: false,
    drawn: 0,

    /** main.bundle.js hands over a placeholder canvas and the function that draws the real one. */
    watch(placeholder, draw) {
      placeholder.__ptDraw = draw;
      // the tile is put into its list right after this returns
      queueMicrotask(() => this.observe(placeholder));
    },

    observe(ph) {
      if (!ph.isConnected) { requestAnimationFrame(() => { if (ph.isConnected) this.observe(ph); }); return; }
      const root = ph.closest('.tracks-container');
      let io = this.observers.get(root);
      if (!io) {
        io = new IntersectionObserver((entries) => this.seen(entries, io), { root, rootMargin: '400px 0px' });
        this.observers.set(root, io);
      }
      io.observe(ph);
    },

    seen(entries, io) {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); this.queue.push(e.target); }
      this.pump();
    },

    pump() {
      if (this.busy || !this.queue.length) return;
      this.busy = true;
      const step = () => {
        const t0 = performance.now();
        // at least one each turn, more while it stays under half a frame
        do {
          const ph = this.queue.shift();
          if (ph && ph.isConnected && ph.__ptDraw) this.draw(ph);
        } while (this.queue.length && performance.now() - t0 < 8);
        if (this.queue.length) schedule(step); else this.busy = false;
      };
      schedule(step);
    },

    draw(ph) {
      let canvas;
      try { canvas = ph.__ptDraw(); } catch (e) { console.error('[tracklist] thumbnail', e); return; }
      ph.__ptDraw = null;
      if (!(canvas instanceof HTMLCanvasElement)) return;
      canvas.className = 'thumbnail loading';
      ph.replaceWith(canvas);
      this.drawn++;
      requestAnimationFrame(() => canvas.classList.remove('loading'));   // the game's own fade-in
    },
  };

  window.PTLazyThumbs = PTLazyThumbs;

  // ================================================================== favourites, recent, filters
  const STORE = 'pt-tracklist-v1';
  const RECENT_KEEP = 30, RECENT_SHOWN = 6;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const STAR_PATH = 'M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z';
  const starSvg = () => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg>';
  const STAR_IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ffffff" d="' + STAR_PATH + '"/></svg>');

  const CSS = `
.pt-hide { display:none !important; }
/* the star: in the tile's title bar, left of the name (the delete button has the right) */
.track-selection-ui .tracks-container .track > button.pt-star { position:absolute; left:13px; top:13px; z-index:3; width:24px; height:24px;
  margin:0; padding:2px; border:none; background:none; cursor:pointer; opacity:0; transition:opacity 0.1s ease-in-out; }
.track-selection-ui .tracks-container .track:hover > button.pt-star, .track-selection-ui .tracks-container .track > button.pt-star:focus-visible { opacity:0.55; }
.track-selection-ui .tracks-container .track > button.pt-star:hover, .track-selection-ui .tracks-container .track > button.pt-star.on { opacity:1; }
.pt-star > svg, .pt-fav > svg { display:block; width:100%; height:100%; fill:none; stroke:#fff; stroke-width:2; stroke-linejoin:round;
  filter:drop-shadow(1px 1px 0 rgba(0, 0, 0, 0.5)); }
.pt-star.on > svg, .pt-fav.on > svg { fill:#ff5; stroke:#ff5; }
/* the track page's star, in the thumbnail's other top corner */
.track-info-ui > .side-panel > .thumbnail > .pt-fav { display:inline-block; position:absolute; left:0; top:0; margin:8px; padding:0 9px;
  clip-path:polygon(3px 0, 100% 0, calc(100% - 3px) 100%, 0 100%); }
.track-info-ui > .side-panel > .thumbnail > .pt-fav > svg { width:16px; height:16px; }
/* the filter bar at the top of a list */
.track-selection-ui .pt-tl-bar { display:flex; flex-wrap:wrap; align-items:center; gap:10px 24px; margin:0 0.4em 8px; color:var(--text-color); }
.track-selection-ui .pt-tl-bar > label { display:flex; align-items:center; gap:10px; font-size:20px; }
.track-selection-ui .pt-tl-bar > label > span { opacity:0.6; }
.track-selection-ui .pt-tl-bar .pt-choice > .button { padding:4px 14px; font-size:20px; }
.track-selection-ui .pt-tl-bar > .pt-note { margin:0; font-size:17px; }
.track-selection-ui .tracks-container.no-group-containers .pt-tl-bar { margin-top:-30px; }
`;

  const PTTrackList = {
    state: null,
    root: null,
    counter: 0,

    init() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { saved = null; }
      this.state = Object.assign({ fav: {}, recent: [], show: 'all', sort: 'default' }, saved || {});
      const st = el('style'); st.id = 'pt-tracklist-css'; st.textContent = CSS;
      document.head.appendChild(st);
    },
    save() { try { localStorage.setItem(STORE, JSON.stringify(this.state)); } catch (e) { console.warn('[tracklist] could not save', e); } },

    /** The same key the statistics use: custom tracks change id when edited, so they go by name. */
    keyFor(id, category, name) {
      return window.PTRuns && window.PTRuns.keyForTrack ? window.PTRuns.keyForTrack(id, category, name)
        : (category === 'custom' ? 'custom:' + name : (id || 'custom:' + name));
    },
    isFav(key) { return !!this.state.fav[key]; },

    // ---------------------------------------------------------------- tiles
    /** main.bundle.js hands over every tile it builds: the track, and your personal best on it. */
    decorateTile(container, button, id, category, metadata, pb) {
      try {
        const name = (metadata && metadata.name) || '';
        const key = this.keyFor(id, category, name);
        container.__ptTile = { key, id, category, name, pb: pb ? pb.numberOfFrames : null, index: this.counter++ };
        container.appendChild(this.star(key, 'pt-star'));
      } catch (e) { console.error('[tracklist] tile', e); }
    },

    star(key, cls) {
      const b = el('button', cls + (this.isFav(key) ? ' on' : ''));
      b.type = 'button';
      b.dataset.ptKey = key;
      b.innerHTML = starSvg();
      b.title = this.isFav(key) ? 'Remove from favourites' : 'Add to favourites';
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleFav(key); });
      return b;
    },

    toggleFav(key) {
      if (this.state.fav[key]) delete this.state.fav[key]; else this.state.fav[key] = Date.now();
      this.save();
      const on = this.isFav(key);
      for (const b of document.querySelectorAll('.pt-star, .pt-fav')) {
        if (b.dataset.ptKey !== key) continue;
        b.classList.toggle('on', on);
        b.title = on ? 'Remove from favourites' : 'Add to favourites';
      }
      if (this.root) this.rebuild(this.root);
      if (window.PTUI) window.PTUI.toast(on ? 'Added to favourites' : 'Removed from favourites', 1400);
    },

    /** The track page's own star, next to its share button. */
    trackPageStar(container, key) {
      try {
        const thumb = container.closest('.side-panel') && container.closest('.side-panel').querySelector(':scope > .thumbnail');
        if (!thumb || thumb.querySelector(':scope > .pt-fav')) return;
        thumb.appendChild(this.star(key, 'button pt-fav'));
      } catch (e) { console.error('[tracklist] track page star', e); }
    },

    /** A race on this track has ended (not an editor test drive). */
    notePlayed(key, type) {
      if (!key) return;
      this.state.recent = [{ key, type, at: Date.now() }].concat(this.state.recent.filter((r) => r.key !== key)).slice(0, RECENT_KEEP);
      this.save();
    },

    // ---------------------------------------------------------------- the lists
    /** main.bundle.js: the track list has just been (re)built. */
    refreshed(root) {
      if (!root) return;
      this.root = root;
      try { this.rebuild(root); } catch (e) { console.error('[tracklist] lists', e); }
      // a list the game fills again later (custom tracks added or removed) gets its groups back
      for (const c of root.querySelectorAll('.tracks-container')) {
        if (c.__ptWatched) continue;
        c.__ptWatched = true;
        new MutationObserver(() => { if (!c.querySelector('.pt-tl-bar')) { try { this.rebuildList(c); } catch (e) { console.error('[tracklist] list', e); } } })
          .observe(c, { childList: true });
      }
    },

    rebuild(root) { for (const c of root.querySelectorAll('.tracks-container')) this.rebuildList(c); },

    wrapperOf(list) { return list.querySelector(':scope > .wrapper') || list; },

    rebuildList(list) {
      const w = this.wrapperOf(list);
      for (const old of w.querySelectorAll(':scope > .pt-tl-bar, :scope > .pt-tl-group')) old.remove();
      const tiles = [...w.querySelectorAll('.track')].filter((t) => t.__ptTile && !t.classList.contains('pt-copy'));
      if (!tiles.length) return;
      const byKey = new Map();
      for (const t of tiles) if (!byKey.has(t.__ptTile.key)) byKey.set(t.__ptTile.key, t);
      const groups = [];
      const favs = tiles.filter((t) => this.isFav(t.__ptTile.key) && byKey.get(t.__ptTile.key) === t);
      if (favs.length) groups.push(this.group('Favourites', STAR_IMG, favs));
      const recent = this.state.recent.map((r) => byKey.get(r.key)).filter(Boolean).slice(0, RECENT_SHOWN);
      if (recent.length) groups.push(this.group('Recently played', 'images/timer.svg', recent));
      const bar = this.bar(list);
      if (groups.length && list.classList.contains('no-group-containers')) {
        const rest = el('div', 'pt-tl-group pt-tl-rest');
        rest.appendChild(el('div', 'group-title pt-tl-title', 'All tracks'));
        groups.push(rest);
      }
      w.prepend(bar, ...groups);
      this.apply(list);
    },

    group(title, icon, tiles) {
      const g = el('div', 'pt-tl-group');
      const t = el('div', 'group-title pt-tl-title', title);
      const img = el('img'); img.src = icon; t.prepend(img);
      g.appendChild(t);
      for (const tile of tiles) g.appendChild(this.copyTile(tile));
      return g;
    },

    /** A copy of a tile that opens its track the way the tile itself does. */
    copyTile(orig) {
      const c = orig.cloneNode(true);
      c.classList.add('pt-copy');
      c.__ptTile = orig.__ptTile;
      const btn = c.querySelector(':scope > .button');
      if (btn) btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const own = orig.querySelector(':scope > .button');
        if (own) own.click();
      });
      const del = c.querySelector(':scope > .delete-button');
      if (del) del.remove();
      const star = c.querySelector(':scope > .pt-star');
      if (star) star.replaceWith(this.star(orig.__ptTile.key, 'pt-star'));
      const ot = orig.querySelector(':scope > .button > .thumbnail'), ct = c.querySelector(':scope > .button > .thumbnail');
      if (ot && ct) {
        if (ct instanceof HTMLImageElement) {
          if (ct.complete && ct.naturalWidth) ct.classList.remove('loading');
          else ct.addEventListener('load', () => ct.classList.remove('loading'), { once: true });
        } else if (ot instanceof HTMLCanvasElement) {
          // the custom tracks' pictures: copy the pixels (the game keeps one canvas per track)
          const copy = (src) => {
            if (!(src instanceof HTMLCanvasElement)) return src;
            const k = document.createElement('canvas');
            k.width = src.width; k.height = src.height;
            k.getContext('2d').drawImage(src, 0, 0);
            return k;
          };
          if (ot.__ptDraw) {
            PTLazyThumbs.watch(ct, () => {
              const cur = orig.querySelector(':scope > .button > .thumbnail');
              return copy(cur && cur.__ptDraw ? cur.__ptDraw() : cur);
            });
          } else {
            const k = copy(ot);
            k.className = 'thumbnail';
            ct.replaceWith(k);
          }
        }
      }
      return c;
    },

    bar(list) {
      const U = window.PTUI;
      const bar = el('div', 'pt-tl-bar');
      if (!U) return bar;
      const show = el('label');
      show.appendChild(el('span', null, 'Show'));
      show.appendChild(U.choice([['all', 'All'], ['new', 'Not driven yet'], ['pb', 'Has a PB']], this.state.show, (v) => this.set('show', v)));
      const order = el('label');
      order.appendChild(el('span', null, 'Order'));
      order.appendChild(U.choice([['default', 'As listed'], ['z-asc', 'Z-score ↑'], ['z-desc', 'Z-score ↓']], this.state.sort, (v) => this.set('sort', v)));
      order.title = 'Z-score: how far each world record is ahead of the other top times. Low first: the softest records first.';
      const note = el('p', 'pt-note');
      bar.append(show, order, note);
      return bar;
    },

    set(what, value) {
      this.state[what] = value;
      this.save();
      // every list's bar is drawn again, so they all show the same choice
      if (this.root) this.rebuild(this.root);
    },

    zOf(info) {
      const Z = window.PTZScore;
      try { const r = Z && info.id ? Z.get(info.id) : null; return r && r.z != null ? r.z : null; } catch { return null; }
    },

    passes(info) {
      const s = this.state.show;
      if (s === 'pb') return info.pb != null;
      if (s === 'new') {
        const R = window.PTRuns, rec = R && R.stats ? R.stats.tracks[info.key] : null;
        return info.pb == null && !(rec && rec.attempts > 0);
      }
      return true;
    },

    /** Shows and orders the tiles of one list as the bar says. */
    apply(list) {
      const w = this.wrapperOf(list);
      const tiles = [...w.querySelectorAll('.track')].filter((t) => t.__ptTile);
      let shown = 0, withZ = 0;
      for (const t of tiles) {
        const ok = this.passes(t.__ptTile);
        t.classList.toggle('pt-hide', !ok);
        if (ok && !t.classList.contains('pt-copy')) shown++;
        if (this.zOf(t.__ptTile) != null) withZ++;
      }
      // order inside each group (the game's groups, and ours)
      const parents = new Set(tiles.map((t) => t.parentElement));
      const sort = this.state.sort;
      for (const p of parents) {
        if (p.classList.contains('pt-tl-group') && p.firstElementChild && p.firstElementChild.textContent === 'Recently played' && sort === 'default') continue;
        const own = [...p.children].filter((t) => t.__ptTile);
        const z = (t) => this.zOf(t.__ptTile);
        own.sort((a, b) => {
          if (sort === 'default') return a.__ptTile.index - b.__ptTile.index;
          const za = z(a), zb = z(b);
          if (za == null && zb == null) return a.__ptTile.index - b.__ptTile.index;
          if (za == null) return 1;
          if (zb == null) return -1;
          return sort === 'z-asc' ? za - zb : zb - za;
        });
        for (const t of own) p.appendChild(t);
      }
      // a group with nothing left to show goes too, title and all
      for (const g of w.children) {
        if (!g.querySelector || !g.querySelector(':scope > .group-title') || g.classList.contains('pt-tl-rest')) continue;
        const any = [...g.querySelectorAll(':scope > .track')].some((t) => !t.classList.contains('pt-hide'));
        g.classList.toggle('pt-hide', !any && [...g.querySelectorAll(':scope > .track')].length > 0);
      }
      const note = w.querySelector(':scope > .pt-tl-bar > .pt-note');
      if (note) {
        const msgs = [];
        if (this.state.show !== 'all') msgs.push(shown + (shown === 1 ? ' track' : ' tracks'));
        if (sort !== 'default' && !withZ) msgs.push('no z-scores yet: the Z-scores button works them out');
        note.textContent = msgs.join(' · ');
      }
    },
  };

  window.PTTrackList = PTTrackList;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTTrackList.init());
  else PTTrackList.init();
})();
