/* tmux-ronin — browser grid of live tmux sessions. No framework, just xterm.js. */
'use strict';

const grid = document.getElementById('grid');
const NEW = '__new__';
const TILE_COUNT = 4;
const LS_SESSIONS = 'tmuxgrid.sessions';
const LS_LAYOUT = 'tmuxgrid.layout';

// Touch device (iPhone/iPad): a tap must NOT auto-focus the terminal (which pops
// the keyboard); scrolling is driven by drag + buttons that inject wheel events.
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
// SGR mouse-wheel sequences. With tmux `mouse on`, injecting these scrolls the
// scrollback (verified: enters copy-mode, scroll_position advances).
const WHEEL_UP = '\x1b[<64;1;1M';
const WHEEL_DOWN = '\x1b[<65;1;1M';

let sessions = []; // [{name, windows, attached, created}]
let active = null;
const tiles = [];
let compose = null; // the touch compose bar { bar, ta }
let copySheet = null; // the copy panel { sheet, ta, open, close } — touch only
let notePanel = null; // shared per-session note editor { open(session), close } — all devices
let selectMode = false; // desktop Copy Mode: tmux mouse off so the browser selects natively
let lastSelection = ''; // last non-empty terminal selection, kept so a live-TUI redraw
// that clears the on-screen highlight can't lose the text before ⌘C reads it

const THEME = {
  background: '#0b0e14',
  foreground: '#c5c8c6',
  cursor: '#e0af68',
  cursorAccent: '#0b0e14',
  selectionBackground: '#2a3145',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#6b7488',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};

/* ---------- persistence ---------- */
function saveState() {
  localStorage.setItem(LS_SESSIONS, JSON.stringify(tiles.map((t) => t.session || '')));
  localStorage.setItem(LS_LAYOUT, String(grid.dataset.layout || TILE_COUNT));
}
function loadState() {
  let map = [];
  try {
    map = JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]');
  } catch (_) {
    map = [];
  }
  const layout = Number(localStorage.getItem(LS_LAYOUT)) || TILE_COUNT;
  return { map, layout };
}

/* ---------- server calls ---------- */
async function fetchSessions() {
  try {
    const r = await fetch('/api/sessions');
    sessions = await r.json();
    if (!Array.isArray(sessions)) sessions = [];
  } catch (_) {
    sessions = [];
  }
  tiles.forEach((t) => t.refreshOptions());
  return sessions;
}

async function createSession(name) {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data.name;
}

/** Kill a tmux session on the host (and its grid_* viewers). */
async function deleteSession(name) {
  const r = await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
}

/* ---------- tile ---------- */
class Tile {
  constructor(index) {
    this.index = index;
    this.session = null;
    this.ws = null;
    this.wantOpen = false;
    this.retry = null;

    this.el = document.createElement('section');
    this.el.className = 'tile';
    this.el.innerHTML = `
      <div class="tile-head">
        <span class="dot off" title="disconnected"></span>
        <select class="sess" title="Pick / switch session"></select>
        <span class="grow"></span>
        <button class="note" title="Session note (post-it)">📝</button>
        <button class="rc" title="Reconnect">⟳</button>
        <button class="dc" title="Detach (stop viewing)">✕</button>
        <button class="kill" title="Kill session (ends it + its viewers)">🗑</button>
      </div>
      <div class="tile-body"></div>`;
    this.select = this.el.querySelector('.sess');
    this.body = this.el.querySelector('.tile-body');
    this.dot = this.el.querySelector('.dot');

    this.term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, "DejaVu Sans Mono", Consolas, monospace',
      theme: THEME,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // Option+drag forces a native selection even when the running app (e.g. Claude
      // Code) holds mouse-reporting on and would otherwise eat the drag. Lets you copy
      // in-place out of a live TUI without a panel.
      macOptionClickForcesSelection: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.body);
    this.term.onData((d) => this.send({ t: 'i', d }));
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', c: cols, r: rows }));
    // Stash the selection as soon as it's made; a streaming TUI repaint can clear the
    // visible highlight before ⌘C fires, so we copy this captured text, not a stale read.
    this.term.onSelectionChange(() => {
      const s = this.term.getSelection ? this.term.getSelection() : '';
      if (s) lastSelection = s;
    });

    if (IS_TOUCH) {
      // Touch (iPhone/iPad): tap only activates the tile. Typing is via the compose
      // bar at the bottom; drag the terminal to scroll.
      this.body.addEventListener('pointerdown', () => this.activate());
      this.setupDragScroll();
    } else {
      // Desktop: click focuses the terminal. Works great — left untouched.
      this.body.addEventListener('pointerdown', () => this.focusTerminal());
    }
    // Marking a tile active on header focus, without stealing keyboard focus —
    // otherwise iOS closes the <select> picker the instant it opens.
    this.el.addEventListener('focusin', (e) => {
      this.activate();
      if (!IS_TOUCH && this.body.contains(e.target)) this.term.focus();
    });
    this.select.addEventListener('pointerdown', () => this.activate());
    this.select.addEventListener('change', () => this.onSelect());
    this.el.querySelector('.rc').addEventListener('click', () => {
      if (this.session) this.connect(this.session);
    });
    this.el.querySelector('.note').addEventListener('click', () => {
      if (this.session && notePanel) notePanel.open(this.session);
    });
    this.el.querySelector('.dc').addEventListener('click', () => this.detach());
    this.el.querySelector('.kill').addEventListener('click', () => this.kill());

    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(this.body);

    this.refreshOptions();
    this.writeBanner();
  }

  writeBanner() {
    this.term.writeln('\x1b[2m  tile ' + (this.index + 1) + ' — pick a session above ↑\x1b[0m');
  }

  refreshOptions() {
    const cur = this.session;
    this.select.innerHTML = '';
    this.select.add(new Option('— pick session —', ''));
    for (const s of sessions) {
      const label = `${s.name}${s.attached ? ' •' : ''}  (${s.windows}w)`;
      this.select.add(new Option(label, s.name));
    }
    // keep a stale-but-connected session visible even if it left the list
    if (cur && !sessions.some((s) => s.name === cur)) {
      this.select.add(new Option(`${cur}  (gone?)`, cur));
    }
    this.select.add(new Option('➕ new session…', NEW));
    this.select.value = cur || '';
    this.updateNoteBtn();
  }

  /** Reflect on the 📝 button whether this tile's session has a note (and disable when none). */
  updateNoteBtn() {
    const btn = this.el.querySelector('.note');
    if (!btn) return;
    const s = sessions.find((x) => x.name === this.session);
    const has = !!(s && s.hasNote);
    btn.classList.toggle('has-note', has);
    btn.disabled = !this.session;
    btn.title = !this.session ? 'Session note' : has ? 'Session note (has notes)' : 'Session note (empty)';
  }

  async onSelect() {
    const v = this.select.value;
    if (v === NEW) {
      const name = (prompt('New tmux session name (letters, digits, _ or -):') || '').trim();
      this.select.value = this.session || '';
      if (!name) return;
      try {
        await createSession(name);
        await fetchSessions();
        this.connect(name);
      } catch (e) {
        alert('Could not create session:\n' + e.message);
      }
      return;
    }
    if (!v) {
      this.detach();
      return;
    }
    this.connect(v);
  }

  /** Mark this tile active (visual highlight + keystroke target) without grabbing keyboard focus. */
  activate() {
    if (active === this) return;
    active = this;
    tiles.forEach((t) => t.el.classList.toggle('active', t === this));
  }

  /** Activate and pull keyboard focus into the terminal. */
  focusTerminal() {
    this.activate();
    this.term.focus();
  }

  /** Write a raw string to the pty (used for injected wheel sequences). */
  sendRaw(d) {
    this.send({ t: 'i', d });
  }

  /** TOUCH ONLY: one-finger drag over the terminal scrolls the tmux scrollback. */
  setupDragScroll() {
    let lastY = null;
    let accum = 0;
    const STEP = 16; // px of drag per wheel step
    this.body.addEventListener(
      'touchstart',
      (e) => {
        this.activate();
        lastY = e.touches[0] ? e.touches[0].clientY : null;
        accum = 0;
        e.stopPropagation();
      },
      { passive: true, capture: true },
    );
    this.body.addEventListener(
      'touchmove',
      (e) => {
        if (lastY == null || !e.touches[0]) return;
        const y = e.touches[0].clientY;
        accum += y - lastY; // finger DOWN reveals older lines => wheel up
        lastY = y;
        while (accum >= STEP) {
          this.sendRaw(WHEEL_UP);
          accum -= STEP;
        }
        while (accum <= -STEP) {
          this.sendRaw(WHEEL_DOWN);
          accum += STEP;
        }
        e.preventDefault(); // own the gesture: no page bounce, no xterm handling
        e.stopPropagation();
      },
      { passive: false, capture: true },
    );
    this.body.addEventListener(
      'touchend',
      () => {
        lastY = null;
      },
      { passive: true, capture: true },
    );
  }

  setDot(state) {
    this.dot.className = 'dot ' + state;
    this.dot.title = state === 'on' ? 'connected' : state === 'wait' ? 'connecting…' : 'disconnected';
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  detach() {
    this.wantOpen = false;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.session = null;
    this.select.value = '';
    this.updateNoteBtn();
    this.setDot('off');
    this.term.reset();
    this.writeBanner();
    saveState();
  }

  /** Destroy the tmux session on the host (root + its grid_* viewers), then detach. */
  async kill() {
    const name = this.session;
    if (!name) return;
    if (!confirm(`Kill tmux session "${name}"? This ends the session and everything running in it.`)) return;
    try {
      await deleteSession(name);
    } catch (e) {
      alert('Could not kill session:\n' + e.message);
      return;
    }
    this.detach();
    fetchSessions();
  }

  connect(session) {
    this.wantOpen = true;
    this.session = session;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    // make sure the option exists & is selected
    if (![...this.select.options].some((o) => o.value === session)) {
      this.select.add(new Option(session, session), this.select.options.length - 1);
    }
    this.select.value = session;
    this.updateNoteBtn();

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.term.reset();
    this.setDot('wait');
    this.doFit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url =
      `${proto}://${location.host}/pty?session=${encodeURIComponent(session)}` +
      `&cols=${this.term.cols}&rows=${this.term.rows}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.setDot('on');
      this.doFit();
      this.send({ t: 'r', c: this.term.cols, r: this.term.rows });
      if (selectMode) this.send({ t: 'mouse', on: false }); // keep copy mode after reconnect
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (m.t === 'error') {
          this.term.writeln('\r\n\x1b[31m[grid] ' + m.m + '\x1b[0m');
          this.setDot('off');
        } else if (m.t === 'exit') {
          this.term.writeln('\r\n\x1b[33m[grid] session ended.\x1b[0m');
          this.setDot('off');
        }
        return;
      }
      this.term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setDot('off');
      if (this.wantOpen && this.session === session) {
        this.retry = setTimeout(() => {
          if (this.wantOpen && this.session === session) this.connect(session);
        }, 2000);
      }
    };
    ws.onerror = () => this.setDot('off');

    saveState();
  }

  doFit() {
    if (this.el.style.display === 'none') return;
    try {
      this.fit.fit();
    } catch (_) {}
  }
}

/**
 * TOUCH: a compose bar — a real native textarea where you type / dictate (Wispr Flow) /
 * paste, then Enter or Send writes the whole line into the active terminal and runs it.
 * Far easier than poking at xterm's hidden textarea on a phone, and paste/dictation work.
 */
function buildCompose() {
  // Floating "type" button — opens the compose overlay. Hidden while it's open.
  const fab = document.createElement('button');
  fab.id = 'fab';
  fab.textContent = '⌨';
  fab.title = 'Type';

  // Compose overlay — floats just above the keyboard, over the terminal.
  const bar = document.createElement('div');
  bar.id = 'compose';
  const ta = document.createElement('textarea');
  ta.rows = 1;
  ta.placeholder = 'Type, Enter sends';
  ta.autocapitalize = 'off';
  ta.autocomplete = 'off';
  ta.spellcheck = false;
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('inputmode', 'text');
  ta.setAttribute('enterkeyhint', 'send');
  ta.setAttribute('data-1p-ignore', ''); // suppress password-manager / autofill prompts
  ta.setAttribute('data-lpignore', 'true');
  const sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.textContent = 'Send';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.textContent = '✕';
  bar.append(ta, sendBtn, closeBtn);

  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  };
  const submit = () => {
    if (!active) return;
    if (ta.value) active.sendRaw(ta.value);
    // Send Enter as a SEPARATE, slightly-delayed keypress so TUIs (e.g. Claude Code)
    // treat it as a real submit, not a trailing newline inside pasted text.
    setTimeout(() => active && active.sendRaw('\r'), 40);
    ta.value = '';
    autosize();
  };
  const open = () => {
    bar.classList.add('open');
    fab.classList.add('hidden');
    positionCompose();
    ta.focus();
    autosize();
  };
  const hide = () => {
    bar.classList.remove('open');
    fab.classList.remove('hidden');
    ta.blur();
  };

  fab.addEventListener('click', open);
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); // Enter sends; Shift+Enter inserts a newline
      submit();
    }
  });
  sendBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep keyboard up
  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    submit();
    ta.focus();
  });
  closeBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    hide();
  });

  document.body.append(fab, bar);
  compose = { bar, ta, open, hide };
}

/** All visible terminal text (the alt-screen buffer under tmux), trailing blanks trimmed. */
function terminalText(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n').replace(/\s+$/, '');
}

/**
 * Copy panel: a real, selectable <textarea> showing the terminal's text. You select
 * what you want and copy natively (⌘C on desktop, long-press → Copy on iOS) — no
 * canvas-selection or mouse-mode tricks. "Copy all" grabs everything in one tap.
 */
function buildCopySheet() {
  const sheet = document.createElement('div');
  sheet.id = 'copysheet';
  const bar = document.createElement('div');
  bar.className = 'cs-bar';
  const hint = document.createElement('span');
  hint.className = 'cs-hint';
  hint.textContent = 'Select text → Copy (or ⌘C)';
  const copyAll = document.createElement('button');
  copyAll.textContent = 'Copy all';
  const closeB = document.createElement('button');
  closeB.textContent = 'Close';
  bar.append(hint, copyAll, closeB);
  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.spellcheck = false;
  sheet.append(bar, ta);
  document.body.appendChild(sheet);

  const open = () => {
    if (!active) return;
    ta.value = terminalText(active.term);
    sheet.classList.add('open');
  };
  const close = () => sheet.classList.remove('open');
  copyAll.addEventListener('click', async () => {
    ta.select();
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch (_) {
      try {
        document.execCommand('copy');
      } catch (_) {}
    }
    copyAll.textContent = 'Copied ✓';
    setTimeout(() => {
      copyAll.textContent = 'Copy all';
    }, 1000);
  });
  closeB.addEventListener('click', close);
  copySheet = { sheet, ta, open, close };
}

/**
 * Per-session "post-it" note editor. One shared modal (a centered card on desktop,
 * full-bleed on phones) that loads/saves the active tile's session note. The note lives
 * on the tmux session itself (a user option) — no separate storage, gone when the session
 * dies. Additive: it never touches terminal/copy behavior on any device.
 */
function buildNotePanel() {
  const sheet = document.createElement('div');
  sheet.id = 'notesheet';
  const card = document.createElement('div');
  card.className = 'ns-card';
  const bar = document.createElement('div');
  bar.className = 'ns-bar';
  const title = document.createElement('span');
  title.className = 'ns-title';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  bar.append(title, saveBtn, closeBtn);
  const ta = document.createElement('textarea');
  ta.placeholder = "What's this session working on?";
  ta.spellcheck = false;
  card.append(bar, ta);
  sheet.appendChild(card);
  document.body.appendChild(sheet);

  let current = null; // session whose note is loaded
  const close = () => {
    sheet.classList.remove('open');
    current = null;
  };
  const open = async (session) => {
    if (!session) return;
    current = session;
    title.textContent = '📝 ' + session;
    ta.value = '';
    ta.disabled = true;
    sheet.classList.add('open');
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(session) + '/note');
      const d = await r.json().catch(() => ({}));
      if (current === session) ta.value = d.note || '';
    } catch (_) {}
    ta.disabled = false;
    ta.focus();
  };
  saveBtn.addEventListener('click', async () => {
    if (!current) return;
    const session = current;
    saveBtn.textContent = 'Saving…';
    try {
      await fetch('/api/sessions/' + encodeURIComponent(session) + '/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: ta.value }),
      });
      const s = sessions.find((x) => x.name === session);
      if (s) s.hasNote = !!ta.value.trim();
      tiles.forEach((t) => t.updateNoteBtn());
    } catch (_) {}
    saveBtn.textContent = 'Save';
    close();
  });
  closeBtn.addEventListener('click', close);
  // Click the backdrop (outside the card) or press Esc to dismiss.
  sheet.addEventListener('pointerdown', (e) => {
    if (e.target === sheet) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('open')) close();
  });
  notePanel = { open, close };
}

/** Float the compose overlay just above the on-screen keyboard. */
function positionCompose() {
  if (!compose) return;
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  compose.bar.style.bottom = kb + 'px';
}

/* ---------- layout ---------- */
function setLayout(n) {
  n = [1, 2, 4].includes(n) ? n : 4;
  grid.dataset.layout = String(n);
  grid.className = 'layout-' + n;
  document.querySelectorAll('.layouts button').forEach((b) => b.classList.toggle('active', b.dataset.layout === String(n)));
  tiles.forEach((t, i) => {
    t.el.style.display = i < n ? '' : 'none';
  });
  requestAnimationFrame(() => tiles.forEach((t, i) => i < n && t.doFit()));
  saveState();
}

/* ---------- boot ---------- */
function build() {
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = new Tile(i);
    tiles.push(t);
    grid.appendChild(t.el);
  }
  document.querySelectorAll('.layouts button').forEach((b) => {
    b.addEventListener('click', () => setLayout(Number(b.dataset.layout)));
  });
  document.getElementById('refresh').addEventListener('click', fetchSessions);
  window.addEventListener('resize', () => tiles.forEach((t) => t.doFit()));
  // Top-bar control keys (sent to the active terminal).
  const key = (id, fn) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', fn);
  };
  key('k-esc', () => active && active.sendRaw('\x1b'));
  key('k-int', () => active && active.sendRaw('\x03'));
  key('k-bottom', () => {
    // Exit copy mode server-side => pane snaps to the live bottom. Wheel bursts only
    // page partway through deep scrollback. Fall back to wheel if the ws is gone.
    if (!active) return;
    if (active.ws && active.ws.readyState === 1) active.send({ t: 'bottom' });
    else for (let i = 0; i < 40; i++) active.sendRaw(WHEEL_DOWN);
  });

  // Per-session note editor (📝 on each tile head) — works the same on desktop and touch.
  buildNotePanel();

  if (IS_TOUCH) {
    // Touch (iPhone/iPad): no precise pointer and the canvas can't be touch-selected,
    // so Copy pops the visible text into a real <textarea> panel to select & copy.
    buildCopySheet();
    key('copybtn', () => copySheet && copySheet.open());

    // Touch-only keypad: ⋯ toggles a drop panel of keys the iOS keyboard can't send
    // (Tab/⇧Tab + arrows) so you can drive TUIs like Claude Code. Stays open so you
    // can fire several (e.g. arrow-navigate a menu); doesn't steal terminal focus.
    const KEYPAD = { tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
    const more = document.getElementById('k-more');
    const pad = document.getElementById('keypad');
    if (more && pad) {
      more.addEventListener('click', () => {
        const open = pad.classList.toggle('open');
        more.classList.toggle('armed', open);
        more.setAttribute('aria-expanded', String(open));
      });
      pad.querySelectorAll('button[data-key]').forEach((b) => {
        b.addEventListener('click', () => active && active.sendRaw(KEYPAD[b.dataset.key]));
      });
    }
  } else {
    // Desktop (Mac): Copy Mode is a real toggle. ON => tmux mouse OFF so a drag is a
    // native browser selection on the canvas (and the button lights up); OFF => mouse
    // back ON for normal terminal use (wheel scroll). The screen is never covered.
    const selBtn = document.getElementById('selmode');
    if (selBtn) {
      selBtn.addEventListener('click', () => {
        selectMode = !selectMode;
        selBtn.classList.toggle('armed', selectMode);
        selBtn.textContent = selectMode ? 'Copy Mode ●' : 'Copy Mode';
        tiles.forEach((t) => t.send({ t: 'mouse', on: !selectMode }));
      });
    }
    // "?" popover explaining how to copy (esp. Option+drag in Claude panes).
    const help = document.getElementById('copyhelp');
    const pop = document.getElementById('copyhelp-pop');
    if (help && pop) {
      help.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (e.target !== help && !pop.contains(e.target)) pop.classList.remove('open');
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') pop.classList.remove('open');
      });
    }
    // xterm draws to a canvas, so the browser's native copy can't see the selection —
    // feed it the captured terminal selection on ⌘C/Ctrl-C. Works on http and https.
    document.addEventListener('copy', (e) => {
      const live = active && active.term.getSelection ? active.term.getSelection() : '';
      const sel = live || lastSelection;
      // Only hijack ⌘C when the terminal actually has a selection; otherwise let the
      // browser copy normally. Works whether the selection came from Copy Mode (mouse
      // off) or an Option+drag over a mouse-grabbing app.
      if (sel && e.clipboardData) {
        e.clipboardData.setData('text/plain', sel);
        e.preventDefault();
      }
    });
  }
}

async function init() {
  build();
  if (IS_TOUCH) {
    buildCompose();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', positionCompose);
      window.visualViewport.addEventListener('scroll', positionCompose);
    }
  }
  const saved = loadState();
  // First run on a phone: default to a single full-screen terminal (a 2x2 grid of
  // tiny terminals is unusable on a phone). iPad/desktop keep the saved/4 default.
  const phone = window.matchMedia('(max-width: 680px)').matches;
  const firstRun = localStorage.getItem(LS_LAYOUT) === null;
  setLayout(firstRun && phone ? 1 : saved.layout);
  await fetchSessions();
  saved.map.forEach((s, i) => {
    if (s && tiles[i]) tiles[i].connect(s);
  });
  // Mark the first tile active but don't grab the keyboard on load (avoids the
  // iOS on-screen keyboard popping up before you've picked a session).
  if (tiles[0]) tiles[0].activate();
}

init();
