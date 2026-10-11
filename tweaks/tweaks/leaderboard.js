/*
 * PolyTrack Tweaks — where the game's backend lives, and saying so.
 *
 * Kodub's API answers requests from Kodub's own domains only; from anywhere else it replies 403, and
 * a web page cannot set the Origin header that would change that. So a web build cannot read or
 * write the official leaderboard, and this mod does not try to pretend otherwise.
 *
 * What it can do is talk to a *different* backend. Every endpoint the game uses is built from one
 * address, so setting `apiBase` points the whole client — leaderboard, profiles, recordings — at a
 * server of your own (web/signaling-server/ in the mod source serves exactly those endpoints).
 * Times there are your community's, unverified, and nothing to do with the official boards.
 *
 * Desktop builds leave `apiBase` null and keep using Kodub's backend as usual.
 */
(function () {
  'use strict';

  const config = Object.assign({ apiBase: null, label: null }, window.PTLeaderboardConfig || {});
  const log = (...a) => console.log('[leaderboard]', ...a);

  const base = (() => {
    const v = config.apiBase;
    if (typeof v !== 'string' || !v) return null;
    if (!/^https?:\/\//.test(v)) { log('ignoring apiBase, it must start with http:// or https://:', v); return null; }
    return v.endsWith('/') ? v : v + '/';
  })();

  if (base) {
    window.PTApiBase = base;
    log('using', base, 'instead of the official backend');
  }

  const CSS = `
.pt-lb-banner { margin:0 10px 8px; padding:6px 8px; font-size:15px; line-height:1.35;
  background:var(--surface-secondary-color, rgba(0,0,0,0.2)); color:var(--text-color); opacity:0.85; }
.pt-lb-banner b { font-weight:normal; color:#ffc84a; }
.pt-lb-note { margin:0; padding:0 20px 16px; font-size:17px; line-height:1.4; text-align:center; color:var(--text-color); opacity:0.85; }
.pt-lb-note a { color:#8cd3ff; }
`;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const host = (() => { try { return new URL(base || 'http://x').host; } catch { return 'your server'; } })();
  const onKodub = /(^|\.)kodub\.com$/i.test(location.hostname);

  /**
   * Appended by the game when a leaderboard fails to load, so the reason is on screen instead of
   * just "Failed to load leaderboard".
   */
  window.PTLeaderboardNote = function (container) {
    try {
      if (!container || container.querySelector('.pt-lb-note')) return;
      const p = el('p', 'pt-lb-note');
      if (base) {
        p.textContent = 'This build is pointed at ' + host + ' for leaderboards, and that server did not answer.';
      } else if (!onKodub) {
        p.textContent = 'Leaderboards come from Kodub’s servers, which only answer requests from Kodub’s own '
          + 'domains — a site like this one cannot read them, and your times here stay on this device. '
          + 'A community leaderboard can be run instead: see README-WEB-BUILD.md in the mod.';
      } else {
        p.textContent = 'The leaderboard server did not answer. Check your connection and try again.';
      }
      container.appendChild(p);
    } catch (e) { log('could not add the note', e); }
  };

  // Nobody should mistake a community board for the official one, so it says where it came from.
  if (base) {
    const style = document.createElement('style');
    style.id = 'pt-lb-css';
    style.textContent = CSS;
    const addStyle = () => { if (document.head && !document.getElementById('pt-lb-css')) document.head.appendChild(style); };
    const mark = () => {
      for (const ui of document.querySelectorAll('.leaderboard-ui')) {
        if (ui.querySelector('.pt-lb-banner')) continue;
        const banner = el('div', 'pt-lb-banner');
        banner.appendChild(el('b', null, config.label || 'Community leaderboard'));
        banner.appendChild(document.createTextNode(' — ' + host + '. Not the official board, and runs here are not verified.'));
        const after = ui.querySelector('h3') || ui.querySelector('h2');
        if (after && after.parentElement === ui) after.insertAdjacentElement('afterend', banner);
        else ui.insertAdjacentElement('afterbegin', banner);
      }
    };
    const start = () => { addStyle(); mark(); new MutationObserver(mark).observe(document.body, { childList: true, subtree: true }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
