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
  crossPackageRef,
  field,
  getTestDatabase,
  ObjectRegistry,
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

@smrt({ idType: 'text' })
class CliInlineContact extends SmrtObject {
  @field({ required: true }) name = '';
  @field() email = '';
}
@smrt({
  idType: 'text',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
  writeThrough: { contactId: { fields: ['name', 'email'] } },
  display: { label: { via: 'contactId', field: 'name', fallback: 'Unnamed' } },
})
class CliInlineCustomer extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-cli:CliInlineContact') contactId = '';
}

class CliInlineCustomers extends SmrtCollection<CliInlineCustomer> {
  static readonly _itemClass = CliInlineCustomer;
}
class CliInlineContacts extends SmrtCollection<CliInlineContact> {
  static readonly _itemClass = CliInlineContact;
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

  it('creates and edits a named linked record through ordinary CLI flags', async () => {
    await getTestDatabase({
      db,
      classes: ['CliInlineCustomer', 'CliInlineContact'],
    });
    await CliInlineCustomers.create({ db });
    await CliInlineContacts.create({ db });
    const handler = new CLIGenerator(
      { prompt: false, colors: false },
      { db },
    ).generateHandler();
    await handler([
      'cliinlinecustomer:create',
      '--name',
      'CLI Member',
      '--email',
      'cli@example.test',
    ]);
    const customers = await ObjectRegistry.getCollection('CliInlineCustomer', {
      db,
    });
    const created = await customers.list({ displayLabel: true });
    expect(created).toHaveLength(1);
    expect(created[0].toJSON().displayLabel).toBe('CLI Member');
    await handler([
      'cliinlinecustomer:update',
      String(created[0].id),
      '--name',
      'CLI Updated',
    ]);
    expect(
      (
        await customers.get(String(created[0].id), {
          displayLabel: true,
          cache: false,
        })
      )?.toJSON().name,
    ).toBe('CLI Updated');
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
