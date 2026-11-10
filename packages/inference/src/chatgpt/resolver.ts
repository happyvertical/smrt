/**
 * The resolver piece of "Sign in with ChatGPT": yields a `chatgpt-plan`
 * target for the signed-in account, for calls that ASK for it.
 *
 * Using a ChatGPT plan is a different billing path from an API key, so it is
 * an explicit opt-in per call (`appliesTo`), never the default for a tier and
 * never a fallback. A call that opted in and finds nobody signed in is
 * answered `unavailable: 'unconfigured'` (core throws
 * `InferenceUnavailableError` before any client is built); it does not
 * quietly run on an API key. Every other call is the `fallback`'s, unchanged:
 * install this OUTSIDE the user resolver, as {@link createInferenceSettingsHost}
 * does when given `chatgptPlan`.
 */
import type {
  InferenceModeRequest,
  InferenceRequest,
  InferenceResolution,
  InferenceResolver,
  InferenceResolverContext,
} from '@happyvertical/smrt-core';
import {
  CHATGPT_PLAN_PROVIDER,
  type ChatGPTPlanConnection,
} from './connection.js';

export interface ChatGPTPlanResolverOptions {
  connection: Pick<ChatGPTPlanConnection, 'status' | 'defaultModel'>;
  /** Whether this call asked for the ChatGPT plan. There is no default. */
  appliesTo(request: InferenceRequest): boolean | Promise<boolean>;
  /**
   * The model for this call (the owner's choice). Default: the account's
   * first listed model.
   */
  model?(
    request: InferenceRequest,
  ): string | undefined | Promise<string | undefined>;
  /** Everything that did not opt in (the user resolver). */
  fallback?: InferenceResolver;
}

export function createChatGPTPlanResolver(
  options: ChatGPTPlanResolverOptions,
): InferenceResolver {
  const { fallback } = options;
  const resolver: InferenceResolver = {
    async resolve(
      request: InferenceRequest,
      context: InferenceResolverContext,
    ): Promise<InferenceResolution | undefined> {
      if (!(await options.appliesTo(request)))
        return fallback?.resolve(request, context);
      const tierResolved =
        request.tier === 'auto' ? 'good' : (request.tier ?? 'good');
      if (!(await options.connection.status()).signedIn)
        return {
          tierResolved,
          target: {},
          via: 'resolver',
          mode: 'off',
          unavailable: 'unconfigured',
        };
      const model =
        (await options.model?.(request)) ??
        (await options.connection.defaultModel());
      return {
        tierResolved,
        target: {
          provider: CHATGPT_PLAN_PROVIDER,
          ...(model ? { model } : {}),
          // The person's own account, not a key, a local server or hosted.
          source: 'byo',
        },
        via: 'resolver',
        mode: 'byo',
      };
    },
  };
  if (fallback?.mode)
    resolver.mode = (request: InferenceModeRequest) => fallback.mode?.(request);
  if (fallback?.lookupFusion)
    resolver.lookupFusion = (key, request, context) =>
      fallback.lookupFusion?.(key, request, context);
  return resolver;
}

export type ChatGPTPlanFailureKind =
  | 'usage_limit'
  | 'session_revoked'
  | 'workspace'
  | 'unavailable'
  | 'unsupported_capability'
  | 'other';

const BY_CLASS: Record<string, ChatGPTPlanFailureKind> = {
  ChatGPTPlanUsageLimitError: 'usage_limit',
  ChatGPTPlanSessionRevokedError: 'session_revoked',
  ChatGPTPlanWorkspaceError: 'workspace',
  ChatGPTPlanUsageUnavailableError: 'unavailable',
};

/**
 * What kind of ChatGPT plan failure `error` is, from the SDK's error class
 * and code (never message text): `usage_limit` (plan or app limit),
 * `session_revoked` (sign in again), `workspace` (the account or workspace
 * does not allow it), `unavailable` (try again later; the session is kept),
 * `unsupported_capability` (the request used an option the preview refuses:
 * a bug in the caller), else `other`.
 */
export function classifyChatGPTPlanFailure(
  error: unknown,
): ChatGPTPlanFailureKind {
  if (!error || typeof error !== 'object') return 'other';
  const e = error as { name?: unknown; code?: unknown };
  if (typeof e.name === 'string' && BY_CLASS[e.name]) return BY_CLASS[e.name];
  if (e.code === 'subscription_sharing_unsupported_capability')
    return 'unsupported_capability';
  if (e.name === 'ChatGPTSessionError') {
    const code = e.code;
    if (code === 'unknown_account' || code === 'refresh_invalid')
      return 'session_revoked';
  }
  return 'other';
}
