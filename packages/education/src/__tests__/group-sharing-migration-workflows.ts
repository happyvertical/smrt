import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { SchemaManager } from '@happyvertical/smrt-core/schema';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import {
  EducationGroupCollection,
  GroupLearnerMembershipCollection,
  GroupSharingPolicyCollection,
} from '../group-sharing-models.js';
import { WorkbookService } from '../workbook-service.js';
import { sharingPolicy } from './group-sharing-read-workflows.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

/** Factories must initialize this old schema, excluding every sharing table. */
export const groupSharingMigrationBaseClasses = workbookClasses;
const sharingClasses = [
  'EducationGroup',
  'GroupLearnerInvitation',
  'GroupLearnerMembership',
  'GroupSharingPolicy',
  'GroupRevisionComment',
  'GroupLearnerRosterEntry',
];
export type GroupSharingMigrationFactory = () => Promise<{
  db: DatabaseInterface;
  cleanup: () => Promise<void>;
}>;

/** Runs identically against an existing family SQLite or PostgreSQL database. */
export function groupSharingMigrationContractTests(
  make: GroupSharingMigrationFactory,
): void {
  it('upgrades existing family/workbook history through explicit structured schema migration', async () => {
    const handle = await make();
    const storage = await mkdtemp(join(tmpdir(), 'group-sharing-migration-'));
    try {
      const { db } = handle;
      const schemas = sharingClasses.map((name) => {
        const schema = ObjectRegistry.getSchema(name);
        if (!schema) throw new Error(`Missing generated schema for ${name}`);
        return schema;
      });
      for (const schema of schemas)
        expect(await db.tableExists(schema.tableName)).toBe(false);
      const f = await learnerFixture(db);
      const workbook = new WorkbookService(
        db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === f.guardianType.id,
        () => true,
        { storage },
      );
      const activity = await f.as(f.parent, () =>
        workbook.resolveWorkbookActivity({
          ...f.parent,
          workbookKey: 'pre-sharing-history',
          title: 'Existing family workbook',
          pageKey: 'p1',
          pageLabel: '1',
        }),
      );
      const attempt = await f.as(f.own, () =>
        workbook.captureWorkbookWork({
          ...f.own,
          activityId: activity.id,
          requestKey: 'before-migration',
          intakeItemId: 'old-capture',
          pages: [
            {
              name: 'old.png',
              mimeType: 'image/png',
              data: Buffer.from(
                'synthetic retained child work before group sharing migration',
              ),
            },
          ],
          assistance: 'independent',
        }),
      );
      const selectors = [
        [
          'learners',
          { id: String(f.learner.id), tenant_id: f.parent.tenantId },
        ],
        [
          'workbook_activities',
          { id: activity.id, tenant_id: f.parent.tenantId },
        ],
        ['workbook_attempts', { id: attempt.id, tenant_id: f.parent.tenantId }],
        [
          'submissions',
          { id: attempt.submissionId, tenant_id: f.parent.tenantId },
        ],
      ] as const;
      const before = await Promise.all(
        selectors.map(([table, where]) => db.get(table, where)),
      );
      for (const row of before) expect(row).toBeTruthy();
      expect(before[2]).toMatchObject({
        activity_id: activity.id,
        submission_id: attempt.submissionId,
      });

      // Ordinary collection setup is a runtime consumer and must not migrate.
      const missingGroups = await EducationGroupCollection.create({ db });
      await expect(
        f.as(f.parent, () =>
          missingGroups.list({ where: { tenantId: f.parent.tenantId } }),
        ),
      ).rejects.toThrow();
      for (const schema of schemas)
        expect(await db.tableExists(schema.tableName)).toBe(false);

      // This explicit deployment phase is the owning public additive schema API.
      const manager = new SchemaManager(db);
      await manager.ensureTables(schemas as SchemaDefinition[]);
      for (const schema of schemas)
        expect(await db.tableExists(schema.tableName)).toBe(true);
      expect(
        await Promise.all(
          selectors.map(([table, where]) => db.get(table, where)),
        ),
      ).toEqual(before);
      // A second deployment is idempotent and preserves immutable history too.
      await manager.ensureTables(schemas as SchemaDefinition[]);
      expect(
        await Promise.all(
          selectors.map(([table, where]) => db.get(table, where)),
        ),
      ).toEqual(before);

      const group = await withTenant(
        { tenantId: String(f.foreign.tenantId), userId: f.parent.actorUserId },
        async () =>
          (await EducationGroupCollection.create({ db })).create({
            tenantId: f.foreign.tenantId,
            name: 'New independent group',
            creatorUserId: f.parent.actorUserId,
            creatorProfileId: String(f.guardian.profile.id),
            _insertOnly: true,
          }),
      );
      await f.as(f.parent, async () => {
        const edges = await GroupLearnerMembershipCollection.create({ db });
        const input = {
          tenantId: f.parent.tenantId,
          groupId: String(group.id),
          learnerId: String(f.learner.id),
          consentParentUserId: f.parent.actorUserId,
          policyVersion: 1,
          _insertOnly: true,
        };
        const edge = await edges.create(input);
        await expect(edges.create(input)).rejects.toThrow();
        const policies = await GroupSharingPolicyCollection.create({ db });
        const snapshot = {
          tenantId: f.parent.tenantId,
          membershipId: String(edge.id),
          version: 1,
          actorUserId: f.parent.actorUserId,
          policyJson: JSON.stringify(sharingPolicy()),
          _insertOnly: true,
        };
        await policies.create(snapshot);
        await expect(policies.create(snapshot)).rejects.toThrow();
      });
      expect(
        await Promise.all(
          selectors.map(([table, where]) => db.get(table, where)),
        ),
      ).toEqual(before);
    } finally {
      await rm(storage, { recursive: true, force: true });
      await handle.cleanup();
    }
  });
}
