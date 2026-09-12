import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { OxcScanner } from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtPlugin } from '../vite-plugin/index.js';
import {
  type ArtifactFilesystem,
  publishArtifactFiles,
} from './artifact-publication.js';
import { smrtConsumer } from './index';

function manifestHash(manifest: unknown): string {
  const { timestamp: _timestamp, ...withoutTimestamp } = manifest as Record<
    string,
    unknown
  >;
  return createHash('sha256')
    .update(JSON.stringify(sortJson(withoutTimestamp), null, 2))
    .digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

describe('smrtConsumer registration generation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(import.meta.dirname, `__test-consumer-${Date.now()}`);

    mkdirSync(join(tmpDir, 'node_modules', '@test', 'pkg', 'dist'), {
      recursive: true,
    });

    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'consumer-app',
        version: '1.0.0',
      }),
    );

    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        version: '1.2.3',
        exports: {
          '.': './dist/index.js',
        },
      }),
    );

    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/pkg',
        objects: {
          ExternalThing: {
            className: 'ExternalThing',
            collection: 'externalthings',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          ExternalThingCollection: {
            className: 'ExternalThingCollection',
            exportName: 'ExternalThingCollection',
            collection: 'externalthings',
            extends: 'SmrtCollection',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          LegacyThingCollection: {
            className: 'LegacyThingCollection',
            exportName: 'LegacyThingCollection',
            collection: 'legacythings',
            extendsTypeArg: 'ExternalThing',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          SpecializedThingCollection: {
            className: 'SpecializedThingCollection',
            exportName: 'SpecializedThingCollection',
            collection: 'specializedthings',
            extends: 'ExternalThingCollection',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves optional native provider binaries to the Node runtime', async () => {
    const plugin = smrtConsumer({ projectRoot: tmpDir });
    const config = await plugin.config?.call({} as any, {} as any, {
      command: 'build',
      mode: 'production',
    });
    const external = (config as any).build.rollupOptions.external as RegExp[];
    expect(external).toHaveLength(1);
    expect(external[0].test('/tmp/provider/native-addon.node')).toBe(true);
    expect(external[0].test('/tmp/provider/index.js')).toBe(false);
  });

  it('should write explicit package names into .smrt/register.js', async () => {
    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await plugin.buildStart?.call({} as any);

    const registerPath = join(tmpDir, '.smrt', 'register.js');
    expect(existsSync(registerPath)).toBe(true);

    const content = readFileSync(registerPath, 'utf-8');
    expect(content).toContain(
      "import * as __smrt_provider_0 from '@test/pkg';",
    );
    expect(content).toContain(
      'const __smrt_consumer_0 = getSmrtExport(__smrt_provider_0, "ExternalThing");',
    );
    expect(content).toContain(
      'if (__smrt_consumer_0) ObjectRegistry.register(__smrt_consumer_0, { name: "ExternalThing", packageName: "@test/pkg", _manifest: smrtRegistrationManifests["ExternalThing"], _manifestKey: "ExternalThing" });',
    );
    expect(content).toContain(
      "console.log('[smrt:register] Registered 1 external object');",
    );
    expect(content).not.toContain('ObjectRegistry.register(__smrt_consumer_1');
    expect(content).not.toContain('ObjectRegistry.register(__smrt_consumer_2');
    expect(content).not.toContain('ObjectRegistry.register(__smrt_consumer_3');

    const manifestLiteral = content.match(
      /const smrtRegistrationManifests = JSON\.parse\((.+)\);/,
    )?.[1];
    expect(manifestLiteral).toBeDefined();
    const registrationManifests = JSON.parse(
      JSON.parse(manifestLiteral as string),
    );
    expect(registrationManifests.ExternalThing).toMatchObject({
      packageName: '@test/pkg',
      objects: {
        ExternalThing: {
          className: 'ExternalThing',
          packageName: '@test/pkg',
        },
      },
    });
  });

  it('aliases same-name exports and isolates their registration manifests', async () => {
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/pkg',
        objects: {
          '@test/pkg:SharedThing': {
            className: 'SharedThing',
            qualifiedName: '@test/pkg:SharedThing',
            collection: 'pkg_shared_things',
            fields: { alpha: { type: 'string' } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    mkdirSync(join(tmpDir, 'node_modules', '@test', 'other', 'dist'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'other', 'package.json'),
      JSON.stringify({
        name: '@test/other',
        version: '4.5.6',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'other', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/other',
        objects: {
          '@test/other:SharedThing': {
            className: 'SharedThing',
            qualifiedName: '@test/other:SharedThing',
            collection: 'other_shared_things',
            fields: { beta: { type: 'number' } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg', '@test/other'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    await plugin.buildStart?.call({} as any);

    const content = readFileSync(join(tmpDir, '.smrt', 'register.js'), 'utf-8');
    expect(content).toContain(
      "import * as __smrt_provider_1 from '@test/pkg';",
    );
    expect(content).toContain(
      "import * as __smrt_provider_0 from '@test/other';",
    );
    expect(content).toContain(
      'const __smrt_consumer_0 = getSmrtExport(__smrt_provider_1, "SharedThing");',
    );
    expect(content).toContain(
      'const __smrt_consumer_1 = getSmrtExport(__smrt_provider_0, "SharedThing");',
    );
    expect(content).toContain(
      'if (__smrt_consumer_0) ObjectRegistry.register(__smrt_consumer_0, { name: "SharedThing", packageName: "@test/pkg", _manifest: smrtRegistrationManifests["@test/pkg:SharedThing"], _manifestKey: "@test/pkg:SharedThing" });',
    );
    expect(content).toContain(
      'if (__smrt_consumer_1) ObjectRegistry.register(__smrt_consumer_1, { name: "SharedThing", packageName: "@test/other", _manifest: smrtRegistrationManifests["@test/other:SharedThing"], _manifestKey: "@test/other:SharedThing" });',
    );

    const manifestLiteral = content.match(
      /const smrtRegistrationManifests = JSON\.parse\((.+)\);/,
    )?.[1];
    const registrationManifests = JSON.parse(
      JSON.parse(manifestLiteral as string),
    );
    expect(
      registrationManifests['@test/pkg:SharedThing'].objects[
        '@test/pkg:SharedThing'
      ].fields,
    ).toEqual({ alpha: { type: 'string' } });
    expect(
      registrationManifests['@test/other:SharedThing'].objects[
        '@test/other:SharedThing'
      ].fields,
    ).toEqual({ beta: { type: 'number' } });
  });

  it('preserves local project entries already in .smrt/manifest.json (issue #1760 review)', async () => {
    // smrtPlugin() writes the project's own scanned objects to
    // .smrt/manifest.json; both plugins write in parallel buildStart hooks,
    // so the consumer's aggregated write must merge, not clobber — otherwise
    // local field metadata vanishes and server writes drop domain columns.
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    writeFileSync(
      join(smrtDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        timestamp: 1,
        packageName: 'consumer-app',
        objects: {
          'consumer-app:Item': {
            className: 'Item',
            qualifiedName: 'consumer-app:Item',
            packageName: 'consumer-app',
            collection: 'items',
            fields: { title: { type: 'text' } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await plugin.buildStart?.call({} as any);

    const merged = JSON.parse(
      readFileSync(join(smrtDir, 'manifest.json'), 'utf-8'),
    );

    // Local entry survives with its field metadata intact.
    expect(merged.objects['consumer-app:Item']).toBeDefined();
    expect(merged.objects['consumer-app:Item'].fields.title.type).toBe('text');
    // Aggregated external entries are added alongside it.
    expect(merged.objects.ExternalThing).toBeDefined();
    // The local project's packageName remains the manifest cache key.
    expect(merged.packageName).toBe('consumer-app');

    const knowledge = JSON.parse(
      readFileSync(join(smrtDir, 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge.sourceHashes.manifest).toBe(manifestHash(merged));
    expect(knowledge.objects).toContainEqual(
      expect.objectContaining({ name: 'ExternalThing' }),
    );
  });

  it('uses inline producer knowledge options when refreshing consumer knowledge', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: {
          includeDocs: true,
          includePrompts: true,
          tags: ['file-tag'],
          summary: 'file summary',
          risks: ['file risk'],
        },
        packages: {
          'consumer-app': { knowledge: { tags: ['package-tag'] } },
        },
      }),
    );
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Consumer instructions');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src', 'prompt.ts'),
      "definePrompt('consumer-prompt', {});",
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
      knowledge: {
        includeDocs: false,
        includePrompts: false,
        tags: ['inline-tag'],
        summary: 'inline summary',
        risks: ['inline risk'],
      },
    });
    const resolvedConfig = {
      root: tmpDir,
      build: {},
      plugins: [producer, consumer],
    };
    await producer.configResolved?.call(producer, resolvedConfig as any);
    await consumer.configResolved?.call(consumer, resolvedConfig as any);

    await consumer.buildStart?.call({} as any);

    const knowledge = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge).toMatchObject({
      tags: ['inline-tag'],
      summary: 'inline summary',
      risks: ['inline risk'],
      prompts: [],
    });
    expect(knowledge.agentDoc).toBeUndefined();
  });

  it('does not regenerate knowledge when inline producer options disable it', async () => {
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
      knowledge: { enabled: false },
    });
    const resolvedConfig = {
      root: tmpDir,
      build: {},
      plugins: [producer, consumer],
    };
    await producer.configResolved?.call(producer, resolvedConfig as any);
    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    writeFileSync(knowledgePath, '{"previous":"artifact"}');
    await consumer.configResolved?.call(consumer, resolvedConfig as any);

    await consumer.buildStart?.call({} as any);

    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"artifact"}',
    );
  });

  it('uses the current producer scan after an intent changes at the same path', async () => {
    const sourcePath = join(tmpDir, 'src', 'orders.intents.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      sourcePath,
      `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const orders = defineIntent({
  id: 'orders.previous',
  description: 'Previous declaration',
  target: { registry: 'dataSurface', controlId: 'orders', kind: 'table' },
});`,
    );
    const objectPath = join(tmpDir, 'src', 'order.ts');
    writeFileSync(
      objectPath,
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
export class PreviousOrder extends SmrtObject {
  status = '';
}`,
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    const resolvedConfig = {
      root: tmpDir,
      build: {},
      plugins: [producer, consumer],
    };
    await producer.configResolved?.call(producer, resolvedConfig as any);
    await consumer.configResolved?.call(consumer, resolvedConfig as any);
    // The first buildStart reuses configResolved's scan. The next one is the
    // watch-style refresh that can run in parallel with the consumer.
    await producer.buildStart?.call(producer);

    writeFileSync(
      sourcePath,
      `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const orders = defineIntent({
  id: 'orders.current',
  description: 'Current declaration',
  target: { registry: 'dataSurface', controlId: 'orders', kind: 'table' },
});`,
    );
    writeFileSync(
      objectPath,
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
export class CurrentOrder extends SmrtObject {
  status = '';
}`,
    );
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const originalScan = OxcScanner.prototype.scanAndResolve;
    const delayedScan = vi
      .spyOn(OxcScanner.prototype, 'scanAndResolve')
      .mockImplementation(async function (...args) {
        await scanGate;
        return originalScan.apply(this, args);
      });
    try {
      const producerRefresh = producer.buildStart?.call(producer);
      // Give the producer hook its synchronous turn to register its in-flight
      // scan, then start the consumer while that scan remains blocked.
      await Promise.resolve();
      let consumerComplete = false;
      const consumerRefresh = consumer.buildStart?.call(consumer).then(() => {
        consumerComplete = true;
      });
      await Promise.resolve();
      expect(consumerComplete).toBe(false);
      releaseScan?.();
      await Promise.all([producerRefresh, consumerRefresh]);
    } finally {
      delayedScan.mockRestore();
      releaseScan?.();
    }

    const knowledge = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge.agentSurface.intents).toEqual([
      expect.objectContaining({
        id: 'orders.current',
        description: 'Current declaration',
        sourceFile: 'src/orders.intents.ts',
      }),
    ]);
    expect(
      knowledge.sourceHashes['agentSurface:src/orders.intents.ts'],
    ).toBeDefined();
    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(manifest.objects['consumer-app:CurrentOrder']).toBeDefined();
    expect(manifest.objects['consumer-app:PreviousOrder']).toBeUndefined();
  });

  it('does not rehash a prior artifact agent surface without a producer', async () => {
    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    mkdirSync(join(tmpDir, '.smrt'), { recursive: true });
    writeFileSync(
      knowledgePath,
      JSON.stringify({
        agentSurface: {
          intents: [
            {
              id: 'orders.stale',
              description: 'Stale declaration',
              sourceFile: 'src/orders.intents.ts',
            },
          ],
          playbooks: [],
          diagnostics: [],
        },
      }),
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await consumer.buildStart?.call(consumer);

    const knowledge = JSON.parse(readFileSync(knowledgePath, 'utf-8'));
    expect(knowledge.agentSurface).toBeUndefined();
    expect(knowledge.sourceHashes).not.toHaveProperty(
      'agentSurface:src/orders.intents.ts',
    );
  });

  it('uses file and package knowledge configuration without a producer plugin', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: { enabled: true, includeDocs: false, includePrompts: false },
        packages: { 'consumer-app': { knowledge: { enabled: false } } },
      }),
    );
    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    mkdirSync(join(tmpDir, '.smrt'), { recursive: true });
    writeFileSync(knowledgePath, '{"previous":"artifact"}');
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await consumer.buildStart?.call({} as any);

    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"artifact"}',
    );
  });

  it('restores the previous artifact pair when manifest publication fails', async () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const manifestPath = join(smrtDir, 'manifest.json');
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const previousManifest = JSON.stringify({
      version: '1.0.0',
      timestamp: 1,
      packageName: 'consumer-app',
      objects: {},
    });
    const previousKnowledge = '{"previous":"knowledge"}';
    writeFileSync(manifestPath, previousManifest);
    writeFileSync(knowledgePath, previousKnowledge);
    let renameCount = 0;
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        renameCount++;
        if (renameCount === 4) throw new Error('manifest publication failed');
        return fs.renameSync(...args);
      },
    };
    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('manifest publication failed');

    expect(readFileSync(manifestPath, 'utf-8')).toBe(previousManifest);
    expect(readFileSync(knowledgePath, 'utf-8')).toBe(previousKnowledge);
  });

  it('keeps prior artifacts when staging a later replacement fails', () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const manifestPath = join(smrtDir, 'manifest.json');
    writeFileSync(knowledgePath, '{"previous":"knowledge"}');
    writeFileSync(manifestPath, '{"previous":"manifest"}');
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      chmodSync: fs.chmodSync,
      renameSync: fs.renameSync,
      writeFileSync: (pathname, ...args) => {
        fs.writeFileSync(pathname, ...args);
        if (String(pathname).includes('manifest.json.smrt-')) {
          throw new Error('manifest staging failed');
        }
      },
    };

    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('manifest staging failed');
    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"knowledge"}',
    );
    expect(readFileSync(manifestPath, 'utf-8')).toBe('{"previous":"manifest"}');
    expect(
      readdirSync(smrtDir).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('removes a first-generation replacement when a later publication fails', () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const manifestPath = join(smrtDir, 'manifest.json');
    let renameCount = 0;
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        renameCount++;
        if (renameCount === 2) throw new Error('manifest publication failed');
        return fs.renameSync(...args);
      },
    };

    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('manifest publication failed');
    expect(existsSync(knowledgePath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('retains a backup when rollback itself fails', () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const manifestPath = join(smrtDir, 'manifest.json');
    writeFileSync(knowledgePath, '{"previous":"knowledge"}');
    writeFileSync(manifestPath, '{"previous":"manifest"}');
    let renameCount = 0;
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        renameCount++;
        if (renameCount === 4 || renameCount === 5) {
          throw new Error('publication or rollback failed');
        }
        return fs.renameSync(...args);
      },
    };

    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('rollback retained recovery backups');
    const manifestBackup = readdirSync(smrtDir).find((entry) =>
      entry.startsWith('manifest.json.smrt-'),
    );
    expect(manifestBackup).toBeDefined();
    if (!manifestBackup) throw new Error('Expected retained manifest backup');
    expect(readFileSync(join(smrtDir, manifestBackup), 'utf-8')).toBe(
      '{"previous":"manifest"}',
    );
    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"knowledge"}',
    );
  });

  it('excludes standalone consumer docs and prompts from file configuration', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: { includeDocs: false, includePrompts: false },
      }),
    );
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Consumer instructions');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src', 'prompt.ts'),
      "definePrompt('prompt', {})",
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await consumer.buildStart?.call({} as any);

    const knowledge = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge.agentDoc).toBeUndefined();
    expect(knowledge.prompts).toEqual([]);
  });

  it('fails aggregation without publishing a new manifest when knowledge cannot be written', async () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(join(smrtDir, 'smrt-knowledge.json'), { recursive: true });
    writeFileSync(
      join(smrtDir, 'manifest.json'),
      JSON.stringify({ version: '1.0.0', timestamp: 1, objects: {} }),
    );
    const before = readFileSync(join(smrtDir, 'manifest.json'), 'utf-8');
    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await expect(plugin.buildStart?.call({} as any)).rejects.toThrow(
      'Failed to save aggregated manifest',
    );
    expect(readFileSync(join(smrtDir, 'manifest.json'), 'utf-8')).toBe(before);
  });
});
