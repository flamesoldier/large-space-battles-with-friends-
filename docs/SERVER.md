# Running the game online

The server (`server/`) runs the real game: one galaxy, a clock that runs in real time whether
anyone is looking or not, battles resolved in a worker thread, and replays saved to disk. Players
open the website, type their password, and play as their player. Plain Node 20+, no other
dependencies.

## Putting it online with Railway (no command line needed)

[Railway](https://railway.com) builds the game straight from this GitHub repo, keeps it running,
and gives it a web address with HTTPS. A new account gets a free trial; after that the Hobby plan
is $5 a month, which covers a game this size. Everything below is clicks in the browser.

1. **Sign up** at railway.com with "Login with GitHub" (the account that owns this repo).
2. **New project**: click *New Project* → *Deploy from GitHub repo* → pick
   `large-space-battles-with-friends-` (allow Railway to see it if it asks). It starts building;
   the first deploy can fail or wait until steps 3–4 are done, that's fine.
3. **Admin password**: click the new service → *Variables* tab → *New Variable*. Name
   `LSB_ADMIN_PASSWORD`, value: a long password only you know (10+ characters; this is not a
   player password, it unlocks the admin page). Add a second variable `PORT` = `8080`. Save
   (Railway may ask to redeploy: say yes).
4. **Storage**: right-click an empty spot on the project canvas (or press Ctrl/⌘+K) → *Volume* →
   attach it to the game service, mount path `/data`. Without it, the game would be wiped every
   time the server restarts. The server finds the volume by itself.
5. **Web address**: service → *Settings* → *Networking* → *Generate Domain*. You get something like
   `large-space-battles-production.up.railway.app`. If it asks which port, type `8080`.
6. Wait for the deploy to turn green (*Deployments* tab), then open
   `https://<your address>/admin`, log in with the admin password, set the number of players and
   click **Create the game**. Copy the passwords it shows: they're shown only once. (You can type
   names for the first seats, e.g. your own; leave the rest empty.)
7. Send each friend the address `https://<your address>` and one password each, privately. The
   first time they log in they pick their own name and colour.

### Your own domain name (optional)

To have the game at `https://yourgame.com` instead of `….up.railway.app`: buy the name from a
registrar (Cloudflare, Porkbun or Namecheap; usually $10–15 a year), then in Railway go to the
service → *Settings* → *Networking* → *Custom Domain*, type the name, and add the DNS record
Railway shows you at the registrar (on the registrar's DNS page). HTTPS for it is set up
automatically once the record works (minutes to a few hours). Custom domains need Railway's paid
Hobby plan, not the trial. A bare `yourgame.com` needs a registrar that supports CNAME
flattening (Cloudflare does); `play.yourgame.com` works anywhere.

From then on, every push to the repo's main branch redeploys automatically; the game carries on
(it lives on the volume). If the site shows an error, the *Deployments* tab → *View logs* says why.

## On your own computer

```sh
npm install
npm run build                                       # writes dist/play.html (the game page)
LSB_ADMIN_PASSWORD="a long admin password" npm start   # http://localhost:8080, admin at /admin
```

Or without the admin page: `npm run admin -- new-game --players "Rowan,Sam,Alex,Jo"` prints each
player's password once (optional: `--teams "A,A,B,B"` for who starts allied, `--seed 42` for the
map, `--worlds 7` worlds per player), then `npm start`.

Copy the passwords somewhere safe when they're shown and send each friend theirs privately
(a direct message, not the group chat). Only hashes are stored, so they can't be shown again;
if one is lost, make a new one (below).

## Passwords and accounts

- **The password is the player.** There are no usernames: the server checks the password against
  every player's and logs you in as whoever it belongs to. Every password is different.
- Passwords are generated: 12 random characters like `k7pm-x3qa-9fwe` (about 59 bits), with no
  look-alike characters. Capitals and stray spaces are forgiven when typing.
- After logging in, the browser keeps a session cookie for 30 days (HttpOnly, SameSite=Strict),
  so friends only type the password once per device. **Log out** in the top bar ends it.
- The server decides who you are from your session for **every** action. The page never says
  which player it is, so nobody can send orders, sell shipyards or move fleets as someone else,
  even with the browser's developer tools.
- Wrong passwords: 8 in 15 minutes from one address and that address is blocked for the rest of
  the 15 minutes. Failed and successful logins are printed in the server log.

**Open seats:** a game has a number of seats (2–10). Seats you don't name are open: whoever logs
in with that seat's password picks their name and colour once, on first login (names must differ;
colours come from 18, minus the ones taken). Named seats keep the name you gave. An open seat
nobody takes still has a home world and income, and others can conquer it, so make the game the
size of the group that's actually playing.

The **admin page** (`/admin`, needs `LSB_ADMIN_PASSWORD` set on the server): create the game,
see the players, give one of them a new password (logs them out everywhere), or replace the game
with a new one. Admin logins share the rate limit and last 12 hours.

The same from the command line, on the server machine:

```sh
npm run admin -- players                         # list players
npm run admin -- reset-password Sam              # new password for Sam, logs Sam out everywhere
npm run admin -- reset-password Sam --password "our-own-choice"   # pick it yourself (8+ chars)
npm run admin -- passwords                       # new passwords for everyone
npm run admin -- new-game --players "..." --force   # replace the game (stop the server first)
```

`reset-password` works while the server is running.

## Settings

Environment variables for `npm start`:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | 8080 | |
| `HOST` | 0.0.0.0 | `127.0.0.1` when a proxy on the same machine does HTTPS |
| `LSB_DATA` | Railway volume, else `./data` | game, accounts, sessions, replays |
| `LSB_ADMIN_PASSWORD` | (off) | turns on `/admin`; 10+ characters |
| `LSB_SPEED` | 1 | game speed; 1 = real time (60 for a quick test) |
| `LSB_TRUST_PROXY` | off (on, on Railway) | set to `1` behind Caddy/nginx: marks the cookie Secure and reads the client address from `X-Forwarded-For` |

## Your own server instead (VPS)

**Use HTTPS.** Without it, passwords and session cookies cross the network in plain text, and
anyone on the same café Wi-Fi could log in as your friend.

The simplest setup is a small Linux VPS (1 vCPU and 1–2 GB of RAM is plenty for 4–10 players;
a 2,000-ship battle takes about 8 s of one core) with a domain name pointed at it, and
[Caddy](https://caddyserver.com) in front, which gets and renews the HTTPS certificate by itself.

1. On the server: install Node 20+ and Caddy, clone the repo, then
   `npm install && npm run build && npm run admin -- new-game --players "..."`.
2. `/etc/caddy/Caddyfile`:

   ```
   galaxy.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

3. Run the game as a service, `/etc/systemd/system/lsb.service`:

   ```ini
   [Unit]
   Description=Large Space Battles
   After=network.target

   [Service]
   WorkingDirectory=/home/lsb/large-space-battles-with-friends-
   ExecStart=/usr/bin/node server/server.mjs
   Environment=HOST=127.0.0.1 PORT=8080 LSB_TRUST_PROXY=1
   User=lsb
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now lsb caddy`, then open `https://galaxy.example.com`.

Only open ports 80 and 443 in the firewall (not 8080). Other hosts with a persistent disk
(Fly.io, Render) work too: point `LSB_DATA` at the persistent volume, set `LSB_TRUST_PROXY=1`
since they terminate HTTPS for you, and run a single instance (the game lives in one process).

**Updating:** `git pull && npm run build`, then `sudo systemctl restart lsb`. The page is
re-read after a build even without a restart; server code changes need the restart. The game,
its clock and everyone's sessions carry on across restarts, and time the server was down counts
(fleets that should have arrived meanwhile arrive, battles they owe are fought).

**Backups:** copy the `data/` folder (`game.json` is the whole galaxy; `replays/` can be large).

## How it works

- `server/game.mjs`: the world is the same JSON object and the same rule functions
  (`src/world/`) as the hot-seat page. Game time is `anchor + (now − anchorWall) × speed`.
  Every change (the 1-second tick that processes arrivals, sieges and battles, and every player
  action) runs under one lock, in order. Each action first brings the world up to now.
- Battles run in `server/battleWorker.mjs` (a worker thread) so the server keeps answering
  while one resolves. Meanwhile the world waits at the moment the battle started (as the page
  did), actions wait their turn, and every player sees a progress card. Replays are stored as
  `data/replays/<battle id>.bin.gz` and served gzipped; they're kept for the whole game.
- `server/server.mjs`: the HTTP API.
  - `GET /` the game page (`dist/play.html`), `GET /healthz`.
  - `POST /api/login {password}` → session cookie; `POST /api/logout`.
  - `GET /api/state?v=&wv=` long poll: answers as soon as anything changes (or after 25 s). The
    world is only sent when it changed since the client's copy (`wv`); battle progress alone
    sends the small status part.
  - `POST /api/act {type, ...}`: `fleet {from, to, ships, lanes, avoid}`, `build {planet,
    design}`, `sell {planet, yard}`, `propose|accept|decline|break {player}`. Every field is
    checked; the player always comes from the session.
  - `GET /api/replay/<id>` replay bytes, with title and sides in `X-Replay-Meta`.
  - `/admin` page and `/api/admin/{login,logout,state,new-game,reset-password}` (own cookie,
    `lsb_admin`). A new game replaces the running one in place: the old one finishes what it's
    doing, stops writing, and its players are sent back to the login screen.
  - With no game yet the site still runs: players are told it isn't set up, `/admin` makes one.
  - POSTs must be JSON, from the same origin; bodies are capped at 4 MB.
- `src/galaxy/net.js` and the `ONLINE` parts of `src/galaxy/app.js`: the page logs in, keeps its
  copy current, ticks income and shipyards forward locally between updates (pure functions of
  time), and sends actions. The build makes `dist/play.html` from the same page with
  `__ONLINE__` set; `dist/galaxy.html` is still the hot-seat game.
- `tools/test-server.mjs` (part of `npm test`) runs the real server on a temporary folder:
  logins, rate limit, impersonation attempts, malformed requests, a battle with its replay,
  password reset, and a restart.

## Not done yet

- **Fog of war:** every player's browser gets the whole world (as in the hot-seat game). The page
  shows everything anyway today; once fog of war is decided, the server should send each player
  only what they can see.
- The ship designer's library is still per browser (localStorage); designs in play are on the
  server.
- A battle that keeps crashing the worker (out of memory, say) is retried every second and holds
  the game up; the server log says so.
