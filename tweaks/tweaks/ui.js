/*
 * PolyTrack Tweaks — the mod's screens, built from the game's own parts.
 *
 * The game draws every panel the same way: a centred title on its surface colour, the content on
 * the darker secondary surface, and a bar at the bottom with the way back on the left and the main
 * action on the right. Its buttons are slanted, fill from the left on hover and show the selected
 * one in the hover colour; green means ahead or better, red behind or worse; key names sit in small
 * rounded chips. This file gives the mod's screens those same parts, so they read as the game's own.
 *
 * It also smooths a few corners of the game itself: its panels fade in over 0.16 s instead of
 * appearing in one frame (nothing waits for it — a click lands straight away), the four window titles
 * that were bold now match the rest, and the editor's help shows keys as the game names them ("W",
 * "↑") instead of their codes ("[KeyW]", "[ArrowUp]").
 */
(function () {
  'use strict';

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const CSS = `
/* ---------------------------------------------------------------- the game's own panels, a touch smoother */
@keyframes pt-rise { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
@keyframes pt-fade { from { opacity:0; } to { opacity:1; } }
.settings-menu-ui, .track-info-ui, .multiplayer-ui > .join, .multiplayer-ui > .host, .player-list-ui, .invite-ui,
.news-popup-ui, .graph-ui, .message-box-ui > div, .track-export-ui > .box, .terms-privacy-ui,
.editor-help-ui > .container, .editor-track-settings-ui > .container, .profile-selection-ui > .container,
.profile-settings-ui > .container, .user-export-ui > .container, .country-selection-ui > .container { animation:pt-rise 0.16s ease-out; }

/* every window title of the game is regular weight, but for these four, which fell back to the browser's bold */
.graph-ui > h2, .news-popup-ui > h2, .player-list-ui > h2, .invite-ui > h2 { font-weight:normal; }
.track-selection-ui > .bar, .track-selection-ui > .image-button-container,
.track-selection-ui .tracks-container.open > .wrapper { animation:pt-fade 0.16s ease-out; }

/* key names in the editor's help, as chips like the game's own hints draw them */
.editor-help-ui .pt-key { font-size:0.9em; }

/* ---------------------------------------------------------------- a screen of the mod's */
.pt-page { position:absolute; left:0; top:0; z-index:40; display:flex; justify-content:center; width:100%; height:100%;
  pointer-events:none; color:var(--text-color); }
.pt-page.hidden { display:none; }
.pt-page.dim { background-color:rgba(20, 20, 45, 0.8); -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px); pointer-events:auto; }
.pt-panel { position:relative; display:flex; flex-direction:column; box-sizing:border-box; width:1050px; max-width:calc(100% - 40px);
  height:100%; background-color:var(--surface-color); pointer-events:auto; animation:pt-rise 0.16s ease-out; }
/* everything but the content keeps its height; the content scrolls */
.pt-panel > :not(.pt-content) { flex-shrink:0; }
.pt-panel > .pt-title { margin:10px 10px 0; padding:0; font-weight:normal; font-size:38px; text-align:center; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.pt-panel > .pt-sub { margin:4px 10px 0; font-size:18px; text-align:center; opacity:0.5; }
.pt-panel > .pt-sub:empty { display:none; }
.pt-panel > .pt-tabs { display:flex; margin:10px 10px 0; }
.pt-panel > .pt-tabs > .button { flex:1 1 0; margin:0 -3px; padding:6px 0; font-size:26px; }
.pt-panel > .pt-tabs > .button:first-child { margin-left:0; }
.pt-panel > .pt-tabs > .button:last-child { margin-right:0; }
.pt-panel > .pt-tabs > .button.selected { background-color:var(--button-hover-color); }
.pt-panel > .pt-tabs > .button.selected::after { width:100%; }
.pt-panel > .pt-tools { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:10px 10px 0; }
.pt-panel > .pt-tools > .button { margin:0; }
.pt-panel > .pt-pages { display:flex; margin:10px 10px 0; }
.pt-panel > .pt-pages:empty { display:none; }
.pt-panel > .pt-pages > .button { margin:0; padding:4px 16px; font-size:26px; }
.pt-panel > .pt-pages > .button.page { flex:1 1 0; width:0; padding:4px 0; }
.pt-panel > .pt-pages > .button.selected { background-color:var(--button-hover-color); }
.pt-panel > .pt-progress { flex:0 0 auto; }
.pt-panel > .pt-content { flex:1 1 auto; min-height:0; margin-top:10px; padding:0 0 10px; overflow-x:hidden; overflow-y:scroll;
  background-color:var(--surface-secondary-color); }
.pt-panel > .pt-content.pt-swap { animation:pt-fade 0.14s ease-out; }
.pt-panel > .pt-bar { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:10px; }
.pt-panel > .pt-bar > .button { margin:0; }
.pt-panel > .pt-bar > .pt-grow { flex:1 1 auto; }
.pt-panel > .pt-bar > .pt-status { flex:1 1 200px; min-width:0; font-size:18px; opacity:0.75; text-align:right; }
.pt-panel > .pt-bar .button.small, .pt-row .button.small { padding:6px 14px; font-size:22px; }
.pt-behind { visibility:hidden !important; }
.pt-grow { flex:1 1 auto; }

/* blocks inside a screen */
.pt-card { margin:10px 10px 0; padding:16px 20px; background-color:var(--surface-color); }
.pt-card > h3 { margin:0 0 12px; padding:0; font-weight:normal; font-size:26px; }
.pt-card > h3 > small { margin-left:10px; font-size:18px; opacity:0.5; }
.pt-cols { display:flex; flex-wrap:wrap; }
.pt-cols > * { flex:1 1 400px; min-width:0; }
.pt-row { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:10px 10px 0; }
.pt-row > .button { margin:0; }
.pt-note { margin:8px 0 0; font-size:18px; line-height:1.3; opacity:0.75; white-space:pre-wrap; }
.pt-row > .pt-note, .pt-tools > .pt-note { margin:0; }
.pt-content > .pt-note { margin:10px 10px 0; }
.pt-heading { margin:20px 10px 0; padding:4px; font-weight:normal; font-size:24px; border-bottom:2px solid var(--text-color); }
.pt-good { color:#5f5; }
.pt-bad { color:#f55; }
.pt-gold { color:#ff5; }
.pt-dim { opacity:0.5; }

/* numbers over their labels */
.pt-tiles { display:flex; flex-wrap:wrap; gap:10px; margin:10px 10px 0; }
.pt-tile { flex:1 1 140px; padding:10px 16px 12px 14px; background-color:var(--surface-color);
  clip-path:polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-tile > .v { font-size:30px; white-space:nowrap; }
.pt-tile > .k { margin-top:6px; font-size:16px; opacity:0.5; }

/* lists: rows like the game's leaderboard and player list */
table.pt-list { width:100%; border-collapse:separate; border-spacing:0 5px; font-size:22px; }
table.pt-list th { padding:0 10px; font-weight:normal; font-size:16px; text-align:left; opacity:0.5; white-space:nowrap; }
/* the row colour is a variable so the 1px shadow that hides the seams between cells (the UI is scaled, so cell
   edges fall between pixels) always matches it */
table.pt-list td { --row:var(--button-color); padding:0 10px; height:40px; background-color:var(--row); box-shadow:1px 0 0 var(--row);
  white-space:nowrap; transition:background-color 0.1s ease-in-out, box-shadow 0.1s ease-in-out; }
table.pt-list td:last-child { clip-path:polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%); padding-right:18px; }
table.pt-list .r { text-align:right; }
table.pt-list tr.click { cursor:pointer; }
table.pt-list tr.click:hover > td { --row:var(--button-hover-color); }
table.pt-list tr.self > td, table.pt-list tr.open > td { --row:#2e4182; }
table.pt-list tr.total > td { --row:var(--surface-tertiary-color); }
table.pt-list tr.faded > td { color:rgba(255, 255, 255, 0.5); }
table.pt-list td.wrap { white-space:normal; }
table.pt-list th.sort { cursor:pointer; }
table.pt-list th.sort:hover { opacity:1; text-decoration:underline; }
table.pt-list th.sorted { opacity:1; }
table.pt-list .button { margin:0 4px 0 0; padding:3px 12px; font-size:18px; background-color:var(--surface-color); }
table.pt-list .ord { font-size:0.7em; opacity:0.3; }
table.pt-list .flag { width:28px; height:21px; margin-right:8px; vertical-align:-3px; filter:drop-shadow(2px 2px 1px rgba(0, 0, 0, 0.5)); }
.pt-list-wrap { margin:0 10px; }

/* a bar that fills, like the game's loading bar */
.pt-progress { height:12px; margin:10px 10px 0; padding:3px; background-color:var(--surface-tertiary-color);
  clip-path:polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%); }
.pt-progress > div { width:0; height:100%; background-color:#fff; clip-path:polygon(2px 0, 100% 0, calc(100% - 2px) 100%, 0 100%);
  transition:width 0.2s ease-out; }
.pt-meter { display:inline-block; width:90px; height:8px; margin-left:10px; vertical-align:middle; background-color:var(--surface-tertiary-color); }
.pt-meter > i { display:block; height:100%; background-color:#7272c2; }
.pt-meter.bad > i { background-color:#f55; }

/* a switch, like the leaderboard's "Only verified" */
.button.pt-toggle { font-size:22px; line-height:32px; padding:6px 16px; }
.button.pt-toggle > img { width:26px; margin:0 0 -6px 8px; }
.button.pt-toggle.off { color:rgba(255, 255, 255, 0.35); }
.button.pt-toggle.off > img { opacity:0.25; }

/* options side by side, the selected one lit, like Settings */
.pt-choice { display:inline-flex; }
.pt-choice > .button { margin:0 -2px; padding:6px 14px; font-size:22px; }
.pt-choice > .button.selected { background-color:var(--button-hover-color); }

/* a search field, like the track list's */
.pt-search { display:flex; flex:1 1 320px; max-width:520px; height:48px; }
.pt-search > input[type="text"] { flex:1 1 auto; min-width:0; margin:0 -10px 0 0; padding:0 20px; text-indent:2px;
  clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-search > img { padding:0 16px; width:24px; background-color:var(--button-hover-color);
  clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.pt-panel textarea { box-sizing:border-box; width:100%; min-height:110px; margin:0; padding:10px; resize:vertical; border:none;
  background-color:var(--surface-tertiary-color); color:var(--text-color); font-size:20px; word-break:break-all; pointer-events:auto; }
.pt-panel textarea:focus-visible { outline:none; }
.pt-panel textarea::placeholder { color:var(--text-color); opacity:0.25; }

/* key names, as chips like the game's own hints draw them */
.pt-key { display:inline-block; box-sizing:border-box; min-width:1.6em; margin:0 2px; padding:0 0.4em; line-height:1.5em;
  text-align:center; font-style:normal; background-color:var(--button-color); border-radius:4px; }
.pt-key.unbound { opacity:0.5; }

/* a message that comes and goes */
.pt-toast { position:absolute; left:50%; bottom:150px; z-index:60; box-sizing:border-box; max-width:80%; padding:10px 24px;
  font-size:24px; text-align:center; color:var(--text-color); background-color:var(--surface-color);
  clip-path:polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); pointer-events:none;
  opacity:0; transform:translate(-50%, 12px); transition:opacity 0.15s ease-out, transform 0.15s ease-out; }
.pt-toast.show { opacity:1; transform:translate(-50%, 0); }
.pt-toast.race.show { opacity:0.9; }

@media (prefers-reduced-motion: reduce) {
  .settings-menu-ui, .track-info-ui, .multiplayer-ui > .join, .multiplayer-ui > .host, .player-list-ui, .invite-ui,
  .news-popup-ui, .graph-ui, .message-box-ui > div, .track-export-ui > .box, .terms-privacy-ui,
  .editor-help-ui > .container, .editor-track-settings-ui > .container, .profile-selection-ui > .container,
  .profile-settings-ui > .container, .user-export-ui > .container, .country-selection-ui > .container, .track-selection-ui > .bar,
  .track-selection-ui > .image-button-container, .track-selection-ui .tracks-container.open > .wrapper,
  .pt-panel, .pt-panel > .pt-content.pt-swap { animation:none; }
  .pt-toast { transition:none; }
}
`;

  const ORD = ['th', 'st', 'nd', 'rd'];

  const PTUI = {
    el,

    /** A button in the game's style, with one of its icons before (or after) the words. */
    button(label, icon, iconAfter) {
      const b = el('button', 'button');
      if (icon && !iconAfter) { const i = el('img', 'button-icon'); i.src = 'images/' + icon; b.appendChild(i); b.appendChild(document.createTextNode(' ')); }
      b.appendChild(document.createTextNode(label));
      if (icon && iconAfter) { b.appendChild(document.createTextNode(' ')); const i = el('img', 'button-icon'); i.src = 'images/' + icon; b.appendChild(i); }
      return b;
    },

    /**
     * A full-height screen like Settings: a centred title, optional tabs, the content, and a bar
     * with Back on the left. `behind` names what to hide while it is up (the screen it was opened
     * from), so it sits on the menu's backdrop the way the game's own screens do; with no menu
     * behind it (in a race) it brings that backdrop itself.
     */
    page({ cls, title, tabs, onTab, onBack, behind, tools, pager }) {
      const root = el('div', 'pt-page hidden' + (cls ? ' ' + cls : ''));
      const panel = el('div', 'pt-panel');
      const h = el('h2', 'pt-title', title);
      const sub = el('div', 'pt-sub');
      panel.append(h, sub);
      let tabRow = null;
      if (tabs) {
        tabRow = el('div', 'pt-tabs');
        for (const [id, label] of tabs) {
          const b = el('button', 'button', label);
          b.dataset.tab = id;
          b.addEventListener('click', () => { if (onTab) onTab(id); });
          tabRow.appendChild(b);
        }
        panel.appendChild(tabRow);
      }
      const toolRow = tools ? el('div', 'pt-tools') : null;
      if (toolRow) panel.appendChild(toolRow);
      const content = el('div', 'pt-content');
      const pageRow = pager ? el('div', 'pt-pages') : null;
      const bar = el('div', 'pt-bar');
      const back = PTUI.button('Back', 'back.svg');
      back.classList.add('pt-back');
      back.addEventListener('click', () => { if (onBack) onBack(); });
      bar.appendChild(back);
      panel.appendChild(content);
      if (pageRow) panel.appendChild(pageRow);
      panel.appendChild(bar);
      root.appendChild(panel);
      (document.getElementById('ui') || document.body).appendChild(root);
      let hidden = [];
      return {
        root, panel, title: h, sub, tabs: tabRow, tools: toolRow, content, pages: pageRow, bar, back,
        get open() { return !root.classList.contains('hidden'); },
        setTab(id) { if (tabRow) for (const b of tabRow.children) b.classList.toggle('selected', b.dataset.tab === id); },
        /** Fades freshly drawn content in. */
        swap() { content.classList.remove('pt-swap'); void content.offsetWidth; content.classList.add('pt-swap'); },
        show() {
          const menu = document.querySelector('.menu-ui');
          const backdrop = !!(menu && !menu.classList.contains('hidden') && menu.offsetParent !== null);
          for (const e of hidden) e.classList.remove('pt-behind');
          hidden = [];
          for (const e of (behind ? behind() : [])) if (e && !e.classList.contains('pt-behind')) { e.classList.add('pt-behind'); hidden.push(e); }
          root.classList.toggle('dim', !backdrop);
          root.classList.remove('hidden');
        },
        hide() {
          root.classList.add('hidden');
          for (const e of hidden) e.classList.remove('pt-behind');
          hidden = [];
        },
      };
    },

    /** Changes a button's words (and icon) in place. */
    relabel(b, label, icon, iconAfter) {
      b.textContent = '';
      if (icon && !iconAfter) { const i = el('img', 'button-icon'); i.src = 'images/' + icon; b.append(i, ' '); }
      b.appendChild(document.createTextNode(label));
      if (icon && iconAfter) { const i = el('img', 'button-icon'); i.src = 'images/' + icon; b.append(' ', i); }
    },

    /** Page buttons like the leaderboard's: ‹, up to seven numbers around the current page, ›. */
    pager(host, current, count, go) {
      host.textContent = '';
      if (count <= 1) return;
      const add = (label, to, cls, off) => {
        const b = el('button', 'button' + (cls ? ' ' + cls : ''), label);
        b.disabled = !!off;
        b.addEventListener('click', () => go(to));
        host.appendChild(b);
      };
      add('<', current - 1, null, current <= 0);
      const first = Math.max(0, Math.min(current - 3, count - 7));
      for (let i = first; i < Math.min(count, first + 7); i++) add(String(i + 1), i, 'page' + (i === current ? ' selected' : ''));
      add('>', current + 1, null, current >= count - 1);
    },

    card(parent, title, note) {
      const c = el('div', 'pt-card');
      if (title) { const h = el('h3', null, title); if (note) h.appendChild(el('small', null, note)); c.appendChild(h); }
      parent.appendChild(c);
      return c;
    },

    /** Numbers over their labels: [[label, value, class?], ...]. */
    tiles(parent, items) {
      const wrap = el('div', 'pt-tiles');
      for (const [k, v, cls] of items) {
        const t = el('div', 'pt-tile');
        t.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
        t.appendChild(el('div', 'k', k));
        wrap.appendChild(t);
      }
      parent.appendChild(wrap);
      return wrap;
    },

    /** A list table with a header row; columns are [label, 'r' to right-align]. */
    list(columns, cls) {
      const table = el('table', 'pt-list' + (cls ? ' ' + cls : ''));
      const tr = el('tr');
      for (const c of columns) {
        const [label, align] = Array.isArray(c) ? c : [c];
        tr.appendChild(el('th', align || null, label));
      }
      table.appendChild(tr);
      return table;
    },

    /** "1st", "2nd", "23rd" — the suffix small and faint, as the game's leaderboard writes positions. */
    ordinal(n) {
      const f = document.createDocumentFragment();
      const k = n % 100;
      f.appendChild(document.createTextNode(n.toLocaleString()));
      f.appendChild(el('span', 'ord', (k >= 11 && k <= 13) ? 'th' : (ORD[n % 10] || 'th')));
      return f;
    },

    /** An on/off switch drawn like the leaderboard's "Only verified". */
    toggle(label, on, onChange) {
      const b = el('button', 'button pt-toggle' + (on ? '' : ' off'));
      b.appendChild(document.createTextNode(label));
      const i = el('img');
      i.src = 'images/checkmark.svg';
      b.appendChild(i);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', () => {
        const now = b.classList.contains('off');
        b.classList.toggle('off', !now);
        b.setAttribute('aria-pressed', now ? 'true' : 'false');
        if (onChange) onChange(now);
      });
      return b;
    },

    /** Options side by side, the chosen one lit: [[value, label], ...]. */
    choice(options, value, onChange) {
      const wrap = el('div', 'pt-choice');
      for (const [v, label] of options) {
        const b = el('button', 'button' + (v === value ? ' selected' : ''), label);
        b.addEventListener('click', () => {
          for (const x of wrap.children) x.classList.toggle('selected', x === b);
          if (onChange) onChange(v);
        });
        wrap.appendChild(b);
      }
      return wrap;
    },

    /** A search field with the game's magnifier. */
    search(placeholder, onInput) {
      const wrap = el('div', 'pt-search');
      const input = el('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.spellcheck = false;
      // typing here must not drive the game underneath
      for (const t of ['keydown', 'keyup', 'keypress']) input.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      input.addEventListener('input', () => { if (onInput) onInput(input.value); });
      const icon = el('img');
      icon.src = 'images/search.svg';
      wrap.append(input, icon);
      wrap.input = input;
      return wrap;
    },

    /** A button that opens the file picker, instead of the browser's own "Choose File". */
    fileButton(label, accept, onText) {
      const b = PTUI.button(label, 'import.svg');
      const input = el('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        input.value = '';
        if (f) f.text().then(onText, () => PTUI.toast('Could not read that file.'));
      });
      b.addEventListener('click', () => input.click());
      b.appendChild(input);
      return b;
    },

    /** A bar that fills (0..1). */
    progress() {
      const root = el('div', 'pt-progress');
      const fill = el('div');
      root.appendChild(fill);
      return { root, set(f) { fill.style.width = (100 * Math.max(0, Math.min(1, f || 0))).toFixed(1) + '%'; } };
    },

    /** A short bar for a value against the largest of its kind. */
    meter(fraction, bad) {
      const m = el('span', 'pt-meter' + (bad ? ' bad' : ''));
      const i = el('i');
      i.style.width = (100 * Math.max(0, Math.min(1, fraction || 0))).toFixed(1) + '%';
      m.appendChild(i);
      return m;
    },

    /** One key name as a chip. */
    key(label) { return el('span', 'pt-key', label); },

    /** A game key binding's keys as chips ("[" or ";"), or "unbound". */
    keys(name) {
      const frag = document.createDocumentFragment();
      const K = window.PTKeys;
      const codes = K ? K.codes(name) : [];
      if (!codes.length) { frag.appendChild(el('span', 'pt-key unbound', 'unbound')); return frag; }
      codes.forEach((c, i) => {
        if (i) frag.appendChild(document.createTextNode(' or '));
        frag.appendChild(PTUI.key(K.keyName(c)));
      });
      return frag;
    },

    /** A message for a few seconds, low in the middle: above the timer in a race, above the bottom bar elsewhere. */
    toast(text, ms) {
      let t = document.querySelector('.pt-toast');
      if (!t) { t = el('div', 'pt-toast'); (document.getElementById('ui') || document.body).appendChild(t); }
      const timer = document.querySelector('.timer-ui');
      t.classList.toggle('race', !!(timer && timer.offsetParent !== null && !timer.classList.contains('up')));
      t.textContent = text;
      t.classList.add('show');
      clearTimeout(PTUI._toast);
      PTUI._toast = setTimeout(() => t.classList.remove('show'), ms || 2600);
    },

    /** The editor's help writes keys as "[KeyW]": make them chips with the game's names for them. */
    keyChips(root) {
      try {
        const name = (code) => (window.__ptKeyName ? window.__ptKeyName(code) : code.replace(/^Key|^Digit/, ''));
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\[[A-Za-z0-9]+\]/.test(n.nodeValue)) nodes.push(n);
        for (const n of nodes) {
          const frag = document.createDocumentFragment();
          let last = 0;
          const text = n.nodeValue;
          text.replace(/\[([A-Za-z0-9]+)\]/g, (m, code, at) => {
            if (at > last) frag.appendChild(document.createTextNode(text.slice(last, at)));
            frag.appendChild(PTUI.key(name(code)));
            last = at + m.length;
            return m;
          });
          if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
          n.parentNode.replaceChild(frag, n);
        }
      } catch (e) { console.warn('[ui] key chips', e); }
    },
  };

  const st = el('style');
  st.id = 'pt-ui-css';
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);

  window.PTUI = PTUI;
})();
