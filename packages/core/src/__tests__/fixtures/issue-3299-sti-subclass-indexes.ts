/**
 * #3299 fixture: an STI subclass declares its own unique index on the shared
 * table — the Ludis `(tenant_id, ramp_event_id)` shape — while a sibling
 * shares the column without the constraint. Shared by the SQLite and
 * PostgreSQL suites; the classes go through the real scanner (test manifest)
 * and the registry, and the table comes from the `db:migrate` schema
 * (`getAllSchemasAsDefinitions()`).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection.js';
import { field } from '../../decorators/index.js';
import { getSQLFromDiff, SchemaComparer } from '../../migrations/differ.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';

export const STI_3299_TABLE = 'issue_3299_events';
export const STI_3299_INDEX = 'issue_3299_events_game_tenant_ramp_uidx';

@smrt({
  tableStrategy: 'sti',
  tableName: 'issue_3299_events',
  tenantScoped: { mode: 'optional' },
})
export class Event3299 extends SmrtObject {
  @field({ nullable: true }) tenantId: string | null = null;
  title: string = '';
}

@smrt({
  indexes: [
    {
      name: 'issue_3299_events_game_tenant_ramp_uidx',
      columns: ['tenantId', 'rampEventId'],
      unique: true,
    },
  ],
})
export class Game3299 extends Event3299 {
  rampEventId: string = '';
}

/** Inherits Game3299's declaration through its own partial copy. */
@smrt()
export class PlayoffGame3299 extends Game3299 {
  round: string = '';
}

@smrt()
export class Meetup3299 extends Event3299 {
  rampEventId: string = '';
}

class Games3299 extends SmrtCollection<Game3299> {
  static readonly _itemClass = Game3299;
}
class PlayoffGames3299 extends SmrtCollection<PlayoffGame3299> {
  static readonly _itemClass = PlayoffGame3299;
}
class Meetups3299 extends SmrtCollection<Meetup3299> {
  static readonly _itemClass = Meetup3299;
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function sharedTableSchema(): SchemaDefinition {
  const schema = ObjectRegistry.getAllSchemasAsDefinitions()[STI_3299_TABLE];
  if (!schema) throw new Error(`no schema for ${STI_3299_TABLE}`);
  return schema;
}

export function runSti3299SubclassIndexes(engine: 'sqlite' | 'postgres'): void {
  describe(`STI subclass-declared indexes on ${engine} (#3299)`, () => {
    let db: DatabaseInterface;

    async function freshDb(): Promise<DatabaseInterface> {
      return getDatabase(
        engine === 'postgres'
          ? {
              type: 'postgres',
              url: process.env.SMRT_TEST_POSTGRES_URL as string,
              dbid: randomUUID(),
            }
          : { type: 'sqlite', url: ':memory:' },
      );
    }

    /** Create the table as an older deployment had it: no subclass index. */
    async function createLegacyTable(target: DatabaseInterface) {
      const schema = sharedTableSchema();
      const legacy: SchemaDefinition = {
        ...schema,
        indexes: schema.indexes.filter(
          (i) => !i.name.startsWith(STI_3299_INDEX),
        ),
      };
      const strategy = getDDLStrategy(engine);
      await target.query(`DROP TABLE IF EXISTS "${STI_3299_TABLE}"`);
      await target.query(strategy.generateCreateTable(legacy));
      for (const sql of strategy.generateIndexes(legacy)) {
        await target.query(sql);
      }
    }

    async function pendingSql(target: DatabaseInterface): Promise<string[]> {
      const diff = await new SchemaComparer(target, {
        engineHint: engine,
      }).compare({ [STI_3299_TABLE]: sharedTableSchema() });
      return getSQLFromDiff(diff);
    }

    beforeAll(async () => {
      db = await freshDb();
      await createLegacyTable(db);
    });

    afterAll(async () => {
      if (db) {
        await db.query(`DROP TABLE IF EXISTS "${STI_3299_TABLE}"`);
        await db.close?.();
      }
    });

    it('declares the subclass index on the shared table, scoped to the declaring subtype', () => {
      const index = sharedTableSchema().indexes.find(
        (i) => i.name === STI_3299_INDEX,
      );
      const game = ObjectRegistry.getClassByConstructor(Game3299)
        ?.qualifiedName as string;
      expect(index).toMatchObject({
        columns: ['tenant_id', 'ramp_event_id'],
        unique: true,
        where: `_meta_type = '${game}'`,
      });
    });

    it('adds the missing index through the normal migration diff, then converges', async () => {
      const statements = await pendingSql(db);
      // The declared index plus the PlayoffGame3299 subtree copy.
      const create = statements.filter((sql) => sql.includes(STI_3299_INDEX));
      expect(create).toHaveLength(2);
      for (const sql of create) {
        expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
        expect(sql).toMatch(/_meta_type/);
      }
      for (const sql of statements) await db.query(sql);
      expect(await pendingSql(db)).toEqual([]);
    });

    it('refuses a second same-tenant game for one ramp event', async () => {
      const games = await Games3299.create({ db });
      await games.create({
        slug: 'game-1',
        title: 'Final',
        rampEventId: 'ramp-1',
        tenantId: TENANT_A,
      });
      await expect(
        games.create({
          slug: 'game-1-dup',
          title: 'Final again',
          rampEventId: 'ramp-1',
          tenantId: TENANT_A,
        }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it("enforces the declared key for the declaring class's own subclass rows", async () => {
      const playoffs = await PlayoffGames3299.create({ db });
      await playoffs.create({
        slug: 'playoff-1',
        title: 'Semi',
        round: 'semi',
        rampEventId: 'ramp-3',
        tenantId: TENANT_A,
      });
      await expect(
        playoffs.create({
          slug: 'playoff-1-dup',
          title: 'Semi again',
          round: 'semi',
          rampEventId: 'ramp-3',
          tenantId: TENANT_A,
        }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it('allows the same ramp event in another tenant and in a sibling subtype', async () => {
      const games = await Games3299.create({ db });
      const meetups = await Meetups3299.create({ db });
      await games.create({
        slug: 'game-2',
        title: 'Final',
        rampEventId: 'ramp-2',
        tenantId: TENANT_A,
      });
      const otherTenant = await games.create({
        slug: 'game-2-b',
        title: 'Final',
        rampEventId: 'ramp-2',
        tenantId: TENANT_B,
      });
      const sibling = await meetups.create({
        slug: 'meetup-2',
        title: 'Watch party',
        rampEventId: 'ramp-2',
        tenantId: TENANT_A,
      });
      const sibling2 = await meetups.create({
        slug: 'meetup-2-again',
        title: 'Second watch party',
        rampEventId: 'ramp-2',
        tenantId: TENANT_A,
      });
      expect(new Set([otherTenant.id, sibling.id, sibling2.id]).size).toBe(3);
    });

    it('fails the index migration closed when existing rows already duplicate the key', async () => {
      const legacyDb = await freshDb();
      try {
        await createLegacyTable(legacyDb);
        const game = ObjectRegistry.getClassByConstructor(Game3299)
          ?.qualifiedName as string;
        for (const slug of ['dup-a', 'dup-b']) {
          await legacyDb.query(
            `INSERT INTO "${STI_3299_TABLE}" (id, slug, context, _meta_type, tenant_id, ramp_event_id)
             VALUES ('${randomUUID()}', '${slug}', '', '${game}', '${TENANT_A}', 'ramp-dup')`,
          );
        }
        const create = (await pendingSql(legacyDb)).filter((sql) =>
          sql.includes(`"${STI_3299_INDEX}"`),
        );
        expect(create).toHaveLength(1);
        await expect(legacyDb.query(create[0])).rejects.toThrow(
          /unique|duplicate/i,
        );
        // Nothing was rewritten or deleted to make the index fit.
        expect(await legacyDb.list(STI_3299_TABLE, {})).toHaveLength(2);
      } finally {
        await legacyDb.query(`DROP TABLE IF EXISTS "${STI_3299_TABLE}"`);
        await legacyDb.close?.();
      }
    });
  });
}
