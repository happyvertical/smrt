/**
 * #4948: built manifests carry package-relative `filePath`s, so two packages
 * that each declare a class with the same simple name at the same relative
 * path (`@a/ledgers` and `@a/messages` both have `Account` at
 * `src/models/Account.ts`) have equal paths. Registering both from their
 * manifests alone must keep both: the same-source-file skip is a consumer
 * manifest re-export of ONE package's class, never a collision between two.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SmartObjectDefinition } from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';

const LEDGERS = '@fixture/ledgers';
const MESSAGES = '@fixture/messages';
const SAME_PATH = 'src/models/Account.ts';

function accountDef(
  packageName: string,
  tableName: string,
  filePath: string | undefined = SAME_PATH,
): SmartObjectDefinition {
  return {
    name: 'account',
    className: 'Account',
    qualifiedName: `${packageName}:Account`,
    collection: 'accounts',
    filePath,
    packageName,
    fields: {
      label: { type: 'text', required: false },
    },
    methods: {},
    decoratorConfig: { tableName },
    schema: { tableName },
    exportName: 'Account',
    collectionExportName: 'AccountCollection',
  } as unknown as SmartObjectDefinition;
}

describe('#4948 same class name at the same relative path in two packages', () => {
  let restoreRegistry: () => void;
  let dir: string;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    dir = mkdtempSync(join(tmpdir(), 'smrt-4948-'));
  });

  afterEach(() => {
    restoreRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(
    packageName: string,
    tableName: string,
    filePath?: string,
  ): string {
    const path = join(dir, `${packageName.split('/')[1]}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: '1.0.0',
        timestamp: 0,
        packageName,
        objects: {
          [`${packageName}:Account`]: accountDef(
            packageName,
            tableName,
            filePath,
          ),
        },
      }),
    );
    return path;
  }

  const orders: Array<[string, string[]]> = [
    ['ledgers then messages', [LEDGERS, MESSAGES]],
    ['messages then ledgers', [MESSAGES, LEDGERS]],
  ];

  for (const [label, order] of orders) {
    it(`registers both from manifests only (${label})`, () => {
      const tables: Record<string, string> = {
        [LEDGERS]: 'ledger_accounts',
        [MESSAGES]: 'accounts',
      };
      const paths = order.map((pkg) => writeManifest(pkg, tables[pkg]));
      ObjectRegistry.loadAllManifests({ manifestPaths: paths });

      expect(
        ObjectRegistry.findClassesByName('Account')
          .map((c) => c.qualifiedName)
          .sort(),
      ).toEqual([`${LEDGERS}:Account`, `${MESSAGES}:Account`]);
      const names = Object.keys(ObjectRegistry.getAllSchemasAsDefinitions());
      expect(names).toContain('ledger_accounts');
      expect(names).toContain('accounts');
    });
  }

  it('still skips the same package arriving twice (consumer re-export)', () => {
    const def = accountDef(LEDGERS, 'ledger_accounts');
    ObjectRegistry.registerFromManifest(`${LEDGERS}:Account`, def, LEDGERS);
    // The consumer's aggregate copies the entry verbatim, under the consumer.
    ObjectRegistry.registerFromManifest(
      `${LEDGERS}:Account`,
      { ...def },
      '@fixture/consumer',
    );
    expect(ObjectRegistry.findClassesByName('Account')).toHaveLength(1);
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'ledger_accounts',
    ]);
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
  });

  it('still skips when the incoming entry names no package', () => {
    ObjectRegistry.registerFromManifest(
      `${LEDGERS}:Account`,
      accountDef(LEDGERS, 'ledger_accounts'),
      LEDGERS,
    );
    const anonymous = accountDef(LEDGERS, 'ledger_accounts');
    delete (anonymous as { packageName?: string }).packageName;
    delete (anonymous as { qualifiedName?: string }).qualifiedName;
    ObjectRegistry.registerFromManifest('Account', anonymous, undefined);
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'ledger_accounts',
    ]);
  });
});
