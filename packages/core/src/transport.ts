/**
 * `@happyvertical/smrt-core/transport`: the transport kernel (#5158).
 *
 * Server-only. Not re-exported from the package root or the browser entry.
 * See `agents/transport-kernel.md`.
 */
export {
  authorizeOperation,
  describeOperation,
} from './transport/authorize.js';
export { toTransportError } from './transport/errors.js';
export { createHttpHandlers, readJsonBody } from './transport/http.js';
export {
  applyWriteInput,
  filterWriteInput,
  resolveWritableFields,
} from './transport/input.js';
export {
  createMcpToolRuntime,
  validateToolArguments,
} from './transport/mcp.js';
export {
  resolveCollectionSegment,
  resolveTransportModel,
} from './transport/model.js';
export {
  notImplemented,
  TransportNotImplementedError,
} from './transport/not-implemented.js';
export { executeOperation } from './transport/operations.js';
export {
  type PrincipalContextSource,
  principalFromContext,
  principalFromEnv,
  principalFromLocals,
} from './transport/principal.js';
export * from './transport/profile.js';
export { toPublic } from './transport/project.js';
export { parseListQuery } from './transport/query.js';
export { createSyncApplyHost } from './transport/sync.js';
export { runInTenantGate } from './transport/tenant.js';
export * from './transport/types.js';
