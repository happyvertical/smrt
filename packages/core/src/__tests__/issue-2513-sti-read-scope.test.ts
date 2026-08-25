import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  MAX_STI_READ_SCOPE_TYPES,
  SmrtCollection,
  type SmrtLatestRelatedListOptions,
  type SmrtListOptions,
  type SmrtStiReadScope,
} from '../collection.js';
import { field, foreignKey, oneToMany } from '../decorators/index.js';
import { ObjectRegistry, SmrtObject, smrt } from '../index.js';
import { GlobalInterceptors } from '../interceptors.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = '00000000-0000-4000-8000-000000002513';
const TENANT_B = '00000000-0000-4000-8000-000000002514';
const CURRENT_TYPE = '@happyvertical/smrt-core:ScopeCurrentEvent';
const HISTORICAL_TYPE = '@happyvertical/smrt-core:ScopeHistoricalEvent';

@smrt({
  tableStrategy: 'sti',
  idType: 'text',
  tenantScoped: { mode: 'optional', autoPopulate: false },
})
class ScopeEvent extends SmrtObject {
  title: string = '';
  status: string = '';
  tenantId: string | null = null;
}

@smrt()
class ScopeCurrentEvent extends ScopeEvent {
  accountKey: string = '';

  @oneToMany('ScopeEventNote')
  notes: ScopeEventNote[] = [];
}

@smrt()
class ScopeHistoricalEvent extends ScopeEvent {
  legacyKey: string = '';

  @field({ type: 'boolean' })
  archived: boolean = false;

  @field({ type: 'integer' })
  attempts: number = 0;

  @field({ type: 'datetime' })
  occurredAt: Date = new Date(0);

  @field({ type: 'json' })
  payload: Record<string, unknown> = {};
}

@smrt({ tableStrategy: 'sti' })
class OtherScopeRoot extends SmrtObject {
  label: string = '';
}

@smrt()
class OtherScopeChild extends OtherScopeRoot {}

@smrt({ idType: 'text' })
class ScopeEventNote extends SmrtObject {
  @foreignKey(ScopeCurrentEvent, {
    constraint: { engines: ['postgres', 'sqlite'] },
  })
  eventId: string = '';

  @field()
  sequence: number = 0;

  @field()
  note: string = '';
}

class ScopeEventCollection extends SmrtCollection<ScopeEvent> {
  static readonly _itemClass = ScopeEvent;
}

class ScopeCurrentEventCollection extends SmrtCollection<ScopeCurrentEvent> {
  static readonly _itemClass = ScopeCurrentEvent;
}

class ScopeHistoricalEventCollection extends SmrtCollection<ScopeHistoricalEvent> {
  static readonly _itemClass = ScopeHistoricalEvent;
}

class ScopeEventNoteCollection extends SmrtCollection<ScopeEventNote> {
  static readonly _itemClass = ScopeEventNote;
}

const allTypesScope: SmrtStiReadScope = {
  types: [CURRENT_TYPE, HISTORICAL_TYPE],
};

function assertPublicReadTypes(current: ScopeCurrentEventCollection): void {
  const publicListOptions: SmrtListOptions<ScopeCurrentEvent> = {};
  const publicLatestOptions: SmrtLatestRelatedListOptions<ScopeCurrentEvent> = {
    latestRelated: {
      relation: 'notes',
      orderBy: 'sequence DESC',
    },
  };
  expectTypeOf(current.list()).resolves.toEqualTypeOf<ScopeCurrentEvent[]>();
  expectTypeOf(
    current.list({ stiScope: allTypesScope }),
  ).resolves.toEqualTypeOf<SmrtObject[]>();
  expectTypeOf(
    current.list({ select: ['title'] as const }),
  ).resolves.toEqualTypeOf<Array<{ title: string }>>();
  expectTypeOf(
    current.list({ select: ['title'] as const, stiScope: allTypesScope }),
  ).resolves.toEqualTypeOf<Record<string, unknown>[]>();
  expectTypeOf(current.list(publicListOptions)).resolves.toEqualTypeOf<
    SmrtObject[]
  >();
  function listThroughPublicOptions(
    options: SmrtListOptions<ScopeCurrentEvent>,
  ) {
    return current.list(options);
  }
  expectTypeOf(listThroughPublicOptions).returns.toEqualTypeOf<
    Promise<SmrtObject[] | Record<string, unknown>[]>
  >();
  expectTypeOf(
    current.listWithLatestRelated(publicLatestOptions),
  ).resolves.toEqualTypeOf<
    Array<{
      parent: SmrtObject;
      latestRelated: Record<string, unknown> | null;
    }>
  >();
}
void assertPublicReadTypes;

describe.each([
  { name: 'SQLite', type: 'sqlite' as const },
  { name: 'DuckDB', type: 'duckdb' as const },
])('bounded STI read scope on $name (#2513)', ({ type }) => {
  let db: DatabaseInterface | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    GlobalInterceptors.unregister('issue-2513-tenant');
    await db?.close?.();
    db = undefined;
  });

  async function setup() {
    db = await getTestDatabase({
      type,
      url: ':memory:',
      classes: [
        'ScopeEvent',
        'ScopeCurrentEvent',
        'ScopeHistoricalEvent',
        'ScopeEventNote',
      ],
    });
    const current = await ScopeCurrentEventCollection.create({ db });
    const historical = await ScopeHistoricalEventCollection.create({ db });
    const base = await ScopeEventCollection.create({ db });
    const notes = await ScopeEventNoteCollection.create({ db });

    const currentA = await current.create({
      title: 'Current A',
      status: 'open',
      accountKey: 'account-a',
      tenantId: TENANT_A,
    });
    const historicalA = await historical.create({
      title: 'Historical A',
      status: 'open',
      legacyKey: 'legacy-a',
      archived: true,
      attempts: 7,
      occurredAt: new Date('2025-01-02T03:04:05.000Z'),
      payload: { source: 'legacy', version: 2 },
      tenantId: TENANT_A,
    });
    await current.create({
      title: 'Current B',
      status: 'closed',
      accountKey: 'account-b',
      tenantId: TENANT_B,
    });
    await notes.create({
      eventId: currentA.id,
      sequence: 1,
      note: 'current note',
    });
    await notes.create({
      eventId: historicalA.id,
      sequence: 1,
      note: 'historical note',
    });

    GlobalInterceptors.register({
      name: 'issue-2513-tenant',
      beforeList(className, options) {
        if (className !== 'ScopeCurrentEvent') return options;
        return {
          ...options,
          where: {
            ...(options.where as Record<string, unknown>),
            tenantId: TENANT_A,
          },
        };
      },
      beforeGet(className, filter) {
        if (className !== 'ScopeCurrentEvent') return filter;
        return {
          ...(filter as Record<string, unknown>),
          tenantId: TENANT_A,
        };
      },
    });

    return { base, current, currentA, historicalA };
  }

  it('keeps child-only defaults and reads an allowlisted sibling scope in one bounded query', async () => {
    const { current } = await setup();
    await expect(current.list({ orderBy: 'title ASC' })).resolves.toMatchObject(
      [{ title: 'Current A' }],
    );

    const queries: string[] = [];
    const activeDb = db;
    if (!activeDb) throw new Error('Test database was not initialized.');
    const originalQuery = activeDb.query.bind(activeDb);
    activeDb.query = (async (sql: string, ...params: unknown[]) => {
      queries.push(sql);
      return originalQuery(sql, ...params);
    }) as DatabaseInterface['query'];

    // Simulate an external sibling disappearing from the local registry after
    // allowlist validation but before row hydration. The hydration boundary
    // must invoke manifest loading before it asks for concrete field metadata.
    const originalGetClass = ObjectRegistry.getClass.bind(ObjectRegistry);
    let historicalLookups = 0;
    vi.spyOn(ObjectRegistry, 'getClass').mockImplementation((name) => {
      if (name === HISTORICAL_TYPE && ++historicalLookups === 2) {
        return undefined;
      }
      return originalGetClass(name);
    });
    const ensureManifestLoaded = vi.spyOn(
      ObjectRegistry,
      'ensureManifestLoaded',
    );

    const scoped = await current.list({
      stiScope: allTypesScope,
      orderBy: 'title ASC',
      limit: 2,
      offset: 0,
      cache: { ttl: 60_000 },
    });

    expect(scoped).toHaveLength(2);
    expect(scoped[0]).toBeInstanceOf(ScopeCurrentEvent);
    expect(scoped[1]).toBeInstanceOf(ScopeHistoricalEvent);
    if (!(scoped[1] instanceof ScopeHistoricalEvent)) {
      throw new Error('Expected historical sibling hydration.');
    }
    expect(scoped[1].archived).toBe(true);
    expect(scoped[1].attempts).toBe(7);
    expect(scoped[1].occurredAt).toEqual(new Date('2025-01-02T03:04:05.000Z'));
    expect(scoped[1].payload).toEqual({ source: 'legacy', version: 2 });
    expect(ensureManifestLoaded).toHaveBeenCalledWith(HISTORICAL_TYPE);
    expect(scoped.map((event) => event.title)).toEqual([
      'Current A',
      'Historical A',
    ]);
    expect(
      queries.filter((sql) => sql.includes(`FROM ${current.tableName}`)),
    ).toHaveLength(1);

    await current.list({
      stiScope: allTypesScope,
      orderBy: 'title ASC',
      limit: 2,
      offset: 0,
      cache: { ttl: 60_000 },
    });
    expect(
      queries.filter((sql) => sql.includes(`FROM ${current.tableName}`)),
    ).toHaveLength(1);
  });

  it('preserves child projection, polymorphic hydration, counts, facets, and tenancy', async () => {
    const { current, historicalA } = await setup();

    await expect(
      current.list({
        stiScope: allTypesScope,
        select: ['title', 'accountKey', '_meta_type'] as const,
        orderBy: 'title ASC',
      }),
    ).resolves.toEqual([
      {
        title: 'Current A',
        accountKey: 'account-a',
        _meta_type: CURRENT_TYPE,
      },
      {
        title: 'Historical A',
        accountKey: '',
        _meta_type: HISTORICAL_TYPE,
      },
    ]);

    const getAllFields = vi.spyOn(ObjectRegistry, 'getAllFields');
    const latestRelatedPromise = current.listWithLatestRelated({
      stiScope: allTypesScope,
      latestRelated: {
        relation: 'notes',
        orderBy: 'sequence DESC',
        select: ['note'],
      },
      orderBy: 'title ASC',
      limit: 2,
    });
    expectTypeOf(latestRelatedPromise).resolves.toEqualTypeOf<
      Array<{
        parent: SmrtObject;
        latestRelated: Record<string, unknown> | null;
      }>
    >();
    const latestRelated = await latestRelatedPromise;
    expect(latestRelated).toHaveLength(2);
    expect(latestRelated[0]?.parent).toBeInstanceOf(ScopeCurrentEvent);
    expect(latestRelated[1]?.parent).toBeInstanceOf(ScopeHistoricalEvent);
    expect(latestRelated.map((row) => row.latestRelated?.note)).toEqual([
      'current note',
      'historical note',
    ]);
    expect(
      getAllFields.mock.calls.filter(([type]) => type === CURRENT_TYPE),
    ).toHaveLength(1);
    expect(
      getAllFields.mock.calls.filter(([type]) => type === HISTORICAL_TYPE),
    ).toHaveLength(1);
    expect(await current.count()).toBe(1);
    expect(await current.count({ stiScope: allTypesScope })).toBe(2);
    await expect(
      current.counts({
        stiScope: allTypesScope,
        where: { status: 'open' },
      }),
    ).resolves.toEqual({ total: 2, filtered: 2 });
    await expect(
      current.facets({
        stiScope: allTypesScope,
        fields: ['status'],
      }),
    ).resolves.toEqual([
      { field: 'status', values: [{ value: 'open', count: 2 }] },
    ]);
  });

  it('rejects malformed, unknown, duplicate, oversized, base, and unrelated scopes', async () => {
    const { base, current } = await setup();

    await expect(current.list({ stiScope: { types: [] } })).rejects.toThrow(
      /must not be empty/,
    );
    await expect(
      current.list({ stiScope: { types: ['ScopeHistoricalEvent'] } }),
    ).rejects.toThrow(/qualified SMRT type/);
    await expect(
      current.list({
        stiScope: { types: ['@happyvertical/smrt-core:MissingScopeEvent'] },
      }),
    ).rejects.toThrow(/unknown type/);
    await expect(
      current.list({ stiScope: { types: [CURRENT_TYPE, CURRENT_TYPE] } }),
    ).rejects.toThrow(/duplicate type/);
    await expect(
      current.list({
        stiScope: {
          types: Array.from(
            { length: MAX_STI_READ_SCOPE_TYPES + 1 },
            (_, index) => `@fixture/scope:Type${index}`,
          ),
        },
      }),
    ).rejects.toThrow(`at most ${MAX_STI_READ_SCOPE_TYPES} types`);
    await expect(
      current.list({
        stiScope: {
          types: ['@happyvertical/smrt-core:OtherScopeChild'],
        },
      }),
    ).rejects.toThrow(/does not share STI root/);
    await expect(base.list({ stiScope: allTypesScope })).rejects.toThrow(
      /require an STI child collection/,
    );
    const malformedScope = JSON.parse(
      `{"types":["${CURRENT_TYPE}"],"extra":true}`,
    );
    await expect(current.list({ stiScope: malformedScope })).rejects.toThrow(
      /expected \{ types/,
    );
  });
});
