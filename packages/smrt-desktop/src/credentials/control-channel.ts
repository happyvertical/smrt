import { DesktopContractError } from '../errors.js';
import { isLoopbackOrigin } from '../internal/grammar.js';
import { hasClosedKeys } from '../internal/strict-json.js';
import {
  CORE_CONTROL_ERROR_CODES,
  CORE_CONTROL_OPS,
  type ControlCodec,
  type ControlOpSpec,
  type ControlRequest,
  type ControlResponse,
  createControlCodec,
} from '../rendezvous/control-protocol.js';
import { sendControlRequest } from '../rendezvous/control-transport.js';
import {
  resolveVettedEndpoint,
  type VettedEndpoint,
} from '../rendezvous/vetted-endpoint.js';
import {
  type AcquireCredentialRequest,
  type CredentialLease,
  encodeAcquireCredentialResponse,
  parseAcquireCredentialResponse,
} from './control-handler.js';
import { isInstanceNonce } from './grammar.js';
import type { SendAcquireRequest } from './provider.js';

/**
 * The `acquire-credential` operation on contract (b)'s control channel.
 *
 * Contract (b) ships `coreControlCodec` (`status`, `ensure-ready`) and leaves
 * ops open; this module is the credential contract's extension. It adds one
 * op and three error codes and leaves the core codec untouched, so a plain
 * rendezvous client or server never learns the op and answers it
 * `unsupported_op`.
 *
 * The bearer crosses the wire in exactly one place: the `ok: true` body of
 * `acquire-credential`. In memory it is a `SecretString` inside
 * `lease`; `encodeAcquireCredentialResponse` and
 * `parseAcquireCredentialResponse` (the credential module's own functions) do
 * the only reveal and the only wrap. No rendezvous type carries it.
 */

/** Success body of `acquire-credential`: the lease, bearer wrapped. */
export interface AcquireCredentialSuccess {
  readonly v: 1;
  readonly ok: true;
  /** The instance that answered; the provider checks it against `status`. */
  readonly instanceNonce: string;
  readonly lease: CredentialLease;
}

/** Every request the extended channel carries. */
export type CredentialControlRequest =
  | ControlRequest
  | AcquireCredentialRequest;
/** Every response the extended channel carries. */
export type CredentialControlResponse =
  | ControlResponse
  | AcquireCredentialSuccess;

export type CredentialControlCodec = ControlCodec<
  CredentialControlRequest,
  CredentialControlResponse
>;

/** Failure codes `acquire-credential` adds to the core error-code list. */
export const CREDENTIAL_CONTROL_ERROR_CODES = [
  'credential_unavailable',
  'credential_invalid',
  'instance_mismatch',
] as const;

function invalidMessage(field?: string): DesktopContractError {
  return new DesktopContractError(
    'invalid_control_message',
    field === undefined ? {} : { field },
  );
}

/**
 * The op spec. The request is closed to `v`, `op`, `instanceNonce` and
 * `origin`; the response is whatever `parseAcquireCredentialResponse` accepts
 * for a success body (its failures are value-free `credential_unavailable`).
 */
export const credentialControlOp: ControlOpSpec<
  AcquireCredentialRequest,
  AcquireCredentialSuccess
> = {
  op: 'acquire-credential',
  parseRequest(fields) {
    if (!hasClosedKeys(fields, ['v', 'op', 'instanceNonce', 'origin'])) {
      throw invalidMessage();
    }
    if (!isInstanceNonce(fields.instanceNonce)) {
      throw invalidMessage('instanceNonce');
    }
    if (!isLoopbackOrigin(fields.origin)) throw invalidMessage('origin');
    return {
      v: 1,
      op: 'acquire-credential',
      instanceNonce: fields.instanceNonce,
      origin: fields.origin,
    };
  },
  parseResponse(fields) {
    const result = parseAcquireCredentialResponse(fields);
    if (!result.ok) throw invalidMessage();
    return Object.freeze({
      v: 1,
      ok: true,
      instanceNonce: result.instanceNonce,
      lease: result.lease,
    });
  },
};

const baseCodec = createControlCodec<
  CredentialControlRequest,
  CredentialControlResponse
>(
  [...CORE_CONTROL_OPS, credentialControlOp] as readonly ControlOpSpec<
    CredentialControlRequest,
    CredentialControlResponse
  >[],
  [...CORE_CONTROL_ERROR_CODES, ...CREDENTIAL_CONTROL_ERROR_CODES],
);

function isAcquireSuccess(
  response: CredentialControlResponse,
): response is AcquireCredentialSuccess {
  return (
    response.ok === true &&
    typeof response === 'object' &&
    'lease' in response &&
    response.lease !== undefined
  );
}

/**
 * The codec for `status`, `ensure-ready` and `acquire-credential`.
 *
 * `JSON.stringify` of a `SecretString` is `"[REDACTED]"`, so the generic
 * encoder cannot serialize the success body; this codec routes it through
 * `encodeAcquireCredentialResponse` and validates the line it produced with
 * the same strict parser a client would use (size cap included).
 */
export const credentialControlCodec: CredentialControlCodec = {
  ops: baseCodec.ops,
  errorCodes: baseCodec.errorCodes,
  parseRequest: baseCodec.parseRequest,
  parseResponse: baseCodec.parseResponse,
  encodeRequest: baseCodec.encodeRequest,
  encodeResponse(response) {
    if (!isAcquireSuccess(response)) return baseCodec.encodeResponse(response);
    const line = encodeAcquireCredentialResponse({
      ok: true,
      instanceNonce: response.instanceNonce,
      lease: response.lease,
    });
    baseCodec.parseResponse('acquire-credential', line);
    return `${line}\n`;
  },
};

export interface ControlChannelSendOptions {
  /** Response budget in milliseconds. Defaults to 2000. */
  readonly timeoutMs?: number;
  /** Connect budget in milliseconds. Defaults to the transport's 1000. */
  readonly connectTimeoutMs?: number;
}

/**
 * A `SendAcquireRequest` over the rendezvous control transport, for
 * `createControlChannelCredentialProvider({ send })`.
 *
 * `endpoint` is the `endpoint` of a `ready` rendezvous result: the handle only
 * `createFileRendezvous` can mint, after its custody checks. Nothing else is
 * accepted (a raw `ControlEndpoint`, a look-alike object, a missing handle),
 * so the credential flow cannot be pointed at an endpoint nobody vetted. On
 * Windows a `ready` result has a handle only if the shell supplied `vetPipe`.
 * Throws `invalid_endpoint` for anything else.
 */
export function createControlChannelSend(
  endpoint: VettedEndpoint,
  options: ControlChannelSendOptions = {},
): SendAcquireRequest {
  const target = resolveVettedEndpoint(endpoint);
  return (request, { signal }) =>
    sendControlRequest<CredentialControlRequest, CredentialControlResponse>(
      target,
      request,
      {
        timeoutMs: options.timeoutMs ?? 2000,
        ...(options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: options.connectTimeoutMs }),
        signal,
        codec: credentialControlCodec,
      },
    );
}
