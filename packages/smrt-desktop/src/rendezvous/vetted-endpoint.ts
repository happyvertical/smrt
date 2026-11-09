import { DesktopContractError } from '../errors.js';
import type { ControlEndpoint } from './endpoint.js';

declare const vettedBrand: unique symbol;

/**
 * An opaque handle to a control endpoint that `createFileRendezvous` vetted
 * (the private directory, the socket's type, owner and mode, and the live
 * instance answering with its recorded nonce).
 *
 * It is the only thing the credential flow accepts as an endpoint
 * (`createControlChannelSend`), so a launcher cannot reach the credential
 * channel without going through the custody checks, and cannot re-implement
 * them badly. It carries no path and no name: it serializes as `{}`, and the
 * endpoint behind it is recoverable only inside this package. A structurally
 * similar object is rejected at run time, not just by the type.
 *
 * A handle is a statement about the moment of the vetting. It does not make
 * the later connect atomic with the check (a same-user process can still swap
 * the socket in between), which is why the credential reply is also bound to
 * the instance: it must echo the `instanceNonce` that `status` proved.
 *
 * @experimental Part of contract (b); not stable until the Rust shell lands.
 */
export interface VettedEndpoint {
  readonly [vettedBrand]: true;
}

const issued = new WeakMap<object, ControlEndpoint>();

/** Mint a handle. Internal: only the vetting code in this package calls it. */
export function issueVettedEndpoint(endpoint: ControlEndpoint): VettedEndpoint {
  const handle = Object.freeze(Object.create(null)) as VettedEndpoint;
  issued.set(handle, Object.freeze({ ...endpoint }) as ControlEndpoint);
  return handle;
}

/**
 * The endpoint behind a handle this package issued. Internal. Throws
 * `invalid_endpoint` for anything else (a forged or structural look-alike).
 */
export function resolveVettedEndpoint(handle: unknown): ControlEndpoint {
  const endpoint =
    typeof handle === 'object' && handle !== null
      ? issued.get(handle)
      : undefined;
  if (endpoint === undefined)
    throw new DesktopContractError('invalid_endpoint');
  return endpoint;
}
