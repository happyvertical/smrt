/**
 * Which subtype a create through a base model may select.
 *
 * A model of a shared table (STI) is created through its base with
 * `createType` (or `_meta_type`). The base's surface decides whether the base
 * accepts creates; the selected subtype has a surface of its own, and it
 * decides too. A subtype closed on a transport (`api: false`, `mcp: false`, an
 * `include` list without `create`, or an abstract class) is not a create
 * target there, whoever may create the base.
 *
 * `ObjectRegistry.resolveCreateTarget()` validates the selector against the
 * family and the runtime exposure gate; it does not read the subtype's
 * surface. Every transport therefore calls {@link assertCreateTargetSurface}
 * on what it returns, and the MCP schema offers only the subtypes
 * {@link isCreateOpenOnSurface} admits.
 */

import { ValidationError } from './errors';
import { ObjectRegistry } from './registry';
import { surfaceOpensOperation } from './registry/subclass-exposure';

/** Transports with a per-model surface config that gates `create`. */
export type CreateSurface = 'api' | 'mcp' | 'cli';

/**
 * A create selector that names a subtype this transport does not create.
 *
 * Carries `status` / `publicMessage` so it is rendered as a typed 400 with
 * the registry's own text for a selector outside the family.
 */
export class CreateTargetError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(selector: string, base: string) {
    const message = `Unknown STI discriminator: ${selector} is not a subtype of '${base}' or is unavailable`;
    super(message, 'CREATE_TARGET_UNAVAILABLE', { selector, base });
    this.name = 'CreateTargetError';
    this.publicMessage = message;
  }
}

/** Whether `model`'s own surface config opens `create` on a transport. */
export function isCreateOpenOnSurface(
  model: string,
  surface: CreateSurface,
): boolean {
  const config = ObjectRegistry.getConfig(model);
  if (config.abstract) return false;
  return surfaceOpensOperation(surface, config[surface], 'create');
}

/**
 * Refuse a create that selects a subtype whose own surface does not open
 * `create` on this transport.
 *
 * @param base - Registry key of the model the request was sent to
 * @param target - What `ObjectRegistry.resolveCreateTarget()` returned
 * @param surface - The transport's surface config key
 * @throws {CreateTargetError} a typed 400
 */
export function assertCreateTargetSurface(
  base: string,
  target: { name: string; collectionName: string },
  surface: CreateSurface,
): void {
  // The base itself was gated by the transport before it resolved a target;
  // the registry returns the caller's own base key for it.
  if (target.collectionName === base) return;
  if (!isCreateOpenOnSurface(target.name, surface)) {
    throw new CreateTargetError(target.name, base);
  }
}

/** An operation a transport performs on rows a base model's table holds. */
export type FamilyRowOperation = 'list' | 'get' | 'update' | 'delete';

/**
 * Which models of a shared table (STI) a transport serves rows of through
 * `model`'s route, for one operation.
 *
 * A base's table holds the rows of every subtype. A subtype has a surface of
 * its own: a row whose type closes the operation on this transport (or, on a
 * server given an explicit model list, a type not on it) is not served through
 * the base either. Returns `undefined` when every member of the family is
 * served (no restriction is needed), or the registry keys of the served
 * types, `model` itself included.
 *
 * @param model - Registry key of the model the request was sent to
 * @param surface - The transport's surface config key
 * @param operation - The operation performed on the rows
 * @param served - Registry keys of the models a server was given, if any
 * @param admits - The request's own admission of a member (the caller may
 *   read it, it is switched on for the request's tenant), if any
 */
export function servedFamilyTypes(
  model: string,
  surface: CreateSurface,
  operation: FamilyRowOperation,
  served?: ReadonlySet<string>,
  admits?: (key: string) => boolean,
): string[] | undefined {
  if (ObjectRegistry.getTableStrategy(model) !== 'sti') return undefined;
  const members = ObjectRegistry.getDescendants(model);
  if (members.length === 0) return undefined;
  const allowed = [model];
  for (const member of members) {
    const info = ObjectRegistry.getClass(member);
    const key = info ? info.qualifiedName || info.name : member;
    if (served && !served.has(key)) continue;
    if (admits && !admits(key)) continue;
    if (
      !surfaceOpensOperation(
        surface,
        ObjectRegistry.getConfig(key)[surface],
        operation,
      )
    ) {
      continue;
    }
    allowed.push(key);
  }
  return allowed.length === members.length + 1 ? undefined : allowed;
}

/**
 * The registry keys of the STI descendants of `model` a transport could
 * serve rows of through `model`'s route for at least one of `operations`: on
 * the server's model list (when it has one) and with the operation open on
 * `surface`. A transport asks its host about these members only (exposure,
 * authorization), never about a member it could not serve anyway.
 */
export function familyMembersInScope(
  model: string,
  surface: CreateSurface,
  operations: readonly FamilyRowOperation[],
  served?: ReadonlySet<string>,
): string[] {
  if (ObjectRegistry.getTableStrategy(model) !== 'sti') return [];
  const keys: string[] = [];
  for (const member of ObjectRegistry.getDescendants(model)) {
    const info = ObjectRegistry.getClass(member);
    const key = info ? info.qualifiedName || info.name : member;
    if (served && !served.has(key)) continue;
    const config = ObjectRegistry.getConfig(key)[surface];
    if (
      !operations.some((operation) =>
        surfaceOpensOperation(surface, config, operation),
      )
    ) {
      continue;
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Whether a row of type `rowModel` is served through `model`'s route for
 * `operation`: `model` itself, or a member {@link servedFamilyTypes} admits.
 */
export function isFamilyRowServed(
  model: string,
  rowModel: string,
  surface: CreateSurface,
  operation: FamilyRowOperation,
  served?: ReadonlySet<string>,
  admits?: (key: string) => boolean,
): boolean {
  if (rowModel === model) return true;
  const allowed = servedFamilyTypes(model, surface, operation, served, admits);
  return !allowed || allowed.includes(rowModel);
}
