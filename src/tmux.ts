import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const pexec = promisify(execFile);

export interface SessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
}

/** tmux session names can't contain '.' or ':' and we keep them shell-safe. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && NAME_RE.test(name);
}

function noServer(err: unknown): boolean {
  const s = String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? '');
  return s.includes('no server running') || s.includes('error connecting');
}

/** Real, user-facing sessions (viewer sessions are filtered out). */
export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const { stdout } = await pexec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_windows}\t#{?session_attached,1,0}\t#{session_created}',
    ]);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, windows, attached, created] = line.split('\t');
        return {
          name,
          windows: Number(windows) || 0,
          attached: attached === '1',
          created: Number(created) || 0,
        };
      })
      .filter((s) => !s.name.startsWith(config.viewerPrefix))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (noServer(err)) return [];
    throw err;
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  try {
    await pexec('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(name: string): Promise<void> {
  await pexec('tmux', ['new-session', '-d', '-s', name]);
}

export async function killSession(name: string): Promise<void> {
  try {
    await pexec('tmux', ['kill-session', '-t', name]);
  } catch {
    // already gone — fine
  }
}

/** Toggle the `mouse` option on a viewer (off => browser does native text selection). */
export async function setMouse(name: string, on: boolean): Promise<void> {
  await pexec('tmux', ['set-option', '-t', name, 'mouse', on ? 'on' : 'off']).catch(() => {});
}

let viewerCounter = 0;

/**
 * Create a grouped "viewer" session that shares the target's windows but has its
 * own current-window pointer and size policy. This is what a browser tile attaches
 * to, so the tile doesn't hijack the window selection of another client viewing
 * the same session. Returns the viewer session name.
 */
export async function createViewer(target: string, tag: string): Promise<string> {
  const safe = target.replace(/[^A-Za-z0-9_-]/g, '');
  const viewer = `${config.viewerPrefix}${safe}_${tag}_${++viewerCounter}`;
  // Grouped (-t target), detached (-d): shares windows with target.
  await pexec('tmux', ['new-session', '-d', '-s', viewer, '-t', target]);
  // Size policy + don't let tmux auto-destroy it in the brief detached window.
  await pexec('tmux', ['set-option', '-t', viewer, 'window-size', config.windowSize]).catch(() => {});
  await pexec('tmux', ['set-option', '-t', viewer, 'destroy-unattached', 'off']).catch(() => {});
  // Mouse on => the browser's trackpad/wheel scrolls tmux scrollback instead of
  // being translated into Up/Down arrows (history recall). Scoped to this viewer.
  await pexec('tmux', ['set-option', '-t', viewer, 'mouse', config.mouse]).catch(() => {});
  return viewer;
}

/** Kill any leftover viewer sessions (e.g. from a previous crash). */
export async function cleanupViewers(): Promise<number> {
  let stdout = '';
  try {
    ({ stdout } = await pexec('tmux', ['list-sessions', '-F', '#{session_name}']));
  } catch {
    return 0;
  }
  const stale = stdout.split('\n').filter((n) => n.startsWith(config.viewerPrefix));
  for (const n of stale) await killSession(n);
  return stale.length;
}
