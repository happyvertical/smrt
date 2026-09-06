import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDomainKnowledgeManifest,
  resolveAgentModuleDocPaths,
} from './knowledge.js';
import type { SmartObjectManifest } from './scanner/types.js';

describe('buildDomainKnowledgeManifest', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-domain-knowledge-'));
    mkdirSync(join(rootDir, 'src', 'prompts'), { recursive: true });
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify(
        {
          name: '@example/orders',
          version: '1.0.0',
          exports: {
            '.': './dist/index.js',
            './smrt-knowledge.json': './dist/smrt-knowledge.json',
          },
          dependencies: {
            '@happyvertical/smrt-core': 'workspace:*',
            '@happyvertical/sql': 'catalog:',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(rootDir, 'AGENTS.md'),
      '# Orders\n\nReview payment and tenant boundaries.',
    );
    writeFileSync(
      join(rootDir, 'src', 'prompts', 'review.ts'),
      "export const review = definePrompt('orders.review', {});\n",
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('captures package metadata and authored context', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.packageName).toBe('@example/orders');
    expect(artifact.tags).toEqual(['commerce']);
    expect(artifact.summary).toBe('Order package');
    expect(artifact.risks).toEqual(['Ledger integration']);
    expect(artifact.sdkDependencies).toEqual(['@happyvertical/sql']);
    expect(artifact.exports).toContain('./smrt-knowledge.json');
    expect(artifact.agentDoc).toContain('Review payment');
    expect(artifact.prompts).toEqual([
      {
        filePath: 'src/prompts/review.ts',
        key: 'orders.review',
      },
    ]);
  });

  it('builds objects, surfaces, and object-level advisory metadata', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.objects.map((object) => object.name)).toEqual([
      'Order',
      'OrderLinks',
      'OrderTree',
      'OrderTreeCollection',
      'SpecialOrderTreeCollection',
      'SmrtObject',
      'SmrtReport',
      'SmrtObject',
      'RoutedOrder',
      'LegacyPathOrder',
      'ThrowingRouteOrder',
      'CasedVerbItem',
      'CasedIncludeItem',
      'MalformedConfigItem',
      'LifecycleOverrideOrder',
      'CaseCollisionItem',
      'ExcludeCaseItem',
    ]);
    expect(artifact.objects[0].tags).toEqual(['payments']);
    expect(artifact.surfaces.map((surface) => surface.name)).toEqual(
      expect.arrayContaining(['orders.get', 'order_get', 'order_approve']),
    );
  });

  it('reports full CRUD and eligible custom-method surfaces when api/cli/mcp config is omitted (#2619)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const orderLinksSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:OrderLinks',
    );
    const orderTreeSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:OrderTree',
    );

    // OrderLinks has no `api`/`cli`/`mcp` config at all — an omitted config
    // key is full CRUD, not a closed surface, mirroring the generators'
    // actual defaults.
    for (const kind of ['api', 'cli', 'mcp'] as const) {
      const names = orderLinksSurfaces
        .filter((surface) => surface.kind === kind)
        .map((surface) => surface.operation);
      expect(names.sort()).toEqual([
        'create',
        'delete',
        'get',
        'list',
        'update',
      ]);
    }

    // OrderTree additionally declares two public custom methods (`archive`,
    // `findByReference`) and a non-public one (`internalRebalance`); only
    // the public methods are eligible, matching
    // MCPGenerator/APIGenerator's own isPublic gate (packages/cli's CLIGenerator shares it too).
    for (const kind of ['api', 'cli', 'mcp'] as const) {
      const names = orderTreeSurfaces
        .filter((surface) => surface.kind === kind)
        .map((surface) => surface.operation);
      expect(names.sort()).toEqual([
        'archive',
        'create',
        'delete',
        'findByReference',
        'get',
        'list',
        'update',
      ]);
    }
    expect(
      orderTreeSurfaces.some((surface) => surface.operation === 'archive'),
    ).toBe(true);
    expect(
      orderTreeSurfaces.some(
        (surface) => surface.operation === 'internalRebalance',
      ),
    ).toBe(false);

    // MCPGenerator's `buildCustomActionTool()` lowercases the WHOLE joined
    // `${lowerName}_${methodName}` tool name, not just the object-name
    // prefix, so a camelCase method name must be reported under its real
    // (fully lowercased) tool id. packages/cli's CLIGenerator's `object:methodName` command
    // string does not lowercase the method half, so `cli` keeps it as
    // authored.
    const findByReferenceMcp = orderTreeSurfaces.find(
      (surface) =>
        surface.kind === 'mcp' && surface.operation === 'findByReference',
    );
    const findByReferenceCli = orderTreeSurfaces.find(
      (surface) =>
        surface.kind === 'cli' && surface.operation === 'findByReference',
    );
    expect(findByReferenceMcp?.name).toBe('ordertree_findbyreference');
    expect(findByReferenceCli?.name).toBe('ordertree_findByReference');
  });

  it('excludes a locally overridden framework lifecycle method from the cli and mcp surfaces (#2657, #2638)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const surfaces = artifact.surfaces.filter(
      (surface) =>
        surface.objectName === '@example/orders:LifecycleOverrideOrder',
    );

    // `save` is a framework lifecycle method (the mechanism behind generated
    // create/update), so packages/cli's CLIGenerator.listCommands()/assertCommandExposed()
    // and MCPGenerator.generateTools() both refuse to expose or invoke it
    // even when the class declares its own override -- this projection
    // mirrors that with the same isFrameworkLifecycleMethod() check, for
    // cli and mcp.
    for (const kind of ['cli', 'mcp'] as const) {
      expect(
        surfaces
          .filter((surface) => surface.kind === kind)
          .map((surface) => surface.operation)
          .sort(),
      ).toEqual(['create', 'delete', 'get', 'list', 'reconcile', 'update']);
    }

    // `api` is unaffected: the generator does not gate on
    // isFrameworkLifecycleMethod() today, so `save` still appears as a
    // custom-method surface there.
    expect(
      surfaces
        .filter((surface) => surface.kind === 'api')
        .map((surface) => surface.operation)
        .sort(),
    ).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'reconcile',
      'save',
      'update',
    ]);
  });

  it('never reports CRUD for an undecorated SmrtCollection subclass, but does report its public custom methods on every surface (#2642)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const collectionSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:OrderTreeCollection',
    );

    // A hand-written `class OrderTreeCollection extends
    // SmrtCollection<OrderTree>` is registered by `loadAllManifests()` just
    // like any genuine domain class (#2642) — it never gets CRUD verbs
    // (`list`/`get`/`create`/`update`/`delete` belong to the row model, not
    // the collection), but its public custom method reaches MCP/CLI too,
    // not just REST, matching what a real registration produces.
    for (const kind of ['mcp', 'cli', 'api'] as const) {
      expect(
        collectionSurfaces
          .filter((surface) => surface.kind === kind)
          .map((surface) => surface.operation),
      ).toEqual(['findAbandoned']);
    }
  });

  it('walks the extends chain so a deeper collection subclass is still recognized (#2619)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const deepSurfaces = artifact.surfaces.filter(
      (surface) =>
        surface.objectName === '@example/orders:SpecialOrderTreeCollection',
    );

    // `SpecialOrderTreeCollection extends OrderTreeCollection` carries no
    // `extendsTypeArg` of its own — only its base does. Without walking the
    // extends chain through the manifest, this class would be mistaken for a
    // row model and gain a synthetic full-CRUD surface it does not have —
    // it still reports its one public custom method on every surface kind
    // (#2642), same as its shallower sibling above.
    for (const kind of ['mcp', 'cli', 'api'] as const) {
      expect(
        deepSurfaces
          .filter((surface) => surface.kind === kind)
          .map((surface) => surface.operation),
      ).toEqual(['findEscalated']);
    }
  });

  it('reports no surfaces for a framework base class scanned in its own foundation package (#2642)', () => {
    const artifact = buildFixtureArtifact(rootDir);

    // `@happyvertical/smrt-core:SmrtObject` has `decoratorConfig: {}` — the
    // same shape as a genuine bare `@smrt()`. #2619 excluded it on the false
    // premise that it "never registers with ObjectRegistry"; #2642 confirmed
    // `loadAllManifests()` registers it exactly like any genuine domain
    // class, and fixed the real root cause — MCPGenerator/route generation/packages/cli's CLIGenerator
    // generation now skip the framework's own abstract base classes by class
    // identity, independent of config. This projection mirrors that same
    // shared check (`isFrameworkBaseClass`), so it stays truthful rather
    // than reintroducing the 317 phantom `smrtobjects.list`/`.create`/...
    // surfaces #2619 originally hid.
    expect(
      artifact.surfaces.filter(
        (surface) =>
          surface.objectName === '@happyvertical/smrt-core:SmrtObject',
      ),
    ).toEqual([]);
  });

  it('resolves the framework-base exclusion per owning package, not by class name alone (#2642)', () => {
    const artifact = buildFixtureArtifact(rootDir);

    // SmrtReport/SmrtReportCollection live in @happyvertical/smrt-reports,
    // not @happyvertical/smrt-core — the exclusion must still catch them.
    expect(
      artifact.surfaces.filter(
        (surface) =>
          surface.objectName === '@happyvertical/smrt-reports:SmrtReport',
      ),
    ).toEqual([]);

    // A same-named `SmrtObject` in an unrelated third package is a genuine
    // application class (however unlikely the name collision) and must
    // still get its normal full-CRUD surface — a naive className-only check
    // would wrongly suppress it.
    const unrelatedSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/other-pkg:SmrtObject',
    );
    expect(unrelatedSurfaces.length).toBeGreaterThan(0);
    expect(
      unrelatedSurfaces
        .filter((surface) => surface.kind === 'api')
        .map((surface) => surface.operation)
        .sort(),
    ).toEqual(['create', 'delete', 'get', 'list', 'update']);
  });

  it('treats a malformed non-array include/exclude as unset rather than throwing or substring-matching (#2619)', () => {
    // `mcp: { include: 'list' }` (a bare string, not an array) must not
    // reach `.includes()` as-is: for a string that would silently perform
    // substring matching instead of array membership, and for other
    // malformed values could throw outright.
    expect(() => buildFixtureArtifact(rootDir)).not.toThrow();

    const artifact = buildFixtureArtifact(rootDir);
    const mcpSurfaces = artifact.surfaces.filter(
      (surface) =>
        surface.objectName === '@example/orders:MalformedConfigItem' &&
        surface.kind === 'mcp',
    );
    // Falls back to "no include list": full CRUD plus the eligible public
    // custom method, exactly as if `mcp: {}` had been declared.
    expect(mcpSurfaces.map((surface) => surface.operation).sort()).toEqual([
      'create',
      'delete',
      'exportData',
      'get',
      'list',
      'update',
    ]);
  });

  it('does not report an MCP surface the CRUD-name reservation suppresses (#2646)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const operations = (objectName: string, kind: 'api' | 'cli' | 'mcp') =>
      artifact.surfaces
        .filter(
          (surface) =>
            surface.objectName === objectName && surface.kind === kind,
        )
        .map((surface) => surface.operation)
        .sort();

    // MCP lowercases the whole tool id, so `List` lands on the identifier the
    // CRUD list tool already owns and no separate tool is emitted.
    expect(operations('@example/orders:CasedVerbItem', 'mcp')).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'syncNow',
      'update',
    ]);

    // REST and the CLI keep declared casing in their route/command names, so
    // `List` stays a distinct surface there — the reservation is per-transport.
    expect(operations('@example/orders:CasedVerbItem', 'cli')).toContain(
      'List',
    );
    expect(operations('@example/orders:CasedVerbItem', 'api')).toContain(
      'List',
    );
  });

  it('reports one mcp operation for two methods that fold onto the same MCP tool id (#2638)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const surfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === '@example/orders:CaseCollisionItem',
    );

    // `mcp` folds case, so `Refresh`/`refresh` collide on one tool id and the
    // projection reports the operation once (first declared -- `Refresh`),
    // alongside the standard CRUD operations this omitted-config class also
    // gets.
    expect(
      surfaces
        .filter((surface) => surface.kind === 'mcp')
        .map((surface) => surface.operation)
        .sort(),
    ).toEqual(['Refresh', 'create', 'delete', 'get', 'list', 'update']);

    // `cli`/`api` keep declared casing, so both distinct methods are
    // reported as separate operations there.
    for (const kind of ['cli', 'api'] as const) {
      expect(
        surfaces
          .filter((surface) => surface.kind === kind)
          .map((surface) => surface.operation)
          .sort(),
      ).toEqual([
        'Refresh',
        'create',
        'delete',
        'get',
        'list',
        'refresh',
        'update',
      ]);
    }
  });

  it('excludes an mcp operation via a case-mismatched `exclude` entry (#2638)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const mcpOperations = artifact.surfaces
      .filter(
        (surface) =>
          surface.objectName === '@example/orders:ExcludeCaseItem' &&
          surface.kind === 'mcp',
      )
      .map((surface) => surface.operation);

    // `exclude: ['refresh']` against a method declared `Refresh` still
    // excludes it -- mcp's exclude comparison is case-folded, matching
    // MCPGenerator's own fix for the asymmetry with `include`.
    expect(mcpOperations).not.toContain('Refresh');
    // An unrelated public method is unaffected.
    expect(mcpOperations).toContain('syncNow');
  });

  it('reports no MCP surface when a strict include names only a cased verb (#2646)', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const mcpSurfaces = artifact.surfaces.filter(
      (surface) =>
        surface.objectName === '@example/orders:CasedIncludeItem' &&
        surface.kind === 'mcp',
    );

    // `include: ['List']` selects no CRUD verb (that gate is exact) and the
    // cased entry fails closed, so the generator emits nothing. Reporting a
    // `List` surface here would advertise a tool that does not exist.
    expect(mcpSurfaces.map((surface) => surface.operation)).toEqual([]);
  });

  it("reports a custom action's REST route the way the generator emits it (#2619)", () => {
    const artifact = buildFixtureArtifact(rootDir);
    const apiSurface = (objectName: string, operation: string) =>
      artifact.surfaces.find(
        (surface) =>
          surface.kind === 'api' &&
          surface.objectName === objectName &&
          surface.operation === operation,
      );

    // `generateRoutesForObject` nests an item-scoped action under `[id]`, and
    // a public INSTANCE method defaults to item scope. Reporting
    // `/order_trees/archive` would advertise an endpoint that is never
    // generated.
    expect(apiSurface('@example/orders:OrderTree', 'archive')).toMatchObject({
      path: '/order_trees/[id]/archive',
      method: 'POST',
    });

    // A STATIC method defaults to collection scope — no `[id]` segment.
    expect(apiSurface('@example/orders:Order', 'approve')).toMatchObject({
      path: '/orders/approve',
      method: 'POST',
    });

    // A collection class's action is collection-scoped for the same reason.
    expect(
      apiSurface('@example/orders:OrderTreeCollection', 'findAbandoned'),
    ).toMatchObject({ path: '/order_trees/findAbandoned', method: 'POST' });

    // An explicit `routes` override wins for both path and method.
    expect(
      apiSurface('@example/orders:RoutedOrder', 'exportCsv'),
    ).toMatchObject({
      path: '/routed_orders/[id]/export-csv',
      method: 'GET',
    });

    // CRUD paths are unchanged by the custom-action resolution.
    expect(apiSurface('@example/orders:OrderTree', 'list')?.path).toBe(
      '/order_trees',
    );
    expect(apiSurface('@example/orders:OrderTree', 'get')?.path).toBe(
      '/order_trees/[id]',
    );

    // The collection segment is the manifest `collection` VERBATIM. A
    // collection-level `api.path` must NOT be consulted: it configures
    // smrt-agents' route map, while the SvelteKit generator and the runtime
    // dispatcher both serve `collection` unmodified, so honoring it here
    // would name endpoints that 404 on both (#2630).
    expect(apiSurface('@example/orders:LegacyPathOrder', 'list')?.path).toBe(
      '/legacy_orders',
    );
    expect(apiSurface('@example/orders:LegacyPathOrder', 'get')?.path).toBe(
      '/legacy_orders/[id]',
    );
    expect(
      apiSurface('@example/orders:LegacyPathOrder', 'reconcile')?.path,
    ).toBe('/legacy_orders/[id]/reconcile');
    // ...and no emitted surface anywhere uses the override value.
    expect(
      artifact.surfaces.filter((surface) =>
        (surface.path ?? '').includes('orders-v1'),
      ),
    ).toEqual([]);
  });

  it('survives a routes config the shared resolver rejects (#2619)', () => {
    // `resolveCustomActionMetadata` throws on `effect: 'read'` + DELETE. The
    // projection reads untrusted scanned config, so one malformed action must
    // not fail `dev:knowledge-check`/`docs:agents` for the whole package.
    expect(() => buildFixtureArtifact(rootDir)).not.toThrow();

    const artifact = buildFixtureArtifact(rootDir);
    const purge = artifact.surfaces.find(
      (surface) =>
        surface.kind === 'api' &&
        surface.objectName === '@example/orders:ThrowingRouteOrder' &&
        surface.operation === 'purge',
    );
    // Scope falls back to the receiver the method itself dictates — an
    // instance method is item-scoped, which a route-only override cannot
    // change. The declared `method` is read on its own non-throwing path, so
    // it is still reported as authored rather than silently normalized away.
    expect(purge).toMatchObject({
      path: '/throwing_route_orders/[id]/purge',
      method: 'DELETE',
    });
  });

  it('derives the owning package from a qualified manifest key (#2619)', () => {
    // An entry carrying only a qualified KEY — no `packageName`, no
    // `qualifiedName` — must still resolve its package, or the same-package
    // preference is skipped and a duplicate simple name picks the wrong
    // parent, misclassifying the collection-class carve-out.
    const manifest = fixtureManifest();
    // The DECOY is inserted FIRST, and this ordering is the whole test: string
    // keys keep insertion order, so the bare simple-name fallback finds this
    // one. Only the same-package preference — which needs the package derived
    // from the qualified KEY, since neither entry has `packageName` or
    // `qualifiedName` — reaches the real base below. Reverting
    // `manifestObjectPackage` to read only `qualifiedName` makes this test
    // fail, which is what makes it a regression test rather than a tautology.
    manifest.objects['@decoy/pkg:KeyOnlyBase'] = {
      className: 'KeyOnlyBase',
      collection: 'decoys',
      fields: {},
      methods: {},
      decoratorConfig: {},
      extends: 'SmrtObject',
    } as SmartObjectManifest['objects'][string];
    manifest.objects['@key-only/pkg:KeyOnlyBase'] = {
      className: 'KeyOnlyBase',
      collection: 'key_only_bases',
      fields: {},
      methods: {},
      decoratorConfig: {},
      extends: 'SmrtCollection',
      extendsTypeArg: 'KeyOnlyRow',
    } as SmartObjectManifest['objects'][string];
    manifest.objects['@key-only/pkg:KeyOnlyChild'] = {
      className: 'KeyOnlyChild',
      collection: 'key_only_children',
      fields: {},
      methods: {},
      decoratorConfig: {},
      extends: 'KeyOnlyBase',
    } as SmartObjectManifest['objects'][string];

    const artifact = buildDomainKnowledgeManifest({ manifest, rootDir });
    const childSurfaces = artifact.surfaces.filter(
      (surface) => surface.objectName === 'KeyOnlyChild',
    );

    // Resolved through its own package's collection base, so the child is a
    // collection class: no CRUD, and nothing at all on mcp/cli.
    expect(childSurfaces).toEqual([]);
  });

  it('projects structural facts without exposing sensitive fields', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const order = artifact.objects.find((object) => object.name === 'Order');

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.sensitiveFieldsExcluded).toBe(true);
    expect(order).toMatchObject({
      tenant: { scoped: true, mode: 'required', field: 'tenantId' },
      tableStrategy: 'sti',
      conflictColumns: ['tenant_id', 'profile_id'],
      methods: ['approve'],
      methodSignatures: [
        {
          name: 'approve',
          async: true,
          static: true,
          params: ['reason?: string'],
          returns: 'Promise<void>',
        },
      ],
    });
    expect(
      artifact.objects.find((object) => object.name === 'OrderLinks'),
    ).toMatchObject({
      relationshipFeatures: ['SmrtJunction', 'foreignKey'],
      conflictColumns: ['order_id', 'item_id'],
    });
    expect(order?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'attempts',
          default: 0,
          constraints: { min: 0, max: 3 },
          readonly: true,
        }),
        expect.objectContaining({ name: 'active', default: false }),
        expect.objectContaining({
          name: 'reference',
          constraints: { minLength: 2, maxLength: 24, pattern: '^[A-Z]+' },
        }),
        expect.objectContaining({ name: 'preview', transient: true }),
      ]),
    );
    expect(order?.fields.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
    expect(order?.relationships.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
  });

  it('redacts a sensitive tenant field identity while retaining tenant scope', () => {
    const manifest = fixtureManifest();
    manifest.objects['@example/orders:Order'].decoratorConfig.tenantScoped = {
      field: 'secretId',
      mode: 'optional',
    };
    const artifact = buildDomainKnowledgeManifest({ manifest, rootDir });
    const order = artifact.objects.find((object) => object.name === 'Order');

    expect(order?.tenant).toEqual({ scoped: true, mode: 'optional' });
  });

  it('preserves relationship details and relationships-v2 counts', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const order = artifact.objects.find((object) => object.name === 'Order');

    expect(order?.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tenantId',
          type: 'foreignKey',
          required: true,
          columnType: 'UUID',
        }),
        expect.objectContaining({
          name: 'profileId',
          type: 'crossPackageRef',
          columnType: 'UUID',
        }),
      ]),
    );
    expect(artifact.relationshipsV2).toMatchObject({
      foreignKeyFields: 3,
      crossPackageRefFields: 1,
      junctionCollections: 1,
      hierarchicalObjects: 1,
      uuidColumns: 3,
    });
  });

  it('records stable source hashes', () => {
    const artifact = buildFixtureArtifact(rootDir);
    const rebuilt = buildFixtureArtifact(rootDir);
    const changedManifest = fixtureManifest();
    changedManifest.objects[
      '@example/orders:Order'
    ].decoratorConfig.conflictColumns = ['tenant_id', 'reference'];
    const changed = buildDomainKnowledgeManifest({
      manifest: changedManifest,
      rootDir,
    });

    expect(artifact.sourceHashes).toHaveProperty('packageJson');
    expect(artifact.sourceHashes).toHaveProperty('agents');
    expect(artifact.sourceHashes).toHaveProperty('manifest');
    expect(rebuilt.sourceHashes).toEqual(artifact.sourceHashes);
    expect(changed.sourceHashes.manifest).not.toBe(
      artifact.sourceHashes.manifest,
    );
  });

  it('omits moduleDocs when AGENTS.md links no sibling docs', () => {
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.moduleDocs).toBeUndefined();
    expect(
      Object.keys(artifact.sourceHashes).filter((key) =>
        key.startsWith('moduleDoc:'),
      ),
    ).toEqual([]);
  });

  it('loads and hashes the module docs AGENTS.md links (#2108)', () => {
    writeModuleDocs(rootDir);
    const artifact = buildFixtureArtifact(rootDir);

    expect(artifact.moduleDocs).toEqual([
      expect.objectContaining({
        path: 'agents/payouts.md',
        module: 'payouts',
        content: expect.stringContaining('claimForPayout never double-owns'),
      }),
      expect.objectContaining({ path: 'agents/crm.md', module: 'crm' }),
    ]);
    expect(artifact.sourceHashes).toHaveProperty('moduleDoc:agents/payouts.md');
    expect(artifact.sourceHashes).toHaveProperty('moduleDoc:agents/crm.md');
  });

  it('still hashes module docs when doc bodies are excluded', () => {
    writeModuleDocs(rootDir);
    const artifact = buildDomainKnowledgeManifest({
      manifest: fixtureManifest(),
      rootDir,
      config: { includeDocs: false },
    });

    expect(artifact.agentDoc).toBeUndefined();
    expect(artifact.moduleDocs).toBeUndefined();
    expect(artifact.sourceHashes).toHaveProperty('moduleDoc:agents/payouts.md');
  });
});

describe('resolveAgentModuleDocPaths', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-module-docs-'));
    mkdirSync(join(rootDir, 'agents'), { recursive: true });
    writeFileSync(join(rootDir, 'agents', 'payouts.md'), '# payouts\n');
    writeFileSync(join(rootDir, 'AGENTS.md'), '# pkg\n');
    writeFileSync(join(rootDir, 'CLAUDE.md'), '@AGENTS.md');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('accepts a link to an existing file inside the package, once', () => {
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        '[a](agents/payouts.md) and again [b](agents/payouts.md)',
      ),
    ).toEqual(['agents/payouts.md']);
  });

  it('tolerates an anchor and a link title', () => {
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        '[a](agents/payouts.md#claims) [b](agents/payouts.md "Payouts")',
      ),
    ).toEqual(['agents/payouts.md']);
  });

  it('ignores non-links, missing files, and remote targets', () => {
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        'see `agents/payouts.md`, [gone](agents/missing.md), [x](https://e.dev/a.md)',
      ),
    ).toEqual([]);
  });

  it('ignores links that escape the package or point back at the chain', () => {
    // A cross-package doc belongs to that package's own instruction chain, and
    // re-including AGENTS.md/CLAUDE.md would double-count the chain itself.
    expect(
      resolveAgentModuleDocPaths(
        rootDir,
        '[o](../other/AGENTS.md) [s](AGENTS.md) [c](CLAUDE.md)',
      ),
    ).toEqual([]);
  });

  it('returns nothing without an agent doc', () => {
    expect(resolveAgentModuleDocPaths(rootDir, undefined)).toEqual([]);
  });
});

function writeModuleDocs(rootDir: string): void {
  mkdirSync(join(rootDir, 'agents'), { recursive: true });
  writeFileSync(
    join(rootDir, 'agents', 'payouts.md'),
    '# payouts\n\n`claimForPayout never double-owns` a row.\n',
  );
  writeFileSync(
    join(rootDir, 'agents', 'crm.md'),
    '# crm\n\nLeads and pipelines.\n',
  );
  writeFileSync(
    join(rootDir, 'AGENTS.md'),
    [
      '# Orders',
      '',
      'Review payment and tenant boundaries.',
      '',
      '| Module | Module doc |',
      '|---|---|',
      '| payouts | [agents/payouts.md](agents/payouts.md) |',
      '| crm | [agents/crm.md](agents/crm.md) |',
    ].join('\n'),
  );
}

function buildFixtureArtifact(rootDir: string) {
  return buildDomainKnowledgeManifest({
    manifest: fixtureManifest(),
    rootDir,
    manifestPath: join(rootDir, '.smrt', 'manifest.json'),
    config: {
      tags: ['commerce'],
      summary: 'Order package',
      risks: ['Ledger integration'],
    },
  });
}

function fixtureManifest(): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 1,
    packageName: '@example/orders',
    packageVersion: '1.0.0',
    objects: {
      '@example/orders:Order': {
        className: 'Order',
        qualifiedName: '@example/orders:Order',
        collection: 'orders',
        fields: {
          tenantId: {
            type: 'foreignKey',
            required: true,
            related: 'Tenant',
          },
          profileId: {
            type: 'crossPackageRef',
            related: '@happyvertical/smrt-profiles:Profile',
          },
          attempts: {
            type: 'integer',
            default: 0,
            min: 0,
            max: 3,
            readonly: true,
          },
          active: { type: 'boolean', default: false },
          reference: {
            type: 'text',
            _meta: {
              minLength: 2,
              maxLength: 24,
              pattern: { source: '^[A-Z]+' },
            },
          },
          preview: { type: 'text', _meta: { transient: true } },
          secretId: {
            type: 'foreignKey',
            related: 'Secret',
            sensitive: true,
          },
          legacySecretId: {
            type: 'foreignKey',
            related: 'LegacySecret',
            _meta: { sensitive: true },
          },
          apiTokenID: { type: 'text', _meta: { sensitive: true } },
        },
        methods: {
          approve: {
            name: 'approve',
            async: true,
            parameters: [
              {
                name: 'reason',
                type: 'string',
                optional: true,
              },
            ],
            returnType: 'Promise<void>',
            isStatic: true,
            isPublic: true,
          },
        },
        decoratorConfig: {
          api: true,
          cli: { include: ['approve'] },
          mcp: { include: ['get', 'approve'] },
          tenantScoped: true,
          tableStrategy: 'sti',
          conflictColumns: [
            'tenant_id',
            'profile_id',
            'secret_id',
            'legacy_secret_id',
            'api_token_i_d',
          ],
          knowledge: {
            tags: ['payments'],
            summary: 'Order aggregate',
            risks: ['Payment state transitions are sensitive'],
          },
        },
        extends: 'SmrtObject',
        schema: {
          tableName: 'orders',
          columns: {
            id: { type: 'UUID' },
            tenant_id: { type: 'UUID' },
            profile_id: { type: 'UUID' },
          },
        },
      },
      '@example/orders:OrderLinks': {
        className: 'OrderLinks',
        qualifiedName: '@example/orders:OrderLinks',
        collection: 'order_links',
        fields: {
          orderId: { type: 'foreignKey', related: 'Order', required: true },
          itemId: { type: 'foreignKey', related: 'Item', required: true },
        },
        methods: {},
        decoratorConfig: { conflictColumns: ['order_id', 'item_id'] },
        extends: 'SmrtJunction',
      },
      '@example/orders:OrderTree': {
        className: 'OrderTree',
        qualifiedName: '@example/orders:OrderTree',
        collection: 'order_trees',
        fields: {},
        methods: {
          archive: {
            name: 'archive',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
          internalRebalance: {
            name: 'internalRebalance',
            async: false,
            parameters: [],
            returnType: 'void',
            isStatic: false,
            isPublic: false,
          },
          findByReference: {
            name: 'findByReference',
            async: true,
            parameters: [],
            returnType: 'Promise<OrderTree | null>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtHierarchical',
      },
      '@example/orders:OrderTreeCollection': {
        className: 'OrderTreeCollection',
        qualifiedName: '@example/orders:OrderTreeCollection',
        collection: 'order_trees',
        fields: {},
        methods: {
          findAbandoned: {
            name: 'findAbandoned',
            async: true,
            parameters: [],
            returnType: 'Promise<OrderTree[]>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtCollection',
        extendsTypeArg: 'OrderTree',
      },
      '@example/orders:SpecialOrderTreeCollection': {
        className: 'SpecialOrderTreeCollection',
        qualifiedName: '@example/orders:SpecialOrderTreeCollection',
        collection: 'order_trees',
        fields: {},
        methods: {
          findEscalated: {
            name: 'findEscalated',
            async: true,
            parameters: [],
            returnType: 'Promise<OrderTree[]>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        // A deeper collection subclass carries no `extendsTypeArg` of its
        // own — only its `OrderTreeCollection` base does. Recognizing it as
        // a collection class requires walking the extends chain (#2619).
        extends: 'OrderTreeCollection',
        extendsQualified: '@example/orders:OrderTreeCollection',
      },
      '@example/orders:HiddenOrder': {
        className: 'HiddenOrder',
        qualifiedName: '@example/orders:HiddenOrder',
        collection: 'hidden_orders',
        fields: {},
        methods: {},
        decoratorConfig: { knowledge: false },
        extends: 'SmrtObject',
      },
      // A foundation package (e.g. `@happyvertical/smrt-core` itself)
      // declares its own framework base classes as real local classes, so
      // the scanner emits a manifest entry for them too — with
      // `decoratorConfig: {}`, indistinguishable in shape from a genuine
      // bare `@smrt()`. They carry no decorator of their own, but ARE
      // registered by `loadAllManifests()` like any genuine domain class
      // (#2642) — excluded from every surface by class identity, not by
      // registration status.
      '@happyvertical/smrt-core:SmrtObject': {
        className: 'SmrtObject',
        qualifiedName: '@happyvertical/smrt-core:SmrtObject',
        packageName: '@happyvertical/smrt-core',
        collection: 'smrtobjects',
        fields: {},
        methods: {
          describe: {
            name: 'describe',
            async: true,
            parameters: [],
            returnType: 'Promise<string>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtClass',
      },
      // `SmrtReport`/`SmrtReportCollection` are framework base classes too,
      // but declared in `@happyvertical/smrt-reports`, not
      // `@happyvertical/smrt-core` — the owning package is per-name (#2619).
      '@happyvertical/smrt-reports:SmrtReport': {
        className: 'SmrtReport',
        qualifiedName: '@happyvertical/smrt-reports:SmrtReport',
        packageName: '@happyvertical/smrt-reports',
        collection: 'smrtreports',
        fields: {},
        methods: {
          summarize: {
            name: 'summarize',
            async: true,
            parameters: [],
            returnType: 'Promise<string>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtObject',
      },
      // A same-named, unrelated class in a THIRD package must never be
      // mistaken for the real framework base — the map lookup is keyed on
      // (className, packageName) together, not className alone.
      '@example/other-pkg:SmrtObject': {
        className: 'SmrtObject',
        qualifiedName: '@example/other-pkg:SmrtObject',
        packageName: '@example/other-pkg',
        collection: 'smrtobjects',
        fields: {},
        methods: {},
        decoratorConfig: {},
      },
      // A model whose custom action carries an explicit `routes` override:
      // the emitted path/method must follow that override, not the derived
      // defaults (#2619).
      '@example/orders:RoutedOrder': {
        className: 'RoutedOrder',
        qualifiedName: '@example/orders:RoutedOrder',
        collection: 'routed_orders',
        fields: {},
        methods: {
          exportCsv: {
            name: 'exportCsv',
            async: true,
            parameters: [],
            returnType: 'Promise<string>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {
          api: {
            include: ['exportCsv'],
            routes: { exportCsv: { method: 'GET', path: 'export-csv' } },
          },
        },
        extends: 'SmrtObject',
      },
      // A collection-level `api.path` that differs from `collection`. The
      // SvelteKit generator and the runtime dispatcher both ignore this field
      // (it configures smrt-agents' route map instead), so the emitted path
      // must use `collection` verbatim (#2630).
      '@example/orders:LegacyPathOrder': {
        className: 'LegacyPathOrder',
        qualifiedName: '@example/orders:LegacyPathOrder',
        collection: 'legacy_orders',
        fields: {},
        methods: {
          reconcile: {
            name: 'reconcile',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: { api: { path: 'orders-v1' } },
        extends: 'SmrtObject',
      },
      // `effect: 'read'` on a DELETE route makes the shared custom-action
      // resolver throw by design. The knowledge build must not die for the
      // whole package because one action's config is wrong (#2619).
      '@example/orders:ThrowingRouteOrder': {
        className: 'ThrowingRouteOrder',
        qualifiedName: '@example/orders:ThrowingRouteOrder',
        collection: 'throwing_route_orders',
        fields: {},
        methods: {
          purge: {
            name: 'purge',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {
          api: { routes: { purge: { effect: 'read', method: 'DELETE' } } },
        },
        extends: 'SmrtObject',
      },
      // A malformed `include` (not an array) must be treated as unset,
      // never as a truthy value fed straight into `.includes()` — that
      // would either throw (no such method) or, for a string, silently do
      // substring matching instead of array membership (#2619).
      // #2646: a public method whose name lands on a CRUD verb in the MCP tool
      // namespace. `MCPGenerator` emits no separate tool for it, so the
      // knowledge projection must not report one either.
      '@example/orders:CasedVerbItem': {
        className: 'CasedVerbItem',
        qualifiedName: '@example/orders:CasedVerbItem',
        collection: 'cased_verb_items',
        fields: {},
        methods: {
          List: {
            name: 'List',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
          syncNow: {
            name: 'syncNow',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
      },
      // #2646: the same method reached through a strict include naming only the
      // cased verb. `mcp.include` fails closed on it and `shouldInclude('list')`
      // is exact, so the generator emits NO tool for this class at all.
      '@example/orders:CasedIncludeItem': {
        className: 'CasedIncludeItem',
        qualifiedName: '@example/orders:CasedIncludeItem',
        collection: 'cased_include_items',
        fields: {},
        methods: {
          List: {
            name: 'List',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: { mcp: { include: ['List'] } },
      },
      '@example/orders:MalformedConfigItem': {
        className: 'MalformedConfigItem',
        qualifiedName: '@example/orders:MalformedConfigItem',
        collection: 'malformed_config_items',
        fields: {},
        methods: {
          exportData: {
            name: 'exportData',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: { mcp: { include: 'list' as unknown as string[] } },
      },
      // A locally overridden framework lifecycle method (mirroring
      // User.save() at packages/users/src/models/User.ts) must not be
      // reported as a `cli` or `mcp` custom-action surface, matching
      // packages/cli's CLIGenerator.listCommands()'s and MCPGenerator.generateTools()'s
      // isFrameworkLifecycleMethod() gate (#2657, #2638) -- but `api` is
      // unaffected, since that generator did not change.
      '@example/orders:LifecycleOverrideOrder': {
        className: 'LifecycleOverrideOrder',
        qualifiedName: '@example/orders:LifecycleOverrideOrder',
        collection: 'lifecycle_override_orders',
        fields: {},
        methods: {
          save: {
            name: 'save',
            async: true,
            parameters: [],
            returnType: 'Promise<this>',
            isStatic: false,
            isPublic: true,
          },
          reconcile: {
            name: 'reconcile',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
        extends: 'SmrtObject',
      },
      // Two distinct, legitimate non-CRUD methods differing only in case.
      // `MCPGenerator` folds both onto the tool id
      // `casecollisionitem_refresh` and reports it once, keeping whichever
      // was declared first (#2638, moved from #2648) -- the projection must
      // mirror that, not report both method names as separate `mcp`
      // operations.
      '@example/orders:CaseCollisionItem': {
        className: 'CaseCollisionItem',
        qualifiedName: '@example/orders:CaseCollisionItem',
        collection: 'case_collision_items',
        fields: {},
        methods: {
          Refresh: {
            name: 'Refresh',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
          refresh: {
            name: 'refresh',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: {},
      },
      // `exclude` names the method in the OPPOSITE case from how it is
      // declared. MCP tool ids are case-folded, so `MCPGenerator` now
      // compares `exclude` case-insensitively too (#2638) -- the projection
      // must not still advertise `Refresh` as an `mcp` operation here.
      '@example/orders:ExcludeCaseItem': {
        className: 'ExcludeCaseItem',
        qualifiedName: '@example/orders:ExcludeCaseItem',
        collection: 'exclude_case_items',
        fields: {},
        methods: {
          Refresh: {
            name: 'Refresh',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
          syncNow: {
            name: 'syncNow',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: { mcp: { exclude: ['refresh'] } },
      },
    },
  };
}
