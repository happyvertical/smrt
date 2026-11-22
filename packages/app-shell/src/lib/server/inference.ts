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
  InferenceSettingsService,
  inferenceKeyOrigin,
} from '@happyvertical/smrt-inference/server';
import { createPreferenceStore } from '@happyvertical/smrt-preferences';
import './inference-registry.ts';
import { asSettingsOwner, assistantSettings } from './agent-cli/service.ts';
import { CHATGPT_ASSISTANT_CLASS, lazyChatgptConnection } from './chatgpt.ts';
import {
  getShellDb,
  getShellSecretMasterKey,
  shellDbSync,
  shellProfile,
} from './host.ts';
import {
  currentPrincipal,
  type Principal,
  principalFromLocals,
  requireOwner,
  runAs,
} from './owner.ts';

let host: InferenceSettingsHost | undefined;

/** The shell's inference host, built on first use over shell.db. */
export function shellInference(): InferenceSettingsHost {
  host ??= tenantOnlyInCloud(createShellInferenceHost());
  return host;
}

/**
 * Hosted, an owner is the owner of ONE tenant, not of the deployment: the
 * shared host lets any session holding the right write app-scope rows
 * (`_smrt_inference_overrides`, which every tenant's resolution layers
 * under its own), so the settings service is rebuilt with an authorizer that
 * admits this tenant's own scope only. Every app-scope write (a tier or
 * default tier at `app`, an alias, a fusion, the transcript setting) is then
 * refused with the host's 403 outcome. The desktop keeps the shared host's
 * rule: its one owner is the deployment.
 */
function tenantOnlyInCloud(base: InferenceSettingsHost): InferenceSettingsHost {
  return {
    ...base,
    async settingsService(session, permission) {
      if ((await shellProfile()) !== 'cloud')
        return base.settingsService(session, permission);
      return InferenceSettingsService.create(
        { db: shellDbSync() },
        {
          authorize: (request) =>
            session.can(permission) &&
            request.scopeType === 'tenant' &&
            request.scopeId === session.tenantId,
        },
      );
    },
  };
}

function createShellInferenceHost(): InferenceSettingsHost {
  return createInferenceSettingsHost({
    database: getShellDb,
    masterKeyProvider: getShellSecretMasterKey,
    // Read only after `getShellDb()` has resolved (every route and every
    // stored-key read opens it first).
    overrides: () => ({ db: shellDbSync() }),
    // Sign in with ChatGPT: only the assistant's own `chatgpt` engine asks for
    // the plan (by request name); no tier is ever moved onto it.
    chatgptPlan: {
      connection: lazyChatgptConnection,
      appliesTo: (request) => request.className === CHATGPT_ASSISTANT_CLASS,
      model: async () => {
        const owner = currentPrincipal();
        if (!owner) return undefined;
        const settings = await asSettingsOwner(owner, () =>
          assistantSettings().read(),
        );
        return settings.chatgptModel ?? undefined;
      },
    },
  });
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
  controller ??= withoutServerProbesInCloud(
    createInferenceSettingsController({
      host: shellInference(),
      preferenceStore: async () =>
        createPreferenceStore({ db: await getShellDb() }),
    }),
  );
  return controller;
}

const NO_PROBES = {
  ok: false as const,
  status: 403,
  error: 'This is not available on the hosted app.',
};

const NO_ENDPOINT = {
  ok: false as const,
  status: 403,
  error: 'A custom or local endpoint is not available on the hosted app.',
};

/**
 * Hosted, the probes are refused: they make the SERVER connect to an address
 * the owner typed (an internal-network request), read the operator's key
 * variables for a configured candidate, and look at the server's own
 * loopback for local model servers. None of that is a tenant's to do.
 */
function withoutServerProbesInCloud(
  inner: InferenceSettingsController,
): InferenceSettingsController {
  return {
    ...inner,
    async saveKey(session, change) {
      if ((await shellProfile()) === 'cloud') {
        // The key is later SENT to its endpoint by the server: hosted, only a
        // provider's own public https endpoint may hold one, never an address
        // the owner typed (an internal-network request) or a local server.
        let origin: string | null = null;
        try {
          origin = inferenceKeyOrigin(change);
        } catch {
          origin = null; // the inner host refuses it with its own message
        }
        if (change.baseUrl?.trim() || (origin && !origin.startsWith('https:')))
          return { ...NO_ENDPOINT };
      }
      return inner.saveKey(session, change);
    },
    async testConnection(session, input) {
      if ((await shellProfile()) === 'cloud') return { ...NO_PROBES };
      return inner.testConnection(session, input);
    },
    async testCandidate(session, candidate) {
      if ((await shellProfile()) === 'cloud') return { ...NO_PROBES };
      return inner.testCandidate(session, candidate);
    },
    async discoverModels(session) {
      if ((await shellProfile()) === 'cloud') return { discovered: [] };
      return inner.discoverModels(session);
    },
  };
}

/**
 * The session the controller sees: the owner holds every right here. That is
 * the desktop's one-owner-one-deployment rule; hosted, the right is checked
 * against the SCOPE of each write by {@link shellInference}'s authorizer, so
 * `can: () => true` never reaches an app-scope row.
 */
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
  // The override resolver reads the database synchronously. Hosted, the
  // database is handed out only inside a tenant's context, so open it as the
  // request's own principal (nobody: the owner check below answers 401).
  const requester = principalFromLocals(locals);
  if (requester) await runAs(requester, () => getShellDb());
  const owner = await requireOwner(requester);
  return runAs(owner, () => fn(owner, ownerSession(owner)));
}
