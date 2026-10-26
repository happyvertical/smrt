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
  DataSurfaceQueryError,
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

function fakeRun(tenantId: string | null = 'tenant-a'): PrincipalRun {
  const permissions = ['records.read'];
  return {
    context: {
      userId: 'user-a',
      tenantId,
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

  it('treats a visible surface with no executor as a configuration failure, not a denial', async () => {
    const failures: unknown[] = [];
    const denied: unknown[] = [];
    const tools = createDataSurfaceTools({
      surfaces: [records],
      onFailure: (entry) => {
        failures.push(entry);
      },
      onDenied: (entry) => {
        denied.push(entry);
      },
    });
    const query = tools.find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG);
    await expect(
      query?.execute({
        run: fakeRun(),
        args: { surfaceId: 'records', request: count },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceQueryError);
    expect(denied).toEqual([]);
    expect(failures).toEqual([
      expect.objectContaining({
        action: 'query',
        surfaceId: 'records',
        error: expect.objectContaining({
          message: 'Data surface has no executor.',
        }),
      }),
    ]);
  });

  it('names query for a surface visible only for discover', async () => {
    const { call, denied } = harness((action) =>
      action === 'discover' ? [records] : [],
    );
    await expect(
      call(DATA_QUERY_TOOL_SLUG, { surfaceId: 'records', request: count }),
    ).rejects.toThrow("Querying 'records' is not permitted for you");
    expect(denied[0]).toMatchObject({
      surfaceId: 'records',
      reason: 'action_not_permitted',
    });
  });

  it('reports a throwing lesser lookup to onFailure and keeps looking', async () => {
    const failures: Array<{ action: string }> = [];
    const tools = createDataSurfaceTools({
      surfaces: (_run, { action }) => {
        if (action === 'inspect') throw new Error('catalog down');
        return action === 'discover' ? [records] : [];
      },
      onFailure: (entry) => {
        failures.push(entry);
      },
    });
    const query = tools.find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG);
    await expect(
      query?.execute({
        run: fakeRun(),
        args: { surfaceId: 'records', request: count },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceActionDeniedError);
    expect(failures.map((entry) => entry.action)).toEqual(['inspect']);
  });

  it('evaluates lesser catalogs for any function catalog, once each, stopping at a hit', async () => {
    const run = (tools: ReturnType<typeof createDataSurfaceTools>) =>
      tools
        .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
        ?.execute({
          run: fakeRun(),
          args: { surfaceId: 'records', request: count },
          db: undefined,
        })
        .catch(() => undefined);
    // A one-argument (or defaulted / wrapped) function is not skipped.
    const actions: string[] = [];
    await run(
      createDataSurfaceTools({
        surfaces: (...callArgs: unknown[]) => {
          actions.push(
            (callArgs[1] as { action: string } | undefined)?.action ?? '?',
          );
          return [];
        },
      }),
    );
    expect(actions).toEqual(['query', 'inspect', 'discover']);

    // A hit on inspect stops the search: discover is never evaluated.
    const hit: string[] = [];
    await run(
      createDataSurfaceTools({
        surfaces: (_run, { action }) => {
          hit.push(action);
          return action === 'inspect' ? [records] : [];
        },
      }),
    );
    expect(hit).toEqual(['query', 'inspect']);

    // A static catalog never needs another evaluation.
    const tools = createDataSurfaceTools({ surfaces: [] });
    await expect(
      tools
        .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
        ?.execute({
          run: fakeRun(),
          args: { surfaceId: 'records', request: count },
          db: undefined,
        }),
    ).rejects.toThrow('Data surface is not available.');
  });

  it('ignores a lesser action whose tool the principal is not allowed', async () => {
    const actions: string[] = [];
    const denied: DataSurfaceDeniedEntry[] = [];
    const tools = createDataSurfaceTools({
      surfaces: (_run, { action }) => {
        actions.push(action);
        return action === 'query' ? [] : [records];
      },
      onDenied: (entry) => {
        denied.push(entry);
      },
    });
    const run = fakeRun();
    run.isToolAllowed = (slug) => slug === DATA_QUERY_TOOL_SLUG;
    const error = await tools
      .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
      ?.execute({
        run,
        args: { surfaceId: 'records', request: count },
        db: undefined,
      })
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(DataSurfaceActionDeniedError);
    expect((error as Error).message).toBe('Data surface is not available.');
    expect(actions).toEqual(['query']);
    expect(denied[0]).toMatchObject({ reason: 'not_visible' });
    expect(denied[0]).not.toHaveProperty('surfaceId');
  });

  it('passes the model requestId to onDenied, and reports a throwing audit sink', async () => {
    const denied: DataSurfaceDeniedEntry[] = [];
    const failures: Array<{ action: string; error: unknown }> = [];
    const tools = createDataSurfaceTools({
      surfaces: [],
      onDenied: (entry) => {
        denied.push(entry);
      },
      onFailure: (entry) => {
        failures.push(entry);
      },
      audit: () => {
        throw new Error('audit down');
      },
    });
    await expect(
      tools
        .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
        ?.execute({
          run: fakeRun(),
          args: { surfaceId: 'x', request: { ...count, requestId: 'req-7' } },
          db: undefined,
        }),
    ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    expect(denied[0]?.requestId).toBe('req-7');
    expect(failures).toEqual([
      expect.objectContaining({
        action: 'query',
        error: expect.objectContaining({ message: 'audit down' }),
      }),
    ]);
  });

  it('omits the user, and skips the audit, for a run without one', async () => {
    const denied: DataSurfaceDeniedEntry[] = [];
    const audits: DataSurfaceAuditEntry[] = [];
    const tools = createDataSurfaceTools({
      surfaces: [],
      onDenied: (entry) => {
        denied.push(entry);
      },
      audit: (entry) => {
        audits.push(entry);
      },
    });
    const run = fakeRun();
    (run.context as { userId: string | null }).userId = null;
    await tools
      .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
      ?.execute({
        run,
        args: { surfaceId: 'x', request: count },
        db: undefined,
      })
      .catch(() => undefined);
    expect(denied).toEqual([
      { action: 'query', tenantId: 'tenant-a', reason: 'not_visible' },
    ]);
    expect(audits).toEqual([]);
  });

  it('rejects a non-string or empty surfaceId as a request error, with no denial', async () => {
    const actions: string[] = [];
    const { denied } = harness((action) => {
      actions.push(action);
      return [records];
    });
    const tools = createDataSurfaceTools({
      surfaces: (_run, { action }) => {
        actions.push(action);
        return [records];
      },
      onDenied: (entry) => {
        denied.push(entry);
      },
    });
    for (const slug of [DATA_QUERY_TOOL_SLUG, DATA_INSPECT_TOOL_SLUG]) {
      for (const surfaceId of [7, '']) {
        await expect(
          tools
            .find((tool) => tool.slug === slug)
            ?.execute({
              run: fakeRun(),
              args: { surfaceId, request: count },
              db: undefined,
            }),
        ).rejects.toBeInstanceOf(DataSurfaceRequestError);
      }
    }
    expect(denied).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('records no denied audit entry for a successful call, and keeps a null tenant', async () => {
    const { call, audits } = harness(() => [records]);
    await call(DATA_QUERY_TOOL_SLUG, { surfaceId: 'records', request: count });
    expect(audits).toHaveLength(1);
    expect(audits[0]).not.toHaveProperty('denied');

    const denied: DataSurfaceDeniedEntry[] = [];
    const tools = createDataSurfaceTools({
      surfaces: [],
      onDenied: (entry) => {
        denied.push(entry);
      },
    });
    await tools
      .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
      ?.execute({
        run: fakeRun(null),
        args: { surfaceId: 'x', request: count },
        db: undefined,
      })
      .catch(() => undefined);
    expect(denied).toEqual([
      {
        action: 'query',
        userId: 'user-a',
        tenantId: null,
        reason: 'not_visible',
      },
    ]);
  });

  it('reports an allow-list refusal to onDenied', async () => {
    const denied: DataSurfaceDeniedEntry[] = [];
    const tools = createDataSurfaceTools({
      surfaces: [records],
      onDenied: (entry) => {
        denied.push(entry);
      },
    });
    const run = fakeRun();
    run.assertToolAllowed = () => {
      throw new Error('not allowed');
    };
    await expect(
      tools
        .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
        ?.execute({
          run,
          args: { surfaceId: 'records', request: count },
          db: undefined,
        }),
    ).rejects.toThrow('not allowed');
    expect(denied).toEqual([
      {
        action: 'query',
        userId: 'user-a',
        tenantId: 'tenant-a',
        reason: 'tool_not_allowed',
      },
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
