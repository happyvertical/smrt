/**
 * The generated CLI creates an STI subtype through its base only when the
 * subtype's own `cli` surface opens create, like REST and MCP do for theirs:
 * a closed subtype is neither offered by `--createType` nor created, from
 * flags or a file. Create input names declared fields only.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

@smrt({
  tableName: 'cli_surface_profiles',
  tableStrategy: 'sti',
  cli: { include: ['list', 'get', 'create'] },
})
class CliSurfaceProfile extends SmrtObject {
  @field()
  title: string = '';
}

/** Closed for create on the CLI. */
@smrt({ cli: { include: ['list', 'get'] } })
class CliSurfaceService extends CliSurfaceProfile {
  @field()
  privilege: string = '';
}

/** Open: the control. */
@smrt({ cli: { include: ['list', 'get', 'create'] } })
class CliSurfaceMember extends CliSurfaceProfile {
  @field()
  privilege: string = '';
}

const key = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};

describe('generated CLI STI create targets', () => {
  let db: DatabaseInterface;
  let dir: string;
  const types = async () =>
    (
      await db.query('SELECT title, _meta_type FROM cli_surface_profiles')
    ).rows.map((row) => `${row.title}:${row._meta_type}`);

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CliSurfaceProfile', 'CliSurfaceService', 'CliSurfaceMember'],
    });
    // Materialise each model's collection class, as an app's registration does.
    for (const name of [
      'CliSurfaceProfile',
      'CliSurfaceService',
      'CliSurfaceMember',
    ]) {
      await ObjectRegistry.getCollection(key(name), { db });
    }
    dir = mkdtempSync(join(tmpdir(), 'cli-surface-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close?.();
  });

  const handler = () =>
    new CLIGenerator(
      { prompt: false, colors: false },
      { db },
    ).generateHandler();

  it('offers only subtypes whose cli surface opens create', async () => {
    const cli = new CLIGenerator({}, { db }) as unknown as {
      generateObjectCommands(
        name: string,
        info: NonNullable<ReturnType<typeof ObjectRegistry.getClass>>,
      ): Promise<
        Array<{
          name: string;
          options: Record<string, { description: string }>;
        }>
      >;
    };
    const commands = await cli.generateObjectCommands(
      key('CliSurfaceProfile'),
      ObjectRegistry.getClass('CliSurfaceProfile')!,
    );
    const create = commands.find((command) => command.name.endsWith(':create'));
    const description = create?.options.createType?.description ?? '';
    expect(description).toContain(key('CliSurfaceMember'));
    expect(description).not.toContain(key('CliSurfaceService'));
  });

  it('refuses a closed subtype from flags and from a file', async () => {
    await expect(
      handler()([
        'clisurfaceprofile:create',
        '--title',
        'flags',
        '--createType',
        key('CliSurfaceService'),
      ]),
    ).rejects.toThrow();
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ title: 'file', privilege: 'root' }));
    await expect(
      handler()([
        'clisurfaceprofile:create',
        '--from-file',
        file,
        '--createType',
        key('CliSurfaceService'),
      ]),
    ).rejects.toThrow();
    expect(await types()).toEqual([]);
  });

  it('refuses a file key the model does not declare', async () => {
    const file = join(dir, 'unknown.json');
    writeFileSync(file, JSON.stringify({ title: 'file', notAField: 'x' }));
    await expect(
      handler()(['clisurfaceprofile:create', '--from-file', file]),
    ).rejects.toThrow(/notAField/);
    expect(await types()).toEqual([]);
  });

  it('creates the base and an open subtype', async () => {
    await handler()(['clisurfaceprofile:create', '--title', 'base']);
    const file = join(dir, 'member.json');
    writeFileSync(file, JSON.stringify({ title: 'member', privilege: 'user' }));
    await handler()([
      'clisurfaceprofile:create',
      '--from-file',
      file,
      '--createType',
      key('CliSurfaceMember'),
    ]);
    expect((await types()).sort()).toEqual([
      `base:${key('CliSurfaceProfile')}`,
      `member:${key('CliSurfaceMember')}`,
    ]);
    expect(CliSurfaceService).toBeDefined();
  });
});
