/**
 * Request-scoped repository client binding.
 *
 * Provider credentials are intentionally held only by the caller and this
 * async context. They are never copied to a Repository model or persisted.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentTenant, isSystemContext } from '@happyvertical/smrt-tenancy';
import type { IRepository, RepositoryProviderType } from './types';

/**
 * The repository identity a request-scoped provider client is authorized for.
 *
 * `tenantId` is compared to the repository model's tenant identity. Tenant
 * access itself remains governed by the public TenantContext APIs.
 */
export interface RepositoryClientScope {
  provider: RepositoryProviderType;
  owner: string;
  repo: string;
  tenantId?: string | null;
  baseUrl?: string;
}

/** The Repository fields required to resolve a scoped client. */
export interface RepositoryClientIdentity {
  providerType: RepositoryProviderType;
  owner: string;
  name: string;
  tenantId: string | null;
  baseUrl: string;
}

interface ScopedRepositoryClient {
  scope: Required<RepositoryClientScope>;
  client: IRepository;
}

const REPOSITORY_CLIENT_STORAGE_KEY = Symbol.for(
  'smrt:projects:repository-client-storage',
);

function resolveRepositoryClientStorage(): AsyncLocalStorage<ScopedRepositoryClient> {
  const root = globalThis as typeof globalThis & {
    [REPOSITORY_CLIENT_STORAGE_KEY]?: AsyncLocalStorage<ScopedRepositoryClient>;
  };
  root[REPOSITORY_CLIENT_STORAGE_KEY] ??=
    new AsyncLocalStorage<ScopedRepositoryClient>();
  return root[REPOSITORY_CLIENT_STORAGE_KEY];
}

const repositoryClientStorage = resolveRepositoryClientStorage();

function requiredScope(
  scope: RepositoryClientScope,
): Required<RepositoryClientScope> {
  if (!scope || typeof scope !== 'object') {
    throw new TypeError('Repository client scope must be an object.');
  }
  for (const field of ['provider', 'owner', 'repo'] as const) {
    if (typeof scope[field] !== 'string' || scope[field].trim().length === 0) {
      throw new TypeError(
        `Repository client scope ${field} must be a non-blank string.`,
      );
    }
  }
  if (
    scope.tenantId !== undefined &&
    scope.tenantId !== null &&
    typeof scope.tenantId !== 'string'
  ) {
    throw new TypeError(
      'Repository client scope tenantId must be a string, null, or undefined.',
    );
  }
  if (scope.baseUrl !== undefined && typeof scope.baseUrl !== 'string') {
    throw new TypeError(
      'Repository client scope baseUrl must be a string when provided.',
    );
  }
  return {
    provider: scope.provider,
    owner: scope.owner,
    repo: scope.repo,
    tenantId: scope.tenantId ?? null,
    baseUrl: scope.baseUrl ?? '',
  };
}

/**
 * Bind a provider SDK client to one repository identity for an async request.
 * Nested bindings restore their parent when the callback settles.
 */
export async function withRepositoryClient<T>(
  scope: RepositoryClientScope,
  client: IRepository,
  callback: () => T | Promise<T>,
): Promise<T> {
  if (!client || typeof client !== 'object') {
    throw new TypeError('Repository client must be an object.');
  }
  if (typeof callback !== 'function') {
    throw new TypeError('Repository client callback must be a function.');
  }
  return repositoryClientStorage.run(
    { scope: requiredScope(scope), client },
    callback,
  );
}

/** Whether execution currently has a request-scoped repository client. */
export function hasRepositoryClientScope(): boolean {
  return repositoryClientStorage.getStore() !== undefined;
}

/**
 * Resolve the active scoped client for a repository, failing closed if a
 * request-bound credential is used against any other repository identity.
 */
export function getScopedRepositoryClient(
  repository: RepositoryClientIdentity,
): IRepository | undefined {
  const binding = repositoryClientStorage.getStore();
  if (!binding) return undefined;

  const matches =
    binding.scope.provider === repository.providerType &&
    binding.scope.owner === repository.owner &&
    binding.scope.repo === repository.name &&
    binding.scope.tenantId === repository.tenantId &&
    binding.scope.baseUrl === repository.baseUrl;
  if (!matches) {
    throw new Error(
      'Request-scoped repository client does not match this repository identity.',
    );
  }

  // A scoped provider credential must also remain in the tenant request that
  // owns its repository. `withSystemContext()` is the tenancy package's
  // explicit cross-tenant authorization; an absent context preserves the
  // existing global/single-tenant behavior.
  const tenant = getCurrentTenant();
  if (
    !isSystemContext() &&
    tenant &&
    (tenant.tenantId !== binding.scope.tenantId ||
      tenant.tenantId !== repository.tenantId)
  ) {
    throw new Error(
      'Request-scoped repository client does not match the active tenant context.',
    );
  }
  return binding.client;
}
