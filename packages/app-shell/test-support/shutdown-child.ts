// A stand-in for the shell process, spawned by shutdown.test.ts: a real HTTP
// listener plus a fake `drainShell` over one "app call" in flight. Mode (env
// CHILD_MODE): `drain` the call ends 300 ms after the drain starts; `stuck`
// the call never ends (drain gives up at its timeout, `busy: 1`); `hang` the
// drain itself never returns.
import { createServer } from 'node:http';
import { createDrain, installShutdown } from '../src/lib/server/shutdown.ts';

const mode = process.env.CHILD_MODE ?? 'drain';
let drains = 0;
const streams = new Set<import('node:http').ServerResponse>();
const server = createServer((req, res) => {
  if (req.url === '/stream') {
    // An open EventSource: never ends on its own.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ready\n\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
    return;
  }
  res.end('ok');
});
let workDone = false;
const stopWork = async () => {
  // A workbook import that finishes 700 ms after the stop begins.
  await new Promise((r) => setTimeout(r, 700));
  workDone = true;
  process.stdout.write('work done\n');
};
const drainApps = async () => {
  process.stdout.write(`drain 1 workDone=${workDone}\n`);
  await new Promise((r) => setTimeout(r, 300));
  process.stdout.write('call finished\n');
  return { closed: 1, busy: 0 };
};
if (mode === 'embedded') {
  // An embedding host (#5546): it owns the listener, the signals and the exit.
  // No installShutdown here; the host calls the drain when it decides to.
  const drain = createDrain({
    endStreams: () => {
      process.stdout.write('streams ended\n');
      for (const res of streams) res.end();
    },
    stopWork,
    drain: drainApps,
  });
  process.stdin.once('data', async () => {
    const first = drain();
    const second = drain();
    const result = await first;
    process.stdout.write(`same promise ${first === second}\n`);
    process.stdout.write(`steps ${JSON.stringify(result.steps)}\n`);
    process.stdout.write(`listening ${server.listening}\n`);
    // The host's own listener still answers after the drain.
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    process.stdout.write(`served ${res.status} ${await res.text()}\n`);
    process.stdout.write(`exit code ${result.code}\n`);
    // The host decides when to close its listener and exit.
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
} else
installShutdown({
  ...(process.env.CHILD_ENDSTREAMS === '0'
    ? {}
    : {
        endStreams: () => {
          for (const res of streams) res.end();
        },
      }),
  // A workbook import that finishes 700 ms after the stop begins.
  ...(process.env.CHILD_STOPWORK === '0'
    ? {}
    : {
        stopWork: async () => {
          if (process.env.CHILD_STOPWORK === 'throw') throw new Error('x');
          await new Promise((r) => setTimeout(r, 700));
          workDone = true;
          process.stdout.write('work done\n');
        },
      }),
  stopAccepting: () =>
    new Promise<void>((resolve) => {
      server.closeIdleConnections();
      server.close(() => resolve());
    }),
  drain: async (timeoutMs) => {
    drains++;
    process.stdout.write(`drain ${drains} workDone=${workDone}\n`);
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'stuck') {
      await new Promise((r) => setTimeout(r, timeoutMs));
      return { closed: 1, busy: 1 };
    }
    await new Promise((r) => setTimeout(r, 300));
    process.stdout.write('call finished\n');
    return { closed: 1, busy: 0 };
  },
  onExit: (code) => {
    process.stdout.write(`exit ${code} drains=${drains}\n`);
    process.exit(code);
  },
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  process.stdout.write(`ready ${port}\n`);
});
