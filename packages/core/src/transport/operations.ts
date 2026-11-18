/**
 * Transport kernel: the pipeline (#5158). Owned by K7.
 *
 * The only place generated transports reach collection read and write
 * methods.
 */
import { notImplemented } from './not-implemented.js';
import type {
  CrudOperation,
  OperationContext,
  OperationInput,
  OperationResult,
  Principal,
  TransportBinding,
} from './types.js';

/**
 * Run one generated operation for one caller.
 *
 * Contract. The order is fixed and the same on every surface:
 * 1. Resolve the model (`resolveTransportModel`).
 * 2. Check exposure and that the operation is enabled for the surface.
 * 3. Authorise (`authorizeOperation`).
 * 4. Validate input (`filterWriteInput` or `parseListQuery`).
 * 5. Enter the tenant gate (`runInTenantGate`); everything below runs inside.
 * 6. For a create, resolve the STI target and authorise again against it.
 * 7. Call the collection, obtained from `binding.getCollection` now and not
 *    before.
 * 8. Project the result (`toPublic`), custom serialisers included.
 *
 * Nothing is read from storage before step 3 passes, and nothing is written
 * before step 4 passes. Failures propagate as thrown errors; the adapter
 * renders them with `toTransportError`. A missing row is a `NOT_FOUND` error,
 * not a result.
 */
export function executeOperation<Op extends CrudOperation>(
  _binding: TransportBinding,
  _principal: Principal,
  _operation: Op,
  _input: OperationInput<Op>,
  _context?: OperationContext,
): Promise<OperationResult> {
  return notImplemented('executeOperation', 'K7');
}
