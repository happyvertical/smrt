/**
 * Generated CLI commands for a collection class never exceed its model's.
 *
 * Registers a manifest shaped the way smrt-core <= 0.56.1 emitted it (the
 * collection entry carries no `cli` key at all) and reads the commands the
 * real CLIGenerator builds for the collection. The registry resolves the
 * collection's surface from its model, so the stale manifest is held to the
 * same rule a freshly generated one is.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

const PKG = '@happyvertical/smrt-cli-collection-exposure-fixture';

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

function manifest(itemName: string, itemConfig: Record<string, unknown>) {
  const collectionName = `${itemName}Collection`;
  const base = (className: string) => ({
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: `${itemName.toLowerCase()}s`,
    filePath: `src/${className}.ts`,
    exportName: className,
    collectionExportName: `${className}Collection`,
  });
  return {
    version: '1',
    timestamp: 0,
    packageName: PKG,
    objects: {
      [`${PKG}:${itemName}`]: {
        ...base(itemName),
        fields: { label: { type: 'text', required: false } },
        methods: {},
        decoratorConfig: itemConfig,
        extends: 'SmrtObject',
      },
      [`${PKG}:${collectionName}`]: {
        ...base(collectionName),
        fields: {},
        methods: { issueToken: method('issueToken') },
        decoratorConfig: {},
        extends: 'SmrtCollection',
        extendsTypeArg: itemName,
      },
    },
  };
}

describe('CLI commands of a collection over a closed model', () => {
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

  async function commands(itemName: string, itemConfig: object) {
    ObjectRegistry.registerPackageManifest(
      manifest(itemName, itemConfig as Record<string, unknown>) as never,
    );
    const generated = await (
      cli as unknown as {
        generateObjectCommands(
          name: string,
          info: unknown,
        ): Promise<Array<{ name: string }>>;
      }
    ).generateObjectCommands(
      `${PKG}:${itemName}Collection`,
      ObjectRegistry.getClass(`${PKG}:${itemName}Collection`),
    );
    const prefix = `${PKG}:${itemName}Collection:`.toLowerCase();
    return generated.map((command) => command.name.slice(prefix.length)).sort();
  }

  it('publishes nothing when the model turns the CLI off', async () => {
    expect(await commands('Secret', { cli: false })).toEqual([]);
  });

  it('publishes only the CRUD verbs a model include list names, and no collection method', async () => {
    expect(
      await commands('Membership', { cli: { include: ['list', 'get'] } }),
    ).toEqual(['get', 'list']);
  });

  it('honours a model exclude list', async () => {
    expect(
      await commands('Invoice', { cli: { exclude: ['create', 'delete'] } }),
    ).toEqual(['get', 'issueToken', 'list', 'update']);
  });

  it('leaves the collection of an open model as it was', async () => {
    expect(await commands('Note', {})).toEqual([
      'create',
      'delete',
      'get',
      'issueToken',
      'list',
      'update',
    ]);
  });
});
