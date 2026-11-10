/**
 * Generated CLI create/update honour the same write policy as the REST
 * routes and MCP tools (#3831 review): `api.writable`, `readonly` and
 * server-managed fields are dropped for every input mode, including
 * `--from-file`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  getTestDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

@smrt({
  tableName: 'cli_writable_policy_rows',
  api: { include: ['list', 'get', 'create', 'update'], writable: ['title'] },
  cli: true,
})
class CliWritablePolicyRow extends SmrtObject {
  @field()
  title: string = '';
  @field()
  status: string = 'pending';
}

class CliWritablePolicyRows extends SmrtCollection<CliWritablePolicyRow> {
  static readonly _itemClass = CliWritablePolicyRow;
}

describe('generated CLI write policy', () => {
  let db: DatabaseInterface;
  let dir: string;
  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CliWritablePolicyRow'],
    });
    dir = mkdtempSync(join(tmpdir(), 'cli-writable-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close?.();
  });

  it('drops non-writable fields from --from-file create and update', async () => {
    const rows = await CliWritablePolicyRows.create({ db });
    const handler = new CLIGenerator(
      { prompt: false, colors: false },
      { db },
    ).generateHandler();
    const file = (name: string, body: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(body));
      return path;
    };

    await handler([
      'cliwritablepolicyrow:create',
      '--from-file',
      file('create.json', { title: 'Allowed', status: 'forged' }),
    ]);
    const [created] = await rows.list({});
    expect(created).toMatchObject({ title: 'Allowed', status: 'pending' });

    await handler([
      'cliwritablepolicyrow:update',
      created!.id!,
      '--from-file',
      file('update.json', {
        title: 'Renamed',
        status: 'forged',
        id: 'not-this-id',
      }),
    ]);
    const updated = await rows.get({ id: created!.id! });
    expect(updated).toMatchObject({ title: 'Renamed', status: 'pending' });
  });
});
