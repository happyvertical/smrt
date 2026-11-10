/**
 * Multi-level STI (Single Table Inheritance) tests
 *
 * Tests that multi-level inheritance hierarchies work correctly with STI,
 * including save operations and field inheritance.
 *
 * Related to issue #332
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field, foreignKey, oneToMany } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { cleanupFileDatabase } from '../testing/file-cleanup';

// Simulate multi-level inheritance like Council → Organization → Profile → SmrtObject
// Using unique class names to avoid collisions with @happyvertical/smrt-profiles (see issue #543)
// STITestProfile is the STI base class
@smrt({ tableStrategy: 'sti' })
class STITestProfile extends SmrtObject {
  @field()
  tenantId: string | null = null;
  @field()
  name: string = '';
  @field()
  bio: string = '';
}

// STITestOrganization extends STITestProfile (middle level)
@smrt()
class STITestOrganization extends STITestProfile {
  @field()
  website: string = '';
  @field({ type: 'integer' })
  foundedYear: number = 0;
}

// STITestCouncil extends STITestOrganization (leaf level)
@smrt()
class STITestCouncil extends STITestOrganization {
  @field()
  meetingsUrl: string = '';
  @field()
  jurisdiction: string = '';
}

// Collection for the STI hierarchy
class STITestProfileCollection extends SmrtCollection<STITestProfile> {
  static readonly _itemClass = STITestProfile;
}

class STITestOrganizationCollection extends SmrtCollection<STITestOrganization> {
  static readonly _itemClass = STITestOrganization;
}

@smrt()
class STITestPerson extends STITestProfile {
  @oneToMany('STITestAbstractOrganization')
  organizations: STITestAbstractOrganization[] = [];
}

class STITestPersonCollection extends SmrtCollection<STITestPerson> {
  static readonly _itemClass = STITestPerson;
}

@smrt({ abstract: true })
abstract class STITestAbstractOrganization extends STITestProfile {
  @foreignKey('STITestPerson')
  personId: string | null = null;
}

@smrt()
class STITestConcreteOrganization extends STITestAbstractOrganization {}

class STITestAbstractOrganizationCollection extends SmrtCollection<STITestAbstractOrganization> {
  static readonly _itemClass = STITestAbstractOrganization;
}

@smrt()
class STITestOrganizationInvoice extends SmrtObject {
  @field()
  tenantId: string | null = null;
  @foreignKey('STITestAbstractOrganization', { validateSubtype: true })
  organizationId: string = '';
}

class STITestOrganizationInvoiceCollection extends SmrtCollection<STITestOrganizationInvoice> {
  static readonly _itemClass = STITestOrganizationInvoice;
}

@smrt()
class STITestOrganizationExpense extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:STITestAbstractOrganization', {
    validateSubtype: true,
  })
  commitmentId: string = '';
}

class STITestOrganizationExpenseCollection extends SmrtCollection<STITestOrganizationExpense> {
  static readonly _itemClass = STITestOrganizationExpense;
}

@smrt()
class STITestUnloadedSubtypeReference extends SmrtObject {
  @crossPackageRef('@missing-3898/pkg:MissingOrganization', {
    validateSubtype: true,
  })
  organizationId: string = '';
}

class STITestUnloadedSubtypeReferenceCollection extends SmrtCollection<STITestUnloadedSubtypeReference> {
  static readonly _itemClass = STITestUnloadedSubtypeReference;
}

describe('Multi-Level STI Save Operations', () => {
  it('rejects an unregistered STI intermediate', () => {
    @smrt({ tableStrategy: 'sti' })
    class STITestGuardRoot extends SmrtObject {}
    class STITestUndecoratedMiddle extends STITestGuardRoot {}
    class STITestGuardLeaf extends STITestUndecoratedMiddle {}
    expect(() => ObjectRegistry.register(STITestGuardLeaf)).toThrow(
      'unregistered direct parent',
    );
  });

  let db: DatabaseInterface;
  let dbPath: string;
  let profiles: STITestProfileCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `test-sti-multilevel-${randomUUID().slice(0, 8)}.db`,
    );
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
    profiles = await STITestProfileCollection.create({ db });
  });

  afterEach(async () => {
    await cleanupFileDatabase(db, dbPath);
  });

  describe('Save operations', () => {
    it('fails closed when a typed cross-package target cannot load', async () => {
      const references = await STITestUnloadedSubtypeReferenceCollection.create(
        {
          db,
        },
      );
      await expect(
        references.create({ organizationId: 'missing-target' }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_STI_REFERENCE_TARGET_UNAVAILABLE',
      });
    });

    it('should save STITestProfile (base class) successfully', async () => {
      const profile = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestProfile',
        name: 'John Doe',
        bio: 'Software developer',
      });

      await expect(profile.save()).resolves.not.toThrow();
      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('John Doe');
      expect(profile.bio).toBe('Software developer');
    });

    it('should save STITestOrganization (middle level) successfully', async () => {
      const org = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestOrganization',
        name: 'Acme Corp',
        bio: 'We make everything',
        website: 'https://acme.com',
        foundedYear: 1920,
      });

      await expect(org.save()).resolves.not.toThrow();
      expect(org.id).toBeDefined();
      expect(org.name).toBe('Acme Corp');
      expect(org.bio).toBe('We make everything');
      expect((org as any).website).toBe('https://acme.com');
      expect((org as any).foundedYear).toBe(1920);
    });

    it('should save STITestCouncil (leaf level) successfully', async () => {
      const council = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestCouncil',
        name: 'Springfield City Council',
        bio: 'Municipal government',
        website: 'https://springfield.gov',
        foundedYear: 1850,
        meetingsUrl: 'https://springfield.gov/meetings',
        jurisdiction: 'Springfield, IL',
      });

      // This is the failing case from issue #332
      await expect(council.save()).resolves.not.toThrow();
      expect(council.id).toBeDefined();
      expect(council.name).toBe('Springfield City Council');
      expect(council.bio).toBe('Municipal government');
      expect((council as any).website).toBe('https://springfield.gov');
      expect((council as any).foundedYear).toBe(1850);
      expect((council as any).meetingsUrl).toBe(
        'https://springfield.gov/meetings',
      );
      expect((council as any).jurisdiction).toBe('Springfield, IL');
    });

    it('should load STITestCouncil from database with all inherited fields', async () => {
      // Create and save
      const council = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestCouncil',
        name: 'Springfield City Council',
        bio: 'Municipal government',
        website: 'https://springfield.gov',
        foundedYear: 1850,
        meetingsUrl: 'https://springfield.gov/meetings',
        jurisdiction: 'Springfield, IL',
      });
      await council.save();
      const savedId = council.id;

      // Load from database
      const loaded = await profiles.get({ id: savedId });

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe(savedId);
      expect(loaded?.name).toBe('Springfield City Council');
      expect(loaded?.bio).toBe('Municipal government');
      expect((loaded as any).website).toBe('https://springfield.gov');
      expect((loaded as any).foundedYear).toBe(1850);
      expect((loaded as any).meetingsUrl).toBe(
        'https://springfield.gov/meetings',
      );
      expect((loaded as any).jurisdiction).toBe('Springfield, IL');
    });
  });

  describe('Polymorphic queries', () => {
    it('loads descendant rows through a relation targeting the intermediate class', async () => {
      const person = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestPerson',
      });
      const organization = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestConcreteOrganization',
        personId: person.id,
      });
      const related = await person.loadRelatedMany('organizations');
      expect(related.map((item) => item.id)).toEqual([organization.id]);

      const people = await STITestPersonCollection.create({ db });
      const latest = await people.listWithLatestRelated({
        latestRelated: {
          relation: 'organizations',
          select: ['id'],
          orderBy: 'created_at DESC',
        },
      });
      expect(latest[0].latestRelated?.id).toBe(organization.id);
    });

    it('rejects a sibling row referenced through an intermediate STI foreign key', async () => {
      const person = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestPerson',
      });
      const organization = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestConcreteOrganization',
        tenantId: 'tenant-a',
      });
      const invoices = await STITestOrganizationInvoiceCollection.create({
        db,
      });
      await expect(
        invoices.create({ organizationId: String(person.id) }),
      ).rejects.toThrow('must reference');
      const expenses = await STITestOrganizationExpenseCollection.create({
        db,
      });
      await expect(
        expenses.create({ commitmentId: String(person.id) }),
      ).rejects.toThrow('must reference');
      const invoice = await invoices.create({
        tenantId: 'tenant-a',
        organizationId: String(organization.id),
      });
      expect(invoice).toBeInstanceOf(STITestOrganizationInvoice);
      await expect(
        invoices.create({
          tenantId: 'tenant-b',
          organizationId: String(organization.id),
        }),
      ).rejects.toThrow('must reference');
      await db.query(
        `UPDATE ${invoices.tableName} SET organization_id = ? WHERE id = ?`,
        person.id,
        invoice.id,
      );
      const corrupt = await invoices.get({ id: invoice.id }, { cache: false });
      await expect(corrupt?.loadRelated('organizationId')).rejects.toThrow(
        'points to',
      );
    });

    it('rejects abstract discriminators but permits concrete leaves through the abstract collection', async () => {
      const organizations = await STITestAbstractOrganizationCollection.create({
        db,
      });
      await expect(organizations.create({})).rejects.toThrow('abstract model');
      await expect(
        profiles.create({
          _meta_type: '@happyvertical/smrt-core:STITestAbstractOrganization',
        }),
      ).rejects.toThrow('abstract model');
      const concrete = await organizations.create({
        _meta_type: '@happyvertical/smrt-core:STITestConcreteOrganization',
      });
      expect(concrete).toBeInstanceOf(STITestConcreteOrganization);
    });

    it('reads descendants through an intermediate collection without sibling rows', async () => {
      const organization = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestOrganization',
        name: 'Organization',
      });
      const council = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestCouncil',
        name: 'Council',
      });
      await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestPerson',
        name: 'Person',
      });
      const organizations = await STITestOrganizationCollection.create({ db });

      expect(
        (await organizations.list()).map((item) => item.id).sort(),
      ).toEqual([organization.id, council.id].sort());
      expect(await organizations.get({ id: council.id })).toBeInstanceOf(
        STITestCouncil,
      );
      expect(await organizations.get({ id: organization.id })).toBeInstanceOf(
        STITestOrganization,
      );
    });

    it('should list mixed types in one query', async () => {
      // Create one of each type
      const profile = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestProfile',
        name: 'John Doe',
        bio: 'Developer',
      });
      await profile.save();

      const org = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestOrganization',
        name: 'Acme Corp',
        bio: 'Company',
        website: 'https://acme.com',
        foundedYear: 1920,
      });
      await org.save();

      const council = await profiles.create({
        _meta_type: '@happyvertical/smrt-core:STITestCouncil',
        name: 'Springfield Council',
        bio: 'Government',
        website: 'https://springfield.gov',
        foundedYear: 1850,
        meetingsUrl: 'https://springfield.gov/meetings',
        jurisdiction: 'Springfield',
      });
      await council.save();

      // List all
      const all = await profiles.list({});

      expect(all).toHaveLength(3);
      expect(all.map((p) => p.name)).toContain('John Doe');
      expect(all.map((p) => p.name)).toContain('Acme Corp');
      expect(all.map((p) => p.name)).toContain('Springfield Council');
    });

    it('should filter by discriminator type', async () => {
      // Create one of each type
      await (
        await profiles.create({
          _meta_type: '@happyvertical/smrt-core:STITestProfile',
          name: 'John',
          bio: 'Developer',
        })
      ).save();
      await (
        await profiles.create({
          _meta_type: '@happyvertical/smrt-core:STITestOrganization',
          name: 'Acme',
          bio: 'Company',
          website: 'https://acme.com',
        })
      ).save();
      await (
        await profiles.create({
          _meta_type: '@happyvertical/smrt-core:STITestCouncil',
          name: 'Springfield',
          bio: 'Government',
          meetingsUrl: 'https://gov.com/meetings',
          jurisdiction: 'Springfield, IL',
        })
      ).save();

      // Filter by type
      const councils = await profiles.list({
        where: { _meta_type: '@happyvertical/smrt-core:STITestCouncil' },
      });

      expect(councils).toHaveLength(1);
      expect(councils[0].name).toBe('Springfield');
    });
  });
});
