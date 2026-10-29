/*
 * PolyTrack Tweaks — a search field in Settings.
 *
 * Settings is one long list (language, gameplay, Tweaks, graphics, sound, every key binding...). A field
 * under its title narrows it as you type: a row stays if every word you typed is in its name, in one
 * of its choices or key names, or in the heading it sits under — "ghost" finds Ghost car, Ghost car
 * sounds and Toggle ghosts; "tweaks key" the mod's keys. Headings with nothing left under them go too.
 * Clearing the field brings everything back; Settings opens with it empty.
 */
(function () {
  'use strict';

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const CSS = `
.settings-menu-ui > .pt-set-search { display:flex; margin:0 10px 10px; }
.settings-menu-ui > .pt-set-search > .pt-search { flex:1 1 auto; max-width:none; height:44px; }
.settings-menu-ui > .pt-set-search > .pt-search > input { font-size:22px; }
.settings-menu-ui > .container > .pt-set-none { margin:30px 10px; font-size:24px; text-align:center; opacity:0.6; }
.settings-menu-ui .pt-set-hide { display:none !important; }
`;

  const PTSettingsSearch = {
    init() {
      const st = el('style'); st.id = 'pt-settingsearch-css'; st.textContent = CSS;
      document.head.appendChild(st);
    },

    /** main.bundle.js: the Settings screen and its list, as it builds them. */
    attach(root, list) {
      try {
        if (!window.PTUI || root.querySelector(':scope > .pt-set-search')) return;
        const holder = el('div', 'pt-set-search');
        const field = window.PTUI.search('Search settings…', (q) => this.apply(list, q));
        holder.appendChild(field);
        root.insertBefore(holder, list);
        this.field = field.input;
        // the game rebuilds the list (Reset): keep it narrowed to what is typed
        new MutationObserver(() => { if (!this.applying) this.apply(list, field.input.value); }).observe(list, { childList: true });
      } catch (e) { console.error('[settings search]', e); }
    },

    /** Words a row can be found by: its name, its choices, the key names on its buttons. */
    textOf(node) {
      if (!node) return '';
      let t = '';
      for (const c of node.querySelectorAll('p, button, input')) t += ' ' + (c.value && c.tagName === 'INPUT' && c.type !== 'range' ? c.value : c.textContent || '');
      return t.toLowerCase();
    },

    apply(list, query) {
      this.applying = true;
      try {
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        let section = null, sub = null, sectionShown = 0, subShown = 0, total = 0;
        const close = () => {
          if (sub) sub.classList.toggle('pt-set-hide', words.length > 0 && !subShown);
          if (section) section.classList.toggle('pt-set-hide', words.length > 0 && !sectionShown);
        };
        for (const node of list.children) {
          if (node.classList.contains('pt-set-none')) continue;
          if (node.tagName === 'H2') {
            if (sub) sub.classList.toggle('pt-set-hide', words.length > 0 && !subShown);
            if (section) section.classList.toggle('pt-set-hide', words.length > 0 && !sectionShown);
            section = node; sub = null; sectionShown = 0; subShown = 0;
            continue;
          }
          if (node.tagName === 'H3') {
            if (sub) sub.classList.toggle('pt-set-hide', words.length > 0 && !subShown);
            sub = node; subShown = 0;
            continue;
          }
          const where = ((section ? section.textContent : '') + ' ' + (sub ? sub.textContent : '')).toLowerCase();
          const text = this.textOf(node) + ' ' + where;
          const ok = words.every((w) => text.includes(w));
          node.classList.toggle('pt-set-hide', !ok);
          if (ok) { sectionShown++; subShown++; total++; }
        }
        close();
        let none = list.querySelector(':scope > .pt-set-none');
        if (words.length && !total) {
          if (!none) { none = el('p', 'pt-set-none'); list.appendChild(none); }
          none.textContent = 'No setting matches “' + query.trim() + '”.';
        } else if (none) none.remove();
        if (words.length) list.scrollTop = 0;
      } finally { this.applying = false; }
    },
  };

  window.PTSettingsSearch = PTSettingsSearch;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => PTSettingsSearch.init());
  else PTSettingsSearch.init();
})();
