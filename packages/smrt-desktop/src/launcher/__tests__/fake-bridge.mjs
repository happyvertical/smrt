// A stand-in for smrt-mcp-bridge, driven by newline-delimited JSON commands on
// stdin. It reads its configuration the way the real bridge does (environment
// variables selected by --env-prefix).
import { createInterface } from 'node:readline';

const prefix = process.argv
  .find((arg) => arg.startsWith('--env-prefix='))
  ?.split('=')[1];
const token = process.env[`${prefix}_TOKEN`];
let lingering = false;
let ignoreTerm = false;

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('SIGTERM', () => {
  if (!ignoreTerm) process.exit(0);
});

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const message = JSON.parse(line);
  switch (message.cmd) {
    case 'info':
      out({
        pid: process.pid,
        argv: process.argv.slice(2),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            key.startsWith(prefix),
          ),
        ),
        envKeys: Object.keys(process.env).sort(),
        cwd: process.cwd(),
      });
      break;
    case 'echo':
      out({ echo: message.data });
      break;
    case 'leak':
      out({ leak: token });
      process.stderr.write(`leak ${token}\n`);
      break;
    case 'leak-split': {
      const half = Math.floor(token.length / 2);
      process.stdout.write(`{"split":"${token.slice(0, half)}`);
      await pause(50);
      process.stdout.write(`${token.slice(half)}"}\n`);
      process.stderr.write(token.slice(0, half));
      await pause(50);
      process.stderr.write(`${token.slice(half)}\n`);
      break;
    }
    case 'linger':
      // Outlive stdin EOF; optionally ignore SIGTERM too.
      lingering = true;
      ignoreTerm = message.ignoreTerm === true;
      setInterval(() => undefined, 1_000);
      out({ lingering: true, pid: process.pid });
      break;
    case 'die':
      process.exit(message.code ?? 3);
      break;
    default:
      out({ error: 'unknown' });
  }
});
input.on('close', () => {
  if (!lingering) process.exit(0);
});
