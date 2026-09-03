/**
 * Acceptance coverage for issue #2646 on the MCP tool catalog.
 * https://github.com/happyvertical/smrt/issues/2646
 *
 * `generateObjectTools` emits the five standard CRUD tools as
 * `${lowerName}_${verb}`, then walks the class's merged methods to emit custom
 * actions as `${lowerName}_${methodName}`. The strict (`include`) branch drops
 * CRUD verbs before that walk, and `CLIGenerator.listCommands` skips
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

import { describe, expect, it } from 'vitest';

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

// A strict `include` naming ONLY a cased CRUD verb. `shouldInclude('list')` is
// exact-match, so no standard list tool is emitted for this class — the include
// entry is the only thing that can produce `issue2646casedinclude_list`, and
// dropping it would leave the class with no list tool at all.
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

  it('keeps a cased include entry that collides with no emitted CRUD tool', async () => {
    const names = await toolNamesFor('issue2646casedinclude');

    // `include: ['List']` does not match the exact-match CRUD gate, so the
    // include entry is the ONLY source of this tool. It must survive.
    expect(names).toEqual(['issue2646casedinclude_list']);
  });

  it('drops a cased include entry that would collide with an emitted CRUD tool', async () => {
    const names = await toolNamesFor('issue2646casedincludecollision');

    // `include: ['list', 'List']` emits the standard tool, so the cased entry
    // is a collision and is dropped — one tool, not two.
    expect(names).toEqual(['issue2646casedincludecollision_list']);
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
