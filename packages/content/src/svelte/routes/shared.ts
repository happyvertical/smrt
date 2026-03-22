import type {
  SmrtRouteLoadKind,
  SmrtRouteNavigationItem,
  SmrtRouteNavigationMeta,
} from '@happyvertical/smrt-types';
import type {
  ContentData,
  ContentTransparencyData,
} from '../../mock-smrt-client.js';

export const CONTENT_ROUTE_IDS = {
  workspace: 'content.workspace',
  governance: 'content.governance',
  contributions: 'content.contributions',
  article: 'content.article',
} as const;

export type ContentRouteKey = keyof typeof CONTENT_ROUTE_IDS;
export type ContentRouteId = (typeof CONTENT_ROUTE_IDS)[ContentRouteKey];

interface ContentRouteMeta {
  id: ContentRouteId;
  title: string;
  description: string;
  defaultPath: string;
  loadKind?: SmrtRouteLoadKind;
  nav?: SmrtRouteNavigationMeta;
}

export interface ContentRouteNavigationItem extends SmrtRouteNavigationItem {
  routeId: ContentRouteId;
}

export interface PublishedContentArticleRouteData {
  content: ContentData;
  transparency: ContentTransparencyData | null;
}

export interface LoadPublishedArticleRouteInput {
  fetch: typeof globalThis.fetch;
  slug: string;
  apiBasePath?: string;
}

export const CONTENT_ROUTE_META = {
  workspace: {
    id: CONTENT_ROUTE_IDS.workspace,
    title: 'Contents',
    description:
      'Author, review, and publish content records against the content module workflows.',
    defaultPath: '/workspace',
    nav: {
      label: 'Workspace',
      description: 'Authoring and publishing workspace',
      icon: 'file-text',
      order: 10,
      group: 'content',
    },
  },
  governance: {
    id: CONTENT_ROUTE_IDS.governance,
    title: 'Governance Admin',
    description:
      'Manage review policies, profiles, and publication assignments for governed content.',
    defaultPath: '/governance',
    nav: {
      label: 'Governance QA',
      description: 'Policy, profile, and assignment management',
      icon: 'shield-check',
      order: 20,
      group: 'content',
    },
  },
  contributions: {
    id: CONTENT_ROUTE_IDS.contributions,
    title: 'Contribution Intake and Review',
    description:
      'Review contributor submissions, moderation state, and promotion flows into content.',
    defaultPath: '/contributions',
    nav: {
      label: 'Contribution QA',
      description: 'Contributor intake, moderation, and promotion',
      icon: 'inbox',
      order: 30,
      group: 'content',
    },
  },
  article: {
    id: CONTENT_ROUTE_IDS.article,
    title: 'Published article',
    description:
      'Render a published content record with its public transparency information.',
    defaultPath: '/articles/[slug]',
    loadKind: 'page',
  },
} as const satisfies Record<ContentRouteKey, ContentRouteMeta>;

type ContentNavigableRouteKey = Exclude<ContentRouteKey, 'article'>;

const CONTENT_NAV_ROUTE_KEYS = [
  'workspace',
  'governance',
  'contributions',
] as const satisfies readonly ContentNavigableRouteKey[];

export function getContentRouteDefaultPath(routeId: ContentRouteId): string {
  const route = Object.values(CONTENT_ROUTE_META).find(
    (entry) => entry.id === routeId,
  );
  if (!route) {
    throw new Error(`Unknown content route id: ${routeId}`);
  }

  return route.defaultPath;
}

export function buildPublishedArticlePath(
  slug: string,
  basePath = CONTENT_ROUTE_META.article.defaultPath,
): string {
  const normalizedBase = basePath.replace(/\/\[[^/]+\]$/, '');
  return `${normalizedBase}/${slug}`;
}

export function createContentRouteNavigation(
  pathOverrides: Partial<Record<ContentRouteId, string>> = {},
): ContentRouteNavigationItem[] {
  return CONTENT_NAV_ROUTE_KEYS.map((routeKey) => {
    const route = CONTENT_ROUTE_META[routeKey];

    return {
      routeId: route.id,
      href: pathOverrides[route.id] || route.defaultPath,
      label: route.nav.label,
      description: route.nav.description,
      icon: route.nav.icon,
      order: route.nav.order,
      group: route.nav.group,
    };
  }).sort((left, right) => (left.order || 0) - (right.order || 0));
}

export const CONTENT_DEFAULT_ROUTE_NAVIGATION = createContentRouteNavigation();

export function getContentRouteHref(
  navigation: ContentRouteNavigationItem[],
  routeId: ContentRouteId,
): string {
  return (
    navigation.find((item) => item.routeId === routeId)?.href ||
    getContentRouteDefaultPath(routeId)
  );
}
