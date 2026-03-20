import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentGovernanceAssignmentKey,
  buildContentReviewPrompt,
  configureContentGovernance,
  getAcceptedContentReviewStatuses,
  getContentGovernanceConfig,
  getContentReviewKind,
  getContentReviewPolicies,
  getContentReviewPolicy,
  getContentReviewProfile,
  getContentReviewProfileKeys,
  getContentReviewRequirements,
  getEffectiveContentGovernanceConfig,
  hasStaticContentGovernancePolicy,
  hasStaticContentGovernanceProfile,
  parseContentReviewResponse,
  resetContentGovernanceConfig,
  resolveConfiguredContentGovernance,
  resolveEffectiveContentGovernance,
} from './content-governance';

afterEach(() => {
  resetContentGovernanceConfig();
  vi.restoreAllMocks();
});

describe('content governance helpers', () => {
  it('configures and resolves governance with exact-match assignment precedence', async () => {
    configureContentGovernance({
      policies: [
        {
          key: 'editorial',
          label: 'Editorial Review',
          kind: 'custom',
          instructions: 'Check tone and clarity.',
        },
      ],
      profiles: [
        {
          key: 'medical-publication',
          label: 'Medical Publication',
          requirements: [
            {
              policyKey: 'editorial',
              blocking: true,
            },
          ],
        },
      ],
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
          contentVariant: 'medical',
          enabled: false,
          publicationProfileKey: 'medical-publication',
        },
      ],
    });

    const config = getContentGovernanceConfig();
    expect(config.policies.map((policy) => policy.key)).toContain('editorial');
    expect(getContentReviewPolicy('editorial')?.label).toBe('Editorial Review');
    expect(getContentReviewKind('facts')).toBe('facts');
    expect(getContentReviewKind('editorial')).toBe('custom');
    expect(getContentReviewPolicies().map((policy) => policy.key)).toEqual(
      expect.arrayContaining(['facts', 'safety', 'editorial']),
    );
    expect(getContentReviewProfile('publication')?.key).toBe('publication');
    expect(getContentReviewProfileKeys()).toEqual(
      expect.arrayContaining([
        'publication',
        'correction',
        'medical-publication',
      ]),
    );
    expect(getContentReviewRequirements('medical-publication')).toEqual([
      {
        policyKey: 'editorial',
        blocking: true,
      },
    ]);
    expect(
      getAcceptedContentReviewStatuses({
        acceptedStatuses: [],
      }),
    ).toEqual(['passed', 'waived']);
    expect(
      getAcceptedContentReviewStatuses({
        acceptedStatuses: ['passed', 'flagged'],
      }),
    ).toEqual(['passed', 'flagged']);

    const broad = resolveConfiguredContentGovernance({
      contentType: 'article',
    });
    const exactDisabled = resolveConfiguredContentGovernance({
      contentType: 'article',
      contentVariant: 'medical',
    });

    expect(broad.isGoverned).toBe(true);
    expect(broad.factLinkingEnabled).toBe(true);
    expect(exactDisabled.isGoverned).toBe(false);
    expect(exactDisabled.publicationProfileKey).toBeNull();
    expect(exactDisabled.assignment?.key).toBe('article::medical');
    expect(buildContentGovernanceAssignmentKey('article', 'medical')).toBe(
      'article::medical',
    );
    expect(hasStaticContentGovernancePolicy('facts')).toBe(true);
    expect(hasStaticContentGovernanceProfile('publication')).toBe(true);
  });

  it('merges persisted governance definitions on top of configured defaults', async () => {
    configureContentGovernance({
      assignments: [
        {
          contentType: 'article',
          enabled: true,
          publicationProfileKey: 'publication',
        },
      ],
    });

    const db = {
      list: vi.fn(async (table: string) => {
        switch (table) {
          case 'content_governance_policies':
            return [
              {
                key: 'facts',
                label: 'Persisted Facts Review',
                kind: 'facts',
                instructions: 'Persisted facts instructions',
                enabled: 1,
                metadata: '{"source":"admin"}',
                created_at: '2026-03-20T08:00:00.000Z',
              },
            ];
          case 'content_governance_profiles':
            return [
              {
                key: 'publication',
                label: 'Publication Override',
                enabled: 1,
                requirements: JSON.stringify([
                  { policyKey: 'facts', blocking: true },
                ]),
                metadata: '{"source":"admin"}',
                created_at: '2026-03-20T08:05:00.000Z',
              },
            ];
          case 'content_governance_assignments':
            return [
              {
                key: 'article::',
                content_type: 'article',
                enabled: 1,
                fact_linking_enabled: 1,
                transparency_enabled: 1,
                publication_profile_key: 'publication',
                enforce_publish_readiness: 1,
                default_fact_relationship: 'supports',
                metadata: '{"source":"admin"}',
                created_at: '2026-03-20T08:10:00.000Z',
              },
            ];
          default:
            return [];
        }
      }),
    } as any;

    const effective = await getEffectiveContentGovernanceConfig({ db });
    const resolved = await resolveEffectiveContentGovernance({
      contentType: 'article',
      db,
    });

    expect(
      effective.policies.find((policy) => policy.key === 'facts'),
    ).toMatchObject({
      label: 'Persisted Facts Review',
      metadata: { source: 'admin' },
    });
    expect(
      effective.profiles.find((profile) => profile.key === 'publication'),
    ).toMatchObject({
      label: 'Publication Override',
      requirements: [{ policyKey: 'facts', blocking: true }],
    });
    expect(resolved.isGoverned).toBe(true);
    expect(resolved.transparencyEnabled).toBe(true);
    expect(resolved.enforcePublishReadiness).toBe(true);
  });

  it('gracefully ignores missing governance tables', async () => {
    const db = {
      list: vi.fn(async () => {
        throw new Error("Run 'smrt db:migrate' to create missing tables");
      }),
    } as any;

    await expect(
      getEffectiveContentGovernanceConfig({ db }),
    ).resolves.toMatchObject({
      policies: expect.arrayContaining([
        expect.objectContaining({ key: 'facts' }),
        expect.objectContaining({ key: 'safety' }),
      ]),
      profiles: expect.arrayContaining([
        expect.objectContaining({ key: 'publication' }),
        expect.objectContaining({ key: 'correction' }),
      ]),
    });
  });

  it('builds structured prompts and parses JSON or fallback review outputs', () => {
    const prompt = buildContentReviewPrompt({
      kind: 'facts',
      content: {
        id: 'content-1',
        type: 'article',
        status: 'draft',
        state: 'draft',
        title: 'River update',
        description: 'Flooding continues',
        body: 'The river rose by two metres.',
        author: 'Reporter',
        publish_date: new Date('2026-03-20T08:00:00.000Z'),
      } as any,
      facts: [
        {
          id: 'fact-1',
          status: 'accepted',
          confidence: 0.92,
          sourceCount: 2,
          textRefined: 'The river rose by two metres.',
        } as any,
      ],
      policy: {
        key: 'facts',
        label: 'Facts Review',
        kind: 'facts',
        instructions: 'Use only supplied facts.',
      },
      customInstructions: 'Be strict.',
    });

    expect(prompt).toContain('Review kind: facts');
    expect(prompt).toContain('Policy key: facts');
    expect(prompt).toContain('Be strict.');
    expect(prompt).toContain('[fact-1]');

    expect(
      parseContentReviewResponse(
        'Noise before {"status":"passed","summary":"Looks good","findings":[{"severity":"error","title":"Fix claim","detail":"Unsupported","factId":"fact-1","quote":"claim","suggestedChange":"revise","ruleId":"facts"}]} noise after',
      ),
    ).toEqual({
      status: 'passed',
      summary: 'Looks good',
      findings: [
        {
          severity: 'error',
          title: 'Fix claim',
          detail: 'Unsupported',
          factId: 'fact-1',
          quote: 'claim',
          suggestedChange: 'revise',
          ruleId: 'facts',
        },
      ],
    });

    expect(parseContentReviewResponse('unstructured feedback')).toEqual({
      status: 'flagged',
      summary: 'unstructured feedback',
      findings: [
        {
          severity: 'warning',
          title: 'Unstructured review output',
          detail: 'unstructured feedback',
        },
      ],
    });
  });
});
