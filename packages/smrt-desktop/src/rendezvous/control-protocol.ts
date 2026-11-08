import { DesktopContractError } from '../errors.js';
import { deepFreeze } from '../internal/freeze.js';
import { isLoopbackOrigin, isSlug } from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { isShellFailureCode, type ShellFailureCode } from './failure-code.js';
import { isInstanceNonce } from './instance-record.js';

/**
 * Control protocol v1: one UTF-8 JSON object per line (`\n`-terminated), at
 * most 4096 bytes excluding the terminator, strict closed schema, duplicate
 * keys rejected, one request per connection (the server closes after its
 * response).
 *
 * This contract defines two operations, `status` and `ensure-ready`. The
 * credential handoff adds `acquire-credential` at integration without changing
 * this file's core: ops are data (`ControlOpSpec`), a codec is built from a
 * list of specs (`createControlCodec`), and the request/response unions widen
 * through the codec's type parameters.
 */

export const CONTROL_PROTOCOL_VERSION = 1;
/** Size cap of one message, excluding the terminating newline. */
export const MAX_CONTROL_MESSAGE_BYTES = 4096;
/** Upper bound of the `ensure-ready` wait, ten minutes. */
export const MAX_ENSURE_READY_TIMEOUT_MS = 600_000;

export interface StatusRequest {
  readonly v: 1;
  readonly op: 'status';
}

export interface EnsureReadyRequest {
  readonly v: 1;
  readonly op: 'ensure-ready';
  /** How long the server may wait for `ready`/`failed` before answering. */
  readonly timeoutMs: number;
}

export type CoreControlRequest = StatusRequest | EnsureReadyRequest;

/** Today's request union. Widened at integration with further ops. */
export type ControlRequest = CoreControlRequest;

/**
 * Success body of `status` and `ensure-ready`. A `ready` answer carries the
 * origin; no answer ever carries a bearer or any secret.
 */
export type InstanceStateResponse =
  | {
      readonly v: 1;
      readonly ok: true;
      readonly state: 'ready';
      readonly instanceNonce: string;
      readonly productId: string;
      /** Exactly `http://127.0.0.1:<port>`. */
      readonly origin: string;
    }
  | {
      readonly v: 1;
      readonly ok: true;
      readonly state: 'starting';
      readonly instanceNonce: string;
      readonly productId: string;
    }
  | {
      readonly v: 1;
      readonly ok: true;
      readonly state: 'failed';
      readonly instanceNonce: string;
      readonly productId: string;
      readonly code: ShellFailureCode;
    };

/** Error codes of the core protocol. Other contracts may extend the list. */
export const CORE_CONTROL_ERROR_CODES = [
  'unsupported_version',
  'unsupported_op',
  'bad_request',
  'too_large',
  'forbidden',
  'internal',
] as const;
export type CoreControlErrorCode = (typeof CORE_CONTROL_ERROR_CODES)[number];

export interface ControlErrorResponse {
  readonly v: 1;
  readonly ok: false;
  /** A member of the codec's closed error-code list. */
  readonly code: string;
}

export type CoreControlResponse = InstanceStateResponse | ControlErrorResponse;
/** Today's response union. Widened at integration with further ops. */
export type ControlResponse = CoreControlResponse;

type Fields = Readonly<Record<string, unknown>>;

/**
 * One protocol operation. `parseRequest` receives the whole decoded object
 * (including `v` and `op`) and must enforce a closed key set; it returns a
 * fresh object in canonical key order. `parseResponse` does the same for the
 * `ok: true` answer to this op.
 */
export interface ControlOpSpec<Req extends object, Ok extends object> {
  readonly op: string;
  parseRequest(fields: Fields): Req;
  parseResponse(fields: Fields): Ok;
}

export interface ControlCodec<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> {
  readonly ops: readonly string[];
  readonly errorCodes: readonly string[];
  encodeRequest(request: Req): string;
  parseRequest(line: string): Req;
  encodeResponse(response: Res): string;
  /** Parse the answer to a request for `op`. */
  parseResponse(op: string, line: string): Res;
}

function invalidMessage(field?: string): DesktopContractError {
  return new DesktopContractError(
    'invalid_control_message',
    field === undefined ? {} : { field },
  );
}

/** Decode one framed line into an object with a valid `v`. */
function decodeLine(line: string): Fields {
  if (typeof line !== 'string') throw invalidMessage();
  const body = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
    throw new DesktopContractError('control_message_too_large');
  }
  if (body.includes('\n') || body.includes('\r')) throw invalidMessage();
  const parsed = parseStrictJson(body);
  if (!parsed.ok) {
    throw new DesktopContractError(
      parsed.reason === 'syntax' ? 'invalid_json' : 'duplicate_keys',
    );
  }
  if (!isRecord(parsed.value)) throw invalidMessage();
  if (!Object.hasOwn(parsed.value, 'v')) throw invalidMessage('v');
  if (parsed.value.v !== CONTROL_PROTOCOL_VERSION) {
    throw new DesktopContractError('unsupported_contract');
  }
  return parsed.value;
}

function parseOkField(fields: Fields): boolean {
  if (typeof fields.ok !== 'boolean') throw invalidMessage('ok');
  return fields.ok;
}

/** Build a codec from a list of operation specs and an error-code list. */
export function createControlCodec<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
>(
  specs: readonly ControlOpSpec<Req, Res>[],
  errorCodes: readonly string[] = CORE_CONTROL_ERROR_CODES,
): ControlCodec<Req, Res> {
  const byOp = new Map<string, ControlOpSpec<Req, Res>>();
  for (const spec of specs) {
    if (byOp.has(spec.op)) throw invalidMessage('op');
    byOp.set(spec.op, spec);
  }
  const codes = [...errorCodes];

  const parseRequest = (line: string): Req => {
    const fields = decodeLine(line);
    if (typeof fields.op !== 'string') throw invalidMessage('op');
    const spec = byOp.get(fields.op);
    if (spec === undefined) throw new DesktopContractError('unsupported_op');
    return deepFreeze(spec.parseRequest(fields));
  };

  const parseResponse = (op: string, line: string): Res => {
    const spec = byOp.get(op);
    if (spec === undefined) throw new DesktopContractError('unsupported_op');
    const fields = decodeLine(line);
    if (!parseOkField(fields)) {
      if (!hasClosedKeys(fields, ['v', 'ok', 'code'])) throw invalidMessage();
      if (typeof fields.code !== 'string' || !codes.includes(fields.code)) {
        throw invalidMessage('code');
      }
      return deepFreeze({
        v: 1,
        ok: false,
        code: fields.code,
      } as unknown as Res);
    }
    return deepFreeze(spec.parseResponse(fields));
  };

  return {
    ops: [...byOp.keys()],
    errorCodes: codes,
    parseRequest,
    parseResponse,
    encodeRequest(request) {
      const parsed = parseRequest(JSON.stringify(request));
      return `${JSON.stringify(parsed)}\n`;
    },
    encodeResponse(response) {
      // A response is validated against every spec; the matching one accepts.
      const text = JSON.stringify(response);
      let lastError: unknown = invalidMessage();
      for (const spec of byOp.values()) {
        try {
          const parsed = parseResponse(spec.op, text);
          return `${JSON.stringify(parsed)}\n`;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}

/** Map a codec failure to the protocol error code a server answers with. */
export function controlErrorCodeFor(error: unknown): CoreControlErrorCode {
  if (error instanceof DesktopContractError) {
    switch (error.code) {
      case 'unsupported_contract':
        return 'unsupported_version';
      case 'unsupported_op':
        return 'unsupported_op';
      case 'control_message_too_large':
        return 'too_large';
      default:
        return 'bad_request';
    }
  }
  return 'internal';
}

function timeoutField(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ENSURE_READY_TIMEOUT_MS
  ) {
    throw invalidMessage('timeoutMs');
  }
  return value;
}

/** Validate the `instanceNonce` and `productId` every state answer carries. */
function identityFields(fields: Fields): {
  instanceNonce: string;
  productId: string;
} {
  if (!isInstanceNonce(fields.instanceNonce)) {
    throw invalidMessage('instanceNonce');
  }
  if (!isSlug(fields.productId)) throw invalidMessage('productId');
  return { instanceNonce: fields.instanceNonce, productId: fields.productId };
}

/** Parse the `ok: true` body shared by `status` and `ensure-ready`. */
export function parseInstanceStateResponse(
  fields: Fields,
): InstanceStateResponse {
  const base = ['v', 'ok', 'state', 'instanceNonce', 'productId'];
  const { instanceNonce, productId } = identityFields(fields);
  switch (fields.state) {
    case 'ready':
      if (!hasClosedKeys(fields, [...base, 'origin'])) throw invalidMessage();
      if (!isLoopbackOrigin(fields.origin)) throw invalidMessage('origin');
      return {
        v: 1,
        ok: true,
        state: 'ready',
        instanceNonce,
        productId,
        origin: fields.origin,
      };
    case 'starting':
      if (!hasClosedKeys(fields, base)) throw invalidMessage();
      return { v: 1, ok: true, state: 'starting', instanceNonce, productId };
    case 'failed':
      if (!hasClosedKeys(fields, [...base, 'code'])) throw invalidMessage();
      if (!isShellFailureCode(fields.code)) throw invalidMessage('code');
      return {
        v: 1,
        ok: true,
        state: 'failed',
        instanceNonce,
        productId,
        code: fields.code,
      };
    default:
      throw invalidMessage('state');
  }
}

export const STATUS_OP: ControlOpSpec<StatusRequest, InstanceStateResponse> = {
  op: 'status',
  parseRequest(fields) {
    if (!hasClosedKeys(fields, ['v', 'op'])) throw invalidMessage();
    return { v: 1, op: 'status' };
  },
  parseResponse: parseInstanceStateResponse,
};

export const ENSURE_READY_OP: ControlOpSpec<
  EnsureReadyRequest,
  InstanceStateResponse
> = {
  op: 'ensure-ready',
  parseRequest(fields) {
    if (!hasClosedKeys(fields, ['v', 'op', 'timeoutMs'])) {
      throw invalidMessage();
    }
    return {
      v: 1,
      op: 'ensure-ready',
      timeoutMs: timeoutField(fields.timeoutMs),
    };
  },
  parseResponse: parseInstanceStateResponse,
};

/** The two operations this contract defines. */
export const CORE_CONTROL_OPS = [STATUS_OP, ENSURE_READY_OP] as const;

/** The codec for `status` and `ensure-ready`. */
export const coreControlCodec: ControlCodec = createControlCodec<
  CoreControlRequest,
  CoreControlResponse
>(CORE_CONTROL_OPS);

export const encodeControlRequest = (request: ControlRequest): string =>
  coreControlCodec.encodeRequest(request);
export const parseControlRequest = (line: string): ControlRequest =>
  coreControlCodec.parseRequest(line);
export const encodeControlResponse = (response: ControlResponse): string =>
  coreControlCodec.encodeResponse(response);
/** Parse the answer to a request for `op` (`status` or `ensure-ready`). */
export const parseControlResponse = (
  op: ControlRequest['op'],
  line: string,
): ControlResponse => coreControlCodec.parseResponse(op, line);
