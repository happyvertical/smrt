import type { Fact, FactContentRelationship } from '@happyvertical/smrt-facts';
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

export interface ContentReviewPolicy {
  key: string;
  label?: string;
  kind?: ContentReviewKind;
  instructions: string;
}

export interface ContentReviewRequirement {
  policyKey: string;
  label?: string;
  blocking?: boolean;
  acceptedStatuses?: ContentReviewStatus[];
  when?: (content: Content) => boolean;
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
}

export interface ContentGovernanceState {
  isFactual: boolean;
  defaultFactRelationship: FactContentRelationship;
  publicationReviewProfileKey: string;
  enforcePublishReadiness: boolean;
  reviewPolicies: ContentReviewPolicyDefinition[];
  reviewProfiles: ContentReviewProfileEvaluation[];
}

export interface ContentGovernanceConfig {
  isFactual?: (content: Content) => boolean;
  defaultFactRelationship: FactContentRelationship;
  publicationReviewProfileKey: string;
  enforcePublishReadiness: boolean | ((content: Content) => boolean);
  safetyPrompt: string;
  reviewPolicies: Record<string, ContentReviewPolicy>;
  reviewProfiles: Record<string, ContentReviewRequirement[]>;
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
  policy?: ContentReviewPolicy | null;
  customInstructions?: string;
}

export const DEFAULT_SAFETY_PROMPT = [
  'Review the content for legal, reputational, and user-safety risks.',
  'At minimum, check for defamation risk, privacy leaks, unverified allegations, unsafe instructions, and medical, legal, or financial claims that need qualification.',
  'Flag content that should be softened, attributed, removed, or escalated for human review.',
].join(' ');

const DEFAULT_REVIEW_POLICIES: Record<string, ContentReviewPolicy> = {
  facts: {
    key: 'facts',
    label: 'Facts Review',
    kind: 'facts',
    instructions: [
      'Compare the draft copy against the supplied facts only.',
      'Flag contradictions, unsupported claims, stale claims, and places where the copy should cite or qualify a statement.',
      'Do not invent missing facts. If the draft makes a claim that is not supported by the provided facts, flag it clearly.',
    ].join(' '),
  },
  safety: {
    key: 'safety',
    label: 'Safety Review',
    kind: 'safety',
    instructions: DEFAULT_SAFETY_PROMPT,
  },
};

const DEFAULT_REVIEW_PROFILES: Record<string, ContentReviewRequirement[]> = {
  publication: [
    {
      policyKey: 'safety',
      label: 'Safety Review',
      blocking: false,
    },
    {
      policyKey: 'facts',
      label: 'Facts Review',
      blocking: false,
      when: (content) => isFactualContentEnabled(content),
    },
  ],
  correction: [
    {
      policyKey: 'safety',
      label: 'Safety Review',
      blocking: false,
    },
  ],
};

let governanceConfig: ContentGovernanceConfig = {
  defaultFactRelationship: 'supports',
  publicationReviewProfileKey: 'publication',
  enforcePublishReadiness: false,
  safetyPrompt: DEFAULT_SAFETY_PROMPT,
  reviewPolicies: { ...DEFAULT_REVIEW_POLICIES },
  reviewProfiles: { ...DEFAULT_REVIEW_PROFILES },
};

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

function cloneReviewProfiles(
  profiles: Record<string, ContentReviewRequirement[]>,
): Record<string, ContentReviewRequirement[]> {
  return Object.fromEntries(
    Object.entries(profiles).map(([key, requirements]) => [
      key,
      requirements.map(cloneReviewRequirement),
    ]),
  );
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
  return {
    ...governanceConfig,
    reviewPolicies: { ...governanceConfig.reviewPolicies },
    reviewProfiles: cloneReviewProfiles(governanceConfig.reviewProfiles),
  };
}

export function configureContentGovernance(
  config: Partial<ContentGovernanceConfig>,
): ContentGovernanceConfig {
  governanceConfig = {
    ...governanceConfig,
    ...config,
    reviewPolicies: config.reviewPolicies
      ? {
          ...governanceConfig.reviewPolicies,
          ...config.reviewPolicies,
        }
      : { ...governanceConfig.reviewPolicies },
    reviewProfiles: config.reviewProfiles
      ? {
          ...cloneReviewProfiles(governanceConfig.reviewProfiles),
          ...cloneReviewProfiles(config.reviewProfiles),
        }
      : cloneReviewProfiles(governanceConfig.reviewProfiles),
  };

  return getContentGovernanceConfig();
}

export function resetContentGovernanceConfig(): ContentGovernanceConfig {
  governanceConfig = {
    defaultFactRelationship: 'supports',
    publicationReviewProfileKey: 'publication',
    enforcePublishReadiness: false,
    safetyPrompt: DEFAULT_SAFETY_PROMPT,
    reviewPolicies: { ...DEFAULT_REVIEW_POLICIES },
    reviewProfiles: cloneReviewProfiles(DEFAULT_REVIEW_PROFILES),
  };

  return getContentGovernanceConfig();
}

export function getContentReviewPolicy(
  policyKey: string,
): ContentReviewPolicy | null {
  return governanceConfig.reviewPolicies[policyKey] ?? null;
}

export function getContentReviewKind(
  policyKey: string,
  fallback: ContentReviewKind = 'custom',
): ContentReviewKind {
  const configuredKind = governanceConfig.reviewPolicies[policyKey]?.kind;
  if (configuredKind) {
    return configuredKind;
  }

  if (policyKey === 'facts' || policyKey === 'safety') {
    return policyKey;
  }

  return fallback;
}

export function getContentReviewProfile(
  profileKey: string,
): ContentReviewRequirement[] {
  const requirements = governanceConfig.reviewProfiles[profileKey] ?? [];
  return requirements.map(cloneReviewRequirement);
}

export function getContentReviewProfileKeys(): string[] {
  return Object.keys(governanceConfig.reviewProfiles);
}

export function getContentReviewPolicies(): ContentReviewPolicyDefinition[] {
  return Object.values(governanceConfig.reviewPolicies).map((policy) => ({
    key: policy.key,
    label: policy.label || policy.key,
    kind: getContentReviewKind(policy.key),
    instructions: policy.instructions,
  }));
}

export function getContentReviewRequirements(
  content: Content,
  profileKey: string,
): ContentReviewRequirement[] {
  return getContentReviewProfile(profileKey).filter((requirement) =>
    typeof requirement.when === 'function' ? requirement.when(content) : true,
  );
}

export function getAcceptedContentReviewStatuses(
  requirement: Pick<ContentReviewRequirement, 'acceptedStatuses'>,
): ContentReviewStatus[] {
  return requirement.acceptedStatuses && requirement.acceptedStatuses.length > 0
    ? [...requirement.acceptedStatuses]
    : ['passed', 'waived'];
}

export function getContentPublicationReviewProfileKey(): string {
  return governanceConfig.publicationReviewProfileKey || 'publication';
}

export function isContentPublishReadinessEnforced(content: Content): boolean {
  const { enforcePublishReadiness } = governanceConfig;

  if (typeof enforcePublishReadiness === 'function') {
    return enforcePublishReadiness(content);
  }

  return enforcePublishReadiness === true;
}

export function isFactualContentEnabled(content: Content): boolean {
  if (typeof governanceConfig.isFactual === 'function') {
    return governanceConfig.isFactual(content);
  }

  const metadata = (content.metadata ?? {}) as Record<string, any>;
  const governance = (metadata.governance ?? {}) as Record<string, any>;

  return (
    content.constructor.name === 'FactualContent' ||
    metadata.factual === true ||
    governance.enabled === true ||
    governance.factual === true
  );
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
    (kind === 'safety'
      ? governanceConfig.safetyPrompt
      : DEFAULT_REVIEW_POLICIES[kind]?.instructions || '');

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
