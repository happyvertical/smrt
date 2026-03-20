import { describe, expect, it } from 'vitest';
import {
  type ContentTransparencyData,
  normalizeContentTransparency,
} from './content-transparency';
import { serializeContent as serverSerializeContent } from './lib/server/content-api-serializers';
import {
  serializeContent,
  serializeContentCorrection,
  serializeContentGovernanceAssignment,
  serializeContentGovernanceProfile,
  serializeContentGovernanceState,
  serializeContentReview,
  serializeContentReviewPolicy,
  serializeContentReviewProfileEvaluation,
  serializeContentVersion,
  serializeFact,
  serializeFactLink,
} from './serialization';
import { contentToString, stringToContent } from './utils';

describe('content utilities', () => {
  it('normalizes transparency snapshots with defaults and derived fact sections', () => {
    const snapshot = normalizeContentTransparency(
      {
        snapshotKind: 'published',
        contentId: 'content-1',
        generation: {
          aiAssisted: 1,
          publicPrompt: 'Summarize the record',
          model: 'gpt-test',
        },
        linkedFacts: [
          {
            id: 'fact-used',
            textRefined: 'Used fact',
            usedInArticle: true,
            relationship: 'supports',
            linkMetadata: { confidence: 'high' },
            sources: [{ id: 'source-1', sourceUrl: 'https://example.com/a' }],
          },
          {
            id: 'fact-linked',
            textRaw: 'Linked but unused',
            usedInArticle: false,
          },
        ],
        references: [
          {
            id: 'reference-1',
            title: 'Reference',
            usedFactIds: ['fact-used', '', null],
            extractedFacts: [
              {
                id: 'fact-other',
                textRefined: 'Other fact',
                usedInArticle: false,
              },
              {
                id: 'fact-other',
                textRefined: 'Other fact',
                usedInArticle: false,
              },
            ],
          },
        ],
        versionHistory: [
          {
            id: 'version-1',
            version: 3,
            kind: 'publication',
            summary: 'Published',
            provenance: { fromCorrectionId: 'correction-1' },
          },
        ],
        publicationVersion: {
          id: 'version-1',
          version: 3,
          kind: 'publication',
          summary: 'Published snapshot',
          createdAt: '2026-03-20T09:00:00.000Z',
        },
      },
      {
        generatedAt: '2026-03-20T09:05:00.000Z',
        publicationProfileKey: 'publication',
      },
    );

    expect(snapshot.snapshotKind).toBe('published');
    expect(snapshot.generatedAt).toBe('2026-03-20T09:05:00.000Z');
    expect(snapshot.factsUsed.map((fact) => fact.id)).toEqual(['fact-used']);
    expect(snapshot.otherExtractedFacts.map((fact) => fact.id)).toEqual([
      'fact-other',
    ]);
    expect(snapshot.references[0].usedFactIds).toEqual(['fact-used']);
    expect(snapshot.linkedFacts[0].linkMetadata).toEqual({
      confidence: 'high',
    });
    expect(snapshot.publicationVersion?.version).toBe(3);
    expect(snapshot.versionHistory[0].provenance).toEqual({
      fromCorrectionId: 'correction-1',
    });
  });

  it('falls back to preview defaults when transparency data is incomplete', () => {
    const snapshot = normalizeContentTransparency(
      {
        publicationReviewProfileKey: 'legacy-publication',
        reviews: 'not-an-array',
      },
      {
        snapshotKind: 'preview',
        contentId: 'content-2',
        currentContentStatus: 'draft',
      } satisfies Partial<ContentTransparencyData>,
    );

    expect(snapshot.snapshotKind).toBe('preview');
    expect(snapshot.contentId).toBe('content-2');
    expect(snapshot.currentContentStatus).toBe('draft');
    expect(snapshot.publicationProfileKey).toBe('legacy-publication');
    expect(snapshot.publicationVersion).toBeNull();
    expect(snapshot.reviews).toEqual([]);
  });

  it('serializes content workflows with getter-based metadata and nested lists', async () => {
    const fact = {
      toJSON: () => ({ id: 'fact-1', metadata: { stale: true } }),
      getMetadata: () => ({ confidence: 'high' }),
    };
    const link = {
      toJSON: () => ({ id: 'link-1', metadata: { old: true } }),
      getMetadata: () => ({ relationship: 'supports' }),
    };
    const version = {
      toJSON: () => ({ id: 'version-1', snapshot: { wrong: true } }),
      getSnapshot: () => ({ body: 'snapshot body' }),
      getMetadata: () => ({ reason: 'publish' }),
    };
    const review = {
      toJSON: () => ({ id: 'review-1', findings: 'ignored' }),
      getFindings: () => [{ title: 'Need source' }],
      getMetadata: () => ({ fingerprint: 'abc123' }),
    };
    const correction = {
      toJSON: () => ({ id: 'correction-1', metadata: { ignored: true } }),
      getMetadata: () => ({ published: true }),
    };
    const profile = {
      toJSON: () => ({ key: 'publication', requirements: 'ignored' }),
      getMetadata: () => ({ builtin: true }),
    };
    const assignment = {
      toJSON: () => ({ key: 'article::news', metadata: { ignored: true } }),
      getMetadata: () => ({ fromAdmin: true }),
    };
    const governanceState = {
      toJSON: () => ({
        isGoverned: true,
        reviewPolicies: [{ key: 'facts', label: 'Facts Review' }],
        availableProfiles: [{ key: 'publication', requirements: [] }],
        reviewProfiles: [{ profileKey: 'publication', requirements: [] }],
      }),
    };
    const content = {
      toJSON: () => ({ id: 'content-1', title: 'Hello world' }),
      getReferences: async () => [{ id: 'reference-1' }, { id: null }],
      getAssets: async () => [{ id: 'asset-1' }, { id: undefined }],
    };

    expect(serializeFact(fact)).toMatchObject({
      id: 'fact-1',
      metadata: { confidence: 'high' },
    });
    expect(serializeFactLink(link)).toMatchObject({
      id: 'link-1',
      metadata: { relationship: 'supports' },
    });
    expect(serializeContentVersion(version)).toMatchObject({
      id: 'version-1',
      snapshot: { body: 'snapshot body' },
      metadata: { reason: 'publish' },
    });
    expect(serializeContentReview(review)).toMatchObject({
      id: 'review-1',
      findings: [{ title: 'Need source' }],
      metadata: { fingerprint: 'abc123' },
    });
    expect(serializeContentCorrection(correction)).toMatchObject({
      id: 'correction-1',
      metadata: { published: true },
    });
    expect(
      serializeContentReviewProfileEvaluation({
        profileKey: 'publication',
        requirements: 'invalid',
      }),
    ).toEqual({
      profileKey: 'publication',
      requirements: [],
    });
    expect(serializeContentReviewPolicy({ key: 'facts' })).toEqual({
      key: 'facts',
    });
    expect(serializeContentGovernanceProfile(profile)).toMatchObject({
      key: 'publication',
      requirements: [],
      metadata: { builtin: true },
    });
    expect(serializeContentGovernanceAssignment(assignment)).toMatchObject({
      key: 'article::news',
      metadata: { fromAdmin: true },
    });
    expect(serializeContentGovernanceState(governanceState)).toMatchObject({
      isGoverned: true,
      reviewPolicies: [{ key: 'facts', label: 'Facts Review' }],
      availableProfiles: [{ key: 'publication', requirements: [] }],
      reviewProfiles: [{ profileKey: 'publication', requirements: [] }],
    });
    expect(serializeFact(null)).toEqual({ metadata: {} });
    expect(serializeContentVersion({ toJSON: () => null })).toEqual({
      snapshot: {},
      metadata: {},
    });

    await expect(serializeContent(content)).resolves.toEqual({
      id: 'content-1',
      title: 'Hello world',
      referenceIds: ['reference-1'],
      assetIds: ['asset-1'],
      assets: [{ id: 'asset-1' }, { id: undefined }],
    });
    expect(serverSerializeContent).toBe(serializeContent);
  });

  it('serializes content to markdown frontmatter and parses it back', () => {
    const rendered = contentToString({
      title: 'Bridge Update',
      slug: 'bridge-update',
      body: 'First paragraph\n\nSecond paragraph',
      tags: ['local'],
    } as any);

    expect(rendered).toContain('title: Bridge Update');
    expect(rendered).toContain('slug: bridge-update');
    expect(rendered).toContain('First paragraph');

    expect(stringToContent(rendered)).toEqual({
      title: 'Bridge Update',
      slug: 'bridge-update',
      tags: ['local'],
      body: 'First paragraph\n\nSecond paragraph',
    });
    expect(stringToContent('No frontmatter here')).toEqual({
      body: 'No frontmatter here',
    });
  });
});
