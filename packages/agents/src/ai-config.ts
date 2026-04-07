import type { AIClientOptions } from '@happyvertical/ai';
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
}

const DEFAULT_SECRET_NAMES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

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
  const provider = asNonEmptyString(aiConfig.type)?.toLowerCase();
  if (!provider) {
    return undefined;
  }

  return DEFAULT_SECRET_NAMES[provider];
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
      } catch {
        return undefined;
      }
    });

    if (value) {
      return value;
    }
  }

  return undefined;
}

export async function resolveAgentAIOptions(
  input: ResolveAgentAIOptionsInput,
): Promise<AIClientOptions | undefined> {
  const { aiConfig, db } = input;
  if (!aiConfig) {
    return undefined;
  }

  const normalized = { ...aiConfig };
  if (asNonEmptyString(normalized.apiKey)) {
    return stripAgentAISecretFields(normalized);
  }

  const secretName =
    asNonEmptyString(normalized.apiKeySecretName) ??
    getDefaultSecretName(normalized);
  if (!secretName || !db) {
    return stripAgentAISecretFields(normalized);
  }

  const tenantId =
    asNonEmptyString(input.tenantId) ??
    asNonEmptyString(getCurrentTenant()?.tenantId);
  if (!tenantId) {
    return stripAgentAISecretFields(normalized);
  }

  const fallback = normalizeSecretFallback(normalized.apiKeySecretFallback);
  const tenantIds = await getTenantSearchOrder(db, tenantId, fallback);
  const service = await getSecretService(db);
  const apiKey = await resolveSecretValue(service, tenantIds, secretName);

  if (!apiKey) {
    return stripAgentAISecretFields(normalized);
  }

  return {
    ...stripAgentAISecretFields(normalized),
    apiKey,
  };
}
