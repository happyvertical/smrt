/**
 * Regression test for #2642: framework base classes stop being exposed as
 * resources at every generator layer, plus the schema and projection layers
 * fixed alongside them.
 *
 * `@happyvertical/smrt-core` ships its abstract framework base classes
 * (`SmrtObject`, `SmrtClass`, `SmrtCollection`, `SmrtHierarchical`,
 * `SmrtJunction`, `SmrtPolymorphicAssociation`) — and `@happyvertical/
 * smrt-reports` ships `SmrtReport`/`SmrtReportCollection` — as real local
 * classes with no `@smrt()` decorator of their own. `ObjectRegistry.
 * loadAllManifests()` registers them exactly like any genuine domain class
 * (no decoration or framework-base filter of its own), so before this fix
 * `MCPGenerator.generateTools()`, `CLIGenerator.listCommands()`, and
 * `generateSvelteKitRoutes()` all produced real tools/commands/routes under
 * their own name (`smrtobject_list`, `smrtobject:list`, a `smrtobjects/`
 * route directory, ...), and `knowledge.ts`'s projection worked around the
 * symptom instead of the cause.
 *
 * This file registers ONE shared manifest fixture — three framework base
 * classes (two from core, one from a different owning package, proving the
 * exclusion is keyed on (className, packageName) together) plus a genuine
 * domain class and a domain subclass of a framework base — and drives it
 * through every layer #2642 touches from that single fixture: schema
 * (`getAllSchemasAsDefinitions`), the MCP and CLI generators, and the
 * `knowledge.ts` projection. SvelteKit route generation is covered
 * separately in `vite-plugin/sveltekit-generator.test.ts` (#2642) because it
 * operates on raw manifest objects behind a mocked `node:fs`, which cannot
 * share a test file with `knowledge.ts`'s real file reads.
 *
 * @see https://github.com/happyvertical/smrt/issues/2642
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDomainKnowledgeManifest } from '../knowledge.js';
import { ObjectRegistry } from '../registry.js';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { CLIGenerator } from './cli.js';
import { MCPGenerator } from './mcp.js';

const CORE_PKG = '@happyvertical/smrt-core';
const REPORTS_PKG = '@happyvertical/smrt-reports';
const FIXTURE_PKG = '@happyvertical/smrt-issue-2642-fixture';

function objectDef(
  className: string,
  packageName: string,
  fields: Record<string, FieldDefinition>,
  methods: SmartObjectDefinition['methods'] = {},
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/fixture/src/${className}.ts`,
    packageName,
    fields,
    methods,
    decoratorConfig: {},
    extends: extendsName,
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

/**
 * Two of core's own framework base classes, one from `@happyvertical/
 * smrt-reports` (proving the exclusion resolves per owning package, not
 * class name alone), a genuine domain class, and a domain class that
 * extends a framework base (proving the fix does not over-broadly suppress
 * real resources or their inherited surfaces).
 */
const FIXTURE: Record<string, SmartObjectDefinition> = {
  [`${CORE_PKG}:SmrtObject`]: objectDef('SmrtObject', CORE_PKG, {}),
  [`${CORE_PKG}:SmrtCollection`]: objectDef('SmrtCollection', CORE_PKG, {}),
  [`${REPORTS_PKG}:SmrtReport`]: objectDef(
    'SmrtReport',
    REPORTS_PKG,
    {},
    {},
    'SmrtObject',
  ),
  [`${FIXTURE_PKG}:Widget`]: objectDef(
    'Widget',
    FIXTURE_PKG,
    { label: { type: 'text', required: false } },
    {
      archive: {
        name: 'archive',
        async: true,
        parameters: [],
        returnType: 'Promise<void>',
        isStatic: false,
        isPublic: true,
      },
    },
    'SmrtObject',
  ),
  [`${FIXTURE_PKG}:Folder`]: objectDef(
    'Folder',
    FIXTURE_PKG,
    { name: { type: 'text', required: false } },
    {},
    'SmrtHierarchical',
  ),
};

const FRAMEWORK_BASE_NAMES = ['SmrtObject', 'SmrtCollection', 'SmrtReport'];

describe('issue #2642: framework base classes are not exposed as resources', () => {
  let restoreRegistry: () => void;

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    for (const [name, def] of Object.entries(FIXTURE)) {
      ObjectRegistry.registerFromManifest(name, def, def.packageName ?? '');
    }
  });

  afterAll(() => {
    restoreRegistry();
  });

  it('schema: plans no table for any framework base class, but does for the domain classes', async () => {
    const schemas = await ObjectRegistry.getAllSchemasAsDefinitions();
    for (const name of ['smrt_objects', 'smrt_collections', 'smrt_reports']) {
      expect(Object.keys(schemas)).not.toContain(name);
    }
    expect(schemas.widgets).toBeDefined();
    expect(schemas.folders).toBeDefined();
  });

  it('mcp: MCPGenerator.generateTools() emits no tool for any framework base class, but does for Widget', async () => {
    const tools = await new MCPGenerator().generateTools();
    const toolNames = tools.map((tool) => tool.name);

    for (const className of FRAMEWORK_BASE_NAMES) {
      const lower = className.toLowerCase();
      expect(
        toolNames.filter((name) => name.startsWith(`${lower}_`)),
        `no ${lower}_* tool`,
      ).toEqual([]);
    }
    expect(toolNames).toContain('widget_list');
    expect(toolNames).toContain('widget_archive');
    // Folder extends SmrtHierarchical (a framework base) but is itself a
    // genuine domain class — it must still get its own tools.
    expect(toolNames).toContain('folder_list');
  });

  it('cli: CLIGenerator.listCommands() emits no command for any framework base class, but does for Widget', async () => {
    const commands = await new CLIGenerator().listCommands();

    for (const className of FRAMEWORK_BASE_NAMES) {
      const lower = className.toLowerCase();
      expect(
        commands.filter((name) => name.startsWith(`${lower}:`)),
        `no ${lower}:* command`,
      ).toEqual([]);
    }
    expect(commands).toContain('widget:list');
    expect(commands).toContain('widget:archive');
    expect(commands).toContain('folder:list');
  });

  it('projection: knowledge.ts reports zero surfaces for every framework base class, using the same shared identity check as the generators', () => {
    const manifest: SmartObjectManifest = {
      version: '1',
      timestamp: 1,
      packageName: FIXTURE_PKG,
      packageVersion: '1.0.0',
      objects: FIXTURE,
    };
    const rootDir = mkdtempSync(join(tmpdir(), 'smrt-issue-2642-projection-'));
    try {
      const artifact = buildDomainKnowledgeManifest({
        manifest,
        rootDir,
        packageJson: { name: FIXTURE_PKG, version: '1.0.0' },
      });

      for (const [qualifiedName] of Object.entries(FIXTURE).filter(([, def]) =>
        FRAMEWORK_BASE_NAMES.includes(def.className),
      )) {
        expect(
          artifact.surfaces.filter(
            (surface) => surface.objectName === qualifiedName,
          ),
          `no surfaces for ${qualifiedName}`,
        ).toEqual([]);
      }

      const widgetSurfaces = artifact.surfaces.filter(
        (surface) => surface.objectName === `${FIXTURE_PKG}:Widget`,
      );
      expect(widgetSurfaces.length).toBeGreaterThan(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
