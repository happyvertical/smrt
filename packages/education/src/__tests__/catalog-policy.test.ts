import { describe, expect, it } from 'vitest';
import type { CatalogSourceRecord } from '../catalog-contracts.js';
import { CatalogPolicy } from '../catalog-policy.js';

const resource = (
  overrides: Partial<CatalogSourceRecord> = {},
): CatalogSourceRecord => ({
  providerId: 'oer',
  stableId: 'resource',
  revision: '1',
  canonicalUrl: 'https://example.test',
  title: 'Resource',
  visibility: 'catalog',
  availableFormats: ['pdf'],
  licenseEvidence: {
    state: 'verified',
    identifier: 'CC-BY-4.0',
    permittedOperations: ['download', 'print'],
  },
  ...overrides,
});
const guardian = {
  tenantId: 'tenant',
  actorUserId: 'guardian',
  roles: ['guardian'],
};

describe('CatalogPolicy', () => {
  it('requires resource-level verified evidence for each operation', () => {
    const policy = new CatalogPolicy();
    expect(policy.authorize(resource(), 'print', guardian)).toEqual({
      allowed: true,
    });
    expect(policy.authorize(resource(), 'adapt', guardian)).toMatchObject({
      allowed: false,
      reason: 'operation-not-permitted',
    });
    expect(
      policy.authorize(
        resource({ licenseEvidence: { state: 'unknown' } }),
        'print',
        guardian,
      ),
    ).toMatchObject({ allowed: false, reason: 'unverified-license' });
    expect(
      policy.authorize(
        resource({
          licenseEvidence: { state: 'conflicting', identifier: 'CC-BY' },
        }),
        'print',
        guardian,
      ),
    ).toMatchObject({ allowed: false, reason: 'unverified-license' });
  });

  it('withholds teacher-only resource metadata from non-teachers', () => {
    const policy = new CatalogPolicy();
    const teacherOnly = resource({ visibility: 'teacher' });
    expect(policy.canView(teacherOnly, guardian)).toBe(false);
    expect(policy.authorize(teacherOnly, 'print', guardian)).toMatchObject({
      allowed: false,
      reason: 'teacher-material',
    });
    expect(
      policy.canView(teacherOnly, { ...guardian, roles: ['teacher'] }),
    ).toBe(true);
  });
});
