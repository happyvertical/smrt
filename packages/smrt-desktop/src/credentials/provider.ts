import { DesktopContractError } from '../errors.js';
import { isLoopbackOrigin } from '../internal/grammar.js';
import {
  type AcquireCredentialRequest,
  type CredentialLease,
  parseAcquireCredentialResponse,
} from './control-handler.js';
import { isInstanceNonce } from './grammar.js';

export type { CredentialLease } from './control-handler.js';

export interface AcquireOptions {
  /** `instanceNonce` the rendezvous proved over the control channel. */
  readonly instanceNonce: string;
  /** Origin the rendezvous reported for that same instance. */
  readonly origin: string;
  readonly signal?: AbortSignal;
}

/**
 * Launcher-facing source of the bearer. `acquire` either returns a lease bound
 * to the requested origin or throws a `DesktopContractError` whose `code` is
 * `credential_unavailable`, `credential_invalid` or `instance_mismatch`.
 */
export interface CredentialProvider {
  acquire(request: AcquireOptions): Promise<CredentialLease>;
}

/**
 * Sends one `acquire-credential` request over the owner-only control channel
 * and resolves with the decoded reply (a parsed object or one JSON line). The
 * rendezvous transport implements it; this module imports nothing from it.
 * Honor `signal`: it fires on timeout and on caller abort.
 */
export type SendAcquireRequest = (
  request: AcquireCredentialRequest,
  options: { readonly signal: AbortSignal },
) => Promise<unknown>;

export interface ControlChannelCredentialProviderOptions {
  readonly send: SendAcquireRequest;
  /** Defaults to 2000 ms, the control protocol's response budget. */
  readonly timeoutMs?: number;
  /** Clock, milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Provider over an injected `send`. It validates the request before sending
 * (so a malformed nonce or origin never reaches the channel), validates the
 * reply strictly, insists the reply echoes the requested `instanceNonce` (the
 * reply is bound to the instance `status` proved; a mismatch is
 * `instance_mismatch`) and the requested origin (the bearer is only ever bound
 * to the origin the caller proved), and refuses an already-expired bearer. A transport failure, timeout or malformed reply is
 * `credential_unavailable`; the underlying error is dropped, never chained.
 */
export function createControlChannelCredentialProvider(
  options: ControlChannelCredentialProviderOptions,
): CredentialProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.now ?? Date.now;

  return {
    async acquire(request) {
      if (
        !isInstanceNonce(request?.instanceNonce) ||
        !isLoopbackOrigin(request.origin)
      ) {
        throw new DesktopContractError('instance_mismatch');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      if (request.signal?.aborted) controller.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });

      let reply: unknown;
      try {
        if (controller.signal.aborted) throw new Error('aborted');
        reply = await Promise.race([
          options.send(
            {
              v: 1,
              op: 'acquire-credential',
              instanceNonce: request.instanceNonce,
              origin: request.origin,
            },
            { signal: controller.signal },
          ),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
        ]);
      } catch {
        throw new DesktopContractError('credential_unavailable');
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      }

      const result = parseAcquireCredentialResponse(reply);
      if (!result.ok) throw new DesktopContractError(result.code);
      const { lease } = result;
      // The reply must come from the instance `status` proved, not merely
      // from whatever answered on the vetted endpoint.
      if (result.instanceNonce !== request.instanceNonce) {
        throw new DesktopContractError('instance_mismatch');
      }
      if (lease.origin !== request.origin) {
        throw new DesktopContractError('instance_mismatch');
      }
      if (Date.parse(lease.expiresAt) <= clock()) {
        throw new DesktopContractError('credential_invalid');
      }
      return lease;
    },
  };
}
