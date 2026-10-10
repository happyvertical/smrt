import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookbookCommands } from '../cookbook.js';
import type { KitchenAI } from '../kitchen/ai.js';
import { resolveKitchenAI } from '../kitchen/ai.js';
import { createCookbookApplier } from '../kitchen/apply.js';
import {
  inspectPlanner,
  loadPlannerCore,
  PLANNER_PACKAGE,
  PlannerError,
  type PlannerInstall,
  plannerCacheDir,
  resolvePlanner,
} from '../kitchen/planner.js';
import { checkTargetDir, runKitchen } from '../kitchen/run.js';
import {
  type KitchenServer,
  startKitchenServer,
  TOKEN_HEADER,
} from '../kitchen/server.js';
import { kitchenCommands } from '../kitchen.js';

/** A planner package as `pnpm package` leaves it, with a tiny stand-in core. */
const FAKE_CORE = `
export function parseHostRequest(body) {
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return { ok: false, error: '"message" must be a non-empty string' };
  }
  return { ok: true, request: body };
}
export function buildHostPrompt(request) {
  return {
    system: 'SYSTEM for ' + request.message.length + ' chars',
    messages: [...(request.history ?? []), { role: 'user', content: request.message }],
  };
}
export function parseHostReply(text) {
  try {
    const value = JSON.parse(text);
    return { ok: true, reply: { reply: String(value.reply ?? 'ok'), add: value.add ?? [] }, issues: [] };
  } catch {
    return { ok: false, reply: { reply: 'fallback' }, issues: ['the reply was not a JSON object'] };
  }
}
`;

function writePlanner(root: string, version = '0.0.1'): void {
  mkdirSync(join(root, 'dist', 'core'), { recursive: true });
  mkdirSync(join(root, 'app', '_app', 'immutable'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: PLANNER_PACKAGE,
      version,
      type: 'module',
      exports: { './core': { default: './dist/core/index.js' } },
    }),
  );
  writeFileSync(join(root, 'dist', 'core', 'index.js'), FAKE_CORE);
  writeFileSync(
    join(root, 'app', 'index.html'),
    '<!doctype html><title>planner</title>',
  );
  writeFileSync(
    join(root, 'app', '_app', 'immutable', 'x.js'),
    'export default 1;',
  );
  // A file next to the app that must never be served.
  writeFileSync(join(root, 'secret.txt'), 'nope');
}

const stubAI = (
  answer: string | Error = '{"reply":"Added Sales.","add":["commerce.sales"]}',
) => {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  const ai: KitchenAI = {
    label: 'stub (test-model)',
    async chat(messages) {
      calls.push(messages);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { ai, calls };
};

const COOKBOOK = {
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  name: 'Corner Bakery',
  recipes: ['commerce.sales'],
  features: [],
  policies: [],
};

let work: string;
let plannerRoot: string;
let install: PlannerInstall;
let manifests: string;
let template: string;
const servers: KitchenServer[] = [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'smrt-kitchen-'));
  plannerRoot = join(work, 'planner');
  writePlanner(plannerRoot);
  install = inspectPlanner(plannerRoot, 'local');
  manifests = join(work, 'manifests');
  mkdirSync(manifests);
  writeFileSync(
    join(manifests, 'commerce.json'),
    JSON.stringify({
      packageName: '@happyvertical/smrt-commerce',
      recipes: [{ id: 'commerce.sales' }],
      objects: {},
    }),
  );
  template = join(work, 'template');
  mkdirSync(template);
  writeFileSync(
    join(template, 'package.json'),
    JSON.stringify(
      {
        name: 'template',
        dependencies: { '@happyvertical/smrt-core': '^1.2.3' },
        scripts: { 'app:setup': 'x', 'app:doctor': 'y' },
      },
      null,
      2,
    ),
  );
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  rmSync(work, { recursive: true, force: true });
});

async function start(
  options: { ai?: KitchenAI | null; project?: string } = {},
): Promise<{ server: KitchenServer; project: string; origin: string }> {
  const project = options.project ?? join(work, 'project');
  const core = await loadPlannerCore(install);
  const server = await startKitchenServer({
    planner: install,
    core,
    ai: options.ai === undefined ? stubAI().ai : options.ai,
    apply: createCookbookApplier({
      dir: project,
      template,
      install: false,
      manifests: [manifests],
      registry: false,
    }),
    token: 'test-token',
  });
  servers.push(server);
  return { server, project, origin: `http://127.0.0.1:${server.port}` };
}

const readJson = async (response: Response): Promise<any> => response.json();

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** A request with a hand-made path and Host, which `fetch` would normalise away. */
function raw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('planner.config.json', () => {
  it('announces host mode and the kitchen endpoint when a model is configured', async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/planner.config.json`);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      inference: { mode: 'host', host: { endpoint: '/api/planner/chat' } },
      kitchen: { endpoint: '/api/kitchen/cookbook', token: 'test-token' },
    });
  });

  it('falls back to browser mode, keeping the kitchen, with no model', async () => {
    const { origin, server } = await start({ ai: null });
    expect(server.mode).toBe('browser');
    const body = await (await fetch(`${origin}/planner.config.json`)).json();
    expect(body).toEqual({
      inference: { mode: 'browser' },
      kitchen: { endpoint: '/api/kitchen/cookbook', token: 'test-token' },
    });
    const chat = await fetch(`${origin}/api/planner/chat`, json({}));
    expect(chat.status).toBe(503);
  });

  it('draws the token at random when none is given', async () => {
    const core = await loadPlannerCore(install);
    const make = async () => {
      const server = await startKitchenServer({
        planner: install,
        core,
        ai: null,
        apply: async () => ({ ok: false, status: 500, errors: [] }),
      });
      servers.push(server);
      return server;
    };
    const [a, b] = [await make(), await make()];
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
    expect(a.port).not.toBe(b.port);
  });
});

describe('serving the app', () => {
  it('serves the planner app at / and its assets, and nothing outside it', async () => {
    const { origin, server } = await start();
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('<title>planner</title>');
    const asset = await fetch(`${origin}/_app/immutable/x.js`);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect((await fetch(`${origin}/missing`)).status).toBe(404);
    for (const path of [
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/..%2f..%2fpackage.json',
    ]) {
      const result = await raw(server.port, path);
      expect([400, 403, 404], path).toContain(result.status);
      expect(result.body).not.toContain('nope');
    }
  });

  it('refuses a request whose Host is not this server (DNS rebinding)', async () => {
    const { server } = await start();
    const result = await raw(server.port, '/planner.config.json', {
      host: 'evil.example',
    });
    expect(result.status).toBe(403);
    expect(result.body).not.toContain('test-token');
  });

  it('listens on 127.0.0.1 only', async () => {
    const { server } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });
});

describe('/api/planner/chat', () => {
  const body = {
    version: 1,
    message: 'I run a bakery',
    snapshot: { version: 1 },
    history: [{ role: 'assistant', content: 'Hello' }],
  };

  it('builds the prompt, asks the model and returns the parsed reply', async () => {
    const { ai, calls } = stubAI();
    const { origin } = await start({ ai });
    const response = await fetch(
      `${origin}/api/planner/chat`,
      json(body, { origin }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      reply: 'Added Sales.',
      add: ['commerce.sales'],
    });
    expect(calls).toEqual([
      [
        { role: 'system', content: 'SYSTEM for 14 chars' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'I run a bakery' },
      ],
    ]);
  });

  it('repairs a model answer that is not JSON instead of passing it on', async () => {
    const { origin } = await start({ ai: stubAI('Sure! Here you go').ai });
    const response = await fetch(
      `${origin}/api/planner/chat`,
      json(body, { origin }),
    );
    expect(await readJson(response)).toEqual({ reply: 'fallback' });
  });

  it('answers 400 for a bad request and never calls the model', async () => {
    const { ai, calls } = stubAI();
    const { origin } = await start({ ai });
    const bad = await fetch(
      `${origin}/api/planner/chat`,
      json({ version: 1 }, { origin }),
    );
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error).toMatch(/message/);
    const notJson = await fetch(`${origin}/api/planner/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{nope',
    });
    expect(notJson.status).toBe(400);
    const wrongType = await fetch(`${origin}/api/planner/chat`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin },
      body: JSON.stringify(body),
    });
    expect(wrongType.status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('refuses a foreign Origin', async () => {
    const { ai, calls } = stubAI();
    const { origin } = await start({ ai });
    const response = await fetch(
      `${origin}/api/planner/chat`,
      json(body, { origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('reports a failing model as 502 without leaking its message', async () => {
    const { origin } = await start({
      ai: stubAI(new Error('401 for key sk-secret')).ai,
    });
    const response = await fetch(
      `${origin}/api/planner/chat`,
      json(body, { origin }),
    );
    expect(response.status).toBe(502);
    expect(JSON.stringify(await readJson(response))).not.toContain('sk-secret');
  });
});

describe('/api/kitchen/cookbook', () => {
  it('requires the token, a same-origin JSON POST, and applies nothing otherwise', async () => {
    const { origin, project } = await start();
    const url = `${origin}/api/kitchen/cookbook`;
    const attempts: Array<[string, RequestInit]> = [
      ['no token', json(COOKBOOK, { origin })],
      ['wrong token', json(COOKBOOK, { origin, [TOKEN_HEADER]: 'nope' })],
      ['no Origin', json(COOKBOOK, { [TOKEN_HEADER]: 'test-token' })],
      [
        'foreign Origin',
        json(COOKBOOK, {
          origin: 'https://evil.example',
          [TOKEN_HEADER]: 'test-token',
        }),
      ],
    ];
    const statuses: Record<string, number> = {};
    for (const [name, init] of attempts) {
      statuses[name] = (await fetch(url, init)).status;
    }
    expect(statuses).toEqual({
      'no token': 401,
      'wrong token': 401,
      'no Origin': 403,
      'foreign Origin': 403,
    });
    const wrongType = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin,
        [TOKEN_HEADER]: 'test-token',
      },
      body: JSON.stringify(COOKBOOK),
    });
    expect(wrongType.status).toBe(415);
    expect(existsSync(project)).toBe(false);
  });

  it('validates, writes the project into the directory, and answers with the next steps', async () => {
    const { origin, project, server } = await start();
    const response = await fetch(
      `${origin}/api/kitchen/cookbook`,
      json(COOKBOOK, { origin, [TOKEN_HEADER]: 'test-token' }),
    );
    expect(response.status).toBe(200);
    const answer = await readJson(response);
    expect(answer).toMatchObject({
      ok: true,
      dir: project,
      mode: 'new',
      installed: false,
      added: ['@happyvertical/smrt-commerce'],
    });
    expect(answer.nextSteps).toEqual(
      expect.arrayContaining([
        'pnpm install',
        'pnpm app:setup',
        'pnpm app:doctor',
      ]),
    );
    expect(
      JSON.parse(readFileSync(join(project, 'smrt.cookbook.json'), 'utf-8')),
    ).toMatchObject({
      recipes: ['commerce.sales'],
    });
    const pkg = JSON.parse(
      readFileSync(join(project, 'package.json'), 'utf-8'),
    );
    expect(pkg.name).toBe('corner-bakery');
    expect(pkg.dependencies).toMatchObject({
      '@happyvertical/smrt-commerce': '^1.2.3',
    });
    await expect(server.applied).resolves.toMatchObject({
      ok: true,
      dir: project,
    });
    // One-time: the token is spent.
    const again = await fetch(
      `${origin}/api/kitchen/cookbook`,
      json(COOKBOOK, { origin, [TOKEN_HEADER]: 'test-token' }),
    ).catch(() => undefined);
    if (again) expect(again.status).toBe(401);
  });

  it('refuses an invalid cookbook with the reasons and keeps listening', async () => {
    const { origin, project } = await start();
    const send = (cookbook: unknown) =>
      fetch(
        `${origin}/api/kitchen/cookbook`,
        json(cookbook, { origin, [TOKEN_HEADER]: 'test-token' }),
      );
    const bad = await send({ ...COOKBOOK, recipes: ['nope.nothing'] });
    expect(bad.status).toBe(422);
    const body = await readJson(bad);
    expect(body.ok).toBe(false);
    expect(body.errors.join(' ')).toMatch(/nope\.nothing/);
    expect(existsSync(project)).toBe(false);
    const shape = await send({ recipes: 'x' });
    expect(shape.status).toBe(422);
    // The visitor can fix it and send again with the same token.
    expect((await send(COOKBOOK)).status).toBe(200);
  });

  it('reports a directory that cannot take the project as a conflict', async () => {
    const taken = join(work, 'taken');
    mkdirSync(taken);
    writeFileSync(join(taken, 'file.txt'), 'x');
    const { origin } = await start({ project: taken });
    const response = await fetch(
      `${origin}/api/kitchen/cookbook`,
      json(COOKBOOK, { origin, [TOKEN_HEADER]: 'test-token' }),
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).errors[0]).toMatch(/not empty/);
  });
});

describe('concurrent cookbook posts', () => {
  it('lets only one of two simultaneous posts apply', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = await loadPlannerCore(install);
    const server = await startKitchenServer({
      planner: install,
      core,
      ai: null,
      apply: async () => {
        calls += 1;
        await gate;
        return { ok: true, body: { ok: true } } as never;
      },
      token: 'test-token',
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const post = () =>
      fetch(
        `${origin}/api/kitchen/cookbook`,
        json(COOKBOOK, { origin, [TOKEN_HEADER]: 'test-token' }),
      );
    const first = post();
    const second = post();
    // The loser answers while the winner is still applying.
    const loser = await Promise.race([first, second]);
    expect(loser.status).toBe(409);
    release();
    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(calls).toBe(1);
  });
});

describe('runKitchen', () => {
  it('serves, waits for the cookbook from the page, applies it and returns', async () => {
    const project = join(work, 'run-project');
    const lines: string[] = [];
    const { ai } = stubAI();
    let opened = '';
    const applied = await runKitchen({
      dir: project,
      template,
      install: false,
      open: true,
      manifests: [manifests],
      registry: false,
      log: (line) => lines.push(line),
      overrides: {
        planner: install,
        ai,
        token: 'run-token',
        openBrowser: (url) => {
          opened = url;
        },
      },
      onReady: (server) => {
        void fetch(
          `${server.url}api/kitchen/cookbook`,
          json(COOKBOOK, {
            origin: `http://127.0.0.1:${server.port}`,
            [TOKEN_HEADER]: 'run-token',
          }),
        );
      },
    });
    expect(applied).toMatchObject({ ok: true, dir: project, mode: 'new' });
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(lines.join('\n')).toContain('Chat is answered by stub (test-model)');
    expect(existsSync(join(project, 'smrt.cookbook.json'))).toBe(true);
  });

  it('says so in the terminal when no model is configured', async () => {
    const lines: string[] = [];
    await runKitchen({
      dir: join(work, 'p2'),
      template,
      install: false,
      open: false,
      manifests: [manifests],
      registry: false,
      log: (line) => lines.push(line),
      overrides: { planner: install, ai: null, token: 't' },
      onReady: (server) => {
        void fetch(
          `${server.url}api/kitchen/cookbook`,
          json(COOKBOOK, {
            origin: `http://127.0.0.1:${server.port}`,
            [TOKEN_HEADER]: 't',
          }),
        );
      },
    });
    expect(lines.join('\n')).toMatch(
      /No AI provider is configured.*in-browser model/,
    );
  });

  it('stops cleanly when told to, closing the server', async () => {
    let stopNow!: (reason: Error) => void;
    const stop = new Promise<never>((_, reject) => {
      stopNow = reject;
    });
    let port = 0;
    const running = runKitchen({
      dir: join(work, 'p3'),
      install: false,
      open: false,
      registry: false,
      log: () => {},
      overrides: { planner: install, ai: null },
      stop,
      onReady: (server) => {
        port = server.port;
        queueMicrotask(() => stopNow(new Error('stopped')));
      },
    });
    await expect(running).rejects.toThrow('stopped');
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('refuses a non-empty directory up front', () => {
    const dir = join(work, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'x');
    expect(() => checkTargetDir(dir)).toThrow(/not empty/);
    writeFileSync(join(dir, 'smrt.cookbook.json'), '{}');
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(() => checkTargetDir(dir)).not.toThrow();
    expect(() => checkTargetDir(join(work, 'absent'))).not.toThrow();
  });
});

describe('finding the planner', () => {
  it('checks a --planner directory and says how to package it', () => {
    expect(() => inspectPlanner(join(work, 'nothing'), 'local')).toThrow(
      /not a planner package/,
    );
    const unpackaged = join(work, 'unpackaged');
    mkdirSync(unpackaged);
    writeFileSync(
      join(unpackaged, 'package.json'),
      JSON.stringify({
        name: PLANNER_PACKAGE,
        exports: { './core': './dist/core/index.js' },
      }),
    );
    expect(() => inspectPlanner(unpackaged, 'local')).toThrow(/pnpm package/);
    const other = join(work, 'other');
    mkdirSync(other);
    writeFileSync(
      join(other, 'package.json'),
      JSON.stringify({ name: 'something-else' }),
    );
    expect(() => inspectPlanner(other, 'local')).toThrow(
      /is not @happyvertical\/smrt-planner/,
    );
  });

  it('puts the cache under the user cache directory, one folder per version', () => {
    expect(plannerCacheDir({ SMRT_CACHE_DIR: '/c' })).toBe(
      join('/c', 'planner'),
    );
    expect(plannerCacheDir({ XDG_CACHE_HOME: '/x' })).toBe(
      join('/x', 'smrt', 'planner'),
    );
  });

  describe('from the registry', () => {
    let tarball: Buffer;
    let downloads = 0;
    let registryUp = true;

    beforeEach(async () => {
      const built = join(work, 'built');
      writePlanner(join(built, 'package'), '2.4.0');
      const file = join(work, 'planner.tgz');
      await create({ gzip: true, file, cwd: built }, ['package']);
      tarball = readFileSync(file);
      downloads = 0;
      registryUp = true;
    });

    const fetchImpl = async (url: string) => {
      if (!registryUp) throw new TypeError('offline');
      if (url.endsWith('/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: '2.4.0',
            dist: { tarball: 'https://registry.example/planner.tgz' },
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      downloads += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          tarball.buffer.slice(
            tarball.byteOffset,
            tarball.byteOffset + tarball.byteLength,
          ) as ArrayBuffer,
      };
    };

    it('downloads once, caches per version, and reuses the cache', async () => {
      const cacheDir = join(work, 'cache');
      const messages: string[] = [];
      const options = {
        cacheDir,
        dir: work,
        registry: { registryUrl: 'https://registry.example', fetchImpl },
        log: (m: string) => messages.push(m),
      };
      const first = await resolvePlanner(options);
      expect(first).toMatchObject({ version: '2.4.0', source: 'registry' });
      expect(first.root).toBe(join(cacheDir, '2.4.0', 'package'));
      expect(existsSync(join(first.appDir, 'index.html'))).toBe(true);
      expect(downloads).toBe(1);
      const second = await resolvePlanner(options);
      expect(second).toMatchObject({ version: '2.4.0', source: 'cache' });
      expect(downloads).toBe(1);
      expect(messages.join('\n')).toMatch(/Downloading the planner 2\.4\.0/);
    });

    it('uses the newest cached copy when the registry is unreachable', async () => {
      const cacheDir = join(work, 'cache');
      await resolvePlanner({
        cacheDir,
        dir: work,
        registry: { registryUrl: 'https://registry.example', fetchImpl },
      });
      registryUp = false;
      const offline = await resolvePlanner({
        cacheDir,
        dir: work,
        registry: { registryUrl: 'https://registry.example', fetchImpl },
      });
      expect(offline).toMatchObject({ version: '2.4.0', source: 'cache' });
    });

    it('refuses a registry version that is not a plain version', async () => {
      const evil = async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          version: '../../../../..',
          dist: { tarball: 'https://registry.example/planner.tgz' },
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      });
      const cacheDir = join(work, 'evil-cache');
      mkdirSync(cacheDir);
      await expect(
        resolvePlanner({
          cacheDir,
          dir: work,
          registry: {
            registryUrl: 'https://registry.example',
            fetchImpl: evil,
          },
        }),
      ).rejects.toBeInstanceOf(PlannerError);
      expect(existsSync(cacheDir)).toBe(true);
    });

    it('refuses a tarball that does not match the registry integrity', async () => {
      const tampered = async (url: string) => {
        const meta = url.endsWith('/latest');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: '2.4.0',
            dist: {
              tarball: 'https://registry.example/planner.tgz',
              integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
            },
          }),
          arrayBuffer: async () =>
            meta
              ? new ArrayBuffer(0)
              : (tarball.buffer.slice(
                  tarball.byteOffset,
                  tarball.byteOffset + tarball.byteLength,
                ) as ArrayBuffer),
        };
      };
      await expect(
        resolvePlanner({
          cacheDir: join(work, 'tampered-cache'),
          dir: work,
          registry: {
            registryUrl: 'https://registry.example',
            fetchImpl: tampered,
          },
        }),
      ).rejects.toBeInstanceOf(PlannerError);
    });

    it('fails with a clear message when there is no planner anywhere', async () => {
      registryUp = false;
      const attempt = resolvePlanner({
        cacheDir: join(work, 'empty-cache'),
        dir: work,
        registry: { registryUrl: 'https://registry.example', fetchImpl },
      });
      await expect(attempt).rejects.toBeInstanceOf(PlannerError);
      await expect(attempt).rejects.toThrow(/--planner <dir>/);
    });
  });
});

describe('the configured model', () => {
  it('is none without any AI configuration', async () => {
    expect(await resolveKitchenAI({ dir: work, env: {} })).toBeNull();
  });

  it('builds the provider the environment names and chats through it', async () => {
    const seen: unknown[] = [];
    const ai = await resolveKitchenAI({
      dir: work,
      env: {
        SMRT_AI_PROVIDER: 'openai',
        SMRT_AI_API_KEY: 'sk-test',
        SMRT_AI_MODEL: 'gpt-test',
      },
      createClient: async (clientOptions) => {
        seen.push(clientOptions);
        return {
          async chat(messages) {
            return { content: `echo:${messages.length}` };
          },
        };
      },
    });
    expect(ai?.label).toBe('openai (gpt-test)');
    expect(ai?.label).not.toContain('sk-test');
    expect(seen[0]).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-test',
      defaultModel: 'gpt-test',
    });
    expect(await ai?.chat([{ role: 'user', content: 'hi' }])).toBe('echo:1');
  });
});

describe('smrt kitchen apply', () => {
  it('is the cookbook apply command under the kitchen name', () => {
    const apply = kitchenCommands['kitchen apply'];
    expect(apply.name).toBe('kitchen apply');
    expect(apply.handler).toBe(cookbookCommands['cookbook apply'].handler);
    expect(Object.keys(apply.options ?? {})).toEqual(
      expect.arrayContaining([
        'template',
        'dry-run',
        'no-install',
        'manifests',
      ]),
    );
    expect(kitchenCommands.kitchen.args).toEqual(['dir']);
  });
});

const REAL_PLANNER = process.env.SMRT_PLANNER_DIR;

describe.skipIf(!REAL_PLANNER)(
  'against a packaged planner (SMRT_PLANNER_DIR)',
  () => {
    it('speaks the real host contract through the real core', async () => {
      const real = inspectPlanner(REAL_PLANNER as string, 'local');
      const core = await loadPlannerCore(real);
      const { ai, calls } = stubAI(
        '{"reply":"Added Sales.","add":["commerce.sales"]}',
      );
      const server = await startKitchenServer({
        planner: real,
        core,
        ai,
        apply: async () => ({ ok: false, status: 500, errors: [] }),
      });
      servers.push(server);
      const origin = `http://127.0.0.1:${server.port}`;
      const snapshot = {
        version: 1,
        revision: 1,
        app: { name: 'my-app', cookbook: null },
        recipes: [],
        features: [],
        unavailable: [],
        settings: { currency: 'USD', taxRate: 0, paymentTerms: '' },
        theme: {
          text: 'smrt',
          preset: null,
          primary: null,
          colorScheme: 'system',
        },
        sections: [],
        focus: { tab: null, section: null },
        policies: 0,
        undo: [],
      };
      const response = await fetch(
        `${origin}/api/planner/chat`,
        json({ version: 1, message: 'I run a bakery', snapshot }, { origin }),
      );
      expect(response.status).toBe(200);
      const reply = await readJson(response);
      expect(reply.reply).toBe('Added Sales.');
      expect(calls[0][0].role).toBe('system');
      expect(calls[0][0].content.length).toBeGreaterThan(500);
      expect(calls[0].at(-1)).toEqual({
        role: 'user',
        content: 'I run a bakery',
      });
      const page = await fetch(`${origin}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toMatch(/<html/i);
    });
  },
);
