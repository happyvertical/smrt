/**
 * Coverage for the CLI generator parsing + dispatch surface (#1500).
 *
 * cli-hardening.spec covers the security policy (exhaustive include, writable
 * guard, sensitive redaction, tenancy pass-through). This file fills the
 * remaining branches: argv parsing forms, help output, the full CRUD verb
 * dispatch with list flags, custom-action routing (instance + collection),
 * value coercion, and the `setupCLI` / `getCLIHandler` wrappers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { CLIGenerator, getCLIHandler, setupCLI } from './cli';

@smrt({ cli: true })
class CliCmdWidget extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @field({ type: 'integer' })
  qty = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.qty !== undefined) this.qty = options.qty;
  }

  // Instance custom action — echoes the options it receives.
  async describe(options: any = {}): Promise<any> {
    return { kind: 'instance', name: this.name, options };
  }

  // Public on the object too (so command exposure passes), but when invoked
  // without an id the collection's same-named method runs instead.
  async tally(options: any = {}): Promise<any> {
    return { kind: 'instance-tally', options };
  }
}

class CliCmdWidgetCollection extends SmrtCollection<CliCmdWidget> {
  static readonly _itemClass = CliCmdWidget;

  // Collection-level custom action (invoked when no id is provided). The CLI
  // exposure gate validates against the object's methods, so `tally` is also
  // declared on the object above.
  async tally(options: any = {}): Promise<any> {
    return { kind: 'collection', options };
  }
}

function captureLog<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; out: string }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return fn()
    .then((result) => ({ result, out: logs.join('\n') }))
    .finally(() => {
      console.log = original;
    });
}

describe('CLI generator parsing + dispatch (#1500)', () => {
  ObjectRegistry.registerCollection('CliCmdWidget', CliCmdWidgetCollection);

  let db: any;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CliCmdWidget'],
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  describe('help + empty input', () => {
    it('prints help for no args', async () => {
      const gen = new CLIGenerator();
      const { out } = await captureLog(() => gen.run([]));
      expect(out).toContain('Usage:');
      expect(out).toContain('Commands:');
      // Generated default name/version appear in the header.
      expect(out).toContain('smrt-cli');
    });

    it('prints help for the --help flag', async () => {
      const gen = new CLIGenerator();
      const { out } = await captureLog(() => gen.run(['--help']));
      expect(out).toContain('Global flags:');
    });

    it('prints help when the command starts with a dash', async () => {
      const gen = new CLIGenerator();
      const { out } = await captureLog(() => gen.run(['--limit', '5']));
      expect(out).toContain('Usage:');
    });

    it('prints help for a bare object name with no action', async () => {
      const gen = new CLIGenerator();
      const { out } = await captureLog(() => gen.run(['clicmdwidget']));
      expect(out).toContain('Usage:');
    });

    it('lists the generated CRUD commands for the object', async () => {
      const gen = new CLIGenerator();
      const commands = await gen.listCommands();
      expect(commands).toContain('clicmdwidget:list');
      expect(commands).toContain('clicmdwidget:create');
      expect(commands).toContain('clicmdwidget:describe');
    });
  });

  describe('unknown commands', () => {
    it('throws for an unknown object type', async () => {
      const gen = new CLIGenerator();
      await expect(gen.run(['nosuchobject:list'])).rejects.toThrow(
        /not found/i,
      );
    });

    it('throws for an unknown custom method', async () => {
      const gen = new CLIGenerator({}, { db });
      await expect(
        gen.run(['clicmdwidget:noSuchMethod', 'id1']),
      ).rejects.toThrow(/unknown command/i);
    });
  });

  describe('CRUD dispatch', () => {
    it('creates via the name:action form and parses --key=value', async () => {
      const collection = await CliCmdWidgetCollection.create({ db });
      const gen = new CLIGenerator({}, { db });

      // `name action` (space) command form + `--key=value` flag form.
      await gen.run(['clicmdwidget', 'create', '--name=Spaced', '--qty=7']);

      const rows = await collection.list({ where: { name: 'Spaced' } });
      expect(rows).toHaveLength(1);
      expect((rows[0] as CliCmdWidget).qty).toBe(7);
    });

    it('gets an object by positional id and prints it', async () => {
      const collection = await CliCmdWidgetCollection.create({ db });
      const created = await collection.create({ name: 'Gettable', qty: 1 });
      await created.save();
      const gen = new CLIGenerator({}, { db });

      const { out } = await captureLog(() =>
        gen.run(['clicmdwidget:get', created.id as string]),
      );
      expect(out).toContain('Gettable');
    });

    it('throws when get is missing an id', async () => {
      const gen = new CLIGenerator({}, { db });
      await expect(gen.run(['clicmdwidget:get'])).rejects.toThrow(
        /id is required/i,
      );
    });

    it('throws a not-found for get on a missing id', async () => {
      const gen = new CLIGenerator({}, { db });
      await expect(gen.run(['clicmdwidget:get', 'missing-id'])).rejects.toThrow(
        /not found/i,
      );
    });

    it('updates an object and merges new field values', async () => {
      const collection = await CliCmdWidgetCollection.create({ db });
      const created = await collection.create({ name: 'Updatable', qty: 1 });
      await created.save();
      const gen = new CLIGenerator({}, { db });

      await gen.run([
        'clicmdwidget:update',
        created.id as string,
        '--qty',
        '99',
      ]);

      const reread = await collection.get(created.id as string);
      expect((reread as CliCmdWidget).qty).toBe(99);
    });

    it('throws when update is missing an id', async () => {
      const gen = new CLIGenerator({}, { db });
      await expect(
        gen.run(['clicmdwidget:update', '--qty', '1']),
      ).rejects.toThrow(/id is required/i);
    });

    it('deletes an object and returns a success payload', async () => {
      const collection = await CliCmdWidgetCollection.create({ db });
      const created = await collection.create({ name: 'Deletable', qty: 1 });
      await created.save();
      const gen = new CLIGenerator({}, { db });

      const { out } = await captureLog(() =>
        gen.run(['clicmdwidget:delete', created.id as string]),
      );
      expect(out).toContain('deleted');
      expect(await collection.get(created.id as string)).toBeNull();
    });

    it('throws when delete is missing an id', async () => {
      const gen = new CLIGenerator({}, { db });
      await expect(gen.run(['clicmdwidget:delete'])).rejects.toThrow(
        /id is required/i,
      );
    });

    it('lists with --where, --limit, --offset, and --order-by', async () => {
      const collection = await CliCmdWidgetCollection.create({ db });
      for (const [name, qty] of [
        ['List-A', 1],
        ['List-B', 2],
      ] as const) {
        const o = await collection.create({ name, qty });
        await o.save();
      }
      const gen = new CLIGenerator({}, { db });

      const { out } = await captureLog(() =>
        gen.run([
          'clicmdwidget:list',
          '--where',
          JSON.stringify({ name: 'List-B' }),
          '--limit',
          '10',
          '--offset',
          '0',
          '--order-by',
          'qty DESC',
        ]),
      );
      expect(out).toContain('List-B');
      expect(out).not.toContain('List-A');
    });
  });

  describe('custom action dispatch', () => {
    it('runs an instance custom action with coerced options', async () => {
      const collection = await CliCmdWidgetCollection.create({ db });
      const created = await collection.create({ name: 'ActionTarget', qty: 1 });
      await created.save();
      const gen = new CLIGenerator({}, { db });

      // Coercion: --count 3 → number, --flag → boolean true, JSON object value.
      const { out } = await captureLog(() =>
        gen.run([
          'clicmdwidget:describe',
          created.id as string,
          '--count',
          '3',
          '--flag',
          '--payload',
          '{"a":1}',
        ]),
      );
      expect(out).toContain('"kind": "instance"');
      expect(out).toContain('"count": 3');
      expect(out).toContain('"flag": true');
      // JSON-object flag value was parsed into an object, not left a string.
      expect(out).toContain('"a": 1');
    });

    it('runs a collection-level custom action when no id is given', async () => {
      const gen = new CLIGenerator({}, { db });
      const { out } = await captureLog(() =>
        gen.run(['clicmdwidget:tally', '--scope', 'all']),
      );
      expect(out).toContain('"kind": "collection"');
      expect(out).toContain('"scope": "all"');
    });
  });

  describe('setupCLI / getCLIHandler wrappers', () => {
    it('setupCLI().run strips the leading node + script argv entries', async () => {
      const { run, generator } = setupCLI({}, { db });
      expect(generator).toBeInstanceOf(CLIGenerator);
      const { out } = await captureLog(() =>
        run(['node', 'script.js', 'clicmdwidget:list', '--limit', '1']),
      );
      // Runs without throwing and prints a JSON array result.
      expect(out.startsWith('[') || out === '').toBe(true);
    });

    it('getCLIHandler returns a runnable argv handler', async () => {
      const handler = getCLIHandler({}, { db });
      const { out } = await captureLog(() => handler(['--help']));
      expect(out).toContain('Usage:');
    });
  });
});
