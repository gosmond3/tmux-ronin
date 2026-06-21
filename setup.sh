#!/usr/bin/env bash
#
# tmux-ronin setup — installs dependencies and an always-on autostart service.
# Run from the repo root:   ./setup.sh
#
# Works on Linux (systemd --user) and macOS (prints launchd steps). No root needed
# for the app itself; only the optional `tailscale serve` and `enable-linger` steps
# below use sudo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"
echo "==> tmux-ronin setup in $REPO_DIR"

# --- prerequisites ---
command -v tmux >/dev/null || { echo "ERROR: tmux not found — install tmux first."; exit 1; }
command -v node >/dev/null || { echo "ERROR: node not found — install Node.js 18+."; exit 1; }

# Resolve a STABLE node path (e.g. fnm/nvm put an ephemeral shim on PATH).
NODE_BIN="$(readlink -f "$(command -v node)" 2>/dev/null || command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
echo "    tmux : $(command -v tmux)"
echo "    node : $NODE_BIN ($(node -v))"
if command -v tailscale >/dev/null; then
  echo "    tailscale: $(command -v tailscale)"
else
  echo "    tailscale: not found (optional — needed for tailnet HTTPS + clipboard)"
fi

# --- install deps ---
echo "==> npm install"
"$NODE_DIR/npm" install

# --- .env ---
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> created .env from .env.example (edit if you want auth / a different port)"
fi

# --- autostart ---
OS="$(uname -s)"
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/tmux-ronin.service" <<UNIT
[Unit]
Description=tmux-ronin — browser grid of tmux sessions
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=$NODE_DIR/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now tmux-ronin
  echo "==> systemd --user service 'tmux-ronin' installed and started"
  echo "    logs:   journalctl --user -u tmux-ronin -f"
  echo "    status: systemctl --user status tmux-ronin"
elif [ "$OS" = "Darwin" ]; then
  echo "==> macOS: install the launchd agent from deploy/com.tmux-ronin.plist"
  echo "    sed -e 's#__REPO_DIR__#$REPO_DIR#' -e 's#__NODE_DIR__#$NODE_DIR#' \\"
  echo "        deploy/com.tmux-ronin.plist > ~/Library/LaunchAgents/com.tmux-ronin.plist"
  echo "    launchctl load -w ~/Library/LaunchAgents/com.tmux-ronin.plist"
else
  echo "==> No systemd/launchd detected. Start manually with: npm start"
fi

echo
echo "Next steps:"
echo "  1) Keep it running without an active login (Linux):"
echo "       sudo loginctl enable-linger $USER"
echo "  2) (Recommended) tailnet HTTPS for remote access + clipboard:"
if command -v tailscale >/dev/null; then
  IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  echo "       sudo tailscale serve --bg --https=8443 http://${IP:-<tailnet-ip>}:3006"
  echo "       -> open https://<your-host>.ts.net:8443 on your phone/laptop"
else
  echo "       install Tailscale, then:"
  echo "       sudo tailscale serve --bg --https=8443 http://<tailnet-ip>:3006"
fi
echo
echo "==> done. Local URL: http://<tailnet-ip-or-localhost>:3006"
