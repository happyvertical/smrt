// Which generated surfaces of the shell models can load a ROW by id (#5191).
// A generated item route reads through the request's own database, which under
// the shell tables' row-level security carries the session's permissions and
// never the store marker, so each one is a place the policy must admit on
// purpose (`shellPolicySlugs`). Pin the set: a new instance action or CRUD on
// a shell model fails here until its policy has been thought through.
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import '../objects/index.ts';
import { SHELL_TENANT_MODELS, shellPolicySlugs } from './shell-tenancy.ts';

const CRUD = new Set(['list', 'get', 'create', 'update', 'delete']);

function surfaces(surface: 'api' | 'mcp' | 'cli') {
  const out: string[] = [];
  for (const name of SHELL_TENANT_MODELS) {
    const registered = ObjectRegistry.getClass(name);
    const config = (
      registered?.config as Record<string, unknown> | undefined
    )?.[surface];
    if (config === false) continue;
    const include = (config as { include?: string[] } | undefined)?.include;
    // Omitted (or without a list) is the full CRUD surface.
    if (!include) {
      out.push(`${name}: full CRUD`);
      continue;
    }
    const cls = registered?.constructor as unknown as {
      prototype: Record<string, unknown>;
    } & Record<string, unknown>;
    for (const action of include) {
      if (CRUD.has(action)) out.push(`${name}.${action}: CRUD`);
      // A static method is generated without an id (nothing loads a row); an
      // instance method is generated as `/[id]/<action>` and loads the row.
      else if (typeof cls[action] !== 'function')
        if (typeof cls.prototype[action] === 'function')
          out.push(`${name}.${action}: item action`);
    }
  }
  return out.sort();
}

describe('generated routes that load a shell row by id', () => {
  it('are exactly Approval.decide, in the API and MCP; none in the CLI', () => {
    expect(surfaces('api')).toEqual(['Approval.decide: item action']);
    expect(surfaces('mcp')).toEqual(['Approval.decide: item action']);
    expect(surfaces('cli')).toEqual([]);
  });

  it('admit the session’s own read permission only where such a route reads', () => {
    expect(shellPolicySlugs('Approval').SELECT).toContain('approvals.read');
    for (const name of SHELL_TENANT_MODELS.filter((m) => m !== 'Approval'))
      expect(shellPolicySlugs(name).SELECT, name).toEqual([
        'smrt-app-shell.store',
      ]);
    for (const action of ['INSERT', 'UPDATE', 'DELETE'] as const)
      expect(shellPolicySlugs('Approval')[action]).toEqual([
        'smrt-app-shell.store',
      ]);
  });
});
