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
window.PTCollabConfig = {
  signaling: null,
  iceServers: [],
};
