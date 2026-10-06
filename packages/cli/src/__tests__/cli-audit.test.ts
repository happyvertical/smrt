import {
  type AuditEntry,
  type AuditWriter,
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
  withAuditContext,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

@smrt({ tableName: 'issue_3460_cli_records', audit: true })
class Issue3460CliRecord extends SmrtObject {
  // CLI tests use live registration without a scanner manifest.
  @field()
  title: string = '';
  @field({ sensitive: true })
  secret: string = '';
}

class Issue3460CliRecords extends SmrtCollection<Issue3460CliRecord> {
  static readonly _itemClass = Issue3460CliRecord;
}

@smrt({ tableName: 'issue_3460_cli_entries' })
class Issue3460CliEntry extends SmrtObject {
  entry: Record<string, unknown> = {};
}

describe('generated CLI audit boundary', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Issue3460CliRecord', 'Issue3460CliEntry'],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close?.();
  });

  it('records create/update/delete once, keeps actor scope, and rolls back failed audited update', async () => {
    const records = await Issue3460CliRecords.create({ db });
    const entries: AuditEntry[] = [];
    let fail = false;
    const writer: AuditWriter = async (entry, tx) => {
      expect(tx).not.toBe(db);
      const log = new Issue3460CliEntry({ db: tx, entry });
      await log.initialize();
      await log.save();
      if (fail) throw new Error('audit writer unavailable');
      entries.push(entry);
    };
    const cli = new CLIGenerator({ prompt: false, colors: false }, { db });
    expect(
      Array.from(ObjectRegistry.getFields('Issue3460CliRecord').keys()),
    ).toContain('title');
    const handler = cli.generateHandler();
    const run = (args: string[]) =>
      withAuditContext(
        {
          actorId: 'cli-principal',
          source: 'cli',
          reason: 'Operator correction',
          writer,
        },
        () => handler(args),
      );
    await run([
      'issue3460clirecord:create',
      '--title',
      'Initial',
      '--secret',
      'cli-secret',
      '--quiet',
    ]);
    expect(entries[0].changes.title).toEqual({
      before: null,
      after: 'Initial',
    });
    const row = (await records.list())[0];
    expect(row.title).toBe('Initial');
    fail = true;
    await expect(
      run([
        'issue3460clirecord:update',
        row.id as string,
        '--title',
        'Failed',
        '--quiet',
      ]),
    ).rejects.toThrow('audit writer unavailable');
    expect((await records.get(row.id as string, { cache: false }))?.title).toBe(
      'Initial',
    );
    fail = false;
    await run([
      'issue3460clirecord:update',
      row.id as string,
      '--title',
      'Changed',
      '--quiet',
    ]);
    await run(['issue3460clirecord:delete', row.id as string, '--force']);
    expect(await records.count()).toBe(0);
    expect(
      entries.map((entry) => [entry.action, entry.actorId, entry.reason]),
    ).toEqual([
      ['created', 'cli-principal', 'Operator correction'],
      ['updated', 'cli-principal', 'Operator correction'],
      ['deleted', 'cli-principal', 'Operator correction'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('cli-secret');
    expect((await db.list('issue_3460_cli_entries', {})).length).toBe(3);
  });
});
