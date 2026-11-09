import type { ControlRequest } from '../rendezvous/control-protocol.js';
import {
  type ControlHandlerRegistry,
  createControlHandlerRegistry,
} from '../rendezvous/control-transport.js';
import type { ReferenceSupervisor } from '../rendezvous/reference-shell.js';
import type {
  CredentialControlRequest,
  CredentialControlResponse,
} from './control-channel.js';
import {
  type AcquireCredentialHandler,
  type ControlContext,
  type CredentialControlHandlerOptions,
  createCredentialControlHandler,
} from './control-handler.js';

/**
 * Reference-server wiring for `acquire-credential`, exported only from
 * `@happyvertical/smrt-desktop/testing`. The production server is the Rust
 * shell; nothing here is reachable from the package root.
 */

/**
 * Register `acquire-credential` in a handler registry that uses
 * `credentialControlCodec`. `handler` is the reference handler from
 * `createCredentialControlHandler` (it decides from its own `current()`, which
 * must be the serving instance's identity). Its `{ ok: false, code }` result
 * becomes a protocol error response; a success becomes the lease body.
 *
 * @experimental
 */
export function registerAcquireCredential(
  registry: ControlHandlerRegistry<
    CredentialControlRequest,
    CredentialControlResponse
  >,
  handler: AcquireCredentialHandler,
): typeof registry {
  return registry.register('acquire-credential', async (request) => {
    const result = await handler(request);
    return result.ok
      ? {
          v: 1,
          ok: true,
          instanceNonce: result.instanceNonce,
          lease: result.lease,
        }
      : { v: 1, ok: false, code: result.code };
  });
}

/**
 * The `{ instanceNonce, origin }` of the instance a reference supervisor
 * represents, or `null` unless it is `ready`. Feed it to the handler as
 * `current` so the nonce and origin it checks are the serving instance's own,
 * never anything the request supplies.
 *
 * @experimental
 */
export function referenceControlContext(
  supervisor: ReferenceSupervisor,
): () => ControlContext | null {
  return () => {
    const snapshot = supervisor.snapshot();
    if (snapshot.state !== 'ready' || snapshot.origin === undefined) {
      return null;
    }
    return {
      instanceNonce: supervisor.instanceNonce,
      origin: snapshot.origin,
    };
  };
}

/** @experimental */
export type ReferenceCredentialRegistryOptions = Omit<
  CredentialControlHandlerOptions,
  'current'
>;

/**
 * Handler registry for a reference shell that serves the core ops and
 * `acquire-credential`. Pass it, with `credentialControlCodec`, to
 * `startReferenceShell`.
 *
 * @experimental
 */
export function createCredentialReferenceRegistry(
  supervisor: ReferenceSupervisor,
  options: ReferenceCredentialRegistryOptions,
): ControlHandlerRegistry<CredentialControlRequest, CredentialControlResponse> {
  const registry = createControlHandlerRegistry<
    CredentialControlRequest,
    CredentialControlResponse
  >();
  registry.register('status', (request) =>
    supervisor.respond(request as Extract<ControlRequest, { op: 'status' }>),
  );
  registry.register('ensure-ready', (request, context) =>
    supervisor.respond(
      request as Extract<ControlRequest, { op: 'ensure-ready' }>,
      context.signal,
    ),
  );
  return registerAcquireCredential(
    registry,
    createCredentialControlHandler({
      ...options,
      current: referenceControlContext(supervisor),
    }),
  );
}
