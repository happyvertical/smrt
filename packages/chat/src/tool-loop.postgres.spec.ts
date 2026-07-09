/**
 * ToolLoop — Postgres RLS-enforced tool path (#1891).
 *
 * The side-door tool executor runs its operations against
 * `run.context.database`, which — under `executeAsPrincipal({ postgresRls: true
 * })` — is the RLS transaction with `(smrt.user_id, smrt.tenant_id,
 * smrt.permissions[])` published. This spec proves the tool path is executed
 * INSIDE that published RLS transaction, so the manifest-derived RLS policies
 * bound every side-door query per-`(table, action)` and per-tenant — the
 * precondition for enforcement through any door.
 *
 * The enforcement of a published permission set BY the RLS policies is covered
 * (adapter-owned, door-agnostic) by `@happyvertical/smrt-users`'
 * `permission-postgres-rls.test.ts` / `principal-permission-context-postgres.test.ts`
 * — the same split `executeAsPrincipal.test.ts` follows: SQLite proves the
 * door-agnostic pieces, Postgres proves the RLS publication/enforcement.
 *
 * Gated on `DATABASE_URL` (skips without a Postgres test database).
 */

import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
} from '@happyvertical/ai';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runToolLoop, type ToolExecutionContext } from './tool-loop.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

function currentSetting(row: unknown): string | null {
  const value = (row as { uid?: unknown }).uid;
  return typeof value === 'string' ? value : null;
}

describePostgres('ToolLoop — Postgres RLS-published tool path', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let userId: string;
  let tenantId: string;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest();
    const options = { db: isolated.db };

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'rls@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'RLS Org' });
    await tenant.save();
    const role = await roles.create({ name: 'RLS Role' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id as string,
        tenantId: tenant.id as string,
        roleId: role.id as string,
      })
    ).save();

    const permission = await permissions.create({
      slug: 'conv_notes.read',
      name: 'conv_notes.read',
    });
    await permission.save();
    await rolePermissions.addPermission(
      role.id as string,
      permission.id as string,
    );

    userId = user.id as string;
    tenantId = tenant.id as string;
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('executes the side-door tool inside the published RLS transaction', async () => {
    let observedUserId: string | null = null;
    let observedRls = false;

    // Inject a tool executor that inspects the principal run: the operation is
    // handed the RLS transaction with the principal GUCs published.
    const executeTool = async (ctx: ToolExecutionContext) => {
      observedRls = ctx.run.context.postgresRls;
      const database = ctx.run.context.database;
      const result = await database?.query(
        "SELECT current_setting('smrt.user_id', true) AS uid",
      );
      observedUserId = currentSetting(
        (result as { rows?: unknown[] })?.rows?.[0],
      );
      return { seen: observedUserId };
    };

    let call = 0;
    const ai = {
      async chat(_messages: AIMessage[], options?: ChatOptions) {
        const offered =
          Array.isArray(options?.tools) &&
          options.tools.length > 0 &&
          options?.toolChoice !== 'none';
        call += 1;
        if (call === 1 && offered) {
          return {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'conv_notes.read', arguments: '{}' },
              },
            ],
          } satisfies AIResponse;
        }
        return { content: 'done', finishReason: 'stop' } satisfies AIResponse;
      },
    } as unknown as AIInterface;

    const result = await runToolLoop({
      ai,
      db: isolated?.db,
      messages: [{ role: 'user', content: 'read notes' }],
      tools: [
        {
          slug: 'conv_notes.read',
          collection: 'conv_notes',
          className: 'ConvNote',
          action: 'read',
        },
      ],
      principal: {
        runAsUserId: userId,
        tenantId,
        allowedTools: ['conv_notes.read'],
      },
      postgresRls: true,
      executeTool,
      audit: () => {},
    });

    expect(observedRls).toBe(true);
    // The side-door operation saw the principal published on the RLS session.
    expect(observedUserId).toBe(userId);
    expect(result.invocations[0]?.ok).toBe(true);
  });
});
