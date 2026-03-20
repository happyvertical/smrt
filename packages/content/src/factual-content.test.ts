import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  FactCollection,
  FactSourceCollection,
} from '@happyvertical/smrt-facts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Content } from './content';
import { ContentCorrection } from './content-correction';
import {
  buildContentReviewPrompt,
  configureContentGovernance,
  getContentReviewPolicies,
  getContentReviewProfileKeys,
  getContentReviewRequirements,
  parseContentReviewResponse,
  resetContentGovernanceConfig,
} from './content-governance';
import { ContentReview } from './content-review';
import { ContentReviewCollection } from './content-reviews';
import { FactualContent } from './content-types';
import { ContentVersion } from './content-version';

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

async function prepareContentWorkflowSchemas(db: DatabaseInterface) {
  await syncSchema({ db, schema: CONTENT_REFERENCES_SCHEMA });
  await syncSchema({ db, schema: CONTENT_VERSIONS_SCHEMA });
  await syncSchema({ db, schema: CONTENT_CORRECTIONS_SCHEMA });
  await syncSchema({ db, schema: FACT_CONTENTS_SCHEMA });
}

describe('FactualContent foundations', () => {
  it('marks factual content as opted in via metadata and helper methods', () => {
    const content = new FactualContent({
      title: 'Transit update',
      body: 'Ridership increased this winter.',
      metadata: {
        section: 'transportation',
      },
    });

    expect(content.isFactual()).toBe(true);
    expect(content.metadata.section).toBe('transportation');
    expect(content.metadata.factual).toBe(true);
    expect(content.metadata.governance.enabled).toBe(true);
    expect(content.metadata.governance.factual).toBe(true);
  });

  it('supports app-level governance overrides and reset', () => {
    const configured = configureContentGovernance({
      defaultFactRelationship: 'referenced_in',
      publicationReviewProfileKey: 'preflight',
      enforcePublishReadiness: true,
      reviewPolicies: {
        newsroom: {
          key: 'newsroom',
          instructions: 'Check tone, sourcing, and local publication rules.',
        },
      },
      reviewProfiles: {
        publish: [
          {
            policyKey: 'safety',
            blocking: true,
          },
        ],
      },
    });

    expect(configured.defaultFactRelationship).toBe('referenced_in');
    expect(configured.publicationReviewProfileKey).toBe('preflight');
    expect(configured.enforcePublishReadiness).toBe(true);
    expect(configured.reviewPolicies.newsroom.instructions).toContain(
      'local publication rules',
    );
    expect(configured.reviewProfiles.publish[0]?.policyKey).toBe('safety');

    const reset = resetContentGovernanceConfig();
    expect(reset.defaultFactRelationship).toBe('supports');
    expect(reset.publicationReviewProfileKey).toBe('publication');
    expect(reset.enforcePublishReadiness).toBe(false);
    expect(reset.reviewPolicies.newsroom).toBeUndefined();
    expect(reset.reviewProfiles.publish).toBeUndefined();
  });

  it('builds and parses structured review prompts', () => {
    const content = new FactualContent({
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
    expect(prompt).toContain('The bridge reopened on March 1.');

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
    expect(parsed.summary).toContain('unsupported timing');
    expect(parsed.findings[0].factId).toBe('fact-1');
  });

  it('round-trips version, review, and correction JSON payloads', () => {
    const version = new ContentVersion({
      contentId: 'content-1',
      version: 2,
      summary: 'Updated numbers',
      snapshot: {
        title: 'Budget update',
        body: 'The total is $4.2 million.',
      },
      metadata: {
        editor: 'copy-desk',
      },
    });
    expect(version.getSnapshot().body).toBe('The total is $4.2 million.');
    expect(version.getMetadata().editor).toBe('copy-desk');

    const review = new ContentReview({
      contentId: 'content-1',
      kind: 'facts',
      findings: [
        {
          severity: 'warning',
          title: 'Unsupported amount',
          detail: 'The amount needs a source.',
        },
      ],
      metadata: {
        reviewerMode: 'ai',
      },
    });
    expect(review.getFindings()).toHaveLength(1);
    expect(review.getMetadata().reviewerMode).toBe('ai');

    const correction = new ContentCorrection({
      contentId: 'content-1',
      summary: 'Corrected the amount.',
      metadata: {
        correctionChannel: 'public-note',
      },
    });
    expect(correction.getMetadata().correctionChannel).toBe('public-note');
  });

  it('filters review requirements for factual content profiles', () => {
    const content = new FactualContent({
      title: 'Budget update',
      body: 'The budget passed second reading.',
    });

    const publicationRequirements = getContentReviewRequirements(
      content,
      'publication',
    );

    expect(
      publicationRequirements.map((requirement) => requirement.policyKey),
    ).toContain('safety');
    expect(
      publicationRequirements.map((requirement) => requirement.policyKey),
    ).toContain('facts');
    expect(getContentReviewProfileKeys()).toContain('publication');
    expect(getContentReviewPolicies().map((policy) => policy.key)).toContain(
      'facts',
    );
  });

  it('evaluates review profile readiness separately from completeness', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      configureContentGovernance({
        reviewProfiles: {
          publication: [
            {
              policyKey: 'safety',
              blocking: true,
            },
            {
              policyKey: 'facts',
              blocking: false,
            },
          ],
        },
      });

      const content = new FactualContent({
        name: 'budget-update',
        title: 'Budget update',
        body: 'The budget passed.',
        db,
      });
      await content.initialize();
      await content.save();

      const reviews = await ContentReviewCollection.create({ db });
      await reviews.create({
        contentId: content.id,
        kind: 'safety',
        policyKey: 'safety',
        status: 'passed',
        summary: 'Safety review passed.',
      });

      const evaluation = await content.evaluateReviewProfile('publication');

      expect(evaluation.ready).toBe(true);
      expect(evaluation.complete).toBe(false);
      expect(
        evaluation.requirements.find(
          (requirement) => requirement.policyKey === 'facts',
        )?.missing,
      ).toBe(true);
      expect(
        evaluation.requirements.find(
          (requirement) => requirement.policyKey === 'safety',
        )?.satisfied,
      ).toBe(true);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('lists configured review profile evaluations for content', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      configureContentGovernance({
        reviewProfiles: {
          publication: [
            {
              policyKey: 'safety',
              blocking: true,
            },
            {
              policyKey: 'facts',
              blocking: false,
            },
          ],
          correction: [
            {
              policyKey: 'safety',
              blocking: true,
            },
          ],
        },
      });

      const content = new FactualContent({
        name: 'council-update',
        title: 'Council update',
        body: 'Council approved the budget.',
        db,
      });
      await content.initialize();
      await content.save();

      const reviews = await ContentReviewCollection.create({ db });
      await reviews.create({
        contentId: content.id,
        kind: 'safety',
        policyKey: 'safety',
        status: 'passed',
        summary: 'Safety review passed.',
      });

      const profiles = await content.listReviewProfilesAction();

      expect(profiles.map((profile) => profile.profileKey)).toEqual([
        'publication',
        'correction',
      ]);
      expect(
        profiles.find((profile) => profile.profileKey === 'publication')?.ready,
      ).toBe(true);
      expect(
        profiles.find((profile) => profile.profileKey === 'correction')?.ready,
      ).toBe(true);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('uses configured policy kinds for app-level review policies', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      configureContentGovernance({
        reviewPolicies: {
          legal: {
            key: 'legal',
            label: 'Legal Review',
            kind: 'safety',
            instructions: 'Check legal exposure and risky claims.',
          },
        },
        reviewProfiles: {
          publication: [
            {
              policyKey: 'legal',
              blocking: true,
            },
          ],
        },
      });

      const content = new FactualContent({
        name: 'court-update',
        title: 'Court update',
        body: 'The filing made several allegations.',
        db,
        ai: {
          embed: vi.fn().mockResolvedValue([]),
          message: vi.fn().mockResolvedValue(
            JSON.stringify({
              status: 'passed',
              summary: 'Legal review passed.',
              findings: [],
            }),
          ),
        },
      });
      await content.initialize();
      await content.save();

      const evaluation = await content.evaluateReviewProfile('publication');
      expect(evaluation.requirements[0]?.kind).toBe('safety');

      const review = await content.runReview({
        policyKey: 'legal',
        createVersion: false,
      });

      expect(review.kind).toBe('safety');
      expect(review.policyKey).toBe('legal');
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('marks version-bound reviews as stale after content changes', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      configureContentGovernance({
        reviewProfiles: {
          publication: [
            {
              policyKey: 'safety',
              blocking: true,
            },
          ],
        },
      });

      const content = new FactualContent({
        name: 'transit-safety',
        title: 'Transit safety',
        body: 'Transit service remains available.',
        db,
        ai: {
          embed: vi.fn().mockResolvedValue([]),
          message: vi.fn().mockResolvedValue(
            JSON.stringify({
              status: 'passed',
              summary: 'Safety review passed.',
              findings: [],
            }),
          ),
        },
      });
      await content.initialize();
      await content.save();
      await content.reviewSafety({ createVersion: false });

      const freshEvaluation =
        await content.evaluateReviewProfile('publication');
      expect(freshEvaluation.ready).toBe(true);
      expect(freshEvaluation.requirements[0]?.stale).toBe(false);

      content.body = 'Transit service is suspended tonight.';

      const staleEvaluation =
        await content.evaluateReviewProfile('publication');
      expect(staleEvaluation.ready).toBe(false);
      expect(staleEvaluation.complete).toBe(false);
      expect(staleEvaluation.requirements[0]?.stale).toBe(true);
      expect(staleEvaluation.requirements[0]?.satisfied).toBe(false);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('enforces blocking publish requirements on save when configured', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      configureContentGovernance({
        enforcePublishReadiness: true,
        reviewProfiles: {
          publication: [
            {
              policyKey: 'safety',
              blocking: true,
            },
          ],
        },
      });

      const content = new FactualContent({
        name: 'overnight-publish',
        title: 'Overnight publish',
        body: 'Breaking copy without review.',
        status: 'published',
        db,
      });
      await content.initialize();

      await expect(content.save()).rejects.toThrow(
        /review profile is satisfied/i,
      );

      content.status = 'draft';
      await expect(content.save()).resolves.toBe(content);
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('captures a transparency snapshot when published content is saved', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareContentWorkflowSchemas(db);

      const content = new FactualContent({
        name: 'bridge-update',
        title: 'Bridge update',
        body: 'The bridge reopened this morning.',
        db,
        metadata: {
          generation: {
            publicPrompt: 'Write a concise public-service update.',
            aiAssisted: true,
            model: 'gpt-test',
          },
        },
      });
      await content.initialize();
      await content.save();

      const reference = new Content({
        name: 'bridge-reference',
        title: 'Bridge authority release',
        url: 'https://example.com/bridge-release',
        body: 'Official release from the bridge authority.',
        db,
      });
      await reference.initialize();
      await reference.save();
      await content.addReference(reference);

      const facts = await FactCollection.create({ db });
      const factSources = await FactSourceCollection.create({ db });
      const fact = await facts.create({
        textRefined: 'The bridge reopened on Friday morning.',
        textRaw: 'The bridge reopened on Friday morning.',
        status: 'active',
      });
      await factSources.create({
        factId: fact.id as string,
        sourceUrl: reference.url || '',
        sourceTitle: reference.title,
        sourceType: 'article',
      });
      await content.addFact(fact, 'supports');

      content.status = 'published';
      await content.save();

      const versions = await content.getVersions();
      const publicationVersion = versions.find(
        (version) => version.kind === 'publication',
      );

      expect(publicationVersion).toBeTruthy();

      const metadata = publicationVersion?.getMetadata() || {};
      expect(metadata.publicationSnapshotFingerprint).toBeTruthy();
      expect(metadata.transparency?.generation?.publicPrompt).toBe(
        'Write a concise public-service update.',
      );
      expect(metadata.transparency?.factsUsed).toHaveLength(1);
      expect(metadata.transparency?.references[0]?.usedFactIds).toContain(
        fact.id,
      );

      const previewTransparency = await content.previewTransparencyAction();
      const publishedTransparency =
        await content.getPublishedTransparencyAction();
      const versionTransparency =
        await publicationVersion?.getTransparencyAction();

      expect(previewTransparency.snapshotKind).toBe('preview');
      expect(previewTransparency.factsUsed).toHaveLength(1);
      expect(publishedTransparency?.snapshotKind).toBe('published');
      expect(publishedTransparency?.publicationVersion?.id).toBe(
        publicationVersion?.id,
      );
      expect(versionTransparency?.publicationVersion?.version).toBe(
        publicationVersion?.version,
      );
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('auto-creates a correction draft version when issuing a correction', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      await prepareContentWorkflowSchemas(db);

      const content = new FactualContent({
        name: 'budget-fix',
        title: 'Budget fix',
        body: 'The budget is $4.2 million.',
        status: 'published',
        db,
      });
      await content.initialize();
      await content.save();

      const correction = await content.issueCorrection({
        summary: 'Correct the budget amount.',
        incorrectText: '$4.2 million',
        correctedText: '$5.1 million',
      });

      expect(correction.getMetadata().autoGeneratedDraft).toBe(true);
      expect(correction.getMetadata().draftVersionId).toBeTruthy();

      const versions = await content.getVersions();
      const draftVersion = versions.find(
        (version) =>
          version.kind === 'draft' &&
          version.summary ===
            'Auto-created correction draft: Correct the budget amount.',
      );

      expect(draftVersion).toBeTruthy();
      expect(draftVersion?.getSnapshot().status).toBe('draft');
      expect(draftVersion?.getSnapshot().body).toContain('$5.1 million');

      const previewTransparency = await content.previewTransparencyAction();
      const correctionEntry = previewTransparency.corrections[0];
      const draftHistoryEntry = previewTransparency.versionHistory.find(
        (version) => version.id === draftVersion?.id,
      );

      expect(correctionEntry?.provenance?.draftVersionId).toBe(
        draftVersion?.id,
      );
      expect(draftHistoryEntry?.provenance?.sourceCorrectionVersionId).toBe(
        correction.getMetadata().sourceCorrectionVersionId,
      );
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });

  it('returns governance state with policies and evaluated profiles', async () => {
    const db: DatabaseInterface = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    try {
      configureContentGovernance({
        reviewPolicies: {
          editorial: {
            key: 'editorial',
            label: 'Editorial Review',
            kind: 'custom',
            instructions: 'Check voice, style, and clarity.',
          },
        },
        reviewProfiles: {
          publication: [
            {
              policyKey: 'safety',
              blocking: true,
            },
            {
              policyKey: 'editorial',
              blocking: false,
            },
          ],
        },
      });

      const content = new FactualContent({
        name: 'budget-roundup',
        title: 'Budget roundup',
        body: 'The budget passed last night.',
        db,
      });
      await content.initialize();
      await content.save();

      const governanceState = await content.getGovernanceStateAction();

      expect(governanceState.isFactual).toBe(true);
      expect(governanceState.defaultFactRelationship).toBe('supports');
      expect(governanceState.publicationReviewProfileKey).toBe('publication');
      expect(governanceState.enforcePublishReadiness).toBe(false);
      expect(
        governanceState.reviewPolicies.find(
          (policy) => policy.key === 'editorial',
        )?.kind,
      ).toBe('custom');
      expect(
        governanceState.reviewProfiles.find(
          (profile) => profile.profileKey === 'publication',
        ),
      ).toBeTruthy();
    } finally {
      if (typeof db.close === 'function') {
        await db.close();
      }
    }
  });
});
