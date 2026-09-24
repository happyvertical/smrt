/**
 * #3106: a consumer package that declares its own `LicenseSale` next to
 * smrt-commerce's (ergot's `@ergot/market-core`, table `license_sales`, versus
 * commerce's `Contract` STI subtype on `contracts`).
 *
 * The consumer class lives in a workspace package laid out on disk — its own
 * `package.json`, TypeScript-free source, no manifest — so the registry
 * derives its package from where it is declared, as it does for a workspace
 * package consumed from source. The fixture module does not import smrt-core
 * (nothing resolves from a temp directory); it exports
 * `define({ smrt, SmrtObject })`, which applies the decorator inside the
 * fixture file.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ObjectRegistry,
  type SmrtObject,
  SmrtObject as SmrtObjectBase,
  smrt,
} from '@happyvertical/smrt-core';
import { expect } from 'vitest';
import { LicenseSale } from '../../models/Contract.js';
import { ContractStatus, ContractType } from '../../types/index.js';

export const CONSUMER_PACKAGE = '@fixture/market-core';

export async function defineConsumerLicenseSale(): Promise<{
  ctor: typeof SmrtObject;
  dispose: () => void;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-3106-')));
  const packageDir = join(root, 'packages/market-core');
  mkdirSync(join(packageDir, 'src/models'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: CONSUMER_PACKAGE }),
  );
  const file = join(packageDir, 'src/models/LicenseSale.js');
  writeFileSync(
    file,
    [
      'export function define({ smrt, SmrtObject }) {',
      "  return smrt({ tableName: 'license_sales' })(class LicenseSale extends SmrtObject {});",
      '}',
      '',
    ].join('\n'),
  );
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(file).href
  )) as {
    define: (deps: {
      smrt: typeof smrt;
      SmrtObject: typeof SmrtObjectBase;
    }) => typeof SmrtObject;
  };
  return {
    ctor: module.define({ smrt, SmrtObject: SmrtObjectBase }),
    dispose: () => {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Each `LicenseSale` keeps its own identity and table, the schema planner
 * keeps commerce's `contracts` free of the consumer's class, and commerce's
 * `LicenseSale` still round-trips through its own table.
 */
export async function assertLicenseSalesCoexist(
  consumer: typeof SmrtObject,
): Promise<void> {
  const commerce = ObjectRegistry.getClassByConstructor(LicenseSale);
  const mine = ObjectRegistry.getClassByConstructor(consumer);
  expect(commerce?.qualifiedName).toBe(
    '@happyvertical/smrt-commerce:LicenseSale',
  );
  expect(mine?.qualifiedName).toBe(`${CONSUMER_PACKAGE}:LicenseSale`);
  expect(commerce?.constructor).toBe(LicenseSale);
  expect(ObjectRegistry.getTableName(commerce?.qualifiedName ?? '')).toBe(
    'contracts',
  );
  expect(mine?.schema?.tableName).toBe('license_sales');
  expect([...(commerce?.fields.keys() ?? [])]).toEqual(
    expect.arrayContaining(['licenseeEmail', 'rightsMedium']),
  );

  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  expect(Object.keys(schemas)).toEqual(
    expect.arrayContaining(['contracts', 'license_sales']),
  );

  const dbPath = join(tmpdir(), `smrt-3106-${crypto.randomUUID()}.db`);
  try {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      licenseeEmail: 'buyer@example.test',
      status: ContractStatus.DRAFT,
    });
    await license.initialize();
    await license.save();
    const { ContractCollection } = await import(
      '../../collections/ContractCollection.js'
    );
    const contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const loaded = (await contracts.get({ id: license.id })) as LicenseSale;
    expect(loaded).toBeInstanceOf(LicenseSale);
    expect(loaded.contractType).toBe(ContractType.LICENSE_SALE);
    expect(loaded.licenseeEmail).toBe('buyer@example.test');
  } finally {
    rmSync(dbPath, { force: true });
  }
}
