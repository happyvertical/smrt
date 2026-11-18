/**
 * The change feed records each change under the tenant its row belongs to,
 * read from the class's real ownership field — a declared custom tenant
 * field, or a runtime ownership registration such as the tenancy package's
 * `{ field: 'organizationId' }` — not only a `tenantId` property. An entry
 * recorded as global is served to every tenant.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
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

const PROJECTS = 'tenant_field_projects';
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
});
