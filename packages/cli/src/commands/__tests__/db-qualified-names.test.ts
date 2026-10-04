/**
 * `smrt doctor --db`'s deprecated-qualified-name section and
 * `smrt db:migrate-qualified-names` (#3338), against a REAL SQLite database.
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { SmartObjectDefinition } from '@happyvertical/smrt-core/scanner';
import { getDatabase } from '@happyvertical/sql';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { requireCommandHandler } from '../../__tests__/command-handler.js';
import {
  dbMigrateQualifiedNamesCommand,
  formatLegacyQualifiedNameReport,
  runLegacyQualifiedNameReport,
} from '../db-qualified-names.js';
import { utilityCommands } from '../utilities.js';

const PKG = '@test-3338/cli-app';
const CURRENT = `${PKG}:MovedOwner`;
const OLD = '@test-3338/cli-old-owner:MovedOwner';

function def(
  className: string,
  tableName: string,
  fields: SmartObjectDefinition['fields'],
  extra: Partial<SmartObjectDefinition['decoratorConfig']> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `cli-app/src/${className}.ts`,
    packageName: PKG,
    fields,
    methods: {},
    decoratorConfig: { tableName, ...extra },
    exportName: className,
    collectionExportName: `${className}Collection`,
  };
}

describe('deprecated qualified-name references (#3338)', () => {
  let dbUrl: string;

  beforeAll(() => {
    ObjectRegistry.registerFromManifest(
      CURRENT,
      def(
        'MovedOwner',
        'cli_3338_moved_owners',
        {},
        {
          previousQualifiedNames: [OLD],
        },
      ),
      PKG,
    );
    ObjectRegistry.registerFromManifest(
      `${PKG}:OwnerLink`,
      def('OwnerLink', 'cli_3338_owner_links', {
        metaType: { type: 'text', required: true },
        metaId: { type: 'text', required: true },
        role: { type: 'text', required: true },
      }),
      PKG,
    );
  });

  beforeEach(async () => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `qualified-names-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [],
      totalObjects: 0,
    });
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      await db.query(
        'CREATE TABLE cli_3338_owner_links (id TEXT PRIMARY KEY, meta_type TEXT, meta_id TEXT, role TEXT)',
      );
      await db.query(
        `INSERT INTO cli_3338_owner_links VALUES ('1', ?, 'a', 'hero'), ('2', ?, 'b', 'hero'), ('3', ?, 'c', 'hero')`,
        OLD,
        OLD,
        CURRENT,
      );
    } finally {
      await db.close?.();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
    rmSync(dbUrl, { force: true });
  });

  async function storedMetaTypes(): Promise<string[]> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      const result = await db.query(
        'SELECT meta_type FROM cli_3338_owner_links ORDER BY id',
      );
      return (result.rows as Array<{ meta_type: string }>).map(
        (row) => row.meta_type,
      );
    } finally {
      await db.close?.();
    }
  }

  it('doctor counts stored references by legacy name', async () => {
    const outcome = await runLegacyQualifiedNameReport({ discover: false });
    expect(outcome.error).toBeNull();
    expect(outcome.report?.total).toBe(2);
    const lines = formatLegacyQualifiedNameReport(
      outcome.report as NonNullable<typeof outcome.report>,
    ).join('\n');
    expect(lines).toContain(`${OLD} → ${CURRENT}`);
    expect(lines).toContain(
      `cli_3338_owner_links.meta_type = ${OLD}: 2 row(s)`,
    );
    expect(lines).toContain('smrt db:migrate-qualified-names');
  });

  it('doctor fails closed without a persistent database', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    });
    const outcome = await runLegacyQualifiedNameReport({ discover: false });
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('No persistent database is configured');
  });

  it('db:migrate-qualified-names is registered, dry-runs, then rewrites idempotently', async () => {
    expect(utilityCommands['db:migrate-qualified-names']).toBe(
      dbMigrateQualifiedNamesCommand,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await requireCommandHandler(dbMigrateQualifiedNamesCommand)([], {
      'dry-run': true,
    });
    expect(await storedMetaTypes()).toEqual([OLD, OLD, CURRENT]);

    await requireCommandHandler(dbMigrateQualifiedNamesCommand)([], {});
    expect(process.exitCode).toBeUndefined();
    expect(await storedMetaTypes()).toEqual([CURRENT, CURRENT, CURRENT]);

    log.mockClear();
    await requireCommandHandler(dbMigrateQualifiedNamesCommand)([], {});
    expect(log.mock.calls.flat().join('\n')).toContain('Already applied');

    const after = await runLegacyQualifiedNameReport({ discover: false });
    expect(after.report?.total).toBe(0);
    expect(
      formatLegacyQualifiedNameReport(
        after.report as NonNullable<typeof after.report>,
      ).join('\n'),
    ).toContain('No stored row in this database uses a deprecated name');
  });

  describe('formatLegacyQualifiedNameReport messaging', () => {
    const SOURCE_REMINDER =
      'source still naming an old qualified name (@crossPackageRef / relationship targets, playbook step models)';
    const base = {
      aliases: [{ alias: OLD, current: CURRENT }],
      references: [],
      total: 0,
      missingTables: [],
      untenantedTables: [],
    };

    it('a zero global count allows removal only after source references move', () => {
      const text = formatLegacyQualifiedNameReport(base).join('\n');
      expect(text).toContain(
        'No stored row in this database uses a deprecated name',
      );
      expect(text).toContain(SOURCE_REMINDER);
    });

    it('a zero tenant-scoped count never claims removal is safe and lists skipped tables', () => {
      const text = formatLegacyQualifiedNameReport(
        { ...base, untenantedTables: ['plain_links'] },
        { tenantId: 'tenant-a' },
      ).join('\n');
      expect(text).toContain('tenant tenant-a');
      expect(text).toContain(
        'Skipped (no tenant column, not counted): plain_links',
      );
      expect(text).not.toMatch(/can be removed|may be removed/);
      expect(text).toContain('Run without --tenant');
      expect(text).toContain(SOURCE_REMINDER);
    });

    it('a zero count with skipped tables never claims removal is safe', () => {
      const text = formatLegacyQualifiedNameReport({
        ...base,
        untenantedTables: ['plain_links'],
      }).join('\n');
      expect(text).toContain('plain_links');
      expect(text).not.toMatch(/can be removed|may be removed/);
    });

    it('a non-zero count keeps the aliases and reminds about source', () => {
      const text = formatLegacyQualifiedNameReport({
        ...base,
        total: 1,
        references: [
          {
            table: 'links',
            column: 'meta_type',
            kind: 'polymorphic',
            alias: OLD,
            current: CURRENT,
            count: 1,
          },
        ],
      }).join('\n');
      expect(text).toContain('keep the aliases until this count is zero');
      expect(text).toContain(SOURCE_REMINDER);
    });
  });
});
