import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = await mkdtemp(resolve(tmpdir(), 'smrt-core-browser-plain-json-'));
const outputDir = resolve(workDir, 'dist');
const entry = resolve(workDir, 'entry.ts');
const contentTypes = { '.js': 'text/javascript', '.map': 'application/json' };

try {
  await writeFile(
    entry,
    `Object.defineProperty(JSON, 'isRawJSON', { configurable: true, value: undefined });
const { getBoxedPrimitiveKind, isRawJSON } = await import(${JSON.stringify(resolve(packageDir, 'src/plain-json.ts'))});
const foreign = window.frames[0];
const values = [
  new foreign.Boolean(true),
  new foreign.Number(3),
  new foreign.String('text'),
  Object(1n),
];
const kinds = values.map(getBoxedPrimitiveKind);
if (JSON.stringify(kinds) !== JSON.stringify(['boolean', 'number', 'string', 'bigint'])) throw new Error('boxed primitive brands were not preserved');
const tagged = new Number(1);
Object.defineProperty(tagged, Symbol.toStringTag, { get() { throw new Error('tag getter must not run'); } });
if (getBoxedPrimitiveKind(tagged) !== 'number') throw new Error('brand probe observed Symbol.toStringTag');
if (isRawJSON({ rawJSON: '1' })) throw new Error('JSON.isRawJSON fallback must be false when unavailable');
if (typeof process !== 'undefined') throw new Error('browser probe unexpectedly has process');
if (typeof JSON.isRawJSON !== 'undefined') throw new Error('browser probe unexpectedly has JSON.isRawJSON');
document.body.textContent = 'browser plain-json regression passed';
`,
  );
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: outputDir,
      rollupOptions: { input: entry, output: { entryFileNames: 'entry.js' } },
      target: 'es2022',
    },
  });
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<iframe></iframe><script type="module" src="/entry.js"></script>');
      return;
    }
    const file = resolve(outputDir, `.${pathname}`);
    if (!file.startsWith(`${outputDir}/`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromium.executablePath() });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(
      () => document.body.textContent?.includes('passed'),
      undefined,
      { timeout: 5_000 },
    ).catch(() => { throw new Error(errors.join('\n') || 'browser probe did not complete'); });
    console.log('browser plain-json regression passed');
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
} finally {
  await rm(workDir, { force: true, recursive: true });
}
