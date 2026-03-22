/**
 * Mock SMRT Client for Content Service - Temporary implementation for demo purposes
 *
 * This replaces the missing @smrt/client virtual module with a working implementation
 * that demonstrates the intended functionality.
 */

import type { ContentTransparencyData as ContentTransparencyShape } from './content-transparency';

export type ContentTransparencyData = ContentTransparencyShape;

export interface ContentData {
  id?: string;
  slug?: string | null;
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

export interface ContentReviewPolicyData {
  id?: string;
  key: string;
  label: string;
  kind: string;
  instructions: string;
  enabled?: boolean;
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
  stale?: boolean;
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

export interface ContentGovernanceProfileData {
  id?: string;
  key: string;
  label: string;
  description?: string;
  enabled?: boolean;
  requirements: Array<{
    policyKey: string;
    label?: string;
    blocking?: boolean;
    acceptedStatuses?: string[];
  }>;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentGovernanceAssignmentData {
  id?: string;
  key?: string;
  label?: string;
  contentType: string;
  contentVariant?: string | null;
  enabled?: boolean;
  factLinkingEnabled?: boolean;
  transparencyEnabled?: boolean;
  publicationProfileKey?: string | null;
  correctionProfileKey?: string | null;
  enforcePublishReadiness?: boolean;
  defaultFactRelationship?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolvedContentGovernanceData {
  isGoverned: boolean;
  factLinkingEnabled: boolean;
  transparencyEnabled: boolean;
  publicationProfileKey: string | null;
  correctionProfileKey: string | null;
  enforcePublishReadiness: boolean;
  defaultFactRelationship: string;
  reviewPolicies: ContentReviewPolicyData[];
  availableProfiles: ContentGovernanceProfileData[];
  assignment: ContentGovernanceAssignmentData | null;
}

export interface ContentGovernanceStateData
  extends ResolvedContentGovernanceData {
  reviewProfiles: ContentReviewProfileData[];
}

export interface ContentGovernanceDefinitionsData {
  effective: {
    policies: ContentReviewPolicyData[];
    profiles: ContentGovernanceProfileData[];
    assignments: ContentGovernanceAssignmentData[];
  };
  persisted: {
    policies: ContentReviewPolicyData[];
    profiles: ContentGovernanceProfileData[];
    assignments: ContentGovernanceAssignmentData[];
  };
}

export interface ContentContributionAttachmentData {
  id?: string;
  contributionId?: string;
  revisionId?: string | null;
  filename?: string;
  mimeType?: string | null;
  size?: number | null;
  fileKey?: string | null;
  sourceUri?: string | null;
  channel?: string | null;
  promotedAssetId?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentContributionRevisionData {
  id?: string;
  contributionId?: string;
  revisionNumber?: number | null;
  channel?: string | null;
  title?: string | null;
  description?: string | null;
  body?: string | null;
  sourceMessageId?: string | null;
  sourceThreadKey?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentContributorData {
  id?: string;
  profileId?: string | null;
  email?: string | null;
  name?: string | null;
  trustLevel?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentContributionTypeData {
  id?: string;
  key: string;
  label: string;
  enabled?: boolean;
  allowedChannels?: string[];
  allowText?: boolean;
  allowFiles?: boolean;
  allowEmptyText?: boolean;
  intakeRules?: Record<string, any>;
  promotion?: Record<string, any>;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentContributionData {
  id?: string;
  contributorId?: string;
  contributionTypeKey?: string;
  status?: string | null;
  intakeDecision?: string | null;
  channel?: string | null;
  title?: string | null;
  description?: string | null;
  body?: string | null;
  contributorEmail?: string | null;
  contributorName?: string | null;
  threadKey?: string | null;
  sourceMessageId?: string | null;
  editorNotes?: string | null;
  promotedContentId?: string | null;
  revisionCount?: number | null;
  approvedAt?: string | null;
  promotedAt?: string | null;
  rejectedAt?: string | null;
  withdrawnAt?: string | null;
  requestedChangesAt?: string | null;
  metadata?: Record<string, any>;
  tenantId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  contributor?: ContentContributorData | null;
  revisions?: ContentContributionRevisionData[];
  attachments?: ContentContributionAttachmentData[];
}

export interface ContentContributionTypeConfigStateData {
  effective: ContentContributionTypeData[];
  persisted: ContentContributionTypeData[];
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

  private async request<T>(
    path: string,
    options?: RequestInit,
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, options);
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    return { data: getItemData<T>(payload), success: true };
  }

  private async requestList<T>(
    path: string,
    options?: RequestInit,
  ): Promise<ApiResponse<T[]>> {
    const res = await fetch(`${this.baseUrl}${path}`, options);
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    return { data: getListData<T>(payload), success: true };
  }

  contents = {
    list: async (): Promise<ApiResponse<ContentData[]>> =>
      this.requestList<ContentData>('/contents'),

    getBySlug: async (
      slug: string,
      options: {
        context?: string;
        status?: string;
      } = {},
    ): Promise<ApiResponse<ContentData | null>> =>
      this.request<ContentData | null>(
        `/contents/by-slug${toQueryString({
          slug,
          context: options.context,
          status: options.status,
        })}`,
      ),

    get: async (id: string): Promise<ApiResponse<ContentData>> =>
      this.request<ContentData>(`/contents/${id}`),

    create: async (
      contentData: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> =>
      this.request<ContentData>('/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contentData),
      }),

    update: async (
      id: string,
      updates: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> =>
      this.request<ContentData>(`/contents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }),

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
    ): Promise<ApiResponse<FactData[]>> =>
      this.requestList<FactData>(
        `/contents/facts${toQueryString({
          q: query,
          limit: options.limit,
          minSimilarity: options.minSimilarity,
          includeSuperseded: options.includeSuperseded,
          latestOnly: options.latestOnly,
        })}`,
      ),

    getFacts: async (
      id: string,
      relationship?: string,
    ): Promise<
      ApiResponse<{
        factIds: string[];
        facts: FactData[];
        factLinks: FactLinkData[];
      }>
    > =>
      this.request(`/contents/${id}/facts${toQueryString({ relationship })}`),

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
    > =>
      this.request(`/contents/${id}/facts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    getReviews: async (
      id: string,
      kind?: string,
    ): Promise<ApiResponse<ContentReviewData[]>> =>
      this.requestList<ContentReviewData>(
        `/contents/${id}/reviews${toQueryString({ kind })}`,
      ),

    getGovernanceState: async (
      id: string,
    ): Promise<ApiResponse<ContentGovernanceStateData>> =>
      this.request<ContentGovernanceStateData>(`/contents/${id}/governance`),

    getGovernanceDefinitions: async (): Promise<
      ApiResponse<ContentGovernanceDefinitionsData>
    > => this.request<ContentGovernanceDefinitionsData>('/contents/governance'),

    resolveGovernance: async (options: {
      type?: string;
      variant?: string | null;
    }): Promise<ApiResponse<ResolvedContentGovernanceData>> =>
      this.request<ResolvedContentGovernanceData>(
        `/contents/governance/resolve${toQueryString({
          type: options.type,
          variant: options.variant,
        })}`,
      ),

    getPublishedTransparency: async (
      id: string,
    ): Promise<ApiResponse<ContentTransparencyData | null>> =>
      this.request<ContentTransparencyData | null>(
        `/contents/${id}/transparency`,
      ),

    getTransparencyPreview: async (
      id: string,
    ): Promise<ApiResponse<ContentTransparencyData | null>> =>
      this.request<ContentTransparencyData | null>(
        `/contents/${id}/transparency/preview`,
      ),

    getReviewProfiles: async (
      id: string,
    ): Promise<ApiResponse<ContentReviewProfileData[]>> =>
      this.requestList<ContentReviewProfileData>(
        `/contents/${id}/review-profiles`,
      ),

    getReviewProfile: async (
      id: string,
      profileKey: string,
    ): Promise<ApiResponse<ContentReviewProfileData>> =>
      this.request<ContentReviewProfileData>(
        `/contents/${id}/review-profiles/${encodeURIComponent(profileKey)}`,
      ),

    runReview: async (
      id: string,
      data: Record<string, any>,
    ): Promise<ApiResponse<ContentReviewData>> =>
      this.request<ContentReviewData>(`/contents/${id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    getCorrections: async (
      id: string,
    ): Promise<ApiResponse<ContentCorrectionData[]>> =>
      this.requestList<ContentCorrectionData>(`/contents/${id}/corrections`),

    issueCorrection: async (
      id: string,
      data: Record<string, any>,
    ): Promise<ApiResponse<ContentCorrectionData>> =>
      this.request<ContentCorrectionData>(`/contents/${id}/corrections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    getVersions: async (
      id: string,
    ): Promise<ApiResponse<ContentVersionData[]>> =>
      this.requestList<ContentVersionData>(`/contents/${id}/versions`),

    createVersion: async (
      id: string,
      data: Record<string, any>,
    ): Promise<ApiResponse<ContentVersionData>> =>
      this.request<ContentVersionData>(`/contents/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    restoreVersion: async (
      id: string,
      versionNumber: number,
    ): Promise<ApiResponse<ContentData>> =>
      this.request<ContentData>(`/contents/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'restore',
          versionNumber,
        }),
      }),
  };

  contentGovernancePolicies = {
    list: async (): Promise<ApiResponse<ContentReviewPolicyData[]>> =>
      this.requestList<ContentReviewPolicyData>('/contentgovernancepolicies'),

    get: async (id: string): Promise<ApiResponse<ContentReviewPolicyData>> =>
      this.request<ContentReviewPolicyData>(`/contentgovernancepolicies/${id}`),

    create: async (
      data: Partial<ContentReviewPolicyData>,
    ): Promise<ApiResponse<ContentReviewPolicyData>> =>
      this.request<ContentReviewPolicyData>('/contentgovernancepolicies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    update: async (
      id: string,
      data: Partial<ContentReviewPolicyData>,
    ): Promise<ApiResponse<ContentReviewPolicyData>> =>
      this.request<ContentReviewPolicyData>(
        `/contentgovernancepolicies/${id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(
        `${this.baseUrl}/contentgovernancepolicies/${id}`,
        {
          method: 'DELETE',
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined, success: true };
    },
  };

  contentGovernanceProfiles = {
    list: async (): Promise<ApiResponse<ContentGovernanceProfileData[]>> =>
      this.requestList<ContentGovernanceProfileData>(
        '/contentgovernanceprofiles',
      ),

    get: async (
      id: string,
    ): Promise<ApiResponse<ContentGovernanceProfileData>> =>
      this.request<ContentGovernanceProfileData>(
        `/contentgovernanceprofiles/${id}`,
      ),

    create: async (
      data: Partial<ContentGovernanceProfileData>,
    ): Promise<ApiResponse<ContentGovernanceProfileData>> =>
      this.request<ContentGovernanceProfileData>('/contentgovernanceprofiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    update: async (
      id: string,
      data: Partial<ContentGovernanceProfileData>,
    ): Promise<ApiResponse<ContentGovernanceProfileData>> =>
      this.request<ContentGovernanceProfileData>(
        `/contentgovernanceprofiles/${id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(
        `${this.baseUrl}/contentgovernanceprofiles/${id}`,
        {
          method: 'DELETE',
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined, success: true };
    },
  };

  contentGovernanceAssignments = {
    list: async (): Promise<ApiResponse<ContentGovernanceAssignmentData[]>> =>
      this.requestList<ContentGovernanceAssignmentData>(
        '/contentgovernanceassignments',
      ),

    get: async (
      id: string,
    ): Promise<ApiResponse<ContentGovernanceAssignmentData>> =>
      this.request<ContentGovernanceAssignmentData>(
        `/contentgovernanceassignments/${id}`,
      ),

    create: async (
      data: Partial<ContentGovernanceAssignmentData>,
    ): Promise<ApiResponse<ContentGovernanceAssignmentData>> =>
      this.request<ContentGovernanceAssignmentData>(
        '/contentgovernanceassignments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),

    update: async (
      id: string,
      data: Partial<ContentGovernanceAssignmentData>,
    ): Promise<ApiResponse<ContentGovernanceAssignmentData>> =>
      this.request<ContentGovernanceAssignmentData>(
        `/contentgovernanceassignments/${id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(
        `${this.baseUrl}/contentgovernanceassignments/${id}`,
        {
          method: 'DELETE',
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined, success: true };
    },
  };

  contentContributions = {
    list: async (): Promise<ApiResponse<ContentContributionData[]>> =>
      this.requestList<ContentContributionData>('/contentcontributions'),

    get: async (id: string): Promise<ApiResponse<ContentContributionData>> =>
      this.request<ContentContributionData>(`/contentcontributions/${id}`),

    submitWebContribution: async (
      payload: Record<string, unknown>,
    ): Promise<ApiResponse<any>> =>
      this.request<any>('/contentcontributions/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    ingestEmailContribution: async (
      payload: Record<string, unknown>,
    ): Promise<ApiResponse<any>> =>
      this.request<any>('/contentcontributions/ingest-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    appendRevision: async (
      id: string,
      payload: Record<string, unknown>,
    ): Promise<ApiResponse<any>> =>
      this.request<any>(`/contentcontributions/${id}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    requestChanges: async (
      id: string,
      payload: Record<string, unknown>,
    ): Promise<ApiResponse<any>> =>
      this.request<any>(`/contentcontributions/${id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    approve: async (
      id: string,
      payload: Record<string, unknown> = {},
    ): Promise<ApiResponse<any>> =>
      this.request<any>(`/contentcontributions/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    reject: async (
      id: string,
      payload: Record<string, unknown> = {},
    ): Promise<ApiResponse<any>> =>
      this.request<any>(`/contentcontributions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    withdraw: async (
      id: string,
      payload: Record<string, unknown> = {},
    ): Promise<ApiResponse<any>> =>
      this.request<any>(`/contentcontributions/${id}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    promote: async (
      id: string,
      payload: Record<string, unknown> = {},
    ): Promise<ApiResponse<any>> =>
      this.request<any>(`/contentcontributions/${id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),

    listForContributor: async (
      options: { contributorId?: string; contributorEmail?: string } = {},
    ): Promise<ApiResponse<ContentContributionData[]>> =>
      this.requestList<ContentContributionData>(
        `/contentcontributions/by-contributor${toQueryString(options)}`,
      ),

    listInbox: async (
      options: { statuses?: string | string[] } = {},
    ): Promise<ApiResponse<ContentContributionData[]>> =>
      this.requestList<ContentContributionData>(
        `/contentcontributions/inbox${toQueryString({
          statuses: Array.isArray(options.statuses)
            ? options.statuses.join(',')
            : options.statuses,
        })}`,
      ),

    getContributionTypes: async (): Promise<
      ApiResponse<ContentContributionTypeConfigStateData>
    > => this.request('/contentcontributions/types'),
  };

  contentContributionTypes = {
    list: async (): Promise<ApiResponse<ContentContributionTypeData[]>> =>
      this.requestList<ContentContributionTypeData>(
        '/contentcontributiontypes',
      ),

    get: async (
      id: string,
    ): Promise<ApiResponse<ContentContributionTypeData>> =>
      this.request<ContentContributionTypeData>(
        `/contentcontributiontypes/${id}`,
      ),

    create: async (
      data: Partial<ContentContributionTypeData>,
    ): Promise<ApiResponse<ContentContributionTypeData>> =>
      this.request<ContentContributionTypeData>('/contentcontributiontypes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    update: async (
      id: string,
      data: Partial<ContentContributionTypeData>,
    ): Promise<ApiResponse<ContentContributionTypeData>> =>
      this.request<ContentContributionTypeData>(
        `/contentcontributiontypes/${id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      ),

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(
        `${this.baseUrl}/contentcontributiontypes/${id}`,
        {
          method: 'DELETE',
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined, success: true };
    },
  };

  contentContributors = {
    list: async (): Promise<ApiResponse<ContentContributorData[]>> =>
      this.requestList<ContentContributorData>('/contentcontributors'),

    get: async (id: string): Promise<ApiResponse<ContentContributorData>> =>
      this.request<ContentContributorData>(`/contentcontributors/${id}`),

    create: async (
      data: Partial<ContentContributorData>,
    ): Promise<ApiResponse<ContentContributorData>> =>
      this.request<ContentContributorData>('/contentcontributors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    update: async (
      id: string,
      data: Partial<ContentContributorData>,
    ): Promise<ApiResponse<ContentContributorData>> =>
      this.request<ContentContributorData>(`/contentcontributors/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(`${this.baseUrl}/contentcontributors/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined, success: true };
    },
  };

  contentVersions = {
    getTransparency: async (
      id: string,
    ): Promise<ApiResponse<ContentTransparencyData>> =>
      this.request<ContentTransparencyData>(
        `/contentversions/${id}/transparency`,
      ),
  };
}

export function createClient(baseUrl = '/api/v1'): ApiClient {
  return new ApiClient(baseUrl);
}

export default createClient;
