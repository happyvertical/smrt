import type {
  ApiResponse,
  ContentGovernanceAssignmentData,
  ContentGovernanceDefinitionsData,
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../mock-smrt-client';
import { CONTENT_MODULE_META } from '../ui.js';
import type { ContentGovernanceManagerClient } from './governance-manager-client';

const DEFAULT_CONTENT_PLAYGROUND_API_BASE_URL = '/api/v1';

type ContentPlaygroundGlobal = typeof globalThis & {
  __SMRT_CONTENT_PLAYGROUND_API_BASE_URL__?: string;
  location?: {
    search: string;
  };
};

function resolveContentPlaygroundApiBaseUrl(): string {
  const configuredViaGlobal = (globalThis as ContentPlaygroundGlobal)
    .__SMRT_CONTENT_PLAYGROUND_API_BASE_URL__;
  if (configuredViaGlobal) {
    return configuredViaGlobal;
  }

  const browserLocation = (globalThis as ContentPlaygroundGlobal).location;
  if (browserLocation) {
    const configuredViaQuery = new URLSearchParams(browserLocation.search).get(
      'smrtContentApiBaseUrl',
    );

    if (configuredViaQuery) {
      return configuredViaQuery;
    }
  }

  return DEFAULT_CONTENT_PLAYGROUND_API_BASE_URL;
}

const sampleArticles = [
  {
    id: 'article-aurora-kitchen',
    slug: 'aurora-kitchen-notes',
    title: 'Aurora Kitchen Notes',
    description:
      'A reference article card preview showing how editorial metadata lands in the package playground.',
    publish_date: '2026-03-14T12:00:00.000Z',
    author: 'Editorial Systems',
    tags: ['release', 'editorial', 'qa'],
  },
  {
    id: 'article-governance-habits',
    slug: 'governance-habits',
    title: 'Governance Habits That Scale',
    description:
      'Teams can move fast when quality gates are visible, lightweight, and shared with contributors.',
    publish_date: '2026-03-19T09:30:00.000Z',
    author: 'Content Ops',
    tags: ['governance', 'quality', 'workflows'],
  },
];

const sampleContributions = [
  {
    id: 'contribution-1',
    title: 'Spring buyer guide',
    contributionTypeKey: 'article',
    status: 'needs_changes',
    revisionCount: 2,
    editorNotes: 'Please tighten the sourcing notes in the opening section.',
    contributorName: 'Taylor Rowan',
    contributorEmail: 'taylor@example.com',
    intakeDecision: 'needs_changes',
    body: 'The spring buyer guide draft is attached, with sourcing notes for the opening section and the product comparison appendix.',
    updatedAt: '2026-03-20T15:18:00.000Z',
  },
  {
    id: 'contribution-2',
    title: 'Field report: Pacific logistics',
    contributionTypeKey: 'report',
    status: 'submitted',
    revisionCount: 1,
    contributorName: 'Jordan Lee',
    contributorEmail: 'jordan@example.com',
    intakeDecision: 'submitted',
    body: 'Field notes from the Pacific corridor include updated shipping windows, route constraints, and operator interviews.',
    updatedAt: '2026-03-18T10:40:00.000Z',
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
        instructions: 'Apply newsroom tone, structure, and clarity guidelines.',
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
        instructions: 'Apply newsroom tone, structure, and clarity guidelines.',
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

const sampleEditorContent = {
  id: 'content-playground-editor',
  slug: 'playground-editor-reference',
  title: 'Reference editorial draft',
  description:
    'A working editor preview with copy, references, and assets already populated.',
  body: `# Editorial Draft

This preview is meant to feel like a real authoring surface.

- tighten the lede
- verify product claims
- attach supporting references`,
  author: 'Editorial Systems',
  type: 'article',
  status: 'draft',
  state: 'active',
  source: 'manual',
  tags: ['editorial', 'playground'],
  referenceIds: ['fact-aurora', 'source-governance'],
  assetIds: [],
  assets: [],
};

const noop = () => {};

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildPlaygroundResponse<T>(data: T): ApiResponse<T> {
  return {
    data,
    success: true,
  };
}

function upsertByIdOrKey<
  T extends {
    id?: string;
    key?: string;
  },
>(items: T[], value: Partial<T>, prefix: string): T[] {
  const id = value.id || `${prefix}-${value.key || items.length + 1}`;
  const nextValue = {
    ...value,
    id,
  } as T;

  const index = items.findIndex(
    (item) => item.id === id || (!!value.key && item.key === value.key),
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

function createGovernancePlaygroundClient(
  seed = sampleGovernanceDefinitions,
): ContentGovernanceManagerClient {
  let policies = cloneValue(seed.effective.policies);
  let profiles = cloneValue(seed.effective.profiles);
  let assignments = cloneValue(seed.effective.assignments);

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

  return {
    contents: {
      getGovernanceDefinitions: async () =>
        buildPlaygroundResponse(getDefinitions()),
    },
    contentGovernancePolicies: {
      create: async (policy: Partial<ContentReviewPolicyData>) => {
        policies = upsertByIdOrKey(policies, policy, 'policy');
        return buildPlaygroundResponse(policies[policies.length - 1]);
      },
      update: async (id: string, policy: Partial<ContentReviewPolicyData>) => {
        policies = upsertByIdOrKey(policies, { ...policy, id }, 'policy');
        return buildPlaygroundResponse(
          policies.find((item) => item.id === id)!,
        );
      },
      delete: async (id: string) => {
        policies = policies.filter((item) => item.id !== id);
        return buildPlaygroundResponse(undefined);
      },
    },
    contentGovernanceProfiles: {
      create: async (profile: Partial<ContentGovernanceProfileData>) => {
        profiles = upsertByIdOrKey(profiles, profile, 'profile');
        return buildPlaygroundResponse(profiles[profiles.length - 1]);
      },
      update: async (
        id: string,
        profile: Partial<ContentGovernanceProfileData>,
      ) => {
        profiles = upsertByIdOrKey(profiles, { ...profile, id }, 'profile');
        return buildPlaygroundResponse(
          profiles.find((item) => item.id === id)!,
        );
      },
      delete: async (id: string) => {
        profiles = profiles.filter((item) => item.id !== id);
        return buildPlaygroundResponse(undefined);
      },
    },
    contentGovernanceAssignments: {
      create: async (assignment: Partial<ContentGovernanceAssignmentData>) => {
        assignments = upsertByIdOrKey(assignments, assignment, 'assignment');
        return buildPlaygroundResponse(assignments[assignments.length - 1]);
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
        return buildPlaygroundResponse(
          assignments.find((item) => item.id === id)!,
        );
      },
      delete: async (id: string) => {
        assignments = assignments.filter((item) => item.id !== id);
        return buildPlaygroundResponse(undefined);
      },
    },
  };
}

const markdownExample = `# Content Playground

This preview module lives in \`src/svelte/playground.ts\`.

- Package-owned previews stay close to the real components
- The shared host simply discovers and renders them
- Live entries can still point at the package's generated API routes`;

// Keep the published playground module importable from Node so `smrt
// playground list` can inspect entry metadata without needing a Svelte loader.
const loadArticleCard = () => import('./components/ArticleCard.svelte');
const loadArticleList = () => import('./components/ArticleList.svelte');
const loadContentEditor = () => import('./components/ContentEditor.svelte');
const loadContentContributionInbox = () =>
  import('./components/ContentContributionInbox.svelte');
const loadContentContributionPortal = () =>
  import('./components/ContentContributionPortal.svelte');
const loadContentGovernanceManager = () =>
  import('./components/ContentGovernanceManager.svelte');
const loadMarkdown = () => import('./components/Markdown.svelte');
const governancePlaygroundClient = createGovernancePlaygroundClient();

export default {
  packageName: '@happyvertical/smrt-content',
  displayName: 'Content',
  description: CONTENT_MODULE_META.description,
  moduleMeta: CONTENT_MODULE_META,
  entries: [
    {
      id: 'article-card',
      slotId: 'article-card',
      title: 'Article Card',
      description: 'Editorial teaser card with tags and metadata.',
      loadComponent: loadArticleCard,
      order: 1,
      props: {
        article: sampleArticles[0],
        showTags: true,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'article-list',
      slotId: 'article-list',
      title: 'Article List',
      description: 'Reference list/grid layout for published content.',
      loadComponent: loadArticleList,
      order: 2,
      props: {
        articles: sampleArticles,
        showTags: true,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'markdown',
      slotId: 'markdown',
      title: 'Markdown Renderer',
      description: 'Safe markdown rendering with a small editorial snippet.',
      loadComponent: loadMarkdown,
      order: 3,
      props: {
        content: markdownExample,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'content-editor',
      title: 'Content Editor',
      description: 'Authoring surface for body copy, references, and media.',
      loadComponent: loadContentEditor,
      order: 4,
      props: {
        apiBaseUrl: resolveContentPlaygroundApiBaseUrl(),
        content: sampleEditorContent,
        contentId: sampleEditorContent.id,
        agentChatEnabled: false,
        agentChatNotice:
          'The shared playground keeps the editor preview local. Run the content package app when you want the live agent chat routes too.',
        onSave: noop,
        onCancel: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'contribution-portal',
      title: 'Contribution Portal',
      description: 'Contributor-facing inbox and submission status view.',
      loadComponent: loadContentContributionPortal,
      order: 5,
      props: {
        contributions: sampleContributions,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'contribution-inbox',
      title: 'Contribution Inbox',
      description:
        'Editorial review queue for approving, rejecting, or requesting changes.',
      loadComponent: loadContentContributionInbox,
      order: 6,
      props: {
        contributions: sampleContributions,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'governance-manager',
      title: 'Governance Manager',
      description:
        'Administrative view with in-memory mock data and optional live package routes.',
      loadComponent: loadContentGovernanceManager,
      order: 7,
      modes: {
        mock: {
          label: 'Mock',
          description:
            'Uses an in-memory governance client so the shared playground works without a package-local dev server.',
          props: {
            client: governancePlaygroundClient,
          },
        },
        live: {
          label: 'Live',
          description:
            'Requires the content package dev server and generated routes. Override the base URL with ?smrtContentApiBaseUrl=... or window.__SMRT_CONTENT_PLAYGROUND_API_BASE_URL__ when needed.',
          props: {
            apiBaseUrl: resolveContentPlaygroundApiBaseUrl(),
          },
        },
      },
    },
  ],
};
