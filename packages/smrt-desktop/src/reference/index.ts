/**
 * `@happyvertical/smrt-desktop/testing`: reference servers and test doubles.
 *
 * Node-only, and not for production. The production control server, the
 * `instance.json` writer and the keychain custody are the Rust shell's. What
 * is here exists so a launcher (or another contract's tests) can talk to
 * something real:
 *
 * - `startReferenceShell` / `serveControlChannelForTests`: a control server
 *   over a unix socket that publishes `instance.json`. It performs no
 *   peer-credential check, holds no single-instance lock and, on Windows,
 *   only listens (no pipe DACL, no first-instance flag), so it refuses to
 *   start there unless `insecureForTests: true` is passed.
 * - `createReferenceSupervisor` / `createReferenceRegistry`: the supervisor
 *   state machine and handler registry such a server answers from.
 * - `createCredentialControlHandler` and friends: the reference
 *   `acquire-credential` handler the Rust shell mirrors.
 * - `createMemorySecretItemStore`: an in-process `SecretItemStore`. It is not
 *   an OS keychain and offers none of its protection.
 * - the low-level control codec, transport and endpoint derivation these are
 *   built from (`createControlCodec`, `sendControlRequest`,
 *   `deriveControlEndpoint`, ...). `sendControlRequest` connects to whatever
 *   endpoint it is given and vets nothing: a launcher goes through
 *   `createFileRendezvous`, whose `ready` result carries the vetted handle.
 *
 * @experimental Contracts (b) and (c) are experimental; see the README.
 */

export type {
  AcquireCredentialHandler,
  ControlContext,
  CredentialControlHandlerOptions,
} from '../credentials/control-handler.js';
export {
  createCredentialControlHandler,
  encodeAcquireCredentialResponse,
} from '../credentials/control-handler.js';
export { createMemorySecretItemStore } from '../credentials/custody.js';
export type { ReferenceCredentialRegistryOptions } from '../credentials/reference.js';
export {
  createCredentialReferenceRegistry,
  referenceControlContext,
  registerAcquireCredential,
} from '../credentials/reference.js';
export type {
  ControlErrorResponse,
  CoreControlRequest,
  CoreControlResponse,
  EnsureReadyRequest,
  InstanceStateResponse,
  StatusRequest,
} from '../rendezvous/control-protocol.js';
export {
  CORE_CONTROL_OPS,
  controlErrorCodeFor,
  createControlCodec,
  ENSURE_READY_OP,
  encodeControlRequest,
  encodeControlResponse,
  parseControlRequest,
  parseControlResponse,
  parseInstanceStateResponse,
  STATUS_OP,
} from '../rendezvous/control-protocol.js';
export type {
  ControlHandler,
  ControlHandlerRegistry,
  ControlRequestContext,
  ControlServer,
  SendControlRequestOptions,
  ServeControlChannelForTestsOptions,
} from '../rendezvous/control-transport.js';
export {
  createControlHandlerRegistry,
  sendControlRequest,
  serveControlChannelForTests,
} from '../rendezvous/control-transport.js';
export type { DeriveControlEndpointOptions } from '../rendezvous/endpoint.js';
export {
  controlSocketDirectory,
  deriveControlEndpoint,
} from '../rendezvous/endpoint.js';
export { failureCodeFromSupervisorMessage } from '../rendezvous/failure-code.js';
export { shellLaunchEnvironment } from '../rendezvous/file-rendezvous.js';
export type {
  ReferenceShell,
  ReferenceShellOptions,
  ReferenceSnapshot,
  ReferenceSupervisor,
  ReferenceSupervisorOptions,
} from '../rendezvous/reference-shell.js';
export {
  createReferenceRegistry,
  createReferenceSupervisor,
  startReferenceShell,
} from '../rendezvous/reference-shell.js';
