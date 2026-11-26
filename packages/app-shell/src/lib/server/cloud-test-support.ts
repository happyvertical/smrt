// Test harness for the cloud profile: ONE shell database (SQLite, in a temp
// directory), the tenancy interceptor ON (as the runtime turns it on), the
// shell configured as `cloud`, and two owners, each with their own tenant made
// the way a first sign-in makes it (`ownerTenantFor`). No SvelteKit, no
// containers, no PostgreSQL: see the "what this does not prove" notes in
// cloud-isolation.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { createSchemaManager } from '@happyvertical/smrt-core/schema';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { UserCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { vi } from 'vitest';
import '../objects/index.ts';
import { ownerTenantFor } from './accounts.ts';
import { configureShell, resetShell, type ShellContext } from './host.ts';
import { resetShellInference } from './inference.ts';
import { type Principal, setOwnerCheck } from './owner.ts';
import { prepareShellSchema } from './schema.ts';

export const CLOUD_MASTER_KEY = 'ef'.repeat(32);

export interface CloudHarness {
  dir: string;
  db: DatabaseInterface;
  a: Principal;
  b: Principal;
  /** Another account in the deployment that owns nothing yet. */
  newUser(email: string): Promise<{ id: string }>;
  close(): Promise<void>;
}

export interface CloudHarnessOptions {
  /**
   * The shell's database, already open (the caller closes it): PostgreSQL for
   * the row-level-security suite. Default: a SQLite file in the harness's
   * temp directory.
   */
  db?: DatabaseInterface;
  /** Runs once the schema and the two owners exist, before the shell is configured. */
  afterOwners?: (db: DatabaseInterface) => Promise<void>;
}

export async function openCloudShell(
  extra: Partial<ShellContext> = {},
  options: CloudHarnessOptions = {},
): Promise<CloudHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'shell-cloud-test-'));
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  const db =
    options.db ??
    (await actual.getDatabase({
      type: 'sqlite',
      url: join(dir, 'shell.db'),
    } as never));
  if (options.db) {
    // `prepareShellSchema` detects the engine from the URL and does not know an
    // in-process PGlite; the schema manager does (a deployed database is made by
    // `smrt db:migrate`, which is this).
    const manager = createSchemaManager(db);
    for (const schema of Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ))
      await manager.ensureTable(schema);
  } else await prepareShellSchema(db, { hosted: true });
  const users = await UserCollection.create({ db });
  const newUser = async (email: string) => {
    const user = await users.create({ email, username: email.split('@')[0] });
    await user.save();
    return { id: user.id as string };
  };
  const principals: Principal[] = [];
  for (const name of ['ann', 'bob']) {
    const user = await newUser(`${name}@example.test`);
    const tenantId = await ownerTenantFor(db, { id: user.id, name });
    principals.push({ id: user.id, tenantId });
  }
  await options.afterOwners?.(db);
  enableTenancy();
  setOwnerCheck(null);
  configureShell({
    profile: async () => 'cloud' as const,
    db: async () => db,
    dataRoot: async () => dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
    ...extra,
  });
  return {
    dir,
    db,
    a: principals[0],
    b: principals[1],
    newUser,
    async close() {
      resetShellInference();
      await resetShell();
      disableTenancy();
      setOwnerCheck(null);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
