// Test harness for the cloud profile: ONE shell database (SQLite, in a temp
// directory), the tenancy interceptor ON (as the runtime turns it on), the
// shell configured as `cloud`, and two owners, each with their own tenant made
// the way a first sign-in makes it (`ownerTenantFor`). No SvelteKit, no
// containers, no PostgreSQL: see the "what this does not prove" notes in
// cloud-isolation.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { UserCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { vi } from 'vitest';
import '../objects/index.ts';
import { ownerTenantFor } from './accounts.ts';
import { configureShell, resetShell } from './host.ts';
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

export async function openCloudShell(): Promise<CloudHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'shell-cloud-test-'));
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  const db = await actual.getDatabase({
    type: 'sqlite',
    url: join(dir, 'shell.db'),
  } as never);
  await prepareShellSchema(db);
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
  enableTenancy();
  setOwnerCheck(null);
  configureShell({
    profile: async () => 'cloud' as const,
    db: async () => db,
    dataRoot: async () => dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
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
