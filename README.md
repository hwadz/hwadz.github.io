# hwadz.github.io
hi this is random stuff ive made stuff idk blah blah blah

## what's here

- `tweaks/` — PolyTrack Tweaks 0.6.2, web build. Play at https://hwadz.github.io/tweaks/
- `ultramix/` — the earlier mix
- `signaling-server/` — tiny server that lets the Tweaks collaborative editor work on this site

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
