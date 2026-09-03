/**
 * Acceptance coverage for issue #2646 on the generated CLI command namespace.
 * https://github.com/happyvertical/smrt/issues/2646
 *
 * `generateObjectCommands` pushes `${lowerName}:${verb}` for each emitted CRUD
 * verb, then walks the class's merged methods pushing
 * `${lowerName}:${methodName}` as custom commands. That walk had no CRUD
 * filter, so a public merged method named after an EMITTED verb added a second
 * command under a name already taken — and `objectCommands.find` is first-match,
 * so the duplicate was unreachable.
 *
 * The skip has to be conditional on the verb actually being emitted:
 * `include: ['list', 'get']` emits no `create` command, so a public `create()`
 * collides with nothing and must stay a reachable custom command.
 *
 * Unlike MCP, this namespace is case-SENSITIVE — `${lowerName}:${methodName}`
 * keeps the method's declared casing and lookup compares exactly — so `foo:List`
 * is a distinct command and is not folded into `foo:list`.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

/** Build a minimal public MethodDefinition. */
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

/** Register one object's metadata into the spied registry. */
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

describe('#2646 CLI CRUD-named custom commands', () => {
  let cli: CLIGenerator;

  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(cli as any, 'tryLoadUserClasses').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Command names generated for the single stubbed object. */
  async function commandNames(): Promise<string[]> {
    await (cli as any).ensureManifestLoaded();
    const commands = await (cli as any).getObjectCommandsLazy('widget');
    return commands.map((command: any) => command.name);
  }

  it('emits an emitted CRUD verb exactly once when a public method shadows it', async () => {
    stubObject({ name: 'Widget', cli: true, methods: ['list', 'syncNow'] });

    const names = await commandNames();

    expect(names.filter((name) => name === 'widget:list')).toEqual([
      'widget:list',
    ]);
    // A non-CRUD method is still exposed.
    expect(names).toContain('widget:syncNow');
  });

  it('keeps a CRUD-named method whose verb is not emitted', async () => {
    // `create` is absent from the include list, so no `widget:create` CRUD
    // command exists to collide with — the custom command must survive.
    stubObject({
      name: 'Widget',
      cli: { include: ['list', 'get'] },
      methods: ['create'],
    });

    const names = await commandNames();

    expect(names).toContain('widget:create');
    expect(names.filter((name) => name === 'widget:create')).toEqual([
      'widget:create',
    ]);
  });

  it('keeps a differently-cased method as its own command', async () => {
    // This namespace is case-sensitive: `widget:List` never collides with
    // `widget:list`, so both are emitted.
    stubObject({ name: 'Widget', cli: true, methods: ['List'] });

    const names = await commandNames();

    expect(names).toContain('widget:list');
    expect(names).toContain('widget:List');
  });

  it('generates no duplicate command names', async () => {
    stubObject({
      name: 'Widget',
      cli: true,
      methods: ['list', 'get', 'create', 'update', 'delete', 'syncNow'],
    });

    const names = await commandNames();
    const duplicates = names.filter(
      (name, index) => names.indexOf(name) !== index,
    );

    expect(duplicates).toEqual([]);
  });
});
