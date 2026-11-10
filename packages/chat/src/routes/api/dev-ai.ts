/**
 * Provider resolution for the dev workbench routes (#3372).
 *
 * Delegates to the shared `@happyvertical/smrt-config` resolver. The dev routes
 * keep their historical env precedence by passing an explicit prefix list
 * (`SMRT_CHAT_DEV_*`, then `SMRT_AI_*`, then `HAVE_AI_*`) and letting env win
 * over the `smrt.config.ts` `ai` block, then key auto-detection.
 */
import { tryResolveConfiguredAIProvider } from '@happyvertical/smrt-config';
import { resolveInferenceTarget } from '@happyvertical/smrt-core';

export interface DevAIConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export const DEV_AI_ENV_PREFIXES = [
  'SMRT_CHAT_DEV',
  'SMRT_AI',
  'HAVE_AI',
] as const;

/** Resolve the dev provider, or `null` to use the local deterministic reply. */
export function resolveDevAIConfig(
  requestedModel?: string,
): DevAIConfig | null {
  const resolved = tryResolveConfiguredAIProvider({
    explicit: requestedModel ? { model: requestedModel } : undefined,
    prefixes: DEV_AI_ENV_PREFIXES,
    envOverridesConfig: true,
  });
  if (!resolved?.provider) return null;
  return {
    provider: resolved.provider,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
  };
}

/**
 * `getAI()` options for a dev text route: a registered inference binding
 * (#4756; the dev workbench has no principal, so only tenant-less app
 * bindings apply) over the resolved dev provider, with the #3077 usage
 * recorder attached (configured usage handlers; the workbench has no db).
 */
export async function devAIClientOptions(
  config: DevAIConfig,
): Promise<Record<string, unknown>> {
  const resolved = await resolveInferenceTarget({
    base: {
      type: config.provider,
      provider: config.provider,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model
        ? { model: config.model, defaultModel: config.model }
        : {}),
    },
    className: 'ChatDev',
    usage: { className: 'ChatDev' },
    // Chat content is stored by smrt-chat, never as AI transcripts (#4780).
    transcript: false,
  });
  return resolved.options ?? {};
}
