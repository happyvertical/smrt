import { getTestDatabase } from '@happyvertical/smrt-core';
import { FactCollection } from '@happyvertical/smrt-facts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Content } from './content';
import {
  buildContentReviewPrompt,
  configureContentGovernance,
  parseContentReviewResponse,
  resetContentGovernanceConfig,
  resolveConfiguredContentGovernance,
  resolveEffectiveContentGovernance,
} from './content-governance';
import {
  ContentGovernanceAssignmentCollection,
  ContentGovernancePolicyCollection,
  ContentGovernanceProfileCollection,
  ContentReviewCollection,
} from './index';

afterEach(() => {
  resetContentGovernanceConfig();
});

const CONTENT_REFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_references (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  source_id TEXT,
  target_id TEXT
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

const FACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  text_refined TEXT,
  text_raw TEXT,
  type TEXT,
  status TEXT,
  domain TEXT,
  parent_id TEXT,
  evolution_type TEXT,
  source_count INTEGER,
  confidence DECIMAL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS facts_id_idx ON facts (id);
`;

const FACT_SOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS fact_sources (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  fact_id TEXT,
  source_type TEXT,
  source_url TEXT,
  source_title TEXT,
  credibility DECIMAL,
  extracted_at DATETIME,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS fact_sources_id_idx ON fact_sources (id);
`;

const FACT_EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fact_evidences (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  fact_id TEXT,
  evidence_key TEXT,
  status TEXT DEFAULT 'supports',
  source_kind TEXT,
  source_id TEXT,
  source_url TEXT,
  source_title TEXT,
  quote TEXT,
  locator TEXT,
  extraction_method TEXT,
  confidence DECIMAL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS fact_evidences_id_idx ON fact_evidences (id);
CREATE INDEX IF NOT EXISTS fact_evidences_tenant_id_source_status_idx ON fact_evidences (tenant_id, source_kind, source_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS fact_evidences_fact_id_evidence_key_idx ON fact_evidences (fact_id, evidence_key);
`;

const FACT_CONTENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fact_contents (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  fact_id TEXT,
  content_id TEXT,
  relationship TEXT,
  metadata TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS fact_contents_id_idx ON fact_contents (id);
CREATE UNIQUE INDEX IF NOT EXISTS fact_contents_fact_id_content_id_relationship_idx ON fact_contents (fact_id, content_id, relationship);
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

async function prepareContentWorkflowSchemas(db: DatabaseInterface) {
  await syncSchema({ db, schema: CONTENT_REFERENCES_SCHEMA });
  await syncSchema({ db, schema: CONTENT_VERSIONS_SCHEMA });
  await syncSchema({ db, schema: CONTENT_REVIEWS_SCHEMA });
  await syncSchema({ db, schema: CONTENT_CORRECTIONS_SCHEMA });
  await syncSchema({ db, schema: FACTS_SCHEMA });
  await syncSchema({ db, schema: FACT_SOURCES_SCHEMA });
  await syncSchema({ db, schema: FACT_EVIDENCE_SCHEMA });
  await syncSchema({ db, schema: FACT_CONTENTS_SCHEMA });
}

async function prepareGovernanceSchemas(db: DatabaseInterface) {
  await syncSchema({ db, schema: GOVERNANCE_POLICIES_SCHEMA });
  await syncSchema({ db, schema: GOVERNANCE_PROFILES_SCHEMA });
  await syncSchema({ db, schema: GOVERNANCE_ASSIGNMENTS_SCHEMA });
}

describe('Content governance', () => {
  it('keeps plain Content publish/save compatible without governance tables', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });
    const touchedTables = new Set<string>();
    const trackTable = <T extends (...args: any[]) => Promise<any>>(
      method: T,
    ): T =>
      (async (table: string, ...args: any[]) => {
        touchedTables.add(table);
        return method(table, ...args);
      }) as T;

    db.list = trackTable(db.list.bind(db));
    db.get = trackTable(db.get.bind(db));
    db.insert = trackTable(db.insert.bind(db));
    db.update = trackTable(db.update.bind(db));
    db.delete = trackTable(db.delete.bind(db));
    db.upsert = trackTable(db.upsert.bind(db));
    db.getOrInsert = trackTable(db.getOrInsert.bind(db));

    try {
      const content = new Content({
        name: 'document-body',
        title: 'Document body',
        body: 'This is a plain document body.',
        type: 'document',
        status: 'published',
        db,
      });
      await content.initialize();
      await content.save();

      expect(content.id).toBeDefined();
      expect(content.isGoverned()).toBe(false);

      content.body = 'This is still plain content.';
      await expect(content.save()).resolves.toBe(content);
      expect(
        [...touchedTables].filter((table) =>
          [
            'content_governance_policies',
            'content_governance_profiles',
            'content_governance_assignments',
            'content_versions',
            'content_reviews',
            'content_corrections',
            'fact_contents',
          ].includes(table),
        ),
      ).toEqual([]);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('builds and parses structured review prompts', () => {
    const content = new Content({
      title: 'Bridge reopening',
      body: 'The bridge reopened in February.',
      status: 'draft',
    });

    const prompt = buildContentReviewPrompt({
      kind: 'facts',
      content,
      facts: [
        {
          id: 'fact-1',
          textRefined: 'The bridge reopened on March 1.',
          status: 'active',
          confidence: 0.82,
          sourceCount: 3,
        } as any,
      ],
    });

    expect(prompt).toContain('Review kind: facts');
    expect(prompt).toContain('fact-1');

    const parsed = parseContentReviewResponse(
      JSON.stringify({
        status: 'flagged',
        summary: 'One unsupported timing claim.',
        findings: [
          {
            severity: 'warning',
            title: 'Timing mismatch',
            detail: 'The supplied fact says March 1, not February.',
            factId: 'fact-1',
          },
        ],
      }),
    );

    expect(parsed.status).toBe('flagged');
    expect(parsed.findings[0]?.factId).toBe('fact-1');
  });

  it('applies type-only assignments and keeps built-in policies/profiles available', () => {
    configureContentGovernance({
      assignments: [
        {
          contentType: 'article',
          enabled: true,
          factLinkingEnabled: true,
          transparencyEnabled: true,
          publicationProfileKey: 'publication',
          correctionProfileKey: 'correction',
          enforcePublishReadiness: true,
        },
      ],
    });

    const articleGovernance = resolveConfiguredContentGovernance({
      contentType: 'article',
    });
    const documentGovernance = resolveConfiguredContentGovernance({
      contentType: 'document',
    });

    expect(articleGovernance.isGoverned).toBe(true);
    expect(articleGovernance.factLinkingEnabled).toBe(true);
    expect(
      articleGovernance.reviewPolicies.map((policy) => policy.key),
    ).toEqual(expect.arrayContaining(['facts', 'safety']));
    expect(
      articleGovernance.availableProfiles.map((profile) => profile.key),
    ).toEqual(expect.arrayContaining(['publication', 'correction']));
    expect(documentGovernance.isGoverned).toBe(false);
  });

  it('lets exact variant assignments override and disable broader type rules', () => {
    configureContentGovernance({
      assignments: [
        {
          contentType: 'article',
          enabled: true,
          factLinkingEnabled: true,
          transparencyEnabled: true,
          publicationProfileKey: 'publication',
        },
        {
          contentType: 'article',
          contentVariant: 'news:live-blog',
          enabled: false,
        },
        {
          contentType: 'article',
          contentVariant: 'news:analysis',
          enabled: true,
          factLinkingEnabled: false,
          transparencyEnabled: true,
          publicationProfileKey: 'correction',
        },
      ],
    });

    const liveBlog = resolveConfiguredContentGovernance({
      contentType: 'article',
      contentVariant: 'news:live-blog',
    });
    const analysis = resolveConfiguredContentGovernance({
      contentType: 'article',
      contentVariant: 'news:analysis',
    });
    const genericArticle = resolveConfiguredContentGovernance({
      contentType: 'article',
      contentVariant: 'news:brief',
    });

    expect(liveBlog.isGoverned).toBe(false);
    expect(analysis.isGoverned).toBe(true);
    expect(analysis.factLinkingEnabled).toBe(false);
    expect(analysis.publicationProfileKey).toBe('correction');
    expect(genericArticle.isGoverned).toBe(true);
    expect(genericArticle.factLinkingEnabled).toBe(true);
  });

  it('lets persisted admin records override config defaults', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareGovernanceSchemas(db);

      configureContentGovernance({
        policies: [
          {
            key: 'editorial',
            label: 'Editorial Review',
            kind: 'custom',
            instructions: 'Check style and tone.',
          },
        ],
        profiles: [
          {
            key: 'publication',
            label: 'Publication',
            requirements: [
              {
                policyKey: 'editorial',
                blocking: false,
              },
            ],
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

      await policies.create({
        key: 'editorial',
        label: 'Admin Editorial Review',
        kind: 'custom',
        instructions: 'Admin override instructions.',
      });
      await profiles.create({
        key: 'admin-publication',
        label: 'Admin Publication',
        requirements: [
          {
            policyKey: 'editorial',
            blocking: true,
          },
        ],
      });
      await assignments.create({
        contentType: 'article',
        enabled: true,
        publicationProfileKey: 'admin-publication',
        enforcePublishReadiness: true,
      });

      const governance = await resolveEffectiveContentGovernance({
        contentType: 'article',
        db,
      });

      expect(governance.isGoverned).toBe(true);
      expect(governance.publicationProfileKey).toBe('admin-publication');
      expect(governance.enforcePublishReadiness).toBe(true);
      expect(
        governance.reviewPolicies.find((policy) => policy.key === 'editorial')
          ?.label,
      ).toBe('Admin Editorial Review');
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('validates references and blocks deletion of in-use policies and profiles', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareGovernanceSchemas(db);

      const policies = await ContentGovernancePolicyCollection.create({ db });
      const profiles = await ContentGovernanceProfileCollection.create({ db });
      const assignments = await ContentGovernanceAssignmentCollection.create({
        db,
      });

      await expect(
        profiles.create({
          key: 'broken-profile',
          label: 'Broken profile',
          requirements: [
            {
              policyKey: 'missing-policy',
            },
          ],
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining('missing-policy'),
        }),
      });

      await expect(
        assignments.create({
          contentType: 'article',
          enabled: true,
          publicationProfileKey: 'missing-profile',
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining('missing-profile'),
        }),
      });

      const policy = await policies.create({
        key: 'legal',
        label: 'Legal Review',
        kind: 'safety',
        instructions: 'Check legal risk.',
      });
      const profile = await profiles.create({
        key: 'legal-publication',
        label: 'Legal publication',
        requirements: [
          {
            policyKey: 'legal',
            blocking: true,
          },
        ],
      });
      await assignments.create({
        contentType: 'article',
        enabled: true,
        publicationProfileKey: 'legal-publication',
      });

      await expect(policy.delete()).rejects.toThrow('referenced by profiles');
      await expect(profile.delete()).rejects.toThrow(
        'referenced by assignments',
      );
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('persists reviews created from collection results', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await syncSchema({ db, schema: CONTENT_REVIEWS_SCHEMA });

      const reviews = await ContentReviewCollection.create({ db });
      const created = await reviews.createFromResult({
        contentId: 'content-1',
        kind: 'facts',
        policyKey: 'facts',
        result: {
          status: 'passed',
          summary: 'Looks good',
          findings: [],
        },
        tenantId: 'tenant-1',
      });

      const reloaded = await reviews.get({ id: created.id as string });
      expect(reloaded?.status).toBe('passed');
      expect(reloaded?.policyKey).toBe('facts');
      expect(reloaded?.summary).toBe('Looks good');
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('keeps the governed article workflow working end to end', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareContentWorkflowSchemas(db);
      await prepareGovernanceSchemas(db);

      configureContentGovernance({
        assignments: [
          {
            contentType: 'article',
            enabled: true,
            factLinkingEnabled: true,
            transparencyEnabled: true,
            publicationProfileKey: 'publication',
            correctionProfileKey: 'correction',
            enforcePublishReadiness: true,
            defaultFactRelationship: 'supports',
          },
        ],
        profiles: [
          {
            key: 'publication',
            label: 'Publication',
            requirements: [
              { policyKey: 'safety', blocking: true },
              { policyKey: 'facts', blocking: true },
            ],
          },
          {
            key: 'correction',
            label: 'Correction',
            requirements: [{ policyKey: 'safety', blocking: true }],
          },
        ],
      });

      const aiMessage = vi.fn().mockResolvedValue(
        JSON.stringify({
          status: 'passed',
          summary: 'Review passed.',
          findings: [],
        }),
      );
      const content = new Content({
        name: 'bridge-update',
        title: 'Bridge update',
        body: 'The bridge reopened on March 1.',
        type: 'article',
        status: 'draft',
        db,
        ai: {
          embed: vi.fn().mockResolvedValue([]),
          message: aiMessage,
        },
      });
      await content.initialize();
      await content.save();

      const facts = await FactCollection.create({ db });
      const fact = await facts.create({
        textRefined: 'The bridge reopened on March 1.',
        textRaw: 'The bridge reopened on March 1.',
        status: 'pending',
        type: 'assertion',
        domain: 'civic',
      });

      const sync = await content.syncFacts([fact.id as string]);
      expect(sync.added).toEqual([fact.id]);

      await content.reviewFacts({ createVersion: false });
      await content.reviewSafety({ createVersion: false });

      const governanceState = await content.getGovernanceState();
      expect(governanceState.isGoverned).toBe(true);
      expect(governanceState.factLinkingEnabled).toBe(true);
      expect(
        governanceState.reviewProfiles.find(
          (profile) => profile.profileKey === 'publication',
        )?.ready,
      ).toBe(true);

      content.status = 'published';
      await content.save();

      const publishedTransparency = await content.getPublishedTransparency();
      expect(publishedTransparency?.factsUsed).toHaveLength(1);
      expect(publishedTransparency?.publicationProfileKey).toBe('publication');

      const correction = await content.issueCorrection({
        summary: 'Correct the reopening date reference.',
        factId: fact.id as string,
        correctedFactText: 'The bridge reopened shortly after March 1.',
      });
      expect(correction.getMetadata().autoGeneratedDraft).toBe(true);

      const versions = await content.getVersions();
      expect(versions.some((version) => version.kind === 'publication')).toBe(
        true,
      );
      expect(versions.some((version) => version.kind === 'draft')).toBe(true);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('repairs fact audit claims without changing article prose', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareContentWorkflowSchemas(db);
      await prepareGovernanceSchemas(db);

      configureContentGovernance({
        assignments: [
          {
            contentType: 'article',
            enabled: true,
            factLinkingEnabled: true,
            transparencyEnabled: true,
            defaultFactRelationship: 'supports',
          },
        ],
      });

      const aiMessage = vi.fn(async (prompt: string) => {
        if (prompt.includes('candidate_facts_json')) {
          const matchedId = prompt.match(/"id": "([^"]+)"/)?.[1];
          if (prompt.includes('<claim>\nCouncil approved the project.')) {
            return JSON.stringify({
              status: 'supported',
              matchedFactIds: matchedId ? [matchedId] : [],
              rationale: 'The reference fact supports the article claim.',
              confidence: 0.94,
            });
          }
          return JSON.stringify({
            status: 'unsupported',
            matchedFactIds: [],
            rationale: 'No source fact supports this claim.',
            confidence: 0.9,
          });
        }

        if (prompt.includes('article_text')) {
          return JSON.stringify({
            facts: [
              {
                statement: 'Council approved the project.',
                type: 'event',
                sourceExcerpt: 'Council approved the project.',
                confidence: 0.91,
              },
              {
                statement: 'The project will cost $2 million.',
                type: 'measurement',
                sourceExcerpt: 'The project will cost $2 million.',
                confidence: 0.82,
              },
            ],
          });
        }

        return JSON.stringify({
          facts: [
            {
              statement: 'Council approved the project.',
              type: 'event',
              sourceExcerpt: 'Council approved the project.',
              confidence: 0.95,
            },
          ],
        });
      });

      const article = new Content({
        name: 'project-story',
        title: 'Council approves project',
        body: 'Council approved the project. The project will cost $2 million.',
        type: 'article',
        status: 'draft',
        db,
        ai: {
          embed: vi.fn().mockResolvedValue([]),
          message: aiMessage,
        },
      });
      await article.initialize();
      await article.save();

      const reference = new Content({
        name: 'project-minutes',
        title: 'Meeting minutes',
        body: 'Council approved the project.',
        type: 'minutes',
        status: 'published',
        db,
      });
      await reference.initialize();
      await reference.save();
      await article.addReference(reference);

      const facts = await FactCollection.create({ db });
      const manualClaimFact = await facts.create({
        textRefined: 'The project will cost $2 million.',
        textRaw: 'The project will cost $2 million.',
        status: 'pending',
        type: 'measurement',
        domain: 'content-audit',
      });
      await article.addFact(manualClaimFact, 'referenced_in', {
        manual: true,
      });

      const originalBody = article.body;
      const audit = await article.repairFactAudit();

      expect(article.body).toBe(originalBody);
      expect(audit.counts.total).toBe(2);
      expect(audit.counts.supported).toBe(1);
      expect(audit.counts.unsupported).toBe(1);
      expect(audit.claims.map((claim) => claim.supportStatus).sort()).toEqual([
        'supported',
        'unsupported',
      ]);
      expect(audit.resourceClaims[0]?.status).toBe('supports');

      const sourceEvidenceId = audit.resourceClaims[0]?.evidence?.[0]?.id;
      const supportedClaim = audit.claims.find(
        (claim) => claim.supportStatus === 'supported',
      );
      expect(sourceEvidenceId).toBeTruthy();
      expect(supportedClaim?.id).toBeTruthy();

      const invalidEvidenceState = await article.updateFactEvidenceStatus({
        evidenceIds: [sourceEvidenceId as string],
        status: 'invalid',
        reason: 'Evidence excerpt is not reliable.',
      });
      expect(invalidEvidenceState.resourceClaims[0]?.status).toBe('invalid');

      const recheckedWithoutEvidence = await article.recheckFactClaims({
        claimFactIds: [supportedClaim?.id as string],
      });
      expect(
        recheckedWithoutEvidence.claims.find(
          (claim) => claim.id === supportedClaim?.id,
        )?.supportStatus,
      ).toBe('unsupported');

      await article.repairFactEvidence({
        sources: [
          {
            sourceKind: 'content-reference',
            sourceId: reference.id as string,
          },
        ],
      });
      const recheckedWithEvidence = await article.recheckFactClaims({
        claimFactIds: [supportedClaim?.id as string],
      });
      expect(
        recheckedWithEvidence.claims.find(
          (claim) => claim.id === supportedClaim?.id,
        )?.supportStatus,
      ).toBe('supported');

      const secondAudit = await article.repairFactAudit();
      expect(secondAudit.counts.total).toBe(2);

      const manualLink = (
        await article.getFactLinks({ relationship: 'referenced_in' })
      ).find((link: any) => link.factId === manualClaimFact.id);
      expect(manualLink).toBeTruthy();
      expect(manualLink?.getMetadata().manual).toBe(true);
      expect(manualLink?.getMetadata().generatedBy).toBeUndefined();
      expect(manualLink?.getMetadata().factAudit?.generatedBy).toBe(
        'content.factAudit',
      );

      const pending = await facts.getPending();
      expect(
        pending.some((fact) => fact.textRefined.includes('$2 million')),
      ).toBe(true);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('keeps supported article claims distinct from their source facts', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareContentWorkflowSchemas(db);
      await prepareGovernanceSchemas(db);

      configureContentGovernance({
        assignments: [
          {
            contentType: 'article',
            enabled: true,
            factLinkingEnabled: true,
            transparencyEnabled: true,
            defaultFactRelationship: 'supports',
          },
        ],
      });

      const aiMessage = vi.fn(async (prompt: string) => {
        if (prompt.includes('candidate_facts_json')) {
          const matchedId = prompt.match(/"id": "([^"]+)"/)?.[1];
          return JSON.stringify({
            status: 'supported',
            matchedFactIds: matchedId ? [matchedId] : [],
            rationale: 'The source fact supports the article claim.',
            confidence: 0.93,
          });
        }

        if (prompt.includes('article_text')) {
          return JSON.stringify({
            facts: [
              {
                statement: 'Council approved the project.',
                type: 'event',
                sourceExcerpt: 'Council approved the project.',
                confidence: 0.91,
              },
              {
                statement: 'Council gave final approval to the project.',
                type: 'event',
                sourceExcerpt: 'Council gave final approval to the project.',
                confidence: 0.89,
              },
            ],
          });
        }

        return JSON.stringify({
          facts: [
            {
              statement: 'Council approved the project.',
              type: 'event',
              sourceExcerpt: 'Council approved the project.',
              confidence: 0.95,
            },
          ],
        });
      });

      const article = new Content({
        name: 'project-approval-story',
        title: 'Council approves project',
        body: 'Council approved the project. Council gave final approval to the project.',
        type: 'article',
        status: 'draft',
        db,
        ai: {
          embed: vi.fn().mockResolvedValue([]),
          message: aiMessage,
        },
      });
      await article.initialize();
      await article.save();

      const reference = new Content({
        name: 'project-approval-minutes',
        title: 'Meeting minutes',
        body: 'Council approved the project.',
        type: 'minutes',
        status: 'published',
        db,
      });
      await reference.initialize();
      await reference.save();
      await article.addReference(reference);

      const audit = await article.repairFactAudit();
      const sourceFactId = audit.resourceClaims[0]?.id;
      const claimIds = audit.claims
        .map((claim) => claim.id)
        .filter((id): id is string => typeof id === 'string');

      expect(audit.counts.total).toBe(2);
      expect(audit.counts.supported).toBe(2);
      expect(claimIds).toHaveLength(2);
      expect(new Set(claimIds).size).toBe(2);
      expect(sourceFactId).toBeTruthy();
      expect(claimIds).not.toContain(sourceFactId);

      const referencedLinks = await article.getFactLinks({
        relationship: 'referenced_in',
      });
      expect(referencedLinks).toHaveLength(2);

      const rechecked = await article.recheckFactClaims({
        claimFactIds: [claimIds[0]],
      });
      expect(rechecked.claimRecheck.recheckedClaims).toBe(1);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('enforces publish readiness for persisted governance assignments', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareContentWorkflowSchemas(db);
      await prepareGovernanceSchemas(db);

      const profiles = await ContentGovernanceProfileCollection.create({
        db,
      });
      const publicationProfile = await profiles.create({
        key: 'publication',
        label: 'Publication',
        requirements: [{ policyKey: 'safety', blocking: true }],
      });
      await publicationProfile.save();

      const assignments = await ContentGovernanceAssignmentCollection.create({
        db,
      });
      const assignment = await assignments.create({
        key: 'article::',
        contentType: 'article',
        enabled: true,
        publicationProfileKey: 'publication',
        correctionProfileKey: 'correction',
        enforcePublishReadiness: true,
      });
      await assignment.save();

      const content = new Content({
        name: 'persisted-governance-article',
        title: 'Persisted governance article',
        body: 'This draft has not been reviewed yet.',
        type: 'article',
        status: 'published',
        db,
      });
      await content.initialize();

      await expect(content.save()).rejects.toMatchObject({
        code: 'VALIDATION_PUBLISH_READINESS',
      });
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });
});
