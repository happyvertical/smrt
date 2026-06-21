/**
 * Coverage for CLIGenerator dispatch/lazy-loading/help flows.
 *
 * These exercise the orchestration layer — ensureManifestLoaded(),
 * getObjectCommandsLazy(), findObjectCommand(), generateAllCommands(),
 * executeCommand() built-in + object-help branches, showObjectHelp(),
 * getCollection(), promptForFields(), and the singleton-method happy path.
 *
 * tryLoadUserClasses() is stubbed to a no-op (it imports the consumer's
 * compiled classes from disk, irrelevant here) and ObjectRegistry getters are
 * spied to feed controlled object metadata. A real in-memory SQLite database is
 * used for getCollection() — no DB mocking.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

function silenceConsole() {
  const logs: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((m?: any) => logs.push(String(m ?? '')));
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    logs,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

/** Register a single object's metadata into the spied registry. */
function stubObject(opts: {
  name: string;
  key?: string;
  packageName?: string;
  cli?: any;
  constructor?: any;
  collectionConstructor?: any;
  fields?: Map<string, any>;
  methods?: Map<string, any>;
}) {
  const key = opts.key ?? `${opts.packageName ?? 'project'}:${opts.name}`;
  const info: any = {
    name: opts.name,
    packageName: opts.packageName ?? 'project',
    qualifiedName: key,
    constructor: opts.constructor,
    collectionConstructor: opts.collectionConstructor,
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
  vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
    opts.fields ?? new Map(),
  );
  vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
    opts.methods ?? new Map(),
  );
  return { key, info };
}

describe('CLIGenerator - lazy command resolution', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    // Prevent disk class loading; we drive the registry via spies.
    vi.spyOn(cli as any, 'tryLoadUserClasses').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('ensureManifestLoaded builds the registered-name set once', async () => {
    stubObject({ name: 'Council', cli: { include: ['list'] } });
    await (cli as any).ensureManifestLoaded();
    expect((cli as any).manifestLoaded).toBe(true);
    expect((cli as any).registeredObjectNames.has('council')).toBe(true);
    // Second call short-circuits (no throw, idempotent).
    await (cli as any).ensureManifestLoaded();
    expect((cli as any).manifestLoaded).toBe(true);
  });

  it('getObjectCommandsLazy returns and caches commands for a known object', async () => {
    stubObject({ name: 'Council', cli: { include: ['list', 'get'] } });
    await (cli as any).ensureManifestLoaded();
    const first = await (cli as any).getObjectCommandsLazy('council');
    expect(first.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['council:list', 'council:get']),
    );
    // Cached on second call.
    const second = await (cli as any).getObjectCommandsLazy('council');
    expect(second).toBe(first);
  });

  it('getObjectCommandsLazy returns [] for an unknown object', async () => {
    stubObject({ name: 'Council' });
    await (cli as any).ensureManifestLoaded();
    expect(await (cli as any).getObjectCommandsLazy('nonexistent')).toEqual([]);
  });

  it('findObjectCommand resolves colon-form commands and rejects non-objects', async () => {
    stubObject({ name: 'Council', cli: { include: ['list'] } });
    const found = await (cli as any).findObjectCommand('council:list');
    expect(found?.name).toBe('council:list');
    // Non-colon command -> undefined.
    expect(await (cli as any).findObjectCommand('list')).toBeUndefined();
    // Colon command for unknown object -> undefined.
    expect(
      await (cli as any).findObjectCommand('mystery:list'),
    ).toBeUndefined();
  });

  it('generateAllCommands merges utility + object commands', async () => {
    stubObject({ name: 'Council', cli: { include: ['list'] } });
    const all = await (cli as any).generateAllCommands();
    const names = all.map((c: any) => c.name);
    expect(names).toContain('objects'); // utility
    expect(names).toContain('council:list'); // object
  });
});

describe('CLIGenerator - executeCommand dispatch', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(cli as any, 'tryLoadUserClasses').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows full help when no command is given', async () => {
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    const showHelp = vi
      .spyOn(cli as any, 'showHelp')
      .mockResolvedValue(undefined);
    await (cli as any).executeCommand(
      { command: undefined, args: [], options: {} },
      [],
    );
    expect(showHelp).toHaveBeenCalled();
  });

  it('dispatches a lazily-resolved object command', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(cli as any, 'findObjectCommand').mockResolvedValue({
      name: 'council:list',
      description: 'd',
      handler,
    });
    await (cli as any).executeCommand(
      { command: 'council:list', args: [], options: {} },
      [],
      ['council:list'],
    );
    expect(handler).toHaveBeenCalled();
  });

  it('raises "Unknown command" after exhausting object + built-in lookups', async () => {
    // No object command and no built-in command matches. This drives the full
    // fall-through: lazy object lookup, the built-in command loaders, and the
    // registered-object-name check, ending in the unknown-command error.
    vi.spyOn(cli as any, 'findObjectCommand').mockResolvedValue(undefined);
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    const { restore } = silenceConsole();
    await expect(
      (cli as any).executeCommand(
        { command: 'definitely-not-a-command', args: [], options: {} },
        [],
        ['definitely-not-a-command'],
      ),
    ).rejects.toThrow(/Unknown command/);
    restore();
  });

  it('shows object help when command matches a registered object name', async () => {
    stubObject({ name: 'Council', cli: { include: ['list'] } });
    vi.spyOn(cli as any, 'findObjectCommand').mockResolvedValue(undefined);
    const showObjectHelp = vi
      .spyOn(cli as any, 'showObjectHelp')
      .mockResolvedValue(undefined);
    await (cli as any).executeCommand(
      { command: 'council', args: [], options: {} },
      [],
      ['council'],
    );
    expect(showObjectHelp).toHaveBeenCalledWith('Council', expect.anything());
  });
});

describe('CLIGenerator - showObjectHelp', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists commands, options and fields for an object', async () => {
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Council',
      packageName: 'test',
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([['title', { type: 'text', options: { required: true } }]]),
    );
    const { logs, restore } = silenceConsole();
    await (cli as any).showObjectHelp('Council', [
      {
        name: 'council:list',
        description: 'List councils',
        args: ['id'],
        options: { limit: { description: 'max', short: 'l', default: '50' } },
      },
    ]);
    const out = logs.join('\n');
    expect(out).toContain('Council');
    expect(out).toContain('Package: test');
    expect(out).toContain('smrt council list <id>');
    expect(out).toContain('--limit');
    expect(out).toContain('title: text (required)');
    restore();
  });

  it('shows guidance when an object has no CLI commands', async () => {
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Council',
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
    const { logs, restore } = silenceConsole();
    await (cli as any).showObjectHelp('Council', []);
    expect(logs.join('\n')).toContain('No CLI commands available');
    restore();
  });
});

describe('CLIGenerator - getCollection (real in-memory SQLite)', () => {
  let cli: CLIGenerator;
  afterEach(() => vi.restoreAllMocks());

  it('throws a helpful error when no collection constructor is registered', async () => {
    cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue(undefined as any);
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    await expect((cli as any).getCollection('Widget')).rejects.toThrow(
      /not found or has no collection constructor/,
    );
  });

  it('constructs and initializes a collection using the context db', async () => {
    const { getDatabase } = await import('@happyvertical/sql');
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    cli = new CLIGenerator({ prompt: false, colors: false }, { db });

    const initialize = vi.fn().mockResolvedValue(undefined);
    const captured: any[] = [];
    class FakeCollection {
      constructor(opts: any) {
        captured.push(opts);
      }
      initialize = initialize;
    }
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Widget',
      collectionConstructor: FakeCollection as any,
    } as any);

    const coll = await (cli as any).getCollection('Widget');
    expect(coll).toBeInstanceOf(FakeCollection);
    expect(initialize).toHaveBeenCalled();
    // Real db handle passed through.
    expect(captured[0].db).toBe(db);
    // Cached on second call (same instance, no re-init).
    initialize.mockClear();
    const again = await (cli as any).getCollection('Widget');
    expect(again).toBe(coll);
    expect(initialize).not.toHaveBeenCalled();
  });
});

describe('CLIGenerator - promptForFields', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: true, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('collects text and boolean fields, falling back to current values', async () => {
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map([
        ['title', { type: 'text', options: { description: 'the title' } }],
        ['active', { type: 'boolean', options: {} }],
        ['keep', { type: 'text', options: {} }],
      ]),
    );
    // title -> typed value, active -> confirm true, keep -> empty (use current).
    vi.spyOn(cli as any, 'prompt').mockImplementation(async (msg: any) => {
      if (String(msg).startsWith('title')) return 'My Title';
      return ''; // 'keep' returns empty
    });
    vi.spyOn(cli as any, 'confirm').mockResolvedValue(true);

    const result = await (cli as any).promptForFields('Widget', {
      keep: 'existing',
    });
    expect(result.title).toBe('My Title');
    expect(result.active).toBe(true);
    expect(result.keep).toBe('existing');
  });
});

describe('CLIGenerator - handleSingletonMethod happy path', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('constructs the class, initializes it, and calls the method with mapped params', async () => {
    const doThing = vi.fn().mockResolvedValue({ done: true });
    const initialize = vi.fn().mockResolvedValue(undefined);
    class Widget {
      doThing = doThing;
      initialize = initialize;
    }
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Widget',
      constructor: Widget as any,
      packageName: 'test',
    } as any);
    const { logs, restore } = silenceConsole();
    await (cli as any).handleSingletonMethod(
      'Widget',
      'doThing',
      { count: '7' },
      {
        parameters: [{ name: 'count', type: 'number' }],
      },
    );
    expect(initialize).toHaveBeenCalled();
    expect(doThing).toHaveBeenCalledWith('7');
    expect(logs.join('\n')).toContain('"done": true');
    restore();
  });

  it('errors when the named method is not a function', async () => {
    class Widget {
      label = 'widget';
    }
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Widget',
      constructor: Widget as any,
    } as any);
    const { restore } = silenceConsole();
    await expect(
      (cli as any).handleSingletonMethod(
        'Widget',
        'missing',
        {},
        {
          parameters: [],
        },
      ),
    ).rejects.toThrow();
    restore();
  });

  it('passes {} for a required object param with no options and uses flat defaults', async () => {
    const doThing = vi.fn().mockResolvedValue(undefined);
    class Widget {
      doThing = doThing;
    }
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Widget',
      constructor: Widget as any,
    } as any);
    const { restore } = silenceConsole();
    await (cli as any).handleSingletonMethod(
      'Widget',
      'doThing',
      {},
      {
        parameters: [
          { name: 'opts', type: '{ a?: string }', optional: false },
          { name: 'retries', type: 'number', default: 5 },
        ],
      },
    );
    // Required object param with no matching options -> {}; flat default -> 5.
    expect(doThing).toHaveBeenCalledWith({}, 5);
    restore();
  });

  it('runs in JSON mode and silences spinner output', async () => {
    const doThing = vi.fn().mockResolvedValue({ v: 1 });
    class Widget {
      doThing = doThing;
    }
    vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
      name: 'Widget',
      constructor: Widget as any,
    } as any);
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m?: any) => logs.push(String(m ?? '')));
    await (cli as any).handleSingletonMethod(
      'Widget',
      'doThing',
      { json: true },
      {
        parameters: [],
      },
    );
    // Only the JSON result should be printed.
    expect(logs.join('\n')).toContain('"v": 1');
    spy.mockRestore();
  });
});

describe('CLIGenerator - handleCustomMethod param edge cases', () => {
  let cli: CLIGenerator;
  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false, colors: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes {} for required object param, undefined for optional, and flat default', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue({
      get: async () => ({ id: '1', run }),
    } as any);
    vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
      new Map([
        [
          'run',
          {
            name: 'run',
            isPublic: true,
            parameters: [
              { name: 'required', type: '{ a?: string }', optional: false },
              { name: 'optionalObj', type: '{ b?: string }', optional: true },
              { name: 'count', type: 'number', default: 9 },
            ],
          },
        ],
      ]),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (cli as any).handleCustomMethod('Widget', '1', 'run', {});
    expect(run).toHaveBeenCalledWith({}, undefined, 9);
  });
});

describe('CLIGenerator - createSpinner TTY branch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes spinner frames and uses clearLine/cursorTo when TTY + colors', () => {
    const cli = new CLIGenerator({ colors: true });
    const writes: string[] = [];
    const stdout = process.stdout as any;
    const origIsTTY = stdout.isTTY;
    const origClear = stdout.clearLine;
    const origCursor = stdout.cursorTo;
    const origWrite = stdout.write;
    try {
      stdout.isTTY = true;
      stdout.clearLine = vi.fn();
      stdout.cursorTo = vi.fn();
      stdout.write = vi.fn((s: string) => {
        writes.push(s);
        return true;
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const spinner = (cli as any).createSpinner('Loading');
      spinner.succeed('Loaded');
      spinner.fail('Failed');
      expect(writes.some((w) => w.includes('Loading'))).toBe(true);
      expect(stdout.clearLine).toHaveBeenCalled();
      expect(stdout.cursorTo).toHaveBeenCalled();
      logSpy.mockRestore();
    } finally {
      stdout.isTTY = origIsTTY;
      stdout.clearLine = origClear;
      stdout.cursorTo = origCursor;
      stdout.write = origWrite;
    }
  });
});
