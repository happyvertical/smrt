/**
 * The server wiring every host of `InferenceSettingsPanel` needs, free of any
 * web framework: the secret store (sealed under the runtime's master key),
 * the user resolver stored API keys are written through and read from, its
 * registration for inference calls, and the settings service with the
 * authorizer that gates its writes.
 *
 * A SvelteKit template app and the app shell both build their host from this,
 * so a key saved on the Inference page is the key the process's inference
 * calls (including the shell's assistant) use, with no restart.
 */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  type SecretMasterKeyProvider,
  SecretService,
} from '@happyvertical/smrt-secrets';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  createUserInferenceResolver,
  type InferenceSecretStore,
  registerUserInferenceResolver,
  type UserInferenceResolver,
} from '../resolver.js';
import type { InferenceOverrideAuthorizer } from './override-service.js';
import { createInferenceOverrideResolver } from './resolver.js';
import { InferenceSettingsService } from './settings-service.js';

/** What {@link createInferenceSettingsHost} needs from the host app. */
export interface InferenceSettingsHostOptions {
  /** The application database (resolved on first use). */
  database: () => Promise<DatabaseInterface>;
  /**
   * The application master key for the secret store. `SMRT_SECRET_MASTER_KEY`
   * wins where it is set; a local runtime supplies `secretMasterKey()` here
   * (null off the local profile).
   */
  masterKeyProvider?: SecretMasterKeyProvider;
  /** Database options of the `InferenceOverride` collection. */
  overrides: () => SmrtClassOptions;
}

/** The principal of a settings request. */
export interface InferenceSettingsSession {
  tenantId: string;
  /** Whether the session holds `permission` (the host's own check). */
  can(permission: string): boolean;
}

export interface InferenceSettingsHost {
  /** The secret store; built on first use, retried after a failure. */
  secrets(): Promise<SecretService>;
  /**
   * The resolver stored API keys are written through and read from: the
   * signed-in user's key, then the tenant's, then the stored tier bindings,
   * then config.
   */
  userResolver(): UserInferenceResolver;
  /**
   * Register {@link userResolver} for every inference call in this process
   * (the chain validation stays outermost).
   */
  install(): UserInferenceResolver;
  /**
   * Settings reads, plus writes for a session holding `permission`. An app
   * scope write is allowed for that session; a tenant scope write only for
   * the session's own tenant.
   */
  settingsService(
    session: InferenceSettingsSession,
    permission: string,
  ): Promise<InferenceSettingsService>;
}

/** Build the host. Nothing touches the database until first use. */
export function createInferenceSettingsHost(
  options: InferenceSettingsHostOptions,
): InferenceSettingsHost {
  let secretService: Promise<SecretService> | undefined;
  const secrets = (): Promise<SecretService> => {
    secretService ??= (async () =>
      SecretService.create({
        db: await options.database(),
        ...(options.masterKeyProvider
          ? { masterKeyProvider: options.masterKeyProvider }
          : {}),
      }))().catch((cause: unknown) => {
      secretService = undefined;
      throw cause;
    });
    return secretService;
  };

  const lazySecrets: InferenceSecretStore = {
    retrieve: async (name) => (await secrets()).retrieve(name),
    store: async (name, value, storeOptions) =>
      (await secrets()).store(name, value, storeOptions),
    delete: async (name) => (await secrets()).delete(name),
  };

  let resolver: UserInferenceResolver | undefined;
  const userResolver = (): UserInferenceResolver => {
    resolver ??= createUserInferenceResolver({
      secrets: lazySecrets,
      fallback: createInferenceOverrideResolver({ db: options.overrides }),
    });
    return resolver;
  };

  return {
    secrets,
    userResolver,
    install: () => registerUserInferenceResolver(userResolver()),
    settingsService(session, permission) {
      const authorize: InferenceOverrideAuthorizer = (request) =>
        session.can(permission) &&
        (request.scopeType === 'app' || request.scopeId === session.tenantId);
      return InferenceSettingsService.create(options.overrides(), {
        authorize,
      });
    },
  };
}

/**
 * A `{ status, error }` for a failed settings write. The message names no key
 * or secret: authorization failures get a fixed sentence, anything else its
 * own message (key-origin errors never echo the key).
 */
export function inferenceSettingsFailure(cause: unknown): {
  status: number;
  error: string;
} {
  const named = cause as { name?: string; status?: number };
  if (named?.name === 'InferenceOverrideAuthorizationError') {
    return {
      status: 403,
      error: 'You are not allowed to change this setting.',
    };
  }
  return {
    status: typeof named?.status === 'number' ? named.status : 400,
    error: cause instanceof Error ? cause.message : 'The change was refused.',
  };
}
