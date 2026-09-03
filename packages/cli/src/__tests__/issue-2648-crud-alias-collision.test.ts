/**
 * Acceptance coverage for issue #2648, part 1 — CLI CRUD command aliases.
 * https://github.com/happyvertical/smrt/issues/2648
 *
 * `generateObjectCommands` gives each CRUD command an alias: `list`→`ls`,
 * `get`→`show`, `create`→`new`, `update`→`edit`, `delete`→`rm`. #2646 taught the
 * custom-method walk to skip a method named after an EMITTED CRUD verb, but not
 * one named after that verb's alias.
 *
 * `findObjectCommand` matches `cmd.name === needle || cmd.aliases?.includes(needle)`
 * and takes the first hit, and CRUD commands are pushed before custom ones — so
 * a public `edit()` produced a second `widget:edit` that lookup could never
 * reach, while `--help` listed it with that method's own description.
 *
 * The reservation stays CONDITIONAL on the aliased command actually being
 * emitted, matching #2646's rule for this generator: each CLI command carries
 * its own handler, so a method whose aliased verb was never emitted collides
 * with nothing and remains a legitimate, reachable command.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

function method(name: string) {
  return {
    name,
    async: true,
    parameters: [],
    returnType: 'Promise<any>',
    isStatic: false,
    isPublic: true,
  };
}

function stubObject(opts: { name: string; cli?: any; methods?: string[] }) {
  const key = `project:${opts.name}`;
  const info: any = {
    name: opts.name,
    packageName: 'project',
    qualifiedName: key,
  };
  vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(
    new Map([[key, info]]),
  );
  vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue(info);
  vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
    cli: opts.cli ?? true,
    api: false,
    mcp: false,
  } as any);
  vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
  vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
    new Map((opts.methods ?? []).map((name) => [name, method(name)])),
  );
}

describe('#2648 CLI CRUD alias collisions', () => {
  let cli: CLIGenerator;

  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(cli as any, 'tryLoadUserClasses').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  async function commands(): Promise<any[]> {
    await (cli as any).ensureManifestLoaded();
    return (cli as any).getObjectCommandsLazy('widget');
  }

  /** Every name a caller could type: command names plus every alias. */
  async function addressableNames(): Promise<string[]> {
    return (await commands()).flatMap((c: any) => [
      c.name,
      ...(c.aliases ?? []),
    ]);
  }

  it.each([
    ['edit', 'widget:update'],
    ['rm', 'widget:delete'],
    ['ls', 'widget:list'],
    ['show', 'widget:get'],
    ['new', 'widget:create'],
  ])('does not emit a second addressable `widget:%s` shadowed by %s', async (aliasName, _owner) => {
    stubObject({ name: 'Widget', cli: true, methods: [aliasName, 'syncNow'] });

    const names = await addressableNames();

    expect(names.filter((n) => n === `widget:${aliasName}`)).toEqual([
      `widget:${aliasName}`,
    ]);
    // A genuinely custom method is unaffected.
    expect(names).toContain('widget:syncNow');
  });

  it('keeps an alias-named method whose aliased command is not emitted', async () => {
    // `update` is absent from the include list, so no `widget:update` command
    // and therefore no `widget:edit` alias exists to collide with. The class's
    // own `edit()` must stay reachable — #2646's conditional rule.
    stubObject({
      name: 'Widget',
      cli: { include: ['list', 'get'] },
      methods: ['edit'],
    });

    const names = await addressableNames();

    expect(names).toContain('widget:edit');
    expect(names.filter((n) => n === 'widget:edit')).toEqual(['widget:edit']);
  });

  it('generates no duplicate addressable name for any CRUD verb or alias', async () => {
    stubObject({
      name: 'Widget',
      cli: true,
      methods: [
        'list',
        'get',
        'create',
        'update',
        'delete',
        'ls',
        'show',
        'new',
        'edit',
        'rm',
        'syncNow',
      ],
    });

    const names = await addressableNames();
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);

    expect(duplicates).toEqual([]);
  });
});
