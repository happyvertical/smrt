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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('resolving the conflict and saving a source regenerates', async () => {
    const lampRoute = apiRoute('watchownlamps');
    const logs = vi.mocked(console.log);
    logs.mockClear();
    // Removing the application file alone does not rescan (documented limit).
    unlinkSync(lampRoute);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(rescans()).toEqual([]);

    writeFileSync(
      join(objectsDir(), 'WatchOwnLamp.ts'),
      modelSource('WatchOwnLamp', ['label', 'color']),
    );
    await vi.waitFor(() => {
      expect(readFileSync(lampRoute, 'utf-8')).toContain(
        '// Auto-generated by @smrt/core vite plugin',
      );
    }, WAIT);
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
