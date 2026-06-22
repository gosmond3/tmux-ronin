# CLAUDE.md — tmux-ronin

Browser grid of live tmux sessions. xterm.js (browser) ⟷ websocket ⟷ node-pty running
`tmux attach` on the host. Lets you view/operate several tmux sessions from one browser
tab — desktop or phone — instead of SSHing and `tmux attach`-ing each one by hand.

## Run

```bash
npm install
npm start          # tsx src/index.ts — http://<bind-addr>:3006
npm run smoke      # headless end-to-end pipe test (server must be running)
npm run build      # tsc -> dist/ (optional; start uses tsx directly)
./setup.sh         # install deps + autostart service (Linux systemd / macOS launchd)
```

Service (Linux): `systemctl --user {status,restart} tmux-ronin` · logs: `journalctl --user -u tmux-ronin -f`.

## Key constraints (why it's built this way)

- **No compiler needed** → uses `@lydell/node-pty` (prebuilt binaries, incl. arm64), not
  `node-pty` (which compiles). Runs as a user service (systemd `--user` / launchd), no root.
- **Must run on the HOST**, not in Docker — it needs the user's tmux socket
  (`/tmp/tmux-<uid>/default`). Don't containerize it.
- **Unix-like server**: Linux, macOS, or WSL (tmux + PTYs). The browser client is any OS.
- **Bind**: defaults to the tailnet IP (`tailscale ip -4`) if Tailscale is present, else
  `127.0.0.1`; `BIND` overrides. Tailscale is recommended (secure remote + free HTTPS) but
  swappable for any VPN/reverse-proxy.

## Architecture notes

- Each browser tile attaches to a **grouped viewer session** (`grid_<name>_…`) so it
  doesn't hijack another client's current-window selection. Viewers are hidden from the
  picker and killed on disconnect / startup cleanup. Each viewer gets `mouse on`.
- tmux can't render one window at two sizes; `TMUX_WINDOW_SIZE` (default `latest`) controls
  the trade-off. See README.
- WS protocol: client→server JSON `{t:'i',d}` (input) / `{t:'r',c,r}` (resize) /
  `{t:'mouse',on}` (toggle viewer mouse); server→client raw binary = pty output, JSON
  `{t:'ready'|'exit'|'error'}` = control.
- Copy (desktop): the `⎘ Select` toggle sets the viewer's tmux `mouse off` so the browser
  does native text selection, copied on ⌘C via a document `copy` handler. Works on http/https.

## Frontend / mobile (where tuning happens)

`public/app.js` is the whole UI (plain JS + xterm.js). Touch (iPhone/iPad) is a first-class
surface. **Cardinal rule: never change desktop behavior** — gate every touch/mobile change
behind `IS_TOUCH` (JS) or `@media (pointer:coarse)` / `@media (max-width:680px)` (CSS).

You usually **can't device-test a phone from a dev box** — reason carefully, keep changes
isolated, and reload the browser (it caches `app.js`). The README's **"For future agents —
tuning guide"** lists the knobs and the headless checks. Read it before touching the frontend.

## Conventions

TypeScript strict, ESM (`"type":"module"`, NodeNext → relative imports use `.js`), run via
tsx. Default port 3006.
