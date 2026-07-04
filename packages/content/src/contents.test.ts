import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contents } from './contents';
import {
  ContentGovernanceAssignmentCollection,
  ContentGovernancePolicyCollection,
  ContentGovernanceProfileCollection,
  configureContentGovernance,
  resetContentGovernanceConfig,
} from './index';

const CONTENT_REFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_references (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  source_id TEXT,
  target_id TEXT,
  target_version INTEGER
);
CREATE INDEX IF NOT EXISTS content_references_id_idx ON content_references (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_references_source_id_target_id_idx ON content_references (source_id, target_id);
`;

const CONTENT_VERSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT DEFAULT 'manual',
  title TEXT,
  description TEXT,
  body TEXT,
  status TEXT,
  summary TEXT,
  snapshot TEXT,
  metadata TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS content_versions_id_idx ON content_versions (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_versions_content_id_version_idx ON content_versions (content_id, version);
`;

const CONTENT_REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  content_version_id TEXT,
  kind TEXT,
  policy_key TEXT,
  status TEXT,
  summary TEXT,
  findings TEXT,
  reviewer TEXT,
  metadata TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS content_reviews_id_idx ON content_reviews (id);
`;

const CONTENT_CORRECTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_corrections (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  content_version_id TEXT,
  fact_id TEXT,
  replacement_fact_id TEXT,
  correction_type TEXT,
  status TEXT,
  summary TEXT,
  incorrect_text TEXT,
  corrected_text TEXT,
  public_note TEXT,
  metadata TEXT,
  tenant_id TEXT,
  published_at DATETIME
);
CREATE INDEX IF NOT EXISTS content_corrections_id_idx ON content_corrections (id);
`;

const GOVERNANCE_POLICIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_governance_policies (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  kind TEXT,
  instructions TEXT,
  enabled BOOLEAN,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_governance_policies_id_idx ON content_governance_policies (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_governance_policies_key_idx ON content_governance_policies (key);
`;

const GOVERNANCE_PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_governance_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  description TEXT,
  enabled BOOLEAN,
  requirements TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_governance_profiles_id_idx ON content_governance_profiles (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_governance_profiles_key_idx ON content_governance_profiles (key);
`;

const GOVERNANCE_ASSIGNMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_governance_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  content_type TEXT NOT NULL,
  content_variant TEXT,
  enabled BOOLEAN,
  fact_linking_enabled BOOLEAN,
  transparency_enabled BOOLEAN,
  publication_profile_key TEXT,
  correction_profile_key TEXT,
  enforce_publish_readiness BOOLEAN,
  default_fact_relationship TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_governance_assignments_id_idx ON content_governance_assignments (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_governance_assignments_key_idx ON content_governance_assignments (key);
`;

describe('Contents', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({
      tenantId: 'test-tenant',
      db,
    });
    await syncSchema({ db, schema: CONTENT_REFERENCES_SCHEMA });
    await syncSchema({ db, schema: CONTENT_VERSIONS_SCHEMA });
    await syncSchema({ db, schema: CONTENT_REVIEWS_SCHEMA });
    await syncSchema({ db, schema: CONTENT_CORRECTIONS_SCHEMA });
  });

  afterEach(async () => {
    resetContentGovernanceConfig();
    if (db && typeof (db as any).close === 'function') {
      await (db as any).close();
    }
  });

  it('looks up published content by slug', async () => {
    const created = await contents.create({
      name: 'Bridge update',
      title: 'Bridge update',
      slug: 'bridge-update',
      status: 'published',
      tenantId: 'test-tenant',
    } as any);

    const result = await contents.getBySlug({
      slug: created.slug,
      status: 'published',
    });

    expect(result).toMatchObject({
      id: created.id,
      slug: 'bridge-update',
      status: 'published',
      title: 'Bridge update',
    });
  });

  it('returns null when the status filter does not match', async () => {
    await contents.create({
      name: 'Draft bridge update',
      title: 'Draft bridge update',
      slug: 'draft-bridge-update',
      status: 'draft',
      tenantId: 'test-tenant',
    } as any);

    const result = await contents.getBySlug({
      slug: 'draft-bridge-update',
      status: 'published',
    });

    expect(result).toBeNull();
  });

  it('returns effective governance definitions with persisted override ids', async () => {
    await syncSchema({ db, schema: GOVERNANCE_POLICIES_SCHEMA });
    await syncSchema({ db, schema: GOVERNANCE_PROFILES_SCHEMA });
    await syncSchema({ db, schema: GOVERNANCE_ASSIGNMENTS_SCHEMA });

    configureContentGovernance({
      policies: [
        {
          key: 'editorial',
          label: 'Editorial Review',
          kind: 'custom',
          instructions: 'Check tone and style.',
        },
      ],
      profiles: [
        {
          key: 'publication',
          label: 'Publication',
          requirements: [{ policyKey: 'editorial', blocking: true }],
        },
      ],
      assignments: [
        {
          contentType: 'article',
          enabled: true,
          publicationProfileKey: 'publication',
        },
      ],
    });

    const policies = await ContentGovernancePolicyCollection.create({ db });
    const profiles = await ContentGovernanceProfileCollection.create({ db });
    const assignments = await ContentGovernanceAssignmentCollection.create({
      db,
    });

    const policy = await policies.create({
      key: 'editorial',
      label: 'Admin Editorial Review',
      kind: 'custom',
      instructions: 'Admin override.',
    });
    const profile = await profiles.create({
      key: 'publication',
      label: 'Admin Publication',
      requirements: [{ policyKey: 'editorial', blocking: true }],
    });
    const assignment = await assignments.create({
      contentType: 'article',
      enabled: true,
      publicationProfileKey: 'publication',
      enforcePublishReadiness: true,
    });

    const definitions = await contents.getGovernanceDefinitionsAction();

    expect(
      definitions.effective.policies.find((item) => item.key === 'editorial'),
    ).toMatchObject({
      id: policy.id,
      label: 'Admin Editorial Review',
    });
    expect(
      definitions.effective.profiles.find((item) => item.key === 'publication'),
    ).toMatchObject({
      id: profile.id,
      label: 'Admin Publication',
    });
    expect(
      definitions.effective.assignments.find(
        (item) => item.contentType === 'article',
      ),
    ).toMatchObject({
      id: assignment.id,
      enforcePublishReadiness: true,
    });
  });

  it('scopes governance definitions to global and selected tenant rows', async () => {
    const policies = await ContentGovernancePolicyCollection.create({ db });
    for (const input of [
      {
        key: 'global-policy',
        label: 'Global Policy',
        tenantId: null,
      },
      {
        key: 'tenant-policy',
        label: 'Tenant Policy',
        tenantId: 'tenant-1',
      },
      {
        key: 'other-tenant-policy',
        label: 'Other Tenant Policy',
        tenantId: 'tenant-2',
      },
    ]) {
      const policy = await policies.create({
        ...input,
        kind: 'custom',
        instructions: `${input.label} instructions`,
      });
      await policy.save();
    }

    const tenantDefinitions = await contents.getGovernanceDefinitionsAction({
      tenantId: 'tenant-1',
    });
    const globalDefinitions = await contents.getGovernanceDefinitionsAction({
      tenantId: null,
    });

    expect(
      tenantDefinitions.persisted.policies.map((policy) => policy.key).sort(),
    ).toEqual(['global-policy', 'tenant-policy']);
    expect(
      tenantDefinitions.effective.policies.map((policy) => policy.key),
    ).not.toContain('other-tenant-policy');
    expect(
      globalDefinitions.persisted.policies.map((policy) => policy.key),
    ).toEqual(['global-policy']);
  });
});
