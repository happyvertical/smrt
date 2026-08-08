import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  APIGenerator,
  field,
  MCPGenerator,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  resetTenancy,
  setupTestTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIGenerator } from '../../cli/src/cli-generator.js';
// Registers smrt-users' Tenant so getTestDatabase can create the tenants
// table the user-tier write-time lock check reads through the default
// hierarchy loader.
import {
  TenantCollection,
  withPrincipalPermissionContext,
} from '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import {
  MANAGE_FIELD_POLICY_PERMISSION,
  PERSONALIZE_FIELD_POLICY_PERMISSION,
} from './permissions.js';

@smrt({
  packageName: '@test/smrt-fields-surfaces',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class PolicySurfaceDoc extends SmrtObject {
  @field({ required: true })
  requiredHeadline: string = '';

  @field({ ui: { basic: true } })
  headline: string = '';

  @field({ ui: { basic: true } })
  tagline: string = '';

  @field({ sensitive: true })
  apiToken: string = '';
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(PolicySurfaceDoc);
  if (!registered?.qualifiedName) {
    throw new Error('PolicySurfaceDoc is not registered with a qualified name');
  }
  return registered.qualifiedName;
}

// Generated REST routes are fail-closed (#1540). These tests exercise verb
// exposure, not auth, so they simulate an authenticated gateway with a
// pass-through auth middleware. Auth itself is covered by smrt-core tests.
const passThroughAuth =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

describe('smrt-fields generated surfaces', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let policies: FieldPolicyCollection;

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    db = await getTestDatabase({ classes: ['FieldPolicy', 'Tenant'] });
    policies = await FieldPolicyCollection.create({ db });
  });

  afterEach(async () => {
    clearFieldPolicyCache();
    resetTenancy();
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as unknown as { close: () => Promise<void> }).close();
    }
  });

  it('exposes writes but NO reads over the generated REST surface', async () => {
    const objectRef = fixtureRef();
    const existing = await withSystemContext(() =>
      policies.create({
        objectRef,
        fieldName: 'headline',
        scopeType: 'app',
        help: 'seeded',
      }),
    );

    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    // Reads are closed: list/get on this non-tenant-scoped model would
    // enumerate every tenant's and user's policy rows.
    const listResponse = await handler(
      new Request('http://localhost/api/v1/fieldpolicy'),
    );
    const getResponse = await handler(
      new Request(`http://localhost/api/v1/fieldpolicy/${existing.id}`),
    );
    expect(listResponse.status).toBe(405);
    expect(getResponse.status).toBe(405);

    // Writes stay open (each guarded by the model's save/delete boundaries).
    // The create targets a DIFFERENT field: a natural-key upsert would
    // replace the seeded row's id and invalidate the update/delete steps.
    const createResponse = await withSystemContext(() =>
      handler(
        new Request('http://localhost/api/v1/fieldpolicy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            objectRef,
            fieldName: 'tagline',
            scopeType: 'app',
            label: 'Tagline',
          }),
        }),
      ),
    );
    expect(createResponse.status).toBe(201);

    const updateResponse = await withSystemContext(() =>
      handler(
        new Request(`http://localhost/api/v1/fieldpolicy/${existing.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ help: 'updated help' }),
        }),
      ),
    );
    expect(updateResponse.status).toBe(200);

    const deleteResponse = await withSystemContext(() =>
      handler(
        new Request(`http://localhost/api/v1/fieldpolicy/${existing.id}`, {
          method: 'DELETE',
        }),
      ),
    );
    expect(deleteResponse.status).toBe(204);
  });

  it('returns 403 when a generated user write is blocked by an org lock', async () => {
    const objectRef = fixtureRef();
    const tenantId = randomUUID();
    const userId = randomUUID();
    await withSystemContext(() =>
      policies.create({
        objectRef,
        fieldName: 'headline',
        scopeType: 'app',
        locked: true,
      }),
    );

    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const response = await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([PERSONALIZE_FIELD_POLICY_PERMISSION]),
      },
      () =>
        api.generateHandler()(
          new Request('http://localhost/api/v1/fieldpolicy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              objectRef,
              fieldName: 'headline',
              scopeType: 'user',
              label: 'Denied personal override',
            }),
          }),
        ),
    );
    expect(response.status).toBe(403);
  });

  it('rejects a generated PUT that clears a required field’s only default while demoting it', async () => {
    const objectRef = fixtureRef();
    const existing = await withSystemContext(() =>
      policies.create({
        objectRef,
        fieldName: 'requiredHeadline',
        scopeType: 'app',
        defaultValue: JSON.stringify('Only default'),
      }),
    );
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    const response = await withSystemContext(() =>
      handler(
        new Request(`http://localhost/api/v1/fieldpolicy/${existing.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ defaultValue: null, visibility: 'hidden' }),
        }),
      ),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    // Replacing a tenant row is valid when an app-tier default remains below
    // it; the PUT validates the projected policy rather than its old row.
    const tenantId = randomUUID();
    const tenantRow = await withTenant(
      {
        tenantId,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      () =>
        policies.create({
          objectRef,
          fieldName: 'requiredHeadline',
          scopeType: 'tenant',
          tenantId,
          defaultValue: JSON.stringify('Tenant default'),
        }),
    );
    const permitted = await withTenant(
      {
        tenantId,
        userId: randomUUID(),
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      () =>
        handler(
          new Request(`http://localhost/api/v1/fieldpolicy/${tenantRow.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              defaultValue: null,
              visibility: 'advanced',
            }),
          }),
        ),
    );
    expect(permitted.status).toBe(200);
  });

  it('dispatches the batch resolve action on the runtime REST transport', async () => {
    const objectRef = fixtureRef();
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    // POST /<collection>/resolve dispatches the decorator-declared custom
    // action rather than degrading into a malformed create.
    const response = await handler(
      new Request('http://localhost/api/v1/fieldpolicy/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectRefs: [objectRef] }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      action: string;
      result: {
        policies: Record<
          string,
          { fields: Record<string, { visibility: string }> }
        >;
      };
    };
    expect(payload.action).toBe('resolveBatch');
    const fields = payload.result.policies[objectRef].fields;
    expect(fields.headline).toBeDefined();
    // Field gating holds on this transport too: sensitive fields absent.
    expect(fields.apiToken).toBeUndefined();

    // Wrong method for the action path falls through to CRUD handling,
    // where reads are closed.
    const wrongMethod = await handler(
      new Request('http://localhost/api/v1/fieldpolicy/resolve'),
    );
    expect(wrongMethod.status).toBe(405);

    // A matched action with an unparseable body is a client error, never a
    // CRUD write.
    const badJson = await handler(
      new Request('http://localhost/api/v1/fieldpolicy/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(badJson.status).toBe(400);
  });

  it('creates a row at EVERY scope tier through the generated REST surface', async () => {
    // Regression for the write-dead org tier (#2047): core's mass-assignment
    // guard strips `tenantId` from every generated create/update body, and
    // FieldPolicy is deliberately not @TenantScoped so nothing repopulated
    // it — a `POST {scopeType:'tenant', tenantId}` therefore always reached
    // scope-shape validation with `tenantId === null` and threw, making
    // #2050's org-admin tier unreachable from any generated surface. It went
    // unnoticed because the model-level tests call `policies.create()`
    // directly, so these deliberately drive the transport instead.
    const objectRef = fixtureRef();
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    const post = (body: unknown): Promise<Response> =>
      handler(
        new Request('http://localhost/api/v1/fieldpolicy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    const tenantId = randomUUID();
    const userId = randomUUID();

    // App tier is server-owned: its transport write needs the explicit system
    // bypass, never an absent identity.
    expect(
      (
        await withSystemContext(() =>
          post({
            objectRef,
            fieldName: 'headline',
            scopeType: 'app',
            label: 'Headline',
          }),
        )
      ).status,
    ).toBe(201);

    // Tenant tier: the body names the tenant, the transport strips it, and
    // the model re-derives it from the ambient context.
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([
          MANAGE_FIELD_POLICY_PERMISSION,
          PERSONALIZE_FIELD_POLICY_PERMISSION,
        ]),
      },
      async () => {
        expect(
          (
            await post({
              objectRef,
              fieldName: 'headline',
              scopeType: 'tenant',
              tenantId,
              label: 'Org headline',
            })
          ).status,
        ).toBe(201);

        // User tier through the same transport.
        expect(
          (
            await post({
              objectRef,
              fieldName: 'tagline',
              scopeType: 'user',
              userId,
              label: 'My tagline',
            })
          ).status,
        ).toBe(201);
      },
    );

    const appRows = await policies.list({
      where: { objectRef, scopeType: 'app' },
    });
    expect(appRows).toHaveLength(1);
    expect(appRows[0].tenantId).toBeNull();
    expect(appRows[0].userId).toBeNull();
    expect(appRows[0].scopeKey).toBe('__app__');

    const tenantRows = await policies.list({
      where: { objectRef, scopeType: 'tenant' },
    });
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0].tenantId).toBe(tenantId);
    expect(tenantRows[0].userId).toBeNull();
    expect(tenantRows[0].scopeKey).toBe(tenantId);
    expect(tenantRows[0].label).toBe('Org headline');

    const userRows = await policies.list({
      where: { objectRef, scopeType: 'user' },
    });
    expect(userRows).toHaveLength(1);
    expect(userRows[0].userId).toBe(userId);
    expect(userRows[0].tenantId).toBeNull();
    expect(userRows[0].scopeKey).toBe(userId);
  });

  it('derives the tenant owner from the context, never from the request body', async () => {
    // The transport strip means a forged `tenantId` in the body is inert:
    // the row is always attributed to the ambient tenant.
    const objectRef = fixtureRef();
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    const contextTenant = randomUUID();
    const foreignTenant = randomUUID();

    await withTenant(
      {
        tenantId: contextTenant,
        userId: randomUUID(),
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        const response = await handler(
          new Request('http://localhost/api/v1/fieldpolicy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              objectRef,
              fieldName: 'headline',
              scopeType: 'tenant',
              tenantId: foreignTenant,
              label: 'forged',
            }),
          }),
        );
        expect(response.status).toBe(201);
      },
    );

    const rows = await policies.list({
      where: { objectRef, scopeType: 'tenant' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(contextTenant);
  });

  it('derives tenant and personal owners from session permission ALS without tenant ALS', async () => {
    // `createSessionHandler()` always publishes this permission context, but
    // applications may leave `enterTenantContext` unset. FieldPolicy is not
    // @TenantScoped, so its generated routes must still source the write owner
    // from the authenticated principal rather than a request-body id.
    const objectRef = fixtureRef();
    const tenantId = randomUUID();
    const userId = randomUUID();
    const forgedTenantId = randomUUID();
    const forgedUserId = randomUUID();
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    const postAsSessionPrincipal = (
      permissions: string[],
      body: Record<string, unknown>,
    ): Promise<Response> =>
      withPrincipalPermissionContext(
        {
          db,
          enterTenantContext: false,
          permissions,
          tenantId,
          userId,
        },
        () =>
          handler(
            new Request('http://localhost/api/v1/fieldpolicy', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          ),
      );

    const tenantResponse = await postAsSessionPrincipal(
      [MANAGE_FIELD_POLICY_PERMISSION],
      {
        objectRef,
        fieldName: 'headline',
        scopeType: 'tenant',
        tenantId: forgedTenantId,
        label: 'Session tenant policy',
      },
    );
    expect(tenantResponse.status).toBe(201);

    const personalResponse = await postAsSessionPrincipal(
      [PERSONALIZE_FIELD_POLICY_PERMISSION],
      {
        objectRef,
        fieldName: 'tagline',
        scopeType: 'user',
        label: 'Session personal policy',
      },
    );
    expect(personalResponse.status).toBe(201);

    // A generated body cannot impersonate another user. The normal personal
    // flow omits this server-owned field and is attributed above; a forged
    // owner is rejected rather than becoming a cross-user write.
    const forgedPersonalResponse = await postAsSessionPrincipal(
      [PERSONALIZE_FIELD_POLICY_PERMISSION],
      {
        objectRef,
        fieldName: 'requiredHeadline',
        scopeType: 'user',
        userId: forgedUserId,
        label: 'Forged personal policy',
      },
    );
    expect(forgedPersonalResponse.status).toBe(403);

    const rows = await policies.list({ where: { objectRef } });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeType: 'tenant',
          tenantId,
          userId: null,
        }),
        expect.objectContaining({
          scopeType: 'user',
          tenantId: null,
          userId,
        }),
      ]),
    );
  });

  it('redacts foreign scope identifiers from typed generated-route denials', async () => {
    const objectRef = fixtureRef();
    const tenantId = randomUUID();
    const userId = randomUUID();
    const foreignTenantId = randomUUID();
    const foreignUserId = randomUUID();
    const foreignRows = await withTenant(
      {
        tenantId: foreignTenantId,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => ({
        tenant: await policies.create({
          objectRef,
          fieldName: 'headline',
          scopeType: 'tenant',
          tenantId: foreignTenantId,
          label: 'Foreign tenant policy',
        }),
        user: await policies.create({
          objectRef,
          fieldName: 'tagline',
          scopeType: 'user',
          userId: foreignUserId,
          label: 'Foreign user policy',
        }),
      }),
    );
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();

    const deniedDelete = async (id: string, permission: string) => {
      const response = await withTenant(
        { tenantId, userId, permissions: new Set([permission]) },
        () =>
          handler(
            new Request(`http://localhost/api/v1/fieldpolicy/${id}`, {
              method: 'DELETE',
            }),
          ),
      );
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain('Field policy scope is not permitted');
      expect(body).not.toContain(tenantId);
      expect(body).not.toContain(userId);
      expect(body).not.toContain(foreignTenantId);
      expect(body).not.toContain(foreignUserId);
    };

    const foreignTenantRowId = foreignRows.tenant.id;
    const foreignUserRowId = foreignRows.user.id;
    if (!foreignTenantRowId || !foreignUserRowId) {
      throw new Error('Seeded field-policy rows must have persistent ids');
    }
    await deniedDelete(foreignTenantRowId, MANAGE_FIELD_POLICY_PERMISSION);
    await deniedDelete(foreignUserRowId, PERSONALIZE_FIELD_POLICY_PERMISSION);
  });

  it('dispatches a capability-filtered editor-state action at the registered singular route', async () => {
    const objectRef = fixtureRef();
    const tenantId = randomUUID();
    const userId = randomUUID();
    await withTenant(
      {
        tenantId,
        permissions: new Set<string>(),
        superAdminBypass: true,
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'headline',
          scopeType: 'app',
          help: 'app override',
        });
        await policies.create({
          objectRef,
          fieldName: 'apiToken',
          scopeType: 'app',
          help: 'must not be emitted',
        });
        await policies.create({
          objectRef,
          fieldName: 'headline',
          scopeType: 'tenant',
          tenantId,
          help: 'tenant override',
        });
        await policies.create({
          objectRef,
          fieldName: 'headline',
          scopeType: 'user',
          userId,
          help: 'private override',
        });
      },
    );

    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    // The registered route segment is intentionally singular. It is the key
    // handed to the runtime generator, not the collection's plural metadata.
    api.registerCollection('fieldpolicy', policies);
    const handler = api.generateHandler();
    const editorRequest = (): Request =>
      new Request('http://localhost/api/v1/fieldpolicy/editor-state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectRef }),
      });

    const denied = await withTenant(
      { tenantId, userId, permissions: new Set<string>() },
      () => handler(editorRequest()),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: {
        code: 'permission_denied',
        ok: false,
        status: 403,
      },
    });

    const authorized = await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      () => handler(editorRequest()),
    );
    expect(authorized.status).toBe(200);
    const payload = (await authorized.json()) as {
      action: string;
      result: {
        capabilities: { manage: boolean; personalize: boolean };
        policy: { fields: Record<string, unknown> };
        rows: {
          app: Array<{ fieldName: string; id: string }>;
          tenant: Array<{ fieldName: string; id: string }>;
          user: Array<{ fieldName: string; id: string }>;
        };
      };
    };
    expect(payload.action).toBe('getEditorState');
    expect(payload.result.capabilities).toEqual({
      manage: true,
      personalize: false,
    });
    expect(payload.result.policy.fields.headline).toBeDefined();
    expect(payload.result.policy.fields.apiToken).toBeUndefined();
    expect(payload.result.rows.app).toEqual([
      expect.objectContaining({
        fieldName: 'headline',
        id: expect.any(String),
      }),
    ]);
    expect(payload.result.rows.tenant).toEqual([
      expect.objectContaining({
        fieldName: 'headline',
        id: expect.any(String),
      }),
    ]);
    // `manage` never exposes the caller's personal raw row; that requires
    // the separate personalize capability.
    expect(payload.result.rows.user).toEqual([]);

    // The generator accepts both its registered singular segment and its
    // canonical plural alias. Pin that the plural alias dispatches the same
    // collection action rather than silently reopening generated list/get.
    const pluralRoute = await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      () =>
        handler(
          new Request('http://localhost/api/v1/fieldpolicies/editor-state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ objectRef }),
          }),
        ),
    );
    expect(pluralRoute.status).toBe(200);
    expect((await pluralRoute.json()).action).toBe('getEditorState');
  });

  it('keeps the prefixed system table name as the registry authority', async () => {
    // The decorated collection's config is re-registered onto the ITEM slot
    // wholesale, so a registry change could silently move every policy row to
    // a different table. `_smrt_field_policies` survives only because
    // `resolveTableName` prefers the manifest entry — pin both the item slot
    // and the instance that actually issues the SQL.
    expect(ObjectRegistry.getTableName('FieldPolicy')).toBe(
      '_smrt_field_policies',
    );
    expect(policies.tableName).toBe('_smrt_field_policies');

    // The COLLECTION's own registry slot resolves to the unprefixed
    // collection-fallback name. Nothing reads it for persistence (rows go
    // through the item class above), and the generated route path derives
    // from it — but it must never become the persistence authority.
    expect(ObjectRegistry.getTableName('FieldPolicyCollection')).toBe(
      'field_policies',
    );
  });

  it('declares the natural key on BOTH classes that map to the policy table', () => {
    // The decorated collection emits its OWN manifest schema for
    // `_smrt_field_policies`. Without `conflictColumns` that schema falls back
    // to SmrtObject's default unique `(slug, context)` index, and
    // manifest-driven migrations aggregate both schemas onto the one physical
    // table — so the stray index would reject legitimate layered rows (every
    // policy row has a NULL slug and context, and the app/tenant/user rows for
    // one field differ only by the real natural key).
    //
    // The runtime registry cannot catch this: `getAllSchemas()` and
    // `getAllSchemasAsDefinitions()` are both keyed by TABLE name, so the two
    // schemas collapse into one entry and the divergence is invisible until a
    // consumer runs migrations off the manifest. Pin it at the source instead.
    const naturalKey = ['object_ref', 'field_name', 'scope_type', 'scope_key'];

    // Read the manifest the SMRT vitest plugin regenerates at startup — it is
    // the same artifact consumer migrations consume, and the only place the
    // per-class schemas stay distinct.
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), '.smrt/manifest.json'), 'utf8'),
    ) as {
      objects?: Record<
        string,
        {
          tableName?: string;
          schema?: {
            indexes?: Array<{ columns?: string[]; unique?: boolean }>;
          };
          decoratorConfig?: {
            api?: { principalContext?: boolean };
          };
        }
      >;
    };
    const policyEntries = Object.entries(manifest.objects ?? {}).filter(
      ([name]) =>
        name.endsWith(':FieldPolicy') ||
        name.endsWith(':FieldPolicyCollection'),
    );
    // Both the model and its decorated collection emit a schema here.
    expect(policyEntries).toHaveLength(2);

    // FieldPolicy's sparse table is intentionally not @TenantScoped, but its
    // generated CRUD and collection actions still require a tenant/user
    // identity derived from trusted session locals. Pin the manifest contract
    // consumed by SvelteKit route generation for BOTH route hosts.
    expect(
      policyEntries.map(
        ([, entry]) => entry.decoratorConfig?.api?.principalContext === true,
      ),
    ).toEqual([true, true]);

    for (const [name, entry] of policyEntries) {
      const uniqueIndexes = (entry.schema?.indexes ?? []).filter(
        (index) => index?.unique === true,
      );
      expect({
        name,
        unique: uniqueIndexes.map((index) => index.columns),
      }).toEqual({ name, unique: [naturalKey] });
    }

    // The effective (table-keyed) schema carries exactly that one unique
    // index, and nothing keyed on slug.
    const definitions = ObjectRegistry.getAllSchemasAsDefinitions();
    const policySchema = Object.values(definitions).find(
      (schema) => schema?.tableName === '_smrt_field_policies',
    );
    expect(policySchema).toBeDefined();
    const uniqueIndexes = (policySchema?.indexes ?? []).filter(
      (index) => index?.unique === true,
    );
    expect(uniqueIndexes.map((index) => index.columns)).toEqual([naturalKey]);
  });

  it('exposes nothing over MCP or the runtime CLI', async () => {
    const mcp = new MCPGenerator({}, { db });
    const toolNames = (await mcp.generateTools()).map((tool) => tool.name);
    expect(toolNames.filter((name) => name.startsWith('fieldpolicy'))).toEqual(
      [],
    );

    // The decorated collection's config is the runtime registry authority for
    // the item class, and it closes the CLI surface entirely (the
    // ContentContributions precedent) — reads would otherwise reach every
    // tenant's rows over the CLI's HTTP transport.
    const cli = new CLIGenerator({ prompt: false }, { db });
    const commands = await (cli as any).generateObjectCommands(
      'FieldPolicy',
      {},
    );
    expect(commands.map((command: any) => command.name)).toEqual([]);
  });
});
