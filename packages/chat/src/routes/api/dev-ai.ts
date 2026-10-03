/**
 * Provider resolution for the dev workbench routes (#3372).
 *
 * Delegates to the shared `@happyvertical/smrt-config` resolver. The dev routes
 * keep their historical env precedence by passing an explicit prefix list
 * (`SMRT_CHAT_DEV_*`, then `SMRT_AI_*`, then `HAVE_AI_*`) and letting env win
 * over the `smrt.config.ts` `ai` block, then key auto-detection.
 */
import { tryResolveConfiguredAIProvider } from '@happyvertical/smrt-config';

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
