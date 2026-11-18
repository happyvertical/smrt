/**
 * Transport kernel: authorisation (#5158). Owned by K2; per-operation
 * authorisation is switched on here by F6 and nowhere else.
 */
import { notImplemented } from './not-implemented.js';
import type {
  AuthorizeHook,
  CrudOperation,
  CustomActionOperation,
  OperationDescriptor,
  Principal,
  TransportModel,
} from './types.js';

/**
 * Describe one call for authorisation.
 *
 * Contract:
 * - `model` is the qualified name; `permission` is
 *   `<permissionCollection>.<action>`, where list, get and count share `read`
 *   and a custom action uses its `operationPermissions` alias when declared.
 * - `mutating` is true for create, update and delete. A custom action is
 *   mutating unless it is served by a safe HTTP method.
 * - A malformed `operationPermissions` declaration throws; it never widens.
 */
export function describeOperation(
  _model: TransportModel,
  _operation: CrudOperation | CustomActionOperation,
  _options?: { readonly httpMethod?: string },
): OperationDescriptor {
  return notImplemented('describeOperation', 'K2');
}

/**
 * Decide whether the caller may perform the operation; resolve or throw.
 *
 * Contract, in order:
 * 1. The model is exposed on the surface (`isRuntimeModelEnabled`), else
 *    `NOT_FOUND`.
 * 2. The operation is enabled for the surface by the model's config, else
 *    `OPERATION_NOT_ALLOWED`.
 * 3. An anonymous caller passes only where `api.public` covers the operation,
 *    else `AUTH_REQUIRED`.
 * 4. The caller holds `operation.permission`, or its permissions are `'all'`,
 *    else `PERMISSION_DENIED`.
 * 5. The host `hook`, when given, is awaited last and may refuse.
 *
 * Fails closed: a missing permission snapshot denies. The order is fixed, so
 * the answer for a model that is not exposed is the same whoever asks. While `model.profile.authorization` is present, the checks and their
 * order are that transport's.
 */
export function authorizeOperation(
  _model: TransportModel,
  _operation: OperationDescriptor,
  _principal: Principal,
  _hook?: AuthorizeHook,
): Promise<void> {
  return notImplemented('authorizeOperation', 'K2');
}
