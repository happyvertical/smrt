/**
 * Server side of the inference and prompt settings sections: who may read
 * and write, and the services behind `InferenceSettingsPanel` and
 * `PromptSettingsPanel`. The panels decide nothing; every decision is here.
 *
 * This is a single-owner local app: the signed-in owner holds the
 * `inference.customize` and `prompts.customize` permissions (the owner role
 * is seeded over the permission catalog `./settings-registry` extends), so
 * the owner edits app-wide settings. A member without them reads the
 * settings and every write fails closed.
 */

import {
  createUserInferenceResolver,
  type InferenceSecretStore,
  registerUserInferenceResolver,
  type UserInferenceResolver,
} from '@happyvertical/smrt-inference/resolver';
import {
  createInferenceOverrideResolver,
  type InferenceOverrideAuthorizer,
  InferenceSettingsService,
} from '@happyvertical/smrt-inference/server';
import { SecretService } from '@happyvertical/smrt-secrets';
import { createPreferenceStore } from '@happyvertical/smrt-preferences';
import { PromptSettingsService } from '@happyvertical/smrt-prompts';
import type { SmrtRuntimeLocals } from '@happyvertical/smrt-app-runtime/sveltekit';
import { error } from '@sveltejs/kit';
import { PROMPTS_CUSTOMIZE_PERMISSION } from './settings-registry';
import { runtime } from './smrt';

export { PROMPTS_CUSTOMIZE_PERMISSION };

/** The request locals the settings pages read. */
export type SettingsLocals = Pick<
  SmrtRuntimeLocals,
  'user' | 'tenantId' | 'permissions'
>;

/** The signed-in principal of a settings request. */
export interface SettingsSession {
  tenantId: string;
  userId: string;
  /** Whether the session's permission snapshot holds `permission`. */
  can(permission: string): boolean;
}

/** The session behind a settings load or action; 401 without one. */
export function requireSettingsSession(locals: SettingsLocals): SettingsSession {
  if (!locals.user?.id || !locals.tenantId) error(401, 'Sign in required');
  const permissions = new Set(locals.permissions ?? []);
  return {
    tenantId: locals.tenantId,
    userId: locals.user.id,
    can: (permission) => permissions.has(permission),
  };
}

/**
 * The secrets the user resolver reads and writes. `SMRT_SECRET_MASTER_KEY`
 * wins where it is set (servers); otherwise the local runtime creates the
 * master key on first run and keeps it in its vault key store, so the owner
 * never types or sees it (`runtime.secretMasterKey()` is `null` on deployed
 * profiles, which need the variable). Built on first use: the database
 * resolves after `src/hooks.server.ts` imports this module.
 */
let secretService: Promise<SecretService> | undefined;
function secrets(): Promise<SecretService> {
  secretService ??= (async () =>
    SecretService.create({
      db: await runtime.database(),
      masterKeyProvider: () => runtime.secretMasterKey(),
    }))().catch((cause: unknown) => {
    secretService = undefined;
    throw cause;
  });
  return secretService;
}

const lazySecrets: InferenceSecretStore = {
  retrieve: async (name) => (await secrets()).retrieve(name),
  store: async (name, value, options) =>
    (await secrets()).store(name, value, options),
  delete: async (name) => (await secrets()).delete(name),
};

let userResolver: UserInferenceResolver | undefined;

/**
 * The resolver stored API keys are written through and read from: the
 * signed-in user's key, then the tenant's, then the stored tier bindings
 * (`createInferenceOverrideResolver`), then config.
 */
export function inferenceUserResolver(): UserInferenceResolver {
  userResolver ??= createUserInferenceResolver({
    secrets: lazySecrets,
    fallback: createInferenceOverrideResolver({
      db: () => runtime.classOptions('InferenceOverride'),
    }),
  });
  return userResolver;
}

/**
 * Stored API keys, tier bindings, aliases and fusions apply to every
 * inference call in this process. `registerUserInferenceResolver` keeps the
 * chain validation outermost.
 */
export function installInferenceOverrides(): void {
  registerUserInferenceResolver(inferenceUserResolver());
}

/** Inference settings reads, plus writes for a session that may customize. */
export function inferenceSettingsService(
  session: SettingsSession,
  permission: string,
): Promise<InferenceSettingsService> {
  // The owner edits the app scope; a tenant scope write is only ever for the
  // session's own tenant.
  const authorize: InferenceOverrideAuthorizer = (request) =>
    session.can(permission) &&
    (request.scopeType === 'app' || request.scopeId === session.tenantId);
  return InferenceSettingsService.create(
    runtime.classOptions('InferenceOverride'),
    { authorize },
  );
}

/** The `inference` preference store for the request's principal. */
export async function inferencePreferenceStore() {
  return createPreferenceStore({ db: await runtime.database() });
}

/** Prompt settings reads, plus writes for a session that may customize. */
export function promptSettingsService(
  session: SettingsSession,
): Promise<PromptSettingsService> {
  return PromptSettingsService.create(
    runtime.classOptions('PromptOverride'),
    {
      authorize: (request) =>
        session.can(PROMPTS_CUSTOMIZE_PERMISSION) &&
        (request.scopeType === 'app' ||
          request.scopeId === session.tenantId),
    },
  );
}

/** A `{ error }` body for a failed write: the message names no key or secret. */
export function settingsFailure(cause: unknown): { status: number; error: string } {
  const named = cause as { name?: string; status?: number; message?: string };
  if (
    named?.name === 'InferenceOverrideAuthorizationError' ||
    named?.name === 'PromptOverrideAuthorizationError'
  ) {
    return { status: 403, error: 'You are not allowed to change this setting.' };
  }
  return {
    status: typeof named?.status === 'number' ? named.status : 400,
    error: cause instanceof Error ? cause.message : 'The change was refused.',
  };
}

/** Parse the JSON `payload` form field the settings pages post. */
export async function readPayload<T>(request: Request): Promise<T> {
  const form = await request.formData();
  const raw = form.get('payload');
  if (typeof raw !== 'string') error(400, 'Missing payload');
  try {
    return JSON.parse(raw) as T;
  } catch {
    error(400, 'Invalid payload');
  }
}
