import { SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as governance from './content-governance';
import { ContentGovernanceAssignment } from './content-governance-assignment';
import { ContentGovernanceAssignmentCollection } from './content-governance-assignments';
import { ContentGovernancePolicyCollection } from './content-governance-policies';
import { ContentGovernancePolicy } from './content-governance-policy';
import { ContentGovernanceProfile } from './content-governance-profile';
import { ContentGovernanceProfileCollection } from './content-governance-profiles';
import { ContentReviewCollection } from './content-reviews';
import { ContentVersionCollection } from './content-versions';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('content governance models', () => {
  it('normalizes assignments and validates referenced profiles', async () => {
    const assignment = new ContentGovernanceAssignment({
      contentType: 'article',
      contentVariant: 'news',
      enabled: false,
      factLinkingEnabled: true,
      transparencyEnabled: true,
      publicationProfileKey: 'publication',
      correctionProfileKey: 'correction',
      enforcePublishReadiness: true,
      defaultFactRelationship: 'supports',
      metadata: { source: 'admin' },
    });
    (assignment as any)._db = {};

    expect(assignment.key).toBe('article::news');
    expect(assignment.getMetadata()).toEqual({ source: 'admin' });
    expect(assignment.toDefinition()).toMatchObject({
      key: 'article::news',
      enabled: false,
      factLinkingEnabled: true,
      transparencyEnabled: true,
      publicationProfileKey: 'publication',
      correctionProfileKey: 'correction',
      enforcePublishReadiness: true,
      metadata: { source: 'admin' },
    });

    vi.spyOn(
      governance,
      'getEffectiveContentGovernanceConfig',
    ).mockResolvedValue({
      policies: [],
      profiles: [
        { key: 'publication', label: 'Publication', requirements: [] },
        { key: 'correction', label: 'Correction', requirements: [] },
      ],
      assignments: [],
    });

    await expect(
      (assignment as any).validateBeforeSave(),
    ).resolves.toBeUndefined();

    assignment.publicationProfileKey = 'missing-profile';
    await expect((assignment as any).validateBeforeSave()).rejects.toThrow(
      'missing-profile',
    );

    const invalidMetadata = new ContentGovernanceAssignment({
      contentType: 'document',
      metadata: 'not-json',
    });
    expect(invalidMetadata.getMetadata()).toEqual({});
  });

  it('normalizes policies and blocks deleting referenced custom policies', async () => {
    const policy = new ContentGovernancePolicy({
      key: 'editorial',
      instructions: 'Check tone.',
      metadata: { source: 'admin' },
    });
    (policy as any)._db = {};

    expect(policy.toDefinition()).toMatchObject({
      key: 'editorial',
      kind: 'custom',
      instructions: 'Check tone.',
      metadata: { source: 'admin' },
    });

    vi.spyOn(
      governance,
      'getEffectiveContentGovernanceConfig',
    ).mockResolvedValue({
      policies: [
        {
          key: 'editorial',
          label: 'Editorial',
          kind: 'custom',
          instructions: '',
        },
      ],
      profiles: [
        {
          key: 'publication',
          label: 'Publication',
          requirements: [{ policyKey: 'editorial' }],
        },
      ],
      assignments: [],
    });

    await expect(policy.delete()).rejects.toThrow('publication');

    const baseDelete = vi
      .spyOn(SmrtObject.prototype, 'delete')
      .mockResolvedValue(undefined as any);
    const builtinPolicy = new ContentGovernancePolicy({
      key: 'safety',
      instructions: 'Check safety.',
    });
    (builtinPolicy as any)._db = {};

    await expect(builtinPolicy.delete()).resolves.toBeUndefined();
    expect(baseDelete).toHaveBeenCalled();
  });

  it('normalizes profiles, validates requirements, and blocks deleting referenced custom profiles', async () => {
    const profile = new ContentGovernanceProfile({
      key: 'editorial-publication',
      description: 'Editorial checks',
      requirements: [{ policyKey: 'editorial', blocking: true }],
      metadata: { source: 'admin' },
    });
    (profile as any)._db = {};

    expect(profile.getRequirements()).toEqual([
      { policyKey: 'editorial', blocking: true },
    ]);
    expect(profile.toDefinition()).toMatchObject({
      key: 'editorial-publication',
      description: 'Editorial checks',
      metadata: { source: 'admin' },
    });

    vi.spyOn(
      governance,
      'getEffectiveContentGovernanceConfig',
    ).mockResolvedValue({
      policies: [
        {
          key: 'editorial',
          label: 'Editorial',
          kind: 'custom',
          instructions: '',
        },
      ],
      profiles: [
        { key: 'editorial-publication', label: 'Editorial', requirements: [] },
      ],
      assignments: [
        {
          key: 'article::',
          contentType: 'article',
          publicationProfileKey: 'editorial-publication',
        },
      ],
    });

    await expect(
      (profile as any).validateBeforeSave(),
    ).resolves.toBeUndefined();

    const invalid = new ContentGovernanceProfile({
      key: 'invalid',
      requirements: [{ policyKey: 'missing-policy' }],
    });
    (invalid as any)._db = {};
    await expect((invalid as any).validateBeforeSave()).rejects.toThrow(
      'missing-policy',
    );

    await expect(profile.delete()).rejects.toThrow('article::');

    const baseDelete = vi
      .spyOn(SmrtObject.prototype, 'delete')
      .mockResolvedValue(undefined as any);
    const builtinProfile = new ContentGovernanceProfile({
      key: 'publication',
      requirements: [],
    });
    (builtinProfile as any)._db = {};
    await expect(builtinProfile.delete()).resolves.toBeUndefined();
    expect(baseDelete).toHaveBeenCalled();

    const invalidRequirements = new ContentGovernanceProfile({
      key: 'broken',
      requirements: 'not-json',
      metadata: 'not-json',
    });
    (invalidRequirements as any)._db = {};
    expect(invalidRequirements.getRequirements()).toEqual([]);
    expect(invalidRequirements.getMetadata()).toEqual({});
  });

  it('resolves collection lookups by key and exact assignment precedence', async () => {
    const policyCollection = new ContentGovernancePolicyCollection({} as any);
    const profileCollection = new ContentGovernanceProfileCollection({} as any);
    const assignmentCollection = new ContentGovernanceAssignmentCollection(
      {} as any,
    );

    vi.spyOn(policyCollection, 'get').mockResolvedValue({
      key: 'facts',
    } as any);
    vi.spyOn(profileCollection, 'get').mockResolvedValue({
      key: 'publication',
    } as any);

    const assignmentGet = vi
      .spyOn(assignmentCollection, 'get')
      .mockImplementation(async (where: any) => {
        if (where.key === 'article::news') {
          return { key: 'article::news', contentType: 'article' } as any;
        }
        if (where.key === 'article::') {
          return { key: 'article::', contentType: 'article' } as any;
        }
        return null as any;
      });

    await expect(policyCollection.getByKey('facts')).resolves.toEqual({
      key: 'facts',
    });
    await expect(profileCollection.getByKey('publication')).resolves.toEqual({
      key: 'publication',
    });
    await expect(
      assignmentCollection.resolveForContent({
        contentType: 'article',
        contentVariant: 'news',
      }),
    ).resolves.toEqual({
      key: 'article::news',
      contentType: 'article',
    });
    await expect(
      assignmentCollection.resolveForContent({ contentType: 'article' }),
    ).resolves.toEqual({
      key: 'article::',
      contentType: 'article',
    });
    expect(assignmentGet).toHaveBeenCalledWith({ key: 'article::news' });
  });

  it('creates and restores content version snapshots', async () => {
    const versions = new ContentVersionCollection({} as any);
    (versions as any)._db = {};
    vi.spyOn(versions, 'getLatestForContent').mockResolvedValue({
      version: 2,
    } as any);
    const createSpy = vi.spyOn(versions, 'create').mockImplementation(
      async (data: any) =>
        ({
          ...data,
          getSnapshot: () => JSON.parse(data.snapshot),
        }) as any,
    );
    vi.spyOn(governance, 'resolveEffectiveContentGovernance').mockResolvedValue(
      {
        isGoverned: true,
        factLinkingEnabled: true,
        transparencyEnabled: true,
        publicationProfileKey: 'publication',
        correctionProfileKey: 'correction',
        enforcePublishReadiness: true,
        defaultFactRelationship: 'supports',
        reviewPolicies: [],
        availableProfiles: [],
        assignment: null,
      },
    );

    const content = {
      id: 'content-1',
      slug: 'bridge-update',
      context: 'news',
      name: 'Bridge Update',
      type: 'article',
      variant: 'news',
      fileKey: 'bridge.md',
      author: 'Reporter',
      title: 'Bridge Update',
      description: 'Bridge reopened',
      body: 'Body copy',
      publish_date: new Date('2026-03-20T09:00:00.000Z'),
      url: 'https://example.com/bridge',
      source: 'newsroom',
      original_url: 'https://source.example.com/bridge',
      language: 'en',
      tags: ['local'],
      category: 'civic',
      status: 'published',
      state: 'ready',
      metadata: '{"priority":"high"}',
      thumbnailAssetId: 'asset-thumb',
      tenantId: 'tenant-1',
      toJSON: () => ({ _meta_type: '@happyvertical/smrt-content:Article' }),
      getReferences: vi.fn().mockResolvedValue([{ id: 'reference-1' }]),
      getAssets: vi.fn().mockResolvedValue([{ id: 'asset-1' }]),
      getFactsState: vi.fn().mockResolvedValue({
        factIds: ['fact-1'],
        facts: [],
        factLinks: [{ id: 'link-1', factId: 'fact-1' }],
      }),
    } as any;

    const created = await versions.createSnapshot(content, {
      kind: 'publication',
      summary: 'Published snapshot',
      metadata: { reason: 'publish' },
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contentId: 'content-1',
        version: 3,
        kind: 'publication',
        summary: 'Published snapshot',
      }),
    );
    expect(created.getSnapshot()).toMatchObject({
      referenceIds: ['reference-1'],
      assetIds: ['asset-1'],
      factIds: ['fact-1'],
    });

    const restoredContent = {
      id: 'content-1',
      save: vi.fn().mockResolvedValue(undefined),
    } as any;
    vi.spyOn(versions, 'getVersion').mockResolvedValue({
      getSnapshot: () => ({
        title: 'Restored title',
        body: 'Restored body',
        status: 'draft',
        metadata: '{"restored":true}',
      }),
    } as any);

    await versions.restoreIntoContent(restoredContent, 3);

    expect(restoredContent.title).toBe('Restored title');
    expect(restoredContent.body).toBe('Restored body');
    expect(restoredContent.status).toBe('draft');
    expect(restoredContent.save).toHaveBeenCalled();

    const unsavedContent = { id: null } as any;
    await expect(versions.createSnapshot(unsavedContent)).rejects.toThrow(
      'unsaved content',
    );
    await expect(
      versions.restoreIntoContent({ id: null } as any, 1),
    ).rejects.toThrow('unsaved content item');

    vi.spyOn(versions, 'getVersion').mockResolvedValueOnce(null);
    await expect(
      versions.restoreIntoContent({ id: 'content-1' } as any, 99),
    ).rejects.toThrow('version 99');
  });

  it('restores linked references, assets, and facts from a version snapshot', async () => {
    const versions = new ContentVersionCollection({} as any);
    (versions as any)._db = {};
    vi.spyOn(versions, 'getVersion').mockResolvedValue({
      getSnapshot: () => ({
        title: 'Restored title',
        body: 'Restored body',
        referenceIds: ['reference-1'],
        assetIds: ['asset-1'],
        factLinks: [
          {
            factId: 'fact-1',
            relationship: 'supports',
          },
        ],
      }),
    } as any);
    vi.spyOn(governance, 'resolveEffectiveContentGovernance').mockResolvedValue(
      {
        isGoverned: true,
        factLinkingEnabled: true,
        transparencyEnabled: true,
        publicationProfileKey: 'publication',
        correctionProfileKey: 'correction',
        enforcePublishReadiness: true,
        defaultFactRelationship: 'supports',
        reviewPolicies: [],
        availableProfiles: [],
        assignment: null,
      },
    );

    const save = vi.fn().mockResolvedValue(undefined);
    const getFactLinks = vi
      .fn()
      .mockResolvedValue([{ factId: 'fact-2', relationship: 'supports' }]);
    const syncFacts = vi.fn().mockResolvedValue({
      added: ['fact-1'],
      kept: [],
      removed: ['fact-2'],
    });
    const content = {
      id: 'content-1',
      type: 'article',
      variant: 'news',
      save,
      getFactLinks,
      syncFacts,
    } as any;

    await versions.restoreIntoContent(content, 3);

    expect(content.title).toBe('Restored title');
    expect(content.body).toBe('Restored body');
    expect(content.referenceIds).toEqual(['reference-1']);
    expect(content.assetIds).toEqual(['asset-1']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(syncFacts).toHaveBeenCalledWith(['fact-1'], 'supports');
  });

  it('creates review records through the collection persistence path', async () => {
    const reviews = new ContentReviewCollection({} as any);
    const createSpy = vi
      .spyOn(reviews, 'create')
      .mockResolvedValue({ id: 'review-1' } as any);

    const review = await reviews.createFromResult({
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

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contentId: 'content-1',
        kind: 'facts',
        policyKey: 'facts',
        status: 'passed',
      }),
    );
    expect(review).toEqual({ id: 'review-1' });
  });
});
