/**
 * Mock SMRT Client for Content Service - Temporary implementation for demo purposes
 *
 * This replaces the missing @smrt/client virtual module with a working implementation
 * that demonstrates the intended functionality.
 */

export interface ContentData {
  id?: string;
  references?: any;
  type?: any;
  variant?: any;
  fileKey?: any;
  author?: any;
  title?: any;
  description?: any;
  body?: any;
  publish_date?: any;
  url?: any;
  source?: any;
  status?: any;
  state?: any;
  metadata?: Record<string, any>;
  thumbnailAssetId?: string | null;
  referenceIds?: string[];
  assetIds?: string[];
  assets?: any[];
  factIds?: string[];
  facts?: FactData[];
  factLinks?: FactLinkData[];
  isFactual?: boolean;
  _meta_type?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FactData {
  id?: string;
  textRaw?: string | null;
  textRefined?: string | null;
  status?: string | null;
  domain?: string | null;
  confidence?: number | null;
  sourceCount?: number | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface FactLinkData {
  id?: string;
  factId?: string;
  contentId?: string;
  relationship?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentReviewFindingData {
  severity?: string;
  title?: string;
  detail?: string;
  factId?: string;
  quote?: string;
  suggestedChange?: string;
  ruleId?: string;
}

export interface ContentReviewData {
  id?: string;
  contentId?: string;
  contentVersionId?: string | null;
  kind?: string | null;
  policyKey?: string | null;
  reviewer?: string | null;
  status?: string | null;
  summary?: string | null;
  findings?: ContentReviewFindingData[];
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentCorrectionData {
  id?: string;
  contentId?: string;
  contentVersionId?: string | null;
  correctionType?: string | null;
  status?: string | null;
  factId?: string | null;
  correctedFactId?: string | null;
  summary?: string | null;
  incorrectText?: string | null;
  correctedText?: string | null;
  publicNote?: string | null;
  publishedAt?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentVersionData {
  id?: string;
  contentId?: string;
  version?: number | null;
  kind?: string | null;
  summary?: string | null;
  snapshot?: Record<string, any>;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentReviewProfileRequirementData {
  kind?: string;
  policyKey: string;
  label: string;
  blocking: boolean;
  acceptedStatuses: string[];
  missing: boolean;
  executed: boolean;
  satisfied: boolean;
  latestReviewId: string | null;
  latestStatus: string | null;
  latestSummary: string | null;
}

export interface ContentReviewProfileData {
  profileKey: string;
  ready: boolean;
  complete: boolean;
  requirements: ContentReviewProfileRequirementData[];
}

export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
}

function getListData<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { result?: unknown[] }).result)
  ) {
    return (payload as { result: T[] }).result;
  }

  if (
    payload &&
    typeof payload === 'object' &&
    (payload as { result?: unknown }).result &&
    typeof (payload as { result?: unknown }).result === 'object' &&
    Array.isArray(
      ((payload as { result?: { data?: unknown[] } }).result as any)?.data,
    )
  ) {
    return (payload as { result: { data: T[] } }).result.data;
  }

  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { data?: unknown[] }).data)
  ) {
    return (payload as { data: T[] }).data;
  }

  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { items?: unknown[] }).items)
  ) {
    return (payload as { items: T[] }).items;
  }

  return [];
}

function getItemData<T>(payload: T | { data?: T }): T {
  if (payload && typeof payload === 'object' && 'result' in payload) {
    return (payload as { result: T }).result;
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}

function toQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

class ApiClient {
  constructor(public baseUrl: string) {}

  contents = {
    list: async (): Promise<ApiResponse<ContentData[]>> => {
      const res = await fetch(`${this.baseUrl}/contents`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getListData(payload), success: true };
    },

    get: async (id: string): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },

    create: async (
      contentData: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contentData),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },

    update: async (
      id: string,
      updates: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined, success: true };
    },

    browseFacts: async (
      query = '',
      options: {
        limit?: number;
        minSimilarity?: number;
        includeSuperseded?: boolean;
        latestOnly?: boolean;
      } = {},
    ): Promise<ApiResponse<FactData[]>> => {
      const res = await fetch(
        `${this.baseUrl}/contents/facts${toQueryString({
          q: query,
          limit: options.limit,
          minSimilarity: options.minSimilarity,
          includeSuperseded: options.includeSuperseded,
          latestOnly: options.latestOnly,
        })}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getListData<FactData>(payload), success: true };
    },

    getFacts: async (
      id: string,
      relationship?: string,
    ): Promise<
      ApiResponse<{
        factIds: string[];
        facts: FactData[];
        factLinks: FactLinkData[];
      }>
    > => {
      const res = await fetch(
        `${this.baseUrl}/contents/${id}/facts${toQueryString({
          relationship,
        })}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData(payload), success: true };
    },

    syncFacts: async (
      id: string,
      data: {
        factIds: string[];
        relationship?: string;
      },
    ): Promise<
      ApiResponse<{
        factIds: string[];
        facts: FactData[];
        factLinks: FactLinkData[];
        sync?: {
          added: string[];
          kept: string[];
          removed: string[];
        };
      }>
    > => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/facts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return {
        data: {
          ...getItemData(payload),
          sync: payload.sync,
        },
        success: true,
      };
    },

    getReviews: async (
      id: string,
      kind?: string,
    ): Promise<ApiResponse<ContentReviewData[]>> => {
      const res = await fetch(
        `${this.baseUrl}/contents/${id}/reviews${toQueryString({ kind })}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getListData<ContentReviewData>(payload), success: true };
    },

    getReviewProfiles: async (
      id: string,
    ): Promise<ApiResponse<ContentReviewProfileData[]>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/review-profiles`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return {
        data: getListData<ContentReviewProfileData>(payload),
        success: true,
      };
    },

    getReviewProfile: async (
      id: string,
      profileKey: string,
    ): Promise<ApiResponse<ContentReviewProfileData>> => {
      const res = await fetch(
        `${this.baseUrl}/contents/${id}/review-profiles/${encodeURIComponent(
          profileKey,
        )}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return {
        data: getItemData<ContentReviewProfileData>(payload),
        success: true,
      };
    },

    runReview: async (
      id: string,
      data: Record<string, any>,
    ): Promise<ApiResponse<ContentReviewData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentReviewData>(payload), success: true };
    },

    getCorrections: async (
      id: string,
    ): Promise<ApiResponse<ContentCorrectionData[]>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/corrections`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return {
        data: getListData<ContentCorrectionData>(payload),
        success: true,
      };
    },

    issueCorrection: async (
      id: string,
      data: Record<string, any>,
    ): Promise<ApiResponse<ContentCorrectionData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/corrections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return {
        data: getItemData<ContentCorrectionData>(payload),
        success: true,
      };
    },

    getVersions: async (
      id: string,
    ): Promise<ApiResponse<ContentVersionData[]>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/versions`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getListData<ContentVersionData>(payload), success: true };
    },

    createVersion: async (
      id: string,
      data: Record<string, any>,
    ): Promise<ApiResponse<ContentVersionData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return {
        data: getItemData<ContentVersionData>(payload),
        success: true,
      };
    },

    restoreVersion: async (
      id: string,
      versionNumber: number,
    ): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'restore',
          versionNumber,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },
  };
}

export function createClient(baseUrl = '/api/v1'): ApiClient {
  return new ApiClient(baseUrl);
}

export default createClient;
