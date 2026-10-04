/**
 * An application extends Employment with a same-named subclass over the
 * `employments` table (AGENTS.md, "Extending Employment"), the way
 * `smrt-support` extends the timesheets entry: it restates the fields and the
 * closed surface and adds its own fields (teamworks-os keeps succession rank
 * this way).
 *
 * The application's manifest entry below is what that subclass scans to: the
 * package's Employment entry, the application's package, its `extends`, and
 * one added field. The subclass itself is declared here at runtime rather
 * than with `@smrt()` in a source file, because this package's test manifest
 * scans `src/**` and a second decorated `Employment` would join it.
 */
import { readFileSync } from 'node:fs';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
} from '@happyvertical/smrt-core';
import { isApiActionEnabledForObject } from '@happyvertical/smrt-core/generators';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '@happyvertical/smrt-core/scanner/types';
import { getTenantScopedConfig, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmploymentService,
  Employment as PackageEmployment,
} from '../index.js';

const APP = '@fixture/teamworks-os';
const BASE = '@happyvertical/smrt-human-resources:Employment';
const KEY = `${APP}:Employment`;
const CLOSED = { include: [] as string[] };

/** The application's subclass: the package model plus a succession rank. */
const AppEmployment = {
  Employment: class Employment extends PackageEmployment {
    successionRank: number = 0;
  },
}.Employment;
/** The application's own collection over the shared table. */
const AppEmploymentCollection = {
  EmploymentCollection: class EmploymentCollection extends SmrtCollection<
    InstanceType<typeof AppEmployment>
  > {
    static readonly _itemClass = AppEmployment;
  },
}.EmploymentCollection;

const packageManifest = JSON.parse(
  readFileSync(new URL('../../dist/manifest.json', import.meta.url), 'utf8'),
) as SmartObjectManifest;

function appManifest(): SmartObjectManifest {
  const base = packageManifest.objects[BASE] as SmartObjectDefinition;
  const entry = structuredClone(base) as SmartObjectDefinition &
    Record<string, unknown>;
  entry.qualifiedName = KEY;
  entry.packageName = APP;
  entry.filePath = 'src/lib/server/hr/models.ts';
  entry.extends = 'Employment';
  entry.fields = {
    ...base.fields,
    successionRank: { type: 'integer', required: false, default: 0 },
  } as SmartObjectDefinition['fields'];
  // The schema is derived from the fields when the entry registers.
  delete entry.schema;
  entry.decoratorConfig = {
    ...(base.decoratorConfig as Record<string, unknown>),
    tenantScoped: { mode: 'required' },
    sensitive: true,
    api: CLOSED,
    cli: CLOSED,
    mcp: CLOSED,
  };
  return {
    version: packageManifest.version,
    timestamp: 0,
    packageName: APP,
    objects: { [KEY]: entry },
  } as SmartObjectManifest;
}

describe('an application extends Employment with a same-named subclass', () => {
  let db: DatabaseInterface;
  beforeAll(async () => {
    ObjectRegistry.registerPackageManifest(appManifest());
    ObjectRegistry.register(AppEmployment, {
      ...(appManifest().objects[KEY].decoratorConfig as Record<
        string,
        unknown
      >),
      packageName: APP,
    });
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterAll(async () => {
    await db.close?.();
    ObjectRegistry.clear();
  });

  it('owns the employments table with its added column and keeps the surface closed', () => {
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(ObjectRegistry.getTableName(KEY)).toBe('employments');
    expect(Object.keys(schemas.employments.columns)).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'profile_id',
        'employee_number',
        'succession_rank',
      ]),
    );
    expect(ObjectRegistry.getClassByQualifiedName(BASE)).toBeUndefined();
    for (const action of ['list', 'get', 'create', 'update', 'delete'] as const)
      expect(isApiActionEnabledForObject(KEY, action), action).toBe(false);
    const config = ObjectRegistry.getConfig(KEY);
    expect(config.sensitive).toBe(true);
    expect(config.cli).toEqual(CLOSED);
    expect(config.mcp).toEqual(CLOSED);
    expect(getTenantScopedConfig(KEY)?.mode).toBe('required');
  });

  it('shares rows with the service: one stable id, its own writable column, and the package write guard', async () => {
    const actor = {
      tenantId: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
    };
    const service = new EmploymentService(db, actor);
    const profileId = crypto.randomUUID();
    const hired = await service.hire({
      profileId,
      employeeNumber: 'E-1',
      startedOn: '2026-01-05',
    });

    // The application reads the row the service wrote through its own
    // collection, as its own subclass, with its added field.
    const read = () =>
      withTenant({ tenantId: actor.tenantId }, async () => {
        const employments = await AppEmploymentCollection.create({ db });
        return employments.list({ where: { tenantId: actor.tenantId } });
      });
    const [mine] = await read();
    expect(mine).toBeInstanceOf(AppEmployment);
    expect(mine).toMatchObject({
      id: hired.id,
      profileId,
      employeeNumber: 'E-1',
      status: 'active',
      successionRank: 0,
    });

    // The application saves its own field on the row the service wrote.
    mine.successionRank = 2;
    await withTenant({ tenantId: actor.tenantId }, () => mine.save());
    expect((await read())[0]).toMatchObject({
      id: hired.id,
      employeeNumber: 'E-1',
      status: 'active',
      successionRank: 2,
    });

    // The columns the package owns still change only through the service,
    // whether or not an application field changes with them.
    const owned: Record<string, unknown> = {
      status: 'ended',
      employeeNumber: 'E-2',
      position: 'Sneaky',
      workerType: 'contractor',
      userId: crypto.randomUUID(),
      employerProfileId: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
      tenantId: crypto.randomUUID(),
    };
    for (const [property, value] of Object.entries(owned)) {
      const [row] = await read();
      Object.assign(row, { [property]: value, successionRank: 9 });
      await expect(
        withTenant({ tenantId: actor.tenantId }, () => row.save()),
        property,
      ).rejects.toMatchObject({ code: 'HR_WRITE_FORBIDDEN' });
    }
    // A subclass cannot insert an employment either: hiring is the service's.
    await expect(
      withTenant({ tenantId: actor.tenantId }, async () => {
        const employments = await AppEmploymentCollection.create({ db });
        return employments.create({
          tenantId: actor.tenantId,
          profileId: crypto.randomUUID(),
          employeeNumber: 'E-3',
          successionRank: 1,
        });
      }),
    ).rejects.toMatchObject({ code: 'HR_WRITE_FORBIDDEN' });
    const [unchanged] = await read();
    expect(await read()).toHaveLength(1);
    expect(unchanged).toMatchObject({
      id: hired.id,
      tenantId: actor.tenantId,
      profileId,
      userId: null,
      employerProfileId: null,
      employeeNumber: 'E-1',
      workerType: 'employee',
      position: null,
      status: 'active',
      successionRank: 2,
    });
    await expect(unchanged.delete()).rejects.toMatchObject({
      code: 'HR_HISTORY_IMMUTABLE',
    });

    await service.end(hired.id as string, { endedOn: '2026-03-31' });
    const rehired = await service.rehire(hired.id as string, {
      startedOn: '2026-06-01',
    });
    expect(rehired.id).toBe(hired.id);
    expect(await service.check(profileId, '2026-06-01')).toEqual({
      ok: true,
      employmentId: hired.id,
      onLeave: false,
    });
    // The service's writes leave the application's field alone.
    expect(await read()).toEqual([
      expect.objectContaining({
        id: hired.id,
        status: 'active',
        successionRank: 2,
      }),
    ]);
  });
});
