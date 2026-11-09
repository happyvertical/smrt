// A stand-in for smrt-mcp-bridge, driven by newline-delimited JSON commands on
// stdin. It reads its configuration the way the real bridge does (environment
// variables selected by --env-prefix) and talks to the loopback stub.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const prefix = process.argv
  .find((arg) => arg.startsWith('--env-prefix='))
  ?.split('=')[1];
const url = process.env[`${prefix}_SERVER_URL`];
const token = process.env[`${prefix}_TOKEN`];
let lingering = false;

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

process.on('SIGTERM', () => {
  if (!ignoreTerm) process.exit(0);
});
let ignoreTerm = false;

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const message = JSON.parse(line);
  switch (message.cmd) {
    case 'forward': {
      const response = await fetch(`${url}/api/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      out({ status: response.status, body: await response.json() });
      break;
    }
    case 'info':
      out({
        pid: process.pid,
        argv: process.argv.slice(2),
        envKeys: Object.keys(process.env).sort(),
        cwd: process.cwd(),
        origin: url,
      });
      break;
    case 'leak':
      out({ leak: token });
      process.stderr.write(`leak ${token}\n`);
      break;
    case 'leak-split': {
      const half = Math.floor(token.length / 2);
      process.stdout.write(`{"split":"${token.slice(0, half)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.stdout.write(`${token.slice(half)}"}\n`);
      process.stderr.write(token.slice(0, half));
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.stderr.write(`${token.slice(half)}\n`);
      break;
    }
    case 'length':
      out({ length: message.data.length });
      break;
    case 'flood': {
      const chunk = 'x'.repeat(1023);
      for (let index = 0; index < message.count; index += 1) {
        const ok = process.stdout.write(`${index}:${chunk}\n`);
        if (!ok) {
          await new Promise((resolve) => process.stdout.once('drain', resolve));
        }
      }
      out({ done: message.count });
      break;
    }
    case 'linger':
      lingering = true;
      ignoreTerm = message.ignoreTerm === true;
      setInterval(() => undefined, 1_000);
      out({ lingering: true });
      break;
    case 'hold-pipes': {
      // A detached grandchild that inherits (and so holds open) our pipes.
      const grandchild = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: ['ignore', 'inherit', 'inherit'] },
      );
      grandchild.unref();
      out({ grandchild: grandchild.pid });
      break;
    }
    case 'die':
      process.exit(message.code ?? 3);
      break;
    case 'kill-self':
      process.kill(process.pid, 'SIGKILL');
      break;
    default:
      out({ error: 'unknown' });
  }
});
input.on('close', () => {
  if (!lingering) process.exit(0);
});
