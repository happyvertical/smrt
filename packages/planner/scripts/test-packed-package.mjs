import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);
const suppliedTarball =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.PACKED_TARBALL;

if (!suppliedTarball) {
  console.error(
    'usage: pnpm test:package -- /absolute/path/to/smrt-planner-<version>.tgz',
  );
  process.exit(2);
}

const tarball = resolve(suppliedTarball);
if (!existsSync(tarball)) {
  console.error(`packed package not found: ${tarball}`);
  process.exit(2);
}

const consumer = mkdtempSync(resolve(tmpdir(), 'smrt-planner-consumer-'));

const chromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const contentType = (file) =>
  file.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : file.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : file.endsWith('.wasm')
            ? 'application/wasm'
            : 'application/octet-stream';

async function browserContract(site) {
  const executablePath = chromePaths.find(existsSync);
  if (!executablePath) throw new Error('Chrome/Chromium is required for test:package');
  const providerRequests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/provider/v1/chat/completions') {
      let body = '';
      for await (const chunk of request) body += chunk;
      providerRequests.push({
        body,
        authorization: request.headers.authorization ?? '',
      });
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'credential rejected' }));
      return;
    }
    if (!url.pathname.startsWith('/plan')) {
      response.writeHead(404).end();
      return;
    }
    const relativePath = url.pathname
      .slice('/plan'.length)
      .replace(/^\/+/, '');
    let file = resolve(
      site,
      !relativePath
        ? 'index.html'
        : relativePath.endsWith('/')
          ? `${relativePath}index.html`
          : relativePath,
    );
    if (!existsSync(file) && !basename(relativePath).includes('.')) {
      file = resolve(site, '404.html');
    }
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': contentType(file) });
    response.end(readFileSync(file));
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    const nested = `${origin}/plan/m/products/Product/missing`;
    const navigation = await page.goto(nested, { waitUntil: 'networkidle' });
    if (navigation?.status() !== 200) throw new Error('nested fallback did not answer 200');
    await page.getByRole('link', { name: 'Planner' }).first().waitFor();
    if (requests.some((url) => new URL(url).pathname.startsWith('/_app/'))) {
      throw new Error('fallback requested a root-level app asset');
    }
    if (!requests.some((url) => new URL(url).pathname.startsWith('/plan/_app/'))) {
      throw new Error('fallback did not request prefixed app assets');
    }
    const plannerLink = page.getByRole('link', { name: 'Planner' }).first();
    const plannerHref = await plannerLink.getAttribute('href');
    if (!plannerHref?.startsWith('/plan/')) {
      throw new Error(`in-app link lost the base prefix: ${plannerHref}`);
    }
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/plan/'),
      plannerLink.click(),
    ]);
    await page.goto(nested, { waitUntil: 'networkidle' });
    await page.goBack({ waitUntil: 'networkidle' });
    if (!new URL(page.url()).pathname.startsWith('/plan/')) {
      throw new Error('back navigation lost the base prefix');
    }
    await page.goForward({ waitUntil: 'networkidle' });
    if (
      new URL(page.url()).pathname.replace(/\/$/, '') !==
      '/plan/m/products/Product/missing'
    ) {
      throw new Error(`forward navigation lost the nested URL: ${page.url()}`);
    }

    await page.goto(`${origin}/plan/ai/`, { waitUntil: 'networkidle' });
    const mode = page.getByLabel('Assistant mode');
    if ((await mode.inputValue()) !== 'byo') throw new Error('BYO was not initial');
    await mode.selectOption('browser');
    if ((await mode.inputValue()) !== 'browser') throw new Error('WebLLM selection failed');
    if (requests.some((url) => /huggingface|mlc\.ai|wasm\/model/i.test(url))) {
      throw new Error('selecting WebLLM started a model download');
    }
    await mode.selectOption('byo');
    await page.getByLabel('Model provider').selectOption('custom');
    await page
      .getByRole('textbox', { name: 'Address', exact: true })
      .fill(`${origin}/provider/v1`);
    await page
      .getByRole('textbox', { name: 'Model', exact: true })
      .fill('hosted-test');
    await page.getByLabel('Key').fill('browser-secret-value');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByRole('alert').waitFor();
    if ((await mode.inputValue()) !== 'byo') throw new Error('failure changed inference mode');
    if (providerRequests.length !== 1) throw new Error('provider test was not observed');
    if (providerRequests[0].authorization !== 'Bearer browser-secret-value') {
      throw new Error('provider key was not origin-bound to Authorization');
    }
    if (providerRequests[0].body.includes('browser-secret-value')) {
      throw new Error('provider key leaked into request body');
    }
    const browserState = await page.evaluate(async () => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      url: location.href,
      history: JSON.stringify(history.state),
      databases:
        typeof indexedDB.databases === 'function'
          ? (await indexedDB.databases()).map((entry) => entry.name)
          : [],
    }));
    const serialized = JSON.stringify(browserState);
    if (serialized.includes('browser-secret-value')) {
      throw new Error('memory-only key leaked into browser persistence or URL');
    }
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/plan/'),
      page.getByRole('link', { name: 'Planner' }).first().click(),
    ]);
    const dismissSetup = page.getByRole('button', {
      name: /I don't need AI/,
    });
    if (await dismissSetup.isVisible()) await dismissSetup.click();
    const leftPanel = page.locator('#smrt-admin-shell-left-panel');
    if ((await leftPanel.count()) !== 1) {
      throw new Error('the packaged planner is not inside its AppShell');
    }
    await page.getByRole('tab', { name: 'Layout' }).click();
    const showLeftPanel = page.getByLabel('Show Left sidebar panel');
    if (!(await showLeftPanel.isChecked())) {
      throw new Error('the shell layout editor did not read the live AppShell');
    }
    await page.getByText('Show Left sidebar panel', { exact: true }).click();
    if (await showLeftPanel.isChecked()) {
      throw new Error('the shell layout editor did not accept the panel edit');
    }
    await page.waitForFunction(
      () => document.querySelector('#smrt-admin-shell-left-panel') === null,
    );
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'networkidle' });
    if ((await leftPanel.count()) !== 0) {
      throw new Error('the planner shell layout edit did not persist on reload');
    }
    await page.getByRole('tab', { name: 'Export' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export cookbook' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('cookbook export had no file');
    const exported = readFileSync(downloadPath, 'utf8');
    if (exported.includes('browser-secret-value')) {
      throw new Error('memory-only key leaked into cookbook export');
    }
    if (JSON.parse(exported).layout?.panels?.left?.visible !== false) {
      throw new Error('cookbook export omitted the live shell layout edit');
    }

    await page.goto(`${origin}/plan/ai/`, { waitUntil: 'networkidle' });
    await page.getByLabel('Model provider').selectOption('custom');
    if (
      (await page
        .getByRole('textbox', { name: 'Model', exact: true })
        .inputValue()) !== 'hosted-test'
    ) {
      throw new Error('model preference did not persist');
    }
    if ((await page.getByLabel('Key').inputValue()) !== '') {
      throw new Error('memory-only key survived reload');
    }
    const missingAsset = await page.evaluate(() =>
      fetch('/plan/_app/missing.js').then((response) => response.status),
    );
    if (missingAsset !== 404) throw new Error('missing planner asset did not stay 404');
    const siteMiss = await page.evaluate(() =>
      fetch('/ordinary-site-miss').then((response) => response.status),
    );
    if (siteMiss !== 404) throw new Error('ordinary site miss did not stay 404');
  } finally {
    await browser.close();
    await new Promise((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
}

try {
  writeFileSync(
    resolve(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'smrt-planner-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@happyvertical/smrt-planner': `file:${tarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    resolve(consumer, '.npmrc'),
    '@happyvertical:registry=https://npm.happyvertical.com/\n',
  );
  writeFileSync(
    resolve(consumer, 'verify.mjs'),
    `
      import { existsSync, readFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { createHeadlessPlanner } from '@happyvertical/smrt-planner/core';
      import { appFile, materializeApp } from '@happyvertical/smrt-planner/app';
      import pkg from '@happyvertical/smrt-planner/package.json' with { type: 'json' };

      if (pkg.name !== '@happyvertical/smrt-planner') throw new Error('wrong package name');
      if (pkg.version !== ${JSON.stringify(packageJson.version)}) throw new Error('wrong package version');
      const planner = createHeadlessPlanner();
      const result = planner.run({ name: 'add_cookbook', input: { id: 'bakery' } });
      if (!result.ok || result.snapshot.recipes.length === 0) throw new Error('headless planner failed');
      if (!existsSync(appFile('index.html'))) throw new Error('packaged app is missing');
      const site = resolve('site');
      materializeApp({
        outDir: site,
        basePath: '/plan',
        config: {
          inference: {
            mode: 'byo',
            alternatives: ['browser'],
            credentialPersistence: 'memory',
            byo: { presets: ['ollama', 'openrouter', 'openai', 'custom'] },
          },
        },
      });
      const fallback = readFileSync(resolve(site, '404.html'), 'utf8');
      if (fallback.includes('"/_app/')) throw new Error('fallback has root asset references');
      if (!fallback.includes('"/plan/_app/')) throw new Error('fallback lacks prefixed assets');
      if (!fallback.includes('base: "/plan"')) throw new Error('fallback runtime base is wrong');
      const config = readFileSync(resolve(site, 'planner.config.json'), 'utf8');
      if (!config.endsWith('\\n') || config.includes('key')) throw new Error('unsafe or unstable config');
      console.log(${JSON.stringify(`${basename(tarball)} consumer verified`)});
    `,
  );

  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: resolve(consumer, '.npmrc'),
  };
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error('test:package must run through pnpm');
  }
  execFileSync(
    process.execPath,
    [pnpmCli, 'install', '--ignore-scripts', '--no-frozen-lockfile'],
    { cwd: consumer, env, stdio: 'inherit' },
  );
  execFileSync(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    env,
    stdio: 'inherit',
  });
  await browserContract(resolve(consumer, 'site'));
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
