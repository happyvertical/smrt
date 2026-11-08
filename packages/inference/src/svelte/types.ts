/**
 * Presentational types for the inference settings UI (#4754).
 *
 * Deliberately free of `@happyvertical/smrt-core`, the AI SDK and the
 * `@smrt()` model, so the browser bundle stays a thin presentation layer.
 * Field names match the rows `InferenceSettingsService` returns
 * (`./server`), so a row is structurally assignable to its view with no
 * mapping step.
 *
 * @module
 */

export const INFERENCE_SETTINGS_TIERS = [
  'cheap',
  'good',
  'great',
  'best',
] as const;
export type InferenceSettingsTier = (typeof INFERENCE_SETTINGS_TIERS)[number];

export const INFERENCE_SETTINGS_MODES = [
  'byo',
  'local',
  'hosted',
  'off',
] as const;
export type InferenceSettingsMode = (typeof INFERENCE_SETTINGS_MODES)[number];

export type InferenceSettingsLevelView =
  | 'default'
  | 'config'
  | 'app'
  | 'tenant';
export type InferenceSettingsScope = 'app' | 'tenant';

/**
 * A tier target as the panel reads and emits it: a model, an alias or a
 * fusion. Never a key, never an endpoint (an endpoint belongs in an alias).
 * `null` means "same as default".
 */
export interface InferenceTargetView {
  kind?: string;
  provider?: string;
  model?: string;
  alias?: string;
  fusion?: string;
  candidates?: unknown[];
}

/** The user's choices for the default view, plus whether a key is stored. */
export interface InferenceDefaultsView {
  mode?: InferenceSettingsMode;
  provider?: string;
  baseUrl?: string;
  model?: string;
  defaultTier?: InferenceSettingsTier;
  /** Whether the host holds a key for {@link provider}. The key itself never comes back. */
  keySet?: boolean;
}

/** What Save emits from the default view. Never contains a key. */
export interface InferenceDefaultsChange {
  mode: InferenceSettingsMode;
  provider?: string;
  baseUrl?: string;
  model?: string;
  defaultTier?: InferenceSettingsTier;
}

/** What the replace-key action emits. The host stores it through smrt-secrets. */
export interface InferenceKeyChange {
  provider: string;
  key: string;
}

/** One provider choice (`InferenceProviderOption` from `./server`). */
export interface InferenceProviderView {
  id: string;
  label: string;
  kind: 'preset' | 'provider';
  baseUrl?: string;
  requiresApiKey: boolean;
  needsBaseUrl?: boolean;
  local?: boolean;
}

/** Local discovery results (#4674). */
export interface InferenceDiscoveryView {
  service: string;
  baseUrl: string;
  models: string[];
}

/** What Test connection asks the host to probe. Never carries a key. */
export interface InferenceConnectionRequest {
  provider?: string;
  preset?: string;
  baseUrl?: string;
  model?: string;
}

/** Key-free probe result (`InferenceConnectionResult`). */
export interface InferenceTestResultView {
  reachable: boolean;
  skipped?: boolean;
  status?: number;
  durationMs?: number;
  detail: string;
}

/** One tier row (`InferenceTierSettingsRow`). */
export interface InferenceTierView {
  tier: InferenceSettingsTier;
  effectiveTarget?: InferenceTargetView | null;
  effectiveLabel: string;
  supplyingLevel?: InferenceSettingsLevelView;
  appTarget?: InferenceTargetView | null;
  tenantTarget?: InferenceTargetView | null;
  /** What reverting the app scope produces. */
  appRevertLabel?: string;
  /** What reverting the tenant scope produces (`null`: not computed). */
  inheritedLabel?: string | null;
  tenantAllowList?: string[] | null;
  tenantBlocked?: boolean;
}

/** `auto`'s default tier (`InferenceDefaultTierSetting`). */
export interface InferenceDefaultTierView {
  effectiveTier: InferenceSettingsTier;
  supplyingLevel?: InferenceSettingsLevelView;
  appTier?: InferenceSettingsTier | null;
  tenantTier?: InferenceSettingsTier | null;
  appRevertTier?: InferenceSettingsTier;
  inheritedTier?: InferenceSettingsTier | null;
  tenantAllowList?: string[] | null;
  tenantBlocked?: boolean;
}

/** One candidate of an alias chain. `apiKeyEnv` names a variable; there is never a key. */
export interface InferenceCandidateView {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  preset?: string;
  alias?: string;
  params?: Record<string, unknown>;
}

/** One alias (`InferenceAliasSetting`). */
export interface InferenceAliasView {
  name: string;
  source?: 'config' | 'app';
  candidates: InferenceCandidateView[];
  description?: string;
  inConfig?: boolean;
}

/** One fusion (`InferenceFusionSetting`). */
export interface InferenceFusionView {
  name: string;
  source: 'registry' | 'config' | 'app';
  definition: Record<string, unknown>;
  description?: string;
  editable?: boolean;
}

/** Usage report (`reportAiUsage()`, #4751), structurally. */
export interface InferenceUsageView {
  by: string[];
  costBasis?: string;
  buckets: Array<{
    key: Record<string, string | null | undefined>;
    calls: number;
    totalTokens: number;
    estimatedCost: number;
    uncostedCalls?: number;
    outcomes?: Record<string, number>;
  }>;
}

export type InferenceUsageDimension = 'model' | 'tier' | 'prompt';

export interface InferenceTierChange {
  tier: InferenceSettingsTier;
  scope: InferenceSettingsScope;
  target: InferenceTargetView | null;
}

export interface InferenceDefaultTierChange {
  scope: InferenceSettingsScope;
  tier: InferenceSettingsTier | null;
}

export interface InferenceAliasChange {
  name: string;
  /** `null` removes the app definition. */
  candidates: InferenceCandidateView[] | null;
  description?: string;
}

export interface InferenceFusionChange {
  name: string;
  /** `null` removes the config entry. */
  definition: Record<string, unknown> | null;
}

/** Human label for a supplying level. */
export function inferenceLevelLabel(
  level: InferenceSettingsLevelView | undefined,
): string {
  switch (level) {
    case 'tenant':
      return 'Tenant override';
    case 'app':
      return 'App override';
    case 'config':
      return 'Config';
    default:
      return 'Default';
  }
}

/** Key-free label of a target. Mirrors `describeInferenceTarget()` in `./server`. */
export function describeTargetView(
  target: InferenceTargetView | null | undefined,
): string {
  if (!target || Object.keys(target).length === 0) {
    return 'Same as default (configured client)';
  }
  if (target.kind === 'fusion' || target.fusion) {
    return `Fusion ${target.fusion ?? '?'}`;
  }
  if (target.alias) return `Alias ${target.alias}`;
  if (Array.isArray(target.candidates)) {
    return `${target.candidates.length} inline candidate(s)`;
  }
  return `${target.provider ?? 'default'}/${target.model ?? 'default model'}`;
}

/** Key-free label of a candidate (`provider/model`, `preset:<id>/model`, `alias <name>`). */
export function candidateViewLabel(candidate: InferenceCandidateView): string {
  if (candidate.alias) return `alias ${candidate.alias}`;
  const model = candidate.model ?? 'default';
  if (candidate.preset) return `preset:${candidate.preset}/${model}`;
  return `${candidate.provider ?? 'default'}/${model}`;
}

/** Allow-list reference of a target. Mirrors `inferenceTargetRef()` in `./server`. */
export function targetViewRef(target: InferenceTargetView): string {
  if (target.kind === 'fusion' || target.fusion) {
    return `fusion:${target.fusion ?? ''}`;
  }
  if (target.alias) return `alias:${target.alias}`;
  return `model:${target.provider ?? 'default'}/${target.model ?? 'default'}`;
}

/**
 * Whether a reference is on an allow-list (exact, trailing `*`, or `*`).
 * Display only: the server enforces the list on every tenant write.
 */
export function isRefAllowed(
  ref: string,
  allowList: readonly string[] | null | undefined,
): boolean {
  return (allowList ?? []).some((pattern) =>
    pattern === '*'
      ? true
      : pattern.endsWith('*')
        ? ref.startsWith(pattern.slice(0, -1))
        : ref === pattern,
  );
}

/** What reverting a tier at `scope` produces (the prompts revert invariant). */
export function tierRevertPreview(
  row: InferenceTierView,
  scope: InferenceSettingsScope,
): string {
  if (scope === 'app') return row.appRevertLabel ?? row.effectiveLabel;
  return row.inheritedLabel ?? row.appRevertLabel ?? row.effectiveLabel;
}

/** The tier `auto` returns to when the scope reverts. */
export function defaultTierRevertPreview(
  view: InferenceDefaultTierView,
  scope: InferenceSettingsScope,
): InferenceSettingsTier {
  if (scope === 'app') return view.appRevertTier ?? view.effectiveTier;
  return view.inheritedTier ?? view.appRevertTier ?? view.effectiveTier;
}

/** Usage columns to render: only the dimensions the report was grouped by. */
export function usageColumns(view: InferenceUsageView): string[] {
  return view.by.filter((dimension) => dimension.length > 0);
}
