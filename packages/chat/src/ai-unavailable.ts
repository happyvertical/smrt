/**
 * The structured "AI unavailable" answer chat sends instead of a 500 (#4757).
 *
 * When core throws `InferenceUnavailableError` (`AI_UNAVAILABLE`: mode
 * `off`, nothing configured, ...), the assistant routes, the chat stream
 * handler and the dev routes answer `503` with
 * `{ type: 'unavailable', code: 'ai_unavailable', error, unavailable }`,
 * where `unavailable` is core's `InferenceStatus` (`available: false`, mode,
 * reason, tier). No stack, no provider detail, never a key. Svelte surfaces
 * render it as "AI is off" with a host-supplied settings link.
 *
 * Browser-safe: imports core's light `./inference-availability` subpath only.
 */
import {
  type InferenceStatus,
  inferenceUnavailableMessage,
  inferenceUnavailableStatus,
  isInferenceUnavailableError,
} from '@happyvertical/smrt-core/inference-availability';

/** `code` of a chat answer for unavailable AI. */
export const CHAT_AI_UNAVAILABLE_CODE = 'ai_unavailable';

/** The JSON body (and in-band stream event fields) for unavailable AI. */
export interface ChatUnavailableBody {
  type: 'unavailable';
  code: typeof CHAT_AI_UNAVAILABLE_CODE;
  /** User-safe sentence for the reason. */
  error: string;
  unavailable: InferenceStatus;
}

/**
 * The structured body for an `AI_UNAVAILABLE` error, or `undefined` for any
 * other error. `unconfigured` is also accepted for callers that map their
 * own "no provider" error (smrt-config's `AIProviderNotConfiguredError`).
 */
export function chatUnavailableBody(
  error: unknown,
): ChatUnavailableBody | undefined {
  if (!isInferenceUnavailableError(error)) return undefined;
  const status = inferenceUnavailableStatus(
    error.reason,
    error.mode,
    error.tier,
  );
  return {
    type: 'unavailable',
    code: CHAT_AI_UNAVAILABLE_CODE,
    error: inferenceUnavailableMessage(error.reason),
    unavailable: status,
  };
}

/** The body for nothing configured (no binding and no provider). */
export function chatUnconfiguredBody(): ChatUnavailableBody {
  return {
    type: 'unavailable',
    code: CHAT_AI_UNAVAILABLE_CODE,
    error: inferenceUnavailableMessage('unconfigured'),
    unavailable: inferenceUnavailableStatus('unconfigured'),
  };
}
