import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_HTTP_TOOL_NAMES,
  runtimeHttpTools,
  startRuntimeHttpHost,
} from './http.js';
import { parseHttpCliArgs, TOOLS } from './index.js';
import {
  bootRuntime,
  DECLARED_PROVENANCE,
  getBootedProjectRoot,
  resetRuntimeBootForTests,
} from './tools/runtime/boot.js';
import {
  resetBootPreambleForTests,
  runtimeObject,
  runtimeRegistry,
  runtimeSchemaDiff,
} from './tools/runtime/observation.js';

const ENV_KEYS = ['SMRT_DEV_DB_URL', 'SMRT_DEV_DB_TYPE', 'SMRT_DEV_MCP_TOKEN'];

let projectRoot: string;

function writeProject(root: string): void {
  mkdirSync(join(root, '.smrt'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@acme/app', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, '.smrt', 'manifest.json'),
    JSON.stringify({
      version: '1',
      timestamp: 0,
      moduleType: 'smrt',
      packageName: '@acme/app',
      objects: {
        Article: {
          className: 'Article',
          name: 'article',
          collection: 'articles',
          filePath: join(root, 'src', 'Article.ts'),
          fields: {
            title: { type: 'text', required: true },
            apiKey: { type: 'text', description: 'top secret' },
          },
          methods: {
            publish: {
              name: 'publish',
              async: true,
              parameters: [],
              returnType: 'Promise<void>',
              isStatic: false,
              isPublic: true,
            },
          },
          decoratorConfig: {},
          schema: {
            tableName: 'articles',
            ddl: 'CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, title TEXT NOT NULL, api_key TEXT)',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              title: { type: 'TEXT', notNull: true },
              api_key: { type: 'TEXT' },
            },
            indexes: [],
            version: 'fixture',
          },
        },
      },
    }),
  );
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  ObjectRegistry.clear();
  resetRuntimeBootForTests();
  resetBootPreambleForTests();
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-1831-'));
  writeProject(projectRoot);
});

afterEach(() => {
  ObjectRegistry.clear();
  resetRuntimeBootForTests();
  rmSync(projectRoot, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('confined runtime boot (#1831)', () => {
  it('registers the project manifest without importing project code', async () => {
    const boot = await bootRuntime({ projectRoot });
    expect(boot.provenance).toBe(DECLARED_PROVENANCE);
    expect(boot.projectName).toBe('@acme/app');
    expect(boot.manifests[0]).toMatchObject({
      kind: 'project',
      path: '.smrt/manifest.json',
      objectCount: 1,
    });
    expect(ObjectRegistry.hasClass('Article')).toBe(true);
    expect(JSON.stringify(boot)).not.toContain(projectRoot);
  });

  it('never writes to the project and honours per-object package ownership', async () => {
    // An aggregate manifest carries a dependency object with its own package.
    const manifestPath = join(projectRoot, '.smrt', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.objects.Person = {
      className: 'Person',
      name: 'person',
      collection: 'people',
      packageName: '@acme/people',
      filePath: join(
        projectRoot,
        'node_modules',
        '@acme',
        'people',
        'Person.js',
      ),
      fields: { name: { type: 'text' } },
      methods: {},
      decoratorConfig: {},
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const boot = await bootRuntime({ projectRoot });
    expect(boot.objectCount).toBe(2);
    expect(getBootedProjectRoot()).toBe(projectRoot);
    expect(ObjectRegistry.getClass('Person')?.packageName).toBe('@acme/people');
    expect(ObjectRegistry.getClass('Article')?.packageName).toBe('@acme/app');
    expect(existsSync(join(projectRoot, '.smrt', 'discovery-cache.json'))).toBe(
      false,
    );
  });

  it('boots once per process and reports a missing manifest as a warning', async () => {
    const first = await bootRuntime({ projectRoot });
    const second = await bootRuntime({ projectRoot: '/nowhere' });
    expect(second).toBe(first);
    resetRuntimeBootForTests();
    ObjectRegistry.clear();
    const empty = mkdtempSync(join(tmpdir(), 'smrt-1831-empty-'));
    try {
      const boot = await bootRuntime({ projectRoot: empty });
      expect(boot.objectCount).toBe(0);
      expect(boot.diagnostics.map((d) => d.code)).toContain(
        'project_manifest_missing',
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('observation tools (#1831)', () => {
  it('runtime-registry returns a sanitized booted snapshot', async () => {
    const envelope = await runtimeRegistry({ projectPath: projectRoot });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.provenance).toBe('booted (registry)');
    const snapshot = envelope.data.snapshot as {
      summary: { objectCount: number };
      objects: Array<{ name: string; fields: unknown[]; sourceFile: string }>;
    };
    expect(snapshot.summary.objectCount).toBe(1);
    expect(snapshot.objects[0].name).toBe('Article');
    // summary mode: no field detail unless asked
    expect(snapshot.objects[0].fields).toEqual([]);
    expect(snapshot.objects[0].sourceFile).toBe('src/Article.ts');
    const text = JSON.stringify(envelope);
    expect(text).not.toContain(projectRoot);
    expect(text).not.toContain('top secret');
    expect(text).not.toContain('constructor');
  });

  it('pages runtime-registry objects by cursor and limit', async () => {
    await bootRuntime({ projectRoot });
    for (const name of ['Beta', 'Alpha', 'Gamma']) {
      ObjectRegistry.registerFromManifest(
        name,
        {
          className: name,
          name: name.toLowerCase(),
          collection: `${name.toLowerCase()}s`,
          filePath: join(projectRoot, 'src', `${name}.ts`),
          fields: {},
          methods: {},
          decoratorConfig: {},
        } as never,
        '@acme/app',
      );
    }
    const first = await runtimeRegistry({ projectPath: projectRoot, limit: 2 });
    const page1 = first.data.page as {
      returned: number;
      matched: number;
      nextCursor: string | null;
    };
    expect(page1.matched).toBe(4);
    expect(page1.returned).toBe(2);
    expect(page1.nextCursor).toBe('@acme/app:Article');
    const names = (
      first.data.snapshot as { objects: Array<{ name: string }> }
    ).objects.map((o) => o.name);
    expect(names).toEqual(['Alpha', 'Article']);
    const second = await runtimeRegistry({
      projectPath: projectRoot,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    const page2 = second.data.page as {
      returned: number;
      nextCursor: string | null;
    };
    expect(
      (
        second.data.snapshot as { objects: Array<{ name: string }> }
      ).objects.map((o) => o.name),
    ).toEqual(['Beta', 'Gamma']);
    expect(page2.nextCursor).toBeNull();
    // summary is global regardless of the page
    expect(
      (second.data.snapshot as { summary: { objectCount: number } }).summary
        .objectCount,
    ).toBe(4);
  });

  it('ignores a widened projectPath after boot and never relativizes against it', async () => {
    await runtimeRegistry({ projectPath: projectRoot });
    const spoofed = await runtimeRegistry({
      projectPath: '/',
      objects: ['Article'],
    });
    const snapshot = spoofed.data.snapshot as {
      objects: Array<{ sourceFile: string }>;
    };
    expect(snapshot.objects[0].sourceFile).toBe('src/Article.ts');
    expect(JSON.stringify(spoofed)).not.toContain(projectRoot);
  });

  it('runtime-object refuses an ambiguous simple name', async () => {
    await bootRuntime({ projectRoot });
    ObjectRegistry.registerFromManifest(
      'Article',
      {
        className: 'Article',
        name: 'article',
        collection: 'articles',
        filePath: '/opt/other/Article.js',
        fields: { headline: { type: 'text' } },
        methods: {},
        decoratorConfig: {},
      } as never,
      '@other/news',
    );
    const ambiguous = await runtimeObject({
      projectPath: projectRoot,
      name: 'Article',
    });
    expect(ambiguous.data.object).toBeNull();
    const diagnostic = ambiguous.diagnostics.find(
      (d) => d.code === 'object_ambiguous',
    );
    expect(diagnostic?.message).toContain('@acme/app:Article');
    expect(diagnostic?.message).toContain('@other/news:Article');
    const qualified = await runtimeObject({
      projectPath: projectRoot,
      name: '@acme/app:Article',
    });
    expect(
      (qualified.data.object as { qualifiedName: string }).qualifiedName,
    ).toBe('@acme/app:Article');
  });

  it('emits the manifest list once per process and flags a rebuilt manifest', async () => {
    const first = await runtimeRegistry({ projectPath: projectRoot });
    const second = await runtimeRegistry({ projectPath: projectRoot });
    expect(
      (first.data.boot as { manifests?: unknown[] }).manifests,
    ).toHaveLength(1);
    expect(
      (second.data.boot as { manifests?: unknown[] }).manifests,
    ).toBeUndefined();
    expect((second.data.boot as { manifestCount: number }).manifestCount).toBe(
      1,
    );
    expect(
      second.diagnostics.some((d) => d.code === 'manifest_newer_than_boot'),
    ).toBe(false);
    // A rebuild touches the manifest after boot.
    const manifestPath = join(projectRoot, '.smrt', 'manifest.json');
    const future = new Date(Date.now() + 60_000);
    utimesSync(manifestPath, future, future);
    const third = await runtimeRegistry({ projectPath: projectRoot });
    expect(
      third.diagnostics.some((d) => d.code === 'manifest_newer_than_boot'),
    ).toBe(true);
  });

  it('runtime-object returns detail and generated DDL, or a not-found diagnostic', async () => {
    const found = await runtimeObject({
      projectPath: projectRoot,
      name: 'Article',
    });
    const object = found.data.object as { fields: Array<{ name: string }> };
    expect(object.fields.map((f) => f.name)).toEqual(['apiKey', 'title']);
    expect(String(found.data.ddl)).toMatch(/CREATE TABLE/i);
    const missing = await runtimeObject({
      projectPath: projectRoot,
      name: 'Nope',
    });
    expect(missing.ok).toBe(true);
    expect(missing.data.object).toBeNull();
    expect(missing.diagnostics.map((d) => d.code)).toContain(
      'object_not_found',
    );
  });

  it('runtime-schema-diff degrades to static without a DB and introspects a live one', async () => {
    const offline = await runtimeSchemaDiff({ projectPath: projectRoot });
    expect(offline.ok).toBe(true);
    expect(offline.data.connected).toBe(false);
    expect(offline.data.provenance).toBe('static');

    const dbUrl = `file:${join(projectRoot, 'dev.db')}`;
    const admin = await getDatabase({ type: 'sqlite', url: dbUrl });
    await admin.query('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
    await admin.close?.();
    const live = await runtimeSchemaDiff({ projectPath: projectRoot, dbUrl });
    const why = JSON.stringify({
      diagnostics: live.diagnostics,
      data: live.data,
    });
    expect(live.data.connected, why).toBe(true);
    expect(live.data.provenance, why).toBe('runtime (live DB)');
    // The smrt vitest plugin syncs registered schemas whenever a test opens a
    // connection, so `articles` already exists here and only the orphan is
    // observable. Outside the test harness the same call reports `articles`
    // under `addedTables` (see the PR validation notes); the comparer itself
    // only introspects and never executes DDL.
    expect(live.data.orphanTables, why).toContain('unrelated');
    expect(live.data.droppedTables).toEqual([]);
    expect(Array.isArray(live.data.addedTables)).toBe(true);
    expect(typeof live.data.changeCount).toBe('number');
    expect(live.data.truncated).toBe(false);
    expect(JSON.stringify(live)).not.toContain(projectRoot);
  });
});

describe('runtime HTTP host (#1831)', () => {
  it('exposes exactly the positive read-only catalog', () => {
    const names = runtimeHttpTools().map((t) => t.name);
    expect(names.sort()).toEqual([...RUNTIME_HTTP_TOOL_NAMES].sort());
    for (const name of RUNTIME_HTTP_TOOL_NAMES) {
      expect(
        TOOLS.some((t) => t.name === name),
        name,
      ).toBe(true);
    }
    expect(names).not.toContain('generate-smrt-class');
    expect(names).not.toContain('introspect-project');
  });

  it('parses --http, --port, and --project', () => {
    expect(parseHttpCliArgs([])).toEqual({ http: false });
    expect(
      parseHttpCliArgs(['--http', '--port', '4000', '--project', '/p']),
    ).toEqual({ http: true, port: 4000, projectRoot: '/p' });
    expect(() => parseHttpCliArgs(['--http', '--port', 'x'])).toThrow();
  });

  it('serves the catalog over stateless Streamable HTTP with bearer + localhost guards', async () => {
    const host = await startRuntimeHttpHost({
      projectRoot,
      token: 'dev-secret',
    });
    try {
      expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(host.boot.objectCount).toBe(1);

      const unauthenticated = await fetch(host.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get('www-authenticate')).toContain(
        'Bearer',
      );

      const wrongToken = await fetch(host.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev-secret-but-wrong',
        },
        body: '{}',
      });
      expect(wrongToken.status).toBe(401);

      const badHost = await fetch(host.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev-secret',
          host: 'evil.example',
        },
        body: '{}',
      });
      expect(badHost.status).toBeGreaterThanOrEqual(400);

      const badOrigin = await fetch(host.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev-secret',
          origin: 'https://evil.example',
        },
        body: '{}',
      });
      expect(badOrigin.status).toBeGreaterThanOrEqual(400);

      const client = new Client(
        { name: 'test', version: '0.0.0' },
        {
          capabilities: {},
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        },
      );
      const transport = new StreamableHTTPClientTransport(new URL(host.url), {
        requestInit: { headers: { authorization: 'Bearer dev-secret' } },
      });
      await client.connect(transport);
      try {
        const listed = (await client.listTools()).tools
          .map((t) => t.name)
          .sort();
        expect(listed).toEqual([...RUNTIME_HTTP_TOOL_NAMES].sort());
        const result = await client.callTool({
          name: 'runtime-registry',
          arguments: { projectPath: '/elsewhere', objects: ['Article'] },
        });
        const text = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0].text,
        );
        expect(text.data.snapshot.objects[0].name).toBe('Article');
        // structuredContent is the same envelope, not a re-wrapped one
        expect(
          (result.structuredContent as { data: { snapshot: unknown } }).data
            .snapshot,
        ).toEqual(text.data.snapshot);
        await expect(
          client.callTool({ name: 'generate-smrt-class', arguments: {} }),
        ).rejects.toThrow();
      } finally {
        await client.close();
      }
    } finally {
      await host.close();
    }
  });

  it('uses SMRT_DEV_MCP_TOKEN when supplied and mints one otherwise', async () => {
    process.env.SMRT_DEV_MCP_TOKEN = 'from-env';
    const fromEnv = await startRuntimeHttpHost({ projectRoot });
    try {
      expect(fromEnv.token).toBe('from-env');
    } finally {
      await fromEnv.close();
    }
    delete process.env.SMRT_DEV_MCP_TOKEN;
    const minted = await startRuntimeHttpHost({ projectRoot });
    try {
      expect(minted.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    } finally {
      await minted.close();
    }
  });

  it('refuses non-loopback binds', async () => {
    await expect(
      startRuntimeHttpHost({ projectRoot, host: '0.0.0.0' as never }),
    ).rejects.toThrow(/loopback/);
  });
});
