import type { Fact, FactContentRelationship } from '@happyvertical/smrt-facts';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { Content } from './content';

export type ContentReviewKind = 'facts' | 'safety' | 'custom';

export type ContentReviewStatus =
  | 'pending'
  | 'passed'
  | 'flagged'
  | 'failed'
  | 'waived';

export type ContentReviewSeverity = 'info' | 'warning' | 'error';

export type ContentVersionKind =
  | 'manual'
  | 'draft'
  | 'review'
  | 'publication'
  | 'correction';

export type ContentCorrectionType = 'fact' | 'safety' | 'copy' | 'custom';

export type ContentCorrectionStatus = 'draft' | 'published' | 'retracted';

export interface ContentReviewFinding {
  severity: ContentReviewSeverity;
  title: string;
  detail: string;
  factId?: string;
  quote?: string;
  suggestedChange?: string;
  ruleId?: string;
}

export interface ContentReviewResult {
  status: ContentReviewStatus;
  summary: string;
  findings: ContentReviewFinding[];
}

export interface ContentReviewRequirement {
  policyKey: string;
  label?: string;
  blocking?: boolean;
  acceptedStatuses?: ContentReviewStatus[];
}

export interface ContentReviewProfileEvaluationItem {
  kind: ContentReviewKind;
  policyKey: string;
  label: string;
  blocking: boolean;
  acceptedStatuses: ContentReviewStatus[];
  missing: boolean;
  stale: boolean;
  executed: boolean;
  satisfied: boolean;
  latestReviewId: string | null;
  latestStatus: ContentReviewStatus | null;
  latestSummary: string | null;
}

export interface ContentReviewProfileEvaluation {
  profileKey: string;
  ready: boolean;
  complete: boolean;
  requirements: ContentReviewProfileEvaluationItem[];
}

export interface ContentReviewPolicyDefinition {
  key: string;
  label: string;
  kind: ContentReviewKind;
  instructions: string;
  enabled?: boolean;
  metadata?: Record<string, any>;
}

export interface ContentGovernanceProfileDefinition {
  key: string;
  label: string;
  description?: string;
  enabled?: boolean;
  requirements: ContentReviewRequirement[];
  metadata?: Record<string, any>;
}

export interface ContentGovernanceAssignmentDefinition {
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
  defaultFactRelationship?: FactContentRelationship;
  metadata?: Record<string, any>;
}

export interface ContentGovernanceConfig {
  policies: ContentReviewPolicyDefinition[];
  profiles: ContentGovernanceProfileDefinition[];
  assignments: ContentGovernanceAssignmentDefinition[];
}

export interface PersistedContentGovernancePolicyRecord
  extends ContentReviewPolicyDefinition {
  id?: string;
  tenantId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PersistedContentGovernanceProfileRecord
  extends ContentGovernanceProfileDefinition {
  id?: string;
  tenantId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PersistedContentGovernanceAssignmentRecord
  extends ContentGovernanceAssignmentDefinition {
  id?: string;
  tenantId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PersistedContentGovernanceDefinitions {
  policies: PersistedContentGovernancePolicyRecord[];
  profiles: PersistedContentGovernanceProfileRecord[];
  assignments: PersistedContentGovernanceAssignmentRecord[];
}

export interface ResolvedContentGovernance {
  isGoverned: boolean;
  factLinkingEnabled: boolean;
  transparencyEnabled: boolean;
  publicationProfileKey: string | null;
  correctionProfileKey: string | null;
  enforcePublishReadiness: boolean;
  defaultFactRelationship: FactContentRelationship;
  reviewPolicies: ContentReviewPolicyDefinition[];
  availableProfiles: ContentGovernanceProfileDefinition[];
  assignment: ContentGovernanceAssignmentDefinition | null;
}

export interface ContentGovernanceState extends ResolvedContentGovernance {
  reviewProfiles: ContentReviewProfileEvaluation[];
}

export interface CreateContentVersionOptions {
  kind?: ContentVersionKind;
  summary?: string;
  metadata?: Record<string, any>;
  snapshot?: Record<string, any>;
}

export interface RunContentReviewOptions {
  kind?: ContentReviewKind;
  policyKey?: string;
  reviewer?: string;
  instructions?: string;
  facts?: Fact[];
  factIds?: string[];
  metadata?: Record<string, any>;
  createVersion?: boolean;
}

export interface IssueContentCorrectionOptions {
  correctionType?: ContentCorrectionType;
  factId?: string;
  correctedFactText?: string;
  summary: string;
  incorrectText?: string;
  correctedText?: string;
  publicNote?: string;
  metadata?: Record<string, any>;
  createVersion?: boolean;
  publish?: boolean;
}

export interface BuildContentReviewPromptOptions {
  kind: ContentReviewKind;
  content: Pick<
    Content,
    | 'id'
    | 'type'
    | 'status'
    | 'state'
    | 'title'
    | 'description'
    | 'body'
    | 'author'
    | 'publish_date'
  >;
  facts?: Fact[];
  policy?: ContentReviewPolicyDefinition | null;
  customInstructions?: string;
}

export interface ResolveContentGovernanceOptions {
  contentType?: string | null;
  contentVariant?: string | null;
  db?: DatabaseInterface | null;
}

const DEFAULT_FACT_RELATIONSHIP: FactContentRelationship = 'supports';

const DEFAULT_REVIEW_POLICIES: ContentReviewPolicyDefinition[] = [
  {
    key: 'facts',
    label: 'Facts Review',
    kind: 'facts',
    instructions: [
      'Compare the draft copy against the supplied facts only.',
      'Flag contradictions, unsupported claims, stale claims, and places where the copy should cite or qualify a statement.',
      'Do not invent missing facts. If the draft makes a claim that is not supported by the provided facts, flag it clearly.',
    ].join(' '),
    enabled: true,
  },
  {
    key: 'safety',
    label: 'Safety Review',
    kind: 'safety',
    instructions: [
      'Review the content for legal, reputational, and user-safety risks.',
      'At minimum, check for defamation risk, privacy leaks, unverified allegations, unsafe instructions, and medical, legal, or financial claims that need qualification.',
      'Flag content that should be softened, attributed, removed, or escalated for human review.',
    ].join(' '),
    enabled: true,
  },
];

const DEFAULT_REVIEW_PROFILES: ContentGovernanceProfileDefinition[] = [
  {
    key: 'publication',
    label: 'Publication',
    description: 'Default publication-time editorial checks.',
    enabled: true,
    requirements: [
      {
        policyKey: 'safety',
        label: 'Safety Review',
        blocking: false,
      },
      {
        policyKey: 'facts',
        label: 'Facts Review',
        blocking: false,
      },
    ],
  },
  {
    key: 'correction',
    label: 'Correction',
    description: 'Default correction-time editorial checks.',
    enabled: true,
    requirements: [
      {
        policyKey: 'safety',
        label: 'Safety Review',
        blocking: false,
      },
    ],
  },
];

const DEFAULT_CONTENT_GOVERNANCE_CONFIG: ContentGovernanceConfig = {
  policies: DEFAULT_REVIEW_POLICIES.map(clonePolicyDefinition),
  profiles: DEFAULT_REVIEW_PROFILES.map(cloneProfileDefinition),
  assignments: [],
};

let governanceConfig: ContentGovernanceConfig = cloneGovernanceConfig(
  DEFAULT_CONTENT_GOVERNANCE_CONFIG,
);
// Process-global by design: apps are expected to configure governance once at
// startup and use persisted records for runtime admin overrides.

function cloneReviewRequirement(
  requirement: ContentReviewRequirement,
): ContentReviewRequirement {
  return {
    ...requirement,
    acceptedStatuses: requirement.acceptedStatuses
      ? [...requirement.acceptedStatuses]
      : undefined,
  };
}

function normalizePolicyDefinition(
  policy: ContentReviewPolicyDefinition,
): ContentReviewPolicyDefinition {
  return {
    key: policy.key,
    label: policy.label || policy.key,
    kind: policy.kind || getFallbackPolicyKind(policy.key),
    instructions: policy.instructions || '',
    enabled: policy.enabled !== false,
    metadata: policy.metadata ? { ...policy.metadata } : undefined,
  };
}

function clonePolicyDefinition(
  policy: ContentReviewPolicyDefinition,
): ContentReviewPolicyDefinition {
  return normalizePolicyDefinition(policy);
}

function normalizeProfileDefinition(
  profile: ContentGovernanceProfileDefinition,
): ContentGovernanceProfileDefinition {
  return {
    key: profile.key,
    label: profile.label || profile.key,
    description: profile.description || '',
    enabled: profile.enabled !== false,
    requirements: Array.isArray(profile.requirements)
      ? profile.requirements.map(cloneReviewRequirement)
      : [],
    metadata: profile.metadata ? { ...profile.metadata } : undefined,
  };
}

function cloneProfileDefinition(
  profile: ContentGovernanceProfileDefinition,
): ContentGovernanceProfileDefinition {
  return normalizeProfileDefinition(profile);
}

export function buildContentGovernanceAssignmentKey(
  contentType: string,
  contentVariant?: string | null,
): string {
  return `${contentType || ''}::${contentVariant || ''}`;
}

function normalizeAssignmentDefinition(
  assignment: ContentGovernanceAssignmentDefinition,
): ContentGovernanceAssignmentDefinition {
  return {
    key:
      assignment.key ||
      buildContentGovernanceAssignmentKey(
        assignment.contentType,
        assignment.contentVariant,
      ),
    label: assignment.label || '',
    contentType: assignment.contentType,
    contentVariant: assignment.contentVariant || '',
    enabled: assignment.enabled !== false,
    factLinkingEnabled: assignment.factLinkingEnabled === true,
    transparencyEnabled: assignment.transparencyEnabled === true,
    publicationProfileKey: assignment.publicationProfileKey || null,
    correctionProfileKey: assignment.correctionProfileKey || null,
    enforcePublishReadiness: assignment.enforcePublishReadiness === true,
    defaultFactRelationship:
      assignment.defaultFactRelationship || DEFAULT_FACT_RELATIONSHIP,
    metadata: assignment.metadata ? { ...assignment.metadata } : undefined,
  };
}

function cloneAssignmentDefinition(
  assignment: ContentGovernanceAssignmentDefinition,
): ContentGovernanceAssignmentDefinition {
  return normalizeAssignmentDefinition(assignment);
}

function cloneGovernanceConfig(
  config: ContentGovernanceConfig,
): ContentGovernanceConfig {
  return {
    policies: config.policies.map(clonePolicyDefinition),
    profiles: config.profiles.map(cloneProfileDefinition),
    assignments: config.assignments.map(cloneAssignmentDefinition),
  };
}

function mergeByKey<T extends { key?: string }>(
  previous: T[],
  next: T[],
  normalize: (value: T) => T,
): T[] {
  const merged = new Map<string, T>();

  for (const value of previous) {
    const normalized = normalize(value);
    if (normalized.key) {
      merged.set(normalized.key, normalized);
    }
  }

  for (const value of next) {
    const normalized = normalize(value);
    if (normalized.key) {
      merged.set(normalized.key, normalized);
    }
  }

  return [...merged.values()];
}

export function getFallbackPolicyKind(key: string): ContentReviewKind {
  if (key === 'facts') {
    return 'facts';
  }

  if (key === 'safety') {
    return 'safety';
  }

  return 'custom';
}

function getPolicyMap(
  policies: ContentReviewPolicyDefinition[],
): Map<string, ContentReviewPolicyDefinition> {
  return new Map(
    policies.map((policy) => {
      const normalized = normalizePolicyDefinition(policy);
      return [normalized.key, normalized];
    }),
  );
}

function getProfileMap(
  profiles: ContentGovernanceProfileDefinition[],
): Map<string, ContentGovernanceProfileDefinition> {
  return new Map(
    profiles.map((profile) => {
      const normalized = normalizeProfileDefinition(profile);
      return [normalized.key, normalized];
    }),
  );
}

function isMissingGovernanceTableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error');

  return (
    message.includes("Run 'smrt db:migrate'") ||
    /no such table/i.test(message) ||
    /does not exist/i.test(message)
  );
}

function getRowTimestamp(
  row: Record<string, any>,
  primaryKey: 'createdAt' | 'updatedAt',
): string | null {
  const snakeCaseKey = primaryKey === 'createdAt' ? 'created_at' : 'updated_at';
  const value = row[primaryKey] ?? row[snakeCaseKey];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getRowTenantId(row: Record<string, any>): string | null {
  const value = row.tenantId ?? row.tenant_id ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeParseJSONObject(value: unknown): Record<string, any> {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, any>) };
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, any>) }
      : {};
  } catch {
    return {};
  }
}

function safeParseJSONArray<T>(value: unknown, mapEntry: (entry: T) => T): T[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((entry) => mapEntry(entry as T));
  }

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.map((entry) => mapEntry(entry as T))
      : [];
  } catch {
    return [];
  }
}

function mapPersistedPolicyRow(
  row: Record<string, any>,
): PersistedContentGovernancePolicyRecord {
  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    tenantId: getRowTenantId(row),
    createdAt: getRowTimestamp(row, 'createdAt'),
    updatedAt: getRowTimestamp(row, 'updatedAt'),
    ...normalizePolicyDefinition({
      key: String(row.key || ''),
      label: String(row.label || row.key || ''),
      kind: (row.kind ||
        getFallbackPolicyKind(String(row.key || ''))) as ContentReviewKind,
      instructions: String(row.instructions || ''),
      enabled: row.enabled !== false && row.enabled !== 0,
      metadata: safeParseJSONObject(row.metadata),
    }),
  };
}

function mapPersistedProfileRow(
  row: Record<string, any>,
): PersistedContentGovernanceProfileRecord {
  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    tenantId: getRowTenantId(row),
    createdAt: getRowTimestamp(row, 'createdAt'),
    updatedAt: getRowTimestamp(row, 'updatedAt'),
    ...normalizeProfileDefinition({
      key: String(row.key || ''),
      label: String(row.label || row.key || ''),
      description: String(row.description || ''),
      enabled: row.enabled !== false && row.enabled !== 0,
      requirements: safeParseJSONArray<ContentReviewRequirement>(
        row.requirements,
        cloneReviewRequirement,
      ),
      metadata: safeParseJSONObject(row.metadata),
    }),
  };
}

function mapPersistedAssignmentRow(
  row: Record<string, any>,
): PersistedContentGovernanceAssignmentRecord {
  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    tenantId: getRowTenantId(row),
    createdAt: getRowTimestamp(row, 'createdAt'),
    updatedAt: getRowTimestamp(row, 'updatedAt'),
    ...normalizeAssignmentDefinition({
      key: String(row.key || ''),
      label: String(row.label || ''),
      contentType: String(row.contentType || row.content_type || ''),
      contentVariant: String(row.contentVariant || row.content_variant || ''),
      enabled: row.enabled !== false && row.enabled !== 0,
      factLinkingEnabled:
        row.factLinkingEnabled === true ||
        row.fact_linking_enabled === true ||
        row.fact_linking_enabled === 1,
      transparencyEnabled:
        row.transparencyEnabled === true ||
        row.transparency_enabled === true ||
        row.transparency_enabled === 1,
      publicationProfileKey:
        row.publicationProfileKey || row.publication_profile_key || null,
      correctionProfileKey:
        row.correctionProfileKey || row.correction_profile_key || null,
      enforcePublishReadiness:
        row.enforcePublishReadiness === true ||
        row.enforce_publish_readiness === true ||
        row.enforce_publish_readiness === 1,
      defaultFactRelationship:
        row.defaultFactRelationship ||
        row.default_fact_relationship ||
        DEFAULT_FACT_RELATIONSHIP,
      metadata: safeParseJSONObject(row.metadata),
    }),
  };
}

export async function loadPersistedContentGovernanceDefinitions(
  options: { db?: DatabaseInterface | null } = {},
): Promise<PersistedContentGovernanceDefinitions> {
  const { db } = options;
  if (!db) {
    return {
      policies: [],
      profiles: [],
      assignments: [],
    };
  }

  try {
    const [policyRows, profileRows, assignmentRows] = await Promise.all([
      db.list('content_governance_policies', {}),
      db.list('content_governance_profiles', {}),
      db.list('content_governance_assignments', {}),
    ]);

    policyRows.sort((a: any, b: any) =>
      String(a.created_at || a.createdAt || '').localeCompare(
        String(b.created_at || b.createdAt || ''),
      ),
    );
    profileRows.sort((a: any, b: any) =>
      String(a.created_at || a.createdAt || '').localeCompare(
        String(b.created_at || b.createdAt || ''),
      ),
    );
    assignmentRows.sort((a: any, b: any) =>
      String(a.created_at || a.createdAt || '').localeCompare(
        String(b.created_at || b.createdAt || ''),
      ),
    );

    return {
      policies: policyRows.map((row: any) => mapPersistedPolicyRow(row)),
      profiles: profileRows.map((row: any) => mapPersistedProfileRow(row)),
      assignments: assignmentRows.map((row: any) =>
        mapPersistedAssignmentRow(row),
      ),
    };
  } catch (error) {
    if (isMissingGovernanceTableError(error)) {
      return {
        policies: [],
        profiles: [],
        assignments: [],
      };
    }
    throw error;
  }
}

function resolveAssignmentDefinition(
  assignments: ContentGovernanceAssignmentDefinition[],
  options: Pick<
    ResolveContentGovernanceOptions,
    'contentType' | 'contentVariant'
  >,
): ContentGovernanceAssignmentDefinition | null {
  if (!options.contentType) {
    return null;
  }

  const exactMatch =
    assignments.find(
      (assignment) =>
        assignment.contentType === options.contentType &&
        (assignment.contentVariant || '') === (options.contentVariant || ''),
    ) || null;

  if (exactMatch) {
    return cloneAssignmentDefinition(exactMatch);
  }

  const typeOnlyMatch =
    assignments.find(
      (assignment) =>
        assignment.contentType === options.contentType &&
        !assignment.contentVariant,
    ) || null;

  return typeOnlyMatch ? cloneAssignmentDefinition(typeOnlyMatch) : null;
}

function buildResolvedGovernance(
  config: ContentGovernanceConfig,
  assignment: ContentGovernanceAssignmentDefinition | null,
): ResolvedContentGovernance {
  const normalizedAssignment = assignment
    ? normalizeAssignmentDefinition(assignment)
    : null;
  if (!normalizedAssignment || normalizedAssignment.enabled !== true) {
    return {
      isGoverned: false,
      factLinkingEnabled: false,
      transparencyEnabled: false,
      publicationProfileKey: null,
      correctionProfileKey: null,
      enforcePublishReadiness: false,
      defaultFactRelationship: DEFAULT_FACT_RELATIONSHIP,
      reviewPolicies: config.policies
        .map(clonePolicyDefinition)
        .filter((policy) => policy.enabled !== false),
      availableProfiles: config.profiles
        .map(cloneProfileDefinition)
        .filter((profile) => profile.enabled !== false),
      assignment: normalizedAssignment,
    };
  }

  return {
    isGoverned: true,
    factLinkingEnabled: normalizedAssignment.factLinkingEnabled === true,
    transparencyEnabled: normalizedAssignment.transparencyEnabled === true,
    publicationProfileKey: normalizedAssignment.publicationProfileKey || null,
    correctionProfileKey: normalizedAssignment.correctionProfileKey || null,
    enforcePublishReadiness:
      normalizedAssignment.enforcePublishReadiness === true,
    defaultFactRelationship:
      normalizedAssignment.defaultFactRelationship || DEFAULT_FACT_RELATIONSHIP,
    reviewPolicies: config.policies
      .map(clonePolicyDefinition)
      .filter((policy) => policy.enabled !== false),
    availableProfiles: config.profiles
      .map(cloneProfileDefinition)
      .filter((profile) => profile.enabled !== false),
    assignment: normalizedAssignment,
  };
}

function normalizeStatus(status: unknown): ContentReviewStatus {
  switch (status) {
    case 'pending':
    case 'passed':
    case 'flagged':
    case 'failed':
    case 'waived':
      return status;
    default:
      return 'flagged';
  }
}

function normalizeSeverity(severity: unknown): ContentReviewSeverity {
  switch (severity) {
    case 'info':
    case 'warning':
    case 'error':
      return severity;
    default:
      return 'warning';
  }
}

function extractJSONObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

export function getContentGovernanceConfig(): ContentGovernanceConfig {
  return cloneGovernanceConfig(governanceConfig);
}

export function getStaticContentGovernanceConfig(): ContentGovernanceConfig {
  return cloneGovernanceConfig(governanceConfig);
}

export function configureContentGovernance(
  config: Partial<ContentGovernanceConfig>,
): ContentGovernanceConfig {
  governanceConfig = {
    policies: config.policies
      ? mergeByKey(
          governanceConfig.policies,
          config.policies,
          normalizePolicyDefinition,
        )
      : governanceConfig.policies.map(clonePolicyDefinition),
    profiles: config.profiles
      ? mergeByKey(
          governanceConfig.profiles,
          config.profiles,
          normalizeProfileDefinition,
        )
      : governanceConfig.profiles.map(cloneProfileDefinition),
    assignments: config.assignments
      ? mergeByKey(
          governanceConfig.assignments,
          config.assignments,
          normalizeAssignmentDefinition,
        )
      : governanceConfig.assignments.map(cloneAssignmentDefinition),
  };

  return getContentGovernanceConfig();
}

export function resetContentGovernanceConfig(): ContentGovernanceConfig {
  governanceConfig = cloneGovernanceConfig(DEFAULT_CONTENT_GOVERNANCE_CONFIG);
  return getContentGovernanceConfig();
}

export async function getEffectiveContentGovernanceConfig(
  options: { db?: DatabaseInterface | null } = {},
): Promise<ContentGovernanceConfig> {
  const persisted = await loadPersistedContentGovernanceDefinitions({
    db: options.db,
  });

  return {
    policies: mergeByKey(
      governanceConfig.policies,
      persisted.policies,
      normalizePolicyDefinition,
    ),
    profiles: mergeByKey(
      governanceConfig.profiles,
      persisted.profiles,
      normalizeProfileDefinition,
    ),
    assignments: mergeByKey(
      governanceConfig.assignments,
      persisted.assignments,
      normalizeAssignmentDefinition,
    ),
  };
}

export function hasStaticContentGovernancePolicy(key: string): boolean {
  return getPolicyMap(governanceConfig.policies).has(key);
}

export function hasStaticContentGovernanceProfile(key: string): boolean {
  return getProfileMap(governanceConfig.profiles).has(key);
}

export function getContentReviewPolicy(
  policyKey: string,
  policies: ContentReviewPolicyDefinition[] = governanceConfig.policies,
): ContentReviewPolicyDefinition | null {
  return getPolicyMap(policies).get(policyKey) || null;
}

export function getContentReviewKind(
  policyKey: string,
  policies: ContentReviewPolicyDefinition[] = governanceConfig.policies,
): ContentReviewKind {
  const configuredKind = getPolicyMap(policies).get(policyKey)?.kind;
  return configuredKind || getFallbackPolicyKind(policyKey);
}

export function getContentReviewProfile(
  profileKey: string,
  profiles: ContentGovernanceProfileDefinition[] = governanceConfig.profiles,
): ContentGovernanceProfileDefinition | null {
  return getProfileMap(profiles).get(profileKey) || null;
}

export function getContentReviewProfileKeys(
  profiles: ContentGovernanceProfileDefinition[] = governanceConfig.profiles,
): string[] {
  return profiles
    .map(cloneProfileDefinition)
    .filter((profile) => profile.enabled !== false)
    .map((profile) => profile.key);
}

export function getContentReviewPolicies(
  policies: ContentReviewPolicyDefinition[] = governanceConfig.policies,
): ContentReviewPolicyDefinition[] {
  return policies
    .map(clonePolicyDefinition)
    .filter((policy) => policy.enabled !== false);
}

export function getContentReviewRequirements(
  profileKey: string,
  profiles: ContentGovernanceProfileDefinition[] = governanceConfig.profiles,
): ContentReviewRequirement[] {
  const profile = getContentReviewProfile(profileKey, profiles);
  return profile?.requirements.map(cloneReviewRequirement) || [];
}

export function getAcceptedContentReviewStatuses(
  requirement: Pick<ContentReviewRequirement, 'acceptedStatuses'>,
): ContentReviewStatus[] {
  return requirement.acceptedStatuses && requirement.acceptedStatuses.length > 0
    ? [...requirement.acceptedStatuses]
    : ['passed', 'waived'];
}

export function resolveConfiguredContentGovernance(
  options: Pick<
    ResolveContentGovernanceOptions,
    'contentType' | 'contentVariant'
  >,
): ResolvedContentGovernance {
  const assignment = resolveAssignmentDefinition(governanceConfig.assignments, {
    contentType: options.contentType,
    contentVariant: options.contentVariant,
  });

  return buildResolvedGovernance(governanceConfig, assignment);
}

export async function resolveEffectiveContentGovernance(
  options: ResolveContentGovernanceOptions,
): Promise<ResolvedContentGovernance> {
  const effectiveConfig = await getEffectiveContentGovernanceConfig({
    db: options.db,
  });
  const assignment = resolveAssignmentDefinition(effectiveConfig.assignments, {
    contentType: options.contentType,
    contentVariant: options.contentVariant,
  });

  return buildResolvedGovernance(effectiveConfig, assignment);
}

export function buildContentReviewPrompt(
  options: BuildContentReviewPromptOptions,
): string {
  const { kind, content, facts = [], policy, customInstructions } = options;

  const factLines =
    facts.length > 0
      ? facts
          .map(
            (fact) =>
              `- [${fact.id}] status=${fact.status}; confidence=${fact.confidence}; sources=${fact.sourceCount}; text=${fact.textRefined}`,
          )
          .join('\n')
      : 'No facts were supplied for this review.';

  const policyText =
    customInstructions?.trim() ||
    policy?.instructions ||
    getContentReviewPolicy(kind)?.instructions ||
    '';

  return `You are a structured editorial reviewer.

Return ONLY valid JSON with this shape:
{
  "status": "passed" | "flagged" | "failed" | "waived",
  "summary": "short summary",
  "findings": [
    {
      "severity": "info" | "warning" | "error",
      "title": "short title",
      "detail": "what is wrong and why",
      "factId": "optional fact id",
      "quote": "optional quoted text from the draft",
      "suggestedChange": "optional suggested fix",
      "ruleId": "optional policy or rule id"
    }
  ]
}

Review kind: ${kind}
Policy key: ${policy?.key || kind}
Review instructions:
${policyText}

Draft content:
- id: ${content.id ?? ''}
- type: ${content.type ?? ''}
- status: ${content.status}
- state: ${content.state}
- author: ${content.author ?? ''}
- publish_date: ${content.publish_date?.toISOString?.() ?? ''}

Title:
${content.title}

Description:
${content.description ?? ''}

Body:
${content.body}

Relevant facts:
${factLines}`;
}

export function parseContentReviewResponse(raw: string): ContentReviewResult {
  const normalizedRaw = raw.trim();
  const jsonCandidate = extractJSONObject(normalizedRaw);

  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Partial<ContentReviewResult>;
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.map((finding: any) => ({
            severity: normalizeSeverity(finding?.severity),
            title: String(finding?.title || 'Review finding'),
            detail: String(finding?.detail || ''),
            factId:
              typeof finding?.factId === 'string' ? finding.factId : undefined,
            quote:
              typeof finding?.quote === 'string' ? finding.quote : undefined,
            suggestedChange:
              typeof finding?.suggestedChange === 'string'
                ? finding.suggestedChange
                : undefined,
            ruleId:
              typeof finding?.ruleId === 'string' ? finding.ruleId : undefined,
          }))
        : [];

      return {
        status: normalizeStatus(parsed.status),
        summary: String(parsed.summary || normalizedRaw || 'Review completed'),
        findings,
      };
    } catch {
      // Fall through to a normalized fallback result.
    }
  }

  return {
    status: 'flagged',
    summary: normalizedRaw || 'Review completed without structured output.',
    findings: normalizedRaw
      ? [
          {
            severity: 'warning',
            title: 'Unstructured review output',
            detail: normalizedRaw,
          },
        ]
      : [],
  };
}
