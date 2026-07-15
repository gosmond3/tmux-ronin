import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const pexec = promisify(execFile);

export interface SessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
  /** Whether this session has a post-it note attached (stored as a tmux user option). */
  hasNote: boolean;
}

/** tmux user option holding a session's post-it note. Lives and dies with the session. */
const NOTE_OPT = '@ronin_note';

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
      `#{session_name}\t#{session_windows}\t#{?session_attached,1,0}\t#{session_created}\t#{?${NOTE_OPT},1,0}`,
    ]);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, windows, attached, created, hasNote] = line.split('\t');
        return {
          name,
          windows: Number(windows) || 0,
          attached: attached === '1',
          created: Number(created) || 0,
          hasNote: hasNote === '1',
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
    // `=` forces an exact match — without it, `has-session -t kojin` would
    // prefix-match an existing `kojinsa` and wrongly report the name as taken.
    await pexec('tmux', ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(name: string): Promise<void> {
  const args = ['new-session', '-d', '-s', name];
  if (config.newSessionDir) args.push('-c', config.newSessionDir);
  try {
    await pexec('tmux', args);
  } catch (err) {
    // A missing/inaccessible start-directory makes new-session fail; retry
    // without -c so session creation still works (falls back to ronin's cwd).
    if (config.newSessionDir) {
      await pexec('tmux', ['new-session', '-d', '-s', name]);
    } else {
      throw err;
    }
  }
}

export async function killSession(name: string): Promise<void> {
  try {
    await pexec('tmux', ['kill-session', '-t', name]);
  } catch {
    // already gone — fine
  }
}

/**
 * Kill a real session AND every viewer grouped with it. Browser viewers are grouped
 * sessions (created with `new-session -t name`), so they share tmux's session_group;
 * we match on that to find them exactly (no fragile name-prefix guessing). Without
 * this, killing a session leaves its `grid_*` viewers behind.
 */
export async function killSessionTree(name: string): Promise<void> {
  const targets = new Set<string>([name]);
  try {
    const { stdout } = await pexec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_group}',
    ]);
    const rows = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sname, group] = line.split('\t');
        return { sname, group: group || '' };
      });
    const self = rows.find((r) => r.sname === name);
    if (self?.group) {
      for (const r of rows) if (r.group === self.group) targets.add(r.sname);
    }
  } catch {
    // no server / older tmux without session_group — fall back to killing just `name`
  }
  for (const s of targets) await killSession(s);
}

/**
 * Read a session's post-it note (empty string if none). Stored as a tmux user option
 * on the session itself, so it needs no separate storage and vanishes with the session.
 * Plain `-t name` is safe: tmux prefers an exact name match over a prefix, so `kojin`
 * and `kojinsa` keep distinct notes (callers validate the session exists first).
 */
export async function getNote(name: string): Promise<string> {
  try {
    const { stdout } = await pexec('tmux', ['show-options', '-t', name, '-qv', NOTE_OPT]);
    return stdout.replace(/\n$/, ''); // show-options appends one trailing newline
  } catch {
    return '';
  }
}

/** Set (or, when blank, clear) a session's post-it note. */
export async function setNote(name: string, text: string): Promise<void> {
  if (text.trim()) {
    await pexec('tmux', ['set-option', '-t', name, NOTE_OPT, text]);
  } else {
    await pexec('tmux', ['set-option', '-t', name, '-u', NOTE_OPT]).catch(() => {});
  }
}

/** Toggle the `mouse` option on a viewer (off => browser does native text selection). */
export async function setMouse(name: string, on: boolean): Promise<void> {
  await pexec('tmux', ['set-option', '-t', name, 'mouse', on ? 'on' : 'off']).catch(() => {});
}

/**
 * Snap a viewer's pane to the live bottom. Wheel-scroll bursts only page partway when
 * scrollback is deep; exiting copy mode always returns the pane to the live output.
 * Harmless no-op (errors swallowed) if the pane isn't in copy mode.
 */
export async function jumpToBottom(name: string): Promise<void> {
  await pexec('tmux', ['send-keys', '-t', name, '-X', 'cancel']).catch(() => {});
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
