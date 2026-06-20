/**
 * Regression tests for the generated CLI surface (#1556 / #1554).
 *
 * The CLI generator must reach parity with the REST/MCP generators:
 *  1. Exhaustive `cli.include` — when an include list is present it is the
 *     COMPLETE allowlist; custom (non-CRUD) methods are exposed only if named.
 *  2. Custom methods are gated on `isPublic`; `cli: false` disables the object.
 *  3. Create/update bodies are mass-assignment guarded (writable allowlist +
 *     server-managed / readonly strip).
 *  4. `--from-file` loads a JSON create/update payload (keeps secrets off argv).
 *  5. Output is serialized through `toPublicJSON()` so `sensitive` fields never
 *     print.
 *
 * Tenant fail-closed behavior (the other half of #1554) requires
 * `@happyvertical/smrt-tenancy`, which core cannot depend on, so it is covered
 * end-to-end in the tenancy package's `cli-mcp-tenant-context.spec.ts`. Here we
 * only assert the tenancy-off pass-through (no runner registered → runs).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { CLIGenerator } from './cli';

// Exhaustive include naming only CRUD verbs — custom methods must NOT leak.
@smrt({ cli: { include: ['list', 'get'] } })
class CliCrudOnly extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }

  async recordPayment(): Promise<any> {
    return { ok: true };
  }
}

// No include — custom public methods auto-exposed (historical default).
@smrt({ cli: true })
class CliDefault extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }

  async syncNow(): Promise<any> {
    return { ok: true };
  }
}

// `cli: false` disables the object entirely.
@smrt({ cli: false })
class CliDisabled extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

// Writable allowlist + readonly + sensitive field for mass-assignment tests.
@smrt({ cli: true, api: { writable: ['name'] } })
class CliWritableWidget extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', readonly: true })
  internalCode = '';

  @field({ type: 'text', nullable: true })
  notAllowed: string | null = null;

  @field({ type: 'text', sensitive: true, nullable: true })
  apiKey: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.internalCode !== undefined)
      this.internalCode = options.internalCode;
    if (options.notAllowed !== undefined) this.notAllowed = options.notAllowed;
    if (options.apiKey !== undefined) this.apiKey = options.apiKey;
  }
}

class CliWritableWidgetCollection extends SmrtCollection<CliWritableWidget> {
  static readonly _itemClass = CliWritableWidget;
}

// A plain model with NO hand-written/registered collection class — the CLI must
// still work via the registry's default-collection factory (codex P2 on #1557).
@smrt({ cli: true })
class CliPlainModel extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

describe('CLI generator hardening (#1556 / #1554)', () => {
  ObjectRegistry.registerCollection(
    'CliWritableWidget',
    CliWritableWidgetCollection,
  );

  describe('command exposure policy', () => {
    it('exhaustive cli.include: [list, get] exposes neither custom methods nor other CRUD', async () => {
      const gen = new CLIGenerator();
      const commands = await gen.listCommands();
      const mine = commands.filter((c) => c.startsWith('clicrudonly:'));
      expect(mine).toContain('clicrudonly:list');
      expect(mine).toContain('clicrudonly:get');
      expect(mine).not.toContain('clicrudonly:recordPayment');
      expect(mine).not.toContain('clicrudonly:create');
    });

    it('rejects a non-included command at run time', async () => {
      const gen = new CLIGenerator();
      await expect(
        gen.run(['clicrudonly:create', '--name', 'x']),
      ).rejects.toThrow(/not enabled/i);
    });

    it('rejects a non-included custom method at run time', async () => {
      const gen = new CLIGenerator();
      await expect(
        gen.run(['clicrudonly:recordPayment', 'id1']),
      ).rejects.toThrow(/not enabled/i);
    });

    it('no include list auto-exposes public custom methods', async () => {
      const gen = new CLIGenerator();
      const commands = await gen.listCommands();
      expect(commands).toContain('clidefault:syncNow');
    });

    it('cli: false hides the object and rejects its commands', async () => {
      const gen = new CLIGenerator();
      const commands = await gen.listCommands();
      expect(commands.some((c) => c.startsWith('clidisabled:'))).toBe(false);
      await expect(gen.run(['clidisabled:list'])).rejects.toThrow(/disabled/i);
    });
  });

  describe('mass-assignment guard + sensitive redaction', () => {
    let db: any;

    beforeAll(async () => {
      db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['CliWritableWidget'],
      });
    });

    afterAll(async () => {
      await db?.close?.();
    });

    it('drops tenantId, readonly, and non-writable fields on create', async () => {
      const collection = await CliWritableWidgetCollection.create({ db });
      const gen = new CLIGenerator({}, { db });

      await gen.run([
        'cliwritablewidget:create',
        '--name',
        'Widget A',
        '--tenantId',
        'attacker-tenant',
        '--internalCode',
        'SECRET',
        '--notAllowed',
        'nope',
      ]);

      const rows = await collection.list({ where: { name: 'Widget A' } });
      expect(rows).toHaveLength(1);
      const row = rows[0] as CliWritableWidget;
      expect(row.name).toBe('Widget A');
      // Stripped by the writable allowlist / server-managed / readonly rules.
      expect(row.tenantId).toBeNull();
      expect(row.internalCode).toBe('');
      expect(row.notAllowed).toBeNull();
    });

    it('does not print sensitive fields in command output', async () => {
      const logs: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      };
      try {
        const gen = new CLIGenerator({}, { db });
        await gen.run([
          'cliwritablewidget:create',
          '--name',
          'Widget B',
          '--apiKey',
          'super-secret-key',
        ]);
      } finally {
        console.log = original;
      }
      const output = logs.join('\n');
      expect(output).not.toContain('super-secret-key');
      expect(output).not.toContain('apiKey');
    });

    it('loads a create payload from --from-file', async () => {
      const { writeFile, mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'cli-fromfile-'));
      const file = join(dir, 'payload.json');
      await writeFile(
        file,
        JSON.stringify({ name: 'From File', internalCode: 'STRIP' }),
        'utf-8',
      );

      const collection = await CliWritableWidgetCollection.create({ db });
      const gen = new CLIGenerator({}, { db });
      await gen.run(['cliwritablewidget:create', '--from-file', file]);

      const rows = await collection.list({ where: { name: 'From File' } });
      expect(rows).toHaveLength(1);
      // readonly field still stripped even when supplied via file.
      expect((rows[0] as CliWritableWidget).internalCode).toBe('');
    });
  });

  describe('tenancy-off pass-through', () => {
    it('runs a list with no tenant runner registered', async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['CliWritableWidget'],
      });
      const gen = new CLIGenerator({}, { db });
      // Should not throw — no tenant entry-point runner is registered in core's
      // own test env, so the gate passes through.
      await expect(
        gen.run(['cliwritablewidget:list']),
      ).resolves.toBeUndefined();
      await db?.close?.();
    });
  });

  describe('default-collection models', () => {
    it('create + list work for a plain @smrt() model with no collection class', async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['CliPlainModel'],
      });
      const gen = new CLIGenerator({}, { db });

      // Both must succeed via the registry's default-collection factory, even
      // though CliPlainModel has no hand-written collection class.
      await gen.run(['cliplainmodel:create', '--name', 'Plain One']);

      const logs: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      };
      try {
        await gen.run(['cliplainmodel:list']);
      } finally {
        console.log = original;
      }
      expect(logs.join('\n')).toContain('Plain One');
      await db?.close?.();
    });
  });
});
