/**
 * Acceptance coverage for the MCP-side half of issue #2638.
 * https://github.com/happyvertical/smrt/issues/2638
 *
 * #2650/PR #2651 already gated core's now-retired `CLIGenerator` (#2664)/
 * `findCliApiCoherenceViolations`
 * against framework lifecycle methods (`save`, `initialize`, `loadFromId`,
 * ...) so a locally declared override — e.g. `User.save()` in
 * `packages/users/src/models/User.ts` — is never advertised as a custom CLI
 * command. `MCPGenerator.generateTools()` had no equivalent gate: a class
 * overriding `save()` still emitted `${lowerName}_save` as an MCP tool,
 * duplicating what the generated `create`/`update` tools already do. This
 * file covers the MCP-side fix: `generateObjectTools()` now skips a
 * `FRAMEWORK_LIFECYCLE_METHOD_NAMES` member in both the strict-`include`
 * branch and the "show all discovered methods" default branch, mirroring
 * `assertCommandExposed`'s CLI-side rejection.
 *
 * It also covers the `mcp.exclude` case-fold fix (moved from #2648, landed
 * alongside this issue's MCP wiring): after #2646, `mcp.include` fails
 * CLOSED on a cased CRUD entry (a warning, and the entry is dropped).
 * `exclude` failed OPEN on a case mismatch — `exclude: ['Refresh']` against a
 * manifest method keyed `refresh` silently excluded nothing. Both branches
 * that read `exclude` now compare case-folded.
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

// Default (non-strict) MCP config, mirroring `User`'s real-world shape: a
// locally declared `save()` override plus a genuine custom method.
@smrt({ mcp: true })
class Issue2638McpLifecycleDefault extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  override async save(): Promise<this> {
    this.name = this.name.trim();
    return this;
  }

  async hasValidName(): Promise<boolean> {
    return this.name.length > 0;
  }
}

// Strict `include` naming a lifecycle method explicitly. It must still be
// rejected -- an include entry cannot override the "not a distinct
// operation" judgment, the same way it cannot smuggle in a CRUD verb (#2646).
@smrt({ mcp: { include: ['hasValidName', 'save'] } })
class Issue2638McpLifecycleInclude extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  override async save(): Promise<this> {
    this.name = this.name.trim();
    return this;
  }

  async hasValidName(): Promise<boolean> {
    return this.name.length > 0;
  }
}

// `exclude` names the method in the OPPOSITE case from how it is declared.
// A method declared `Refresh` (capitalized) excluded via a lowercase entry.
@smrt({ mcp: { exclude: ['refresh'] } })
class Issue2638McpExcludeCaseUpper extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async Refresh(): Promise<any> {
    return { ok: true };
  }

  async syncNow(): Promise<any> {
    return { ok: true };
  }
}

// Same asymmetry, the other direction: a method declared lowercase `refresh`
// excluded via a capitalized entry.
@smrt({ mcp: { exclude: ['Refresh'] } })
class Issue2638McpExcludeCaseLower extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async refresh(): Promise<any> {
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

describe('#2638 MCP framework-lifecycle gate', () => {
  it('does not expose a locally overridden lifecycle method as a custom tool by default', async () => {
    const names = await toolNamesFor('issue2638mcplifecycledefault');

    // The class's own genuine custom method is still advertised...
    expect(names).toContain('issue2638mcplifecycledefault_hasvalidname');
    // ...but its save() override -- the mechanism behind create/update, not a
    // distinct operation -- is not.
    expect(names).not.toContain('issue2638mcplifecycledefault_save');
  });

  it('rejects a lifecycle method even when explicitly named in `include`', async () => {
    const names = await toolNamesFor('issue2638mcplifecycleinclude');

    expect(names).toContain('issue2638mcplifecycleinclude_hasvalidname');
    expect(names).not.toContain('issue2638mcplifecycleinclude_save');
  });
});

describe('#2638 MCP `exclude` case-fold', () => {
  it('excludes a method declared uppercase via a lowercase exclude entry', async () => {
    const names = await toolNamesFor('issue2638mcpexcludecaseupper');

    expect(names).not.toContain('issue2638mcpexcludecaseupper_refresh');
    // An unrelated public method is unaffected.
    expect(names).toContain('issue2638mcpexcludecaseupper_syncnow');
  });

  it('excludes a method declared lowercase via a capitalized exclude entry', async () => {
    const names = await toolNamesFor('issue2638mcpexcludecaselower');

    expect(names).not.toContain('issue2638mcpexcludecaselower_refresh');
  });
});
