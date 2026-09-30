import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'vite';
const result = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    minify: true,
    lib: {
      entry: new URL('reference.ts', import.meta.url).pathname,
      name: 'FormReference',
      formats: ['iife'],
    },
  },
});
const script = (Array.isArray(result) ? result[0] : result).output.find(
  (x) => x.type === 'chunk',
).code;
const hash = createHash('sha256').update(script).digest('base64');
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic application form</title></head><body><script>${script}</script></body></html>`;
if (Buffer.byteLength(html) > 102400) throw new Error('Form exceeds 100 KiB');
createServer(async (req, res) => {
  if (req.url === '/submit') {
    let raw = '';
    for await (const part of req) {
      raw += part;
      if (raw.length > 65536) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const reply = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ received: reply, domainApprovalRequired: true }));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.setHeader(
    'content-security-policy',
    `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'`,
  );
  res.end(html);
}).listen(47869, '127.0.0.1');
