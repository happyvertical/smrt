/**
 * Evaluates the BUILT browser entry (`dist/browser.js`, what the package's
 * `browser` export condition resolves to) in real Chromium (#2838).
 *
 * The bundle-gate proves the module graph contains no Node-only modules; this
 * proves the entry also *runs*: a Vite browser bundle is loaded in a page and
 * the test fails on any evaluation error (`Buffer is not defined` from `pg`,
 * `process is not defined`, a missing export) or any module Vite had to
 * externalize "for browser compatibility". Run `pnpm build` first.
 *
 * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use a Chromium other than
 * Playwright's own install.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, createLogger } from 'vite';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserEntry = resolve(packageDir, 'dist/browser.js');
const browserHost = resolve(packageDir, 'dist/host.browser.js');
if (!existsSync(browserEntry)) {
  throw new Error(`${browserEntry} is missing; run \`pnpm build\` first`);
}

const workDir = await mkdtemp(resolve(tmpdir(), 'smrt-core-browser-entry-'));
const outputDir = resolve(workDir, 'dist');
const entry = resolve(workDir, 'entry.ts');
const contentTypes = { '.js': 'text/javascript', '.map': 'application/json' };

try {
  await writeFile(
    entry,
    `import * as core from ${JSON.stringify(browserEntry)};
import { buildWhere, raw, NestedTransactionError } from ${JSON.stringify(browserHost)};
const query = buildWhere({ id: 1 });
if (!query || !raw('count(*)') || typeof NestedTransactionError !== 'function') {
  throw new Error('browser SQL helpers are unavailable');
}
const { SmrtObject, ObjectRegistry, smrt } = core;
const required = ['SmrtObject', 'SmrtCollection', 'SmrtClass', 'smrt', 'smrtRegistry'];
const missing = required.filter((name) => !(name in core));
if (missing.length > 0) throw new Error('browser entry lacks exports: ' + missing.join(', '));
if (typeof process !== 'undefined') throw new Error('page unexpectedly has process');
if (typeof Buffer !== 'undefined') throw new Error('page unexpectedly has Buffer');

// Loading is not enough: a decorated class must register and construct
// without a filesystem, a manifest or a database.
@smrt()
class BrowserWidget extends SmrtObject {
  name = '';
  size = 0;
  constructor(options = {}) {
    super(options);
    Object.assign(this, options);
  }
}
const widget = new BrowserWidget({ name: 'probe', size: 3 });
if (widget.name !== 'probe' || widget.size !== 3) throw new Error('widget fields were not assigned');
const registered = ObjectRegistry.getClass('BrowserWidget');
if (!registered) throw new Error('decorated class did not register');
document.body.textContent = 'browser entry evaluated: ' + Object.keys(core).length + ' exports';
`,
  );

  // Vite reports a Node built-in it cannot bundle as a warning and substitutes
  // a throwing stub; treat each one as a failure instead of letting the
  // entry "evaluate" over a stub.
  const externalized = [];
  const logger = createLogger('error');
  const warn = logger.warn.bind(logger);
  logger.warn = (message, options) => {
    if (message.includes('externalized for browser compatibility')) {
      externalized.push(message.split('\n')[0]);
    } else {
      warn(message, options);
    }
  };
  await build({
    configFile: false,
    customLogger: logger,
    logLevel: 'warn',
    root: packageDir,
    oxc: { decorator: { legacy: true } },
    build: {
      outDir: outputDir,
      minify: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'entry.js' } },
      target: 'es2022',
    },
  });
  if (externalized.length > 0) {
    throw new Error(
      `browser entry bundles Node-only modules:\n${[...new Set(externalized)].join('\n')}`,
    );
  }

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script type="module" src="/entry.js"></script>');
      return;
    }
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    const file = resolve(outputDir, `.${pathname}`);
    if (!file.startsWith(`${outputDir}/`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, {
        'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
      });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        chromium.executablePath(),
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page
      .waitForFunction(
        () => document.body.textContent?.includes('browser entry evaluated'),
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {
        throw new Error(
          errors.join('\n') || 'browser entry did not finish evaluating',
        );
      });
    if (errors.length > 0) throw new Error(errors.join('\n'));
    console.log(await page.evaluate(() => document.body.textContent));
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
} finally {
  await rm(workDir, { force: true, recursive: true });
}
