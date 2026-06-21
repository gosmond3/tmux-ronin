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
- **A tap does NOT pop the keyboard** — it only selects (activates) the tile. (Tapping
  used to focus the terminal and open the keyboard on every touch.)
- **⌨ button** (tile header) brings the keyboard up; tap again to dismiss.
- **Scroll the conversation** by dragging one finger over the terminal, or with **⤒ / ⤓**
  in the bottom key bar.
- **Bottom key bar** `Esc Tab Ctrl ^C ← ↑ ↓ → ⤒ ⤓` sits above the keyboard and acts on
  the active tile. **Ctrl is sticky** — tap it, then type a letter for Ctrl-⟨letter⟩.
- **Phones default to one full-screen, edge-to-edge terminal** (layout 1, no panel
  chrome). iPad keeps the grid. Tap **2/4** to change.
- The layout **shrinks above the on-screen keyboard** (`visualViewport`) so the line
  you're typing is never hidden.

### Copy / paste
Copy needs the **HTTPS URL** (`https://<your-host>.ts.net:8443`) — browsers block
clipboard writes over plain HTTP. With tmux `mouse on`, **drag-select** the text; tmux
copies it and emits **OSC 52**, which `@xterm/addon-clipboard` writes to your system
clipboard (⌘V / long-press-paste elsewhere). The on-screen highlight clears on release
(tmux behavior) but the text is already copied. **Paste into** the terminal is just ⌘V.
On the plain-HTTP URL the clipboard addon is inert (no secure context), so drag there
only does tmux's internal copy.

## Frontend architecture (`public/`)

No framework — plain JS + xterm.js (UMD builds served from `node_modules` at `/vendor/*`).

- **`index.html`** — top bar, empty `#grid`, loads `/vendor/xterm.js` + `addon-fit` + `app.js`.
- **`app.js`**
  - `class Tile` — one xterm `Terminal` + `FitAddon` + a websocket. Key methods:
    `connect` / `detach`, `activate` (highlight only, no keyboard), `focusTerminal`
    (activate + keyboard), `sendRaw`, `setupDragScroll`, `addTouchControls`, `doFit`.
  - Globals: `IS_TOUCH`, `WHEEL_UP`/`WHEEL_DOWN` (SGR mouse-wheel sequences), `applyCtrl`
    (sticky-Ctrl transform on the next typed char), `buildKeybar`/`handleKey`,
    `setupViewport` (visualViewport → `--app-h`), `setLayout`, `init`.
  - **WS protocol** (must stay in sync with `src/index.ts`):
    - client→server JSON: `{t:'i', d}` = input, `{t:'r', c, r}` = resize
    - server→client: raw **binary** = pty output; JSON `{t:'ready'|'exit'|'error'}` = control
  - **Scrolling** works by injecting SGR wheel sequences (`\x1b[<64;1;1M` up / `…65…M` down)
    into the pty as input; tmux `mouse on` (set on each viewer) turns them into scrollback.
- **`style.css`** — dark theme. Desktop vs touch split via `@media (pointer: coarse)`;
  phone layout via `@media (max-width: 680px)`. Body height = `var(--app-h, 100dvh)` so
  the keyboard can shrink the app on touch only.

## For future agents — tuning guide

**Cardinal rule: do not change desktop behavior.** The owner uses this mostly on
iPhone/iPad but the desktop path "works awesome." Every touch/mobile change MUST be gated
behind `IS_TOUCH` (JS) or `@media (pointer: coarse)` / `@media (max-width: 680px)` (CSS).
After any change, confirm the non-touch code path is byte-identical (e.g. `grep` that new
handlers live only inside `if (IS_TOUCH)`), and that `applyCtrl` stays a no-op unless the
touch key bar armed Ctrl.

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
- Key bar keys → the `KEYS` array in `buildKeybar` (sequences dispatched by `handleKey`).
- Phone single-terminal default → the `phone` / `firstRun` logic in `init`.
- Full-bleed single pane → `#grid.layout-1` rules in the `@media (max-width: 680px)` block.
- Keyboard-aware sizing → `setupViewport`.
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
public/app.js      the whole frontend: Tile class, layouts, touch key bar, viewport, ws client
public/style.css   dark theme; desktop/touch/phone breakpoints
scripts/smoke-test.mjs   headless end-to-end pipe test
deploy/tmux-ronin.service systemd --user unit
.env.example       all config vars with docs
```
