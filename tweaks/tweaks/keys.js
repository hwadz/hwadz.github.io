/*
 * PolyTrack Tweaks — the mod's keys, kept with the game's own.
 *
 * Every key the mod listens for is a key binding of the game itself: main.bundle.js adds the mod's
 * actions to the game's list, so they are set in Settings → Controls (the two "Tweaks" sections),
 * saved with the game's bindings and put back by its Reset button. This file is how the mod's
 * scripts read them.
 *
 * Keys chosen before this (in the statistics screen) are carried over once.
 */
(function () {
  'use strict';

  const MIGRATED = 'pt-keys-migrated-v1';
  const loadJSON = (key) => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } };

  // where each action used to be kept, and the key it had by default there
  const OLD = [
    ['pt-practice-prefs-v1', 'slower', 'BracketLeft', 'TweaksPracticeSlower'],
    ['pt-practice-prefs-v1', 'faster', 'BracketRight', 'TweaksPracticeFaster'],
    ['pt-practice-prefs-v1', 'normal', 'Backslash', 'TweaksPracticeNormal'],
    ['pt-practice-prefs-v1', 'save', 'F5', 'TweaksPracticeSave'],
    ['pt-practice-prefs-v1', 'load', 'F6', 'TweaksPracticeLoad'],
    ['pt-practice-prefs-v1', 'forget', 'F7', 'TweaksPracticeForget'],
    ['pt-practice-prefs-v1', 'cycle', 'F4', 'TweaksPracticeSlot'],
    ['pt-runs-prefs-v1', 'statsKey', 'F8', 'TweaksStatistics'],
    ['pt-runs-prefs-v1', 'clipKey', 'F9', 'TweaksSaveClip'],
  ];

  const PTKeys = {
    ready() { return !!(window.__ptSettingsMgr && window.__ptKeyEnum); },

    /** Does this key event press the action (e.g. 'TweaksPracticeSlower')? */
    is(e, name) {
      if (!this.ready()) return false;
      this.migrate();
      const id = window.__ptKeyEnum[name];
      return id != null && window.__ptSettingsMgr.checkKeyBinding(e, id);
    },

    /** The key codes bound to an action: up to two, no empty slots. */
    codes(name) {
      if (!this.ready()) return [];
      this.migrate();
      const id = window.__ptKeyEnum[name];
      if (id == null) return [];
      return (window.__ptSettingsMgr.getKeyBindings(id) || []).filter(Boolean);
    },

    /** One key's name as the game writes it ("[" for BracketLeft, "↑" for ArrowUp). */
    keyName(code) { return window.__ptKeyName ? window.__ptKeyName(code) : String(code || '').replace(/^Key|^Digit/, ''); },

    /** The action's keys as text: "F5", "[ or ;", or "unbound". */
    label(name) {
      const codes = this.codes(name);
      return codes.length ? codes.map((c) => this.keyName(c)).join(' or ') : 'unbound';
    },

    /** The action's keys as small chips (styled in ui.js), so "[" can't be read as part of the sentence around it. */
    caps(name) {
      const frag = document.createDocumentFragment();
      const codes = this.codes(name);
      if (!codes.length) { const s = document.createElement('span'); s.className = 'pt-key unbound'; s.textContent = 'unbound'; frag.appendChild(s); return frag; }
      codes.forEach((c, i) => {
        if (i) frag.appendChild(document.createTextNode(' or '));
        const k = document.createElement('span');
        k.className = 'pt-key';
        k.textContent = this.keyName(c);
        frag.appendChild(k);
      });
      return frag;
    },

    /** Keys picked in the old statistics-screen settings become the game bindings, once. */
    migrate() {
      if (this.migrated) return;
      this.migrated = true;
      try {
        if (localStorage.getItem(MIGRATED)) return;
        const changes = [];
        for (const [store, field, old, name] of OLD) {
          const prefs = loadJSON(store);
          const code = prefs && prefs[field];
          const id = window.__ptKeyEnum[name];
          if (typeof code === 'string' && code && code !== old && id != null) changes.push([id, [code, null]]);
        }
        if (changes.length) window.__ptSettingsMgr.setKeyBindings(changes);
        localStorage.setItem(MIGRATED, '1');
      } catch (e) { console.warn('[keys] could not carry over the old key choices', e); }
    },
  };

  window.PTKeys = PTKeys;

  // carry old choices over as soon as the game's settings exist, so Settings shows them from the start
  let tries = 0;
  const settle = () => {
    if (PTKeys.ready()) PTKeys.migrate();
    else if (++tries < 120) setTimeout(settle, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', settle);
  else settle();
})();
