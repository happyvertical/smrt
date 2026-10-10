/**
 * The overview tool contract (#3727 phase 4) against a structural surface.
 * The real overview model behind the surface (smrt-svelte's
 * `createOverviewAssistantSurface`) is exercised end to end with these tools in
 * `packages/smrt-svelte/src/components/overview/__tests__/assistant-tools.integration.test.ts`
 * (smrt-svelte already depends on this package for tests; the reverse edge
 * would be a cycle).
 */
import type { PrincipalRun, PrincipalTool } from '@happyvertical/smrt-agents';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryOverviewUndoStore,
  createOverviewTools,
  formatOverviewIssues,
  OVERVIEW_APPLY_TOOL_SLUG,
  OVERVIEW_DESCRIBE_TOOL_SLUG,
  OVERVIEW_UNDO_TOOL_SLUG,
  OverviewToolError,
  type OverviewToolSurface,
  type OverviewToolsHost,
} from './overview-tools.js';
import { classifyToolError } from './tool-loop.js';

const ALL = [
  OVERVIEW_DESCRIBE_TOOL_SLUG,
  OVERVIEW_APPLY_TOOL_SLUG,
  OVERVIEW_UNDO_TOOL_SLUG,
];

function makeRun(
  userId: string | null,
  tenantId: string | null = 'tenant-a',
  allowedTools: string[] = ALL,
): PrincipalRun {
  return {
    context: { userId, tenantId } as PrincipalRun['context'],
    permissions: [],
    allowedTools,
    isToolAllowed: (tool: string) => allowedTools.includes(tool),
    assertToolAllowed(tool: string) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    assertOperation: async () => ({}) as never,
  } as PrincipalRun;
}

interface Stored {
  widgets: string[];
}

/**
 * A tiny overview: widgets are ids; `remove` and `add {type: 'note'}` are the
 * only valid ops. Each principal and page has its own stored value.
 */
function makeHost(
  options: { canCustomize?: (userId: string) => boolean } = {},
) {
  const store = new Map<string, Stored | null>();
  const persisted: Array<{ key: string; value: unknown }> = [];
  const keyOf = (run: PrincipalRun, page: string) =>
    `${run.context.tenantId}|${run.context.userId}|${page}`;
  const defaults = ['w1', 'w2', 'w3'];
  const host: OverviewToolsHost = {
    open(run, page) {
      if (page !== 'events.home') return null;
      const key = keyOf(run, page);
      const read = (): Stored | null => store.get(key) ?? null;
      const surface: OverviewToolSurface = {
        pageId: page,
        canCustomize: options.canCustomize
          ? options.canCustomize(String(run.context.userId))
          : true,
        describe: () => ({
          widgets: (read() ?? { widgets: defaults }).widgets,
        }),
        current: read,
        plan(operations) {
          const widgets = [...(read() ?? { widgets: defaults }).widgets];
          const issues: unknown[] = [];
          const results: unknown[] = [];
          (operations as Array<Record<string, unknown>>).forEach(
            (op, index) => {
              if (op.op === 'remove' && widgets.includes(String(op.id))) {
                widgets.splice(widgets.indexOf(String(op.id)), 1);
                results.push({ index, op: 'remove', id: op.id });
              } else if (op.op === 'add' && op.type === 'note') {
                const id = `w${widgets.length + 10}`;
                widgets.push(id);
                results.push({ index, op: 'add', id });
              } else {
                issues.push({
                  index,
                  op: op.op,
                  code: 'unknown_widget',
                  message: 'not valid here',
                });
              }
            },
          );
          if (issues.length) return { ok: false, issues };
          const same = widgets.join() === defaults.join();
          return {
            ok: true,
            override: same ? null : { widgets },
            document: { widgets },
            results,
          };
        },
        check: (override) =>
          override === null ||
          (typeof override === 'object' &&
            Array.isArray((override as Stored).widgets))
            ? { ok: true, override }
            : { ok: false, issues: [{ message: 'bad' }] },
        async persist(override) {
          persisted.push({ key, value: override });
          store.set(key, override as Stored | null);
        },
      };
      return surface;
    },
    pages: () => [{ id: 'events.home', title: 'Events' }],
  };
  return { host, store, persisted, keyOf };
}

function tools(
  host: OverviewToolsHost,
  extra: Partial<Parameters<typeof createOverviewTools>[0]> = {},
) {
  let n = 0;
  const list = createOverviewTools({
    host,
    createToken: () => `t${++n}`,
    ...extra,
  });
  return new Map(list.map((tool) => [tool.slug, tool])) as Map<
    string,
    PrincipalTool
  >;
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

describe('createOverviewTools', () => {
  it('declares three tools with closed parameter schemas', () => {
    const { host } = makeHost();
    const list = createOverviewTools({ host });
    expect(list.map((tool) => tool.slug)).toEqual(ALL);
    for (const tool of list) {
      expect(tool.aiTool.function.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  });

  it('describes a page, or lists the pages without one', async () => {
    const { host } = makeHost();
    const map = tools(host);
    await expect(
      call(map, OVERVIEW_DESCRIBE_TOOL_SLUG, alice, {}),
    ).resolves.toEqual({ pages: [{ id: 'events.home', title: 'Events' }] });
    await expect(
      call(map, OVERVIEW_DESCRIBE_TOOL_SLUG, alice, { page: 'events.home' }),
    ).resolves.toEqual({
      page: 'events.home',
      overview: { widgets: ['w1', 'w2', 'w3'] },
    });
  });

  it('enforces the allow-list on every tool', async () => {
    const { host } = makeHost();
    const map = tools(host);
    const none = makeRun('alice', 'tenant-a', []);
    for (const slug of ALL) {
      await expect(
        call(map, slug, none, { page: 'events.home', operations: [] }),
      ).rejects.toThrow(`denied:${slug}`);
    }
  });

  it('answers an unknown page as a repairable 404', async () => {
    const { host } = makeHost();
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, {
        page: 'billing.home',
        operations: [{ op: 'remove', id: 'w1' }],
      }),
    );
    expect(error).toMatchObject({ status: 404, code: 'unknown_page' });
    expect(classifyToolError(error)).toBe('invalid_request');
  });

  it('applies a batch, persists it and returns an undo token', async () => {
    const { host, persisted } = makeHost();
    const audit = vi.fn();
    const result = await call(
      tools(host, { audit }),
      OVERVIEW_APPLY_TOOL_SLUG,
      alice,
      {
        page: 'events.home',
        operations: [
          { op: 'remove', id: 'w2' },
          { op: 'add', type: 'note' },
        ],
      },
    );
    expect(result).toMatchObject({
      changed: true,
      undoToken: 't1',
      applied: [
        { op: 'remove', id: 'w2' },
        { op: 'add', id: 'w12' },
      ],
    });
    expect(persisted).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith({
      action: 'apply',
      pageId: 'events.home',
      operations: 2,
      userId: 'alice',
      tenantId: 'tenant-a',
    });
  });

  it('rejects the whole batch with a 422 listing the issues', async () => {
    const { host, persisted } = makeHost();
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, {
        page: 'events.home',
        operations: [
          { op: 'remove', id: 'w2' },
          { op: 'remove', id: 'w99' },
        ],
      }),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe('invalid_operations');
    expect(error.publicMessage).toContain('nothing changed');
    expect(error.publicMessage).toContain('#2 remove: not valid here');
    expect(error.issues).toHaveLength(1);
    expect(classifyToolError(error)).toBe('invalid_request');
    expect(persisted).toEqual([]);
  });

  it.each([
    [{ page: 'events.home', operations: [] }],
    [{ page: 'events.home', operations: 'remove w1' }],
    [{ page: '../etc', operations: [{ op: 'remove', id: 'w1' }] }],
  ])('rejects malformed arguments %#', async (args) => {
    const { host } = makeHost();
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, alice, args),
    );
    expect(error.status).toBe(422);
  });

  it('caps the batch size', async () => {
    const { host } = makeHost();
    const error = await rejection(
      call(tools(host, { maxOperations: 2 }), OVERVIEW_APPLY_TOOL_SLUG, alice, {
        page: 'events.home',
        operations: [
          { op: 'add', type: 'note' },
          { op: 'add', type: 'note' },
          { op: 'add', type: 'note' },
        ],
      }),
    );
    expect(error.code).toBe('invalid_operations');
  });

  it('refuses a principal who may not customize, as not permitted', async () => {
    const { host, persisted } = makeHost({
      canCustomize: (user) => user !== 'bob',
    });
    const error = await rejection(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, bob, {
        page: 'events.home',
        operations: [{ op: 'remove', id: 'w1' }],
      }),
    );
    expect(error.status).toBe(403);
    expect(classifyToolError(error)).toBe('not_permitted');
    expect(persisted).toEqual([]);
  });

  it('refuses a run without a user', async () => {
    const { host } = makeHost();
    await expect(
      call(tools(host), OVERVIEW_APPLY_TOOL_SLUG, makeRun(null), {
        page: 'events.home',
        operations: [{ op: 'remove', id: 'w1' }],
      }),
    ).rejects.toThrow();
  });

  it('does not persist or store an undo for a batch that changes nothing', async () => {
    const { host, persisted } = makeHost();
    const map = tools(host);
    const result = await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [
        { op: 'add', type: 'note' },
        { op: 'remove', id: 'w13' },
      ],
    });
    expect(result).toMatchObject({ changed: false, undoToken: null });
    expect(persisted).toEqual([]);
  });

  it('undo restores the exact prior override and is single-step', async () => {
    const { host, store, keyOf } = makeHost();
    const map = tools(host);
    const key = keyOf(alice, 'events.home');
    const first = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'remove', id: 'w1' }],
    })) as { undoToken: string };
    const afterFirst = structuredClone(store.get(key));
    const second = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'remove', id: 'w3' }],
    })) as { undoToken: string };

    // Only the latest batch can be undone.
    const stale = await rejection(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: first.undoToken,
      }),
    );
    expect(stale).toMatchObject({ status: 409, code: 'nothing_to_undo' });

    await expect(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: second.undoToken,
      }),
    ).resolves.toMatchObject({ undone: true });
    expect(store.get(key)).toEqual(afterFirst);

    // Single step: the same token does not undo twice.
    const again = await rejection(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: second.undoToken,
      }),
    );
    expect(again.code).toBe('nothing_to_undo');
  });

  it('undo back to the defaults restores null', async () => {
    const { host, store, keyOf } = makeHost();
    const map = tools(host);
    const applied = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'add', type: 'note' }],
    })) as { undoToken: string };
    await call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
      page: 'events.home',
      undoToken: applied.undoToken,
    });
    expect(store.get(keyOf(alice, 'events.home'))).toBeNull();
  });

  it("never lets one principal undo another's change", async () => {
    const { host, store, keyOf } = makeHost();
    const map = tools(host);
    const applied = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'remove', id: 'w1' }],
    })) as { undoToken: string };
    const aliceValue = structuredClone(store.get(keyOf(alice, 'events.home')));

    for (const other of [bob, makeRun('alice', 'tenant-b')]) {
      const error = await rejection(
        call(map, OVERVIEW_UNDO_TOOL_SLUG, other, {
          page: 'events.home',
          undoToken: applied.undoToken,
        }),
      );
      expect(error.code).toBe('nothing_to_undo');
    }
    expect(store.get(keyOf(alice, 'events.home'))).toEqual(aliceValue);
    expect(store.has(keyOf(bob, 'events.home'))).toBe(false);
    // Alice still can.
    await expect(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: applied.undoToken,
      }),
    ).resolves.toMatchObject({ undone: true });
  });

  it('does not undo over a change made after the batch', async () => {
    const { host, store, keyOf } = makeHost();
    const map = tools(host);
    const applied = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'remove', id: 'w1' }],
    })) as { undoToken: string };
    const key = keyOf(alice, 'events.home');
    store.set(key, { widgets: ['w3'] });
    const error = await rejection(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: applied.undoToken,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'changed_since' });
    expect(store.get(key)).toEqual({ widgets: ['w3'] });
  });

  it('refuses undo once the principal may no longer customize', async () => {
    let allowed = true;
    const { host } = makeHost({ canCustomize: () => allowed });
    const map = tools(host);
    const applied = (await call(map, OVERVIEW_APPLY_TOOL_SLUG, alice, {
      page: 'events.home',
      operations: [{ op: 'remove', id: 'w1' }],
    })) as { undoToken: string };
    allowed = false;
    const error = await rejection(
      call(map, OVERVIEW_UNDO_TOOL_SLUG, alice, {
        page: 'events.home',
        undoToken: applied.undoToken,
      }),
    );
    expect(error.status).toBe(403);
  });
});

describe('createMemoryOverviewUndoStore', () => {
  it('expires entries and drops the oldest over the cap', () => {
    let now = 0;
    const store = createMemoryOverviewUndoStore({
      ttlMs: 100,
      maxEntries: 2,
      now: () => now,
    });
    const entry = (token: string) => ({
      token,
      before: null,
      after: null,
      createdAt: now,
    });
    store.set('a', entry('a'));
    store.set('b', entry('b'));
    store.set('c', entry('c'));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toMatchObject({ token: 'b' });
    now = 101;
    expect(store.get('c')).toBeUndefined();
  });
});

describe('formatOverviewIssues', () => {
  it('numbers operations from one and labels batch issues', () => {
    expect(
      formatOverviewIssues([
        { index: 0, op: 'add', message: 'type "map" is not registered' },
        { index: null, op: null, code: 'too_many_operations' },
      ]),
    ).toBe('#1 add: type "map" is not registered; batch: too_many_operations');
  });
});
