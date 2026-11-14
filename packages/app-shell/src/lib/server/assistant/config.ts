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
  type InferenceResolver,
  type InferenceTierRequest,
  resolveInference,
  resolveInferenceTarget,
} from '@happyvertical/smrt-core';
import {
  inferenceUnavailableMessage,
  isInferenceUnavailableError,
} from '@happyvertical/smrt-core/inference-availability';
import { ChatGPTSignedOutError } from '@happyvertical/smrt-inference/server';
import type { AssistantStatus } from '../../assistant/events.ts';
import { CHATGPT_ASSISTANT_CLASS, CHATGPT_SETTINGS_HREF } from '../chatgpt.ts';
import { type Principal, runAs } from '../owner.ts';

/**
 * Provider ids that sign in with a person's subscription. Refused on the API
 * engine and everywhere else. The single exception is `chatgpt-plan` from the
 * owner's Sign in with ChatGPT, which only the `chatgpt` engine reaches, by
 * its own resolution below ({@link resolveChatGPTAssistantModel}).
 */
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
      'The API key engine does not use subscription providers (claude.ai, CLI sessions, a ChatGPT plan set in configuration). Use an API key, Claude Code, or Sign in with ChatGPT in Settings.',
    );
    this.name = 'SubscriptionProviderError';
  }
}

const CHATGPT_SIGNED_OUT_MESSAGE = 'Sign in with ChatGPT to use the assistant.';

export { ChatGPTSignedOutError };

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
  /** Tests: the resolver the ChatGPT engine asks, instead of the registered one. */
  resolver?: InferenceResolver;
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

/**
 * The model the `chatgpt` engine runs on, for `principal`: asks the resolver
 * (the ChatGPT one `installShellInference` composed) with this engine's own
 * request name and accepts ONLY a `chatgpt-plan` target that resolver made for
 * the owner's sign-in. Anything else (nobody signed in, a resolver that is not
 * installed, another provider) is {@link ChatGPTSignedOutError}: this engine
 * never runs on an API key or any other provider. No `base` client is bound,
 * so no key, endpoint or `HAVE_AI_*` setting can reach the plan.
 */
export async function resolveChatGPTAssistantModel(
  principal: Principal,
  config: AssistantConfigOptions = {},
): Promise<string | undefined> {
  const resolution = await runAs(principal, () =>
    resolveInference(
      {
        tier: tierOf(config),
        tenantId: principal.tenantId,
        className: CHATGPT_ASSISTANT_CLASS,
      },
      config.resolver ? { resolver: config.resolver } : {},
    ),
  );
  const target = resolution.target;
  if (
    resolution.unavailable ||
    target.provider !== 'chatgpt-plan' ||
    target.source !== 'byo'
  )
    throw new ChatGPTSignedOutError();
  return typeof target.model === 'string' && target.model
    ? target.model
    : undefined;
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
  if (error instanceof ChatGPTSignedOutError)
    return {
      type: 'unavailable',
      configured: false,
      engine: 'chatgpt',
      engineLabel: 'ChatGPT',
      code: error.code,
      message: CHATGPT_SIGNED_OUT_MESSAGE,
      error: CHATGPT_SIGNED_OUT_MESSAGE,
      action: { label: 'Sign in with ChatGPT', href: CHATGPT_SETTINGS_HREF },
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
