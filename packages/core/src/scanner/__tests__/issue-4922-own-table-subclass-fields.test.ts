/**
 * #4922: a subclass of an own-table (CTI) class carries its concrete
 * ancestors' fields in its own table definition, for a same-named subclass
 * (parent resolved through a dependency manifest) and a differently named
 * one. The nearest declaration wins; the subclass's own declaration wins over
 * all. STI families and framework abstract bases keep their existing rules.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { ManifestGenerator } from '../manifest-generator';
import type {
  FieldDefinition,
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../types';

const { PROVIDER, APP, providerManifests } = vi.hoisted(() => ({
  PROVIDER: '@test4922/provider',
  APP: '@test4922/app',
  providerManifests: {} as Record<string, unknown>,
}));

vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  loadExternalManifestSync: vi.fn(
    (packageName: string) => providerManifests[packageName] ?? null,
  ),
}));

type Fields = Record<string, FieldDefinition>;

function def(
  packageName: string,
  className: string,
  fields: Fields,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${packageName}/src/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: {},
    packageName,
    ...extra,
  } as SmartObjectDefinition;
}

function generate(
  packageName: string,
  objects: SmartObjectDefinition[],
  smrtDependencies: string[] = [],
): SmartObjectManifest {
  const scanResults: ScanResult[] = [
    { filePath: `/${packageName}/src`, objects, errors: [] },
  ];
  return new ManifestGenerator().generateManifest(scanResults, {
    packageName,
    smrtDependencies,
  });
}

const CUSTOMER_FIELDS: Fields = {
  name: { type: 'text', required: true },
  phone: { type: 'text' },
};

describe('#4922 manifest: own-table subclass fields (row 1)', () => {
  it('a same-named subclass resolved through a dependency manifest carries the parent fields, its override winning', () => {
    providerManifests[PROVIDER] = generate(PROVIDER, [
      def(PROVIDER, 'Customer', CUSTOMER_FIELDS, { extends: 'SmrtObject' }),
    ]);
    const app = generate(
      APP,
      [
        def(
          APP,
          'Customer',
          {
            phone: { type: 'text', required: true },
            loyaltyTier: { type: 'text', required: true },
          },
          { extends: 'Customer', extendsQualified: `${PROVIDER}:Customer` },
        ),
      ],
      [PROVIDER],
    );
    const child = app.objects[`${APP}:Customer`];
    expect(Object.keys(child.fields).sort()).toEqual([
      'loyaltyTier',
      'name',
      'phone',
    ]);
    expect(child.fields.name.required).toBe(true);
    expect(child.fields.phone.required).toBe(true);
    expect(child.schema?.columns.name).toBeDefined();
    expect(child.schema?.columns.loyalty_tier).toBeDefined();
  });

  it('a differently named subclass in the same manifest carries the parent fields', () => {
    const manifest = generate(APP, [
      def(APP, 'Customer', CUSTOMER_FIELDS, { extends: 'SmrtObject' }),
      def(
        APP,
        'VipCustomer',
        { accountManager: { type: 'text' } },
        { extends: 'Customer' },
      ),
    ]);
    const vip = manifest.objects[`${APP}:VipCustomer`];
    expect(Object.keys(vip.fields).sort()).toEqual([
      'accountManager',
      'name',
      'phone',
    ]);
    expect(vip.schema?.tableName).toBe('vip_customers');
    expect(Object.keys(vip.schema?.columns ?? {})).toEqual(
      expect.arrayContaining(['name', 'phone', 'account_manager']),
    );
    // The parent is untouched.
    expect(
      Object.keys(manifest.objects[`${APP}:Customer`].fields).sort(),
    ).toEqual(['name', 'phone']);
  });

  it('a three-level chain: the nearest declaration wins, the subclass wins over all', () => {
    const manifest = generate(APP, [
      def(
        APP,
        'Base',
        { code: { type: 'text' }, label: { type: 'text', required: true } },
        { extends: 'SmrtObject' },
      ),
      def(
        APP,
        'Middle',
        { label: { type: 'text' }, middleOnly: { type: 'text' } },
        { extends: 'Base' },
      ),
      def(
        APP,
        'Leaf',
        { code: { type: 'integer' }, leafOnly: { type: 'text' } },
        { extends: 'Middle' },
      ),
    ]);
    const leaf = manifest.objects[`${APP}:Leaf`];
    expect(Object.keys(leaf.fields).sort()).toEqual([
      'code',
      'label',
      'leafOnly',
      'middleOnly',
    ]);
    // Middle's `label` (not required) replaces Base's (required).
    expect(leaf.fields.label.required).toBeFalsy();
    // Leaf's own `code` wins over Base's.
    expect(leaf.fields.code.type).toBe('integer');
  });

  it('an unresolvable parent adds nothing and does not throw', () => {
    const manifest = generate(APP, [
      def(
        APP,
        'Orphan',
        { own: { type: 'text' } },
        {
          extends: 'NotInstalled',
          extendsQualified: '@missing/pkg:NotInstalled',
        },
      ),
    ]);
    expect(Object.keys(manifest.objects[`${APP}:Orphan`].fields)).toEqual([
      'own',
    ]);
  });

  it('a subclass restating every parent field keeps each column once and unchanged', () => {
    const restated = generate(APP, [
      def(APP, 'Customer', CUSTOMER_FIELDS, { extends: 'SmrtObject' }),
      def(
        APP,
        'Gold',
        { ...CUSTOMER_FIELDS, tier: { type: 'text' } },
        { extends: 'Customer' },
      ),
    ]);
    const gold = restated.objects[`${APP}:Gold`];
    expect(Object.keys(gold.fields).sort()).toEqual(['name', 'phone', 'tier']);
    const columns = Object.keys(gold.schema?.columns ?? {});
    expect(columns.filter((c) => c === 'name')).toHaveLength(1);
  });

  it('keeps the STI rule: the oldest owner keeps storage', () => {
    const manifest = generate(APP, [
      def(
        APP,
        'Doc',
        { title: { type: 'text', required: true } },
        { extends: 'SmrtObject', decoratorConfig: { tableStrategy: 'sti' } },
      ),
      def(APP, 'Memo', { title: { type: 'text' } }, { extends: 'Doc' }),
      def(APP, 'Note', { body: { type: 'text' } }, { extends: 'Memo' }),
    ]);
    // Note does not redeclare `title`: the oldest owner's declaration stays.
    expect(manifest.objects[`${APP}:Note`].fields.title.required).toBe(true);
  });

  it('keeps the SmrtHierarchical parentId bound to the subclass itself', () => {
    const manifest = generate(APP, [
      def(
        APP,
        'SmrtHierarchical',
        { parentId: { type: 'text' } },
        { extends: 'SmrtObject' },
      ),
      def(
        APP,
        'Category',
        { title: { type: 'text' } },
        { extends: 'SmrtHierarchical' },
      ),
      def(
        APP,
        'SubCategory',
        { extra: { type: 'text' } },
        { extends: 'Category' },
      ),
    ]);
    const sub = manifest.objects[`${APP}:SubCategory`];
    expect(sub.fields.parentId.related).toBe('SubCategory');
    expect(sub.fields.title).toBeDefined();
  });
});

describe('#4922 registry: getFields and getAllSchemasAsDefinitions (row 2)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  async function loadSameNamed(order: 'provider-first' | 'app-first') {
    const { ObjectRegistry } = await import('../../registry.js');
    ObjectRegistry.clear();
    const provider = generate(PROVIDER, [
      def(PROVIDER, 'Customer', CUSTOMER_FIELDS, { extends: 'SmrtObject' }),
    ]);
    providerManifests[PROVIDER] = provider;
    const app = generate(
      APP,
      [
        def(
          APP,
          'Customer',
          {
            phone: { type: 'text', required: true },
            loyaltyTier: { type: 'text', required: true },
          },
          { extends: 'Customer', extendsQualified: `${PROVIDER}:Customer` },
        ),
      ],
      [PROVIDER],
    );
    const register = (m: SmartObjectManifest) => {
      for (const [name, obj] of Object.entries(m.objects)) {
        ObjectRegistry.registerFromManifest(name, obj, m.packageName);
      }
    };
    if (order === 'provider-first') {
      register(provider);
      register(app);
    } else {
      register(app);
      register(provider);
    }
    return ObjectRegistry;
  }

  it.each([
    'provider-first',
    'app-first',
  ] as const)('a same-named subclass has the inherited fields and one table (%s)', async (order) => {
    const registry = await loadSameNamed(order);
    const fields = registry.getFields(`${APP}:Customer`);
    expect([...fields.keys()]).toEqual(
      expect.arrayContaining(['name', 'phone', 'loyaltyTier']),
    );
    const schemas = registry.getAllSchemasAsDefinitions();
    const customers = schemas.customers;
    expect(customers).toBeDefined();
    expect(customers.columns.name).toBeDefined();
    expect(customers.columns.phone.notNull).toBe(true);
    expect(customers.columns.loyalty_tier.notNull).toBe(true);
    expect(
      Object.keys(schemas).filter((table) => table === 'customers'),
    ).toHaveLength(1);
  });

  // The consumer shape of smrt-vitest's #2970 fixture: core's framework base
  // arrives through a manifest, and the app class reaches the registry only
  // through manifest registration.
  async function loadHierarchy() {
    const { ObjectRegistry } = await import('../../registry.js');
    ObjectRegistry.clear();
    const CORE = '@happyvertical/smrt-core';
    const core = generate(CORE, [
      def(
        CORE,
        'SmrtHierarchical',
        { parentId: { type: 'text' } },
        { extends: 'SmrtObject' },
      ),
    ]);
    providerManifests[CORE] = core;
    const app = generate(
      APP,
      [
        def(
          APP,
          'TreeNode',
          { label: { type: 'text' } },
          {
            extends: 'SmrtHierarchical',
            extendsQualified: `${CORE}:SmrtHierarchical`,
          },
        ),
        def(
          APP,
          'Branch',
          { depth: { type: 'integer' } },
          { extends: 'TreeNode' },
        ),
      ],
      [CORE],
    );
    for (const manifest of [core, app]) {
      for (const [name, obj] of Object.entries(manifest.objects)) {
        ObjectRegistry.registerFromManifest(name, obj, manifest.packageName);
      }
    }
    return ObjectRegistry;
  }

  it('a class that extends only a framework abstract base builds its schema as before', async () => {
    const registry = await loadHierarchy();
    const schemas = registry.getAllSchemasAsDefinitions();
    expect(schemas.tree_nodes.columns.parent_id).toBeDefined();
    expect(schemas.tree_nodes.columns.label).toBeDefined();
    expect(schemas.tree_nodes.columns.parent_id.foreignKey?.table).toBe(
      'tree_nodes',
    );
  });

  it('a concrete subclass of a hierarchical class binds parentId to its own table', async () => {
    const registry = await loadHierarchy();
    const branches = registry.getAllSchemasAsDefinitions().branches;
    expect(Object.keys(branches.columns)).toEqual(
      expect.arrayContaining(['parent_id', 'label', 'depth']),
    );
    expect(branches.columns.parent_id.foreignKey?.table).toBe('branches');
  });

  it('a differently named subclass table holds the inherited columns', async () => {
    const { ObjectRegistry } = await import('../../registry.js');
    ObjectRegistry.clear();
    const manifest = generate(APP, [
      def(APP, 'Customer', CUSTOMER_FIELDS, { extends: 'SmrtObject' }),
      def(
        APP,
        'VipCustomer',
        { accountManager: { type: 'text' } },
        { extends: 'Customer' },
      ),
    ]);
    for (const [name, obj] of Object.entries(manifest.objects)) {
      ObjectRegistry.registerFromManifest(name, obj, APP);
    }
    const vip = ObjectRegistry.getAllSchemasAsDefinitions().vip_customers;
    expect(Object.keys(vip.columns)).toEqual(
      expect.arrayContaining(['name', 'phone', 'account_manager']),
    );
  });
});

describe('#4922 persistence of inherited values (row 4)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('a differently named subclass stores and reads back an inherited field', async () => {
    const { ObjectRegistry } = await import('../../registry.js');
    ObjectRegistry.clear();
    const manifest = generate(APP, [
      def(APP, 'Customer', CUSTOMER_FIELDS, { extends: 'SmrtObject' }),
      def(
        APP,
        'VipCustomer',
        { accountManager: { type: 'text' } },
        { extends: 'Customer' },
      ),
    ]);
    for (const [name, obj] of Object.entries(manifest.objects)) {
      ObjectRegistry.registerFromManifest(name, obj, APP);
    }
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    const strategy = getDDLStrategy('sqlite');
    await db.query(strategy.generateCreateTable(schemas.vip_customers));

    const vips = await ObjectRegistry.getCollection(`${APP}:VipCustomer`, {
      db,
    });
    const created = await (
      vips as unknown as {
        create(data: Record<string, unknown>): Promise<{ id: string }>;
      }
    ).create({ name: 'Ada', phone: '555', accountManager: 'Grace' });
    await (created as unknown as { save(): Promise<unknown> }).save();
    const rows = (
      await db.query('SELECT name, phone, account_manager FROM vip_customers')
    ).rows;
    expect(rows).toEqual([
      { name: 'Ada', phone: '555', account_manager: 'Grace' },
    ]);
    const reread = (await (
      vips as unknown as { get(id: string): Promise<{ name: string }> }
    ).get(created.id)) as { name: string };
    expect(reread.name).toBe('Ada');
  });
});

describe('#4922 decorated own-table subclass (row 3)', () => {
  it('getTestDatabase builds the inherited columns for a decorated subclass', async () => {
    const [{ SmrtObject }, { smrt }, { field }, { getTestDatabase }] =
      await Promise.all([
        import('../../object.js'),
        import('../../registry.js'),
        import('../../decorators/index.js'),
        import('../../testing/database.js'),
      ]);
    const restoreRegistry = snapshotObjectRegistryState();
    try {
      @smrt({ tableName: 't4922_own_base' })
      class OwnBase4922 extends SmrtObject {
        @field({ required: true }) label = '';
      }
      @smrt({ tableName: 't4922_own_child' })
      class OwnChild4922 extends OwnBase4922 {
        @field() extra = '';
      }
      const db = await getTestDatabase({
        classes: ['OwnBase4922', 'OwnChild4922'],
      });
      const cols = (
        await db.query('SELECT name FROM pragma_table_info(?)', [
          't4922_own_child',
        ])
      ).rows.map((r: Record<string, unknown>) => String(r.name));
      expect(cols).toEqual(expect.arrayContaining(['label', 'extra']));
      const { ObjectRegistry } = await import('../../registry.js');
      const migrate = ObjectRegistry.getAllSchemasAsDefinitions();
      expect(Object.keys(migrate.t4922_own_child.columns)).toEqual(
        expect.arrayContaining(['label', 'extra']),
      );
    } finally {
      restoreRegistry();
    }
  });
});

describe('#4922 registry replaces concrete declarations like the manifest path (r2)', () => {
  type ColumnView = { notNull: boolean; type: string };
  type FieldSpec = Record<string, unknown> | null;

  /** One decorated chain, run through both registry schema paths. */
  async function registryColumns(
    levels: Array<Record<string, FieldSpec>>,
    column: string,
  ): Promise<{ migrate: ColumnView; testDb: ColumnView }> {
    const [{ SmrtObject }, { smrt }, { field }, { getTestDatabase }] =
      await Promise.all([
        import('../../object.js'),
        import('../../registry.js'),
        import('../../decorators/index.js'),
        import('../../testing/database.js'),
      ]);
    const { ObjectRegistry } = await import('../../registry.js');
    const restoreRegistry = snapshotObjectRegistryState();
    try {
      const suffix = `${levels.length}_${Math.random().toString(36).slice(2, 8)}`;
      const names: string[] = [];
      let parent: typeof SmrtObject = SmrtObject;
      levels.forEach((fields, index) => {
        const name = `R2Level${index}_${suffix}`;
        const ctor = class extends parent {};
        Object.defineProperty(ctor, 'name', { value: name });
        for (const [fieldName, spec] of Object.entries(fields)) {
          if (spec === null) continue;
          field(spec)(ctor.prototype, fieldName);
        }
        smrt({ tableName: `r2_${index}_${suffix}` })(ctor);
        names.push(name);
        parent = ctor as typeof SmrtObject;
      });
      const leaf = names.at(-1) as string;
      const table = `r2_${levels.length - 1}_${suffix}`;
      const schema = ObjectRegistry.getAllSchemasAsDefinitions()[table];
      const migrateColumn = schema.columns[column];
      const db = await getTestDatabase({ classes: names });
      const info = (
        await db.query(
          'SELECT name, type, "notnull" AS nn FROM pragma_table_info(?)',
          [table],
        )
      ).rows.find((row: Record<string, unknown>) => row.name === column) as
        | { type: string; nn: number }
        | undefined;
      expect(leaf).toBeDefined();
      return {
        migrate: {
          notNull: migrateColumn?.notNull === true,
          type: String(migrateColumn?.type).toUpperCase(),
        },
        testDb: {
          notNull: info?.nn === 1,
          type: String(info?.type).toUpperCase(),
        },
      };
    } finally {
      restoreRegistry();
    }
  }

  /** The manifest path for the same chain. */
  function manifestColumn(
    levels: Array<Record<string, FieldDefinition>>,
    column: string,
  ): ColumnView {
    const objects = levels.map((fields, index) =>
      def(
        APP,
        `R2Level${index}`,
        fields,
        index === 0
          ? { extends: 'SmrtObject' }
          : { extends: `R2Level${index - 1}` },
      ),
    );
    const manifest = generate(APP, objects);
    const col =
      manifest.objects[`${APP}:R2Level${levels.length - 1}`].schema?.columns[
        column
      ];
    return {
      notNull: col?.notNull === true,
      type: String(col?.type).toUpperCase(),
    };
  }

  it('an explicit required:false parent tightened by the child is NOT NULL on every path', async () => {
    const registry = await registryColumns(
      [{ code: { required: false } }, { code: { required: true } }],
      'code',
    );
    const manifest = manifestColumn(
      [
        { code: { type: 'text', required: false } },
        { code: { type: 'text', required: true } },
      ],
      'code',
    );
    expect(manifest.notNull).toBe(true);
    expect(registry.migrate.notNull).toBe(true);
    expect(registry.testDb.notNull).toBe(true);
  });

  it('a required parent relaxed by the child is nullable on every path', async () => {
    const registry = await registryColumns(
      [{ code: { required: true } }, { code: { required: false } }],
      'code',
    );
    const manifest = manifestColumn(
      [
        { code: { type: 'text', required: true } },
        { code: { type: 'text', required: false } },
      ],
      'code',
    );
    expect(manifest.notNull).toBe(false);
    expect(registry.migrate.notNull).toBe(false);
    expect(registry.testDb.notNull).toBe(false);
  });

  it("a parent's explicit sqlType does not survive a child redeclaring the type", async () => {
    const registry = await registryColumns(
      [{ code: { sqlType: 'text' } }, { code: { type: 'integer' } }],
      'code',
    );
    const manifest = manifestColumn(
      [
        { code: { type: 'text', _meta: { sqlType: 'text' } } },
        { code: { type: 'integer' } },
      ],
      'code',
    );
    expect(manifest.type).toBe('INTEGER');
    expect(registry.migrate.type).toBe('INTEGER');
    expect(registry.testDb.type).toBe('INTEGER');
  });

  it('a middle class redeclaring a field without `required` relaxes it for the leaf on every path', async () => {
    const registry = await registryColumns(
      [{ label: { required: true } }, { label: {} }, {}],
      'label',
    );
    const manifest = manifestColumn(
      [
        { label: { type: 'text', required: true } },
        { label: { type: 'text' } },
        {},
      ],
      'label',
    );
    expect(manifest.notNull).toBe(false);
    expect(registry.migrate.notNull).toBe(false);
    expect(registry.testDb.notNull).toBe(false);
  });
});
