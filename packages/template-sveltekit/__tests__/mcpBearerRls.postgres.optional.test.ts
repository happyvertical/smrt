/**
 * Hosted bearer identity reaches the request RLS transaction (#3373 combined
 * review C2), proven on real PostgreSQL through the real `runtime.handle`.
 *
 * Under `database-rls` the runtime opens the request transaction from the
 * session cookie (anonymous without one) before route dispatch. The MCP
 * overlay authenticates its bearer token later, so it binds the verified
 * principal with `runtime.runAsPrincipal`; the tool must then see the bearer
 * user, tenant and (token-capped) permissions on its database session and
 * read that tenant's rows, regardless of any cookie on the same request.
 *
 * The application connects as a NOSUPERUSER NOBYPASSRLS role so the policy
 * actually applies (asserted below). The bearer adapter is a structural stub
 * of `createMcpResourceAuth` (JWT verification is covered in smrt-app-mcp).
 *
 * CI role model (.github/CI.md): the base URL is the unprivileged `smrt_ci`
 * role, which owns what it creates, so FORCE ROW LEVEL SECURITY applies to
 * this fixture's own seeding too. The fixture therefore seeds its rows before
 * enabling RLS, and confines all committed DDL (users tables, policy helper
 * functions, the RLS table) to a schema of its own, dropped on teardown. It
 * never uses the superuser URL.
 */

import { randomUUID } from 'node:crypto';

import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import {
  type McpRouteResourceAuth,
  mountMcpAppRoute,
} from '@happyvertical/smrt-app-mcp/sveltekit';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { isFrameworkBaseClass, ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  SessionService,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import type { Handle } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = baseUrl ? describe : describe.skip;
const SCHEMA = `mcp_bearer_rls_${randomUUID().replaceAll('-', '')}`;

/** `url` with its connection search_path confined to this fixture's schema. */
function inSchema(url: string): string {
  const confined = new URL(url);
  confined.searchParams.set('options', `-c search_path=${SCHEMA}`);
  return confined.toString();
}

const TABLE = 'mcp_bearer_rls_items';
const READ = `${TABLE}.read`;
const DELETE = `${TABLE}.delete`;

interface Probe {
  transactional: boolean;
  userId?: string;
  tenantId?: string;
  permissions?: string[];
  titles?: string[];
  sameDatabaseAsSmrtOptions?: boolean;
}

let admin: DatabaseInterface;
let base: DatabaseInterface | undefined;
let adminUrl = '';
let roleName = '';
let roleUrl = '';
const ids = {
  bearer: '',
  cookieUser: '',
  outsider: '',
  revoked: '',
  tenantA: '',
  tenantB: '',
  cookieSession: '',
};

function rows(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

postgresDescribe('hosted bearer MCP under database-rls', () => {
  beforeAll(async () => {
    base = await getDatabase({ type: 'postgres', url: baseUrl! });
    await base.query(`CREATE SCHEMA "${SCHEMA}"`);
    adminUrl = inSchema(baseUrl!);
    admin = await getDatabase({ type: 'postgres', url: adminUrl });
    await getTestDatabase({
      db: admin,
      type: 'postgres',
      classes: ObjectRegistry.getQualifiedClassNames().filter((className) => {
        const registered = ObjectRegistry.getClass(className);
        return (
          registered?.packageName === '@happyvertical/smrt-users' &&
          !isFrameworkBaseClass(registered?.name, registered?.packageName)
        );
      }),
    });

    const options = { db: { type: 'postgres' as const, url: adminUrl } };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const save = async <T extends { save(): Promise<unknown> }>(value: T) => {
      await value.save();
      return value as T & { id: string };
    };
    const bearer = await save(
      await users.create({ email: `bearer-${randomUUID()}@example.test` }),
    );
    const cookieUser = await save(
      await users.create({ email: `cookie-${randomUUID()}@example.test` }),
    );
    const outsider = await save(
      await users.create({ email: `outsider-${randomUUID()}@example.test` }),
    );
    const tenantA = await save(await tenants.create({ name: 'Bearer tenant' }));
    const tenantB = await save(await tenants.create({ name: 'Cookie tenant' }));
    const role = await save(
      await roles.create({ name: `MCP reader ${randomUUID()}` }),
    );
    // A second role holding only DELETE: an active member whose role no
    // longer grants the READ scope the token still carries.
    const revokedRole = await save(
      await roles.create({ name: `MCP revoked reader ${randomUUID()}` }),
    );
    for (const slug of [READ, DELETE]) {
      const permission = await save(
        await permissions.create({ slug, name: slug }),
      );
      await rolePermissions.addPermission(role.id, permission.id);
      if (slug === DELETE) {
        await rolePermissions.addPermission(revokedRole.id, permission.id);
      }
    }
    const revoked = await save(
      await users.create({ email: `revoked-${randomUUID()}@example.test` }),
    );
    await save(
      await memberships.create({
        userId: bearer.id,
        tenantId: tenantA.id,
        roleId: role.id,
      }),
    );
    await save(
      await memberships.create({
        userId: revoked.id,
        tenantId: tenantA.id,
        roleId: revokedRole.id,
      }),
    );
    await save(
      await memberships.create({
        userId: cookieUser.id,
        tenantId: tenantB.id,
        roleId: role.id,
      }),
    );
    Object.assign(ids, {
      bearer: bearer.id,
      cookieUser: cookieUser.id,
      outsider: outsider.id,
      revoked: revoked.id,
      tenantA: tenantA.id,
      tenantB: tenantB.id,
    });
    const sessions = await SessionService.create(options);
    ids.cookieSession = await sessions.createSession(cookieUser.id, tenantB.id);

    // An RLS-protected application table using the smrt-users policy
    // helpers: rows of the session tenant, given the read permission. Its
    // rows are seeded before RLS is enabled: the seeding role owns the table
    // and FORCE ROW LEVEL SECURITY binds the owner too (no write policy).
    await admin.query(
      `CREATE TABLE ${TABLE} (id text PRIMARY KEY, tenant_id text NOT NULL, title text NOT NULL)`,
    );
    await admin.query(
      `INSERT INTO ${TABLE} (id, tenant_id, title) VALUES ($1, $2, 'Bearer tenant row'), ($3, $4, 'Cookie tenant row')`,
      randomUUID(),
      ids.tenantA,
      randomUUID(),
      ids.tenantB,
    );
    for (const statement of [
      `CREATE OR REPLACE FUNCTION smrt_rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$
         SELECT COALESCE(NULLIF(current_setting('smrt.system_context', true), ''), 'false')::boolean
             OR COALESCE(NULLIF(current_setting('smrt.super_admin_bypass', true), ''), 'false')::boolean $$`,
      `CREATE OR REPLACE FUNCTION smrt_current_tenant_id() RETURNS text LANGUAGE sql STABLE AS $$
         SELECT NULLIF(current_setting('smrt.tenant_id', true), '') $$`,
      `CREATE OR REPLACE FUNCTION smrt_has_permission(required_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$
         SELECT smrt_rls_bypass()
             OR jsonb_exists(COALESCE(NULLIF(current_setting('smrt.permissions', true), ''), '[]')::jsonb, required_permission) $$`,
      `ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY ${TABLE}_select ON ${TABLE} FOR SELECT USING (
         smrt_rls_bypass() OR (tenant_id = smrt_current_tenant_id() AND smrt_has_permission('${READ}')))`,
    ]) {
      await admin.query(statement);
    }

    roleName = `smrt_mcp_rls_${randomUUID().replaceAll('-', '_')}`;
    await admin.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD 'rls-test' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${roleName}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${roleName}"`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${SCHEMA}" TO "${roleName}"`,
    );
    const url = new URL(adminUrl);
    url.username = roleName;
    url.password = 'rls-test';
    roleUrl = url.toString();
  });

  afterAll(async () => {
    if (!base) return;
    await admin?.close?.();
    // Undo every committed change: the fixture schema (users tables, policy
    // helpers, RLS table and policy, and with them every grant to the login
    // role, which owns nothing), then the role. `smrt_ci` administers the
    // roles it creates but lacks their privileges, so DROP OWNED BY would be
    // refused; nothing needs it.
    await base.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    if (roleName) {
      await base.query(`DROP ROLE IF EXISTS "${roleName}"`);
    }
    await base.close?.();
  });

  it('connects the application as a NOSUPERUSER NOBYPASSRLS role', async () => {
    // A dedicated pool: the runtimes below share the cached one for roleUrl.
    const app = await getDatabase({
      type: 'postgres',
      url: roleUrl,
      dbid: `mcp-bearer-rls-role-check-${SCHEMA}`,
    } as Parameters<typeof getDatabase>[0]);
    try {
      const [role] = rows(
        await app.query(
          'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        ),
      );
      expect(role).toEqual({
        name: roleName,
        rolsuper: false,
        rolbypassrls: false,
      });
      // RLS is enforced, not bypassed: without a principal nothing is visible.
      expect(rows(await app.query(`SELECT id FROM ${TABLE}`))).toEqual([]);
    } finally {
      await app.close?.();
    }
  });

  function setup(
    profile: 'cloud' | 'self-hosted',
    principal: { id: string; tenantId: string } = {
      id: ids.bearer,
      tenantId: ids.tenantA,
    },
    bind = true,
    form: 'explicit' | 'runtime' = 'explicit',
  ) {
    const resolved = resolveApplicationRuntime({ profile });
    const runtime: SmrtSvelteKitRuntime = createSmrtSvelteKitRuntime({
      appId: 'mcp-bearer-rls',
      runtime: resolved,
      env: { DATABASE_URL: roleUrl },
      providerReadiness: () => async () => undefined,
      enableTenancy: false,
    });
    const auth: McpRouteResourceAuth = {
      metadataUrl:
        'https://app.example/.well-known/oauth-protected-resource/api/mcp',
      metadataResponse: () => Response.json({}),
      authenticate: async (request) =>
        request.headers.get('authorization') === 'Bearer valid'
          ? {
              ok: true,
              principal: { ...principal, kind: 'human', scopes: [READ] },
            }
          : { ok: false, response: new Response(null, { status: 401 }) },
    };
    let smrtOptionsDatabase: unknown;
    const executions: string[] = [];
    // `runtime` form (#3491): `smrtOptions` and `bindPrincipal` come from the
    // runtime; only the (stub) bearer adapter is an explicit override. The
    // runtime's own `databaseConfig` is observed so the probe can prove the
    // derived `smrtOptions` resolved the bound transaction.
    const bindings =
      form === 'runtime'
        ? {
            runtime: {
              ...runtime,
              databaseConfig: () => {
                smrtOptionsDatabase = runtime.databaseConfig();
                return smrtOptionsDatabase as ReturnType<
                  SmrtSvelteKitRuntime['databaseConfig']
                >;
              },
            },
          }
        : {
            smrtOptions: () => {
              smrtOptionsDatabase = runtime.databaseConfig();
              return { db: smrtOptionsDatabase };
            },
            ...(bind ? { bindPrincipal: runtime.runAsPrincipal } : {}),
          };
    const POST = mountMcpAppRoute({
      models: [],
      requiredScopes: [READ],
      effects: ['read'],
      auth,
      ...bindings,
      workflowTools: [
        {
          name: 'items_probe',
          description: 'Report the request database identity and rows.',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object' },
          effect: 'read',
          idempotent: true,
          openWorld: false,
          async execute() {
            executions.push('probe');
            const db = runtime.databaseConfig() as unknown;
            const queryable =
              typeof (db as DatabaseInterface | undefined)?.query ===
              'function';
            const probe: Probe = { transactional: false };
            if (queryable) {
              const tx = db as DatabaseInterface;
              const setting = async (name: string) =>
                rows(
                  await tx.query(
                    `SELECT current_setting('${name}', true) AS value`,
                  ),
                )[0]?.value as string;
              probe.transactional = true;
              probe.userId = await setting('smrt.user_id');
              probe.tenantId = await setting('smrt.tenant_id');
              probe.permissions = JSON.parse(
                (await setting('smrt.permissions')) || '[]',
              );
              probe.titles = rows(
                await tx.query(`SELECT title FROM ${TABLE} ORDER BY title`),
              ).map((row) => String(row.title));
              probe.sameDatabaseAsSmrtOptions = db === smrtOptionsDatabase;
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(probe) }],
              structuredContent: probe as unknown as Record<string, unknown>,
            };
          },
        },
      ],
    });
    return { runtime, POST, executions };
  }

  async function call(
    context: ReturnType<typeof setup>,
    cookie?: string,
  ): Promise<{ status: number; body: any; localsUser?: string }> {
    await context.runtime.init?.({} as never);
    const url = new URL('https://app.example/api/mcp');
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'items_probe',
        authorization: 'Bearer valid',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'items_probe',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'rls', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    let localsUser: string | undefined;
    const response = await context.runtime.handle({
      event: {
        url,
        request,
        cookies: {
          get: (name: string) => (name === 'sid' ? cookie : undefined),
          getAll: () => [],
          set: () => undefined,
          delete: () => undefined,
          serialize: () => '',
        },
        locals: {},
        getClientAddress: () => '203.0.113.1',
        route: { id: '/api/mcp' },
        params: {},
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        fetch,
      } as unknown as Parameters<Handle>[0]['event'],
      resolve: async (event) => {
        localsUser = (event.locals as { user?: { id?: string } | null }).user
          ?.id;
        return context.POST(event as never);
      },
    });
    return { status: response.status, body: await response.json(), localsUser };
  }

  for (const form of ['explicit', 'runtime'] as const) {
    it(`runs a cookie-free bearer call as the bearer principal in its RLS transaction (${form})`, async () => {
      const { status, body } = await call(setup('cloud', undefined, true, form));
      expect(status).toBe(200);
      expect(body.result.structuredContent).toEqual({
        transactional: true,
        userId: ids.bearer,
        tenantId: ids.tenantA,
        // Live membership permissions capped by the token's granted scopes.
        permissions: [READ],
        titles: ['Bearer tenant row'],
        sameDatabaseAsSmrtOptions: true,
      });
    });

    it(`still executes as the bearer principal when a cookie for another user is present (${form})`, async () => {
      const { status, body, localsUser } = await call(
        setup('cloud', undefined, true, form),
        ids.cookieSession,
      );
      expect(localsUser).toBe(ids.cookieUser);
      expect(status).toBe(200);
      expect(body.result.structuredContent).toMatchObject({
        userId: ids.bearer,
        tenantId: ids.tenantA,
        titles: ['Bearer tenant row'],
      });
    });

    it(`fails closed with the safe denial for a bearer principal without membership (${form})`, async () => {
      const { status, body } = await call(
        setup('cloud', { id: ids.outsider, tenantId: ids.tenantA }, true, form),
      );
      expect(status).toBe(403);
      expect(body.error.data).toEqual({
        code: 'mcp_tool_access_denied',
        retryable: false,
      });
    });

    it(`keeps application isolation on the base connection (${form})`, async () => {
      const { status, body } = await call(setup('self-hosted', undefined, true, form));
      expect(status).toBe(200);
      expect(body.result.structuredContent).toEqual({ transactional: false });
    });

    for (const profile of ['cloud', 'self-hosted'] as const) {
      it(`denies before dispatch when live permissions dropped the token scope (${profile}, ${form})`, async () => {
        const revoked = setup(
          profile,
          { id: ids.revoked, tenantId: ids.tenantA },
          true,
          form,
        );
        const { status, body } = await call(revoked);
        // Active membership, token still carries READ, role no longer grants it.
        expect(status).toBe(200);
        expect(body.error).toEqual({
          code: -32600,
          message: 'MCP tool access is not permitted.',
          data: { code: 'mcp_tool_access_denied', retryable: false },
        });
        expect(revoked.executions).toEqual([]);

        const granted = setup(profile, undefined, true, form);
        const allowed = await call(granted);
        expect(allowed.status).toBe(200);
        expect(allowed.body.result.structuredContent.transactional).toBe(
          profile === 'cloud',
        );
        expect(granted.executions).toEqual(['probe']);
      });
    }
  }

  it('without a binder the bearer call runs in the anonymous transaction and sees nothing', async () => {
    const { body } = await call(setup('cloud', undefined, false));
    expect(body.result.structuredContent).toMatchObject({
      transactional: true,
      userId: '',
      titles: [],
    });
  });
});
