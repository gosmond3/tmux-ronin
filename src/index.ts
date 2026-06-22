import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import pty from '@lydell/node-pty';
import { config, authEnabled } from './config.js';
import {
  listSessions,
  sessionExists,
  createSession,
  killSession,
  killSessionTree,
  createViewer,
  cleanupViewers,
  isValidName,
  setMouse,
} from './tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const NM = path.join(ROOT, 'node_modules');

const app = express();
app.use(express.json());

// --- optional HTTP Basic auth (gates everything, including the websocket) ---
function checkAuth(header?: string): boolean {
  if (!authEnabled) return true;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  return u === config.user && p === config.pass;
}

app.use((req, res, next) => {
  if (checkAuth(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="tmux-ronin"').status(401).send('Authentication required.');
});

// --- vendored browser assets (served straight from node_modules, no build step) ---
app.get('/vendor/xterm.css', (_req, res) => res.sendFile(path.join(NM, '@xterm/xterm/css/xterm.css')));
app.get('/vendor/xterm.js', (_req, res) => res.sendFile(path.join(NM, '@xterm/xterm/lib/xterm.js')));
app.get('/vendor/addon-fit.js', (_req, res) => res.sendFile(path.join(NM, '@xterm/addon-fit/lib/addon-fit.js')));

app.use(express.static(PUBLIC));

// --- REST API ---
app.get('/api/health', (_req, res) => res.json({ ok: true, auth: authEnabled }));

app.get('/api/sessions', async (_req, res) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    res.status(500).json({ error: String((e as Error)?.message ?? e) });
  }
});

app.post('/api/sessions', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!isValidName(name)) {
    return res.status(400).json({ error: 'Invalid name. Use letters, digits, _ or - (no spaces, . or :).' });
  }
  if (await sessionExists(name)) {
    return res.status(409).json({ error: `Session "${name}" already exists.` });
  }
  try {
    await createSession(name);
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: String((e as Error)?.message ?? e) });
  }
});

app.delete('/api/sessions/:name', async (req, res) => {
  const { name } = req.params;
  if (!isValidName(name)) return res.status(400).json({ error: 'Invalid name.' });
  await killSessionTree(name);
  res.json({ ok: true });
});

// --- HTTP + WebSocket server ---
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req.headers.authorization)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="tmux-ronin"\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/pty') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handlePty(ws, url).catch((e) => {
      try {
        ws.send(JSON.stringify({ t: 'error', m: String((e as Error)?.message ?? e) }));
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });
});

/** Bridge one browser tile <-> a grouped tmux viewer session over a websocket. */
async function handlePty(ws: WebSocket, url: URL): Promise<void> {
  const session = url.searchParams.get('session') ?? '';
  let cols = clampDim(url.searchParams.get('cols'), 80);
  let rows = clampDim(url.searchParams.get('rows'), 24);

  if (!isValidName(session) || !(await sessionExists(session))) {
    ws.send(JSON.stringify({ t: 'error', m: `No such session: ${session}` }));
    ws.close();
    return;
  }

  const viewer = await createViewer(session, randomBytes(3).toString('hex'));

  // Don't leak the host tmux context into the child, or `tmux attach` complains
  // about nesting and may misbehave.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const term = pty.spawn('tmux', ['attach', '-t', viewer], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME,
    env,
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      term.kill();
    } catch {
      /* already dead */
    }
    void killSession(viewer);
  };

  term.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, 'utf8'));
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'exit' }));
      ws.close();
    }
    cleanup();
  });

  ws.send(JSON.stringify({ t: 'ready', session, viewer }));

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      term.write(raw.toString('utf8'));
      return;
    }
    let msg: { t?: string; d?: string; c?: number; r?: number; on?: boolean };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      term.write(msg.d);
    } else if (msg.t === 'r') {
      cols = clampDim(msg.c, cols);
      rows = clampDim(msg.r, rows);
      try {
        term.resize(cols, rows);
      } catch {
        /* race on close */
      }
    } else if (msg.t === 'mouse') {
      // Toggle tmux mouse on this viewer: off => browser does native text selection
      // (desktop Select mode for copy); on => tmux owns the mouse (wheel scroll).
      void setMouse(viewer, !!msg.on);
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function clampDim(v: string | number | null | undefined, fallback: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(2, n));
}

const removed = await cleanupViewers();
if (removed) console.log(`[tmux-ronin] cleaned up ${removed} stale viewer session(s)`);

server.listen(config.port, config.bind, () => {
  console.log(
    `[tmux-ronin] listening on http://${config.bind}:${config.port}  (auth: ${authEnabled ? 'ON' : 'off'}, window-size: ${config.windowSize})`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void cleanupViewers().finally(() => process.exit(0));
  });
}
