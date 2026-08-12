import type {
  ApiResponse,
  ContentContributionData,
  ContentContributionTypeConfigStateData,
  ContentContributionTypeData,
  ContentContributorData,
  ContentData,
  ContentGovernanceAssignmentData,
  ContentGovernanceDefinitionsData,
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
  FactData,
  ResolvedContentGovernanceData,
} from './mock-smrt-client.js';
import {
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_MODULE,
  createContentRouteNavigation,
} from './route-module.js';
import playground from './svelte/playground.js';

const sampleContents: ContentData[] = [
  {
    id: 'content-workbench-brief',
    slug: 'workbench-editorial-brief',
    title: 'Workbench Editorial Brief',
    description:
      'A draft content record used to exercise the shared route shell.',
    body: '## Editorial Brief\n\nThis fixture is served by the workbench route module so the authoring route can render inline.',
    bodyFormat: 'markdown',
    author: 'Content Systems',
    type: 'article',
    status: 'draft',
    state: 'active',
    source: 'manual',
    factIds: ['fact-workbench-route'],
    createdAt: '2026-03-20T12:00:00.000Z',
    updatedAt: '2026-03-20T12:00:00.000Z',
  },
  {
    id: 'content-workbench-published',
    slug: 'shared-route-workbench',
    title: 'Shared Route Workbench',
    description:
      'Published sample content with a slug so the workspace can show the public route affordance.',
    body: 'Shared routes render inside one Workbench app instead of redirecting to package-local dev servers.',
    bodyFormat: 'markdown',
    author: 'Content Ops',
    type: 'article',
    status: 'published',
    state: 'active',
    source: 'manual',
    publish_date: '2026-03-21T09:00:00.000Z',
    factIds: ['fact-workbench-route', 'fact-governance-visible'],
    createdAt: '2026-03-19T15:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
  },
];

const sampleFacts: FactData[] = [
  {
    id: 'fact-workbench-route',
    textRaw: 'Workbench route demos render inside the shared workbench host.',
    textRefined:
      'Workbench route demos render inside the shared workbench host.',
    status: 'active',
    domain: 'developer-tools',
    confidence: 0.94,
    sourceCount: 3,
    metadata: {
      package: '@happyvertical/smrt-content',
      source: 'workbench',
    },
    createdAt: '2026-03-20T12:00:00.000Z',
    updatedAt: '2026-03-20T12:00:00.000Z',
  },
  {
    id: 'fact-governance-visible',
    textRaw: 'Governance policies should be visible before publishing.',
    textRefined: 'Governance policies should be visible before publishing.',
    status: 'active',
    domain: 'content-governance',
    confidence: 0.88,
    sourceCount: 2,
    metadata: {
      policy: 'facts',
    },
    createdAt: '2026-03-18T16:00:00.000Z',
    updatedAt: '2026-03-19T10:00:00.000Z',
  },
];

const sampleGovernanceDefinitions: ContentGovernanceDefinitionsData = {
  effective: {
    policies: [
      {
        id: 'policy-facts',
        key: 'facts',
        label: 'Facts review',
        kind: 'facts',
        instructions: 'Compare claims against linked facts before publication.',
        enabled: true,
      },
      {
        id: 'policy-style',
        key: 'style',
        label: 'Style review',
        kind: 'custom',
        instructions: 'Apply editorial style and clarity guidelines.',
        enabled: true,
      },
    ],
    profiles: [
      {
        id: 'profile-publication',
        key: 'publication',
        label: 'Publication',
        description: 'Required before governed content can be published.',
        enabled: true,
        requirements: [
          {
            policyKey: 'facts',
            label: 'Facts review',
            blocking: true,
            acceptedStatuses: ['passed'],
          },
          {
            policyKey: 'style',
            label: 'Style review',
            blocking: false,
            acceptedStatuses: ['passed', 'warning'],
          },
        ],
      },
    ],
    assignments: [
      {
        id: 'assignment-article',
        key: 'article',
        label: 'Articles',
        contentType: 'article',
        contentVariant: null,
        enabled: true,
        factLinkingEnabled: true,
        transparencyEnabled: true,
        publicationProfileKey: 'publication',
        correctionProfileKey: null,
        enforcePublishReadiness: true,
        defaultFactRelationship: 'supports',
      },
    ],
  },
  persisted: {
    policies: [
      {
        id: 'policy-style',
        key: 'style',
        label: 'Style review',
        kind: 'custom',
        instructions: 'Apply editorial style and clarity guidelines.',
        enabled: true,
      },
    ],
    profiles: [
      {
        id: 'profile-publication',
        key: 'publication',
        label: 'Publication',
        description: 'Required before governed content can be published.',
        enabled: true,
        requirements: [
          {
            policyKey: 'facts',
            label: 'Facts review',
            blocking: true,
            acceptedStatuses: ['passed'],
          },
          {
            policyKey: 'style',
            label: 'Style review',
            blocking: false,
            acceptedStatuses: ['passed', 'warning'],
          },
        ],
      },
    ],
    assignments: [
      {
        id: 'assignment-article',
        key: 'article',
        label: 'Articles',
        contentType: 'article',
        contentVariant: null,
        enabled: true,
        factLinkingEnabled: true,
        transparencyEnabled: true,
        publicationProfileKey: 'publication',
        correctionProfileKey: null,
        enforcePublishReadiness: true,
        defaultFactRelationship: 'supports',
      },
    ],
  },
};

const sampleContributionTypes: ContentContributionTypeData[] = [
  {
    id: 'type-article',
    key: 'article',
    label: 'Article pitch',
    enabled: true,
    allowedChannels: ['web', 'email'],
    allowText: true,
    allowFiles: true,
    allowEmptyText: false,
    intakeRules: {
      requireTitle: true,
    },
  },
  {
    id: 'type-field-report',
    key: 'field-report',
    label: 'Field report',
    enabled: true,
    allowedChannels: ['web'],
    allowText: true,
    allowFiles: false,
    allowEmptyText: false,
  },
];

const sampleContributors: ContentContributorData[] = [
  {
    id: 'contributor-taylor',
    email: 'taylor@example.com',
    name: 'Taylor Rowan',
    trustLevel: 'trusted',
  },
  {
    id: 'contributor-jordan',
    email: 'jordan@example.com',
    name: 'Jordan Lee',
    trustLevel: 'new',
  },
];

const sampleContributions: ContentContributionData[] = [
  {
    id: 'contribution-spring-guide',
    contributorId: 'contributor-taylor',
    contributionTypeKey: 'article',
    status: 'needs_changes',
    intakeDecision: 'needs_changes',
    channel: 'web',
    title: 'Spring buyer guide',
    description: 'Draft guide with sourcing notes for editorial review.',
    body: 'The spring buyer guide draft includes product comparisons and sourcing notes.',
    contributorEmail: 'taylor@example.com',
    contributorName: 'Taylor Rowan',
    revisionCount: 2,
    editorNotes: 'Please tighten the sourcing notes in the opening section.',
    updatedAt: '2026-03-20T15:18:00.000Z',
  },
  {
    id: 'contribution-field-report',
    contributorId: 'contributor-jordan',
    contributionTypeKey: 'field-report',
    status: 'submitted',
    intakeDecision: 'submitted',
    channel: 'web',
    title: 'Field report: Pacific logistics',
    description: 'Field notes from the Pacific corridor.',
    body: 'Updated shipping windows, route constraints, and operator interviews.',
    contributorEmail: 'jordan@example.com',
    contributorName: 'Jordan Lee',
    revisionCount: 1,
    updatedAt: '2026-03-18T10:40:00.000Z',
  },
];

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function buildResponse<T>(data: T): ApiResponse<T> {
  return {
    data: cloneValue(data),
    success: true,
  };
}

function upsertByIdOrKey<T extends { id?: string; key?: string }>(
  items: T[],
  value: Partial<T>,
  prefix: string,
): T[] {
  const id = value.id || `${prefix}-${value.key || items.length + 1}`;
  const nextValue = {
    ...value,
    id,
  } as T;
  const index = items.findIndex(
    (item) => item.id === id || Boolean(value.key && item.key === value.key),
  );

  if (index === -1) {
    return [...items, nextValue];
  }

  const nextItems = [...items];
  nextItems[index] = {
    ...nextItems[index],
    ...nextValue,
  };
  return nextItems;
}

function createContentWorkbenchClient() {
  let contents = cloneValue(sampleContents);
  let facts = cloneValue(sampleFacts);
  let policies = cloneValue(sampleGovernanceDefinitions.effective.policies);
  let profiles = cloneValue(sampleGovernanceDefinitions.effective.profiles);
  let assignments = cloneValue(
    sampleGovernanceDefinitions.effective.assignments,
  );
  let contributionTypes = cloneValue(sampleContributionTypes);
  let contributors = cloneValue(sampleContributors);
  let contributions = cloneValue(sampleContributions);

  const getDefinitions = (): ContentGovernanceDefinitionsData => ({
    effective: {
      policies: cloneValue(policies),
      profiles: cloneValue(profiles),
      assignments: cloneValue(assignments),
    },
    persisted: {
      policies: cloneValue(policies),
      profiles: cloneValue(profiles),
      assignments: cloneValue(assignments),
    },
  });

  const resolveGovernance = (
    type?: string,
    variant?: string | null,
  ): ResolvedContentGovernanceData => {
    const assignment =
      assignments.find(
        (item) =>
          item.contentType === type &&
          (item.contentVariant || null) === (variant || null),
      ) ||
      assignments.find((item) => item.contentType === type) ||
      assignments[0] ||
      null;

    return {
      isGoverned: Boolean(assignment),
      factLinkingEnabled: assignment?.factLinkingEnabled ?? true,
      transparencyEnabled: assignment?.transparencyEnabled ?? true,
      publicationProfileKey: assignment?.publicationProfileKey || null,
      correctionProfileKey: assignment?.correctionProfileKey || null,
      enforcePublishReadiness:
        assignment?.enforcePublishReadiness ?? Boolean(assignment),
      defaultFactRelationship:
        assignment?.defaultFactRelationship || 'supports',
      reviewPolicies: cloneValue(policies),
      availableProfiles: cloneValue(profiles),
      assignment: cloneValue(assignment),
    };
  };

  const updateContributionStatus = (
    id: string,
    status: string,
    extra: Partial<ContentContributionData> = {},
  ) => {
    contributions = contributions.map((item) =>
      item.id === id
        ? {
            ...item,
            status,
            intakeDecision: status,
            updatedAt: new Date().toISOString(),
            ...extra,
          }
        : item,
    );
    return contributions.find((item) => item.id === id) || null;
  };

  const getContributionTypes = (): ContentContributionTypeConfigStateData => ({
    effective: cloneValue(contributionTypes),
    persisted: cloneValue(contributionTypes),
  });

  return {
    contents: {
      list: async () => buildResponse(contents),
      get: async (id: string) =>
        buildResponse(contents.find((item) => item.id === id) || contents[0]),
      create: async (content: Partial<ContentData>) => {
        const nextContent: ContentData = {
          type: 'article',
          status: 'draft',
          state: 'active',
          source: 'manual',
          ...content,
          id: content.id || `content-workbench-${contents.length + 1}`,
          updatedAt: new Date().toISOString(),
        };
        contents = [nextContent, ...contents];
        return buildResponse(nextContent);
      },
      update: async (id: string, updates: Partial<ContentData>) => {
        contents = contents.map((item) =>
          item.id === id
            ? {
                ...item,
                ...updates,
                id,
                updatedAt: new Date().toISOString(),
              }
            : item,
        );
        return buildResponse(
          contents.find((item) => item.id === id) || contents[0],
        );
      },
      delete: async (id: string) => {
        contents = contents.filter((item) => item.id !== id);
        return buildResponse(undefined);
      },
      browseFacts: async (
        query = '',
        _options: Record<string, unknown> = {},
      ) => {
        const normalizedQuery = query.trim().toLowerCase();
        facts = cloneValue(sampleFacts);
        return buildResponse(
          normalizedQuery
            ? facts.filter((fact) =>
                [
                  fact.textRaw,
                  fact.textRefined,
                  fact.domain,
                  JSON.stringify(fact.metadata || {}),
                ]
                  .join(' ')
                  .toLowerCase()
                  .includes(normalizedQuery),
              )
            : facts,
        );
      },
      getGovernanceDefinitions: async () => buildResponse(getDefinitions()),
      resolveGovernance: async (options: {
        type?: string;
        variant?: string | null;
      }) => buildResponse(resolveGovernance(options.type, options.variant)),
    },
    contentGovernancePolicies: {
      create: async (policy: Partial<ContentReviewPolicyData>) => {
        policies = upsertByIdOrKey(policies, policy, 'policy');
        return buildResponse(policies[policies.length - 1]);
      },
      update: async (id: string, policy: Partial<ContentReviewPolicyData>) => {
        policies = upsertByIdOrKey(policies, { ...policy, id }, 'policy');
        return buildResponse(
          policies.find((item) => item.id === id) || policies[0],
        );
      },
      delete: async (id: string) => {
        policies = policies.filter((item) => item.id !== id);
        return buildResponse(undefined);
      },
    },
    contentGovernanceProfiles: {
      create: async (profile: Partial<ContentGovernanceProfileData>) => {
        profiles = upsertByIdOrKey(profiles, profile, 'profile');
        return buildResponse(profiles[profiles.length - 1]);
      },
      update: async (
        id: string,
        profile: Partial<ContentGovernanceProfileData>,
      ) => {
        profiles = upsertByIdOrKey(profiles, { ...profile, id }, 'profile');
        return buildResponse(
          profiles.find((item) => item.id === id) || profiles[0],
        );
      },
      delete: async (id: string) => {
        profiles = profiles.filter((item) => item.id !== id);
        return buildResponse(undefined);
      },
    },
    contentGovernanceAssignments: {
      create: async (assignment: Partial<ContentGovernanceAssignmentData>) => {
        assignments = upsertByIdOrKey(assignments, assignment, 'assignment');
        return buildResponse(assignments[assignments.length - 1]);
      },
      update: async (
        id: string,
        assignment: Partial<ContentGovernanceAssignmentData>,
      ) => {
        assignments = upsertByIdOrKey(
          assignments,
          { ...assignment, id },
          'assignment',
        );
        return buildResponse(
          assignments.find((item) => item.id === id) || assignments[0],
        );
      },
      delete: async (id: string) => {
        assignments = assignments.filter((item) => item.id !== id);
        return buildResponse(undefined);
      },
    },
    contentContributions: {
      getContributionTypes: async () => buildResponse(getContributionTypes()),
      listInbox: async () => buildResponse(contributions),
      listForContributor: async (options: {
        contributorId?: string;
        contributorEmail?: string;
      }) =>
        buildResponse(
          contributions.filter((item) =>
            options.contributorId
              ? item.contributorId === options.contributorId
              : item.contributorEmail === options.contributorEmail,
          ),
        ),
      submitWebContribution: async (
        payload: Partial<ContentContributionData> & {
          typeKey?: string;
          attachments?: unknown[];
        },
      ) => {
        const contributor = contributors.find(
          (item) => item.email === payload.contributorEmail,
        );
        const nextContribution: ContentContributionData = {
          id: `contribution-workbench-${contributions.length + 1}`,
          contributorId: contributor?.id,
          contributionTypeKey: payload.typeKey || payload.contributionTypeKey,
          status: 'submitted',
          intakeDecision: 'submitted',
          channel: 'web',
          title: payload.title,
          description: payload.description,
          body: payload.body,
          contributorEmail: payload.contributorEmail,
          contributorName: payload.contributorName,
          revisionCount: 1,
          updatedAt: new Date().toISOString(),
        };
        contributions = [nextContribution, ...contributions];
        return buildResponse({
          contribution: nextContribution,
        });
      },
      ingestEmailContribution: async (
        payload: Partial<ContentContributionData>,
      ) =>
        buildResponse({
          contribution: {
            ...payload,
            id: `contribution-email-${contributions.length + 1}`,
            status: 'submitted',
          },
        }),
      appendRevision: async (id: string) =>
        buildResponse(
          updateContributionStatus(id, 'submitted', {
            revisionCount:
              (contributions.find((item) => item.id === id)?.revisionCount ||
                0) + 1,
          }),
        ),
      requestChanges: async (id: string) =>
        buildResponse(updateContributionStatus(id, 'needs_changes')),
      approve: async (id: string) =>
        buildResponse(
          updateContributionStatus(id, 'approved', {
            approvedAt: new Date().toISOString(),
          }),
        ),
      reject: async (id: string) =>
        buildResponse(
          updateContributionStatus(id, 'rejected', {
            rejectedAt: new Date().toISOString(),
          }),
        ),
      withdraw: async (id: string) =>
        buildResponse(
          updateContributionStatus(id, 'withdrawn', {
            withdrawnAt: new Date().toISOString(),
          }),
        ),
      promote: async (id: string) =>
        buildResponse(
          updateContributionStatus(id, 'promoted', {
            promotedAt: new Date().toISOString(),
          }),
        ),
    },
    contentContributionTypes: {
      create: async (type: Partial<ContentContributionTypeData>) => {
        contributionTypes = upsertByIdOrKey(
          contributionTypes,
          type,
          'contribution-type',
        );
        return buildResponse(contributionTypes[contributionTypes.length - 1]);
      },
      update: async (
        id: string,
        type: Partial<ContentContributionTypeData>,
      ) => {
        contributionTypes = upsertByIdOrKey(
          contributionTypes,
          { ...type, id },
          'contribution-type',
        );
        return buildResponse(
          contributionTypes.find((item) => item.id === id) ||
            contributionTypes[0],
        );
      },
      delete: async (id: string) => {
        contributionTypes = contributionTypes.filter((item) => item.id !== id);
        return buildResponse(undefined);
      },
    },
    contentContributors: {
      list: async () => buildResponse(contributors),
      create: async (contributor: Partial<ContentContributorData>) => {
        const nextContributor: ContentContributorData = {
          ...contributor,
          id: contributor.id || `contributor-${contributors.length + 1}`,
        };
        contributors = [nextContributor, ...contributors];
        return buildResponse(nextContributor);
      },
      update: async (
        id: string,
        contributor: Partial<ContentContributorData>,
      ) => {
        contributors = contributors.map((item) =>
          item.id === id ? { ...item, ...contributor, id } : item,
        );
        return buildResponse(
          contributors.find((item) => item.id === id) || contributors[0],
        );
      },
      delete: async (id: string) => {
        contributors = contributors.filter((item) => item.id !== id);
        return buildResponse(undefined);
      },
    },
  };
}

const contentWorkbenchClient = createContentWorkbenchClient();
const contentWorkbenchNavigation = createContentRouteNavigation({
  [CONTENT_ROUTE_IDS.workspace]: '#content-workspace',
  [CONTENT_ROUTE_IDS.facts]: '#content-facts',
  [CONTENT_ROUTE_IDS.governance]: '#content-governance',
  [CONTENT_ROUTE_IDS.contributions]: '#content-contributions',
});
const contentRouteProps = {
  embedded: true,
  client: contentWorkbenchClient,
  navigation: contentWorkbenchNavigation,
};

const articleRouteData = {
  content: {
    id: 'workbench-article',
    slug: 'workbench-reference-article',
    title: 'Workbench Reference Article',
    description:
      'Inline route sample rendered inside the shared SMRT workbench.',
    author: 'Content Systems',
    body: '## Reference Article\n\nThis article route is rendered without redirecting to a package-local dev server.',
    bodyFormat: 'markdown',
    publish_date: '2026-03-20T12:00:00.000Z',
    status: 'published',
  },
  transparency: null,
};

const routeModule = {
  ...CONTENT_ROUTE_MODULE,
  routes: {
    workspace: {
      ...CONTENT_ROUTE_MODULE.routes.workspace,
      props: contentRouteProps,
    },
    facts: {
      ...CONTENT_ROUTE_MODULE.routes.facts,
      props: contentRouteProps,
    },
    governance: {
      ...CONTENT_ROUTE_MODULE.routes.governance,
      props: contentRouteProps,
    },
    contributions: {
      ...CONTENT_ROUTE_MODULE.routes.contributions,
      props: contentRouteProps,
    },
    article: {
      ...CONTENT_ROUTE_MODULE.routes.article,
      props: {
        data: articleRouteData,
        backHref: '#content-workspace',
      },
    },
  },
};

export default {
  packageName: '@happyvertical/smrt-content',
  displayName: 'Content',
  description:
    'Workbench surfaces for content authoring, governance, facts, contributions, articles, and package previews.',
  routeModules: [routeModule],
  recommendedCommands: [
    {
      id: 'content:test',
      label: 'Test',
      command: 'pnpm --filter @happyvertical/smrt-content test',
    },
    {
      id: 'content:typecheck',
      label: 'Typecheck',
      command: 'pnpm --filter @happyvertical/smrt-content typecheck',
    },
  ],
  examples: [
    {
      id: 'content:playground',
      title: 'Content playground module',
      path: 'src/svelte/playground.ts',
      source: 'playground',
    },
  ],
};

export { playground };
