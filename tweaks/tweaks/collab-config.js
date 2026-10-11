/*
 * Collaborative editor: where to find a signaling server.
 *
 * Desktop build: leave `signaling` null. The game's own API client is used, which talks to Kodub's
 * multiplayer servers exactly like stock multiplayer does.
 *
 * Web build (GitHub Pages or any other domain): Kodub's API only answers requests from Kodub's own
 * domains, so hosting/joining through them is impossible from another site. Point `signaling` at your
 * own server instead (see web/signaling-server/ in the mod source):
 *
 *   window.PTCollabConfig = {
 *     signaling: null,
 *     iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
 *   };
 *
 * `iceServers` is optional; public STUN servers are used when it is empty. STUN alone fails for players
 * behind a strict NAT — add a TURN server (with `username` and `credential`) if you want it to work for
 * everyone.
 */
window.PTCollabConfig = Object.assign({
  signaling: null,
  iceServers: [],
}, window.PTCollabConfig || {});

/*
 * Leaderboards, profiles and saved runs.
 *
 * Desktop build: leave `apiBase` null and the game talks to Kodub's backend as it always has.
 *
 * Web build: Kodub's backend only answers Kodub's own domains, so the official leaderboard is out of
 * reach from another site - that is their access control, not a bug to route around. You can instead
 * run the community leaderboard in web/signaling-server/ (the same server as the signaling one) and
 * point this at it:
 *
 *   window.PTLeaderboardConfig = {
 *     apiBase: null,
 *     label: 'Tweaks community leaderboard',
 *   };
 *
 * Times on it are unverified and separate from the official boards, and the leaderboard screen says
 * so while it is in use.
 */
window.PTLeaderboardConfig = Object.assign({
  apiBase: null,
  label: null,
}, window.PTLeaderboardConfig || {});
