import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  generateSchemaDiff,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import {
  getDDLStrategy,
  planForeignKeyCreation,
} from '@happyvertical/smrt-core/schema';
import { Person, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import { LearnerCollection } from '../collections.js';
import { WorkbookPhotoService } from '../workbook-photo-service.js';
import { familyClasses } from './family-intake-workflows.js';

export function familyMigrationTests(
  engine: 'sqlite' | 'postgres',
  factory: (schema: string) => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
    restart: () => Promise<DatabaseInterface>;
  }>,
) {
  it('upgrades existing photo originals and history to family ownership schemas without data loss or parity drift', async () => {
    const merged = ObjectRegistry.getAllSchemasAsDefinitions();
    const selectedTables = new Set(
      [...familyClasses, 'Folder'].map(
        (name) => ObjectRegistry.getSchema(name)?.tableName,
      ),
    );
    // This upgrade targets application schemas; system job bootstrap is separate.
    const current = structuredClone(
      Object.fromEntries(
        Object.entries(merged).filter(
          ([table]) => selectedTables.has(table) && !table.startsWith('_smrt_'),
        ),
      ),
    );
    const old = structuredClone(current);
    for (const table of [
      'family_intakes',
      'family_intake_assets',
      'family_intake_decisions',
    ])
      delete old[table];
    delete old.workbook_photo_intakes.columns.family_intake_id;
    old.workbook_photo_intakes.indexes =
      old.workbook_photo_intakes.indexes.filter(
        (index) => !JSON.stringify(index).includes('family_intake_id'),
      );
    old.workbook_photo_intakes.foreignKeys =
      old.workbook_photo_intakes.foreignKeys?.filter(
        (key) => !JSON.stringify(key).includes('family_intake_id'),
      );
    const strategy = getDDLStrategy(engine);
    const plan = planForeignKeyCreation(Object.values(old), engine);
    const schema = plan.schemas
      .flatMap((table) => [
        strategy.generateCreateTable(table),
        ...strategy.generateIndexes(table),
      ])
      .concat(plan.deferredStatements)
      .join(';\n');
    const isolated = await factory(schema);
    const db = isolated.db;
    const storage = await mkdtemp(join(tmpdir(), 'family-migration-'));
    let restartedDb: DatabaseInterface | undefined;
    try {
      const insert = async (table: string, record: Record<string, unknown>) => {
        await db.query(
          `INSERT INTO ${table} (${Object.keys(record).join(',')}) VALUES (${Object.keys(
            record,
          )
            .map(() => '?')
            .join(',')})`,
          Object.values(record),
        );
      };
      const tenant = await (await TenantCollection.create({ db })).create({
        name: `Migration family ${randomUUID()}`,
      });
      const role = await (await RoleCollection.create({ db })).create({
        name: `Migration member ${randomUUID()}`,
      });
      const profileType = await (
        await ProfileTypeCollection.create({ db })
      ).create({ name: 'Person', slug: 'person' });
      const profile = new Person({
        db,
        name: 'Existing learner',
        typeId: String(profileType.id),
      });
      await profile.initialize();
      await profile.save();
      const user = await (await UserCollection.create({ db })).create({
        profileId: String(profile.id),
        email: '',
      });
      const tenantId = String(tenant.id),
        actorUserId = String(user.id);
      await (await MembershipCollection.create({ db })).create({
        tenantId,
        userId: actorUserId,
        roleId: String(role.id),
        status: MembershipStatus.ACTIVE,
      });
      const learner = await withTenant(
        { tenantId, userId: actorUserId },
        async () =>
          (await LearnerCollection.create({ db })).create({
            tenantId,
            userId: actorUserId,
            profileId: String(profile.id),
            displayName: 'Existing learner',
          }),
      );
      const parent = { tenantId, actorUserId, learnerId: String(learner.id) };
      const f = {
        parent,
        alice: { profile },
        as: <T>(_request: typeof parent, action: () => Promise<T>) =>
          withTenant({ tenantId, userId: actorUserId }, action),
      };

      const bytes = Buffer.from('existing original before family upgrade');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const asset = {
        id: randomUUID(),
        sourceUri: `file://${join(storage, 'original.png')}`,
      };
      await writeFile(join(storage, 'original.png'), bytes);
      await insert('assets', {
        id: asset.id,
        slug: asset.id,
        context: '',
        tenant_id: f.parent.tenantId,
        name: 'original.png',
        _meta_type: '@happyvertical/smrt-assets:Asset',
        access_mode: 'private',
        owner_profile_id: String(f.alice.profile.id),
        mime_type: 'image/png',
        source_uri: asset.sourceUri,
      });
      const photoId = randomUUID(),
        linkId = randomUUID(),
        decisionId = randomUUID();
      await insert('workbook_photo_intakes', {
        id: photoId,
        slug: photoId,
        context: '',
        tenant_id: f.parent.tenantId,
        learner_id: f.parent.learnerId,
        item_id: 'pre-family-receipt',
        actor_user_id: f.parent.actorUserId,
        content_digest: hash,
      });
      await insert('workbook_photo_assets', {
        id: linkId,
        slug: linkId,
        context: '',
        tenant_id: f.parent.tenantId,
        learner_id: f.parent.learnerId,
        intake_id: photoId,
        asset_id: asset.id,
        name: 'original.png',
        mime_type: 'image/png',
        sha256: hash,
        position: 0,
      });
      await insert('workbook_photo_decisions', {
        id: decisionId,
        slug: decisionId,
        context: '',
        tenant_id: f.parent.tenantId,
        learner_id: f.parent.learnerId,
        intake_id: photoId,
        request_key: 'original-history',
        sequence: 1,
        actor_user_id: f.parent.actorUserId,
        body_json:
          '{"type":"resolve","identification":{"kind":"reference","workState":"unknown"},"activity":null}',
      });
      const before = await generateSchemaDiff(db, current, {
        engineHint: engine,
      });
      expect(
        before.added_tables.map((table) => table.tableName).sort(),
      ).toEqual([
        'family_intake_assets',
        'family_intake_decisions',
        'family_intakes',
      ]);
      expect(
        before.changes.some(
          (change) =>
            change.table === 'workbook_photo_intakes' &&
            change.type === 'add_column' &&
            change.name === 'family_intake_id',
        ),
      ).toBe(true);
      const generated = new MigrationGenerator({ engine }).generateFromDiff(
        before,
        { name: 'family_intake_upgrade' },
      );
      const migration = createMigrationDefinition(
        '20261028_family_intake_upgrade',
        generated.up,
        generated.down,
        { packageName: '@happyvertical/smrt-education', version: '0.57.37' },
      );
      const applied = await new MigrationTracker({
        db,
        engineHint: engine,
        useConcurrentIndexes: false,
      }).applyAll([migration], { postgresSafe: false });
      expect(applied.every((result) => result.success)).toBe(true);
      expect(
        (
          await db.query('SELECT * FROM workbook_photo_intakes WHERE id=?', [
            photoId,
          ])
        ).rows[0],
      ).toMatchObject({
        item_id: 'pre-family-receipt',
        family_intake_id: null,
        content_digest: hash,
      });
      expect(
        await db.get('workbook_photo_assets', { id: linkId }),
      ).toMatchObject({ asset_id: asset.id, sha256: hash });
      expect(
        await db.get('workbook_photo_decisions', { id: decisionId }),
      ).toMatchObject({
        request_key: 'original-history',
        body_json:
          '{"type":"resolve","identification":{"kind":"reference","workState":"unknown"},"activity":null}',
      });
      expect(
        Number(
          (await db.get('workbook_photo_decisions', { id: decisionId }))
            ?.sequence,
        ),
      ).toBe(1);
      expect(await readFile(join(storage, 'original.png'))).toEqual(bytes);
      expect(await db.get('assets', { id: asset.id })).toMatchObject({
        source_uri: asset.sourceUri,
      });
      const parity = await generateSchemaDiff(db, current, {
        engineHint: engine,
      });
      expect(parity.added_tables).toEqual([]);
      expect(parity.changes).toEqual([]);
      restartedDb = await isolated.restart();
      const fresh = new WorkbookPhotoService(
        restartedDb,
        ({ own }) => own,
        () => true,
        { storage },
      );
      const request = { ...f.parent, intakeId: photoId };
      const reloaded = await f.as(f.parent, () =>
        fresh.getWorkbookPhotoIntake(request),
      );
      expect(reloaded.identification).toEqual({
        kind: 'reference',
        workState: 'unknown',
      });
      expect(reloaded.originals[0]).toMatchObject({
        assetId: asset.id,
        sha256: hash,
      });
      expect(
        Buffer.from(
          (
            await f.as(f.parent, () =>
              fresh.readWorkbookPhotoOriginal({
                ...request,
                assetId: asset.id,
              }),
            )
          ).data,
        ),
      ).toEqual(bytes);
    } finally {
      await restartedDb?.close?.();
      await isolated.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  });
}
