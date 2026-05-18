/**
 * Cross-package reference (`@crossPackageRef`) tests (R1).
 *
 * Cross-package refs are plain TEXT columns at the database level — no FK
 * constraint — but carry registry metadata so that `loadRelated()`, eager
 * loading via `include`, and optional save-time existence validation can work
 * across package boundaries without requiring a hard import of the target class.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crossPackageRef, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';
import { getTestDatabase } from '../testing/database';

// Target class — pretend it lives in another package
@smrt({ packageName: '@happyvertical/smrt-test-target' })
class XPRefTargetProfile extends SmrtObject {
  displayName: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.displayName) this.displayName = options.displayName;
  }
}

// Source class — references the target via @crossPackageRef
@smrt()
class XPRefSourceCustomer extends SmrtObject {
  name: string = '';

  @crossPackageRef('@happyvertical/smrt-test-target:XPRefTargetProfile')
  profileId: string = '';

  // Same target, but opts into save-time validation
  @crossPackageRef('@happyvertical/smrt-test-target:XPRefTargetProfile', {
    validate: true,
  })
  primaryContactId: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.profileId) this.profileId = options.profileId;
    if (options.primaryContactId)
      this.primaryContactId = options.primaryContactId;
  }
}

describe('@crossPackageRef (R1)', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-xpkg-ref-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Field registration', () => {
    it('registers crossPackageRef fields in the relationship map', () => {
      const relationships = ObjectRegistry.getRelationships(
        'XPRefSourceCustomer',
      );

      const profileRel = relationships.find((r) => r.fieldName === 'profileId');
      expect(profileRel).toBeDefined();
      expect(profileRel?.type).toBe('crossPackageRef');
      expect(profileRel?.targetClass).toBe(
        '@happyvertical/smrt-test-target:XPRefTargetProfile',
      );

      const contactRel = relationships.find(
        (r) => r.fieldName === 'primaryContactId',
      );
      expect(contactRel).toBeDefined();
      expect(contactRel?.type).toBe('crossPackageRef');
    });

    it('emits a plain TEXT column with no FK constraint', async () => {
      // Initialize collection so the schema is materialized
      await ObjectRegistry.getCollection<typeof XPRefSourceCustomer.prototype>(
        'XPRefSourceCustomer',
        { db },
      );

      const tableInfo = await db.query(
        "PRAGMA table_info('xpref_source_customers')",
        [],
      );
      const fkInfo = await db.query(
        "PRAGMA foreign_key_list('xpref_source_customers')",
        [],
      );

      const profileColumn = tableInfo.rows.find(
        (row: any) => row.name === 'profile_id',
      );
      expect(profileColumn).toBeDefined();
      expect(profileColumn?.type).toBe('TEXT');

      // No FK constraint should be emitted for crossPackageRef columns
      const profileFk = fkInfo.rows.find(
        (row: any) => row.from === 'profile_id',
      );
      const contactFk = fkInfo.rows.find(
        (row: any) => row.from === 'primary_contact_id',
      );
      expect(profileFk).toBeUndefined();
      expect(contactFk).toBeUndefined();
    });
  });

  describe('Save-time validation', () => {
    it('saves without checking when validate flag is not set', async () => {
      const customer = new XPRefSourceCustomer({
        name: 'Alpha',
        profileId: 'bogus-id-that-does-not-exist',
        db,
      });
      await customer.initialize();

      // No throw — profileId field has no validate flag
      await expect(customer.save()).resolves.toBeDefined();
    });

    it('saves cleanly when validate=true field is empty', async () => {
      const customer = new XPRefSourceCustomer({
        name: 'Beta',
        db,
      });
      await customer.initialize();

      // primaryContactId is empty — validation skips empty values
      await expect(customer.save()).resolves.toBeDefined();
    });

    it('saves cleanly when validate=true target row exists', async () => {
      const target = new XPRefTargetProfile({
        displayName: 'Real Profile',
        db,
      });
      await target.initialize();
      await target.save();

      const customer = new XPRefSourceCustomer({
        name: 'Gamma',
        primaryContactId: target.id,
        db,
      });
      await customer.initialize();
      await expect(customer.save()).resolves.toBeDefined();
    });

    it('throws ValidationError when validate=true target row is missing', async () => {
      const customer = new XPRefSourceCustomer({
        name: 'Delta',
        primaryContactId: 'definitely-not-a-real-id',
        db,
      });
      await customer.initialize();

      await expect(customer.save()).rejects.toThrow(
        /crossPackageRef validation failed/,
      );
    });
  });

  describe('Runtime loadRelated', () => {
    it('resolves the target instance for a crossPackageRef field', async () => {
      const target = new XPRefTargetProfile({
        displayName: 'Loaded Profile',
        db,
      });
      await target.initialize();
      await target.save();

      const customer = new XPRefSourceCustomer({
        name: 'Epsilon',
        profileId: target.id,
        db,
      });
      await customer.initialize();
      await customer.save();

      const loaded = (await customer.loadRelated(
        'profileId',
      )) as XPRefTargetProfile | null;
      expect(loaded).toBeDefined();
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(target.id);
      expect(loaded?.displayName).toBe('Loaded Profile');
    });

    it('returns null when the FK value is empty', async () => {
      const customer = new XPRefSourceCustomer({
        name: 'Zeta',
        db,
      });
      await customer.initialize();
      await customer.save();

      const loaded = await customer.loadRelated('profileId');
      expect(loaded).toBeNull();
    });
  });
});
