/**
 * `CLIGenerator.listCommands()` is the read-only list of every command the
 * CLI serves for the current registry: the served-surface collector reads it
 * instead of restating the CLI's exposure rules. It must follow the registry
 * as it changes, never a list cached before a registration; it lists the
 * built-in commands execution and help know; and it reads the registry only,
 * never running the project's startup code.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

const PKG = '@fixture/cli-list-commands';

function entry(className: string, decoratorConfig: Record<string, unknown>) {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/src/${className}.ts`,
    fields: { title: { type: 'text' as const } },
    methods: {},
    decoratorConfig,
  };
}

function register(className: string, config: Record<string, unknown> = {}) {
  ObjectRegistry.registerFromManifest(
    `${PKG}:${className}`,
    entry(className, config) as never,
    PKG,
  );
}

const objectCommands = (
  commands: Awaited<ReturnType<CLIGenerator['listCommands']>>,
) =>
  commands
    .filter((command) => command.runtimeModel?.qualifiedName?.startsWith(PKG))
    .map((command) => `${command.runtimeModel?.qualifiedName} ${command.name}`)
    .sort();

beforeEach(() => ObjectRegistry.clear());
afterEach(() => ObjectRegistry.clear());

describe('CLIGenerator.listCommands', () => {
  it('lists each registered object command with the registration it serves', async () => {
    register('Widget', { cli: { include: ['list', 'get'] } });
    register('Hidden', { cli: false });
    const commands = await new CLIGenerator().listCommands();
    expect(objectCommands(commands)).toEqual([
      `${PKG}:Widget widget:get`,
      `${PKG}:Widget widget:list`,
    ]);
    expect(
      commands
        .filter((command) => command.runtimeModel)
        .every((command) => command.source === 'object'),
    ).toBe(true);
  });

  it('an abstract resource’s read commands carry their registration too', async () => {
    register('Shape', { abstract: true, cli: true });
    const commands = await new CLIGenerator().listCommands();
    expect(objectCommands(commands)).toEqual([
      `${PKG}:Shape shape:get`,
      `${PKG}:Shape shape:list`,
    ]);
  });

  it('follows registrations made after an earlier call on the same generator', async () => {
    const cli = new CLIGenerator();
    register('Widget', { cli: { include: ['list'] } });
    expect(objectCommands(await cli.listCommands())).toEqual([
      `${PKG}:Widget widget:list`,
    ]);
    register('Gadget', { cli: { include: ['get'] } });
    expect(objectCommands(await cli.listCommands())).toEqual([
      `${PKG}:Gadget gadget:get`,
      `${PKG}:Widget widget:list`,
    ]);
  });

  it('lists the built-in commands execution and help know, each once', async () => {
    const commands = await new CLIGenerator().listCommands();
    const init = commands.filter((command) => command.name === 'init');
    expect(init).toHaveLength(1);
    expect(init[0].source).toBe('built-in');
    const names = commands.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    const objects = commands.find((command) => command.name === 'objects');
    expect(objects?.source).toBe('utility');
  });

  it('a built-in whose name an object command takes keeps the aliases that still reach it', async () => {
    ObjectRegistry.registerFromManifest(
      `${PKG}:Db`,
      {
        ...entry('Db', { cli: true }),
        methods: {
          migrate: {
            name: 'migrate',
            async: true,
            parameters: [],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
      } as never,
      PKG,
    );
    const commands = await new CLIGenerator().listCommands();
    const claimed = commands.flatMap((command) =>
      [command.name, ...(command.aliases ?? [])].map((address) => ({
        address,
        source: command.source,
      })),
    );
    const owners = (address: string) =>
      claimed.filter((row) => row.address === address).map((row) => row.source);
    expect(owners('db:migrate')).toEqual(['object']);
    expect(owners('migrate')).toEqual(['built-in']);
    expect(owners('db-migrate')).toEqual(['built-in']);
    // Every listed address is listed once.
    const addresses = claimed.map((row) => row.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('without built-ins, lists utility and object commands and registers nothing', async () => {
    register('Widget', { cli: { include: ['list'] } });
    const before = [...ObjectRegistry.getAllClasses().keys()];
    const commands = await new CLIGenerator().listCommands({ builtIns: false });
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual(before);
    expect(objectCommands(commands)).toEqual([`${PKG}:Widget widget:list`]);
    expect(commands.some((command) => command.source === 'built-in')).toBe(
      false,
    );
    expect(commands.some((command) => command.source === 'utility')).toBe(true);
  });

  it('names the registration a command prefix resolves to, even when that registration serves no command', async () => {
    register('Account', { cli: false });
    ObjectRegistry.registerFromManifest(
      '@fixture/other:Account',
      {
        ...entry('Account', { cli: true }),
        qualifiedName: '@fixture/other:Account',
        packageName: '@fixture/other',
      } as never,
      '@fixture/other',
    );
    const cli = new CLIGenerator();
    expect(cli.resolveCommandRegistrationKey('account')).toBe(`${PKG}:Account`);
    expect(cli.resolveCommandRegistrationKey('nothing')).toBeUndefined();
    const commands = await cli.listCommands();
    expect(
      commands.filter((command) => command.name.startsWith('account:')),
    ).toEqual([]);
  });

  it('is published through the side-effect-free generator subpath', async () => {
    const subpath = await import('../generator.js');
    expect(subpath.CLIGenerator).toBe(CLIGenerator);
  });

  it('keys the command cache on the registry generation', async () => {
    const cli = new CLIGenerator() as unknown as {
      generateCommands(): Promise<unknown[]>;
      manifestLoaded: boolean;
    };
    // The cache, not startup, is under test here.
    cli.manifestLoaded = true;
    const first = await cli.generateCommands();
    expect(await cli.generateCommands()).toBe(first);
    register('Widget');
    expect(await cli.generateCommands()).not.toBe(first);
  });
});

describe('listing reads the registry only', () => {
  const marker = '__smrtListCommandsProjectStarted';
  let project: string | undefined;
  let cwd: string | undefined;
  afterEach(() => {
    if (cwd) process.chdir(cwd);
    if (project) rmSync(project, { recursive: true, force: true });
    project = undefined;
    cwd = undefined;
    delete (globalThis as Record<string, unknown>)[marker];
  });

  /** A project whose entry point records that it ran, with a local manifest. */
  function projectWithStartup(): string {
    const root = mkdtempSync(join(tmpdir(), 'cli-list-commands-'));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@fixture/cli-list-project',
        type: 'module',
        main: './dist/index.js',
      }),
    );
    writeFileSync(
      join(root, 'dist/index.js'),
      `globalThis.${marker} = (globalThis.${marker} ?? 0) + 1;\nexport {};\n`,
    );
    writeFileSync(
      join(root, 'dist/manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        packageName: '@fixture/cli-list-project',
        objects: {
          '@fixture/cli-list-project:Probe': {
            ...entry('Probe', { cli: true }),
            qualifiedName: '@fixture/cli-list-project:Probe',
            packageName: '@fixture/cli-list-project',
          },
        },
      }),
    );
    return root;
  }

  it('a first listing runs no project startup code and registers no local manifest entry', async () => {
    project = projectWithStartup();
    cwd = process.cwd();
    process.chdir(project);
    const { CLIGenerator: Published } = await import('../generator.js');
    const commands = await new Published().listCommands();
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(ObjectRegistry.getClass('@fixture/cli-list-project:Probe')).toBe(
      undefined,
    );
    expect(commands.some((command) => command.name === 'probe:list')).toBe(
      false,
    );

    // Negative control: CLI startup (the help path) does run it.
    const cli = new Published() as unknown as {
      generateAllCommands(): Promise<unknown[]>;
    };
    await cli.generateAllCommands();
    expect((globalThis as Record<string, unknown>)[marker]).toBe(1);
  });
});
