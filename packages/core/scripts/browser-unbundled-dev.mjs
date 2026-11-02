/**
 * Serves smrt-core's BUILT naming module UNBUNDLED from a real Vite dev server
 * and evaluates it in real Chromium (#4054).
 *
 * Consumers reach smrt-core through packages excluded from dependency
 * pre-bundling (#3843; e.g. `@happyvertical/smrt-planner`), so Vite dev serves
 * `dist/*.js` and every bare import beneath it as native browser ESM. A
 * CommonJS dependency then fails in the page (`does not provide an export
 * named 'default'`), although `vite build`, which converts CommonJS, and
 * `browser-entry-evaluation.mjs` pass. `dist/utils/naming.js` is the module
 * every table-name derivation goes through; this script disables dependency
 * discovery so nothing beneath it is pre-bundled. Run `pnpm build` first.
 *
 * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use a Chromium other than
 * Playwright's own install.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namingModule = resolve(packageDir, 'dist/utils/naming.js');
if (!existsSync(namingModule)) {
  throw new Error(`${namingModule} is missing; run \`pnpm build\` first`);
}

const workDir = await mkdtemp(resolve(tmpdir(), 'smrt-core-unbundled-dev-'));
let server;
let browser;
try {
  await writeFile(
    resolve(workDir, 'index.html'),
    `<!doctype html><link rel="icon" href="data:,"><script type="module">
import { classnameToTablename, pluralize } from '/@fs${namingModule}';
window.__result = {
  table: classnameToTablename('JournalEntry'),
  plural: pluralize('person'),
};
</script>`,
  );
  server = await createServer({
    root: workDir,
    configFile: false,
    logLevel: 'warn',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      port: 0,
      hmr: false,
      fs: { allow: [workDir, resolve(packageDir, '../..')] },
    },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('Vite dev server did not report a local URL');

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url);
  const result = await page
    .waitForFunction(() => window.__result, undefined, { timeout: 30_000 })
    .then((handle) => handle.jsonValue())
    .catch(() => undefined);
  if (errors.length > 0 || !result) {
    throw new Error(
      `dist/utils/naming.js failed unbundled in Vite dev:\n${errors.join('\n') || 'no result'}`,
    );
  }
  const expected = { table: 'journal_entries', plural: 'people' };
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(
      `unexpected result ${JSON.stringify(result)}; expected ${JSON.stringify(expected)}`,
    );
  }
  console.log('✓ dist/utils/naming.js evaluates unbundled in Vite dev (#4054)');
} finally {
  await browser?.close();
  await server?.close();
  await rm(workDir, { recursive: true, force: true });
}
