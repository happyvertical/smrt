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
  createInferenceSettingsController,
  createInferenceSettingsHost,
  type InferenceSettingsController,
  inferenceSettingsFailure,
} from '@happyvertical/smrt-inference/server';
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
 * Secrets, the user resolver and the settings service, from smrt-inference's
 * host. `SMRT_SECRET_MASTER_KEY` wins where it is set (servers); otherwise
 * the local runtime creates the master key on first run and keeps it in its
 * vault key store, so the owner never types or sees it
 * (`runtime.secretMasterKey()` is `null` on deployed profiles, which need the
 * variable). Nothing touches the database until first use: it resolves after
 * `src/hooks.server.ts` imports this module.
 */
const inference = createInferenceSettingsHost({
  database: () => runtime.database(),
  masterKeyProvider: () => runtime.secretMasterKey(),
  overrides: () => runtime.classOptions('InferenceOverride'),
});

/**
 * Stored API keys, tier bindings, aliases and fusions apply to every
 * inference call in this process (the signed-in user's key, then the
 * tenant's, then the stored tier bindings, then config).
 * `registerUserInferenceResolver` keeps the chain validation outermost.
 */
export function installInferenceOverrides(): void {
  inference.install();
}

let controller: InferenceSettingsController | undefined;

/**
 * What the Inference page loads and saves, shared with the app shell
 * (smrt-inference's controller). The session's `can()` is this app's own
 * check: its permission snapshot.
 */
export function inferenceSettingsController(): InferenceSettingsController {
  controller ??= createInferenceSettingsController({
    host: inference,
    preferenceStore: async () =>
      createPreferenceStore({ db: await runtime.database() }),
  });
  return controller;
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
  if ((cause as { name?: string })?.name === 'PromptOverrideAuthorizationError') {
    return { status: 403, error: 'You are not allowed to change this setting.' };
  }
  return inferenceSettingsFailure(cause);
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
