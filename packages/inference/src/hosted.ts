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
 * advances on every revoke, so a later re-provision runs again.
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
  runOnce,
} from '@happyvertical/smrt-core';
import { SmrtError } from '@happyvertical/smrt-core/smrt-error';
import { SecretService } from '@happyvertical/smrt-secrets';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
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
  | 'HOSTED_STATE_INVALID';

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
}

/**
 * The admin calls provisioning uses. `createProject` and `createVirtualKey`
 * are `AIAdminInterface`; `updateVirtualKey` and `deleteVirtualKey` are
 * feature-detected because `@happyvertical/ai` does not ship them yet
 * (happyvertical/sdk#1494): without them budget sync and gateway revocation
 * report `unsupported`.
 */
export interface HostedGatewayAdmin
  extends Pick<AIAdminInterface, 'createProject' | 'createVirtualKey'> {
  updateVirtualKey?(
    id: string,
    options: {
      budget?: AIAdminBudget;
      models?: string[];
      isActive?: boolean;
    },
  ): Promise<AIVirtualKey>;
  deleteVirtualKey?(id: string): Promise<boolean>;
}

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
 * the installed SDK's provider exposes no admin surface.
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
  const admin = ai.admin as HostedGatewayAdmin | undefined;
  if (
    !admin ||
    typeof admin.createProject !== 'function' ||
    typeof admin.createVirtualKey !== 'function'
  ) {
    throw new HostedInferenceError(
      `The ${config.provider} provider of @happyvertical/ai exposes no admin surface.`,
      'HOSTED_GATEWAY_UNSUPPORTED',
      { provider: config.provider },
    );
  }
  return admin;
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

/** A user's provisioning state (`inference.hosted:user:<userId>`). */
export interface HostedInferenceState {
  version: 1;
  status: 'active' | 'revoked';
  /** Lifecycle generation; advances on every revoke. */
  generation: number;
  provider: HostedGatewayProvider;
  projectId: string;
  /** The gateway's non-secret key id (update/delete handle), when returned. */
  keyId: string | null;
  keyAlias: string;
  budget: Required<HostedInferenceBudget>;
  provisionedAt: string;
  revokedAt?: string;
  /** The user's provider config before provisioning; dropped on revoke. */
  prior: InferenceProviderConfig | null;
}

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
  | 'none';

/** Result of {@link HostedInferenceProvisioner.revoke}. */
export interface RevokeHostedInferenceResult extends HostedInferenceDescriptor {
  revoked: boolean;
  /**
   * `revoked`: the gateway deleted the key; `missing`: it no longer existed;
   * `unsupported`: the SDK has no delete call (happyvertical/sdk#1494) or the
   * gateway returned no key id, so the key must be revoked on the gateway by
   * hand (the audit entry names its id and alias); `none`: nothing to revoke.
   */
  gateway: HostedGatewayRevokeStatus;
  /** What the user's provider config became. */
  restored?: 'prior' | 'off' | 'kept';
}

/** Budget sync outcome. */
export type HostedBudgetSyncStatus = 'updated' | 'unchanged' | 'unsupported';

/** Result of {@link HostedInferenceProvisioner.syncBudget}. */
export interface SyncHostedBudgetResult extends HostedInferenceDescriptor {
  sync: HostedBudgetSyncStatus | 'none';
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
  /** Database for `runOnce()` claims and, without `secrets`, the secrets. */
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
}

/** Hosted provisioning bound to one database, store and gateway. */
export interface HostedInferenceProvisioner {
  provision(options: {
    tenantId: string;
    userId: string;
    budget: HostedInferenceBudget;
  }): Promise<ProvisionHostedInferenceResult>;
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
  revokeTenant(
    tenantId: string,
    options?: { reason?: string },
  ): Promise<RevokeHostedInferenceResult[]>;
  syncTenantBudget(
    tenantId: string,
    budget: HostedInferenceBudget,
  ): Promise<SyncHostedBudgetResult[]>;
}

const STATE_PREFIX = `${HOSTED_INFERENCE_SECRET_CATEGORY}:user:`;
const PROJECT_NAME = `${HOSTED_INFERENCE_SECRET_CATEGORY}:project`;
const RUN_ONCE_ACTOR_PROJECT = 'smrt-inference-hosted';

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
  a: Required<HostedInferenceBudget>,
  b: Required<HostedInferenceBudget>,
): boolean {
  return a.limitMicros === b.limitMicros && a.window === b.window;
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
    typeof state.projectId !== 'string'
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
    provider: state.provider,
    projectId: state.projectId,
    keyId: state.keyId,
    keyAlias: state.keyAlias,
    budget: state.budget,
  };
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

/**
 * Create a provisioner. One per process (or per request) is fine: it holds
 * no per-user state; the admin client and secret store are built lazily.
 */
export function createHostedInferenceProvisioner(
  options: HostedInferenceProvisionerOptions,
): HostedInferenceProvisioner {
  const now = options.now ?? (() => new Date());
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
    state: HostedInferenceState,
  ) => config?.source === 'hosted' && config.gatewayKeyAlias === state.keyAlias;

  /** The tenant's gateway project, created once (runOnce) on first use. */
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
        let project: AIAdminProject;
        try {
          project = await admin.createProject({
            // LiteLLM requires a stable id; Bifrost generates its own.
            id: `smrt-${tenantId}`,
            name: `smrt tenant ${tenantId}`,
            tenantId,
            metadata: { smrt: HOSTED_INFERENCE_FEATURE_KEY, tenantId },
          });
        } catch (error) {
          throw gatewayFailure('createProject', error);
        }
        const projectId = text(project?.id);
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
            },
          },
        );
        return { projectId };
      },
    );
    return result.projectId;
  };

  /** Revoke inside a tenant context; shared by revoke and re-provision. */
  const revokeLocked = async (
    tenantId: string,
    userId: string,
    secrets: HostedSecretStore,
    state: HostedInferenceState,
    reason: string,
    restore: boolean,
  ): Promise<RevokeHostedInferenceResult> => {
    return runOnce(
      {
        db: options.db,
        tenantId,
        actor: userId,
        token: 'smrt-inference-hosted:revoke',
        content: { userId, generation: state.generation },
      },
      async () => {
        let gateway: HostedGatewayRevokeStatus = 'unsupported';
        let admin: HostedGatewayAdmin | undefined;
        try {
          admin = await getAdmin(gatewayConfig());
        } catch (error) {
          // No usable admin surface (gateway env gone, SDK without admin):
          // revocation still removes the key locally and says so.
          if (
            !(error instanceof HostedInferenceError) ||
            (error.code !== 'HOSTED_GATEWAY_NOT_CONFIGURED' &&
              error.code !== 'HOSTED_GATEWAY_UNSUPPORTED')
          ) {
            throw error;
          }
        }
        if (state.keyId && typeof admin?.deleteVirtualKey === 'function') {
          try {
            gateway = (await admin.deleteVirtualKey(state.keyId))
              ? 'revoked'
              : 'missing';
          } catch (error) {
            // Transient: change nothing locally so a retry finishes the job.
            throw gatewayFailure('deleteVirtualKey', error);
          }
        }
        const audit = {
          operation: 'inference.hosted.revoke',
          reason,
          gateway,
          keyAlias: state.keyAlias,
          ...(state.keyId ? { keyId: state.keyId } : {}),
          ...(gateway === 'unsupported'
            ? { manualGatewayRevocation: true }
            : {}),
        };
        let restored: RevokeHostedInferenceResult['restored'] = 'kept';
        if (restore) {
          const current = await readUserConfig(secrets, userId);
          if (isOurs(current, state)) {
            const next = restoredConfig(state.prior);
            restored = next.restored;
            await writeUserConfig(secrets, userId, next.config, {
              ...audit,
              restored,
            });
          }
        }
        const next: HostedInferenceState = {
          ...state,
          status: 'revoked',
          generation: state.generation + 1,
          revokedAt: now().toISOString(),
          prior: null,
        };
        await writeState(secrets, userId, next, { ...audit, restored });
        const result: RevokeHostedInferenceResult = {
          ...describeState(tenantId, userId, next),
          revoked: true,
          gateway,
          restored,
        };
        return result;
      },
    );
  };

  const provisioner: HostedInferenceProvisioner = {
    async provision(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      const budget = normalizeHostedBudget(input.budget);
      const gateway = gatewayConfig();
      await ensureTables();
      const secrets = await getSecrets();
      const result = await inTenant(tenantId, async () => {
        let state = await readState(secrets, userId);
        if (state?.status === 'active') {
          const current = await readUserConfig(secrets, userId);
          if (isOurs(current, state)) {
            const sync = sameBudget(state.budget, budget)
              ? undefined
              : await provisioner.syncBudget({ tenantId, userId, budget });
            const fresh = (await readState(secrets, userId)) ?? state;
            return {
              ...describeState(tenantId, userId, fresh),
              created: false,
              ...(sync && sync.sync !== 'none'
                ? { budgetSync: sync.sync }
                : {}),
            } satisfies ProvisionHostedInferenceResult;
          }
          // The user replaced the hosted binding since: retire that key
          // (keeping their new config) and provision afresh.
          await revokeLocked(
            tenantId,
            userId,
            secrets,
            state,
            'reprovision',
            false,
          );
          state = await readState(secrets, userId);
        }
        const generation = state?.generation ?? 0;
        let rollback: (() => Promise<unknown>) | undefined;
        const admin = await getAdmin(gateway);
        const projectId = await ensureProject(
          tenantId,
          gateway,
          admin,
          secrets,
        );
        return runOnce(
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
            const prior =
              current && current.source !== 'hosted' ? current : null;
            const keyAlias = `smrt-${tenantId}-${userId}-g${generation}`;
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
            let key: AIVirtualKey;
            try {
              key = await admin.createVirtualKey(request);
            } catch (error) {
              throw gatewayFailure('createVirtualKey', error);
            }
            const keyId = text(key?.id) ?? null;
            const apiKey = text(key?.key);
            const discard = async () => {
              if (keyId && typeof admin.deleteVirtualKey === 'function') {
                await admin.deleteVirtualKey(keyId).catch(() => false);
              }
            };
            if (!apiKey) {
              await discard();
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
              await discard();
              // Put the previous state back so the user's prior config is
              // not lost and the next attempt starts from it. Runs after the
              // claim's transaction has rolled back: a delete inside it
              // would wait on that transaction on single-connection
              // adapters.
              const previous = state;
              rollback = () =>
                previous
                  ? writeState(secrets, userId, previous, {
                      operation: 'inference.hosted.provision-rollback',
                      keyAlias,
                    })
                  : secrets.delete(hostedInferenceStateSecretName(userId), {
                      auditDetails: {
                        operation: 'inference.hosted.provision-rollback',
                        keyAlias,
                      },
                    });
              throw error;
            }
            const created: ProvisionHostedInferenceResult = {
              ...describeState(tenantId, userId, next),
              created: true,
            };
            return created;
          },
        ).then(
          async (provisioned) => {
            // A replayed claim must describe what is stored. It does not when
            // the state was removed out of band (claims outlive it for the
            // retention window): refuse rather than report a grant that
            // does not exist.
            const stored = await readUserConfig(secrets, userId);
            if (
              stored?.source !== 'hosted' ||
              stored.gatewayKeyAlias !== provisioned.keyAlias
            ) {
              throw new HostedInferenceError(
                'Hosted inference state for this user was removed outside provisioning; revoke the gateway key named in the audit log and provision again after the run-once claim expires.',
                'HOSTED_STATE_INVALID',
                { tenantId, userId, keyAlias: provisioned.keyAlias },
              );
            }
            return provisioned;
          },
          async (error: unknown) => {
            if (rollback) await rollback().catch(() => undefined);
            throw error;
          },
        );
      });
      invalidateUserInferenceResolvers({ tenantId, userId });
      return result;
    },

    async revoke(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      await ensureTables();
      const secrets = await getSecrets();
      const result = await inTenant(tenantId, async () => {
        const state = await readState(secrets, userId);
        if (state?.status !== 'active') {
          return {
            ...describeState(tenantId, userId, state),
            revoked: false,
            gateway: 'none',
          } satisfies RevokeHostedInferenceResult;
        }
        return revokeLocked(
          tenantId,
          userId,
          secrets,
          state,
          text(input.reason) ?? 'revoke',
          true,
        );
      });
      invalidateUserInferenceResolvers({ tenantId, userId });
      return result;
    },

    async syncBudget(input) {
      const tenantId = requireId(input.tenantId, 'tenantId');
      const userId = requireId(input.userId, 'userId');
      const budget = normalizeHostedBudget(input.budget);
      const secrets = await getSecrets();
      return inTenant(tenantId, async () => {
        const state = await readState(secrets, userId);
        if (state?.status !== 'active') {
          return { ...describeState(tenantId, userId, state), sync: 'none' };
        }
        if (sameBudget(state.budget, budget)) {
          return {
            ...describeState(tenantId, userId, state),
            sync: 'unchanged',
          };
        }
        const admin = await getAdmin(gatewayConfig());
        if (!state.keyId || typeof admin.updateVirtualKey !== 'function') {
          // Recorded state keeps the old budget so a later sync retries.
          return {
            ...describeState(tenantId, userId, state),
            sync: 'unsupported',
          };
        }
        try {
          await admin.updateVirtualKey(state.keyId, {
            budget: toGatewayBudget(budget),
          });
        } catch (error) {
          throw gatewayFailure('updateVirtualKey', error);
        }
        const next = { ...state, budget };
        await writeState(secrets, userId, next, {
          operation: 'inference.hosted.budget',
          keyAlias: state.keyAlias,
          keyId: state.keyId,
          limitMicros: budget.limitMicros,
          window: budget.window,
        });
        return { ...describeState(tenantId, userId, next), sync: 'updated' };
      });
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
      const secrets = await getSecrets();
      return inTenant(tenantId, async () => {
        const rows = await secrets.list({
          category: HOSTED_INFERENCE_SECRET_CATEGORY,
        });
        const users: string[] = [];
        for (const row of rows) {
          if (!row.name.startsWith(STATE_PREFIX)) continue;
          const userId = row.name.slice(STATE_PREFIX.length);
          const state = await readState(secrets, userId);
          if (state?.status === 'active') users.push(userId);
        }
        return users.sort();
      });
    },

    async revokeTenant(tenantId, revokeOptions = {}) {
      const results: RevokeHostedInferenceResult[] = [];
      for (const userId of await provisioner.listActive(tenantId)) {
        results.push(
          await provisioner.revoke({
            tenantId,
            userId,
            ...(revokeOptions.reason ? { reason: revokeOptions.reason } : {}),
          }),
        );
      }
      return results;
    },

    async syncTenantBudget(tenantId, budget) {
      const results: SyncHostedBudgetResult[] = [];
      for (const userId of await provisioner.listActive(tenantId)) {
        results.push(
          await provisioner.syncBudget({ tenantId, userId, budget }),
        );
      }
      return results;
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
 * Revoke a user's hosted inference (downgrade, deletion): delete the gateway
 * key (when the SDK can), restore the user's prior provider config (or mode
 * `off`), and retire the state. Idempotent: nothing active is a no-op.
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

/** Structural mirror of smrt-subscriptions' `EntitlementChange`. */
export interface HostedEntitlementChange {
  tenantId: string;
  gained: readonly string[];
  lost: readonly string[];
  changed: readonly string[];
  after: {
    grants: ReadonlyArray<{
      featureKey: string;
      metadata?: Record<string, unknown>;
    }>;
  };
}

/** Options for {@link createHostedInferenceEntitlementListener}. */
export interface HostedInferenceEntitlementListenerOptions {
  provisioner: HostedInferenceProvisioner;
  /**
   * Users to provision when the tenant gains hosted inference (the tenant's
   * members; membership is the host's). Users joining later are provisioned
   * by the host calling `provision()` directly.
   */
  users(tenantId: string): Promise<readonly string[]>;
  /**
   * The budget for the tenant's plan. Default: the `inference.hosted`
   * grant's `metadata.budget` ({@link hostedBudgetFromGrantMetadata}), else
   * `defaultBudget`.
   */
  budgetFor?(
    change: HostedEntitlementChange,
  ): HostedInferenceBudget | undefined;
  defaultBudget?: HostedInferenceBudget;
}

/**
 * The smrt-subscriptions entitlement-change listener for hosted inference:
 * register it with `registerEntitlementChangeListener()`. Gaining
 * `inference.hosted` provisions every user `users()` names; losing it
 * revokes every active grant of the tenant; a changed grant (plan budget)
 * syncs the gateway budget. Per-user failures are collected and thrown
 * together after every user was attempted (the change outcome lists it);
 * all steps are idempotent, so the host can replay the change.
 */
export function createHostedInferenceEntitlementListener(
  options: HostedInferenceEntitlementListenerOptions,
): (change: HostedEntitlementChange) => Promise<void> {
  const budgetOf = (change: HostedEntitlementChange) => {
    const budget =
      options.budgetFor?.(change) ??
      hostedBudgetFromGrantMetadata(
        change.after.grants.find(
          (grant) => grant.featureKey === HOSTED_INFERENCE_FEATURE_KEY,
        )?.metadata,
      ) ??
      options.defaultBudget;
    if (!budget) {
      throw new HostedInferenceError(
        `The ${HOSTED_INFERENCE_FEATURE_KEY} grant names no budget (metadata.budget.limitMicros) and no defaultBudget is set.`,
        'HOSTED_INFERENCE_INVALID',
        { tenantId: change.tenantId },
      );
    }
    return budget;
  };
  return async (change) => {
    const { tenantId } = change;
    const failures: Array<{ userId?: string; error: unknown }> = [];
    if (change.lost.includes(HOSTED_INFERENCE_FEATURE_KEY)) {
      for (const userId of await options.provisioner.listActive(tenantId)) {
        try {
          await options.provisioner.revoke({
            tenantId,
            userId,
            reason: 'entitlement-lost',
          });
        } catch (error) {
          failures.push({ userId, error });
        }
      }
    } else if (change.gained.includes(HOSTED_INFERENCE_FEATURE_KEY)) {
      const budget = budgetOf(change);
      for (const userId of await options.users(tenantId)) {
        try {
          await options.provisioner.provision({ tenantId, userId, budget });
        } catch (error) {
          failures.push({ userId, error });
        }
      }
    } else if (change.changed.includes(HOSTED_INFERENCE_FEATURE_KEY)) {
      const budget = budgetOf(change);
      for (const userId of await options.provisioner.listActive(tenantId)) {
        try {
          await options.provisioner.syncBudget({ tenantId, userId, budget });
        } catch (error) {
          failures.push({ userId, error });
        }
      }
    }
    if (failures.length > 0) {
      throw new HostedInferenceError(
        `Hosted inference failed for ${failures.length} user(s) of tenant ${tenantId}.`,
        'HOSTED_GATEWAY_FAILED',
        {
          tenantId,
          users: failures.map((failure) => failure.userId),
          codes: failures.map((failure) =>
            failure.error instanceof SmrtError
              ? failure.error.code
              : failure.error instanceof Error
                ? failure.error.name
                : 'unknown',
          ),
        },
      );
    }
  };
}
