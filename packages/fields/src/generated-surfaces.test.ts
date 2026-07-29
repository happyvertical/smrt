import {
  APIGenerator,
  field,
  MCPGenerator,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIGenerator } from '../../cli/src/cli-generator.js';
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
    db = await getTestDatabase({ classes: ['FieldPolicy'] });
    policies = await FieldPolicyCollection.create({ db });
  });

  afterEach(async () => {
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
