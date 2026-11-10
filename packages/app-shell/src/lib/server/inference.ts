// The shell's Inference settings, server side: the one smrt-inference host
// (secret store sealed under the runtime's master key, the user resolver keys
// are written through, the settings service), its registration for every
// inference call in this process, and the owner-only helpers the
// `/settings/inference` route calls. The assistant reads its provider and key
// through this same registered resolver (`assistant/config.ts`), so a key
// saved here is the key the next assistant turn uses.
//
// Owner only: every helper runs through `asOwner` (the same shell.db lookup as
// every other route) before a body is read; a member or a stranger is refused.
import {
  createInferenceSettingsController,
  createInferenceSettingsHost,
  type InferenceControllerSession,
  type InferenceSettingsController,
  type InferenceSettingsHost,
} from '@happyvertical/smrt-inference/server';
import { createPreferenceStore } from '@happyvertical/smrt-preferences';
import './inference-registry.ts';
import { getShellDb, getShellSecretMasterKey, shellDbSync } from './host.ts';
import {
  type Principal,
  principalFromLocals,
  requireOwner,
  runAs,
} from './owner.ts';

let host: InferenceSettingsHost | undefined;

/** The shell's inference host, built on first use over shell.db. */
export function shellInference(): InferenceSettingsHost {
  host ??= createInferenceSettingsHost({
    database: getShellDb,
    masterKeyProvider: getShellSecretMasterKey,
    // Read only after `getShellDb()` has resolved (every route and every
    // stored-key read opens it first).
    overrides: () => ({ db: shellDbSync() }),
  });
  return host;
}

/**
 * Register the user resolver for this process's inference calls. Lazy: no
 * database is touched until an inference call resolves a tier.
 */
export function installShellInference(): void {
  shellInference().install();
}

/** Tests only: forget the cached host (it holds a secret store on one db). */
export function resetShellInference(): void {
  host = undefined;
  controller = undefined;
}

let controller: InferenceSettingsController | undefined;

/**
 * What the Inference page loads and saves (smrt-inference's controller, the
 * one the template uses too), over the shell's host and preference store.
 */
export function shellInferenceController(): InferenceSettingsController {
  controller ??= createInferenceSettingsController({
    host: shellInference(),
    preferenceStore: async () =>
      createPreferenceStore({ db: await getShellDb() }),
  });
  return controller;
}

/** The session the controller sees: the owner holds every right here. */
export function ownerSession(owner: Principal): InferenceControllerSession {
  return { tenantId: owner.tenantId, can: () => true };
}

/**
 * Run `fn` as the verified owner of a SvelteKit request, inside the owner's
 * tenant context (the secret store, user resolver and preferences read the
 * ambient principal). Throws {@link PolicyError} (401 nobody, 403 not the
 * owner) before `fn` runs, so a refusal never reads a request body.
 */
export async function asOwner<T>(
  locals: {
    user?: { id?: unknown } | null;
    tenantId?: unknown;
    permissions?: unknown;
  },
  fn: (owner: Principal, session: InferenceControllerSession) => Promise<T>,
): Promise<T> {
  await getShellDb(); // the override resolver reads it synchronously
  const owner = await requireOwner(principalFromLocals(locals));
  return runAs(owner, () => fn(owner, ownerSession(owner)));
}
