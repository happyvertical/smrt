/**
 * Coverage-focused tests for the CLI command generator (cli-generator.ts).
 *
 * Strategy (per .claude/rules/testing.md — "test generators, not generated
 * output"):
 *  - Generator output is asserted by feeding object metadata through spied
 *    ObjectRegistry static methods and inspecting the produced CLICommand
 *    structures (include/exclude filtering, custom methods, instance vs
 *    singleton, option typing).
 *  - Handler branching (list/get/create/update/delete/custom/singleton) is
 *    exercised by substituting the private getCollection() with a small
 *    in-memory-backed collection (a real Map store, NOT a mocked DB adapter)
 *    so option parsing, error paths and output formatting are covered without
 *    standing up the full manifest/schema machinery (cli does not use
 *    smrtVitestPlugin).
 *  - Pure helpers (countRequiredArgs, preprocessObjectCommands, parseFieldValue,
 *    toYamlString, displayTable, spinner) are tested directly.
 *
 * isTestMode() returns true under vitest, so exitWithError() throws instead of
 * calling process.exit — error paths are assertable.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

/** Minimal in-memory collection backed by a Map (not a mocked DB adapter). */
function makeMemoryCollection(seed: Array<Record<string, any>> = []) {
  const store = new Map<string, any>();
  for (const row of seed) {
    store.set(row.id, { ...row });
  }
  let nextId = store.size + 1;
  return {
    store,
    async list(opts: any = {}) {
      let rows = Array.from(store.values());
      if (opts.where) {
        rows = rows.filter((r) =>
          Object.entries(opts.where).every(([k, v]) => r[k] === v),
        );
      }
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
    async get(id: string) {
      return store.get(id) ?? null;
    },
    async create(data: any) {
      const id = data.id ?? `id-${nextId++}`;
      const obj: any = {
        ...data,
        id,
        async save() {
          store.set(id, this);
        },
        async delete() {
          store.delete(id);
        },
      };
      return obj;
    },
  };
}

function clearRegistry() {
  // Mirror the boolean-options test's reset approach plus the public clear().
  (ObjectRegistry as any)._classes = new Map();
  (ObjectRegistry as any)._methods = new Map();
}

describe('CLIGenerator - pure helpers', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('parseFieldValue parses JSON and falls back to string', () => {
    const g = cli as any;
    expect(g.parseFieldValue('42')).toBe(42);
    expect(g.parseFieldValue('true')).toBe(true);
    expect(g.parseFieldValue('{"a":1}')).toEqual({ a: 1 });
    expect(g.parseFieldValue('plain text')).toBe('plain text');
  });

  it('toYamlString renders nested objects, arrays, scalars and nulls', () => {
    const g = cli as any;
    const yaml = g.toYamlString({
      name: 'x',
      empty: null,
      nested: { a: 1 },
      list: ['one', 'two'],
    });
    expect(yaml).toContain('name: x');
    expect(yaml).toContain('empty: null');
    expect(yaml).toContain('nested:');
    expect(yaml).toContain('  a: 1');
    expect(yaml).toContain('list:');
    expect(yaml).toContain('  - one');
  });

  it('isObjectTypeParameter discriminates inline object types', () => {
    const g = cli as any;
    expect(g.isObjectTypeParameter('{ a: string }')).toBe(true);
    expect(g.isObjectTypeParameter('string')).toBe(false);
  });

  it('displayTable prints a header/rows and a not-found message when empty', () => {
    const g = cli as any;
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    g.displayTable([], 'Widget');
    expect(logs.some((l) => l.includes('No Widget objects found'))).toBe(true);

    logs.length = 0;
    g.displayTable([{ id: '1', name: 'Alpha' }], 'Widget');
    expect(logs.some((l) => l.includes('id'))).toBe(true);
    expect(logs.some((l) => l.includes('Alpha'))).toBe(true);
    spy.mockRestore();
  });

  it('createSpinner falls back to console.log in non-TTY mode', () => {
    const g = new CLIGenerator({ colors: false }) as any;
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    const spinner = g.createSpinner('Working');
    expect(logs).toContain('Working');
    spinner.succeed('Done');
    spinner.fail('Bad');
    expect(logs).toContain('Done');
    expect(logs).toContain('Bad');
    spy.mockRestore();
  });
});

describe('CLIGenerator - countRequiredArgs / arg validation', () => {
  it('validates required vs optional args during executeCommand', async () => {
    const cli = new CLIGenerator({ prompt: false, colors: false });
    const handler = vi.fn();
    const commands = [
      { name: 'thing:do', description: 'd', args: ['id'], handler },
    ];
    // Missing the required 'id' arg -> exitWithError throws in test mode.
    await expect(
      (cli as any).executeCommand(
        { command: 'thing:do', args: [], options: {} },
        commands,
        [],
      ),
    ).rejects.toThrow(/Missing required arguments: id/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('treats [optional...] args as not required', async () => {
    const cli = new CLIGenerator({ prompt: false, colors: false });
    const handler = vi.fn().mockResolvedValue(undefined);
    const commands = [
      { name: 'thing:do', description: 'd', args: ['[pattern...]'], handler },
    ];
    await (cli as any).executeCommand(
      { command: 'thing:do', args: [], options: {} },
      commands,
      [],
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports a missing handler', async () => {
    const cli = new CLIGenerator({ prompt: false, colors: false });
    const commands = [{ name: 'thing:do', description: 'd' }];
    await expect(
      (cli as any).executeCommand(
        { command: 'thing:do', args: [], options: {} },
        commands,
        [],
      ),
    ).rejects.toThrow(/has no handler defined/);
  });

  it('wraps handler errors via exitWithError', async () => {
    const cli = new CLIGenerator({ prompt: false, colors: false });
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const commands = [{ name: 'thing:do', description: 'd', handler }];
    await expect(
      (cli as any).executeCommand(
        { command: 'thing:do', args: [], options: {} },
        commands,
        [],
      ),
    ).rejects.toThrow(/Error: boom/);
  });
});

describe('CLIGenerator - generateObjectCommands', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    clearRegistry();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearRegistry();
  });

  function stubRegistry(opts: {
    cli?: any;
    fields?: Map<string, any>;
    methods?: Map<string, any>;
  }) {
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      constructor: class Mock {},
      packageName: 'test',
    } as any);
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
      cli: opts.cli,
      api: false,
      mcp: false,
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      opts.fields ?? new Map(),
    );
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
      opts.methods ?? new Map(),
    );
  }

  it('returns no commands when cli config is false', async () => {
    stubRegistry({ cli: false });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    expect(cmds).toEqual([]);
  });

  it('generates full CRUD command set with field options when cli is true', async () => {
    const fields = new Map<string, any>([
      ['title', { type: 'text', options: { description: 'the title' } }],
      ['is_active', { type: 'boolean', options: {} }],
    ]);
    stubRegistry({ cli: true, fields });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const names = cmds.map((c: any) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'widget:list',
        'widget:get',
        'widget:create',
        'widget:update',
        'widget:delete',
      ]),
    );
    // Field names become kebab-case create options with descriptions.
    const create = cmds.find((c: any) => c.name === 'widget:create');
    expect(create.options.title.description).toBe('the title');
    expect(create.options['is-active']).toBeDefined();
    // list has aliases + pagination options.
    const list = cmds.find((c: any) => c.name === 'widget:list');
    expect(list.aliases).toContain('widget:ls');
    expect(list.options.limit.default).toBe('50');
  });

  it('honors include list (only listed CRUD commands generated)', async () => {
    stubRegistry({ cli: { include: ['list', 'get'] } });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const names = cmds.map((c: any) => c.name);
    expect(names).toContain('widget:list');
    expect(names).toContain('widget:get');
    expect(names).not.toContain('widget:create');
    expect(names).not.toContain('widget:delete');
  });

  it('honors exclude list', async () => {
    stubRegistry({ cli: { exclude: ['delete', 'update'] } });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const names = cmds.map((c: any) => c.name);
    expect(names).toContain('widget:list');
    expect(names).not.toContain('widget:delete');
    expect(names).not.toContain('widget:update');
  });

  it('includes public custom methods by default and skips non-public ones', async () => {
    const methods = new Map<string, any>([
      ['analyze', { name: 'analyze', isPublic: true, parameters: [] }],
      [
        'internalCalc',
        { name: 'internalCalc', isPublic: false, parameters: [] },
      ],
    ]);
    stubRegistry({ cli: true, methods });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const names = cmds.map((c: any) => c.name);
    expect(names).toContain('widget:analyze');
    expect(names).not.toContain('widget:internalcalc');
  });

  it('uses strict mode when include lists custom methods', async () => {
    const methods = new Map<string, any>([
      ['analyze', { name: 'analyze', isPublic: true, parameters: [] }],
      ['summarize', { name: 'summarize', isPublic: true, parameters: [] }],
    ]);
    stubRegistry({ cli: { include: ['analyze'] }, methods });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const names = cmds.map((c: any) => c.name);
    expect(names).toContain('widget:analyze');
    expect(names).not.toContain('widget:summarize');
  });

  it('marks methods with a leading id param as instance methods needing <id>', async () => {
    const methods = new Map<string, any>([
      [
        'rename',
        {
          name: 'rename',
          isPublic: true,
          parameters: [
            { name: 'id', type: 'string' },
            { name: 'newName', type: 'string' },
          ],
        },
      ],
      [
        'ping',
        {
          name: 'ping',
          isPublic: true,
          parameters: [{ name: 'host', type: 'string' }],
        },
      ],
    ]);
    stubRegistry({ cli: true, methods });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const rename = cmds.find((c: any) => c.name === 'widget:rename');
    const ping = cmds.find((c: any) => c.name === 'widget:ping');
    expect(rename.args).toEqual(['id']); // instance method
    expect(ping.args).toEqual([]); // singleton method
    // camelCase param -> kebab-case option.
    expect(rename.options['new-name']).toBeDefined();
  });

  it('builds JSON-string options for import() object property types', async () => {
    const methods = new Map<string, any>([
      [
        'configure',
        {
          name: 'configure',
          isPublic: true,
          parameters: [
            {
              name: 'opts',
              type: '{ payload?: import("x").Thing; name?: string }',
              optional: true,
            },
          ],
        },
      ],
    ]);
    stubRegistry({ cli: true, methods });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const configure = cmds.find((c: any) => c.name === 'widget:configure');
    expect(configure.options.payload.type).toBe('string');
    expect(configure.options.payload.description).toContain('JSON object');
  });

  it('respects default values on flat parameters', async () => {
    const methods = new Map<string, any>([
      [
        'retry',
        {
          name: 'retry',
          isPublic: true,
          parameters: [{ name: 'count', type: 'number', default: 3 }],
        },
      ],
    ]);
    stubRegistry({ cli: true, methods });
    const cmds = await (cli as any).generateObjectCommands('Widget', {});
    const retry = cmds.find((c: any) => c.name === 'widget:retry');
    expect(retry.options.count.default).toBe('3');
  });
});

describe('CLIGenerator - utility commands', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({
      name: 'smrt',
      version: '9.9.9',
      prompt: false,
      colors: false,
    });
    clearRegistry();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearRegistry();
  });

  it('version handler prints name and version', async () => {
    const cmds = cli.generateUtilityCommands();
    const version = cmds.find((c) => c.name === 'version');
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await version?.handler?.([], {});
    expect(logs.join('\n')).toContain('smrt v9.9.9');
    spy.mockRestore();
  });

  it('status handler reports connection state', async () => {
    const withCtx = new CLIGenerator(
      { name: 'smrt', version: '1.0.0', colors: false },
      { db: {}, user: { id: 'u1' } },
    );
    const status = withCtx
      .generateUtilityCommands()
      .find((c) => c.name === 'status');
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await status?.handler?.([], {});
    const out = logs.join('\n');
    expect(out).toContain('Database: Connected');
    expect(out).toContain('AI: Not available');
    expect(out).toContain('User: u1');
    spy.mockRestore();
  });

  it('objects handler prints empty-state guidance when nothing registered', async () => {
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    const objects = cli
      .generateUtilityCommands()
      .find((c) => c.name === 'objects');
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await objects?.handler?.([], {});
    expect(logs.join('\n')).toContain('No SMRT objects found');
    spy.mockRestore();
  });

  it('objects handler emits JSON output when --json passed', async () => {
    const classes = new Map<string, any>([
      [
        'test:Widget',
        { name: 'Widget', packageName: 'test', qualifiedName: 'test:Widget' },
      ],
    ]);
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(classes);
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({ cli: true } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([['title', { type: 'text' }]]),
    );
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
      new Map([['analyze', { name: 'analyze', isPublic: true }]]),
    );
    const objects = cli
      .generateUtilityCommands()
      .find((c) => c.name === 'objects');
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await objects?.handler?.([], { json: true });
    const json = JSON.parse(logs.join('\n'));
    expect(json['test:Widget'].name).toBe('Widget');
    expect(json['test:Widget'].package).toBe('test');
    spy.mockRestore();
  });

  it('objects handler groups by package in human mode (verbose)', async () => {
    const classes = new Map<string, any>([
      ['test:Widget', { name: 'Widget', packageName: 'test' }],
    ]);
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(classes);
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
      cli: { include: ['analyze'] },
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([['title', { type: 'text' }]]),
    );
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
      new Map([['analyze', { name: 'analyze', isPublic: true }]]),
    );
    const objects = cli
      .generateUtilityCommands()
      .find((c) => c.name === 'objects');
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await objects?.handler?.([], { verbose: true });
    const out = logs.join('\n');
    expect(out).toContain('test:');
    expect(out).toContain('Widget');
    expect(out).toContain('CLI: analyze');
    spy.mockRestore();
  });

  it('schema handler prints fields or errors on unknown object', async () => {
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([
        [
          'title',
          { type: 'text', options: { required: true, description: 'd' } },
        ],
      ]),
    );
    const schema = cli
      .generateUtilityCommands()
      .find((c) => c.name === 'schema');
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await schema?.handler?.(['Widget'], {});
    expect(logs.join('\n')).toContain('title: text (required)');
    spy.mockRestore();

    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
    await expect(schema?.handler?.(['Missing'], {})).rejects.toThrow(
      /Object Missing not found/,
    );
  });
});

describe('CLIGenerator - preprocessObjectCommands', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    clearRegistry();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearRegistry();
  });

  it('returns argv unchanged when fewer than 2 args', () => {
    const g = cli as any;
    expect(g.preprocessObjectCommands(['council'], [])).toEqual(['council']);
  });

  it('skips when first arg already uses colon syntax or is an option', () => {
    const g = cli as any;
    expect(g.preprocessObjectCommands(['a:b', 'x'], [])).toEqual(['a:b', 'x']);
    expect(g.preprocessObjectCommands(['--flag', 'x'], [])).toEqual([
      '--flag',
      'x',
    ]);
    expect(g.preprocessObjectCommands(['a', '--flag'], [])).toEqual([
      'a',
      '--flag',
    ]);
  });

  it('combines space-separated into colon syntax when it matches a command', () => {
    const g = cli as any;
    const commands = [{ name: 'council:list', description: 'd' }];
    expect(
      g.preprocessObjectCommands(['council', 'list', 'extra'], commands),
    ).toEqual(['council:list', 'extra']);
  });

  it('combines for known built-in namespaces', () => {
    const g = cli as any;
    expect(g.preprocessObjectCommands(['git', 'status'], [])).toEqual([
      'git:status',
    ]);
  });

  it('combines when first arg is a registered object name', () => {
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(
      new Map([['test:Council', { name: 'Council', packageName: 'test' }]]),
    );
    const g = cli as any;
    expect(g.preprocessObjectCommands(['council', 'analyze'], [])).toEqual([
      'council:analyze',
    ]);
  });

  it('returns argv unchanged when nothing matches', () => {
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    const g = cli as any;
    expect(g.preprocessObjectCommands(['random', 'thing'], [])).toEqual([
      'random',
      'thing',
    ]);
  });
});

describe('CLIGenerator - handlers (in-memory collection)', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('handleList outputs JSON when format=json and filters via where', async () => {
    const coll = makeMemoryCollection([
      { id: '1', name: 'A', kind: 'x' },
      { id: '2', name: 'B', kind: 'y' },
    ]);
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await (cli as any).handleList('Widget', {
      limit: '50',
      offset: '0',
      where: JSON.stringify({ kind: 'x' }),
      format: 'json',
    });
    const out = logs.join('\n');
    expect(out).toContain('"name": "A"');
    expect(out).not.toContain('"name": "B"');
    spy.mockRestore();
  });

  it('handleList renders a table by default', async () => {
    const coll = makeMemoryCollection([{ id: '1', name: 'A' }]);
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await (cli as any).handleList('Widget', {
      limit: '50',
      offset: '0',
      format: 'table',
    });
    expect(logs.some((l) => l.includes('A'))).toBe(true);
    spy.mockRestore();
  });

  it('handleList surfaces collection errors via exitWithError', async () => {
    vi.spyOn(cli as any, 'getCollection').mockRejectedValue(
      new Error('db down'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      (cli as any).handleList('Widget', { limit: '50', offset: '0' }),
    ).rejects.toThrow(/db down/);
  });

  it('handleGet returns JSON and yaml, and errors when not found', async () => {
    const coll = makeMemoryCollection([{ id: '1', name: 'A', meta: { z: 1 } }]);
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));

    await (cli as any).handleGet('Widget', '1', { format: 'json' });
    expect(logs.join('\n')).toContain('"name": "A"');

    logs.length = 0;
    await (cli as any).handleGet('Widget', '1', { format: 'yaml' });
    expect(logs.join('\n')).toContain('name: A');
    spy.mockRestore();

    await expect(
      (cli as any).handleGet('Widget', 'missing', { format: 'json' }),
    ).rejects.toThrow(/not found/);
  });

  it('handleCreate builds data from field options and saves', async () => {
    const coll = makeMemoryCollection();
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([
        ['title', { type: 'text' }],
        ['count', { type: 'integer' }],
      ]),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (cli as any).handleCreate('Widget', { title: 'Hi', count: '5' });
    const created = Array.from(coll.store.values())[0];
    expect(created.title).toBe('Hi');
    expect(created.count).toBe(5); // parseFieldValue coerces numeric strings
  });

  it('handleCreate reads from a JSON file when --from-file given', async () => {
    const coll = makeMemoryCollection();
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    // Use a real temp file (node:fs/promises readFile cannot be spied in ESM).
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'smrt-cli-'));
    const filePath = join(dir, 'x.json');
    await writeFile(filePath, JSON.stringify({ title: 'FromFile' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (cli as any).handleCreate('Widget', { fromFile: filePath });
    const created = Array.from(coll.store.values())[0];
    expect(created.title).toBe('FromFile');
  });

  it('handleUpdate merges fields into an existing object', async () => {
    const coll = makeMemoryCollection([{ id: '1', title: 'Old' }]);
    // Provide save/delete on the stored object so update path works.
    const stored = coll.store.get('1');
    stored.save = async () => coll.store.set('1', stored);
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([['title', { type: 'text' }]]),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (cli as any).handleUpdate('Widget', '1', { title: 'New' });
    expect(coll.store.get('1').title).toBe('New');
  });

  it('handleUpdate errors when the object is not found', async () => {
    const coll = makeMemoryCollection();
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      (cli as any).handleUpdate('Widget', 'nope', { title: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('handleDelete removes when --force is set', async () => {
    const coll = makeMemoryCollection([{ id: '1', name: 'A' }]);
    const stored = coll.store.get('1');
    stored.delete = async () => coll.store.delete('1');
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (cli as any).handleDelete('Widget', '1', { force: true });
    expect(coll.store.has('1')).toBe(false);
  });

  it('handleDelete cancels when confirmation is declined', async () => {
    const promptCli = new CLIGenerator({ prompt: true, colors: false });
    const coll = makeMemoryCollection([{ id: '1', name: 'A' }]);
    const stored = coll.store.get('1');
    stored.delete = vi.fn();
    vi.spyOn(promptCli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(promptCli as any, 'confirm').mockResolvedValue(false);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: any) =>
      logs.push(String(m ?? '')),
    );
    await (promptCli as any).handleDelete('Widget', '1', { force: false });
    expect(logs.join('\n')).toContain('Cancelled');
    expect(coll.store.has('1')).toBe(true);
  });

  it('handleDelete errors when object not found', async () => {
    const coll = makeMemoryCollection();
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      (cli as any).handleDelete('Widget', 'nope', { force: true }),
    ).rejects.toThrow(/not found/);
  });
});

describe('CLIGenerator - handleCustomMethod', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('invokes the instance method with mapped flat + object params', async () => {
    const analyze = vi.fn().mockResolvedValue({ ok: true });
    const obj = { id: '1', analyze };
    const coll = { get: async () => obj };
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue(coll as any);
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
      new Map([
        [
          'analyze',
          {
            name: 'analyze',
            isPublic: true,
            parameters: [
              { name: 'id', type: 'string' },
              {
                name: 'opts',
                type: '{ depth?: number; payload?: object }',
                optional: true,
              },
            ],
          },
        ],
      ]),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (cli as any).handleCustomMethod('Widget', '1', 'analyze', {
      depth: '3',
      payload: '{"a":1}',
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    const callArgs = analyze.mock.calls[0];
    // Both params are mapped from CLI options. The flat 'id' param has no --id
    // option provided, so it maps to undefined; the object param is
    // reconstructed from --depth/--payload (with JSON auto-parsing).
    expect(callArgs[0]).toBeUndefined();
    expect(callArgs[1]).toEqual({ depth: '3', payload: { a: 1 } });
  });

  it('errors when the object is not found', async () => {
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue({
      get: async () => null,
    } as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      (cli as any).handleCustomMethod('Widget', 'x', 'analyze', {}),
    ).rejects.toThrow(/not found/);
  });

  it('errors when the method definition is missing', async () => {
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue({
      get: async () => ({ id: '1' }),
    } as any);
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(new Map());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      (cli as any).handleCustomMethod('Widget', '1', 'analyze', {}),
    ).rejects.toThrow(/Method analyze not found/);
  });

  it('errors when the method is not callable on the instance', async () => {
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue({
      get: async () => ({ id: '1', analyze: 'not-a-fn' }),
    } as any);
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
      new Map([
        ['analyze', { name: 'analyze', isPublic: true, parameters: [] }],
      ]),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      (cli as any).handleCustomMethod('Widget', '1', 'analyze', {}),
    ).rejects.toThrow(/not callable/);
  });
});

describe('CLIGenerator - handleSingletonMethod', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    clearRegistry();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearRegistry();
  });

  it('errors with troubleshooting text when class constructor is absent', async () => {
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue(undefined as any);
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      (cli as any).handleSingletonMethod(
        'Widget',
        'doThing',
        {},
        {
          parameters: [],
        },
      ),
    ).rejects.toThrow(/not found/);
  });

  it('errors when constructor is a manifest stub', async () => {
    const stub: any = vi.fn();
    stub._isManifestStub = true;
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      constructor: stub,
      packageName: 'test',
    } as any);
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      (cli as any).handleSingletonMethod(
        'Widget',
        'doThing',
        {},
        {
          parameters: [],
        },
      ),
    ).rejects.toThrow(/registered from manifest/);
  });
});
