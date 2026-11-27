/**
 * The change feed records each change under the tenant its row belongs to,
 * read from the class's real ownership field — a declared custom tenant
 * field, or a runtime ownership registration such as the tenancy package's
 * `{ field: 'organizationId' }` — not only a `tenantId` property. An entry
 * recorded as global is served to every tenant.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../index';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { deleteSyncRows } from '../sync-tombstones';
import { getTestDatabase } from '../testing/database';

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldProject extends SmrtObject {
  name: string = '';
  organizationId: string = '';
}
class TenantFieldProjectCollection extends SmrtCollection<TenantFieldProject> {
  static readonly _itemClass = TenantFieldProject;
}

@smrt()
class TenantFieldTeam extends SmrtObject {
  name: string = '';
  workspaceId: string = '';
}
class TenantFieldTeamCollection extends SmrtCollection<TenantFieldTeam> {
  static readonly _itemClass = TenantFieldTeam;
}

@smrt()
class TenantFieldNote extends SmrtObject {
  body: string = '';
  tenantId: string = '';
}
class TenantFieldNoteCollection extends SmrtCollection<TenantFieldNote> {
  static readonly _itemClass = TenantFieldNote;
}

@smrt()
class TenantFieldDual extends SmrtObject {
  name: string = '';
  workspaceId: string = '';
  orgId: string = '';
}
class TenantFieldDualCollection extends SmrtCollection<TenantFieldDual> {
  static readonly _itemClass = TenantFieldDual;
}

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldMixedOwner extends SmrtObject {
  name: string = '';
  organizationId: string = '';
  workspaceId: string = '';
}
class TenantFieldMixedOwnerCollection extends SmrtCollection<TenantFieldMixedOwner> {
  static readonly _itemClass = TenantFieldMixedOwner;
}

@smrt({
  tenantScoped: { field: 'organizationId' },
  hooks: { afterDelete: 'clearOwner' },
})
class TenantFieldClearing extends SmrtObject {
  name: string = '';
  organizationId: string = '';

  async clearOwner(): Promise<void> {
    this.organizationId = '';
  }
}
class TenantFieldClearingCollection extends SmrtCollection<TenantFieldClearing> {
  static readonly _itemClass = TenantFieldClearing;
}

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldLink extends SmrtObject {
  organizationId: string = '';
  ownerId: string = '';
  assetId: string = '';
}

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldBase extends SmrtObject {
  name: string = '';
  organizationId: string = '';
}

@smrt()
class TenantFieldSub extends TenantFieldBase {
  detail: string = '';
}
class TenantFieldSubCollection extends SmrtCollection<TenantFieldSub> {
  static readonly _itemClass = TenantFieldSub;
}

/** The owner a `transformJSON()` hook writes into the persisted row. */
let serializedOwner = '';

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldSerialized extends SmrtObject {
  name: string = '';
  organizationId: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...data, organizationId: serializedOwner };
  }
}
class TenantFieldSerializedCollection extends SmrtCollection<TenantFieldSerialized> {
  static readonly _itemClass = TenantFieldSerialized;
}

/** The owner a `beforeDelete` hook moves the stored row to. */
let movedOwner = '';

@smrt({
  tenantScoped: { field: 'organizationId' },
  hooks: { beforeDelete: 'moveStoredOwner' },
})
class TenantFieldMoved extends SmrtObject {
  name: string = '';
  organizationId: string = '';

  async moveStoredOwner(): Promise<void> {
    // The stored owner changes after the delete began and before its
    // statement runs, the window a concurrent writer could use.
    await this.db.query(
      'UPDATE tenant_field_moveds SET organization_id = ? WHERE id = ?',
      movedOwner,
      this.id,
    );
  }
}
class TenantFieldMovedCollection extends SmrtCollection<TenantFieldMoved> {
  static readonly _itemClass = TenantFieldMoved;
}

@smrt()
class TenantFieldOrg extends SmrtObject {
  name: string = '';
}
class TenantFieldOrgCollection extends SmrtCollection<TenantFieldOrg> {
  static readonly _itemClass = TenantFieldOrg;
}

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldUuidItem extends SmrtObject {
  name: string = '';
  @foreignKey('TenantFieldOrg')
  organizationId: string = '';
}
class TenantFieldUuidItemCollection extends SmrtCollection<TenantFieldUuidItem> {
  static readonly _itemClass = TenantFieldUuidItem;
}

@smrt({
  tenantScoped: { field: 'organizationId' },
  hooks: { afterDelete: 'reassignId' },
})
class TenantFieldRenamed extends SmrtObject {
  name: string = '';
  organizationId: string = '';

  async reassignId(): Promise<void> {
    this.id = 'replacement-row';
  }
}
class TenantFieldRenamedCollection extends SmrtCollection<TenantFieldRenamed> {
  static readonly _itemClass = TenantFieldRenamed;
}

/** Whether `transformJSON()` drops the owner column from the saved row. */
let dropOwnerColumn = false;

@smrt()
class TenantFieldOmitted extends SmrtObject {
  name: string = '';
  workspaceId: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!dropOwnerColumn) return data;
    const { workspaceId: _omitted, ...rest } = data;
    return rest;
  }
}
class TenantFieldOmittedCollection extends SmrtCollection<TenantFieldOmitted> {
  static readonly _itemClass = TenantFieldOmitted;
}

/** A primary-key conflict target: a fresh instance with a stored id upserts. */
@smrt({ conflictColumns: ['id'] })
class TenantFieldIdKeyed extends SmrtObject {
  name: string = '';
  workspaceId: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!dropOwnerColumn) return data;
    const { workspaceId: _omitted, ...rest } = data;
    return rest;
  }
}
class TenantFieldIdKeyedCollection extends SmrtCollection<TenantFieldIdKeyed> {
  static readonly _itemClass = TenantFieldIdKeyed;
}

/**
 * A declared tenant column outside the conflict target: nothing supplies a
 * NULL for it when the saved row omits it.
 */
@smrt({
  tenantScoped: { field: 'organizationId' },
  conflictColumns: ['id'],
})
class TenantFieldDeclaredIdKeyed extends SmrtObject {
  name: string = '';
  organizationId: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!dropOwnerColumn) return data;
    const { organizationId: _omitted, ...rest } = data;
    return rest;
  }
}
class TenantFieldDeclaredIdKeyedCollection extends SmrtCollection<TenantFieldDeclaredIdKeyed> {
  static readonly _itemClass = TenantFieldDeclaredIdKeyed;
}

/** An owner column the database fills from its default when the save omits it. */
@smrt()
class TenantFieldDefaulted extends SmrtObject {
  name: string = '';
  @field({ type: 'text', default: 'ws-default' })
  workspaceId: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const { workspaceId: _omitted, ...rest } = data;
    return rest;
  }
}
class TenantFieldDefaultedCollection extends SmrtCollection<TenantFieldDefaulted> {
  static readonly _itemClass = TenantFieldDefaulted;
}

const PROJECTS = 'tenant_field_projects';
const LINKS = 'tenant_field_links';
const MIXED = 'tenant_field_mixed_owners';
const CLEARING = 'tenant_field_clearings';
const DUALS = 'tenant_field_duals';
const TEAMS = 'tenant_field_teams';
const NOTES = 'tenant_field_notes';

describe('change-feed entries carry the row owner from its real tenant field', () => {
  let db: DatabaseInterface;
  let unregisterSource: (() => void) | undefined;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'TenantFieldProject',
        'TenantFieldTeam',
        'TenantFieldNote',
        'TenantFieldDual',
        'TenantFieldMixedOwner',
        'TenantFieldClearing',
        'TenantFieldLink',
        'TenantFieldSub',
        'TenantFieldSerialized',
        'TenantFieldMoved',
        'TenantFieldRenamed',
        'TenantFieldOmitted',
        'TenantFieldIdKeyed',
        'TenantFieldDeclaredIdKeyed',
        'TenantFieldDefaulted',
      ],
    });
  });

  afterEach(async () => {
    unregisterSource?.();
    unregisterSource = undefined;
    resetChangeSignals();
    await db.close?.();
  });

  async function entryFor(table: string, rowId: string | null | undefined) {
    const { changes } = await getChangesSince(db, { since: 0 });
    return changes.find(
      (change) => change.table === table && change.rowId === rowId,
    );
  }

  it('reads a declared custom tenant field', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const signals: ChangeSignal[] = [];
    subscribeToChangeSignals(db, (signal) => signals.push(signal));
    const project = await projects.create({
      name: 'p',
      organizationId: 'org-a',
    });

    expect((await entryFor(PROJECTS, project.id))?.tenantId).toBe('org-a');
    expect(signals.at(-1)?.tenantId).toBe('org-a');
    // Another tenant's scoped read does not see it.
    const otherTenant = await getChangesSince(db, {
      since: 0,
      tenantId: 'org-b',
    });
    expect(
      otherTenant.changes.some((change) => change.rowId === project.id),
    ).toBe(false);
  });

  it('reads a runtime ownership registration', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldTeam)?.qualifiedName ??
      'TenantFieldTeam';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const teams = await TenantFieldTeamCollection.create({ db });
    const team = await teams.create({ name: 't', workspaceId: 'ws-a' });

    expect((await entryFor(TEAMS, team.id))?.tenantId).toBe('ws-a');
  });

  it('does not record a row whose ownership fields name different tenants', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldDual)?.qualifiedName ??
      'TenantFieldDual';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id', 'org_id'] : undefined,
    );
    const duals = await TenantFieldDualCollection.create({ db });
    const disagreeing = await duals.create({
      name: 'split',
      workspaceId: 'tenant-a',
      orgId: 'tenant-b',
    });
    const agreeing = await duals.create({
      name: 'same',
      workspaceId: 'tenant-a',
      orgId: 'tenant-a',
    });

    expect(await entryFor(DUALS, disagreeing.id)).toBeUndefined();
    expect((await entryFor(DUALS, agreeing.id))?.tenantId).toBe('tenant-a');
  });

  it('warns about a disagreeing row on its own limit, without promising a table-level entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldDual)?.qualifiedName ??
      'TenantFieldDual';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id', 'org_id'] : undefined,
    );
    const duals = await TenantFieldDualCollection.create({ db });
    await duals.create({
      name: 'x',
      workspaceId: 'tenant-a',
      orgId: 'tenant-b',
    });
    await duals.create({
      name: 'y',
      workspaceId: 'tenant-a',
      orgId: 'tenant-b',
    });
    // An append failure on the same table still logs: the limits are separate.
    await db.query(
      `CREATE TRIGGER tenant_field_fail BEFORE INSERT ON _smrt_changes WHEN NEW.table_name = '${DUALS}' BEGIN SELECT RAISE(ABORT, 'forced'); END`,
    );
    await duals.create({
      name: 'z',
      workspaceId: 'tenant-a',
      orgId: 'tenant-a',
    });
    await db.query('DROP TRIGGER tenant_field_fail');

    const messages = warn.mock.calls.map((call) => String(call[0]));
    const ambiguous = messages.filter((m) =>
      m.includes('could not be resolved'),
    );
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).not.toContain('table-level entry');
    expect(messages.filter((m) => m.includes('failed to append'))).toHaveLength(
      1,
    );
    warn.mockRestore();
  });

  it('records nothing, and warns, when the ownership lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldTeam)?.qualifiedName ??
      'TenantFieldTeam';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) => {
      if (name === qualified) throw new Error('ownership source unavailable');
      return undefined;
    });
    const teams = await TenantFieldTeamCollection.create({ db });
    const team = await teams.create({ name: 'private', workspaceId: 'ws-a' });

    // Not recorded as global (which every tenant would be served), and not
    // recorded at all.
    expect(await entryFor(TEAMS, team.id)).toBeUndefined();
    const otherTenant = await getChangesSince(db, {
      since: 0,
      tenantId: 'ws-b',
    });
    expect(otherTenant.changes.some((c) => c.rowId === team.id)).toBe(false);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('could not be resolved'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('does not let a runtime owner hide a conflicting declared owner on a fresh insert', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldMixedOwner)
        ?.qualifiedName ?? 'TenantFieldMixedOwner';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const rows = await TenantFieldMixedOwnerCollection.create({ db });
    const conflicting = await rows.create({
      name: 'split',
      organizationId: 'org-a',
      workspaceId: 'org-b',
    });
    const agreeing = await rows.create({
      name: 'same',
      organizationId: 'org-a',
      workspaceId: 'org-a',
    });
    expect(await entryFor(MIXED, conflicting.id)).toBeUndefined();
    expect((await entryFor(MIXED, agreeing.id))?.tenantId).toBe('org-a');
  });

  it('records a delete under the owner the row had, even if afterDelete clears it', async () => {
    const rows = await TenantFieldClearingCollection.create({ db });
    const row = await rows.create({ name: 'owned', organizationId: 'org-a' });
    await row.delete();
    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === row.id && change.operation === 'delete',
    );
    expect(tombstone?.table).toBe(CLEARING);
    expect(tombstone?.tenantId).toBe('org-a');
    const otherTenant = await getChangesSince(db, {
      since: 0,
      tenantId: 'org-b',
    });
    expect(otherTenant.changes.some((c) => c.rowId === row.id)).toBe(false);
  });

  it('records a delete under the stored owner when the instance field was cleared without saving', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const project = await projects.create({
      name: 'owned',
      organizationId: 'org-a',
    });
    project.organizationId = '';
    await project.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === project.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('org-a');
    const otherTenant = await getChangesSince(db, {
      since: 0,
      tenantId: 'org-b',
    });
    expect(otherTenant.changes.some((c) => c.rowId === project.id)).toBe(false);
  });

  it('records a delete under the stored owner when the instance names another tenant', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const project = await projects.create({
      name: 'owned',
      organizationId: 'org-a',
    });
    project.organizationId = 'org-b';
    await project.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === project.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('org-a');
  });

  it('records grouped deletes under each stored owner', async () => {
    const make = async (organizationId: string, assetId: string) => {
      const link = await new TenantFieldLink({ db }).initialize();
      Object.assign(link, { organizationId, ownerId: 'left', assetId });
      await link.save();
      return link;
    };
    const first = await make('org-a', 'asset-1');
    const second = await make('org-b', 'asset-2');
    first.organizationId = '';
    second.organizationId = '';

    expect(await SmrtObject.tryJunctionBatch([first, second], [])).toBe(true);

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstones = changes.filter(
      (change) => change.table === LINKS && change.operation === 'delete',
    );
    expect(tombstones.map((change) => [change.rowId, change.tenantId])).toEqual(
      [
        [first.id, 'org-a'],
        [second.id, 'org-b'],
      ],
    );
  });

  it('records the same tenant through the bulk path', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const created = await projects.createMany([
      { name: 'p1', organizationId: 'org-a' },
      { name: 'p2', organizationId: 'org-b' },
    ]);
    const { changes } = await getChangesSince(db, { since: 0 });
    const byRow = new Map<string | null | undefined, (typeof changes)[number]>(
      changes.map((change) => [change.rowId, change]),
    );
    expect(created.map((item) => byRow.get(item.id)?.tenantId)).toEqual([
      'org-a',
      'org-b',
    ]);
  });

  it('keeps reading tenantId for a class that uses it', async () => {
    const notes = await TenantFieldNoteCollection.create({ db });
    const scoped = await notes.create({ body: 'n', tenantId: 'tenant-x' });
    const global = await notes.create({ body: 'g', tenantId: '' });
    expect((await entryFor(NOTES, scoped.id))?.tenantId).toBe('tenant-x');
    expect((await entryFor(NOTES, global.id))?.tenantId).toBeNull();
  });

  it('records a subtype delete under the owner column it inherits', async () => {
    // A subtype registered from a manifest that lists only its own fields:
    // the owner field is inherited, and persistence reads the merged set.
    const registered = ObjectRegistry.getClassByConstructor(TenantFieldSub);
    if (!registered?.inheritedFields?.has('organizationId')) {
      throw new Error('expected the inherited owner field');
    }
    const ownFields = registered.fields;
    registered.fields = new Map(
      [...ownFields].filter(([name]) => name === 'detail'),
    );
    const subs = await TenantFieldSubCollection.create({ db });
    const sub = await subs.create({
      name: 's',
      detail: 'd',
      organizationId: 'org-a',
    });
    sub.organizationId = '';
    try {
      await sub.delete();
    } finally {
      registered.fields = ownFields;
    }

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === sub.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('org-a');
  });

  it('records a revision claim under the stored owner, not a cleared field', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const created = await projects.create({
      name: 'claimed',
      organizationId: 'org-a',
    });
    const loaded = await projects.get(String(created.id));
    if (!loaded?.updated_at) throw new Error('expected a persisted row');
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    loaded.organizationId = '';
    await loaded.claimRevision(loaded.updated_at);

    const { changes } = await getChangesSince(db, { since: before });
    const claim = changes.find((change) => change.rowId === created.id);
    expect(claim?.operation).toBe('update');
    expect(claim?.tenantId).toBe('org-a');
  });

  it('records a save under the owner the persisted row carries', async () => {
    const rows = await TenantFieldSerializedCollection.create({ db });
    serializedOwner = 'org-a';
    try {
      const single = await rows.create({ name: 'one' });
      const many = await rows.createMany([{ name: 'two' }, { name: 'three' }]);
      const stored = await db.query(
        'SELECT organization_id FROM tenant_field_serializeds WHERE id = ?',
        single.id,
      );
      expect(stored.rows[0]?.organization_id).toBe('org-a');
      for (const row of [single, ...many]) {
        expect(
          (await entryFor('tenant_field_serializeds', row.id))?.tenantId,
        ).toBe('org-a');
      }
    } finally {
      serializedOwner = '';
    }
  });

  it('records a delete under the owner of the row the delete removed', async () => {
    const rows = await TenantFieldMovedCollection.create({ db });
    const row = await rows.create({ name: 'moved', organizationId: 'org-a' });
    movedOwner = 'org-b';
    try {
      await row.delete();
    } finally {
      movedOwner = '';
    }
    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === row.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('org-b');
  });

  it("reads a deleted row's owner in the delete statement itself", async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const project = await projects.create({
      name: 'single statement',
      organizationId: 'org-a',
    });
    // Every statement the delete issues, on the handle and on any
    // transaction handle opened from it.
    const statements: string[] = [];
    const watch = (handle: DatabaseInterface) => {
      const query = handle.query.bind(handle);
      vi.spyOn(handle, 'query').mockImplementation((sql, ...args) => {
        statements.push(String(sql));
        return query(sql, ...args);
      });
    };
    const handle = project.db;
    watch(handle);
    const transaction = handle.transaction?.bind(handle);
    if (transaction) {
      vi.spyOn(handle, 'transaction').mockImplementation(((
        callback: (tx: DatabaseInterface) => Promise<unknown>,
        ...rest: unknown[]
      ) =>
        (transaction as (...args: unknown[]) => Promise<unknown>)(
          (tx: DatabaseInterface) => {
            watch(tx);
            return callback(tx);
          },
          ...rest,
        )) as unknown as NonNullable<DatabaseInterface['transaction']>);
    }
    try {
      await project.delete();
    } finally {
      vi.restoreAllMocks();
    }
    const ownerReads = statements.filter(
      (sql) =>
        sql.includes('organization_id') &&
        sql.includes('tenant_field_projects'),
    );
    expect(ownerReads.length).toBeGreaterThan(0);
    for (const sql of ownerReads) expect(sql).toMatch(/^\s*DELETE\b/i);
    expect(
      (await getChangesSince(db, { since: 0 })).changes.at(-1)?.tenantId,
    ).toBe('org-a');
  });

  it('keeps a delete attributed when a later interceptor replaces the context metadata', async () => {
    // Runs ahead of the feed writer at both points, after the delete
    // recorded its owner and before the writer reads it.
    GlobalInterceptors.register({
      name: 'tenant-field-metadata-replacer',
      priority: 10,
      async beforeDelete(_instance, context) {
        context.metadata = {};
      },
      async afterDelete(_instance, context) {
        context.metadata = {};
      },
    });
    try {
      const rows = await TenantFieldClearingCollection.create({ db });
      const row = await rows.create({ name: 'owned', organizationId: 'org-a' });
      await row.delete();
      const { changes } = await getChangesSince(db, { since: 0 });
      const tombstone = changes.find(
        (change) => change.rowId === row.id && change.operation === 'delete',
      );
      expect(tombstone?.tenantId).toBe('org-a');
    } finally {
      GlobalInterceptors.unregister('tenant-field-metadata-replacer');
    }
  });

  it('records grouped deletes of ids that differ only in case under each stored owner', async () => {
    const make = async (id: string, organizationId: string) => {
      const link = await new TenantFieldLink({ db }).initialize();
      Object.assign(link, { id, organizationId, ownerId: 'left', assetId: id });
      await link.save();
      return link;
    };
    const upper = await make('Case-Row', 'org-a');
    const lower = await make('case-row', 'org-b');
    upper.organizationId = '';
    lower.organizationId = '';

    expect(await SmrtObject.tryJunctionBatch([upper, lower], [])).toBe(true);

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstones = changes.filter(
      (change) => change.table === LINKS && change.operation === 'delete',
    );
    expect(tombstones.map((change) => [change.rowId, change.tenantId])).toEqual(
      [
        ['Case-Row', 'org-a'],
        ['case-row', 'org-b'],
      ],
    );
  });

  it('records a delete under the id it removed when afterDelete reassigns the id', async () => {
    const rows = await TenantFieldRenamedCollection.create({ db });
    const row = await rows.create({ name: 'renamed', organizationId: 'org-a' });
    const removedId = String(row.id);
    await row.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstones = changes.filter(
      (change) => change.operation === 'delete',
    );
    expect(tombstones.map((change) => [change.rowId, change.tenantId])).toEqual(
      [[removedId, 'org-a']],
    );
  });

  it('records a subtype delete under its inherited owner when the merged field cache is cold', async () => {
    const registered = ObjectRegistry.getClassByConstructor(TenantFieldSub);
    if (!registered?.inheritedFields?.has('organizationId')) {
      throw new Error('expected the inherited owner field');
    }
    const subs = await TenantFieldSubCollection.create({ db });
    const created = await subs.create({
      name: 's',
      detail: 'd',
      organizationId: 'org-a',
    });
    // A fresh instance assigned an existing id, deleted before anything
    // resolved the merged field set; only the parent declares the owner.
    const ownFields = registered.fields;
    registered.fields = new Map(
      [...ownFields].filter(([name]) => name === 'detail'),
    );
    registered.inheritedFields = undefined;
    const sub = await new TenantFieldSub({ db }).initialize();
    sub.id = created.id;
    try {
      await sub.delete();
    } finally {
      registered.fields = ownFields;
      registered.inheritedFields = undefined;
    }

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === created.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('org-a');
  });

  it('records nothing, and warns, when a subtype merged field set cannot be resolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registered = ObjectRegistry.getClassByConstructor(TenantFieldSub);
    if (!registered) throw new Error('expected a registered subtype');
    const subs = await TenantFieldSubCollection.create({ db });
    const created = await subs.create({
      name: 's',
      detail: 'd',
      organizationId: 'org-a',
    });
    const ownFields = registered.fields;
    registered.fields = new Map(
      [...ownFields].filter(([name]) => name === 'detail'),
    );
    registered.inheritedFields = undefined;
    const sub = await new TenantFieldSub({ db }).initialize();
    sub.id = created.id;
    // The one warm-up attempt fails and the merged set stays unresolved.
    const getAllFields = vi
      .spyOn(ObjectRegistry, 'getAllFields')
      .mockRejectedValue(new Error('merged fields unavailable'));
    Object.defineProperty(registered, 'inheritedFields', {
      configurable: true,
      get: () => undefined,
      set: () => {},
    });
    try {
      await sub.delete();
    } finally {
      getAllFields.mockRestore();
      delete (registered as { inheritedFields?: unknown }).inheritedFields;
      registered.fields = ownFields;
      registered.inheritedFields = undefined;
    }

    const { changes } = await getChangesSince(db, { since: 0 });
    expect(
      changes.some(
        (change) =>
          change.rowId === created.id && change.operation === 'delete',
      ),
    ).toBe(false);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('could not be resolved'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('attributes a delete from one ownership snapshot when the registration changes mid-statement', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldDual)?.qualifiedName ??
      'TenantFieldDual';
    let ownerColumn = 'workspace_id';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? [ownerColumn] : undefined,
    );
    const duals = await TenantFieldDualCollection.create({ db });
    const row = await duals.create({
      name: 'switch',
      workspaceId: 'tenant-a',
      orgId: '',
    });
    row.workspaceId = '';
    // Every statement the delete issues, on the handle and on any
    // transaction handle opened from it.
    const watch = (handle: DatabaseInterface) => {
      const query = handle.query.bind(handle);
      vi.spyOn(handle, 'query').mockImplementation(async (sql, ...args) => {
        const result = await query(sql, ...args);
        // The registration moves to another stored column while the DELETE
        // is in flight.
        if (/^\s*DELETE FROM "tenant_field_duals"/i.test(String(sql))) {
          ownerColumn = 'org_id';
        }
        return result;
      });
    };
    const handle = row.db;
    watch(handle);
    const transaction = handle.transaction?.bind(handle);
    if (transaction) {
      vi.spyOn(handle, 'transaction').mockImplementation(((
        callback: (tx: DatabaseInterface) => Promise<unknown>,
        ...rest: unknown[]
      ) =>
        (transaction as (...args: unknown[]) => Promise<unknown>)(
          (tx: DatabaseInterface) => {
            watch(tx);
            return callback(tx);
          },
          ...rest,
        )) as unknown as NonNullable<DatabaseInterface['transaction']>);
    }
    try {
      await row.delete();
    } finally {
      vi.restoreAllMocks();
    }

    const { changes } = await getChangesSince(db, { since: 0 });
    expect(ownerColumn).toBe('org_id');
    const tombstone = changes.find(
      (change) => change.rowId === row.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('tenant-a');
  });

  it('records no tombstone when a trigger keeps the row the delete targeted', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const project = await projects.create({
      name: 'kept',
      organizationId: 'org-a',
    });
    await db.query(
      `CREATE TRIGGER tenant_field_keep BEFORE DELETE ON ${PROJECTS} BEGIN SELECT RAISE(IGNORE); END`,
    );
    project.organizationId = '';
    try {
      await project.delete();
    } finally {
      await db.query('DROP TRIGGER tenant_field_keep');
    }

    const stillStored = await db.query(
      `SELECT id FROM ${PROJECTS} WHERE id = ?`,
      project.id,
    );
    expect(stillStored.rows).toHaveLength(1);
    const { changes } = await getChangesSince(db, { since: 0 });
    expect(
      changes.some(
        (change) =>
          change.rowId === project.id && change.operation === 'delete',
      ),
    ).toBe(false);
  });

  it('records a delete of an id with no stored row under the in-memory owner', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const project = await projects.create({
      name: 'gone',
      organizationId: 'org-a',
    });
    await db.query(`DELETE FROM ${PROJECTS} WHERE id = ?`, project.id);
    await project.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === project.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe('org-a');
  });

  it('records no entry, and warns, for an update whose saved row omits the ownership column', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldOmitted)?.qualifiedName ??
      'TenantFieldOmitted';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const rows = await TenantFieldOmittedCollection.create({ db });
    const created = await rows.create({ name: 'kept', workspaceId: 'ws-a' });
    const loaded = await rows.get(String(created.id));
    if (!loaded) throw new Error('expected a persisted row');
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    loaded.workspaceId = '';
    loaded.name = 'renamed';
    dropOwnerColumn = true;
    try {
      await loaded.save();
    } finally {
      dropOwnerColumn = false;
    }

    const stored = await db.query(
      'SELECT name, workspace_id FROM tenant_field_omitteds WHERE id = ?',
      created.id,
    );
    expect(stored.rows[0]).toMatchObject({
      name: 'renamed',
      workspace_id: 'ws-a',
    });
    const { changes } = await getChangesSince(db, { since: before });
    expect(changes.some((change) => change.rowId === created.id)).toBe(false);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('could not be resolved'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('keeps recording an update whose saved row carries the ownership column', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldOmitted)?.qualifiedName ??
      'TenantFieldOmitted';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const rows = await TenantFieldOmittedCollection.create({ db });
    const created = await rows.create({ name: 'kept', workspaceId: 'ws-a' });
    const loaded = await rows.get(String(created.id));
    if (!loaded) throw new Error('expected a persisted row');
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    loaded.name = 'renamed';
    await loaded.save();

    const { changes } = await getChangesSince(db, { since: before });
    const update = changes.find((change) => change.rowId === created.id);
    expect(update?.operation).toBe('update');
    expect(update?.tenantId).toBe('ws-a');
  });

  it('records a save that adopts a stored natural-key row under that row id', async () => {
    const projects = await TenantFieldProjectCollection.create({ db });
    const first = await projects.create({
      name: 'adopted',
      slug: 'adopted',
      organizationId: 'org-a',
    });
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    // A fresh instance that never looked the row up carries a new id.
    const again = new TenantFieldProject({ db, organizationId: 'org-a' });
    await again.initialize();
    again.name = 'adopted again';
    again.slug = 'adopted';
    const discardedId = randomUUID();
    again.id = discardedId;
    await again.save();

    expect(again.id).toBe(first.id);
    const { changes } = await getChangesSince(db, { since: before });
    expect(changes.some((change) => change.rowId === discardedId)).toBe(false);
    const entry = changes.find((change) => change.rowId === first.id);
    expect(entry?.tenantId).toBe('org-a');
  });

  function expectUnresolvedWarning(warn: ReturnType<typeof vi.spyOn>) {
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('could not be resolved'),
      ),
    ).toBe(true);
  }

  it('refuses, and records no entry for, a primary-key upsert whose saved row omits the ownership column', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldIdKeyed)?.qualifiedName ??
      'TenantFieldIdKeyed';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const rows = await TenantFieldIdKeyedCollection.create({ db });
    const created = await rows.create({ name: 'kept', workspaceId: 'ws-a' });
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    const fresh = new TenantFieldIdKeyed({ db });
    await fresh.initialize();
    fresh.id = created.id;
    fresh.name = 'renamed';
    // An explicit-id create updates a stored row only for the same owner; a
    // save that leaves the owner unset counts as NULL and is refused.
    dropOwnerColumn = true;
    try {
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'TENANT_ISOLATION_VIOLATION',
      });
    } finally {
      dropOwnerColumn = false;
    }

    const stored = await db.query(
      'SELECT name, workspace_id FROM tenant_field_id_keyeds WHERE id = ?',
      created.id,
    );
    expect(stored.rows[0]).toMatchObject({
      name: 'kept',
      workspace_id: 'ws-a',
    });
    const { changes } = await getChangesSince(db, { since: before });
    expect(changes.some((change) => change.rowId === created.id)).toBe(false);
  });

  it('records no entry, and warns, when the saved row omits a declared ownership column outside the conflict target', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await TenantFieldDeclaredIdKeyedCollection.create({ db });
    const kept = await rows.create({ name: 'kept', organizationId: 'org-a' });
    expect(
      (await entryFor('tenant_field_declared_id_keyeds', kept.id))?.tenantId,
    ).toBe('org-a');
    const before = (await getChangesSince(db, { since: 0 })).cursor;

    dropOwnerColumn = true;
    try {
      kept.name = 'renamed';
      await kept.save();
    } finally {
      dropOwnerColumn = false;
    }

    const stored = await db.query(
      'SELECT name, organization_id FROM tenant_field_declared_id_keyeds WHERE id = ?',
      kept.id,
    );
    expect(stored.rows[0]).toMatchObject({
      name: 'renamed',
      organization_id: 'org-a',
    });
    const { changes } = await getChangesSince(db, { since: before });
    expect(changes.some((change) => change.rowId === kept.id)).toBe(false);
    expectUnresolvedWarning(warn);
    warn.mockRestore();
  });

  it('records no entry, and warns, for an insert whose saved row leaves the ownership column to the database', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldDefaulted)
        ?.qualifiedName ?? 'TenantFieldDefaulted';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const rows = await TenantFieldDefaultedCollection.create({ db });
    const created = await rows.create({ name: 'defaulted' });

    const stored = await db.query(
      'SELECT workspace_id FROM tenant_field_defaulteds WHERE id = ?',
      created.id,
    );
    expect(stored.rows[0]).toMatchObject({ workspace_id: 'ws-default' });
    const { changes } = await getChangesSince(db, { since: 0 });
    expect(changes.some((change) => change.rowId === created.id)).toBe(false);
    expectUnresolvedWarning(warn);
    warn.mockRestore();
  });

  it('keeps recording an insert whose saved row carries the ownership column', async () => {
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldIdKeyed)?.qualifiedName ??
      'TenantFieldIdKeyed';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['workspace_id'] : undefined,
    );
    const rows = await TenantFieldIdKeyedCollection.create({ db });
    const created = await rows.create({ name: 'owned', workspaceId: 'ws-a' });

    expect(
      (await entryFor('tenant_field_id_keyeds', created.id))?.tenantId,
    ).toBe('ws-a');
  });

  it('records nothing, and warns, for a claim on a row missing a stored ownership column', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qualified =
      ObjectRegistry.getClassByConstructor(TenantFieldDual)?.qualifiedName ??
      'TenantFieldDual';
    unregisterSource = ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? ['org_id'] : undefined,
    );
    const duals = await TenantFieldDualCollection.create({ db });
    const created = await duals.create({
      name: 'drifted',
      workspaceId: '',
      orgId: 'tenant-a',
    });
    const loaded = await duals.get(String(created.id));
    if (!loaded?.updated_at) throw new Error('expected a persisted row');
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    // The physical column drifts away from the registered ownership field.
    await db.query(`ALTER TABLE ${DUALS} DROP COLUMN org_id`);
    await loaded.claimRevision(loaded.updated_at);

    const { changes } = await getChangesSince(db, { since: before });
    expect(changes.some((change) => change.rowId === created.id)).toBe(false);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('could not be resolved'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });
});

describe('change-feed delete owner on native DuckDB', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['TenantFieldOrg', 'TenantFieldUuidItem'],
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('records a delete under a stored UUID owner', async () => {
    const orgs = await TenantFieldOrgCollection.create({ db });
    const org = await orgs.create({ name: 'org' });
    const items = await TenantFieldUuidItemCollection.create({ db });
    const item = await items.create({
      name: 'owned',
      organizationId: String(org.id),
    });
    item.organizationId = '';
    await item.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === item.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe(org.id);
    const otherTenant = await getChangesSince(db, {
      since: 0,
      tenantId: randomUUID(),
    });
    expect(otherTenant.changes.some((c) => c.rowId === item.id)).toBe(false);
  });

  it('records a delete addressed by a non-canonical UUID spelling under the stored owner', async () => {
    const orgs = await TenantFieldOrgCollection.create({ db });
    const org = await orgs.create({ name: 'org' });
    const items = await TenantFieldUuidItemCollection.create({ db });
    const item = await items.create({
      name: 'owned',
      organizationId: String(org.id),
    });
    const storedId = String(item.id);
    const spelling = storedId.replace(/-/g, '').toUpperCase();
    item.id = spelling;
    item.organizationId = '';
    await item.delete();

    const stored = await db.query(
      'SELECT COUNT(*) AS n FROM tenant_field_uuid_items',
    );
    expect(Number(stored.rows[0]?.n)).toBe(0);
    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === spelling && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe(org.id);
  });
});

describe('deleted-row owners on the JSON adapter', () => {
  it('leaves out an ownership column the table does not have', async () => {
    const db = await getTestDatabase({ type: 'json', classes: [] });
    // The JSON adapter keeps tables across handles; names of its own per run.
    const suffix = randomUUID().replace(/-/g, '');
    const owned = `tenant_field_json_owned_${suffix}`;
    const drifted = `tenant_field_json_drifted_${suffix}`;
    const removeOwners = async (tableName: string) =>
      (
        await deleteSyncRows(
          db,
          { tableName, model: 'TenantFieldJsonRow', ownerColumns: ['org_id'] },
          { id: 'row-1' },
          () => {},
        )
      ).owners;
    try {
      await db.query(
        `CREATE TABLE ${owned} (id VARCHAR PRIMARY KEY, org_id VARCHAR)`,
      );
      await db.query(`CREATE TABLE ${drifted} (id VARCHAR PRIMARY KEY)`);
      await db.insert(owned, { id: 'row-1', org_id: 'a' });
      await db.insert(drifted, { id: 'row-1' });

      expect(await removeOwners(owned)).toStrictEqual([
        { id: 'row-1', columns: { org_id: 'a' } },
      ]);
      expect(await removeOwners(drifted)).toStrictEqual([
        { id: 'row-1', columns: {} },
      ]);
    } finally {
      await db.close?.();
    }
  });
});
