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
