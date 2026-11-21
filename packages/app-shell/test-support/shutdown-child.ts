// A stand-in for the shell process, spawned by shutdown.test.ts: a real HTTP
// listener plus a fake `drainShell` over one "app call" in flight. Mode (env
// CHILD_MODE): `drain` the call ends 300 ms after the drain starts; `stuck`
// the call never ends (drain gives up at its timeout, `busy: 1`); `hang` the
// drain itself never returns.
import { createServer } from 'node:http';
import { installShutdown } from '../src/lib/server/shutdown.ts';

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
