#!/usr/bin/env node
/**
 * Headless end-to-end test of the tmux-ronin pipe — no browser needed.
 *
 *   1. POST /api/sessions to create a throwaway session
 *   2. GET  /api/sessions and assert it shows up
 *   3. Open the /pty websocket, type a marker command, assert it echoes back
 *   4. DELETE the throwaway session
 *
 * Usage: HOST=127.0.0.1 PORT=3006 node scripts/smoke-test.mjs
 */
import WebSocket from 'ws';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || '3006';
const BASE = `http://${HOST}:${PORT}`;
const NAME = `grtest_${Math.floor(Math.random() * 1e6)}`;
const MARKER = `GRID_OK_${Math.floor(Math.random() * 1e9)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function ok(label) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}
function bad(label, detail) {
  failed = true;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log(`\nsmoke test against ${BASE} (session ${NAME})\n`);

  // 1. health
  try {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    h.ok ? ok('health endpoint') : bad('health endpoint', JSON.stringify(h));
  } catch (e) {
    bad('health endpoint (is the server up?)', e.message);
    return finish();
  }

  // 2. create
  const c = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: NAME }),
  });
  c.ok ? ok('create session') : bad('create session', `HTTP ${c.status}`);

  // 3. list
  const list = await (await fetch(`${BASE}/api/sessions`)).json();
  Array.isArray(list) && list.some((s) => s.name === NAME)
    ? ok('session appears in list')
    : bad('session appears in list', JSON.stringify(list));

  // 4. websocket pipe
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/pty?session=${NAME}&cols=80&rows=24`);
    ws.binaryType = 'arraybuffer';
    let buf = '';
    let sawReady = false;
    let finished = false;
    const done = (good, detail) => {
      if (finished) return;
      finished = true;
      good ? ok('websocket pipe echoes typed command') : bad('websocket pipe', detail);
      try {
        ws.close();
      } catch (_) {}
      resolve();
    };
    const timer = setTimeout(() => done(false, `marker not seen in 6s; got ${buf.length}b`), 6000);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.t === 'ready') {
            sawReady = true;
            // type a command that prints the marker
            setTimeout(() => ws.send(JSON.stringify({ t: 'i', d: `echo ${MARKER}\r` })), 300);
          }
        } catch (_) {}
        return;
      }
      buf += Buffer.from(data).toString('utf8');
      // marker appears twice (the echoed keystrokes + command output); the output
      // line is what proves the shell actually ran it. Look for two occurrences.
      const count = buf.split(MARKER).length - 1;
      if (count >= 2) {
        clearTimeout(timer);
        done(true);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      done(false, e.message);
    });
    ws.on('close', () => {
      if (!sawReady) {
        clearTimeout(timer);
        done(false, 'closed before ready');
      }
    });
  });

  // 5. cleanup
  const d = await fetch(`${BASE}/api/sessions/${NAME}`, { method: 'DELETE' });
  d.ok ? ok('delete session') : bad('delete session', `HTTP ${d.status}`);

  await sleep(200);
  finish();
}

function finish() {
  console.log('');
  if (failed) {
    console.log('\x1b[31mSMOKE TEST FAILED\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[32mSMOKE TEST PASSED\x1b[0m\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
