/**
 * The dev-server rescan, driven through a real Vite dev server.
 *
 * Vite's watcher reports absolute paths, while the plugin's include globs are
 * project-relative; and Vite records virtual modules under their resolved
 * `\0` ids. A handler test that passes a relative path and a stub module graph
 * cannot see either, so this test edits, adds and deletes a model file on
 * disk and reads back `.smrt/manifest.json`, the `smrt:web` module served
 * over HTTP, and the same module loaded for SSR.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  nodeRouteFileSystem,
  setRouteFileSystemForTesting,
} from './generated-route-files.js';
import { smrtPlugin } from './index.js';

const WAIT = { timeout: 20_000, interval: 100 };

function modelSource(className: string, fields: string[]): string {
  return `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { include: ['list', 'get'] } })
export class ${className} extends SmrtObject {
${fields.map((field) => `  ${field} = '';`).join('\n')}
}
`;
}

/** The scanner's start and end log lines, in order. */
function scanEvents(calls: unknown[][]): Array<'start' | 'end'> {
  const events: Array<'start' | 'end'> = [];
  for (const [message] of calls) {
    const text = String(message);
    if (text.includes('Using experimental OXC scanner')) events.push('start');
    if (text.includes('OXC scan completed')) events.push('end');
  }
  return events;
}

describe('smrtPlugin dev-server rescans (real Vite dev server)', () => {
  let projectRoot: string;
  let server: ViteDevServer;
  let origin: string;
  const modelsDir = () => join(projectRoot, 'src', 'models');

  function readManifest(): {
    objects: Record<string, { fields?: Record<string, unknown> }>;
  } {
    return JSON.parse(
      readFileSync(join(projectRoot, '.smrt', 'manifest.json'), 'utf-8'),
    );
  }

  async function servedWebModule(): Promise<string> {
    const response = await fetch(`${origin}/@id/__x00__smrt:web`);
    expect(response.status).toBe(200);
    return response.text();
  }

  async function ssrCollectionNames(): Promise<string[]> {
    const mod = (await server.ssrLoadModule(
      '@happyvertical/smrt-virt-web',
    )) as { collectionDefinitions: Record<string, unknown> };
    return Object.keys(mod.collectionDefinitions).sort();
  }

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-watch-dev-'));
    mkdirSync(join(projectRoot, 'src', 'models'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/watch-dev-app',
        version: '0.0.0',
        type: 'module',
      }),
    );
    writeFileSync(
      join(modelsDir(), 'WatchDevNote.ts'),
      modelSource('WatchDevNote', ['title']),
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await createServer({
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
      plugins: [smrtPlugin({ include: ['src/**/*.ts'] })],
    });
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    // Load the virtual module in both environments before any edit, so the
    // test proves the loaded copies are replaced, not merely generated late.
    expect(await servedWebModule()).toContain('watchdevnotes');
    expect(await ssrCollectionNames()).toEqual(['watchdevnotes']);
    // Let the watcher finish its initial crawl before the first edit.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('regenerates the manifest and the served modules when a model is edited', async () => {
    writeFileSync(
      join(modelsDir(), 'WatchDevNote.ts'),
      modelSource('WatchDevNote', ['title', 'editedField']),
    );

    await vi.waitFor(() => {
      expect(
        Object.keys(
          readManifest().objects['@fixture/watch-dev-app:WatchDevNote']
            ?.fields ?? {},
        ),
      ).toContain('editedField');
    }, WAIT);
    await vi.waitFor(async () => {
      expect(await servedWebModule()).toContain('editedField');
    }, WAIT);
    const mod = (await server.ssrLoadModule(
      '@happyvertical/smrt-virt-web',
    )) as {
      collectionDefinitions: Record<
        string,
        { fields: Record<string, unknown> }
      >;
    };
    expect(
      Object.keys(mod.collectionDefinitions.watchdevnotes.fields),
    ).toContain('editedField');
  }, 30_000);

  it('regenerates the manifest and the served modules when a model is added', async () => {
    writeFileSync(
      join(modelsDir(), 'WatchDevInvoice.ts'),
      modelSource('WatchDevInvoice', ['number']),
    );

    await vi.waitFor(() => {
      expect(Object.keys(readManifest().objects)).toContain(
        '@fixture/watch-dev-app:WatchDevInvoice',
      );
    }, WAIT);
    await vi.waitFor(async () => {
      expect(await servedWebModule()).toContain('watchdevinvoices');
    }, WAIT);
    expect(await ssrCollectionNames()).toEqual([
      'watchdevinvoices',
      'watchdevnotes',
    ]);
  }, 30_000);

  it('regenerates the manifest and the served modules when a model is deleted', async () => {
    unlinkSync(join(modelsDir(), 'WatchDevInvoice.ts'));

    await vi.waitFor(() => {
      expect(Object.keys(readManifest().objects)).not.toContain(
        '@fixture/watch-dev-app:WatchDevInvoice',
      );
    }, WAIT);
    await vi.waitFor(async () => {
      expect(await servedWebModule()).not.toContain('watchdevinvoices');
    }, WAIT);
    expect(await ssrCollectionNames()).toEqual(['watchdevnotes']);
  }, 30_000);

  it('runs one rescan at a time for a burst of edits and ends on the latest sources', async () => {
    const logs = vi.mocked(console.log);
    logs.mockClear();
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
    for (const name of names) {
      writeFileSync(
        join(modelsDir(), `WatchDevBurst${name}.ts`),
        modelSource(`WatchDevBurst${name}`, ['label']),
      );
    }

    await vi.waitFor(() => {
      const keys = Object.keys(readManifest().objects);
      for (const name of names) {
        expect(keys).toContain(`@fixture/watch-dev-app:WatchDevBurst${name}`);
      }
    }, WAIT);
    // Let any queued rescan finish before reading the log.
    await vi.waitFor(() => {
      const events = scanEvents(logs.mock.calls);
      expect(events.at(-1)).toBe('end');
    }, WAIT);

    const events = scanEvents(logs.mock.calls);
    expect(events.length).toBeGreaterThan(0);
    // Starts and ends strictly alternate: no scan began while another ran.
    events.forEach((event, index) => {
      expect(event).toBe(index % 2 === 0 ? 'start' : 'end');
    });

    for (const name of names) {
      unlinkSync(join(modelsDir(), `WatchDevBurst${name}.ts`));
    }
    await vi.waitFor(() => {
      expect(
        Object.keys(readManifest().objects).filter((key) =>
          key.includes('WatchDevBurst'),
        ),
      ).toEqual([]);
    }, WAIT);
  }, 60_000);

  it('ignores changes to files outside the include globs', async () => {
    const before = readFileSync(
      join(projectRoot, '.smrt', 'manifest.json'),
      'utf-8',
    );
    const logs = vi.mocked(console.log);
    logs.mockClear();
    writeFileSync(join(projectRoot, 'notes.md'), '# not a source file\n');

    // Give the watcher time to report the event before checking it was ignored.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      logs.mock.calls.some(([message]) =>
        String(message).includes('Rescanning'),
      ),
    ).toBe(false);
    expect(
      readFileSync(join(projectRoot, '.smrt', 'manifest.json'), 'utf-8'),
    ).toBe(before);
  });
});

describe('smrtPlugin dev-server rescans with SvelteKit route generation', () => {
  let projectRoot: string;
  let server: ViteDevServer;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-watch-routes-'));
    mkdirSync(join(projectRoot, 'src', 'lib', 'objects'), { recursive: true });
    mkdirSync(join(projectRoot, 'src', 'lib', 'server'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/watch-routes-app',
        version: '0.0.0',
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'lib', 'objects', 'WatchRouteNote.ts'),
      modelSource('WatchRouteNote', ['title']),
    );
    // The knowledge route is generated outside routesDir.
    writeFileSync(
      join(projectRoot, 'smrt.config.json'),
      JSON.stringify({ knowledge: { api: { enabled: true } } }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await createServer({
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
      // The broad default-style glob covers the generated route files,
      // smrt-register.ts and src/types/virtual-modules.d.ts.
      plugins: [
        smrtPlugin({
          include: ['src/**/*.ts'],
          svelteKit: {
            enabled: true,
            routesDir: 'src/routes/api',
            objectsDir: 'src/lib/objects',
          },
        }),
      ],
    });
    await server.listen();
    // Let the watcher finish its initial crawl before the first edit.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rescans once per edit, not again for the files the rescan itself writes', async () => {
    const logs = vi.mocked(console.log);
    logs.mockClear();
    writeFileSync(
      join(projectRoot, 'src', 'lib', 'objects', 'WatchRouteNote.ts'),
      modelSource('WatchRouteNote', ['title', 'body']),
    );

    await vi.waitFor(() => {
      const source = readFileSync(
        join(
          projectRoot,
          'src',
          'routes',
          'api',
          'watchroutenotes',
          '+server.ts',
        ),
        'utf-8',
      );
      expect(source.length).toBeGreaterThan(0);
      expect(
        logs.mock.calls.filter(([message]) =>
          String(message).includes('Rescanning'),
        ),
      ).toHaveLength(1);
    }, WAIT);
    // The rescan rewrote route files, smrt-register.ts and the type
    // declarations; give the watcher time to report them.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const rescans = logs.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('Rescanning'));
    expect(rescans).toHaveLength(1);
    expect(rescans[0]).toContain('WatchRouteNote.ts');
  }, 30_000);

  it('does not rescan when the knowledge route outside routesDir is cleared and rewritten', async () => {
    const knowledgeRoute = join(
      projectRoot,
      'src',
      'routes',
      '__smrt',
      'knowledge',
      '+server.ts',
    );
    await vi.waitFor(() => {
      expect(readFileSync(knowledgeRoute, 'utf-8').length).toBeGreaterThan(0);
    }, WAIT);
    const content = readFileSync(knowledgeRoute, 'utf-8');
    const logs = vi.mocked(console.log);
    logs.mockClear();

    // What generation does: unlink, then write the file again later.
    unlinkSync(knowledgeRoute);
    await new Promise((resolve) => setTimeout(resolve, 800));
    writeFileSync(knowledgeRoute, content);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(
      logs.mock.calls.filter(([message]) =>
        String(message).includes('Rescanning'),
      ),
    ).toEqual([]);
  }, 30_000);
});

describe('smrtPlugin dev-server rescans and application route files', () => {
  let projectRoot: string;
  let server: ViteDevServer;
  let origin: string;
  const APPLICATION_HANDLER =
    "export const GET = () => new Response('application handler');\n";
  const objectsDir = () => join(projectRoot, 'src', 'lib', 'objects');
  const apiRoute = (...segments: string[]) =>
    join(projectRoot, 'src', 'routes', 'api', ...segments, '+server.ts');
  const rescans = () =>
    vi
      .mocked(console.log)
      .mock.calls.map(([message]) => String(message))
      .filter((message) => message.includes('Rescanning'));

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-watch-ownership-'));
    mkdirSync(objectsDir(), { recursive: true });
    mkdirSync(join(projectRoot, 'src', 'lib', 'server'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/watch-ownership-app',
        version: '0.0.0',
        type: 'module',
      }),
    );
    writeFileSync(
      join(objectsDir(), 'WatchOwnNote.ts'),
      modelSource('WatchOwnNote', ['title']),
    );
    // A hand-written handler at the path a model added later will claim.
    mkdirSync(join(projectRoot, 'src', 'routes', 'api', 'watchownlamps'), {
      recursive: true,
    });
    writeFileSync(apiRoute('watchownlamps'), APPLICATION_HANDLER);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await createServer({
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        smrtPlugin({
          include: ['src/**/*.ts'],
          svelteKit: {
            enabled: true,
            routesDir: 'src/routes/api',
            objectsDir: 'src/lib/objects',
          },
        }),
      ],
    });
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('the watcher does not rescan on its own route writes or removals', async () => {
    const logs = vi.mocked(console.log);
    logs.mockClear();
    const header = '// Auto-generated by @smrt/core vite plugin';
    const obsolete = apiRoute('watchownobsolete');
    mkdirSync(join(obsolete, '..'), { recursive: true });
    writeFileSync(obsolete, `﻿${header}\n// generated\n`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    unlinkSync(obsolete);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(rescans()).toEqual([]);

    // Negative control: a source edit rescans once.
    writeFileSync(
      join(objectsDir(), 'WatchOwnNote.ts'),
      modelSource('WatchOwnNote', ['title', 'body']),
    );
    await vi.waitFor(() => {
      expect(rescans()).toHaveLength(1);
    }, WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(rescans()).toHaveLength(1);
  }, 30_000);

  it('a refused dev rescan keeps its route files and the server keeps answering', async () => {
    const noteRoute = apiRoute('watchownnotes');
    // Let the previous test's rescan settle before reading the baseline.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const noteBytes = readFileSync(noteRoute, 'utf-8');
    const errors = vi.mocked(console.error);
    errors.mockClear();

    writeFileSync(
      join(objectsDir(), 'WatchOwnLamp.ts'),
      modelSource('WatchOwnLamp', ['label']),
    );

    await vi.waitFor(() => {
      expect(
        errors.mock.calls.some(
          ([message, error]) =>
            String(message).includes('Failed to rescan') &&
            String((error as Error)?.message).includes(
              apiRoute('watchownlamps'),
            ),
        ),
      ).toBe(true);
    }, WAIT);
    expect(readFileSync(apiRoute('watchownlamps'), 'utf-8')).toBe(
      APPLICATION_HANDLER,
    );
    expect(readFileSync(noteRoute, 'utf-8')).toBe(noteBytes);
    const response = await fetch(`${origin}/@id/__x00__smrt:web`);
    expect(response.status).toBe(200);
  }, 30_000);

  it('a refused rescan retries once when the route tree changes', async () => {
    const lampRoute = apiRoute('watchownlamps');
    const logs = vi.mocked(console.log);
    logs.mockClear();
    // Removing the application file the refusal named retries the rescan.
    unlinkSync(lampRoute);
    await vi.waitFor(() => {
      expect(readFileSync(lampRoute, 'utf-8')).toContain(
        '// Auto-generated by @smrt/core vite plugin',
      );
    }, WAIT);
    // The accepted retry's own route writes are not admitted: one rescan.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(rescans()).toHaveLength(1);
    expect(rescans()[0]).toContain(lampRoute);
  }, 30_000);
});

describe('smrtPlugin dev-server watcher and executable project config', () => {
  let projectRoot: string;
  let counterDir: string;
  let server: ViteDevServer;
  const evaluations = () =>
    readFileSync(join(counterDir, 'config-evaluations.log'), 'utf-8')
      .split('\n')
      .filter(Boolean).length;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-watch-config-'));
    counterDir = mkdtempSync(join(tmpdir(), 'smrt-watch-config-counter-'));
    writeFileSync(join(counterDir, 'config-evaluations.log'), '');
    mkdirSync(join(projectRoot, 'src', 'lib', 'objects'), { recursive: true });
    mkdirSync(join(projectRoot, 'src', 'lib', 'server'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/watch-config-app',
        version: '0.0.0',
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'lib', 'objects', 'WatchConfigNote.ts'),
      modelSource('WatchConfigNote', ['title']),
    );
    // Executable config with an observable side effect on every evaluation.
    writeFileSync(
      join(projectRoot, 'smrt.config.ts'),
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(counterDir, 'config-evaluations.log'))}, 'x\\n');
export default { knowledge: { api: { enabled: true } } };
`,
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await createServer({
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        smrtPlugin({
          include: ['src/**/*.ts'],
          svelteKit: {
            enabled: true,
            routesDir: 'src/routes/api',
            objectsDir: 'src/lib/objects',
          },
        }),
      ],
    });
    await server.listen();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    if (counterDir) rmSync(counterDir, { recursive: true, force: true });
  });

  it('does not evaluate the project config for an excluded file event', async () => {
    expect(evaluations()).toBeGreaterThan(0);
    const before = evaluations();

    // Matches the include glob but the default exclude (`**/*.test.ts`).
    writeFileSync(
      join(projectRoot, 'src', 'lib', 'objects', 'ignored.test.ts'),
      'export {};\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    writeFileSync(join(projectRoot, 'notes.md'), '# not a source\n');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(evaluations()).toBe(before);
  }, 30_000);
});

describe('smrtPlugin dev-server rescans publish only accepted generations (#5462)', () => {
  let projectRoot: string;
  let server: ViteDevServer;
  let plugin: ReturnType<typeof smrtPlugin>;
  let reloads = 0;
  const APPLICATION_HANDLER =
    "export const GET = () => new Response('application handler');\n";
  const objectsDir = () => join(projectRoot, 'src', 'lib', 'objects');
  const smrtFile = (name: string) => join(projectRoot, '.smrt', name);
  const apiRoute = (...segments: string[]) =>
    join(projectRoot, 'src', 'routes', 'api', ...segments, '+server.ts');
  const knowledgeRoute = () =>
    join(projectRoot, 'src', 'routes', '__smrt', 'knowledge', '+server.ts');
  const intentSource = (id: string) =>
    `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const notes = defineIntent({
  id: '${id}',
  description: 'Dev publication fixture intent',
  target: { registry: 'dataSurface', controlId: 'notes', kind: 'table' },
});
`;
  const rescans = () =>
    vi
      .mocked(console.log)
      .mock.calls.map(([message]) => String(message))
      .filter((message) => message.includes('Rescanning'));
  const failures = () =>
    vi
      .mocked(console.error)
      .mock.calls.filter(([message]) =>
        String(message).includes('Failed to rescan'),
      );

  function knowledgeModuleId(): string {
    const id = /from "(smrt:knowledge-artifact\/[0-9a-f]+)"/.exec(
      readFileSync(knowledgeRoute(), 'utf-8'),
    )?.[1];
    if (!id) throw new Error('managed knowledge route has no module import');
    return id;
  }

  async function servedKnowledge(): Promise<unknown> {
    const mod = (await server.ssrLoadModule(knowledgeModuleId())) as {
      default: unknown;
    };
    return mod.default;
  }

  /** Every published output a refused rescan must leave alone. */
  async function published() {
    const read = (path: string) =>
      existsSync(path) ? readFileSync(path, 'utf-8') : null;
    const mod = (await server.ssrLoadModule(
      '@happyvertical/smrt-virt-manifest',
    )) as Record<string, unknown>;
    return {
      servedManifest: JSON.stringify(mod),
      manifest: read(smrtFile('manifest.json')),
      buildSchema: read(smrtFile('build-schema.js')),
      knowledge: read(smrtFile('smrt-knowledge.json')),
      declarations: read(
        join(projectRoot, 'src', 'types', 'virtual-modules.d.ts'),
      ),
      surface: JSON.stringify(await plugin.api.resolveKnowledgeAgentSurface()),
    };
  }

  /** Wait until the rescan the last edit caused has failed. */
  async function refusal(file: string) {
    await vi.waitFor(() => {
      expect(
        failures().some(([, error]) =>
          String((error as Error)?.message).includes(file),
        ),
      ).toBe(true);
    }, WAIT);
    // Let any (wrong) publication land before comparing.
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-watch-staged-'));
    mkdirSync(objectsDir(), { recursive: true });
    mkdirSync(join(projectRoot, 'src', 'lib', 'server'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/watch-staged-app',
        version: '0.0.0',
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'smrt.config.json'),
      JSON.stringify({ knowledge: { api: { enabled: true } } }),
    );
    writeFileSync(
      join(objectsDir(), 'StagedNote.ts'),
      modelSource('StagedNote', ['title']),
    );
    writeFileSync(
      join(projectRoot, 'src', 'intents.ts'),
      intentSource('notes.first'),
    );
    // Hand-written handlers at paths that models added later will claim.
    for (const collection of ['stagedlamps', 'stagedbulbs']) {
      mkdirSync(join(projectRoot, 'src', 'routes', 'api', collection), {
        recursive: true,
      });
      writeFileSync(apiRoute(collection), APPLICATION_HANDLER);
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      },
    });
    server = await createServer({
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
      plugins: [plugin],
    });
    await server.listen();
    for (const environment of Object.values(server.environments)) {
      const send = environment.hot.send.bind(environment.hot);
      environment.hot.send = ((...args: Parameters<typeof send>) => {
        const [payload] = args;
        if ((payload as { type?: string })?.type === 'full-reload') reloads++;
        return send(...args);
      }) as typeof send;
    }
    // Load the modules once so a publication has something to invalidate.
    await published();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60_000);

  afterAll(async () => {
    // Optional: the regression run executes this file without the seam.
    setRouteFileSystemForTesting?.(undefined);
    await server?.close();
    vi.restoreAllMocks();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a refused rescan publishes nothing', async () => {
    const before = await published();
    reloads = 0;
    writeFileSync(
      join(objectsDir(), 'StagedLamp.ts'),
      modelSource('StagedLamp', ['label']),
    );
    await refusal(apiRoute('stagedlamps'));
    expect(await published()).toEqual(before);
    expect(reloads).toBe(0);

    // Negative control: without the application file the same edit
    // publishes everything (the refusal retries on the route-tree change).
    unlinkSync(apiRoute('stagedlamps'));
    await vi.waitFor(() => {
      expect(readFileSync(smrtFile('manifest.json'), 'utf-8')).toContain(
        'StagedLamp',
      );
    }, WAIT);
    await vi.waitFor(async () => {
      const after = await published();
      expect(after.declarations).toContain('StagedLamp');
      expect(after.buildSchema).not.toBe(before.buildSchema);
      expect(after.servedManifest).toContain('StagedLamp');
    }, WAIT);
    expect(reloads).toBeGreaterThan(0);
  }, 60_000);

  it('a duplicate custom route refused by validation publishes nothing', async () => {
    const before = await published();
    vi.mocked(console.error).mockClear();
    writeFileSync(
      join(objectsDir(), 'StagedNote.ts'),
      `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: {
    routes: {
      archive: { method: 'POST', path: 'close' },
      dismiss: { method: 'POST', path: 'close' },
    },
  },
})
export class StagedNote extends SmrtObject {
  title = '';
  async archive(): Promise<boolean> {
    return true;
  }
  async dismiss(): Promise<boolean> {
    return true;
  }
}
`,
    );
    await vi.waitFor(() => expect(failures().length).toBeGreaterThan(0), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await published()).toEqual(before);
    writeFileSync(
      join(objectsDir(), 'StagedNote.ts'),
      modelSource('StagedNote', ['title']),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 60_000);

  it('the agent surface is published with its scan, or not at all', async () => {
    vi.mocked(console.error).mockClear();
    expect(JSON.stringify(await servedKnowledge())).toContain('notes.first');
    // Refused: the intent changes in the same edit that collides a route.
    writeFileSync(
      join(projectRoot, 'src', 'intents.ts'),
      intentSource('notes.second'),
    );
    writeFileSync(
      join(objectsDir(), 'StagedBulb.ts'),
      modelSource('StagedBulb', ['label']),
    );
    await refusal(apiRoute('stagedbulbs'));
    expect(
      JSON.stringify(await plugin.api.resolveKnowledgeAgentSurface()),
    ).toContain('notes.first');
    expect(readFileSync(smrtFile('smrt-knowledge.json'), 'utf-8')).toContain(
      'notes.first',
    );
    expect(JSON.stringify(await servedKnowledge())).toContain('notes.first');
    expect(JSON.stringify(await servedKnowledge())).not.toContain(
      'notes.second',
    );

    // Accepted: removing the collision publishes the new intent everywhere.
    unlinkSync(apiRoute('stagedbulbs'));
    await vi.waitFor(async () => {
      expect(
        JSON.stringify(await plugin.api.resolveKnowledgeAgentSurface()),
      ).toContain('notes.second');
      expect(readFileSync(smrtFile('smrt-knowledge.json'), 'utf-8')).toContain(
        'notes.second',
      );
      expect(JSON.stringify(await servedKnowledge())).toContain('notes.second');
    }, WAIT);
  }, 60_000);

  it('surface readers get the last published surface after a refused rescan', async () => {
    const before = await plugin.api.resolveKnowledgeAgentSurface();
    vi.mocked(console.error).mockClear();
    // A scan error: the rescan fails before anything is prepared.
    writeFileSync(
      join(objectsDir(), 'Broken.ts'),
      "import { smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class Broken extends {\n",
    );
    const readers: Array<Promise<unknown>> = [];
    await vi.waitFor(() => {
      readers.push(plugin.api.resolveKnowledgeAgentSurface());
      expect(failures().length).toBeGreaterThan(0);
    }, WAIT);
    for (const reader of readers) await expect(reader).resolves.toEqual(before);
    unlinkSync(join(objectsDir(), 'Broken.ts'));
    writeFileSync(
      join(projectRoot, 'src', 'intents.ts'),
      intentSource('notes.third'),
    );
    await vi.waitFor(async () => {
      expect(
        JSON.stringify(await plugin.api.resolveKnowledgeAgentSurface()),
      ).toContain('notes.third');
    }, WAIT);
  }, 60_000);

  it('a commit-phase refusal during a rescan publishes and reloads', async () => {
    vi.mocked(console.error).mockClear();
    const kite = apiRoute('stagedkites');
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      openSync: (path, flag) => {
        // Another writer creates an application file just before the
        // exclusive create.
        if (path === kite && flag === 'wx') {
          mkdirSync(join(kite, '..'), { recursive: true });
          writeFileSync(kite, APPLICATION_HANDLER);
        }
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    reloads = 0;
    try {
      writeFileSync(
        join(objectsDir(), 'StagedKite.ts'),
        modelSource('StagedKite', ['label']),
      );
      await vi.waitFor(() => {
        expect(
          failures().some(
            ([, error]) => (error as { phase?: string })?.phase === 'commit',
          ),
        ).toBe(true);
      }, WAIT);
    } finally {
      setRouteFileSystemForTesting(undefined);
    }
    await vi.waitFor(() => {
      expect(
        readFileSync(
          join(projectRoot, 'src', 'types', 'virtual-modules.d.ts'),
          'utf-8',
        ),
      ).toContain('StagedKite');
      expect(readFileSync(smrtFile('manifest.json'), 'utf-8')).toContain(
        'StagedKite',
      );
    }, WAIT);
    expect(reloads).toBeGreaterThan(0);
    const commitError = failures()
      .map(([, error]) => error as { phase?: string; written?: string[] })
      .find((error) => error?.phase === 'commit');
    for (const written of commitError?.written ?? []) {
      expect(existsSync(written)).toBe(true);
    }
    expect(readFileSync(kite, 'utf-8')).toBe(APPLICATION_HANDLER);

    // The changed-and-thrown run retries when the file its error named
    // changes: removing it regenerates everything.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    vi.mocked(console.log).mockClear();
    unlinkSync(kite);
    await vi.waitFor(() => {
      expect(rescans().some((message) => message.includes(kite))).toBe(true);
      expect(existsSync(knowledgeRoute())).toBe(true);
      expect(existsSync(apiRoute('stagednotes'))).toBe(true);
      expect(readFileSync(kite, 'utf-8')).toContain(
        '// Auto-generated by @smrt/core vite plugin',
      );
    }, WAIT);
    unlinkSync(join(objectsDir(), 'StagedKite.ts'));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 60_000);

  it('the knowledge module serves the selected artifact', async () => {
    const artifact = smrtFile('smrt-knowledge.json');
    const dist = join(projectRoot, 'dist', 'smrt-knowledge.json');
    mkdirSync(join(projectRoot, 'dist'), { recursive: true });
    const published = JSON.parse(readFileSync(artifact, 'utf-8'));
    // (a) Both valid: .smrt wins.
    writeFileSync(dist, JSON.stringify({ marker: 'dist-artifact' }));
    await vi.waitFor(async () => {
      expect(await servedKnowledge()).toEqual(published);
    }, WAIT);
    // (b) A malformed dist beside a valid .smrt is ignored.
    writeFileSync(dist, '{ not json');
    await vi.waitFor(async () => {
      expect(await servedKnowledge()).toEqual(published);
    }, WAIT);
    // (c) A malformed .smrt is served as absent (the route answers 404).
    writeFileSync(artifact, '{ not json');
    await vi.waitFor(async () => {
      expect(await servedKnowledge()).toBeNull();
    }, WAIT);
    // (d) None, then created by an atomic rename: served without a route
    // rewrite.
    rmSync(dist);
    rmSync(artifact);
    const routeBytes = readFileSync(knowledgeRoute(), 'utf-8');
    await vi.waitFor(async () => {
      expect(await servedKnowledge()).toBeNull();
    }, WAIT);
    const staged = `${artifact}.tmp`;
    writeFileSync(staged, JSON.stringify({ marker: 'renamed-artifact' }));
    renameSync(staged, artifact);
    await vi.waitFor(async () => {
      expect(await servedKnowledge()).toEqual({ marker: 'renamed-artifact' });
    }, WAIT);
    expect(readFileSync(knowledgeRoute(), 'utf-8')).toBe(routeBytes);
  }, 60_000);
});
