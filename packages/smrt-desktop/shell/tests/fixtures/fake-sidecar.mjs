// Fake Node sidecar for the supervisor integration tests.
//
// Behaviour is selected with FAKE_MODE (supplied through the manifest `env`).
// FAKE_STATE_DIR is a scratch directory the test owns; it holds a run counter,
// the pid file, markers, and the single-live-process guard.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const mode = process.env.FAKE_MODE ?? 'ok';
const stateDir = process.env.FAKE_STATE_DIR;
const failRuns = Number(process.env.FAKE_FAIL_RUNS ?? '0');
const healthRoute = process.env.FAKE_HEALTH_ROUTE ?? '/health';

// Atomic: a reader polling the state directory never sees a truncated file.
function writeState(name, body) {
  const target = path.join(stateDir, name);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, target);
}

function mark(name, body = '') {
  if (stateDir) writeState(name, body);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

let run = 0;
if (stateDir) {
  const counter = path.join(stateDir, 'runs');
  run = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : '0') + 1;
  writeState('runs', String(run));
  writeState('pid', String(process.pid));
  // At most one live sidecar per state directory (smrt#3379 guard).
  for (const entry of fs.readdirSync(stateDir)) {
    const match = /^live-(\d+)$/.exec(entry);
    if (match && Number(match[1]) !== process.pid && alive(Number(match[1]))) {
      mark('VIOLATION', entry);
    }
  }
  mark(`live-${process.pid}`);
}

function leave(code) {
  if (stateDir) fs.rmSync(path.join(stateDir, `live-${process.pid}`), { force: true });
  process.exit(code);
}

if (mode === 'addr-in-use' && run <= failRuns) {
  console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:1');
  leave(1);
}
if (mode === 'lease-held' && !fs.existsSync(path.join(stateDir, 'release')) && run <= failRuns) {
  console.error('Error: Another application writer is active (process 99999).');
  leave(1);
}
if (mode === 'always-exit') {
  console.error('fatal: configured to fail');
  leave(2);
}

process.on('SIGTERM', () => {
  mark('sigterm');
  if (mode !== 'ignore-sigterm') leave(0);
});

const server = http.createServer((req, res) => {
  if (req.url === healthRoute) {
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    } else if (mode === 'never-healthy') {
      res.writeHead(503);
      res.end('starting');
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }
  } else if (req.url === '/env') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        HOST: process.env.HOST,
        PORT: process.env.PORT,
        ORIGIN: process.env.ORIGIN,
        SMRT_DATA_DIR: process.env.SMRT_DATA_DIR,
        CUSTOM: process.env.CUSTOM,
        INHERITED_MARKER: process.env.INHERITED_MARKER,
        lowerHost: process.env.host,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
      }),
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

function listen() {
  server.listen(Number(process.env.PORT), process.env.HOST, () => {
    if (mode === 'crash-after-ready' && run <= failRuns) {
      setTimeout(() => leave(1), 400);
    }
  });
}

if (mode === 'squatted' && run <= failRuns) {
  // Report the chosen port, then wait until the test has put a squatter on it
  // and let it answer a probe, so the real listen() below fails with a genuine
  // EADDRINUSE while this process is still alive.
  mark(`port-${run}`, String(process.env.PORT));
  const gate = path.join(stateDir, `squatter-ready-${run}`);
  const timer = setInterval(() => {
    if (fs.existsSync(gate)) {
      clearInterval(timer);
      listen();
    }
  }, 10);
} else {
  listen();
}
