import { CONTENT_MODULE_META } from '../ui.js';
import ArticleCard from './components/ArticleCard.svelte';
import ArticleList from './components/ArticleList.svelte';
import ContentContributionInbox from './components/ContentContributionInbox.svelte';
import ContentContributionPortal from './components/ContentContributionPortal.svelte';
import ContentGovernanceManager from './components/ContentGovernanceManager.svelte';
import Markdown from './components/Markdown.svelte';

const DEFAULT_CONTENT_PLAYGROUND_API_BASE_URL = 'http://localhost:5173/api/v1';

type ContentPlaygroundGlobal = typeof globalThis & {
  __SMRT_CONTENT_PLAYGROUND_API_BASE_URL__?: string;
};

function resolveContentPlaygroundApiBaseUrl(): string {
  const configuredViaGlobal = (globalThis as ContentPlaygroundGlobal)
    .__SMRT_CONTENT_PLAYGROUND_API_BASE_URL__;
  if (configuredViaGlobal) {
    return configuredViaGlobal;
  }

  if (typeof globalThis.location !== 'undefined') {
    const configuredViaQuery = new URLSearchParams(
      globalThis.location.search,
    ).get('smrtContentApiBaseUrl');

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

const markdownExample = `# Content Playground

This preview module lives in \`src/svelte/playground.ts\`.

- Package-owned previews stay close to the real components
- The shared host simply discovers and renders them
- Live entries can still point at the package's generated API routes`;

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
      component: ArticleCard,
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
      component: ArticleList,
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
      component: Markdown,
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
      id: 'contribution-portal',
      title: 'Contribution Portal',
      description: 'Contributor-facing inbox and submission status view.',
      component: ContentContributionPortal,
      order: 4,
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
      component: ContentContributionInbox,
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
      id: 'governance-manager',
      title: 'Governance Manager',
      description:
        'Live administrative view driven by the package-local generated API routes.',
      component: ContentGovernanceManager,
      order: 6,
      modes: {
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
