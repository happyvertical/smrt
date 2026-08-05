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
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIGenerator } from '../../cli/src/cli-generator.js';
// Registers smrt-users' Tenant so getTestDatabase can create the tenants
// table the user-tier write-time lock check reads through the default
// hierarchy loader.
import { TenantCollection } from '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';

@smrt({
  packageName: '@test/smrt-fields-surfaces',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class PolicySurfaceDoc extends SmrtObject {
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
    const existing = await policies.create({
      objectRef,
      fieldName: 'headline',
      scopeType: 'app',
      help: 'seeded',
    });

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
    const createResponse = await handler(
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
    );
    expect(createResponse.status).toBe(201);

    const updateResponse = await handler(
      new Request(`http://localhost/api/v1/fieldpolicy/${existing.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ help: 'updated help' }),
      }),
    );
    expect(updateResponse.status).toBe(200);

    const deleteResponse = await handler(
      new Request(`http://localhost/api/v1/fieldpolicy/${existing.id}`, {
        method: 'DELETE',
      }),
    );
    expect(deleteResponse.status).toBe(204);
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

    // App tier: no owner columns at all, no ambient context.
    expect(
      (
        await post({
          objectRef,
          fieldName: 'headline',
          scopeType: 'app',
          label: 'Headline',
        })
      ).status,
    ).toBe(201);

    // Tenant tier: the body names the tenant, the transport strips it, and
    // the model re-derives it from the ambient context.
    await withTenant(
      { tenantId, userId, permissions: new Set<string>() },
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
      { tenantId: contextTenant, permissions: new Set<string>() },
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
