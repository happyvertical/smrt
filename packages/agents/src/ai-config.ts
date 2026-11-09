import type { AIClientOptions } from '@happyvertical/ai';
import { getDefaultAIKeyEnvName } from '@happyvertical/smrt-config';
import {
  attachAiUsageRecorder,
  createAiUsageRecorder,
  resolveInferenceTarget,
} from '@happyvertical/smrt-core';
import { SecretService } from '@happyvertical/smrt-secrets';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';

export type AgentAISecretFallback = 'none' | 'ancestors';

export interface AgentAIOptions extends AIClientOptions {
  /**
   * Secret name to resolve for the provider API key.
   *
   * When omitted, the agent runtime falls back to a provider-specific default
   * for known providers such as Gemini, OpenAI, and Anthropic.
   */
  apiKeySecretName?: string;

  /**
   * Whether to fall back to ancestor tenants when the current tenant does not
   * define the requested secret.
   *
   * Defaults to `'ancestors'`.
   */
  apiKeySecretFallback?: AgentAISecretFallback;
}

interface ResolveAgentAIOptionsInput {
  aiConfig: AgentAIOptions | undefined;
  db: DatabaseInterface | null | undefined;
  tenantId?: string | null;
  /**
   * Record each call's usage into `_smrt_ai_usage` through the SMRT usage
   * pipeline (`createAiUsageRecorder`, #3077). Defaults to `true` when `db`
   * is given. Pass `false` when the caller wires usage itself, e.g. with
   * `SmrtClass#withAiUsage()`.
   */
  recordUsage?: boolean;
  /** `class_name` for recorded usage rows (default `'Agent'`). */
  className?: string;
}

const DEFAULT_SECRET_FALLBACK: AgentAISecretFallback = 'ancestors';

const secretServiceCache = new WeakMap<
  DatabaseInterface,
  Promise<SecretService>
>();
const tenantCollectionCache = new WeakMap<
  DatabaseInterface,
  Promise<TenantCollection>
>();

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeSecretFallback(value: unknown): AgentAISecretFallback {
  return value === 'none' ? 'none' : DEFAULT_SECRET_FALLBACK;
}

function getDefaultSecretName(aiConfig: AgentAIOptions): string | undefined {
  // The provider -> conventional key name map is shared with the resolver in
  // smrt-config; the key itself is still read per tenant from smrt-secrets.
  return getDefaultAIKeyEnvName(asNonEmptyString(aiConfig.type));
}

function stripAgentAISecretFields(
  aiConfig: AgentAIOptions,
): AIClientOptions & Record<string, unknown> {
  const {
    apiKeySecretName: _apiKeySecretName,
    apiKeySecretFallback: _apiKeySecretFallback,
    ...rest
  } = aiConfig;
  return rest;
}

async function getSecretService(db: DatabaseInterface): Promise<SecretService> {
  const existing = secretServiceCache.get(db);
  if (existing) {
    return await existing;
  }

  const created = SecretService.create({ db });
  secretServiceCache.set(db, created);
  return await created;
}

async function getTenantCollection(
  db: DatabaseInterface,
): Promise<TenantCollection> {
  const existing = tenantCollectionCache.get(db);
  if (existing) {
    return await existing;
  }

  const created = TenantCollection.create({ db });
  tenantCollectionCache.set(db, created);
  return await created;
}

async function getTenantSearchOrder(
  db: DatabaseInterface,
  tenantId: string,
  fallback: AgentAISecretFallback,
): Promise<string[]> {
  const tenantIds = [tenantId];
  if (fallback !== 'ancestors') {
    return tenantIds;
  }

  const tenants = await getTenantCollection(db);
  const ancestors = await tenants.getAncestors(tenantId);
  for (const tenant of ancestors) {
    if (tenant.id) {
      tenantIds.push(tenant.id);
    }
  }

  return tenantIds;
}

async function resolveSecretValue(
  service: SecretService,
  tenantIds: string[],
  secretName: string,
): Promise<string | undefined> {
  for (const tenantId of tenantIds) {
    const value = await withTenant({ tenantId }, async () => {
      try {
        return (await service.retrieve(secretName)).value;
      } catch (error) {
        if (isMissingSecretError(error, secretName)) {
          return undefined;
        }

        throw error;
      }
    });

    if (value) {
      return value;
    }
  }

  return undefined;
}

function isMissingSecretError(error: unknown, secretName: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === `Secret '${secretName}' not found` ||
    error.message === 'Secret not found'
  );
}

/**
 * Resolve an agent's AI client options for the current tenant. Without an
 * explicit `apiKey` or `apiKeySecretName`, a stored per-tenant inference
 * binding (the registered resolver, #4756; never a user's) replaces the
 * provider;
 * otherwise the provider API key comes from smrt-secrets (with optional
 * ancestor fallback). With a
 * `db`, the returned `onUsage` also records each call through the SMRT usage
 * pipeline, attributed to `tenantId` or else the ambient tenant at call time,
 * so a per-call `getAI(options)` client is metered (#3077).
 */
export async function resolveAgentAIOptions(
  input: ResolveAgentAIOptionsInput,
): Promise<AIClientOptions | undefined> {
  const { options: resolved, tags } = await resolveAgentAIClientOptions(input);
  if (!resolved || !input.db || input.recordUsage === false) {
    return resolved;
  }
  return attachAiUsageRecorder(
    resolved,
    createAiUsageRecorder({
      db: input.db,
      className: input.className ?? 'Agent',
      // Unset (not null) when no tenant is named, so the recorder falls back
      // to the ambient tenant of each call.
      tenantId: asNonEmptyString(input.tenantId),
      ...(tags ? { tags } : {}),
      aiConfig: resolved as Record<string, unknown>,
    }),
  );
}

/** {@link resolveAgentAIOptions} without the recorder. */
export interface ResolvedAgentAIConfig {
  options: AIClientOptions | undefined;
  /**
   * Usage tags of a stored inference binding (`tierRequested`,
   * `tierResolved`, `source`; #4756), for a caller that records usage itself.
   */
  tags?: Record<string, string>;
}

/**
 * Resolve the client options without attaching a recorder: an explicit
 * `apiKey`, else (no `apiKeySecretName`) a stored per-tenant inference
 * binding (never a user's: the options are shared by every later run), else
 * the named or provider-default tenant secret.
 */
export async function resolveAgentAIClientOptions(
  input: ResolveAgentAIOptionsInput,
): Promise<ResolvedAgentAIConfig> {
  const { aiConfig, db } = input;
  if (!aiConfig) {
    return { options: undefined };
  }

  const normalized = { ...aiConfig };
  if (asNonEmptyString(normalized.apiKey)) {
    return { options: stripAgentAISecretFields(normalized) };
  }

  // No agent-level secret named: a stored per-tenant inference binding
  // (#4756, the registered resolver) wins over the provider-default secret.
  // App `inference` tier bindings do not replace the agent's own `ai` config
  // (`appBindings: false`). The result outlives the call (an agent keeps it
  // for every later run), so no user's binding applies (`userId: null`).
  if (!asNonEmptyString(normalized.apiKeySecretName)) {
    const stored = await resolveInferenceTarget({
      base: stripAgentAISecretFields(normalized),
      tenantId: asNonEmptyString(input.tenantId),
      userId: null,
      className: input.className ?? 'Agent',
      appBindings: false,
    });
    if (stored.bound && stored.options) {
      return {
        options: stored.options as AIClientOptions,
        tags: stored.usageTags,
      };
    }
  }

  const secretName =
    asNonEmptyString(normalized.apiKeySecretName) ??
    getDefaultSecretName(normalized);
  if (!secretName || !db) {
    return { options: stripAgentAISecretFields(normalized) };
  }

  const tenantId =
    asNonEmptyString(input.tenantId) ??
    asNonEmptyString(getCurrentTenant()?.tenantId);
  if (!tenantId) {
    return { options: stripAgentAISecretFields(normalized) };
  }

  const fallback = normalizeSecretFallback(normalized.apiKeySecretFallback);
  const tenantIds = await getTenantSearchOrder(db, tenantId, fallback);
  const service = await getSecretService(db);
  const apiKey = await resolveSecretValue(service, tenantIds, secretName);

  if (!apiKey) {
    return { options: stripAgentAISecretFields(normalized) };
  }

  return {
    options: {
      ...stripAgentAISecretFields(normalized),
      apiKey,
    },
  };
}
