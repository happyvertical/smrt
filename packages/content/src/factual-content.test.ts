import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(configured.reviewPolicies.newsroom.instructions).toContain(
      'local publication rules',
    );
    expect(configured.reviewProfiles.publish[0]?.policyKey).toBe('safety');

    const reset = resetContentGovernanceConfig();
    expect(reset.defaultFactRelationship).toBe('supports');
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
