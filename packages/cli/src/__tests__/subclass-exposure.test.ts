/**
 * Generated CLI commands for a model subclass never exceed its parent's.
 *
 * Registers a manifest shaped the way smrt-core <= 0.57.0 emitted it (the STI
 * child restates none of its parent's exposure) and reads the commands the
 * real CLIGenerator builds for the child. The registry resolves the child's
 * surface from its parent, so the stale manifest is held to the same rule a
 * freshly generated one is.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

const PKG = '@happyvertical/smrt-cli-subclass-exposure-fixture';

function method(name: string) {
  return {
    name,
    async: true,
    parameters: [{ name: 'id', type: 'string', optional: false }],
    returnType: 'Promise<void>',
    isStatic: false,
    isPublic: true,
  };
}

function manifest(parentConfig: Record<string, unknown>) {
  const base = (className: string) => ({
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: 'profiles',
    filePath: `src/${className}.ts`,
    exportName: className,
    collectionExportName: `${className}Collection`,
    fields: { label: { type: 'text', required: false } },
  });
  return {
    version: '1',
    timestamp: 0,
    packageName: PKG,
    objects: {
      [`${PKG}:Profile`]: {
        ...base('Profile'),
        methods: { generateApiKey: method('generateApiKey') },
        decoratorConfig: { tableStrategy: 'sti', ...parentConfig },
        extends: 'SmrtObject',
      },
      [`${PKG}:Person`]: {
        ...base('Person'),
        methods: {
          generateApiKey: method('generateApiKey'),
          greet: method('greet'),
        },
        decoratorConfig: { tableStrategy: 'sti' },
        extends: 'Profile',
      },
    },
  };
}

describe('CLI commands of a subclass of a closed model', () => {
  let cli: CLIGenerator;

  beforeEach(() => {
    ObjectRegistry.clear();
    cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(cli as any, 'tryLoadUserClasses').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ObjectRegistry.clear();
  });

  async function commands(parentConfig: object) {
    ObjectRegistry.registerPackageManifest(
      manifest(parentConfig as Record<string, unknown>) as never,
    );
    const generated = await (
      cli as unknown as {
        generateObjectCommands(
          name: string,
          info: unknown,
        ): Promise<Array<{ name: string }>>;
      }
    ).generateObjectCommands(
      `${PKG}:Person`,
      ObjectRegistry.getClass(`${PKG}:Person`),
    );
    const prefix = `${PKG}:Person:`.toLowerCase();
    return generated.map((command) => command.name.slice(prefix.length)).sort();
  }

  it('publishes nothing when the parent turns the CLI off', async () => {
    expect(await commands({ cli: false })).toEqual([]);
  });

  it("follows the parent's strict include list", async () => {
    expect(
      await commands({ cli: { include: ['list', 'get', 'greet'] } }),
    ).toEqual(['get', 'greet', 'list']);
  });

  it("honours the parent's exclude list", async () => {
    expect(
      await commands({ cli: { exclude: ['delete', 'generateApiKey'] } }),
    ).toEqual(['create', 'get', 'greet', 'list', 'update']);
  });

  it('leaves the subclass of an open parent as it was', async () => {
    expect(await commands({})).toEqual([
      'create',
      'delete',
      'generateApiKey',
      'get',
      'greet',
      'list',
      'update',
    ]);
  });
});
