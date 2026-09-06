/**
 * Acceptance coverage for issue #2646 on the MCP tool catalog.
 * https://github.com/happyvertical/smrt/issues/2646
 *
 * `generateObjectTools` emits the five standard CRUD tools as
 * `${lowerName}_${verb}`, then walks the class's merged methods to emit custom
 * actions as `${lowerName}_${methodName}`. The strict (`include`) branch drops
 * CRUD verbs before that walk, and core's now-retired `CLIGenerator.
 * listCommands` (#2664) skipped
 * `CRUD_OPERATIONS` outright — but the non-strict branch (the default, no
 * `include` list) had no such filter, so a public merged method named after a
 * CRUD verb produced a SECOND tool under a name the CRUD tool already owned.
 * `sortMCPTools` sorts without deduping, so both survived into `tools/list`.
 *
 * The live trigger is a framework abstract base that overrides a collection
 * primitive — `SmrtReportCollection` overrides `list`/`get`, and #2624 keeps
 * such a base's methods mergeable into its subclasses — but the invariant is
 * about the tool NAMESPACE, not method provenance: a class declaring its own
 * domain method called `list` collides the same way.
 *
 * The namespace is also CASE-FOLDED. `buildCustomActionTool` lowercases the
 * whole identifier while the registry keys methods by declared casing, so a
 * method named `List` lands on `${lowerName}_list` as well and has to be
 * skipped by the same rule. The CLI namespace is case-SENSITIVE and keeps
 * `foo:List` as a distinct command, which is why the two transports read
 * different predicates over one shared verb list.
 */

import { describe, expect, it, vi } from 'vitest';

import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { MCPGenerator } from './mcp';

function smrt(config?: any) {
  return (target: any) => {
    ObjectRegistry.register(target, config);
    return target;
  };
}

// Default (non-strict) MCP config: no `include` list, so public methods are
// auto-exposed as custom actions. `list` and `update` shadow CRUD verbs.
@smrt({ mcp: true })
class Issue2646CrudNamed extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async list(): Promise<any> {
    return [];
  }

  async update(): Promise<any> {
    return { ok: true };
  }

  async syncNow(): Promise<any> {
    return { ok: true };
  }
}

// Same collision reached through casing: `List` is a distinct registry key, but
// `buildCustomActionTool` lowercases the whole tool identifier, so it resolves
// to the same `issue2646casedverb_list` the CRUD tool owns.
@smrt({ mcp: true })
class Issue2646CasedVerb extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async List(): Promise<any> {
    return [];
  }

  async Refresh(): Promise<any> {
    return { ok: true };
  }
}

// Two distinct, legitimate NON-CRUD methods differing only in case. Both
// `Refresh` and `refresh` lowercase onto the identical tool id
// `issue2638customcasecollision_refresh` — a collision `isCrudToolAction`
// cannot catch, because neither name is a CRUD verb (#2638, moved from
// #2648). `Refresh` is declared first, so it is the one whose tool survives.
@smrt({ mcp: true })
class Issue2638CustomCaseCollision extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async Refresh(): Promise<any> {
    return { ok: true, via: 'Refresh' };
  }

  async refresh(): Promise<any> {
    return { ok: true, via: 'refresh' };
  }
}

// A strict `include` naming ONLY a cased CRUD verb. Emitting it would build
// `issue2646casedinclude_list`, which `executeAction` dispatches on the parsed
// verb — so it would run the built-in CRUD list, never this class's `List()`,
// under a name the allowlist does not name exactly. `include` fails closed.
@smrt({ mcp: { include: ['List'] } })
class Issue2646CasedInclude extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async List(): Promise<any> {
    return [];
  }
}

// A strict `include` naming a CRUD verb BOTH exactly and in another casing. The
// standard tool is emitted here, so the cased entry would collide with it.
@smrt({ mcp: { include: ['list', 'List'] } })
class Issue2646CasedIncludeCollision extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async List(): Promise<any> {
    return [];
  }
}

/** Tool names emitted for one class, in catalog order. */
async function toolNamesFor(prefix: string): Promise<string[]> {
  const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
  const tools = await generator.generateTools();
  return tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith(`${prefix}_`));
}

describe('#2646 MCP CRUD-named custom actions', () => {
  it('emits each CRUD tool exactly once when a public method shadows the verb', async () => {
    const names = await toolNamesFor('issue2646crudnamed');

    expect(names.filter((name) => name === 'issue2646crudnamed_list')).toEqual([
      'issue2646crudnamed_list',
    ]);
    expect(
      names.filter((name) => name === 'issue2646crudnamed_update'),
    ).toEqual(['issue2646crudnamed_update']);
  });

  it('still auto-exposes non-CRUD public methods', async () => {
    const names = await toolNamesFor('issue2646crudnamed');

    expect(names).toContain('issue2646crudnamed_syncnow');
  });

  it('folds case when deciding a method shadows a CRUD verb', async () => {
    const names = await toolNamesFor('issue2646casedverb');

    // `List` lowercases onto the CRUD tool's identifier, so only one survives.
    expect(names.filter((name) => name === 'issue2646casedverb_list')).toEqual([
      'issue2646casedverb_list',
    ]);
    // A non-CRUD method keeps its lowercased tool name.
    expect(names).toContain('issue2646casedverb_refresh');
  });

  it('fails closed on a cased include entry, warning instead of leaking CRUD', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const names = await toolNamesFor('issue2646casedinclude');

      // The entry cannot become a custom action, and it does not name a CRUD
      // verb exactly, so `shouldInclude('list')` emits no standard tool either.
      // Emitting anything here would hand the caller the built-in list under a
      // name their allowlist never named.
      expect(names).toEqual([]);

      // The caller cannot otherwise see the entry was dropped, so warn.
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some(
          (message) =>
            message.includes("'List'") &&
            message.includes('issue2646casedinclude_list'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops a cased include entry that duplicates an exactly-named verb', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const names = await toolNamesFor('issue2646casedincludecollision');

      // `include: ['list', 'List']` emits the standard tool for `list`; the
      // cased entry is dropped, so the catalog holds one tool, not two.
      expect(names).toEqual(['issue2646casedincludecollision_list']);
    } finally {
      warn.mockRestore();
    }
  });

  it('#2638: dedupes two non-CRUD methods that differ only in case, keeping the first declared', async () => {
    const names = await toolNamesFor('issue2638customcasecollision');

    // Exactly one `obj_refresh` tool reaches the catalog, not two.
    expect(
      names.filter((name) => name === 'issue2638customcasecollision_refresh'),
    ).toEqual(['issue2638customcasecollision_refresh']);

    const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
    const tools = await generator.generateTools();
    const tool = tools.find(
      (t) => t.name === 'issue2638customcasecollision_refresh',
    );
    // Tie-break: first-declared-wins. `Refresh` is declared before `refresh`
    // on the fixture class, so its description (naming the exact declared
    // method) is the one that survives.
    expect(tool?.description).toContain('Refresh');
  });

  it('#2638: dispatches to the SAME method the catalog described, not whichever declared name equals the lowercase tool id', async () => {
    // `resolveCustomActionMethod` previously tried an exact `methods.get(toolAction)`
    // lookup first — `methods.get('refresh')` — before falling back to a
    // case-insensitive scan. Since `refresh` (all-lowercase) is itself one of
    // the two colliding declared names, that fast path always won, regardless
    // of which method the catalog's first-declared-wins dedup had just
    // described. A caller reading the `obj_refresh` tool's description
    // (naming `Refresh`) would have every reason to expect `Refresh` runs,
    // but `refresh` actually executed. Assert catalog and dispatch agree.
    const mockObject = new Issue2638CustomCaseCollision({
      db: null,
      ai: null,
      fs: null,
      id: 'case-collision-id',
    });
    const mockCollection = { get: vi.fn().mockResolvedValue(mockObject) };
    const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
    (generator as any).getCollection = vi.fn().mockReturnValue(mockCollection);
    (generator as any).collections = new Map([
      ['Issue2638CustomCaseCollision', mockCollection],
    ]);

    const response = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'issue2638customcasecollision_refresh',
        arguments: { id: 'case-collision-id' },
      },
    });

    const result = JSON.parse(response.content[0].text);
    // Must match the catalog's advertised method, not the exact-lowercase
    // declared name.
    expect(result.via).toBe('Refresh');
  });

  it('produces no duplicate tool names across the whole registry', async () => {
    const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
    const tools = await generator.generateTools();

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) duplicates.add(tool.name);
      seen.add(tool.name);
    }

    expect([...duplicates]).toEqual([]);
  });
});
