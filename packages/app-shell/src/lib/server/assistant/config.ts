// Where the assistant's model comes from. An API key resolved through core's
// inference tiers; NEVER a subscription login (claude.ai / ChatGPT plan):
// those providers are refused here, before any client is built. The chain is
// the owner's key saved in Settings (smrt-inference's user resolver, over
// smrt-secrets), then the stored tier bindings, then the deployment's config
// (`smrt.config.ts` `ai` block, `SMRT_AI_*`, or the provider's conventional
// variable such as `ANTHROPIC_API_KEY`), which stays the base. The key is
// read here only, handed to the provider SDK, and never logged or sent to a
// browser. The resolver is registered at startup (`installShellInference`),
// and a saved key invalidates its cache, so the next turn uses it.
import {
  type AIProviderClientOptions,
  toAIClientOptions,
  tryResolveAIProviderConfig,
  tryResolveConfiguredAIProvider,
} from '@happyvertical/smrt-config';
import {
  type InferenceTierRequest,
  resolveInferenceTarget,
} from '@happyvertical/smrt-core';
import {
  inferenceUnavailableMessage,
  isInferenceUnavailableError,
} from '@happyvertical/smrt-core/inference-availability';
import type { AssistantStatus } from '../../assistant/events.ts';
import { type Principal, runAs } from '../owner.ts';

/** Provider ids that sign in with a person's subscription. Never allowed. */
export const SUBSCRIPTION_PROVIDERS: readonly string[] = [
  'claude-cli',
  'chatgpt-plan',
];

const SUBSCRIPTION_PATTERN =
  /claude[-_ .]?cli|chatgpt[-_ .]?plan|subscription/i;

/** Thrown for a configuration that would use a subscription login. */
export class SubscriptionProviderError extends Error {
  readonly code = 'assistant_provider_refused';
  constructor() {
    super(
      'The assistant uses an API key. Subscription logins (claude.ai, ChatGPT plan, CLI sessions) are not supported.',
    );
    this.name = 'SubscriptionProviderError';
  }
}

/** Thrown when there is no API key to run the assistant on. */
export class AssistantNotConfiguredError extends Error {
  readonly code = 'assistant_not_configured';
  constructor(
    message = 'The assistant needs an API key. Add one in Settings to turn it on.',
  ) {
    super(message);
    this.name = 'AssistantNotConfiguredError';
  }
}

/** Refuse a provider id that is a subscription login. */
export function assertApiKeyProvider(provider: unknown): void {
  if (typeof provider !== 'string' || !provider.trim()) return;
  const id = provider.trim().toLowerCase();
  if (SUBSCRIPTION_PROVIDERS.includes(id) || SUBSCRIPTION_PATTERN.test(id))
    throw new SubscriptionProviderError();
}

/** Guard a whole `getAI()` options bag (both spellings of the provider). */
export function assertApiKeyOptions(
  options: Record<string, unknown> | undefined,
): void {
  if (!options) return;
  assertApiKeyProvider(options.provider);
  assertApiKeyProvider(options.type);
}

export interface AssistantConfigOptions {
  /** Environment to read. Default `process.env`. Tests inject their own. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Inference tier. Default `SMRT_APP_SHELL_ASSISTANT_TIER`, else `good`. */
  tier?: InferenceTierRequest;
}

const TIERS = ['cheap', 'good', 'great', 'best', 'auto'] as const;

function tierOf(options: AssistantConfigOptions): InferenceTierRequest {
  if (options.tier) return options.tier;
  const env = (options.env ?? process.env).SMRT_APP_SHELL_ASSISTANT_TIER;
  return (TIERS as readonly string[]).includes(env ?? '')
    ? (env as InferenceTierRequest)
    : 'good';
}

function baseOptions(
  env: Readonly<Record<string, string | undefined>>,
): AIProviderClientOptions | undefined {
  let resolved: ReturnType<typeof tryResolveAIProviderConfig>;
  try {
    // The loaded smrt.config.ts `ai` block plus the environment.
    resolved = tryResolveConfiguredAIProvider({ env });
  } catch {
    resolved = tryResolveAIProviderConfig({ env, config: null });
  }
  if (!resolved) return undefined;
  assertApiKeyProvider(resolved.provider);
  return toAIClientOptions(resolved);
}

/**
 * The `getAI()` options for `principal`'s assistant: the config/env key as
 * `base`, bound by core's tier resolution (the principal's saved key wins). Throws
 * {@link AssistantNotConfiguredError}, {@link SubscriptionProviderError} or
 * core's `InferenceUnavailableError`. Never calls a model. The result may hold
 * the key: pass it to `getAI()` and drop it.
 */
export async function resolveAssistantOptions(
  principal: Principal,
  config: AssistantConfigOptions = {},
): Promise<Record<string, unknown>> {
  const base = baseOptions(config.env ?? process.env);
  const resolved = await runAs(principal, () =>
    resolveInferenceTarget({
      tier: tierOf(config),
      ...(base ? { base: base as Record<string, unknown> } : {}),
      tenantId: principal.tenantId,
      className: 'AppShellAssistant',
      usage: { className: 'AppShellAssistant', tenantId: principal.tenantId },
      // The thread is stored in shell.db: no second transcript copy.
      transcript: false,
    }),
  );
  assertApiKeyOptions(resolved.options);
  if (!resolved.options) throw new AssistantNotConfiguredError();
  return resolved.options;
}

/** The answer for the dock's "not configured" state. No secrets. */
export async function assistantStatus(
  principal: Principal,
  config: AssistantConfigOptions = {},
): Promise<AssistantStatus> {
  try {
    await resolveAssistantOptions(principal, config);
    return { configured: true };
  } catch (error) {
    return (
      unavailableBody(error) ?? {
        configured: false,
        code: 'assistant_error',
        message: 'The assistant is not available right now.',
      }
    );
  }
}

/** Typed "not available" body for the errors above, else `undefined`. */
export function unavailableBody(error: unknown):
  | (AssistantStatus & {
      type: 'unavailable';
      configured: false;
      error: string;
    })
  | undefined {
  if (error instanceof AssistantNotConfiguredError)
    return {
      type: 'unavailable',
      configured: false,
      code: error.code,
      message: error.message,
      error: error.message,
    };
  if (error instanceof SubscriptionProviderError)
    return {
      type: 'unavailable',
      configured: false,
      code: error.code,
      message: error.message,
      error: error.message,
    };
  if (isInferenceUnavailableError(error)) {
    const message = inferenceUnavailableMessage(error.reason);
    return {
      type: 'unavailable',
      configured: false,
      code: 'ai_unavailable',
      message,
      error: message,
    };
  }
  return undefined;
}
