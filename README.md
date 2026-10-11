# hwadz.github.io
hi this is random stuff ive made stuff idk blah blah blah

## what's here

- `tweaks/` — PolyTrack Tweaks 0.6.3, web build. Play at https://hwadz.github.io/tweaks/
- `ultramix/` — the earlier mix
- `signaling-server/` — small server for this site: it introduces players to each other for the
  collaborative editor, and can serve a community leaderboard (see below)

## leaderboards on the web

Kodub's backend answers requests from Kodub's own domains only — from here it replies `403`, with no
CORS headers, whether or not an Origin is sent. That is their access control, and a web page cannot
set the Origin header that would get around it, so the official leaderboard is not reachable from
this site and this mod does not try to fake it.

What the mod can do is talk to a different backend. Every endpoint the game uses is built from one
address, so `tweaks/collab-config.js` can point the whole client at a server of your own:

```js
window.PTLeaderboardConfig = {
  apiBase: 'https://your-server.example.com/',
  label: 'Tweaks community leaderboard',
};
```

`signaling-server/` serves those endpoints (`v6/leaderboard`, `v6/leaderboardUserEntry`,
`v6/recordings`, `v6/user`, `v6/iceServers`) alongside the collab signaling, so one deploy covers
both. It keeps one best time per player per track, hands back the recording so ghosts and the replay
viewer work, and the leaderboard screen says on screen which server it is reading and that the runs
are **not verified** — it has no physics, so it cannot check a time, and nobody should mistake it for
the official board.

## collaborative editor on the web

Kodub's servers only answer kodub.com, so the Collaborate button can't use them from here. It needs
its own signaling server: all that does is introduce two players to each other, after which the track
data goes directly between them.

1. Deploy `signaling-server/` anywhere that runs Node with WebSockets (Render, Fly.io, Railway, a VPS).
   It must be reachable over `wss://` — this site is HTTPS, and browsers block plain `ws://` from it.
2. Set `ALLOWED_ORIGINS=https://hwadz.github.io` on it so only this site can use it.
3. Put the URL in [`tweaks/collab-config.js`](tweaks/collab-config.js):

   ```js
   window.PTCollabConfig = {
     signaling: 'wss://your-server-here',
     iceServers: [],
   };
   ```

Until then, Collaborate says it isn't set up on this site. Everything else — the editor, official and
community tracks, replays, all the tweaks — works without it.

Leaderboards, verified runs and official multiplayer races are desktop-only and can't work here.

Rebuild `tweaks/` from the mod source with:

```
node web/build-web.mjs --out ../hwadz.github.io/tweaks --signaling wss://your-server-here
```
