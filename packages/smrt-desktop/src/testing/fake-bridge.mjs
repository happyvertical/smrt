// Fake bridge for the fd 3 handoff tests. Test-only: not part of the package.
//
// Reads launcher frames from descriptor 3 (a socketpair or named pipe the
// launcher inherited into this process), reports each one on stdout as a JSON
// line, and sends a `refresh` frame to the launcher when stdin receives a line
// that says `401`. It prints a SHA-256 of the token, never the token itself.
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';

const channel = new Socket({ fd: 3, readable: true, writable: true });
channel.setEncoding('utf8');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

report({
  type: 'started',
  argv: process.argv,
  env: process.env,
  pid: process.pid,
});

let buffer = '';
channel.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const frame = JSON.parse(line);
    report({
      type: 'frame',
      frameType: frame.type,
      seq: frame.seq,
      origin: frame.origin,
      code: frame.code,
      tokenSha: typeof frame.token === 'string' ? sha(frame.token) : undefined,
      keys: Object.keys(frame),
    });
  }
});
channel.on('error', () => {});
channel.on('close', () => process.exit(0));

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '401') {
    channel.write(`${JSON.stringify({ v: 1, type: 'refresh' })}\n`);
  } else if (line.trim() === 'garbage') {
    channel.write('not json\n');
  } else if (line.trim() === 'exit') {
    process.exit(0);
  }
});
