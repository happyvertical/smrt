/**
 * Hosted inference provisioning (#4759), Node-only (`./node`).
 *
 * When a member gains `inference.hosted`, SMRT mints them a per-user virtual
 * key on the operator's AI gateway (`bifrost` or `litellm`, through the
 * `ai.admin` surface of `@happyvertical/ai`; SMRT never talks to a gateway's
 * admin API itself) and stores it where the BYO path already looks: the
 * user's `inference.provider-config` secret (#4756) with `source: 'hosted'`
 * and `mode: 'hosted'` (#4757). Switching to hosted therefore changes only
 * the stored provider config.
 *
 * Storage (all smrt-secrets rows under `context = tenantId`, every write and
 * delete audited through `SecretAuditLog` with an `operation` detail):
 * - `inference.provider-config:user:<userId>`: the hosted binding (holds the
 *   virtual key; the only place it lives).
 * - `inference.hosted:user:<userId>`: provisioning state: status, lifecycle
 *   generation, the key's non-secret id and alias, the budget, and the
 *   user's prior provider config (restored on revoke).
 * - `inference.hosted:project`: the tenant's gateway project id.
 *
 * Idempotency: provisioning runs under `runOnce()` per `(tenantId, userId,
 * generation)`, so concurrent deliveries create one key; the generation
 * advances on every revoke, so a later re-provision runs again. The tenant
 * project is looked up on the gateway (`listProjects`) before one is
 * created, so a crash between create and persist never makes a second. Lifecycle
 * operations run one at a time per process and, on PostgreSQL, under a
 * per-tenant advisory lock across processes. A revoke ends local
 * use of the key whatever the gateway answers; deletions the gateway could
 * not perform are kept as `pendingGatewayRevocations` and retried by
 * `revoke()` / `reconcileTenant()`.
 *
 * The key never appears in returned objects, errors, logs, usage tags,
 * audit details or `runOnce()` results: usage rows carry `source: hosted`
 * and the key's alias (`gatewayKeyAlias`) only.
 */
import type {
  AIAdminBudget,
  AIAdminInterface,
  AIAdminProject,
  AIVirtualKey,
  CreateAIVirtualKeyOptions,
} from '@happyvertical/ai';
import {
  ensureSystemTables,
  INFERENCE_TIERS,
  type InferenceTier,
  isPostgresDatabase,
  runOnce,
} from '@happyvertical/smrt-core';
import { SmrtError } from '@happyvertical/smrt-core/smrt-error';
import { SecretService } from '@happyvertical/smrt-secrets';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { classifyInferenceFailure } from './classify.js';
import {
  INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
  type InferenceProviderBinding,
  type InferenceProviderConfig,
  inferenceProviderBindingFor,
  inferenceProviderConfigSecretName,
  parseInferenceProviderConfig,
} from './provider-config.js';
import { invalidateUserInferenceResolvers } from './resolver.js';

/** The feature key that entitles hosted inference (`smrt-features`' `FEATURE_INFERENCE_HOSTED`). */
export const HOSTED_INFERENCE_FEATURE_KEY = 'inference.hosted';

/** smrt-secrets category of the hosted state and project rows. */
export const HOSTED_INFERENCE_SECRET_CATEGORY = 'inference.hosted';

/** Gateway providers of `@happyvertical/ai` that expose `ai.admin`. */
export const HOSTED_GATEWAY_PROVIDERS = ['bifrost', 'litellm'] as const;

export type HostedGatewayProvider = (typeof HOSTED_GATEWAY_PROVIDERS)[number];

/** Budget reset windows; mapped to the gateway's reset duration. */
export const HOSTED_BUDGET_WINDOWS = ['day', 'week', 'month', 'year'] as const;

export type HostedBudgetWindow = (typeof HOSTED_BUDGET_WINDOWS)[number];

const WINDOW_DURATION: Record<HostedBudgetWindow, string> = {
  day: '1d',
  week: '7d',
  month: '30d',
  year: '365d',
};

/**
 * A hosted user's spend cap. Money is an integer: micro-dollars (USD ×
 * 1,000,000), the unit #4760's spend gate meters. Converted to the gateway's
 * USD `maxLimit` only at the admin call.
 */
export interface HostedInferenceBudget {
  limitMicros: number;
  /** Reset window. Default `month`. */
  window?: HostedBudgetWindow;
}

/** Error codes of {@link HostedInferenceError}. */
export type HostedInferenceErrorCode =
  | 'HOSTED_INFERENCE_INVALID'
  | 'HOSTED_GATEWAY_NOT_CONFIGURED'
  | 'HOSTED_GATEWAY_UNSUPPORTED'
  | 'HOSTED_GATEWAY_FAILED'
  | 'HOSTED_STATE_INVALID'
  | 'HOSTED_NOT_ENTITLED';

/**
 * A provisioning failure. Messages name fields and operations, never a key,
 * an admin credential or a gateway response body.
 */
export class HostedInferenceError extends SmrtError {
  constructor(
    message: string,
    code: HostedInferenceErrorCode,
    details: Record<string, unknown> = {},
  ) {
    super(message, code, 'configuration', details);
  }
}

// ---------------------------------------------------------------------------
// Gateway configuration and admin client
// ---------------------------------------------------------------------------

/**
 * The operator's gateway. Admin credentials stay in this object (built once
 * from the host environment) and are only handed to `@happyvertical/ai`.
 */
export interface HostedGatewayConfig {
  provider: HostedGatewayProvider;
  /** OpenAI-compatible inference endpoint the virtual keys are used against. */
  baseUrl: string;
  /** Admin API root, when it differs from `baseUrl`. */
  adminUrl?: string;
  /** LiteLLM master key, or a Bifrost admin virtual key. */
  adminApiKey?: string;
  /** Bifrost governance Basic-auth user. */
  adminUser?: string;
  /** Bifrost governance Basic-auth password. */
  adminPassword?: string;
  /** Default model of the stored binding. */
  model?: string;
  /** Per-tier models of the stored binding. */
  tiers?: Partial<Record<InferenceTier, string>>;
  /** Models the virtual key may use. Default: `model` plus the tier models. */
  models?: string[];
  /** Key lifetime (`30d`, `permanent`, ...), where the gateway supports it. */
  keyDuration?: string;
  /**
   * Deadline for each admin call in ms (default
   * {@link HOSTED_GATEWAY_ADMIN_TIMEOUT_MS}). A call past it counts as
   * failed, so a stalled gateway never holds the lifecycle lock.
   */
  adminTimeoutMs?: number;
}

/** Default deadline of one gateway admin call. */
export const HOSTED_GATEWAY_ADMIN_TIMEOUT_MS = 30_000;

/** The `AIAdminInterface` calls provisioning uses. */
export const HOSTED_GATEWAY_ADMIN_METHODS = [
  'createProject',
  'createVirtualKey',
  'updateVirtualKey',
  'deleteVirtualKey',
  'listProjects',
] as const;

/**
 * The admin surface provisioning uses (`@happyvertical/ai` >= 0.111.7,
 * happyvertical/sdk#1494). Plan changes send only `budget` to
 * `updateVirtualKey` (Bifrost refuses `models` / `metadata`, LiteLLM
 * `providerConfigs`, with `ADMIN_UNSUPPORTED_FIELD`); `deleteVirtualKey`
 * resolving `false` means the key is already gone.
 */
export type HostedGatewayAdmin = Pick<
  AIAdminInterface,
  (typeof HOSTED_GATEWAY_ADMIN_METHODS)[number]
>;

/** Environment variables {@link hostedGatewayConfigFromEnv} reads. */
export const HOSTED_GATEWAY_ENV = {
  provider: 'SMRT_INFERENCE_HOSTED_PROVIDER',
  baseUrl: 'SMRT_INFERENCE_HOSTED_BASE_URL',
  adminUrl: 'SMRT_INFERENCE_HOSTED_ADMIN_URL',
  adminApiKey: 'SMRT_INFERENCE_HOSTED_ADMIN_KEY',
  adminUser: 'SMRT_INFERENCE_HOSTED_ADMIN_USER',
  adminPassword: 'SMRT_INFERENCE_HOSTED_ADMIN_PASSWORD',
  model: 'SMRT_INFERENCE_HOSTED_MODEL',
  models: 'SMRT_INFERENCE_HOSTED_MODELS',
  keyDuration: 'SMRT_INFERENCE_HOSTED_KEY_DURATION',
  adminTimeoutMs: 'SMRT_INFERENCE_HOSTED_ADMIN_TIMEOUT_MS',
} as const;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Validate a gateway config. Throws `HOSTED_GATEWAY_NOT_CONFIGURED` naming
 * the missing or invalid fields (never their values).
 */
export function parseHostedGatewayConfig(
  value: Partial<HostedGatewayConfig>,
): HostedGatewayConfig {
  const issues: string[] = [];
  const provider = text(value.provider)?.toLowerCase();
  if (
    !provider ||
    !(HOSTED_GATEWAY_PROVIDERS as readonly string[]).includes(provider)
  ) {
    issues.push(
      `provider must be one of ${HOSTED_GATEWAY_PROVIDERS.join(', ')}`,
    );
  }
  const baseUrl = text(value.baseUrl);
  if (!baseUrl || !isPlainHttpUrl(baseUrl)) {
    issues.push(
      'baseUrl must be an http(s) URL without credentials, query or fragment',
    );
  }
  const adminUrl = text(value.adminUrl);
  if (adminUrl && !isPlainHttpUrl(adminUrl)) {
    issues.push(
      'adminUrl must be an http(s) URL without credentials, query or fragment',
    );
  }
  const adminApiKey = text(value.adminApiKey);
  const adminUser = text(value.adminUser);
  const adminPassword = text(value.adminPassword);
  if (provider === 'litellm' && !adminApiKey) {
    issues.push('adminApiKey (the LiteLLM master key) is required for litellm');
  }
  if (provider === 'bifrost' && !adminApiKey && !(adminUser && adminPassword)) {
    issues.push(
      'bifrost needs adminApiKey or both adminUser and adminPassword',
    );
  }
  const tiers: Partial<Record<InferenceTier, string>> = {};
  for (const tier of INFERENCE_TIERS) {
    const model = text(value.tiers?.[tier]);
    if (model) tiers[tier] = model;
  }
  const adminTimeoutMs = value.adminTimeoutMs;
  if (
    adminTimeoutMs !== undefined &&
    (!Number.isSafeInteger(adminTimeoutMs) || adminTimeoutMs <= 0)
  ) {
    issues.push('adminTimeoutMs must be a positive integer (ms)');
  }
  const model = text(value.model);
  const models = (value.models ?? [])
    .map((entry) => text(entry))
    .filter((entry): entry is string => !!entry);
  if (issues.length > 0) {
    throw new HostedInferenceError(
      `Hosted inference gateway is not configured: ${issues.join('; ')}`,
      'HOSTED_GATEWAY_NOT_CONFIGURED',
      { issues },
    );
  }
  return {
    provider: provider as HostedGatewayProvider,
    baseUrl: baseUrl as string,
    ...(adminUrl ? { adminUrl } : {}),
    ...(adminApiKey ? { adminApiKey } : {}),
    ...(adminUser ? { adminUser } : {}),
    ...(adminPassword ? { adminPassword } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(text(value.keyDuration)
      ? { keyDuration: text(value.keyDuration) }
      : {}),
    ...(adminTimeoutMs !== undefined ? { adminTimeoutMs } : {}),
  };
}

/**
 * Build the gateway config from environment variables
 * ({@link HOSTED_GATEWAY_ENV}, plus `SMRT_INFERENCE_HOSTED_<TIER>_MODEL`).
 * `undefined` when `SMRT_INFERENCE_HOSTED_PROVIDER` is unset (hosted
 * inference off); throws when it is set but incomplete.
 */
export function hostedGatewayConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): HostedGatewayConfig | undefined {
  if (!text(env[HOSTED_GATEWAY_ENV.provider])) return undefined;
  const tiers: Partial<Record<InferenceTier, string>> = {};
  for (const tier of INFERENCE_TIERS) {
    const model = text(
      env[`SMRT_INFERENCE_HOSTED_${tier.toUpperCase()}_MODEL`],
    );
    if (model) tiers[tier] = model;
  }
  return parseHostedGatewayConfig({
    provider: env[HOSTED_GATEWAY_ENV.provider] as HostedGatewayProvider,
    baseUrl: env[HOSTED_GATEWAY_ENV.baseUrl],
    adminUrl: env[HOSTED_GATEWAY_ENV.adminUrl],
    adminApiKey: env[HOSTED_GATEWAY_ENV.adminApiKey],
    adminUser: env[HOSTED_GATEWAY_ENV.adminUser],
    adminPassword: env[HOSTED_GATEWAY_ENV.adminPassword],
    model: env[HOSTED_GATEWAY_ENV.model],
    tiers,
    models: (env[HOSTED_GATEWAY_ENV.models] ?? '').split(','),
    keyDuration: env[HOSTED_GATEWAY_ENV.keyDuration],
    ...(text(env[HOSTED_GATEWAY_ENV.adminTimeoutMs])
      ? {
          adminTimeoutMs: Number(text(env[HOSTED_GATEWAY_ENV.adminTimeoutMs])),
        }
      : {}),
  });
}

let envConfig: { value: HostedGatewayConfig | undefined } | undefined;

/**
 * The process gateway config, read from the environment once and cached.
 * Throws `HOSTED_GATEWAY_NOT_CONFIGURED` when hosted inference is not set up.
 */
export function getHostedGatewayConfig(): HostedGatewayConfig {
  envConfig ??= { value: hostedGatewayConfigFromEnv() };
  if (!envConfig.value) {
    throw new HostedInferenceError(
      `Hosted inference gateway is not configured: set ${HOSTED_GATEWAY_ENV.provider} (bifrost or litellm), ${HOSTED_GATEWAY_ENV.baseUrl} and the admin credentials.`,
      'HOSTED_GATEWAY_NOT_CONFIGURED',
    );
  }
  return envConfig.value;
}

/** Forget the cached environment config (tests). */
export function resetHostedGatewayConfig(): void {
  envConfig = undefined;
}

/**
 * The `ai.admin` surface of the configured gateway provider, built through
 * `getAI()` of `@happyvertical/ai`. Throws `HOSTED_GATEWAY_UNSUPPORTED` when
 * the installed SDK's provider lacks any of {@link HOSTED_GATEWAY_ADMIN_METHODS}.
 */
export async function createHostedGatewayAdmin(
  config: HostedGatewayConfig,
): Promise<HostedGatewayAdmin> {
  const { getAI } = await import('@happyvertical/ai');
  const common = {
    baseUrl: config.baseUrl,
    // The client is only used for admin calls; the inference key is
    // per-user and stored separately.
    apiKey: config.adminApiKey ?? 'smrt-admin',
    timeout: config.adminTimeoutMs ?? HOSTED_GATEWAY_ADMIN_TIMEOUT_MS,
    ...(config.adminUrl ? { adminUrl: config.adminUrl } : {}),
    ...(config.adminApiKey ? { adminApiKey: config.adminApiKey } : {}),
  };
  const ai =
    config.provider === 'bifrost'
      ? await getAI({
          type: 'bifrost',
          ...common,
          ...(config.adminUser ? { adminUser: config.adminUser } : {}),
          ...(config.adminPassword
            ? { adminPassword: config.adminPassword }
            : {}),
        })
      : await getAI({ type: 'litellm', ...common });
  const admin = ai.admin as Partial<HostedGatewayAdmin> | undefined;
  const missing = HOSTED_GATEWAY_ADMIN_METHODS.filter(
    (method) => typeof admin?.[method] !== 'function',
  );
  if (!admin || missing.length > 0) {
    throw new HostedInferenceError(
      `The ${config.provider} provider of @happyvertical/ai lacks admin calls: ${missing.join(', ')} (needs @happyvertical/ai >= 0.111.7).`,
      'HOSTED_GATEWAY_UNSUPPORTED',
      { provider: config.provider, missing },
    );
  }
  return admin as HostedGatewayAdmin;
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

/** A gateway key SMRT no longer uses but could not delete yet. */
export interface HostedPendingGatewayRevocation {
  /** The key's non-secret handle; `null` when the gateway returned none. */
  keyId: string | null;
  keyAlias: string;
  /**
   * Why it is pending: `failed` the delete call failed; `orphaned` a failed
   * provision may have left it; `unsupported` no admin client was usable or
   * the key has no id (entries recorded before `@happyvertical/ai` 0.111.7
   * also carry it). Entries with a `keyId` are retried; without one only an
   * operator can revoke the key (by alias) and acknowledge it.
   */
  reason: 'unsupported' | 'failed' | 'orphaned';
  since: string;
}

/** A user's provisioning state (`inference.hosted:user:<userId>`). */
export interface HostedInferenceState {
  version: 1;
  status: 'active' | 'revoked';
  /** Lifecycle generation; advances on every revoke. */
  generation: number;
  provider?: HostedGatewayProvider;
  projectId?: string;
  /** The gateway's non-secret key id (update/delete handle), when returned. */
  keyId: string | null;
  /** Empty when no key was ever stored (only pending cleanups). */
  keyAlias: string;
  budget?: Required<HostedInferenceBudget>;
  provisionedAt?: string;
  revokedAt?: string;
  /** The user's provider config before provisioning; dropped on revoke. */
  prior: InferenceProviderConfig | null;
  /**
   * Keys SMRT stopped using whose gateway deletion is still owed (a failed
   * delete, no usable admin or key id, or a key left by a failed provision).
   * Retried by `revoke()` and `reconcileTenant()`; never holds a key value.
   */
  pendingGatewayRevocations?: HostedPendingGatewayRevocation[];
  /**
   * The member replaced the hosted binding with their own config: reconcile
   * leaves them alone; only an explicit `provision()` re-provisions.
   */
  optedOut?: boolean;
  /**
   * Set when a budget update failed or timed out (it may still land on the
   * gateway); budget syncs re-apply the stored budget while it is set.
   */
  budgetSyncUncertainAt?: string;
}

/**
 * How long after an uncertain budget update a confirmed one must come
 * before the uncertainty is cleared (a late landing is overwritten by the
 * re-applies in between).
 */
export const HOSTED_BUDGET_UNCERTAIN_WINDOW_MS = 15 * 60_000;

/** What provisioning and revocation return: never the key. */
export interface HostedInferenceDescriptor {
  tenantId: string;
  userId: string;
  status: 'active' | 'revoked' | 'none';
  generation: number;
  provider?: HostedGatewayProvider;
  projectId?: string;
  keyId?: string | null;
  keyAlias?: string;
  budget?: Required<HostedInferenceBudget>;
  /** Non-secret handles of keys whose gateway deletion is still owed. */
  pendingGatewayRevocations?: HostedPendingGatewayRevocation[];
}

/** Result of {@link HostedInferenceProvisioner.provision}. */
export interface ProvisionHostedInferenceResult
  extends HostedInferenceDescriptor {
  /** True when this call created the key; false for an existing grant. */
  created: boolean;
  /** Budget sync outcome when an existing grant's budget differed. */
  budgetSync?: HostedBudgetSyncStatus;
}

/** How a gateway key revocation went. */
export type HostedGatewayRevokeStatus =
  | 'revoked'
  | 'missing'
  | 'unsupported'
  | 'failed'
  | 'none';

/** Result of {@link HostedInferenceProvisioner.revoke}. */
export interface RevokeHostedInferenceResult extends HostedInferenceDescriptor {
  revoked: boolean;
  /**
   * `revoked`: the gateway deleted the key; `missing`: it no longer existed
   * (already revoked); `unsupported`: no admin client is configured or the
   * gateway returned no key id; `failed`: the delete call failed. For
   * `unsupported` and `failed` SMRT has already stopped using the key and
   * records it in `pendingGatewayRevocations` (and the audit log) for a
   * later retry or a manual revocation on the gateway; `none`: nothing to
   * revoke.
   */
  gateway: HostedGatewayRevokeStatus;
  /** What the user's provider config became. */
  restored?: 'prior' | 'off' | 'kept';
}

/**
 * Budget sync outcome. `unsupported`: the grant has no gateway key id to
 * update (the stored budget stays, so a later sync retries).
 */
export type HostedBudgetSyncStatus = 'updated' | 'unchanged' | 'unsupported';

/** Result of {@link HostedInferenceProvisioner.syncBudget}. */
export interface SyncHostedBudgetResult extends HostedInferenceDescriptor {
  sync: HostedBudgetSyncStatus | 'none';
}

/** What {@link HostedInferenceProvisioner.reconcileTenant} should converge to. */
export interface HostedReconcileTarget {
  /** Whether the tenant's plan grants `inference.hosted` now. */
  entitled: boolean;
  /** The plan's budget (required to provision; syncs active grants). */
  budget?: HostedInferenceBudget;
  /** Users to hold an active grant while entitled (idempotent). */
  users?: readonly string[];
}

/** Per-user outcome of a reconcile. */
export interface HostedReconcileResult {
  tenantId: string;
  provisioned: ProvisionHostedInferenceResult[];
  revoked: RevokeHostedInferenceResult[];
  synced: SyncHostedBudgetResult[];
  /** Pending gateway deletions retried, and what is still pending. */
  pending: Array<{ userId: string; remaining: number }>;
  failures: Array<{ userId: string; error: unknown }>;
}

/** The secret store calls provisioning uses (`SecretService` satisfies it). */
export interface HostedSecretStore {
  retrieve(name: string): Promise<{ value: string }>;
  store(
    name: string,
    value: string,
    options?: {
      category?: string;
      description?: string;
      auditDetails?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  delete(
    name: string,
    options?: { auditDetails?: Record<string, unknown> },
  ): Promise<boolean>;
  list(options?: { category?: string }): Promise<Array<{ name: string }>>;
}

/** Options for {@link createHostedInferenceProvisioner}. */
export interface HostedInferenceProvisionerOptions {
  /** Database for `runOnce()` claims, the lifecycle lock and, without `secrets`, the secrets. */
  db: DatabaseInterface;
  /** Secret store; default `SecretService.create({ db })`. */
  secrets?: HostedSecretStore;
  /** Gateway config; default {@link getHostedGatewayConfig} (environment). */
  gateway?: HostedGatewayConfig;
  /** Admin client; default {@link createHostedGatewayAdmin}. Tests inject a fake. */
  admin?: HostedGatewayAdmin;
  /** Who acts, recorded as the audit user (default `system`). */
  actor?: string;
  /** Clock seam. */
  now?: () => Date;
  /** Alias/project nonce seam (tests). Default: random. */
  nonce?: () => string;
  /**
   * Current entitlement check, run inside the tenant lock before a new key
   * is minted (e.g. the host's `checkFeature('inference.hosted')`). With it,
   * a provision that arrives after a downgrade (a stale event, a late
   * retry) refuses with `HOSTED_NOT_ENTITLED` instead of activating.
   */
  entitled?: (tenantId: string) => Promise<boolean>;
}

/** Hosted provisioning bound to one database, store and gateway. */
export interface HostedInferenceProvisioner {
  provision(options: {
    tenantId: string;
    userId: string;
    budget: HostedInferenceBudget;
  }): Promise<ProvisionHostedInferenceResult>;
  /**
   * Revoke the user's active grant; with none active, retry any pending
   * gateway deletions. Idempotent.
   */
  revoke(options: {
    tenantId: string;
    userId: string;
    reason?: string;
  }): Promise<RevokeHostedInferenceResult>;
  syncBudget(options: {
    tenantId: string;
    userId: string;
    budget: HostedInferenceBudget;
  }): Promise<SyncHostedBudgetResult>;
  status(options: {
    tenantId: string;
    userId: string;
  }): Promise<HostedInferenceDescriptor>;
  /** Users of the tenant with an active hosted grant. */
  listActive(tenantId: string): Promise<string[]>;
  /** Users of the tenant with any hosted state (active, revoked, pending). */
  listKnown(tenantId: string): Promise<string[]>;
  revokeTenant(
    tenantId: string,
    options?: { reason?: string },
  ): Promise<RevokeHostedInferenceResult[]>;
  syncTenantBudget(
    tenantId: string,
    budget: HostedInferenceBudget,
  ): Promise<SyncHostedBudgetResult[]>;
  /**
   * Converge the tenant to `target` (idempotent): not entitled revokes every
   * active grant; entitled provisions `users` and syncs active budgets; both
   * retry pending gateway deletions. Run it on webhook redelivery or on a
   * schedule so a lost entitlement reaction is repaired.
   */
  reconcileTenant(
    tenantId: string,
    target: HostedReconcileTarget,
  ): Promise<HostedReconcileResult>;
  /**
   * Drop an owed gateway deletion after an operator revoked that key on the
   * gateway by hand (audited). Returns whether an entry was removed.
   */
  acknowledgeGatewayRevocation(options: {
    tenantId: string;
    userId: string;
    keyAlias: string;
  }): Promise<boolean>;
}

const STATE_PREFIX = `${HOSTED_INFERENCE_SECRET_CATEGORY}:user:`;
const PROJECT_NAME = `${HOSTED_INFERENCE_SECRET_CATEGORY}:project`;
const RUN_ONCE_ACTOR_PROJECT = 'smrt-inference-hosted';

/** Gateway project name of a tenant (also how a lost project is found). */
function hostedProjectName(tenantId: string): string {
  return `smrt tenant ${tenantId}`;
}

/** Secret name of a user's hosted state. */
export function hostedInferenceStateSecretName(userId: string): string {
  return `${STATE_PREFIX}${userId}`;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

function requireId(value: unknown, field: string): string {
  const id = text(value);
  if (!id || !ID_PATTERN.test(id)) {
    throw new HostedInferenceError(
      `${field} must be 1-200 characters of letters, digits and . _ : @ -`,
      'HOSTED_INFERENCE_INVALID',
      { field },
    );
  }
  return id;
}

/** Validate a budget; fills the default window. */
export function normalizeHostedBudget(
  budget: HostedInferenceBudget | undefined,
): Required<HostedInferenceBudget> {
  const limit = budget?.limitMicros;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new HostedInferenceError(
      'budget.limitMicros must be a positive integer (micro-dollars)',
      'HOSTED_INFERENCE_INVALID',
      { field: 'budget.limitMicros' },
    );
  }
  const window = budget?.window ?? 'month';
  if (!(HOSTED_BUDGET_WINDOWS as readonly string[]).includes(window)) {
    throw new HostedInferenceError(
      `budget.window must be one of ${HOSTED_BUDGET_WINDOWS.join(', ')}`,
      'HOSTED_INFERENCE_INVALID',
      { field: 'budget.window' },
    );
  }
  return { limitMicros: limit, window };
}

/** The gateway's budget shape for a hosted budget (USD at the boundary). */
export function toGatewayBudget(
  budget: Required<HostedInferenceBudget>,
): AIAdminBudget {
  return {
    maxLimit: budget.limitMicros / 1_000_000,
    resetDuration: WINDOW_DURATION[budget.window],
  };
}

function sameBudget(
  a: Required<HostedInferenceBudget> | undefined,
  b: Required<HostedInferenceBudget>,
): boolean {
  return !!a && a.limitMicros === b.limitMicros && a.window === b.window;
}

function parseState(value: string): HostedInferenceState {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new HostedInferenceError(
      'Stored hosted inference state is not JSON',
      'HOSTED_STATE_INVALID',
    );
  }
  const state = raw as Partial<HostedInferenceState>;
  if (
    !state ||
    typeof state !== 'object' ||
    state.version !== 1 ||
    (state.status !== 'active' && state.status !== 'revoked') ||
    typeof state.generation !== 'number' ||
    !Number.isSafeInteger(state.generation) ||
    typeof state.keyAlias !== 'string' ||
    (state.status === 'active' &&
      (typeof state.projectId !== 'string' || !state.budget))
  ) {
    throw new HostedInferenceError(
      'Stored hosted inference state is invalid',
      'HOSTED_STATE_INVALID',
    );
  }
  return {
    ...(state as HostedInferenceState),
    prior: state.prior ? parseInferenceProviderConfig(state.prior) : null,
  };
}

function isAbsentSecretError(error: unknown, name: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === `Secret '${name}' not found` ||
    error.message === 'Secret not found' ||
    error.message === 'Secret disabled' ||
    error.message === 'Secret expired'
  );
}

function describeState(
  tenantId: string,
  userId: string,
  state: HostedInferenceState | undefined,
): HostedInferenceDescriptor {
  if (!state) return { tenantId, userId, status: 'none', generation: 0 };
  return {
    tenantId,
    userId,
    status: state.status,
    generation: state.generation,
    ...(state.provider ? { provider: state.provider } : {}),
    ...(state.projectId ? { projectId: state.projectId } : {}),
    keyId: state.keyId,
    ...(state.keyAlias ? { keyAlias: state.keyAlias } : {}),
    ...(state.budget ? { budget: state.budget } : {}),
    ...(state.pendingGatewayRevocations?.length
      ? { pendingGatewayRevocations: state.pendingGatewayRevocations }
      : {}),
  };
}

/** Error code of an admin call that passed its deadline. */
const GATEWAY_TIMEOUT_CODE = 'HOSTED_GATEWAY_TIMEOUT';

/**
 * `call()` bounded by `ms`: past it the result rejects with a timeout error
 * (the call itself may still finish on the gateway; callers treat a timed
 * out create as a possibly created key).
 */
async function withDeadline<T>(
  call: () => Promise<T>,
  ms: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`Gateway ${operation} timed out`), {
            code: GATEWAY_TIMEOUT_CODE,
          }),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([call(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isGatewayTimeout(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === GATEWAY_TIMEOUT_CODE
  );
}

/**
 * Whether a failed create may still have minted the key: anything but an
 * explicit refusal (credential, quota, missing model, refusal). Timeouts,
 * transport resets, 5xx and unclassified errors are ambiguous.
 */
function mayHaveCreated(error: unknown): boolean {
  if (isGatewayTimeout(error)) return true;
  const failure = classifyInferenceFailure(error);
  return (
    failure !== 'credential' &&
    failure !== 'quota' &&
    failure !== 'missing-model' &&
    failure !== 'refusal'
  );
}

/** Name an admin-call failure without echoing the SDK's error text. */
function gatewayFailure(
  operation: string,
  error: unknown,
): HostedInferenceError {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
  const name = error instanceof Error ? error.name : typeof error;
  return new HostedInferenceError(
    `Gateway ${operation} failed (${code ?? name}).`,
    'HOSTED_GATEWAY_FAILED',
    { operation, ...(code ? { gatewayCode: code } : {}), errorName: name },
  );
}

/** The binding a hosted key stores: default plus per-tier models. */
function hostedProviderConfig(
  gateway: HostedGatewayConfig,
  apiKey: string,
  keyAlias: string,
): InferenceProviderConfig {
  const binding = (model: string | undefined): InferenceProviderBinding => ({
    provider: gateway.provider,
    baseUrl: gateway.baseUrl,
    apiKey,
    ...(model ? { model } : {}),
  });
  const tiers: Partial<Record<InferenceTier, InferenceProviderBinding>> = {};
  for (const [tier, model] of Object.entries(gateway.tiers ?? {})) {
    if (model) tiers[tier as InferenceTier] = binding(model);
  }
  return parseInferenceProviderConfig({
    version: 1,
    source: 'hosted',
    mode: 'hosted',
    gatewayKeyAlias: keyAlias,
    ...binding(gateway.model),
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
  });
}

/** Models the key may use: explicit list, else the binding's models. */
function keyModels(gateway: HostedGatewayConfig): string[] | undefined {
  if (gateway.models?.length) return gateway.models;
  const models = new Set<string>();
  if (gateway.model) models.add(gateway.model);
  for (const model of Object.values(gateway.tiers ?? {})) {
    if (model) models.add(model);
  }
  return models.size > 0 ? [...models] : undefined;
}

/** The config to restore on revoke: the prior one, or mode `off`. */
function restoredConfig(prior: InferenceProviderConfig | null): {
  config: InferenceProviderConfig;
  restored: 'prior' | 'off';
} {
  if (prior && prior.mode !== 'hosted' && prior.source !== 'hosted') {
    const hasBinding = INFERENCE_TIERS.some(
      (tier) => !!inferenceProviderBindingFor(prior, tier),
    );
    if (hasBinding || prior.mode) {
      return { config: prior, restored: 'prior' };
    }
  }
  return { config: { mode: 'off' }, restored: 'off' };
}

function defaultNonce(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * Process-wide chain of hosted lifecycle operations. One at a time per
 * process: they are rare (webhooks, operators) and this bounds the pooled
 * connections an operation holds (the PostgreSQL lock transaction plus its
 * own writes) whatever the number of tenants changing at once.
 */
let lifecycleChain: Promise<unknown> = Promise.resolve();

/**
 * Create a provisioner. One per process (or per request) is fine: lifecycle
 * operations run one at a time per process and, on PostgreSQL, hold a
 * per-tenant transaction-scoped advisory lock (cross-process), so a
 * tenant-wide revoke never misses an in-flight provision.
 */
export function createHostedInferenceProvisioner(
  options: HostedInferenceProvisionerOptions,
): HostedInferenceProvisioner {
  const now = options.now ?? (() => new Date());
  const nonce = options.nonce ?? defaultNonce;
  const deadlineMs = (): number => {
    try {
      return gatewayConfig().adminTimeoutMs ?? HOSTED_GATEWAY_ADMIN_TIMEOUT_MS;
    } catch {
      return HOSTED_GATEWAY_ADMIN_TIMEOUT_MS;
    }
  };
  let secretsPromise: Promise<HostedSecretStore> | undefined;
  let adminPromise: Promise<HostedGatewayAdmin> | undefined;
  let tablesPromise: Promise<void> | undefined;

  const gatewayConfig = (): HostedGatewayConfig =>
    options.gateway
      ? parseHostedGatewayConfig(options.gateway)
      : getHostedGatewayConfig();

  const getSecrets = (): Promise<HostedSecretStore> => {
    if (options.secrets) return Promise.resolve(options.secrets);
    secretsPromise ??= SecretService.create({ db: options.db }).catch(
      (error: unknown) => {
        secretsPromise = undefined;
        throw error;
      },
    );
    return secretsPromise;
  };

  const getAdmin = (gateway: HostedGatewayConfig) => {
    if (options.admin) return Promise.resolve(options.admin);
    adminPromise ??= createHostedGatewayAdmin(gateway).catch(
      (error: unknown) => {
        adminPromise = undefined;
        throw error;
      },
    );
    return adminPromise;
  };

  /** The admin surface, or `undefined` when none is usable (revoke path). */
  const optionalAdmin = async (): Promise<HostedGatewayAdmin | undefined> => {
    try {
      return await getAdmin(gatewayConfig());
    } catch (error) {
      if (
        error instanceof HostedInferenceError &&
        (error.code === 'HOSTED_GATEWAY_NOT_CONFIGURED' ||
          error.code === 'HOSTED_GATEWAY_UNSUPPORTED')
      ) {
        return undefined;
      }
      throw error;
    }
  };

  const ensureTables = () => {
    tablesPromise ??= ensureSystemTables(options.db)
      .then(() => undefined)
      .catch((error: unknown) => {
        tablesPromise = undefined;
        throw error;
      });
    return tablesPromise;
  };

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    withTenant(
      { tenantId, ...(options.actor ? { userId: options.actor } : {}) },
      fn,
    );

  /**
   * Run one lifecycle operation for a tenant: after every earlier operation
   * of this process (the chain), and on PostgreSQL under a per-tenant
   * transaction-scoped advisory lock held for the whole operation, so
   * operations of other processes on the same tenant wait (the operation's
   * own writes use other pooled connections: the pool needs at least three).
   * Single-connection adapters (SQLite) serve one process, which the chain
   * covers. Callers inside a locked operation use the `*Locked` helpers,
   * never these public methods (the chain is not re-entrant).
   */
  const withTenantLock = <T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const key = JSON.stringify(['smrt.inference.hosted', tenantId]);
    const run = async () => {
      if (isPostgresDatabase(options.db) && options.db.transaction) {
        return options.db.transaction(async (tx) => {
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            key,
          );
          return fn();
        });
      }
      return fn();
    };
    const result = lifecycleChain.then(run, run);
    lifecycleChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const read = async (
    secrets: HostedSecretStore,
    name: string,
  ): Promise<string | undefined> => {
    try {
      return (await secrets.retrieve(name)).value;
    } catch (error) {
      if (isAbsentSecretError(error, name)) return undefined;
      throw error;
    }
  };

  const readState = async (secrets: HostedSecretStore, userId: string) => {
    const value = await read(secrets, hostedInferenceStateSecretName(userId));
    return value === undefined ? undefined : parseState(value);
  };

  const readUserConfig = async (
    secrets: HostedSecretStore,
    userId: string,
  ): Promise<InferenceProviderConfig | undefined> => {
    const value = await read(
      secrets,
      inferenceProviderConfigSecretName({ userId }),
    );
    return value === undefined
      ? undefined
      : parseInferenceProviderConfig(value);
  };

  const writeState = (
    secrets: HostedSecretStore,
    userId: string,
    state: HostedInferenceState,
    auditDetails: Record<string, unknown>,
  ) =>
    secrets.store(
      hostedInferenceStateSecretName(userId),
      JSON.stringify(state),
      {
        category: HOSTED_INFERENCE_SECRET_CATEGORY,
        description: 'Hosted inference provisioning state',
        auditDetails,
      },
    );

  const writeUserConfig = (
    secrets: HostedSecretStore,
    userId: string,
    config: InferenceProviderConfig,
    auditDetails: Record<string, unknown>,
  ) =>
    secrets.store(
      inferenceProviderConfigSecretName({ userId }),
      JSON.stringify(parseInferenceProviderConfig(config)),
      {
        category: INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
        description: 'Inference provider config (user)',
        auditDetails,
      },
    );

  /** Whether the user's current config is this grant's hosted binding. */
  const isOurs = (
    config: InferenceProviderConfig | undefined,
    keyAlias: string,
  ) =>
    !!keyAlias &&
    config?.source === 'hosted' &&
    config.gatewayKeyAlias === keyAlias;

  /**
   * Try to delete a key on the gateway. Never throws: the outcome says
   * whether SMRT still owes the deletion (`missing`, the SDK's `false`, is
   * an already revoked key: nothing is owed).
   */
  const deleteGatewayKey = async (
    admin: HostedGatewayAdmin | undefined,
    keyId: string | null,
  ): Promise<'revoked' | 'missing' | 'unsupported' | 'failed'> => {
    if (!keyId || !admin) return 'unsupported';
    try {
      return (await withDeadline(
        () => admin.deleteVirtualKey(keyId),
        deadlineMs(),
        'deleteVirtualKey',
      ))
        ? 'revoked'
        : 'missing';
    } catch {
      return 'failed';
    }
  };

  /**
   * A project this provisioner created for the tenant earlier but never
   * recorded (a crash or failed write between create and persist): the
   * gateway's projects for the tenant carrying SMRT's name (and, on LiteLLM,
   * id prefix). The lowest id wins so every process adopts the same one.
   * A failed lookup throws: creating blind could make a second project.
   */
  const findTenantProject = async (
    tenantId: string,
    gateway: HostedGatewayConfig,
    admin: HostedGatewayAdmin,
  ): Promise<string | undefined> => {
    let projects: AIAdminProject[];
    try {
      projects = await withDeadline(
        () => admin.listProjects({ tenantId }),
        deadlineMs(),
        'listProjects',
      );
    } catch (error) {
      throw gatewayFailure('listProjects', error);
    }
    const ids = (Array.isArray(projects) ? projects : [])
      .filter(
        (project) =>
          project?.tenantId === tenantId &&
          project.name === hostedProjectName(tenantId) &&
          (gateway.provider !== 'litellm' ||
            project.id?.startsWith(`smrt-${tenantId}-`)),
      )
      .map((project) => text(project.id))
      .filter((id): id is string => !!id)
      .sort();
    return ids[0];
  };

  /**
   * The tenant's gateway project: the stored record, else one found on the
   * gateway ({@link findTenantProject}), else created once (runOnce).
   */
  const ensureProject = async (
    tenantId: string,
    gateway: HostedGatewayConfig,
    admin: HostedGatewayAdmin,
    secrets: HostedSecretStore,
  ): Promise<string> => {
    const stored = await read(secrets, PROJECT_NAME);
    if (stored !== undefined) {
      try {
        const parsed = JSON.parse(stored) as {
          projectId?: unknown;
          provider?: unknown;
        };
        if (
          typeof parsed.projectId === 'string' &&
          parsed.provider === gateway.provider
        ) {
          return parsed.projectId;
        }
      } catch {
        // Unreadable project record: create (or replay) below.
      }
    }
    const result = await runOnce(
      {
        db: options.db,
        tenantId,
        actor: RUN_ONCE_ACTOR_PROJECT,
        token: 'smrt-inference-hosted:project',
        content: { provider: gateway.provider, baseUrl: gateway.baseUrl },
      },
      async () => {
        const found = await findTenantProject(tenantId, gateway, admin);
        let projectId = found;
        if (!projectId) {
          let project: AIAdminProject;
          try {
            project = await withDeadline(
              () =>
                admin.createProject({
                  // LiteLLM requires an id, unique per attempt so a retry after
                  // a failed attempt never collides with the team it left.
                  id: `smrt-${tenantId}-${nonce()}`,
                  name: hostedProjectName(tenantId),
                  tenantId,
                  metadata: { smrt: HOSTED_INFERENCE_FEATURE_KEY, tenantId },
                }),
              deadlineMs(),
              'createProject',
            );
          } catch (error) {
            throw gatewayFailure('createProject', error);
          }
          projectId = text(project?.id);
        }
        if (!projectId) {
          throw new HostedInferenceError(
            'Gateway createProject returned no project id.',
            'HOSTED_GATEWAY_FAILED',
            { operation: 'createProject' },
          );
        }
        await secrets.store(
          PROJECT_NAME,
          JSON.stringify({
            projectId,
            provider: gateway.provider,
            createdAt: now().toISOString(),
          }),
          {
            category: HOSTED_INFERENCE_SECRET_CATEGORY,
            description: 'Hosted inference gateway project',
            auditDetails: {
              operation: 'inference.hosted.project',
              projectId,
              provider: gateway.provider,
              ...(found ? { adopted: true } : {}),
            },
          },
        );
        return { projectId };
      },
    );
    return result.projectId;
  };

  /**
   * Retry owed gateway deletions. Returns the state to store (the same
   * object when nothing settled) and the entries that settled, with the
   * gateway's answer (`revoked`, or `missing`: already gone).
   */
  const retryPending = async (
    state: HostedInferenceState,
  ): Promise<{
    state: HostedInferenceState;
    settled: Array<{
      keyId: string;
      keyAlias: string;
      gateway: 'revoked' | 'missing';
    }>;
  }> => {
    const pending = state.pendingGatewayRevocations ?? [];
    // Entries without a key id cannot be deleted by SMRT: skip the client.
    if (!pending.some((entry) => entry.keyId)) return { state, settled: [] };
    const admin = await optionalAdmin();
    const remaining: HostedPendingGatewayRevocation[] = [];
    const settled: Array<{
      keyId: string;
      keyAlias: string;
      gateway: 'revoked' | 'missing';
    }> = [];
    for (const entry of pending) {
      const outcome = await deleteGatewayKey(admin, entry.keyId);
      if (outcome === 'revoked' || outcome === 'missing') {
        settled.push({
          keyId: entry.keyId as string,
          keyAlias: entry.keyAlias,
          gateway: outcome,
        });
      } else {
        remaining.push(entry);
      }
    }
    if (settled.length === 0) return { state, settled };
    return {
      state: { ...state, pendingGatewayRevocations: remaining },
      settled,
    };
  };

  /**
   * Revoke an active grant (caller holds the lifecycle lock). Local access
   * ends whatever the gateway answers: the config is restored and the state
   * retired first-class; a deletion the gateway could not perform is kept in
   * `pendingGatewayRevocations` and audited.
   */
  const revokeLocked = async (
    tenantId: string,
    userId: string,
    secrets: HostedSecretStore,
    state: HostedInferenceState,
    reason: string,
    restore: boolean,
    optOut = false,
  ): Promise<RevokeHostedInferenceResult> => {
    const since = now().toISOString();
    const audit = {
      operation: 'inference.hosted.revoke',
      reason,
      keyAlias: state.keyAlias,
      ...(state.keyId ? { keyId: state.keyId } : {}),
    };
    // 1. End local use first, whatever the gateway does next.
    let restored: RevokeHostedInferenceResult['restored'] = 'kept';
    if (restore) {
      const current = await readUserConfig(secrets, userId);
      if (isOurs(current, state.keyAlias)) {
        const next = restoredConfig(state.prior);
        restored = next.restored;
        await writeUserConfig(secrets, userId, next.config, {
          ...audit,
          restored,
        });
      }
    }
    const owedEntry: HostedPendingGatewayRevocation = {
      keyId: state.keyId,
      keyAlias: state.keyAlias,
      reason: 'failed',
      since,
    };
    const retired: HostedInferenceState = {
      ...state,
      status: 'revoked',
      generation: state.generation + 1,
      revokedAt: since,
      prior: null,
      ...(optOut ? { optedOut: true } : {}),
      // Owed until the gateway confirms the deletion below.
      pendingGatewayRevocations: [
        ...(state.pendingGatewayRevocations ?? []),
        owedEntry,
      ],
    };
    await writeState(secrets, userId, retired, {
      ...audit,
      restored,
      gateway: 'pending',
    });
    // 2. Then the gateway (bounded by the admin deadline).
    const gateway = await deleteGatewayKey(await optionalAdmin(), state.keyId);
    const owed = gateway === 'unsupported' || gateway === 'failed';
    const next: HostedInferenceState = {
      ...retired,
      pendingGatewayRevocations: [
        ...(state.pendingGatewayRevocations ?? []),
        ...(owed ? [{ ...owedEntry, reason: gateway }] : []),
      ],
    };
    await writeState(secrets, userId, next, {
      ...audit,
      restored,
      gateway,
      ...(owed ? { manualGatewayRevocation: true } : {}),
    });
    return {
      ...describeState(tenantId, userId, next),
      revoked: true,
      gateway,
      restored,
    };
  };

  const provisionLocked = async (
    tenantId: string,
    userId: string,
    budget: Required<HostedInferenceBudget>,
    gateway: HostedGatewayConfig,
    secrets: HostedSecretStore,
  ): Promise<ProvisionHostedInferenceResult> => {
    let state = await readState(secrets, userId);
    if (state?.status === 'active') {
      const current = await readUserConfig(secrets, userId);
      if (isOurs(current, state.keyAlias)) {
        const sync = sameBudget(state.budget, budget)
          ? undefined
          : await syncLocked(tenantId, userId, budget, secrets);
        const fresh = (await readState(secrets, userId)) ?? state;
        return {
          ...describeState(tenantId, userId, fresh),
          created: false,
          ...(sync && sync.sync !== 'none' ? { budgetSync: sync.sync } : {}),
        };
      }
      // The user replaced the hosted binding since: retire that key
      // (keeping their new config) and provision afresh.
      await revokeLocked(
        tenantId,
        userId,
        secrets,
        state,
        'user-replaced',
        false,
        true,
      );
      state = await readState(secrets, userId);
    }
    if (options.entitled && !(await options.entitled(tenantId))) {
      throw new HostedInferenceError(
        `Tenant ${tenantId} is not entitled to ${HOSTED_INFERENCE_FEATURE_KEY}; nothing was provisioned.`,
        'HOSTED_NOT_ENTITLED',
        { tenantId, userId },
      );
    }
    const generation = state?.generation ?? 0;
    const admin = await getAdmin(gateway);
    const projectId = await ensureProject(tenantId, gateway, admin, secrets);
    let rollback: (() => Promise<unknown>) | undefined;
    const provisioned = await runOnce(
      {
        db: options.db,
        tenantId,
        actor: userId,
        token: 'smrt-inference-hosted:provision',
        content: { userId, generation },
      },
      async () => {
        const current = await readUserConfig(secrets, userId);
        // Keep the user's own config to restore on revoke; a leftover
        // hosted binding is never a prior.
        const prior = current && current.source !== 'hosted' ? current : null;
        // Unique per attempt: a failed attempt's key (whose delete may be
        // still owed) never blocks the retry's alias.
        const keyAlias = `smrt-${tenantId}-${userId}-g${generation}-${nonce()}`;
        const models = keyModels(gateway);
        const request: CreateAIVirtualKeyOptions = {
          name: keyAlias,
          description: `smrt hosted inference for user ${userId}`,
          projectId,
          tenantId,
          userId,
          budget: toGatewayBudget(budget),
          ...(models ? { models } : {}),
          ...(gateway.keyDuration ? { duration: gateway.keyDuration } : {}),
          ...(gateway.provider === 'bifrost' ? { keyIds: ['*'] } : {}),
          metadata: {
            smrt: HOSTED_INFERENCE_FEATURE_KEY,
            tenantId,
            userId,
            generation,
          },
        };
        let key: AIVirtualKey | undefined;
        let createError: unknown;
        try {
          key = await withDeadline(
            () => admin.createVirtualKey(request),
            deadlineMs(),
            'createVirtualKey',
          );
        } catch (error) {
          createError = error;
        }
        const apiKey = text(key?.key);
        // The persisted handle must never be the key itself (an SDK before
        // 0.111.7 could echo LiteLLM's key as its id).
        const returnedId = text(key?.id);
        const keyId = returnedId && returnedId !== apiKey ? returnedId : null;
        /**
         * After the claim rolled back (a delete inside its transaction would
         * wait on it on single-connection adapters): delete the new key or
         * record it as owed, and put the previous state back so the user's
         * prior config survives for the retry.
         */
        const scheduleRollback = () => {
          const previous = state;
          rollback = async () => {
            const outcome = await deleteGatewayKey(admin, keyId);
            const owed = outcome === 'unsupported' || outcome === 'failed';
            const audit = {
              operation: 'inference.hosted.provision-rollback',
              keyAlias,
              gateway: outcome,
              ...(keyId ? { keyId } : {}),
              ...(owed ? { manualGatewayRevocation: true } : {}),
            };
            const pending = [
              ...(previous?.pendingGatewayRevocations ?? []),
              ...(owed
                ? [
                    {
                      keyId,
                      keyAlias,
                      reason: 'orphaned',
                      since: now().toISOString(),
                    } satisfies HostedPendingGatewayRevocation,
                  ]
                : []),
            ];
            if (previous) {
              await writeState(
                secrets,
                userId,
                { ...previous, pendingGatewayRevocations: pending },
                audit,
              );
            } else if (owed) {
              await writeState(
                secrets,
                userId,
                {
                  version: 1,
                  status: 'revoked',
                  generation,
                  keyId: null,
                  keyAlias: '',
                  prior: null,
                  pendingGatewayRevocations: pending,
                },
                audit,
              );
            } else {
              await secrets.delete(hostedInferenceStateSecretName(userId), {
                auditDetails: audit,
              });
            }
          };
        };
        if (createError !== undefined) {
          // An ambiguous failure may still mint the key on the gateway:
          // record its alias as owed. An explicit refusal created nothing.
          if (mayHaveCreated(createError)) scheduleRollback();
          throw gatewayFailure('createVirtualKey', createError);
        }
        if (!apiKey) {
          scheduleRollback();
          throw new HostedInferenceError(
            'Gateway createVirtualKey returned no key value.',
            'HOSTED_GATEWAY_FAILED',
            { operation: 'createVirtualKey' },
          );
        }
        const next: HostedInferenceState = {
          version: 1,
          status: 'active',
          generation,
          provider: gateway.provider,
          projectId,
          keyId,
          keyAlias,
          budget,
          provisionedAt: now().toISOString(),
          prior,
          ...(state?.pendingGatewayRevocations?.length
            ? { pendingGatewayRevocations: state.pendingGatewayRevocations }
            : {}),
        };
        const audit = {
          operation: 'inference.hosted.provision',
          keyAlias,
          projectId,
          provider: gateway.provider,
          ...(keyId ? { keyId } : {}),
        };
        try {
          await writeState(secrets, userId, next, audit);
          await writeUserConfig(
            secrets,
            userId,
            hostedProviderConfig(gateway, apiKey, keyAlias),
            audit,
          );
        } catch (error) {
          scheduleRollback();
          throw error;
        }
        const created: ProvisionHostedInferenceResult = {
          ...describeState(tenantId, userId, next),
          created: true,
        };
        return created;
      },
    ).catch(async (error: unknown) => {
      if (rollback) await rollback().catch(() => undefined);
      throw error;
    });
    // A replayed claim must describe what is stored. It does not when the
    // state was removed out of band (claims outlive it for the retention
    // window): refuse rather than report a grant that does not exist.
    const stored = await readUserConfig(secrets, userId);
    if (!isOurs(stored, provisioned.keyAlias ?? '')) {
      throw new HostedInferenceError(
        'Hosted inference state for this user was removed outside provisioning; revoke the gateway key named in the audit log and provision again after the run-once claim expires.',
        'HOSTED_STATE_INVALID',
        { tenantId, userId, keyAlias: provisioned.keyAlias },
      );
    }
    return provisioned;
  };

  /**
   * Sync one grant's gateway budget (lock held). Unchanged budgets are not
   * re-sent (a gateway update may restart the spend window), except while
   * an earlier update's outcome is uncertain (`budgetSyncUncertainAt`: it
   * failed or timed out and may still land): then the stored budget is
   * re-applied, until a confirmed update at least
   * {@link HOSTED_BUDGET_UNCERTAIN_WINDOW_MS} after the uncertain one.
   */
  const syncLocked = async (
    tenantId: string,
    userId: string,
    budget: Required<HostedInferenceBudget>,
    secrets: HostedSecretStore,
  ): Promise<SyncHostedBudgetResult> => {
    const state = await readState(secrets, userId);
    if (state?.status !== 'active') {
      return { ...describeState(tenantId, userId, state), sync: 'none' };
    }
    const uncertainAt = state.budgetSyncUncertainAt;
    if (!uncertainAt && sameBudget(state.budget, budget)) {
      return { ...describeState(tenantId, userId, state), sync: 'unchanged' };
    }
    if (!state.keyId) {
      // No handle to update: the recorded state keeps the old budget.
      return { ...describeState(tenantId, userId, state), sync: 'unsupported' };
    }
    const admin = await getAdmin(gatewayConfig());
    try {
      const keyId = state.keyId;
      // Budget only: models and metadata are not updatable on every
      // gateway (ADMIN_UNSUPPORTED_FIELD), and a plan change is a budget.
      await withDeadline(
        () =>
          admin.updateVirtualKey(keyId, { budget: toGatewayBudget(budget) }),
        deadlineMs(),
        'updateVirtualKey',
      );
    } catch (error) {
      // The update may still land later: re-apply on the next sync.
      await writeState(
        secrets,
        userId,
        { ...state, budgetSyncUncertainAt: now().toISOString() },
        {
          operation: 'inference.hosted.budget-uncertain',
          keyAlias: state.keyAlias,
          keyId: state.keyId,
        },
      );
      throw gatewayFailure('updateVirtualKey', error);
    }
    const settled =
      !uncertainAt ||
      now().getTime() - Date.parse(uncertainAt) >=
        HOSTED_BUDGET_UNCERTAIN_WINDOW_MS;
    const { budgetSyncUncertainAt: _settled, ...rest } = state;
    const next: HostedInferenceState = {
      ...(settled ? rest : state),
      budget,
    };
    if (sameBudget(state.budget, budget) && !(settled && uncertainAt)) {
      return { ...describeState(tenantId, userId, next), sync: 'updated' };
    }
    await writeState(secrets, userId, next, {
      operation: 'inference.hosted.budget',
      keyAlias: state.keyAlias,
      keyId: state.keyId,
      limitMicros: budget.limitMicros,
      window: budget.window,
    });
    return { ...describeState(tenantId, userId, next), sync: 'updated' };
  };

  const listStates = async (tenantId: string) => {
    const secrets = await getSecrets();
    return inTenant(tenantId, async () => {
      const rows = await secrets.list({
        category: HOSTED_INFERENCE_SECRET_CATEGORY,
      });
      const states: Array<{ userId: string; state: HostedInferenceState }> = [];
      for (const row of rows) {
        if (!row.name.startsWith(STATE_PREFIX)) continue;
        const userId = row.name.slice(STATE_PREFIX.length);
        const state = await readState(secrets, userId);
        if (state) states.push({ userId, state });
      }
      return states.sort((a, b) => a.userId.localeCompare(b.userId));
    });
  };

  /** Retry a user's owed gateway deletions and persist what changed. */
  const retryPendingLocked = async (
    userId: string,
    secrets: HostedSecretStore,
  ): Promise<HostedInferenceState | undefined> => {
    const state = await readState(secrets, userId);
    if (!state?.pendingGatewayRevocations?.length) return state;
    const { state: retried, settled } = await retryPending(state);
    if (settled.length === 0) return state;
    // Each settled entry closes an earlier `manualGatewayRevocation` audit
    // record for the same alias and key id.
    await writeState(secrets, userId, retried, {
      operation: 'inference.hosted.revoke-retry',
      settled,
      remaining: retried.pendingGatewayRevocations?.length ?? 0,
    });
    return retried;
  };

  /** Revoke one user (lock held): active grant, else owed deletions only. */
  const revokeUserLocked = async (
    tenantId: string,
    userId: string,
    secrets: HostedSecretStore,
    reason: string,
  ): Promise<RevokeHostedInferenceResult> => {
    const state = await readState(secrets, userId);
    if (state?.status !== 'active') {
      const retried = await retryPendingLocked(userId, secrets);
      return {
        ...describeState(tenantId, userId, retried),
        revoked: false,
        gateway: 'none',
      };
    }
    return revokeLocked(tenantId, userId, secrets, state, reason, true);
  };

  /**
   * Converge one entitled user (lock held). A user who replaced the hosted
   * binding with their own config keeps it: the stale key is retired and
   * the user marked opted out, so later reconciles leave them alone.
   */
  const reconcileUserLocked = async (
    tenantId: string,
    userId: string,
    budget: Required<HostedInferenceBudget>,
    gateway: HostedGatewayConfig,
    secrets: HostedSecretStore,
    result: HostedReconcileResult,
  ): Promise<void> => {
    const state = await readState(secrets, userId);
    if (state?.status === 'revoked' && state.optedOut) return;
    if (state?.status === 'active') {
      const current = await readUserConfig(secrets, userId);
      if (!isOurs(current, state.keyAlias)) {
        result.revoked.push(
          await revokeLocked(
            tenantId,
            userId,
            secrets,
            state,
            'user-replaced',
            false,
            true,
          ),
        );
        return;
      }
      result.synced.push(await syncLocked(tenantId, userId, budget, secrets));
      return;
    }
    result.provisioned.push(
      await provisionLocked(tenantId, userId, budget, gateway, secrets),
    );
  };

  /** Common entry: prepare, lock the tenant, set its context. */
  const locked = async <T>(
    tenantId: string,
    fn: (secrets: HostedSecretStore) => Promise<T>,
    invalidate?: { userId?: string },
  ): Promise<T> => {
    await ensureTables();
    const secrets = await getSecrets();
    try {
      return await withTenantLock(tenantId, () =>
        inTenant(tenantId, () => fn(secrets)),
      );
    } finally {
      if (invalidate) {
        invalidateUserInferenceResolvers({
          tenantId,
          ...(invalidate.userId ? { userId: invalidate.userId } : {}),
        });
      }
    }
  };

  const provisioner: HostedInferenceProvisioner = {
    async provision(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      const budget = normalizeHostedBudget(input.budget);
      const gateway = gatewayConfig();
      return locked(
        tenantId,
        (secrets) =>
          provisionLocked(tenantId, userId, budget, gateway, secrets),
        { userId },
      );
    },

    async revoke(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      return locked(
        tenantId,
        (secrets) =>
          revokeUserLocked(
            tenantId,
            userId,
            secrets,
            text(input.reason) ?? 'revoke',
          ),
        { userId },
      );
    },

    async syncBudget(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      const budget = normalizeHostedBudget(input.budget);
      return locked(tenantId, (secrets) =>
        syncLocked(tenantId, userId, budget, secrets),
      );
    },

    async status(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      const secrets = await getSecrets();
      return inTenant(tenantId, async () =>
        describeState(tenantId, userId, await readState(secrets, userId)),
      );
    },

    async listActive(tenantIdInput) {
      const tenantId = requireId(tenantIdInput, 'tenantId');
      return (await listStates(tenantId))
        .filter(({ state }) => state.status === 'active')
        .map(({ userId }) => userId);
    },

    async listKnown(tenantIdInput) {
      const tenantId = requireId(tenantIdInput, 'tenantId');
      return (await listStates(tenantId)).map(({ userId }) => userId);
    },

    async revokeTenant(tenantIdInput, revokeOptions = {}) {
      const tenantId = requireId(tenantIdInput, 'tenantId');
      return locked(
        tenantId,
        async (secrets) => {
          const results: RevokeHostedInferenceResult[] = [];
          for (const { userId, state } of await listStates(tenantId)) {
            if (state.status !== 'active') continue;
            results.push(
              await revokeUserLocked(
                tenantId,
                userId,
                secrets,
                text(revokeOptions.reason) ?? 'revoke',
              ),
            );
          }
          return results;
        },
        {},
      );
    },

    async syncTenantBudget(tenantIdInput, budgetInput) {
      const tenantId = requireId(tenantIdInput, 'tenantId');
      const budget = normalizeHostedBudget(budgetInput);
      return locked(tenantId, async (secrets) => {
        const results: SyncHostedBudgetResult[] = [];
        for (const { userId, state } of await listStates(tenantId)) {
          if (state.status !== 'active') continue;
          results.push(await syncLocked(tenantId, userId, budget, secrets));
        }
        return results;
      });
    },

    async acknowledgeGatewayRevocation(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      const keyAlias = text(input.keyAlias);
      if (!keyAlias) {
        throw new HostedInferenceError(
          'keyAlias is required',
          'HOSTED_INFERENCE_INVALID',
          { field: 'keyAlias' },
        );
      }
      return locked(tenantId, async (secrets) => {
        const state = await readState(secrets, userId);
        const pending = state?.pendingGatewayRevocations ?? [];
        const remaining = pending.filter(
          (entry) => entry.keyAlias !== keyAlias,
        );
        if (!state || remaining.length === pending.length) return false;
        await writeState(
          secrets,
          userId,
          { ...state, pendingGatewayRevocations: remaining },
          {
            operation: 'inference.hosted.revoke-acknowledged',
            keyAlias,
          },
        );
        return true;
      });
    },

    async reconcileTenant(tenantIdInput, target) {
      const tenantId = requireId(tenantIdInput, 'tenantId');
      const budget = target.budget
        ? normalizeHostedBudget(target.budget)
        : undefined;
      const users = (target.users ?? []).map((userId) =>
        requireId(userId, 'userId'),
      );
      if (target.entitled && users.length > 0 && !budget) {
        throw new HostedInferenceError(
          'reconcileTenant needs a budget to provision users.',
          'HOSTED_INFERENCE_INVALID',
          { tenantId },
        );
      }
      const gateway =
        target.entitled && users.length > 0 ? gatewayConfig() : undefined;
      return locked(
        tenantId,
        async (secrets) => {
          const result: HostedReconcileResult = {
            tenantId,
            provisioned: [],
            revoked: [],
            synced: [],
            pending: [],
            failures: [],
          };
          const attempt = async (userId: string, fn: () => Promise<void>) => {
            try {
              await fn();
            } catch (error) {
              result.failures.push({ userId, error });
            }
          };
          // Enumerated under the tenant lock: no provision is in flight.
          const states = await listStates(tenantId);
          // A stale "entitled" target (an old snapshot processed after a
          // downgrade) loses to the host's current answer, read under the
          // lock.
          const entitled =
            target.entitled &&
            (!options.entitled || (await options.entitled(tenantId)));
          if (!entitled) {
            for (const { userId, state } of states) {
              if (state.status !== 'active') continue;
              await attempt(userId, async () => {
                result.revoked.push(
                  await revokeLocked(
                    tenantId,
                    userId,
                    secrets,
                    state,
                    'entitlement-lost',
                    true,
                  ),
                );
              });
            }
          } else {
            const wanted = new Set(users);
            for (const userId of wanted) {
              await attempt(userId, () =>
                reconcileUserLocked(
                  tenantId,
                  userId,
                  budget as Required<HostedInferenceBudget>,
                  gateway as HostedGatewayConfig,
                  secrets,
                  result,
                ),
              );
            }
            if (budget) {
              for (const { userId, state } of states) {
                if (wanted.has(userId) || state.status !== 'active') continue;
                await attempt(userId, async () => {
                  result.synced.push(
                    await syncLocked(tenantId, userId, budget, secrets),
                  );
                });
              }
            }
          }
          // Owed gateway deletions for every user with state (an active
          // grant's pending entries are old keys, never the current one).
          for (const { userId } of await listStates(tenantId)) {
            await attempt(userId, async () => {
              const state = await retryPendingLocked(userId, secrets);
              const remaining = state?.pendingGatewayRevocations?.length ?? 0;
              if (remaining > 0) result.pending.push({ userId, remaining });
            });
          }
          return result;
        },
        {},
      );
    },
  };
  return provisioner;
}

/**
 * Provision hosted inference for one user (#4759): create the tenant's
 * gateway project on first use, mint a per-user virtual key with `budget`,
 * store it as the user's `inference.provider-config` (`source: 'hosted'`,
 * `mode: 'hosted'`), keeping the prior config for revoke. Idempotent per
 * `(tenantId, userId)`: an active grant is returned (its budget synced when
 * it differs) and concurrent calls create one key.
 */
export function provisionHostedInference(
  options: HostedInferenceProvisionerOptions & {
    tenantId: string;
    userId: string;
    budget: HostedInferenceBudget;
  },
): Promise<ProvisionHostedInferenceResult> {
  const { tenantId, userId, budget, ...deps } = options;
  return createHostedInferenceProvisioner(deps).provision({
    tenantId,
    userId,
    budget,
  });
}

/**
 * Revoke a user's hosted inference (downgrade, deletion): stop using the key
 * (restore the user's prior provider config, or mode `off`), retire the
 * state, and delete the gateway key (a failed delete is kept as an owed
 * deletion, audited, and retried by revoke or reconcile). Idempotent.
 */
export function revokeHostedInference(
  options: HostedInferenceProvisionerOptions & {
    tenantId: string;
    userId: string;
    reason?: string;
  },
): Promise<RevokeHostedInferenceResult> {
  const { tenantId, userId, reason, ...deps } = options;
  return createHostedInferenceProvisioner(deps).revoke({
    tenantId,
    userId,
    ...(reason ? { reason } : {}),
  });
}

/** Read a hosted budget from an `inference.hosted` grant's `metadata.budget`. */
export function hostedBudgetFromGrantMetadata(
  metadata: Record<string, unknown> | undefined,
): HostedInferenceBudget | undefined {
  const budget = metadata?.budget;
  if (!budget || typeof budget !== 'object') return undefined;
  const { limitMicros, window } = budget as Record<string, unknown>;
  if (typeof limitMicros !== 'number') return undefined;
  return {
    limitMicros,
    ...(typeof window === 'string'
      ? { window: window as HostedBudgetWindow }
      : {}),
  };
}

/** Structural mirror of smrt-subscriptions' `EntitlementSnapshot` (grants). */
export interface HostedEntitlementSnapshot {
  grants: ReadonlyArray<{
    featureKey: string;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  }>;
}

/** Structural mirror of smrt-subscriptions' `EntitlementChange`. */
export interface HostedEntitlementChange {
  tenantId: string;
  gained: readonly string[];
  lost: readonly string[];
  changed: readonly string[];
  after: HostedEntitlementSnapshot;
}

/** Options for the entitlement listener and reconciler. */
export interface HostedInferenceEntitlementListenerOptions {
  provisioner: HostedInferenceProvisioner;
  /**
   * Users who should hold a grant while the tenant is entitled (the
   * tenant's members; membership is the host's). Users joining later are
   * provisioned by the host calling `provision()` directly.
   */
  users(tenantId: string): Promise<readonly string[]>;
  /**
   * The budget for the tenant's plan. Default: the `inference.hosted`
   * grant's `metadata.budget` ({@link hostedBudgetFromGrantMetadata}), else
   * `defaultBudget`.
   */
  budgetFor?(
    tenantId: string,
    snapshot: HostedEntitlementSnapshot,
  ): HostedInferenceBudget | undefined;
  defaultBudget?: HostedInferenceBudget;
}

function hostedGrant(snapshot: HostedEntitlementSnapshot) {
  return snapshot.grants.find(
    (grant) =>
      grant.featureKey === HOSTED_INFERENCE_FEATURE_KEY &&
      grant.enabled !== false,
  );
}

function throwReconcileFailures(result: HostedReconcileResult): void {
  if (result.failures.length === 0) return;
  throw new HostedInferenceError(
    `Hosted inference failed for ${result.failures.length} user(s) of tenant ${result.tenantId}.`,
    'HOSTED_GATEWAY_FAILED',
    {
      tenantId: result.tenantId,
      users: result.failures.map((failure) => failure.userId),
      codes: result.failures.map((failure) =>
        failure.error instanceof SmrtError
          ? failure.error.code
          : failure.error instanceof Error
            ? failure.error.name
            : 'unknown',
      ),
    },
  );
}

/**
 * Reconcile a tenant's hosted grants with its current entitlement snapshot
 * (smrt-subscriptions' `snapshotEntitlements()`): entitled provisions
 * `users()` and syncs budgets, not entitled revokes every grant, both retry
 * owed gateway deletions. Idempotent: run it on webhook redelivery (a
 * replayed write diffs to "no change") and on a schedule, so a reaction
 * lost to a crash or a failed listener is repaired. Throws one error naming
 * the users that failed, after trying all of them.
 */
export function createHostedInferenceReconciler(
  options: HostedInferenceEntitlementListenerOptions,
): (
  tenantId: string,
  snapshot: HostedEntitlementSnapshot,
) => Promise<HostedReconcileResult> {
  return async (tenantId, snapshot) => {
    const grant = hostedGrant(snapshot);
    if (!grant) {
      const result = await options.provisioner.reconcileTenant(tenantId, {
        entitled: false,
      });
      throwReconcileFailures(result);
      return result;
    }
    const budget =
      options.budgetFor?.(tenantId, snapshot) ??
      hostedBudgetFromGrantMetadata(grant.metadata) ??
      options.defaultBudget;
    if (!budget) {
      throw new HostedInferenceError(
        `The ${HOSTED_INFERENCE_FEATURE_KEY} grant names no budget (metadata.budget.limitMicros) and no defaultBudget is set.`,
        'HOSTED_INFERENCE_INVALID',
        { tenantId },
      );
    }
    const result = await options.provisioner.reconcileTenant(tenantId, {
      entitled: true,
      budget,
      users: await options.users(tenantId),
    });
    throwReconcileFailures(result);
    return result;
  };
}

/**
 * The smrt-subscriptions entitlement-change listener for hosted inference:
 * register it with `registerEntitlementChangeListener()`. A change that
 * gains, loses or changes `inference.hosted` reconciles the tenant to the
 * change's `after` snapshot ({@link createHostedInferenceReconciler}).
 */
export function createHostedInferenceEntitlementListener(
  options: HostedInferenceEntitlementListenerOptions,
): (change: HostedEntitlementChange) => Promise<void> {
  const reconcile = createHostedInferenceReconciler(options);
  return async (change) => {
    const touches = [change.gained, change.lost, change.changed].some((keys) =>
      keys.includes(HOSTED_INFERENCE_FEATURE_KEY),
    );
    if (!touches) return;
    await reconcile(change.tenantId, change.after);
  };
}
