# tmux-ronin

**Remote terminals in a browser.** Run it on your always-on home server and view/operate
your **live tmux sessions** from one browser tab — up to four real terminals at once. Pick
which session each tile shows from a dropdown, spawn new named sessions, and type straight
onto the box — from your laptop or phone, reachable anywhere over Tailscale, no SSH dance.

It's a thin bridge: **xterm.js** in the browser ⟷ websocket ⟷ **node-pty** running
`tmux attach` on the host. The tmux server is the always-on substrate; this just adds a
browser client alongside any SSH client you already use.

```
browser tab ──ws──> Express (:3006) ──node-pty──> tmux attach -t <session>
  xterm tiles                                       (grouped viewer sessions)
```

## Requirements

A home server (any always-on box — Raspberry Pi, mini PC, old laptop, NAS, Mac mini):

| Need | Notes |
|------|-------|
| **tmux** | required — the sessions live here |
| **Node.js 18+** | runs the bridge; `@lydell/node-pty` ships prebuilt binaries (incl. arm64), **no compiler** |
| **Tailscale** *(recommended)* | secure remote access + free HTTPS (`tailscale serve`). Swappable for any VPN / reverse-proxy. Install it on the server **and** the devices you connect from. |
| **OS** | server must be **Unix-like**: Linux (incl. Raspberry Pi), macOS, or Windows via WSL. The browser client is any OS. |

No root needed for the app itself (only the optional `tailscale serve` / `enable-linger`
steps use sudo).

## Setup — step by step

> Do this **on your home server** unless a step says otherwise.

**1 — Install tmux and Node 18+ on the server.**

```bash
# Debian / Ubuntu / Raspberry Pi:
sudo apt update && sudo apt install -y tmux
#   then install Node 18+ from https://nodejs.org (or fnm / nvm)
# macOS (Homebrew):
brew install tmux node
```

**2 — Install Tailscale** on the server *and* on every device you'll connect from
(phone, laptop), all signed into the **same** Tailscale account
(<https://tailscale.com/download>). Then bring the server online:

```bash
sudo tailscale up
```

*(Tailscale is recommended, not required — see [Access & security](#access--security) for
LAN-only or other-VPN setups.)*

**3 — Clone the repo and run setup:**

```bash
git clone <your-repo-url> tmux-ronin
cd tmux-ronin
./setup.sh
```

`setup.sh` installs dependencies, creates `.env`, and installs an always-on service
(systemd `--user` on Linux; it prints `launchd` steps on macOS).

**4 — Keep it running across reboots** (Linux):

```bash
sudo loginctl enable-linger "$USER"
```

**5 — (Recommended) Turn on tailnet HTTPS.** Needed for copy/paste, and gives you a clean
URL reachable from anywhere on your tailnet:

```bash
sudo tailscale serve --bg --https=8443 http://$(tailscale ip -4 | head -1):3006
```

Serves it **tailnet-only** (real cert, not public) at `https://<your-host>.ts.net:8443`.

**6 — Open it** on your laptop or phone:

- HTTPS (recommended): `https://<your-host>.ts.net:8443`
- or plain HTTP: `http://<server-tailnet-ip>:3006`

**Where do those come from?** `<your-host>.ts.net` is your server's Tailscale (MagicDNS)
name and `<server-tailnet-ip>` is its tailnet IP. You don't have to memorize them:
`setup.sh` prints your exact URLs when it finishes, and you can re-check anytime with:

```bash
tailscale serve status      # shows the live HTTPS URL (e.g. https://myhost.ts.net:8443)
tailscale ip -4             # the tailnet IP, for the http://<ip>:3006 form
```

**7 — If you have no tmux sessions yet,** make one on the server (or use **➕ new
session…** in the app), then pick it from a tile's dropdown:

```bash
tmux new -s work
```

### Verify / manage

```bash
HOST=127.0.0.1 PORT=3006 npm run smoke      # headless end-to-end self-test (server running)
systemctl --user status tmux-ronin          # service status (Linux)
journalctl --user -u tmux-ronin -f          # follow logs (Linux)
npm start                                   # run in the foreground instead of the service
```

## Access & security

By default the server **binds to the tailnet IP** (`tailscale ip -4`), so only devices
on your tailnet can reach it. The public internet
cannot open a socket to it.

Layers you can add (`.env`):

| Want | Do |
|------|-----|
| Local-only | `BIND=127.0.0.1` |
| Password gate | set `GRID_USER` **and** `GRID_PASS` (HTTP Basic auth on pages **and** the websocket) |
| Pin to exact devices | a Tailscale **ACL** in the admin console (tailnet-level, not app config) |

### Tailnet HTTPS (required for clipboard) — `tailscale serve`

Browsers only allow clipboard writes from a **secure context (HTTPS)**, so copy/paste
(see below) needs an HTTPS URL. We serve it tailnet-only (real cert, **not** the public
Funnel) on its own port, leaving the plain-HTTP URL and the gateway's Funnel untouched:

```bash
sudo tailscale set --operator=$USER                            # once, so serve needs no sudo
tailscale serve --bg --https=8443 http://<tailnet-ip>:3006     # -> https://<host>.ts.net:8443
tailscale serve status                                         # confirm
tailscale serve --https=8443 off                               # remove
```

Primary URL (use this on your laptop/phone): **`https://<your-host>.ts.net:8443`**. The
config persists across reboots. `wss` works through the proxy automatically.

### Public exposure via Funnel (optional, higher risk)

A live shell on the public internet is dangerous — **set `GRID_USER`/`GRID_PASS` first.**
Then enable Funnel:

```bash
tailscale funnel 3006        # serves https://<your-host>.ts.net -> :3006
tailscale funnel reset       # turn it back off
```

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3006` | listen port |
| `BIND` | tailnet IP | bind address; `127.0.0.1` local-only, `0.0.0.0` all interfaces (avoid on a public host) |
| `GRID_USER` / `GRID_PASS` | unset | enable HTTP Basic auth when both set |
| `TMUX_WINDOW_SIZE` | `latest` | `latest` \| `largest` \| `smallest` \| `manual` (see note) |
| `TMUX_MOUSE` | `on` | `on` = trackpad scrolls the conversation; `off` = wheel becomes Up/Down arrows |

## How tiles attach (and the one tmux caveat)

Each tile attaches to a **grouped "viewer" session** (`grid_<name>_…`) that shares the
target's windows but keeps its own current-window pointer — so switching windows in a
tile doesn't change what another attached client sees. Viewer sessions are hidden from the
picker and cleaned up on disconnect (and on startup, in case of a crash).

Caveat: tmux renders a given window at **one size** across all clients viewing it. If
you watch the same session in another client *and* a small grid tile, they share a size.
`TMUX_WINDOW_SIZE=latest` (default) makes the window follow whichever client you last
interacted with; `largest` keeps it at the largest client size and the small tile shows a
viewport. Pick what annoys you least. Attaching *different* sessions per tile (the
normal case) avoids this entirely.

### Scrolling

Trackpad/wheel in a tile scrolls the tmux scrollback — up and down the session
conversation (`TMUX_MOUSE=on`, the default). Keyboard **Up/Down arrows** still recall
prior prompt entries (history). Same shared-pane caveat as sizing: scrolling a tile that
shows the *same* session you're live in via another client also moves that view (grouped
sessions share the pane, and copy-mode is a property of the pane). Watching different
sessions per tile avoids it.

## Using it

### Desktop
- **Dropdown** on each tile → pick/switch which session that tile shows.
- **Click a tile** → it becomes active (keystrokes go there; highlighted border).
- **➕ new session…** in any dropdown → names and spawns a fresh tmux session.
- **1 / 2 / 4** buttons → how many tiles to show. **⟳** (top bar) → refresh sessions.
- **Trackpad/wheel** scrolls the conversation; keyboard **Up/Down** recalls history.
- **✕** detaches a tile; per-tile **⟳** reconnects. Tile→session layout is remembered
  in `localStorage`, so reopening the tab restores your grid.

### iPhone / iPad (the primary surface)
The touch experience is deliberately different from desktop — and every bit of it is
gated behind `IS_TOUCH`, so desktop is never affected:
- **The terminal is full-screen.** A tap only selects the tile; it does not pop the keyboard.
- **Type via the floating ⌨ button** (bottom-right): it opens a compose box that floats
  above the keyboard. Type / paste / dictate, **Enter sends** it to the active terminal,
  **✕** closes it. (Far easier than poking xterm's hidden field — paste & dictation work.)
- **Top-bar control keys** `Esc` · `^C` · `⤓` (jump to latest) act on the active terminal.
- **Scroll** by dragging one finger over the terminal.
- **Phones default to one full-screen, edge-to-edge terminal** (layout 1); the grid
  layout buttons are hidden on phones. iPad keeps the grid.

### Copy / paste
Click **⧉ Copy** (top bar) to open a panel containing the visible terminal text in a real
`<textarea>`. Select what you want and copy it **natively** — ⌘C/Ctrl-C on desktop,
long-press → **Copy** on iPhone/iPad — or hit **Copy all**. Close to return. This avoids
xterm's canvas-selection limits, so it works the same on any device, http or https.
**Paste into** the terminal is just ⌘V (or the compose box on touch).

## Frontend architecture (`public/`)

No framework — plain JS + xterm.js (UMD builds served from `node_modules` at `/vendor/*`).

- **`index.html`** — top bar (brand, `⧉ Copy`, `Esc`/`^C`/`⤓`, layout, refresh), empty
  `#grid`, loads `/vendor/xterm.js` + `addon-fit` + `app.js`.
- **`app.js`**
  - `class Tile` — one xterm `Terminal` + `FitAddon` + a websocket. Key methods:
    `connect` / `detach`, `activate` (highlight only, no keyboard), `focusTerminal`
    (desktop click-to-focus), `sendRaw`, `setupDragScroll`, `doFit`.
  - Globals: `IS_TOUCH`, `WHEEL_UP`/`WHEEL_DOWN` (SGR mouse-wheel sequences), `buildCopySheet`,
    `buildCompose` + `positionCompose` (the touch compose overlay floated above the
    keyboard), `setLayout`, `init`.
  - **WS protocol** (must stay in sync with `src/index.ts`):
    - client→server JSON: `{t:'i', d}` = input, `{t:'r', c, r}` = resize
    - server→client: raw **binary** = pty output; JSON `{t:'ready'|'exit'|'error'}` = control
  - **Scrolling** works by injecting SGR wheel sequences (`\x1b[<64;1;1M` up / `…65…M` down)
    into the pty as input; tmux `mouse on` (set on each viewer) turns them into scrollback.
  - **Copy**: the `⧉ Copy` button opens `#copysheet` (`buildCopySheet`) — a real `<textarea>`
    filled from `term.buffer` (`terminalText`) that you select & copy natively on any device.
- **`style.css`** — dark theme. Desktop vs touch split via `@media (pointer: coarse/fine)`;
  phone layout via `@media (max-width: 680px)`. The compose overlay & FAB are `position:
  fixed`; the page never shrinks (it stays full-screen and the overlay floats over it).

## For future agents — tuning guide

**Cardinal rule: do not change desktop behavior.** The owner uses this mostly on
iPhone/iPad but the desktop path "works awesome." Every touch/mobile change MUST be gated
behind `IS_TOUCH` (JS) or `@media (pointer: coarse)` / `@media (max-width: 680px)` (CSS),
The `⧉ Copy` panel works on every device.

**You cannot test on a real iPhone from the agent environment.** Reason from standard iOS
web behavior, keep changes isolated, then ask the owner to **reload Safari** (it caches
`app.js` — pull-to-refresh or reopen the tab) and report. Checks you *can* run headlessly:
- `node --check public/app.js` (syntax)
- `npm run smoke` against the **tailnet IP** (the service binds there, not `127.0.0.1`):
  `HOST=$(tailscale ip -4 | head -1) PORT=3006 npm run smoke`
- the scroll mechanism: open a ws viewer, send `\x1b[<64;1;1M`, then check
  `tmux display-message -t <viewer> -p '#{pane_in_mode}'` flips to `1` (entered copy-mode).

**Common tuning knobs** (all in `public/`):
- Drag-scroll sensitivity → `STEP` in `setupDragScroll`.
- Compose overlay (the touch text box) → `buildCompose` / `positionCompose`.
- Top-bar control keys + Copy panel → the `key(...)` wiring in `build()` + `buildCopySheet`.
- Phone single-terminal default → the `phone` / `firstRun` logic in `init`.
- Full-bleed single pane → `#grid.layout-1` rules in the `@media (max-width: 680px)` block.
- Theme / font / scrollback → `THEME` and the `new Terminal({...})` options in `Tile`.

**Deploy after changes:** `public/` is served live — just reload the browser. Server
changes (`src/`) need a service restart (`systemctl --user restart tmux-ronin`, or relaunch
`npm start`).

**Backend caveats to know before touching `src/`:**
- Must run on the **host** (needs the tmux socket `/tmp/tmux-<uid>/default`) — don't containerize.
- Uses **`@lydell/node-pty`** (prebuilt binary) so no compiler or sudo is needed.
- Viewer sessions (`grid_*`) are created per ws connection and **must** be killed on
  disconnect + on startup, or they leak.
- Same-pane caveats (window **size** and **copy-mode/scroll** are shared when another client and a
  tile view the same session) are tmux limitations, not bugs — see the caveats above.

## Files

```
src/index.ts       Express + ws + node-pty bridge, REST API, auth, tailnet bind, viewer cleanup
src/tmux.ts        tmux helpers: list/create/kill sessions, grouped viewer sessions (mouse/size opts)
src/config.ts      env parsing + tailnet-IP auto-bind
public/index.html  page shell; loads xterm + app.js
public/app.js      the whole frontend: Tile class, layouts, compose overlay, copy panel, ws client
public/style.css   dark theme; desktop/touch/phone breakpoints
scripts/smoke-test.mjs   headless end-to-end pipe test
deploy/tmux-ronin.service systemd --user unit
.env.example       all config vars with docs
```
