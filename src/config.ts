import { execFileSync } from 'node:child_process';

/** First IPv4 address Tailscale reports for this node, or 127.0.0.1 as a fallback. */
function tailnetIp(): string {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim();
    const ip = out.split('\n')[0]?.trim();
    if (ip) return ip;
  } catch {
    // tailscale not installed / not up — fall through
  }
  return '127.0.0.1';
}

export const config = {
  port: Number(process.env.PORT ?? 3006),
  /** If BIND is unset we lock to the tailnet IP so the server is not publicly reachable. */
  bind: process.env.BIND?.trim() || tailnetIp(),
  user: process.env.GRID_USER ?? '',
  pass: process.env.GRID_PASS ?? '',
  /** latest | largest | smallest | manual */
  windowSize: process.env.TMUX_WINDOW_SIZE?.trim() || 'latest',
  /**
   * Mouse mode on browser viewer sessions. 'on' (default) makes trackpad/wheel
   * scroll the tmux scrollback (the conversation) instead of xterm.js translating
   * the wheel into Up/Down arrow keys (which recalls prior prompt entries). Keyboard
   * arrows still do history. Set TMUX_MOUSE=off to revert to arrow-key scrolling.
   */
  mouse: process.env.TMUX_MOUSE?.trim() || 'on',
  /** Internal grouped "viewer" sessions get this prefix; hidden from the picker. */
  viewerPrefix: 'grid_',
} as const;

export const authEnabled = Boolean(config.user && config.pass);
