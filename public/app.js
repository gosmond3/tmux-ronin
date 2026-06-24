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
let copySheet = null; // the copy panel { sheet, ta, open, close }

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
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.body);
    this.term.onData((d) => this.send({ t: 'i', d }));
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', c: cols, r: rows }));

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
    if (active) for (let i = 0; i < 40; i++) active.sendRaw(WHEEL_DOWN);
  });

  // Copy: pop the active tile's visible text into a real selectable text panel —
  // select what you want and ⌘C (desktop) / long-press→Copy (iOS) into the device
  // clipboard. Reliable on a live TUI, where xterm's canvas selection fights the
  // constant redraw. Same panel on both surfaces; the button differs per device.
  buildCopySheet();
  key(IS_TOUCH ? 'copybtn' : 'selmode', () => copySheet && copySheet.open());
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
