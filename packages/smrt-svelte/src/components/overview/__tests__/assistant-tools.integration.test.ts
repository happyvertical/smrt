/**
 * The chat overview tools (`createOverviewTools`, #3727 phase 4) over the real
 * overview model: a host built from `createOverviewAssistantSurface`, the way
 * an application wires it to its persisted overrides (phase 3). Chat types the
 * surface structurally; this proves the two halves agree.
 */
import type { PrincipalRun, PrincipalTool } from '@happyvertical/smrt-agents';
import {
  classifyToolError,
  createOverviewTools,
  OVERVIEW_APPLY_TOOL_SLUG,
  OVERVIEW_DESCRIBE_TOOL_SLUG,
  OVERVIEW_UNDO_TOOL_SLUG,
  OverviewToolError,
  type OverviewToolsHost,
} from '@happyvertical/smrt-chat';
import { describe, expect, it } from 'vitest';
import { createOverviewAssistantSurface } from '../assistant-surface.js';
import { checkOverviewOverride, resolveOverview } from '../model.js';
import type { OverviewOverride } from '../types.js';
import { coreRegistry, definition as fixture } from './app-fixtures.js';

const ALL = [
  OVERVIEW_DESCRIBE_TOOL_SLUG,
  OVERVIEW_APPLY_TOOL_SLUG,
  OVERVIEW_UNDO_TOOL_SLUG,
];

const definition = {
  ...fixture,
  allowed: ['metric', 'chart', 'records', 'note'],
};
const registry = coreRegistry();

function makeRun(userId: string, tenantId = 'tenant-a'): PrincipalRun {
  return {
    context: { userId, tenantId } as PrincipalRun['context'],
    permissions: [],
    allowedTools: ALL,
    isToolAllowed: (tool: string) => ALL.includes(tool),
    assertToolAllowed(tool: string) {
      if (!ALL.includes(tool)) throw new Error(`denied:${tool}`);
    },
    assertOperation: async () => ({}) as never,
  } as PrincipalRun;
}

/**
 * Stands in for the phase-3 table: one user-tier row per tenant/user/page,
 * written only when the caller's revision is still the stored one (the core
 * revision guard the phase-3 store uses).
 */
function makeHost(admins: readonly string[] = ['alice', 'bob']) {
  const rows = new Map<string, OverviewOverride | null>();
  const revisions = new Map<string, string>();
  let seq = 0;
  const keyOf = (run: PrincipalRun) =>
    `${run.context.tenantId}|${run.context.userId}|${definition.id}`;
  /** A save from elsewhere (another tab, the grid): bumps the revision. */
  const saveElsewhere = (key: string, override: OverviewOverride | null) => {
    rows.set(key, override);
    revisions.set(key, `r${++seq}`);
  };
  const hooks: { beforePersist?: (key: string) => void } = {};
  const host: OverviewToolsHost = {
    open(run, pageId) {
      if (pageId !== definition.id) return null;
      const key = keyOf(run);
      return createOverviewAssistantSurface({
        definition,
        registry,
        override: rows.get(key) ?? null,
        revision: revisions.get(key) ?? null,
        canCustomize: admins.includes(String(run.context.userId)),
        persist: (override, expected) => {
          hooks.beforePersist?.(key);
          if ((revisions.get(key) ?? null) !== expected.revision) {
            return { ok: false, reason: 'conflict' };
          }
          // What a save endpoint does: validate, store the canonical value.
          const checked = checkOverviewOverride(definition, override, registry);
          if (!checked.ok) {
            return { ok: false, reason: 'invalid', issues: checked.issues };
          }
          saveElsewhere(key, checked.override);
          return { ok: true, revision: revisions.get(key) ?? null };
        },
      });
    },
  };
  return { host, rows, keyOf, saveElsewhere, hooks };
}

function tools(host: OverviewToolsHost) {
  return new Map(
    createOverviewTools({ host }).map((tool) => [tool.slug, tool]),
  ) as Map<string, PrincipalTool>;
}

const call = (
  map: Map<string, PrincipalTool>,
  slug: string,
  run: PrincipalRun,
  args: Record<string, unknown>,
) => (map.get(slug) as PrincipalTool).execute({ run, args });

async function rejection(
  promise: Promise<unknown>,
): Promise<OverviewToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OverviewToolError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const alice = makeRun('alice');
const bob = makeRun('bob');

describe('overview assistant tools over the real model', () => {
  it('describes the allowed types and the arrangement', async () => {
    const { host } = makeHost();
    const result = (await call(
      tools(host),
      OVERVIEW_DESCRIBE_TOOL_SLUG,
      alice,
      {
        page: 'events.home',
      },
    )) as {
      overview: { widgetTypes: Array<{ type: string }>; widgets: unknown[] };
    };
    expect(result.overview.widgetTypes.map((t) => t.type)).toEqual([
      'note',
      'metric',
      'chart',
      'records',
    ]);
    expect(result.overview.widgets).toHaveLength(4);
  });

  it('adds a chart and persists an override the save endpoint accepts', async () => {
    const { host, rows, keyOf } = makeHost();
    const result = (await call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [
        {
          op: 'add',
          type: 'chart',
          span: 2,
          options: {
            title: 'Overdue invoices',
            model: 'events:Event',
            groupBy: 'status',
            filter: 'overdue',
          },
        },
      ],
    })) as { changed: boolean; applied: Array<{ id: string }> };
    expect(result.changed).toBe(true);
    const stored = rows.get(keyOf(alice)) ?? null;
    expect(stored?.added?.[0]).toMatchObject({
      id: 'w5',
      type: 'chart',
      options: { title: 'Overdue invoices', filter: 'overdue' },
    });
    expect(
      resolveOverview(definition, stored, registry).overrideIssues,
    ).toEqual([]);
  });

  it.each([
    ['a disallowed type', { op: 'add', type: 'shortcuts' }, 'type_not_allowed'],
    ['an unregistered type', { op: 'add', type: 'map' }, 'unknown_type'],
    [
      'bad options',
      {
        op: 'add',
        type: 'chart',
        options: { model: 'events:Event', period: 'forever' },
      },
      'invalid_options',
    ],
    [
      'a model outside the page',
      { op: 'add', type: 'metric', options: { model: 'billing:Invoice' } },
      'invalid_options',
    ],
    [
      'an unknown widget id',
      { op: 'configure', id: 'w42', options: {} },
      'unknown_widget',
    ],
  ])('rejects %s as a repairable 422', async (_label, operation, code) => {
    const { host, rows } = makeHost();
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, {
        page: 'events.home',
        operations: [operation],
      }),
    );
    expect(error.status).toBe(422);
    expect(classifyToolError(error)).toBe('invalid_request');
    expect(error.issues[0]).toMatchObject({ index: 0, code });
    expect(error.publicMessage).toMatch(/^The batch was rejected/);
    expect(rows.size).toBe(0);
  });

  it('applies nothing when one operation of the batch is invalid', async () => {
    const { host, rows } = makeHost();
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, {
        page: 'events.home',
        operations: [
          { op: 'remove', id: 'w1' },
          { op: 'resize', id: 'w2', span: 9 },
        ],
      }),
    );
    expect(error.issues).toEqual([
      expect.objectContaining({ index: 1, code: 'invalid_span' }),
    ]);
    expect(rows.size).toBe(0);
  });

  it('refuses a principal who may not customize', async () => {
    const { host, rows } = makeHost(['alice']);
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, bob, {
        page: 'events.home',
        operations: [{ op: 'remove', id: 'w1' }],
      }),
    );
    expect(classifyToolError(error)).toBe('not_permitted');
    expect(rows.size).toBe(0);
  });

  it('undo restores the exact prior override, scoped to principal and page', async () => {
    const { host, rows, keyOf } = makeHost();
    const map = tools(host);
    await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'resize', id: 'w1', span: 3 }],
    });
    const before = structuredClone(rows.get(keyOf(alice)));
    const applied = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [
        {
          op: 'configure',
          id: 'w1',
          options: { measure: 'sum', field: 'total' },
        },
        { op: 'remove', id: 'w3' },
        { op: 'move', id: 'w4', index: 0 },
      ],
    })) as { undoToken: string };
    expect(rows.get(keyOf(alice))).not.toEqual(before);

    // Bob, and Alice in another tenant, cannot use Alice's token.
    for (const other of [bob, makeRun('alice', 'tenant-b')]) {
      const error = await rejection(
        call(map, OVERVIEW_UNDO_TOOL_SLUG, other, {
          page: 'events.home',
          undoToken: applied.undoToken,
        }),
      );
      expect(error.code).toBe('nothing_to_undo');
    }
    expect(rows.has(keyOf(bob))).toBe(false);

    await call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
      page: 'events.home',
      undoToken: applied.undoToken,
    });
    expect(rows.get(keyOf(alice))).toEqual(before);
  });

  it('refuses to apply over a save that landed after the page was opened', async () => {
    const { host, rows, keyOf, saveElsewhere, hooks } = makeHost();
    const elsewhere: OverviewOverride = { version: 1, removed: ['w4'] };
    hooks.beforePersist = (key) => {
      hooks.beforePersist = undefined;
      saveElsewhere(key, elsewhere);
    };
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, {
        page: 'events.home',
        operations: [{ op: 'remove', id: 'w1' }],
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'conflict' });
    expect(classifyToolError(error)).toBe('invalid_request');
    expect(rows.get(keyOf(alice))).toEqual(elsewhere);
  });

  it('refuses to undo over a save that landed after the page was opened, and keeps the undo', async () => {
    const { host, rows, keyOf, saveElsewhere, hooks } = makeHost();
    const map = tools(host);
    const applied = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'remove', id: 'w1' }],
    })) as { undoToken: string };
    const after = rows.get(keyOf(alice)) ?? null;
    // The save lands between undo's open (which still sees `after`) and its
    // write: the snapshot check passes, the conditional write must not.
    hooks.beforePersist = (key) => {
      hooks.beforePersist = undefined;
      saveElsewhere(key, after);
    };
    const error = await rejection(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: applied.undoToken,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'changed_since' });
    expect(rows.get(keyOf(alice))).toEqual(after);
    // The entry was not consumed: a retry against the fresh revision undoes.
    await expect(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: applied.undoToken,
      }),
    ).resolves.toMatchObject({ undone: true });
    expect(rows.get(keyOf(alice))).toBeNull();
  });
});
