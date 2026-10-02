/**
 * #3288 F3: the time-entry models moved from smrt-projects to smrt-timesheets.
 * References that stored or declared the pre-move qualified class name —
 * a `SmrtPolymorphicAssociation.metaType` of
 * `@happyvertical/smrt-projects:ServiceTimeEntry`, a `@crossPackageRef` by
 * that name — keep resolving to the moved class through the
 * `previousQualifiedNames` aliases smrt-timesheets declares (#3338). New
 * writes store the current `@happyvertical/smrt-timesheets:*` name.
 */
import {
  crossPackageRef,
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  SmrtPolymorphicAssociation,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ServiceChargeSnapshot,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshot,
  ServiceCompensationSnapshotCollection,
  ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '../index.js';

const OLD = (className: string) => `@happyvertical/smrt-projects:${className}`;
const CURRENT = (className: string) =>
  `@happyvertical/smrt-timesheets:${className}`;
const MOVED = [
  'ServiceTimeEntry',
  'ServiceChargeSnapshot',
  'ServiceCompensationSnapshot',
] as const;

@smrt({
  tableName: 'legacy_identity_links',
  conflictColumns: ['owner_id', 'meta_type', 'meta_id', 'role'],
})
class LegacyIdentityLink extends SmrtPolymorphicAssociation {
  @field()
  ownerId = '';
}

@smrt()
class LegacyIdentityLinkCollection extends SmrtCollection<LegacyIdentityLink> {
  static readonly _itemClass = LegacyIdentityLink;
}

/** Consumer source that still declares the reference by the old name. */
@smrt({ tableName: 'legacy_identity_referrers' })
class LegacyIdentityReferrer extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-projects:ServiceTimeEntry', {
    nullable: true,
  })
  timeEntryId: string | null = null;
}

@smrt()
class LegacyIdentityReferrerCollection extends SmrtCollection<LegacyIdentityReferrer> {
  static readonly _itemClass = LegacyIdentityReferrer;
}

describe('pre-#3288 qualified identities of the moved time models', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function seed() {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const entry = await entries.create({
      workRefType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workRefId: 'request-1',
      participantKind: 'agent',
      agentRef: 'agent:builder',
      source: 'agent',
      description: 'Legacy-linked entry',
      durationSeconds: 60,
    });
    await entry.save();
    const charge = await (
      await ServiceChargeSnapshotCollection.create({ db })
    ).create({ timeEntryId: entry.id, amount: 100, currency: 'USD' });
    await charge.save();
    const paid = await (
      await ServiceCompensationSnapshotCollection.create({ db })
    ).create({ timeEntryId: entry.id, amount: 60, currency: 'USD' });
    await paid.save();
    return {
      ServiceTimeEntry: { id: String(entry.id), ctor: ServiceTimeEntry },
      ServiceChargeSnapshot: {
        id: String(charge.id),
        ctor: ServiceChargeSnapshot,
      },
      ServiceCompensationSnapshot: {
        id: String(paid.id),
        ctor: ServiceCompensationSnapshot,
      },
    };
  }

  it('resolves the legacy qualified names in the registry', () => {
    for (const className of MOVED) {
      expect(
        ObjectRegistry.getClassByQualifiedName(OLD(className))?.qualifiedName,
        className,
      ).toBe(CURRENT(className));
      expect(ObjectRegistry.resolveQualifiedName(OLD(className))).toBe(
        CURRENT(className),
      );
    }
  });

  it('hydrates associations stored under the smrt-projects names', async () => {
    const targets = await seed();
    const links = await LegacyIdentityLinkCollection.create({ db });
    for (const className of MOVED) {
      const { id, ctor } = targets[className];
      // A row exactly as written before the move: the old metaType, stored
      // directly (save() would already store the current name).
      const linkId = crypto.randomUUID();
      await db.insert('legacy_identity_links', {
        id: linkId,
        slug: linkId,
        context: '',
        owner_id: 'owner-legacy',
        meta_type: OLD(className),
        meta_id: id,
        role: 'default',
        sort_order: 0,
      });
      const stored = await links.get({ id: linkId });
      expect(stored?.metaType, className).toBe(OLD(className));
      const target = await stored?.hydrate();
      expect(target, className).toBeInstanceOf(ctor);
      expect(target?.id, className).toBe(id);
    }
  });

  it('stores the current name on new writes', async () => {
    const targets = await seed();
    const links = await LegacyIdentityLinkCollection.create({ db });
    for (const className of MOVED) {
      const link = await links.create({
        ownerId: 'owner-new',
        metaType: OLD(className),
        metaId: targets[className].id,
      });
      await link.save();
      expect(link.metaType, className).toBe(CURRENT(className));
      const row = await db.get('legacy_identity_links', { id: link.id });
      expect(row?.meta_type, className).toBe(CURRENT(className));
    }
  });

  it('loads a @crossPackageRef declared by the smrt-projects name', async () => {
    const targets = await seed();
    const referrers = await LegacyIdentityReferrerCollection.create({ db });
    const referrer = await referrers.create({
      timeEntryId: targets.ServiceTimeEntry.id,
    });
    await referrer.save();

    const referrerName = ObjectRegistry.getClassByConstructor(
      LegacyIdentityReferrer as unknown as typeof SmrtObject,
    )?.qualifiedName as string;
    expect(
      ObjectRegistry.resolveRelationshipTarget(referrerName, 'timeEntryId'),
    ).toBe(CURRENT('ServiceTimeEntry'));
    const related = await referrer.loadRelated('timeEntryId');
    expect(related).toBeInstanceOf(ServiceTimeEntry);
    expect((related as ServiceTimeEntry).id).toBe(targets.ServiceTimeEntry.id);
  });
});
