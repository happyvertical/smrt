/**
 * #4871: run-time models, including run-time subclasses of real classes, and
 * the three open checks of #4869 (the app-subclass standard).
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  planRuntimeModelDDL,
  registerRuntimeModel,
  runtimeModelEntry,
} from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

type Db = Awaited<ReturnType<typeof getDatabase>>;
const OWNER = { id: 'owner', roles: ['admin'] };

@smrt({ tableStrategy: 'sti', tableName: 'rt4871_things' })
class Thing4871 extends SmrtObject {
  @field({ required: true }) title = '';
  describeThing() {
    return `thing:${this.title}`;
  }
}

@smrt({ tableName: 'rt4871_gadgets' })
class Gadget4871 extends SmrtObject {
  @field() label = '';
  shout() {
    return `GADGET ${this.label}`;
  }
}

@smrt({ tableName: 'rt4871_gizmos' })
class Gizmo4871 extends Gadget4871 {
  @field() volts = 0;
}

@smrt({ tableName: 'rt4871_things' })
class SubThing4871 extends Thing4871 {
  @field() weight = 0;
}

const qn = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor)!.qualifiedName!;

async function migrate(db: Db, name: string) {
  const statements = await planRuntimeModelDDL(name, 'sqlite', async (t) => {
    const r = await db.query(`SELECT name FROM pragma_table_info(?)`, [t]);
    return r.rows.length
      ? r.rows.map((x: Record<string, any>) => String(x.name))
      : null;
  });
  for (const s of statements) await db.query(s);
  return statements;
}

describe('#4871 run-time models', () => {
  let restore: () => void;
  // Each test registers its own run-time models; the registry only adds, so
  // start every test from the fixtures alone.
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('a standalone model gets a table, records, REST, MCP and methods', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const q = registerRuntimeModel(
      {
        name: 'Chore',
        packageName: '@test/rt4871',
        fields: {
          title: { type: 'text' },
          done: { type: 'boolean' },
          points: { type: 'integer' },
        },
        methods: {
          complete: { description: 'Mark done', parameters: [] },
        },
      },
      {
        methods: {
          async complete(this: any) {
            this.done = true;
            await this.save();
            return { done: true, id: this.id };
          },
        },
      },
    );
    expect(q).toBe('@test/rt4871:Chore');
    const statements = await migrate(db, q);
    expect(statements.join('\n')).toContain('CREATE TABLE');
    // A second plan against the migrated table adds nothing.
    expect(await migrate(db, q)).toEqual([]);

    const chores: any = await ObjectRegistry.getCollection(q, { db });
    // Records with no natural key save, and records sharing a title stay apart.
    const a = await chores.create({ title: 'Dishes' });
    const b = await chores.create({ title: 'Dishes' });
    const c = await chores.create({ title: '', points: 3 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    // The id is the conflict key, so a second save of the same title is a new record.
    expect(await chores.list({ limit: 10 })).toHaveLength(3);
    a.points = 5;
    await a.save();
    expect((await chores.get(a.id)).points).toBe(5);

    const mcp = new MCPGenerator({ name: 'rt', version: '1' }, {
      db,
      user: OWNER,
    } as any);
    const tools = (await mcp.generateTools()).map((t: any) => t.name);
    expect(tools).toContain('chore_list');
    expect(tools).toContain('chore_complete');
    const out: any = await mcp.handleToolCall({
      method: 'tools/call',
      params: { name: 'chore_complete', arguments: { id: b.id } },
    } as any);
    expect(out.isError).toBeFalsy();
    expect((await chores.get(b.id)).done).toBe(true);

    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (r: Request) => r },
      { db } as any,
    );
    api.registerCollection('chores', chores);
    const res = await api.generateHandler()(
      new Request('http://x/api/chores', { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    await chores.get(a.id).then((r: any) => r.delete());
    expect(await chores.get(a.id)).toBeNull();
  });

  it('exposes the entry: id conflict key, columns, method exposure', () => {
    const e: any = runtimeModelEntry({
      name: 'Visit',
      packageName: '@test/rt4871',
      fields: { when: { type: 'datetime' } },
      methods: {
        cancel: {
          parameters: [
            { name: 'count', type: 'integer' },
            { name: 'ratio', type: 'decimal' },
            { name: 'when', type: 'datetime', optional: true },
            { name: 'extra', type: 'json' },
          ],
        },
      },
    });
    // The generated tool schema reads TypeScript type names, not column types.
    expect(
      Object.fromEntries(
        e.methods.cancel.parameters.map((p: any) => [p.name, p.type]),
      ),
    ).toEqual({
      count: 'number',
      ratio: 'number',
      when: 'string',
      extra: 'object',
    });
    expect(e.decoratorConfig.conflictColumns).toEqual(['id']);
    expect(e.decoratorConfig.mcp.include).toContain('cancel');
    expect(e.methods.cancel.decoratorConfig).toEqual({});
    expect(e.schema.columns.when.type).toBe('TIMESTAMP');
    expect(e.schema.columns.id.primaryKey).toBe(true);
  });

  describe('run-time subclasses of a registered class', () => {
    const tables = async (db: Db) =>
      (
        await db.query(
          `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )
      ).rows.map((r: any) => `${r.type}:${r.name}`);

    it('an STI subclass adds nullable columns to the parent table and carries its own _meta_type', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const parent = qn(Thing4871);
      const parentCtor = ObjectRegistry.getClass(parent)!.constructor;
      const q = registerRuntimeModel(
        {
          name: 'Thing',
          packageName: '@test/rt4871sti',
          extends: parent,
          fields: {
            color: { type: 'text', required: true },
            size: { type: 'integer' },
          },
          methods: {
            paint: {
              description: 'Paint it',
              parameters: [{ name: 'color', type: 'text' }],
            },
          },
        },
        {
          methods: {
            async paint(this: any, params: any = {}) {
              this.color = params.color;
              await this.save();
              return { color: this.color };
            },
          },
        },
      );
      // The parent stays registered, with its own constructor.
      expect(ObjectRegistry.getClass(parent)!.constructor).toBe(parentCtor);
      expect(ObjectRegistry.getTableName(q)).toBe('rt4871_things');

      // An existing parent table gains the subclass's columns, nullable.
      // The parent's table already exists (the SQLite adapter creates the
      // tables of registered decorated classes).
      await ObjectRegistry.getCollection(parent, { db });
      const statements = await migrate(db, q);
      expect(statements).toEqual([
        'ALTER TABLE "rt4871_things" ADD COLUMN "color" TEXT',
        'ALTER TABLE "rt4871_things" ADD COLUMN "size" INTEGER',
      ]);

      const things: any = await ObjectRegistry.getCollection(q, { db });
      const t = await things.create({ title: 'lamp', color: 'red' });
      expect(t.constructor.name).toBe('Thing');
      expect(t.describeThing()).toBe('thing:lamp'); // inherited method
      const row = (
        await db.query(`SELECT _meta_type, title, color FROM rt4871_things`)
      ).rows[0];
      expect(row).toEqual({
        _meta_type: '@test/rt4871sti:Thing',
        title: 'lamp',
        color: 'red',
      });

      // The parent's collection sees the subclass's records.
      const parents: any = await ObjectRegistry.getCollection(parent, { db });
      const seen = await parents.list({ limit: 10 });
      expect(seen.map((x: any) => x.title)).toEqual(['lamp']);

      // A method attached at run time is callable through its generated tool.
      const mcp = new MCPGenerator({ name: 'rt', version: '1' }, {
        db,
        user: OWNER,
      } as any);
      expect((await mcp.generateTools()).map((x: any) => x.name)).toContain(
        'thing_paint',
      );
      const out: any = await mcp.handleToolCall({
        method: 'tools/call',
        params: { name: 'thing_paint', arguments: { id: t.id, color: 'blue' } },
      } as any);
      expect(JSON.stringify(out.content)).not.toContain('rror');
      expect((await things.get(t.id)).color).toBe('blue');
    });

    it('#4869 check 3: an empty STI subclass changes no schema, table, index or row', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const parent = qn(Thing4871);
      const parents: any = await ObjectRegistry.getCollection(parent, { db });
      await parents.create({ title: 'before' });
      const schemaBefore = JSON.stringify(
        ObjectRegistry.getAllSchemasAsDefinitions().rt4871_things,
      );
      const objectsBefore = await tables(db);
      const rowsBefore = (await db.query('SELECT * FROM rt4871_things')).rows;

      const q = registerRuntimeModel({
        name: 'Thing',
        packageName: '@test/rt4871empty',
        extends: parent,
      });

      expect(
        JSON.stringify(
          ObjectRegistry.getAllSchemasAsDefinitions().rt4871_things,
        ),
      ).toBe(schemaBefore);
      expect(await migrate(db, q)).toEqual([]);
      expect(await tables(db)).toEqual(objectsBefore);
      expect((await db.query('SELECT * FROM rt4871_things')).rows).toEqual(
        rowsBefore,
      );
    });

    it('#4869 check 2: package schema migrations tolerate subclass columns', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const parent = qn(Thing4871);
      // What the package's own migration compares against: the parent alone.
      const parentOnly =
        ObjectRegistry.getAllSchemasAsDefinitions().rt4871_things;
      const q = registerRuntimeModel({
        name: 'Thing',
        packageName: '@test/rt4871mig',
        extends: parent,
        fields: { color: { type: 'text' } },
      });
      await migrate(db, q);
      const { SchemaComparer, getSQLFromDiff } = await import(
        '../migrations/differ.js'
      );
      const diff: any = await new SchemaComparer(db, {
        engineHint: 'sqlite',
      }).compare({ rt4871_things: parentOnly });
      // The extra column is an advisory orphan: no change, nothing dropped.
      expect(getSQLFromDiff(diff)).toEqual([]);
      expect(diff.has_changes).toBe(false);
      expect(diff.changes.map((c: any) => [c.type, c.name])).toEqual([
        ['orphan_column', 'color'],
      ]);
    });

    it('#4869 check 1: a subclass of a one-table-per-class parent gets its own table, with the inherited fields declared again', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const parent = qn(Gadget4871);
      const q = registerRuntimeModel({
        name: 'Gadget',
        packageName: '@test/rt4871cti',
        extends: parent,
        fields: { voltage: { type: 'integer' } },
      });
      expect(ObjectRegistry.getTableName(q)).toBe('gadgets');
      expect(ObjectRegistry.getTableName(parent)).toBe('rt4871_gadgets');
      const cols = Object.keys(
        ObjectRegistry.getAllSchemasAsDefinitions().gadgets.columns,
      );
      expect(cols).toEqual(expect.arrayContaining(['label', 'voltage']));
      await migrate(db, q);
      const gadgets: any = await ObjectRegistry.getCollection(q, { db });
      const g = await gadgets.create({ label: 'amp', voltage: 12 });
      expect(g.shout()).toBe('GADGET amp'); // inherited method
      expect(
        (await db.query('SELECT label, voltage FROM gadgets')).rows,
      ).toEqual([{ label: 'amp', voltage: 12 }]);
      // The parent's table does not see the subclass's records.
      expect(
        (await db.query('SELECT COUNT(*) AS n FROM rt4871_gadgets')).rows[0].n,
      ).toBe(0);
      // An empty subclass of such a parent is not free: it adds a table.
      const before = await tables(db);
      const e = registerRuntimeModel({
        name: 'Gadget',
        packageName: '@test/rt4871cti2',
        extends: parent,
        tableName: 'rt4871_gadgets_app',
      });
      await migrate(db, e);
      expect(
        (await tables(db))
          .filter((t) => !before.includes(t))
          .some((t) => t.startsWith('table:')),
      ).toBe(true);
    });

    it("a subclass that shares its parent's simple name leaves the parent family intact", async () => {
      const parent = qn(Thing4871);
      const child = qn(SubThing4871);
      registerRuntimeModel({
        name: 'Thing4871',
        packageName: '@test/rt4871same',
        extends: parent,
        fields: { color: { type: 'text' } },
      });
      expect(ObjectRegistry.getSTIBase(child)).toBe(parent);
      expect(ObjectRegistry.getSTIBase('@test/rt4871same:Thing4871')).toBe(
        parent,
      );
      expect(ObjectRegistry.getTableName(child)).toBe('rt4871_things');
      expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
      expect(
        Object.keys(
          ObjectRegistry.getAllSchemasAsDefinitions().rt4871_things.columns,
        ),
      ).toEqual(expect.arrayContaining(['weight', 'color']));
      // Records created through the same-named subclass keep its fields.
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      await migrate(db, '@test/rt4871same:Thing4871');
      const things: any = await ObjectRegistry.getCollection(
        '@test/rt4871same:Thing4871',
        { db },
      );
      const t = await things.create({ title: 'lamp', color: 'red' });
      expect(t._meta_type).toBe('@test/rt4871same:Thing4871');
      expect(
        (await db.query('SELECT color, _meta_type FROM rt4871_things')).rows,
      ).toEqual([{ color: 'red', _meta_type: '@test/rt4871same:Thing4871' }]);
      expect((await things.get(t.id)).color).toBe('red');
    });
  });
});
