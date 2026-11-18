/**
 * A parent imported from another package is found, or generation fails.
 *
 * The scanner records where a class's `extends` is imported from. When no
 * loadable manifest declares that parent, the class is not "a root model":
 * its storage (a single-table child would get its own table), its inherited
 * fields and the surface limits it inherits all come from the parent, so
 * generating without it would publish a manifest that contradicts the source.
 *
 * Dependency manifests are resolved from the project the manifest is built
 * for, not from the directory the build process happens to run in.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors.js';
import { ManifestBuilder } from '../../manifest/generator.js';
import {
  clearManifestCache,
  loadExternalManifestSync,
} from '../../manifest/manifest-loader.js';
import { resolveStandardCrudActions } from '../../vite-plugin/web-collections.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type { ScanResult, SmartObjectDefinition } from '../types.js';

const APP = '@fixture/parent-app';
const PROVIDER = '@happyvertical/smrt-parent-fixture-events';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function definition(
  className: string,
  extra: Partial<SmartObjectDefinition>,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/app/src/models/${className}.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    packageName: APP,
    ...extra,
  } as SmartObjectDefinition;
}

function generate(objects: SmartObjectDefinition[], projectRoot?: string) {
  const scanResults: ScanResult[] = [
    { filePath: '/app/src/models', objects, errors: [] },
  ];
  return new ManifestGenerator().generateManifest(scanResults, {
    packageName: APP,
    projectRoot,
  });
}

/**
 * A project in a temp directory, with a provider package installed in it.
 *
 * `layout` is where the provider ships its manifest: behind a `./manifest`
 * export (the published convention), or as a root `manifest.json` with no
 * export for it, which the consumer build also reads.
 */
function project(options: {
  providerManifest: boolean;
  layout?: 'export' | 'conventional';
  provider?: string;
  /** How ParentMeeting imports its parent; default a named import. */
  importLine?: string;
  /** The parent's name in ParentMeeting's `extends`; default ParentEvent. */
  extendsName?: string;
  /** Extra app source files, by path relative to the root. */
  files?: Record<string, string>;
}) {
  const provider = options.provider ?? PROVIDER;
  const conventional = options.layout === 'conventional';
  // realpath: discovery reports real paths, and macOS tmp is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-parent-app-')));
  roots.push(root);
  const installed = join(root, 'node_modules', provider);
  const manifestFile = conventional
    ? join(installed, 'manifest.json')
    : join(installed, 'dist/manifest.json');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src/models'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: APP,
      version: '0.0.0',
      dependencies: { [provider]: '*' },
    }),
  );
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({
      name: provider,
      version: '1.0.0',
      main: 'index.js',
      exports: conventional
        ? './index.js'
        : { '.': './index.js', './manifest': './dist/manifest.json' },
    }),
  );
  writeFileSync(join(installed, 'index.js'), 'export class ParentEvent {}');
  if (options.providerManifest) {
    writeFileSync(
      manifestFile,
      JSON.stringify({
        version: '1.0.0',
        ...(conventional ? {} : { moduleType: 'smrt' }),
        packageName: provider,
        objects: {
          [`${provider}:ParentEvent`]: {
            name: 'parentevent',
            className: 'ParentEvent',
            qualifiedName: `${provider}:ParentEvent`,
            collection: 'parentevents',
            packageName: provider,
            // The entry the provider exports it from.
            importPath: provider,
            filePath: 'src/ParentEvent.ts',
            extends: 'SmrtObject',
            fields: { startsAt: { type: 'datetime', required: false } },
            methods: {},
            decoratorConfig: {
              tableStrategy: 'sti',
              tableName: 'parent_events',
              api: { include: ['list', 'get'] },
            },
          },
        },
      }),
    );
  }
  writeFileSync(
    join(root, 'src/models/ParentMeeting.ts'),
    `import { smrt } from '@happyvertical/smrt-core';
${options.importLine ?? `import { ParentEvent } from '${provider}';`}
@smrt()
export class ParentMeeting extends ${options.extendsName ?? 'ParentEvent'} {
  room = '';
}
`,
  );
  for (const [path, source] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** A project root with a tsconfig declaring `paths` (or none). */
function aliasProject(paths?: Record<string, string[]>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-alias-app-')));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: APP, version: '0.0.0' }),
  );
  if (paths) {
    writeFileSync(
      join(root, 'tsconfig.json'),
      `{\n  // path aliases\n  "compilerOptions": { "baseUrl": ".", "paths": ${JSON.stringify(paths)}, },\n}\n`,
    );
  }
  return root;
}

function aliasDefinitions(root: string): SmartObjectDefinition[] {
  return [
    definition('ParentEvent', {
      filePath: join(root, 'src/models/ParentEvent.ts'),
      fields: { startsAt: { type: 'datetime' } },
      decoratorConfig: { tableStrategy: 'sti', tableName: 'parent_events' },
    }),
    definition('ParentMeeting', {
      filePath: join(root, 'src/models/ParentMeeting.ts'),
      extends: 'ParentEvent',
      extendsQualified: '@app/models:ParentEvent',
    }),
  ] as SmartObjectDefinition[];
}

/** An app model that shares the provider parent's simple name. */
const LOCAL_NAMESAKE = {
  'src/models/ParentEvent.ts': `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt({ tableName: 'local_parent_events' })
export class ParentEvent extends SmrtObject {
  title = '';
}
`,
};

function buildProject(root: string) {
  return new ManifestBuilder(root).generate({
    include: ['src/**/*.ts'],
    discoverExternalPackages: true,
    outputMode: 'dev',
    outputDir: '.smrt',
    generateTypeStub: false,
  });
}

describe('a parent imported from a package no manifest declares it in', () => {
  it('fails generation and names the class, the package and the root', () => {
    let thrown: unknown;
    try {
      generate(
        [
          definition('ParentMeeting', {
            extends: 'ParentEvent',
            extendsQualified: `${PROVIDER}:ParentEvent`,
          }),
        ],
        '/nonexistent/parent-app',
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const error = thrown as ConfigurationError;
    expect(error.code).toBe('CONFIG_UNRESOLVED_IMPORTED_PARENT');
    expect(error.message).toContain('ParentMeeting');
    expect(error.message).toContain('ParentEvent');
    expect(error.message).toContain(PROVIDER);
    expect(error.message).toContain('/nonexistent/parent-app');
    expect(error.details).toMatchObject({
      className: 'ParentMeeting',
      parentPackage: PROVIDER,
      resolutionRoot: '/nonexistent/parent-app',
    });
  });

  it.each([
    ['without a tsconfig', undefined],
    [
      'even when a tsconfig maps the name',
      { '@app/models/*': ['src/models/*'] },
    ],
  ])('fails for a qualification that resolves to no package, %s', (_label, paths) => {
    // A path alias is resolved by the scanner to the file it maps to, so a
    // qualification that reaches generation names a package; one that names
    // none has no parent, whatever local class shares its name.
    const root = aliasProject(paths);

    expect(() => generate(aliasDefinitions(root), root)).toThrow(
      expect.objectContaining({ code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT' }),
    );
  });

  it('leaves a class with no imported parent alone', () => {
    const manifest = generate([
      definition('ParentMeeting', { extends: 'LocalMixin' }),
    ]);

    expect(manifest.objects[`${APP}:ParentMeeting`]).toBeDefined();
  });
});

describe('dependency manifests are resolved from the project root', () => {
  it('finds the parent of a project that is not the working directory', async () => {
    const root = project({ providerManifest: true });
    expect(root).not.toBe(process.cwd());

    const manifest = await buildProject(root);
    const meeting = manifest.objects[`${APP}:ParentMeeting`];

    expect(manifest.smrtDependencies).toEqual([PROVIDER]);
    expect(meeting?.extendsQualified).toBe(`${PROVIDER}:ParentEvent`);
    // A single-table child: the parent's table and fields, not its own table.
    expect(meeting?.decoratorConfig.tableName).toBe('parent_events');
    expect(Object.keys(meeting?.fields ?? {})).toEqual(
      expect.arrayContaining(['startsAt', 'room']),
    );
    // The surface the parent limits is inherited, not reopened.
    expect(
      resolveStandardCrudActions(meeting?.decoratorConfig.api).sort(),
    ).toEqual(['get', 'list']);
  });

  it('finds a parent whose package ships a manifest without exporting it', async () => {
    // Not a package discovery lists, and no `./manifest` export: the same
    // conventional location the consumer build reads.
    const vendor = '@fixture-vendor/parent-events';
    const root = project({
      providerManifest: true,
      layout: 'conventional',
      provider: vendor,
    });

    const manifest = await buildProject(root);
    const meeting = manifest.objects[`${APP}:ParentMeeting`];

    expect(meeting?.extendsQualified).toBe(`${vendor}:ParentEvent`);
    expect(meeting?.decoratorConfig.tableName).toBe('parent_events');
  });

  it('fails when the parent package is installed without a manifest', async () => {
    const root = project({ providerManifest: false });

    await expect(buildProject(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      details: { className: 'ParentMeeting', resolutionRoot: root },
    });
  });
});

describe('a confirmed imported parent beside a same-named app model', () => {
  it('inherits exposure from the imported parent, not the namesake', async () => {
    const root = project({ providerManifest: true, files: LOCAL_NAMESAKE });

    const manifest = await buildProject(root);
    const meeting = manifest.objects[`${APP}:ParentMeeting`];

    expect(meeting?.extendsQualified).toBe(`${PROVIDER}:ParentEvent`);
    expect(meeting?.decoratorConfig.tableName).toBe('parent_events');
    // The provider's parent closes every write; the namesake is open.
    expect(
      resolveStandardCrudActions(meeting?.decoratorConfig.api).sort(),
    ).toEqual(['get', 'list']);
  });

  it('fails when the provider is installed without the parent, whatever the app declares', async () => {
    const root = project({ providerManifest: false, files: LOCAL_NAMESAKE });

    await expect(buildProject(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      details: { className: 'ParentMeeting', parentPackage: PROVIDER },
    });
  });
});

describe('a parent imported as a default export', () => {
  it('fails rather than confirm a same-named class of the package', async () => {
    // The provider declares ParentEvent; its default export may be another
    // class entirely. A manifest does not say which, so nothing is confirmed.
    const root = project({
      providerManifest: true,
      importLine: `import ParentEvent from '${PROVIDER}';`,
    });
    writeFileSync(
      join(root, 'node_modules', PROVIDER, 'index.js'),
      'export default class PrivateEvent {}\nexport class ParentEvent {}\n',
    );

    // The scan refuses it: a package's default export cannot be identified.
    await expect(buildProject(root)).rejects.toThrow(/scan error/);
    await expect(buildProject(root)).rejects.toThrow();
  });

  it('fails when the package declares no class of the local name', async () => {
    const root = project({
      providerManifest: true,
      importLine: `import BaseEvent from '${PROVIDER}';`,
      extendsName: 'BaseEvent',
    });

    await expect(buildProject(root)).rejects.toThrow(/scan error/);
  });
});

describe('a parent imported under another name', () => {
  it('is confirmed by its exported name', async () => {
    const root = project({
      providerManifest: true,
      importLine: `import { ParentEvent as BaseEvent } from '${PROVIDER}';`,
      extendsName: 'BaseEvent',
    });

    const manifest = await buildProject(root);
    const meeting = manifest.objects[`${APP}:ParentMeeting`];

    expect(meeting?.extendsQualified).toBe(`${PROVIDER}:ParentEvent`);
    expect(meeting?.decoratorConfig.tableName).toBe('parent_events');
  });
});

describe('a single-table namesake of an imported parent', () => {
  it('contributes none of its fields to the child', async () => {
    const root = project({
      providerManifest: true,
      files: {
        'src/models/ParentEvent.ts': `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt({ tableStrategy: 'sti', tableName: 'local_parent_events' })
export class ParentEvent extends SmrtObject {
  localOnly = '';
}
`,
      },
    });

    const manifest = await buildProject(root);
    const meeting = manifest.objects[`${APP}:ParentMeeting`];

    expect(meeting?.decoratorConfig.tableName).toBe('parent_events');
    expect(Object.keys(meeting?.fields ?? {})).toEqual(
      expect.arrayContaining(['startsAt', 'room']),
    );
    expect(Object.keys(meeting?.fields ?? {})).not.toContain('localOnly');
  });
});

describe('a provider that changes between builds in one process', () => {
  it('is read again by the second build', async () => {
    const root = project({ providerManifest: true, layout: 'conventional' });
    const manifestFile = join(root, 'node_modules', PROVIDER, 'manifest.json');
    const setApi = (api: unknown) => {
      const written = JSON.parse(readFileSync(manifestFile, 'utf8'));
      written.objects[`${PROVIDER}:ParentEvent`].decoratorConfig.api = api;
      writeFileSync(manifestFile, JSON.stringify(written));
    };

    setApi({ include: ['list', 'get', 'create', 'update', 'delete'] });
    const first = await buildProject(root);
    setApi(false);
    const second = await buildProject(root);

    expect(
      resolveStandardCrudActions(
        first.objects[`${APP}:ParentMeeting`]?.decoratorConfig.api,
      ).length,
    ).toBe(5);
    expect(
      resolveStandardCrudActions(
        second.objects[`${APP}:ParentMeeting`]?.decoratorConfig.api,
      ),
    ).toEqual([]);
  });
});

describe('relationship targets in generation', () => {
  it('fails when a target names no class of the package or its dependencies', async () => {
    const root = project({
      providerManifest: true,
      files: {
        'src/models/Booking.ts': `import { smrt, SmrtObject, foreignKey } from '@happyvertical/smrt-core';
import { OwnerModel } from '${PROVIDER}';
@smrt()
export class Booking extends SmrtObject {
  @foreignKey(OwnerModel) ownerId = '';
}
`,
      },
    });

    await expect(buildProject(root)).rejects.toMatchObject({
      code: 'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
    });
  });

  it('accepts a target the dependency declares', async () => {
    const root = project({
      providerManifest: true,
      files: {
        'src/models/Booking.ts': `import { smrt, SmrtObject, foreignKey } from '@happyvertical/smrt-core';
import { ParentEvent } from '${PROVIDER}';
@smrt()
export class Booking extends SmrtObject {
  @foreignKey(ParentEvent) eventId = '';
}
`,
      },
    });

    const manifest = await buildProject(root);
    expect(manifest.objects[`${APP}:Booking`]?.fields.eventId?.related).toBe(
      'ParentEvent',
    );
  });
});

describe('dependency manifests loaded for another project', () => {
  it('stay out of this process’s own manifest lookups', async () => {
    clearManifestCache();
    const root = project({ providerManifest: true });

    await buildProject(root);

    // The provider is installed only in that project; this process's default
    // resolution root has no such package.
    expect(loadExternalManifestSync(PROVIDER, { warn: false })).toBeNull();
  });
});

describe('review round 4', () => {
  it('fails for a package target the package does not declare, even beside an app namesake', async () => {
    const root = project({
      providerManifest: true,
      files: {
        'src/models/OwnerModel.ts': `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt()
export class OwnerModel extends SmrtObject {}
`,
        'src/models/Booking.ts': `import { smrt, SmrtObject, foreignKey } from '@happyvertical/smrt-core';
import { OwnerModel } from '${PROVIDER}';
@smrt()
export class Booking extends SmrtObject {
  @foreignKey(OwnerModel) ownerId = '';
}
`,
      },
    });

    await expect(buildProject(root)).rejects.toMatchObject({
      code: 'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
    });
  });

  it('gives a single-table child the inherited static metadata of a parent imported by relative path', async () => {
    const root = project({
      providerManifest: true,
      files: {
        'src/models/Panel.ts': `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt({ tableStrategy: 'sti' })
export class Panel extends SmrtObject {
  static uiSlots = { sources: { id: 'sources', label: 'Sources' } };
  title = '';
}
`,
        'src/models/SidePanel.ts': `import { smrt } from '@happyvertical/smrt-core';
import { Panel } from './Panel';
@smrt()
export class SidePanel extends Panel {
  width = 0;
}
`,
      },
    });

    const manifest = await buildProject(root);
    const side = manifest.objects[`${APP}:SidePanel`];

    expect(side?.staticProperties?.uiSlots).toEqual({
      sources: { id: 'sources', label: 'Sources' },
    });
  });

  it('reads a changed provider again in a run without an explicit root', () => {
    const root = project({ providerManifest: true });
    const manifestFile = join(
      root,
      'node_modules',
      PROVIDER,
      'dist/manifest.json',
    );
    const setApi = (api: unknown) => {
      const written = JSON.parse(readFileSync(manifestFile, 'utf8'));
      written.objects[`${PROVIDER}:ParentEvent`].decoratorConfig.api = api;
      writeFileSync(manifestFile, JSON.stringify(written));
    };
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const child = () =>
        definition('ParentMeeting', {
          extends: 'ParentEvent',
          extendsQualified: `${PROVIDER}:ParentEvent`,
          extendsImportPath: PROVIDER,
          fields: { room: { type: 'text' } },
        });
      setApi({ include: ['list', 'get', 'create', 'update', 'delete'] });
      const first = generate([child()]);
      setApi(false);
      const second = generate([child()]);

      expect(
        resolveStandardCrudActions(
          first.objects[`${APP}:ParentMeeting`]?.decoratorConfig.api,
        ).length,
      ).toBe(5);
      expect(
        resolveStandardCrudActions(
          second.objects[`${APP}:ParentMeeting`]?.decoratorConfig.api,
        ),
      ).toEqual([]);
    } finally {
      cwd.mockRestore();
    }
  });
});
