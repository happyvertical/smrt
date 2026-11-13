/**
 * Provider API keys for an Inference settings page.
 *
 * A key is stored once, as the `inference.provider-config` secret the user
 * resolver reads (`docs/content/inference-settings.md`): the page's
 * `saveKey` action binds it to the endpoint it was entered for, turns it
 * into that stored config, and writes it through the resolver, so a saved
 * key is the key inference calls use. The browser never receives a key back,
 * only whether one is set.
 *
 * Free of any runtime or web framework, so a template app and the app shell
 * share it, tested with a real resolver over a real secret store.
 */

import type { UserInferenceResolver } from '../resolver.js';
import { bindInferenceKey, inferenceProviderConfigFromKey } from './keys.js';

/** What the panel's `onSaveKey` posts. */
export interface InferenceKeyPayload {
  provider: string;
  key: string;
  preset?: string;
  baseUrl?: string;
}

/**
 * Store the key the owner entered for the signed-in user. `model` is the
 * owner's saved default model (a preset key needs one). Throws
 * `InferenceKeyOriginError` (status 400, names no key) when the key cannot be
 * bound to an endpoint.
 */
export async function saveInferenceKey(
  resolver: Pick<UserInferenceResolver, 'write'>,
  change: InferenceKeyPayload,
  model?: string,
): Promise<void> {
  const record = bindInferenceKey(change);
  await resolver.write(
    'user',
    inferenceProviderConfigFromKey(record, { model }),
  );
}

/**
 * Whether a key is stored for this principal (the user's, else the tenant's),
 * from the resolver's redacted view. A store that cannot be read shows "not
 * set": the page still loads, and the write path reports why.
 */
export async function inferenceKeyIsSet(
  resolver: Pick<UserInferenceResolver, 'resolveBindings'>,
): Promise<boolean> {
  try {
    const bindings = await resolver.resolveBindings({ redact: true });
    const stored = bindings.user ?? bindings.tenant;
    return Boolean(
      stored && (stored as { hasApiKey?: boolean }).hasApiKey === true,
    );
  } catch {
    return false;
  }
}
