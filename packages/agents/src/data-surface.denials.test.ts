/**
 * data.query / data.inspect refusals (#4387): an action-specific denial for a
 * surface the principal can see for a lesser action, the generic denial for
 * one it cannot see at all, and host visibility through `onDenied` and the
 * audit sink.
 */
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import { describe, expect, it, vi } from 'vitest';
import type {
  DataSurfaceAction,
  DataSurfaceAuditEntry,
  DataSurfaceDefinition,
  DataSurfaceDeniedEntry,
  DataSurfaceSchema,
} from './data-surface.js';
import {
  createDataSurfaceTools,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceActionDeniedError,
  DataSurfaceDeniedError,
  DataSurfaceRequestError,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';

const schema: DataSurfaceSchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', projectable: true, filterOperators: ['eq'] },
    {
      id: 'status',
      type: 'string',
      projectable: true,
      filterOperators: ['eq', 'in'],
    },
    {
      id: 'restricted',
      type: 'string',
      projectable: true,
      filterOperators: ['eq'],
      readPermission: 'records.secret',
    },
  ],
  defaultPageLimit: 5,
  maxPageLimit: 5,
};

const records: DataSurfaceDefinition = {
  id: 'records',
  collection: 'records',
  schema,
};

function fakeRun(): PrincipalRun {
  const permissions = ['records.read'];
  return {
    context: {
      userId: 'user-a',
      tenantId: 'tenant-a',
      database: undefined,
      permissions,
      permissionSet: new Set(permissions),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } satisfies SessionPermissionRuntimeContext,
    permissions,
    allowedTools: [DATA_QUERY_TOOL_SLUG, DATA_INSPECT_TOOL_SLUG],
    isToolAllowed: () => true,
    assertToolAllowed() {},
    async assertOperation() {
      return {
        allowed: true,
        permission: 'records.read',
        reason: 'permission_granted',
      };
    },
  };
}

function harness(
  surfacesFor: (action: DataSurfaceAction) => DataSurfaceDefinition[],
  extra: { execute?: boolean } = {},
) {
  const denied: DataSurfaceDeniedEntry[] = [];
  const audits: DataSurfaceAuditEntry[] = [];
  const tools = createDataSurfaceTools({
    surfaces: (_run, { action }) => surfacesFor(action),
    ...(extra.execute === false
      ? {}
      : {
          execute: async () => ({
            rows: [],
            total: { kind: 'exact' as const, value: 2 },
          }),
        }),
    onDenied: (entry) => {
      denied.push(entry);
    },
    audit: (entry) => {
      audits.push(entry);
    },
  });
  const call = (slug: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.slug === slug);
    if (!tool) throw new Error(`${slug} missing`);
    return tool.execute({ run: fakeRun(), args, db: undefined });
  };
  return { call, denied, audits };
}

const count = { mode: 'count' };

describe('action-specific denials (#4387)', () => {
  it('names the action for a surface visible to inspect but not to query', async () => {
    const { call, denied, audits } = harness((action) =>
      action === 'query' ? [] : [records],
    );
    await expect(
      call(DATA_INSPECT_TOOL_SLUG, { surfaceId: 'records' }),
    ).resolves.toMatchObject({ id: 'records' });
    const error = await call(DATA_QUERY_TOOL_SLUG, {
      surfaceId: 'records',
      request: count,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataSurfaceActionDeniedError);
    expect(error).toBeInstanceOf(DataSurfaceDeniedError);
    expect(error).toMatchObject({
      status: 403,
      code: 'DATA_SURFACE_ACTION_DENIED',
      message:
        "Querying 'records' is not permitted for you; answer without this data or ask an administrator.",
    });
    expect(denied).toEqual([
      {
        action: 'query',
        surfaceId: 'records',
        userId: 'user-a',
        tenantId: 'tenant-a',
        reason: 'action_not_permitted',
      },
    ]);
    expect(audits.filter((entry) => entry.denied)).toEqual([
      {
        action: 'query',
        surfaceId: 'records',
        userId: 'user-a',
        tenantId: 'tenant-a',
        denied: true,
        reason: 'action_not_permitted',
      },
    ]);
  });

  it('names inspect for a surface visible to discover only', async () => {
    const { call, denied } = harness((action) =>
      action === 'discover' ? [records] : [],
    );
    await expect(
      call(DATA_INSPECT_TOOL_SLUG, { surfaceId: 'records' }),
    ).rejects.toThrow(
      "Inspecting 'records' is not permitted for you; answer without this data or ask an administrator.",
    );
    expect(denied[0]?.reason).toBe('action_not_permitted');
  });

  it('keeps the generic denial for a surface the principal cannot see at all', async () => {
    const { call, denied, audits } = harness(() => []);
    const error = await call(DATA_QUERY_TOOL_SLUG, {
      surfaceId: 'hidden-surface-id',
      request: count,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataSurfaceDeniedError);
    expect(error).not.toBeInstanceOf(DataSurfaceActionDeniedError);
    expect((error as Error).message).toBe('Data surface is not available.');
    // Neither the host entry nor the audit echoes an id nobody can see.
    expect(denied).toEqual([
      {
        action: 'query',
        userId: 'user-a',
        tenantId: 'tenant-a',
        reason: 'not_visible',
      },
    ]);
    expect(JSON.stringify([denied, audits])).not.toContain('hidden-surface-id');
  });

  it('reports a visible surface with no executor as no_executor', async () => {
    const { call, denied } = harness(() => [records], { execute: false });
    await expect(
      call(DATA_QUERY_TOOL_SLUG, { surfaceId: 'records', request: count }),
    ).rejects.toBeInstanceOf(DataSurfaceActionDeniedError);
    expect(denied).toEqual([
      expect.objectContaining({
        surfaceId: 'records',
        reason: 'no_executor',
      }),
    ]);
  });

  it('never lets a throwing onDenied or audit sink change the denial', async () => {
    const tools = createDataSurfaceTools({
      surfaces: (_run, { action }) => (action === 'query' ? [] : [records]),
      onDenied: vi.fn(() => {
        throw new Error('sink down');
      }),
      audit: vi.fn(() => {
        throw new Error('audit down');
      }),
    });
    const query = tools.find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG);
    await expect(
      query?.execute({
        run: fakeRun(),
        args: { surfaceId: 'records', request: count },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceActionDeniedError);
  });

  it('refuses a hidden field with the actionable field error, not a denial', async () => {
    const { call, denied } = harness(() => [records]);
    const error = await call(DATA_QUERY_TOOL_SLUG, {
      surfaceId: 'records',
      request: {
        mode: 'count',
        filter: {
          kind: 'condition',
          field: 'restricted',
          operator: 'eq',
          value: 'x',
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataSurfaceRequestError);
    expect(error).toMatchObject({ reason: 'DATA_QUERY_FIELD_NOT_ALLOWED' });
    expect((error as Error).message).toContain(
      'Filterable fields: id, status.',
    );
    expect(denied).toEqual([]);
  });
});
