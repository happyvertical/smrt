import type { DatabaseInterface } from '@happyvertical/sql';

export type ContentContributionChannel = 'web' | 'email';

export type ContentContributionStatus =
  | 'submitted'
  | 'quarantined'
  | 'needs_changes'
  | 'approved'
  | 'promoted'
  | 'rejected'
  | 'withdrawn';

export type ContentContributionIntakeDecision =
  | 'accepted'
  | 'quarantined'
  | 'rejected';

export type ContentContributorTrustLevel = 'standard' | 'trusted' | 'blocked';

export interface ContentContributionIntakeRules {
  maxFiles?: number | null;
  maxTotalBytes?: number | null;
  allowedMimePatterns?: string[];
  blockedMimePatterns?: string[];
  quarantineMimePatterns?: string[];
  blockedTextPatterns?: string[];
  quarantineTextPatterns?: string[];
  trustedOnly?: boolean;
}

export interface ContentContributionPromotionMapping {
  targetContentType?: string | null;
  targetContentVariant?: string | null;
  targetContentStatus?: 'draft' | 'review';
  autoPromoteTrusted?: boolean;
  createAssets?: boolean;
  assetRelationship?: string;
}

export interface ContentContributionTypeDefinition {
  key: string;
  label: string;
  enabled?: boolean;
  allowedChannels?: ContentContributionChannel[];
  allowText?: boolean;
  allowFiles?: boolean;
  allowEmptyText?: boolean;
  intakeRules?: ContentContributionIntakeRules;
  promotion?: ContentContributionPromotionMapping;
  metadata?: Record<string, unknown>;
}

export interface PersistedContentContributionTypeRecord
  extends ContentContributionTypeDefinition {
  id?: string;
  tenantId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ContentContributionConfig {
  types: ContentContributionTypeDefinition[];
}

export interface ResolvedContentContributionType
  extends ContentContributionTypeDefinition {}

export interface ContentContributionTypeConfigState {
  effective: ContentContributionTypeDefinition[];
  persisted: PersistedContentContributionTypeRecord[];
}

export interface EvaluateContributionIntakeOptions {
  contributionType: ContentContributionTypeDefinition;
  trustLevel?: ContentContributorTrustLevel;
  channel: ContentContributionChannel;
  title?: string | null;
  description?: string | null;
  body?: string | null;
  attachments?: Array<{
    mimeType?: string | null;
    size?: number | null;
  }>;
}

export interface EvaluateContributionIntakeResult {
  decision: ContentContributionIntakeDecision;
  reasons: string[];
}

const DEFAULT_CONTENT_CONTRIBUTION_CONFIG: ContentContributionConfig = {
  types: [],
};

let contributionConfig = cloneContributionConfig(
  DEFAULT_CONTENT_CONTRIBUTION_CONFIG,
);

function cloneJSONArray<T>(items: T[] | null | undefined): T[] {
  return Array.isArray(items) ? items.map((item) => structuredClone(item)) : [];
}

function safeParseJSONObject(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  if (typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>) };
  }

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function safeParseJSONArray<T>(raw: unknown): T[] {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => structuredClone(item)) as T[];
  }

  if (typeof raw !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function cloneIntakeRules(
  rules: ContentContributionIntakeRules | null | undefined,
): ContentContributionIntakeRules {
  return {
    maxFiles:
      typeof rules?.maxFiles === 'number' ? Math.max(0, rules.maxFiles) : null,
    maxTotalBytes:
      typeof rules?.maxTotalBytes === 'number'
        ? Math.max(0, rules.maxTotalBytes)
        : null,
    allowedMimePatterns: cloneJSONArray(rules?.allowedMimePatterns),
    blockedMimePatterns: cloneJSONArray(rules?.blockedMimePatterns),
    quarantineMimePatterns: cloneJSONArray(rules?.quarantineMimePatterns),
    blockedTextPatterns: cloneJSONArray(rules?.blockedTextPatterns),
    quarantineTextPatterns: cloneJSONArray(rules?.quarantineTextPatterns),
    trustedOnly: rules?.trustedOnly === true,
  };
}

function clonePromotionMapping(
  promotion: ContentContributionPromotionMapping | null | undefined,
): ContentContributionPromotionMapping {
  return {
    targetContentType: promotion?.targetContentType || null,
    targetContentVariant: promotion?.targetContentVariant || null,
    targetContentStatus:
      promotion?.targetContentStatus === 'review' ? 'review' : 'draft',
    autoPromoteTrusted: promotion?.autoPromoteTrusted === true,
    createAssets: promotion?.createAssets !== false,
    assetRelationship: promotion?.assetRelationship || 'attachment',
  };
}

function cloneTypeDefinition(
  type: ContentContributionTypeDefinition,
): ContentContributionTypeDefinition {
  return {
    key: type.key,
    label: type.label,
    enabled: type.enabled !== false,
    allowedChannels:
      type.allowedChannels && type.allowedChannels.length > 0
        ? [...type.allowedChannels]
        : ['web'],
    allowText: type.allowText !== false,
    allowFiles: type.allowFiles === true,
    allowEmptyText: type.allowEmptyText === true,
    intakeRules: cloneIntakeRules(type.intakeRules),
    promotion: clonePromotionMapping(type.promotion),
    metadata: safeParseJSONObject(type.metadata),
  };
}

function clonePersistedTypeRecord(
  type: PersistedContentContributionTypeRecord,
): PersistedContentContributionTypeRecord {
  return {
    ...cloneTypeDefinition(type),
    id: type.id,
    tenantId: type.tenantId ?? null,
    createdAt: type.createdAt ?? null,
    updatedAt: type.updatedAt ?? null,
  };
}

function cloneContributionConfig(
  config: ContentContributionConfig,
): ContentContributionConfig {
  return {
    types: config.types.map(cloneTypeDefinition),
  };
}

function mergeByKey<T extends { key: string }>(
  baseItems: T[],
  overrides: T[],
  normalize: (item: T) => T,
): T[] {
  const merged = new Map<string, T>();

  for (const item of baseItems.map(normalize)) {
    merged.set(item.key, item);
  }

  for (const item of overrides.map(normalize)) {
    merged.set(item.key, item);
  }

  return [...merged.values()];
}

function isMissingContributionTypesTableError(error: unknown): boolean {
  const message = String(
    (error as Error)?.message || error || '',
  ).toLowerCase();
  return (
    message.includes('content_contribution_types') &&
    (message.includes('no such table') ||
      message.includes('does not exist') ||
      message.includes('relation'))
  );
}

function mapPersistedTypeRow(
  row: Record<string, unknown>,
): PersistedContentContributionTypeRecord {
  return {
    // `id` is an optional string column; a falsy DB value collapses to
    // undefined to match the record's `id?: string` shape.
    id: (row.id as string | undefined) || undefined,
    key: String(row.key || ''),
    label: String(row.label || row.key || ''),
    enabled: row.enabled !== false && row.enabled !== 0,
    allowedChannels: safeParseJSONArray<ContentContributionChannel>(
      row.allowedChannels || row.allowed_channels,
    ),
    allowText:
      row.allowText === undefined && row.allow_text === undefined
        ? true
        : row.allowText !== false && row.allow_text !== 0,
    allowFiles:
      row.allowFiles === true ||
      row.allow_files === true ||
      row.allow_files === 1,
    allowEmptyText:
      row.allowEmptyText === true ||
      row.allow_empty_text === true ||
      row.allow_empty_text === 1,
    // Persisted JSON blobs deserialize to the documented intake/promotion
    // shapes; they are re-normalized structurally by clone* helpers downstream.
    intakeRules: safeParseJSONObject(
      row.intakeRules || row.intake_rules,
    ) as ContentContributionIntakeRules,
    promotion: safeParseJSONObject(
      row.promotion || row.promotion_mapping,
    ) as ContentContributionPromotionMapping,
    metadata: safeParseJSONObject(row.metadata),
    tenantId: (row.tenantId ?? row.tenant_id ?? null) as string | null,
    createdAt: (row.createdAt || row.created_at || null) as string | null,
    updatedAt: (row.updatedAt || row.updated_at || null) as string | null,
  };
}

export function getContentContributionConfig(): ContentContributionConfig {
  return cloneContributionConfig(contributionConfig);
}

export function configureContentContributions(
  config: Partial<ContentContributionConfig>,
): ContentContributionConfig {
  contributionConfig = {
    types: config.types
      ? mergeByKey(contributionConfig.types, config.types, cloneTypeDefinition)
      : contributionConfig.types.map(cloneTypeDefinition),
  };

  return getContentContributionConfig();
}

export function resetContentContributionConfig(): ContentContributionConfig {
  contributionConfig = cloneContributionConfig(
    DEFAULT_CONTENT_CONTRIBUTION_CONFIG,
  );
  return getContentContributionConfig();
}

export function hasStaticContentContributionType(key: string): boolean {
  return contributionConfig.types.some((type) => type.key === key);
}

export async function loadPersistedContentContributionTypes(
  options: { db?: DatabaseInterface | null } = {},
): Promise<PersistedContentContributionTypeRecord[]> {
  if (!options.db) {
    return [];
  }

  try {
    const rows = (await options.db.list(
      'content_contribution_types',
      {},
    )) as Record<string, unknown>[];
    rows.sort((a, b) =>
      String(a.created_at || a.createdAt || '').localeCompare(
        String(b.created_at || b.createdAt || ''),
      ),
    );
    return rows.map((row) => mapPersistedTypeRow(row));
  } catch (error) {
    if (isMissingContributionTypesTableError(error)) {
      return [];
    }

    throw error;
  }
}

export async function getEffectiveContentContributionConfig(
  options: { db?: DatabaseInterface | null } = {},
): Promise<ContentContributionConfig> {
  const persisted = await loadPersistedContentContributionTypes({
    db: options.db,
  });

  return {
    types: mergeByKey(
      contributionConfig.types,
      persisted,
      cloneTypeDefinition as (
        item: ContentContributionTypeDefinition,
      ) => ContentContributionTypeDefinition,
    ),
  };
}

export async function getContentContributionTypeConfigState(
  options: { db?: DatabaseInterface | null } = {},
): Promise<ContentContributionTypeConfigState> {
  const [effective, persisted] = await Promise.all([
    getEffectiveContentContributionConfig(options),
    loadPersistedContentContributionTypes(options),
  ]);

  return {
    effective: effective.types,
    persisted: persisted.map(clonePersistedTypeRecord),
  };
}

export async function resolveEffectiveContentContributionType(
  key: string,
  options: { db?: DatabaseInterface | null } = {},
): Promise<ResolvedContentContributionType | null> {
  const effective = await getEffectiveContentContributionConfig(options);
  const type = effective.types.find((entry) => entry.key === key);
  return type ? cloneTypeDefinition(type) : null;
}

function matchesMimePattern(mimeType: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }

  if (pattern.endsWith('/*')) {
    return mimeType.startsWith(pattern.slice(0, -1));
  }

  return mimeType === pattern;
}

function matchesAnyMimePattern(mimeType: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesMimePattern(mimeType, pattern));
}

function containsPattern(text: string, patterns: string[]): boolean {
  const lowerText = text.toLowerCase();
  return patterns.some((pattern) => lowerText.includes(pattern.toLowerCase()));
}

export function evaluateContributionIntake(
  options: EvaluateContributionIntakeOptions,
): EvaluateContributionIntakeResult {
  const type = cloneTypeDefinition(options.contributionType);
  const rules = cloneIntakeRules(type.intakeRules);
  const trustLevel = options.trustLevel || 'standard';
  const attachments = options.attachments || [];
  const text = [options.title, options.description, options.body]
    .filter(Boolean)
    .join('\n')
    .trim();
  const hasText = text.length > 0;
  const hasFiles = attachments.length > 0;
  const totalBytes = attachments.reduce(
    (sum, attachment) => sum + Math.max(0, attachment.size || 0),
    0,
  );
  const reasons: string[] = [];

  if (type.enabled === false) {
    return {
      decision: 'rejected',
      reasons: ['This contribution type is currently disabled.'],
    };
  }

  if (
    Array.isArray(type.allowedChannels) &&
    type.allowedChannels.length > 0 &&
    !type.allowedChannels.includes(options.channel)
  ) {
    return {
      decision: 'rejected',
      reasons: [
        `${options.channel} submissions are not allowed for this type.`,
      ],
    };
  }

  if (trustLevel === 'blocked') {
    return {
      decision: 'rejected',
      reasons: ['This contributor is blocked from submitting new material.'],
    };
  }

  if (rules.trustedOnly && trustLevel !== 'trusted') {
    return {
      decision: 'rejected',
      reasons: ['This contribution type is limited to trusted contributors.'],
    };
  }

  if (type.allowText === false && hasText) {
    return {
      decision: 'rejected',
      reasons: ['This contribution type does not accept text submissions.'],
    };
  }

  if (type.allowFiles !== true && hasFiles) {
    return {
      decision: 'rejected',
      reasons: ['This contribution type does not accept file attachments.'],
    };
  }

  if (
    type.allowText === true &&
    type.allowEmptyText !== true &&
    !hasText &&
    !hasFiles
  ) {
    return {
      decision: 'rejected',
      reasons: ['A text body or at least one attachment is required.'],
    };
  }

  if (
    typeof rules.maxFiles === 'number' &&
    attachments.length > rules.maxFiles
  ) {
    return {
      decision: 'rejected',
      reasons: [
        `This contribution type accepts at most ${rules.maxFiles} files.`,
      ],
    };
  }

  if (
    typeof rules.maxTotalBytes === 'number' &&
    totalBytes > rules.maxTotalBytes
  ) {
    return {
      decision: 'rejected',
      reasons: [
        'The attached files exceed the size limit for this contribution type.',
      ],
    };
  }

  const mimeTypes = attachments
    .map((attachment) => attachment.mimeType || '')
    .filter(Boolean);

  if (
    rules.allowedMimePatterns &&
    rules.allowedMimePatterns.length > 0 &&
    mimeTypes.some(
      (mimeType) =>
        !matchesAnyMimePattern(mimeType, rules.allowedMimePatterns || []),
    )
  ) {
    return {
      decision: 'rejected',
      reasons: ['One or more attachments use a file type that is not allowed.'],
    };
  }

  if (
    mimeTypes.some((mimeType) =>
      matchesAnyMimePattern(mimeType, rules.blockedMimePatterns || []),
    )
  ) {
    return {
      decision: 'rejected',
      reasons: ['One or more attachments match blocked file-type rules.'],
    };
  }

  if (containsPattern(text, rules.blockedTextPatterns || [])) {
    return {
      decision: 'rejected',
      reasons: ['The submission body matches blocked intake rules.'],
    };
  }

  if (
    mimeTypes.some((mimeType) =>
      matchesAnyMimePattern(mimeType, rules.quarantineMimePatterns || []),
    )
  ) {
    reasons.push('One or more attachments triggered quarantine file rules.');
  }

  if (containsPattern(text, rules.quarantineTextPatterns || [])) {
    reasons.push('The submission body triggered quarantine text rules.');
  }

  if (reasons.length > 0) {
    return {
      decision: 'quarantined',
      reasons,
    };
  }

  return {
    decision: 'accepted',
    reasons: [],
  };
}
