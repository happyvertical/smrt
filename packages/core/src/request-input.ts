/**
 * Update input for a registered model: the one place every request-facing
 * update path assigns a body onto a loaded object.
 *
 * Runtime REST, the generated SvelteKit routes, the in-process and both
 * emitted MCP servers, sync apply, the CLI and the assistant tool loop each
 * strip the keys their own policy ignores (server-managed fields, read-only
 * fields, an `api.writable` allowlist) and then call
 * {@link applyUpdateInput}. What is left may set a declared field or a
 * settable accessor and nothing else; see `write-input.ts` for the rule.
 */

import { ObjectRegistry } from './registry';
import type { SmrtObjectConstructor } from './registry/types';
import {
  assignUpdateInput,
  resolveUpdateInput,
  type UpdateInputRules,
} from './write-input';

/**
 * Registry key of the model an instance belongs to.
 *
 * Read from the instance's prototype, never from its `constructor` property:
 * the class an object was built by is not something a property write changes.
 * An STI row loaded through its base collection is its own subtype, so the
 * subtype's fields are the ones it may set.
 */
export function modelOfInstance(instance: object): string | undefined {
  const prototype = Object.getPrototypeOf(instance) as {
    constructor?: unknown;
  } | null;
  const ctor =
    prototype && Object.hasOwn(prototype, 'constructor')
      ? prototype.constructor
      : undefined;
  if (typeof ctor !== 'function') return undefined;
  const registered = ObjectRegistry.getEffectiveClassByConstructor(
    ctor as SmrtObjectConstructor,
  );
  return registered ? registered.qualifiedName || registered.name : undefined;
}

function hasFieldMetadata(model: string): boolean {
  const registered = ObjectRegistry.getClass(model);
  if (!registered) return false;
  if ((registered.inheritedFields?.size ?? 0) > 0) return true;
  if (registered.fields.size > 0) return true;
  return ObjectRegistry.getInheritanceChain(
    registered.qualifiedName ?? registered.name,
  ).some((ancestor) => ObjectRegistry.getFields(ancestor).size > 0);
}

/**
 * The update rules of a model.
 *
 * @param instance - The loaded object the body will be assigned onto
 * @param model - Registry key to fall back to when the instance's own class is
 *   not registered (a structural row, a test double)
 */
export function updateInputRulesFor(
  instance: object,
  model?: string,
): UpdateInputRules {
  const name = modelOfInstance(instance) ?? model;
  if (!name) return { declaresField: () => false, hasFieldMetadata: false };

  let writeThrough: Record<string, unknown> | undefined;
  const declaresField = (key: string): boolean => {
    if (ObjectRegistry.declaresField(name, key)) return true;
    // Write-through fields are declared on the model's config, not as columns.
    writeThrough ??= ObjectRegistry.getWriteThroughFields(name);
    return Object.hasOwn(writeThrough, key);
  };
  const config = ObjectRegistry.getConfig(name);
  const projectsDisplayLabel = typeof config.display?.label === 'object';
  // The write policy of the object's own class. A route filters the body by
  // the policy of the model it serves; an STI row loaded through its base
  // route is its own subtype, whose read-only fields and `api.writable`
  // allowlist hold too. Keys either policy withholds are left out, the way
  // each route's own policy leaves them out.
  const apiConfig = config.api;
  const writable =
    apiConfig &&
    typeof apiConfig === 'object' &&
    Array.isArray((apiConfig as { writable?: unknown }).writable)
      ? ((apiConfig as { writable: unknown[] }).writable as string[])
      : undefined;
  let readonly: Set<string> | undefined;
  const isReadonly = (key: string): boolean => {
    if (!readonly) {
      readonly = new Set();
      for (const [field, def] of ObjectRegistry.getFields(name)) {
        if (def && (def.readonly === true || def._meta?.readonly === true))
          readonly.add(field);
      }
    }
    return readonly.has(key);
  };

  return {
    declaresField,
    hasFieldMetadata: hasFieldMetadata(name),
    isEmittedOnly: (key) =>
      (projectsDisplayLabel && key === 'displayLabel') ||
      isReadonly(key) ||
      (writable !== undefined && !writable.includes(key)),
  };
}

/**
 * Refuse an update body that names anything but a declared field or a
 * settable accessor of the object, without changing the object.
 *
 * @throws {WriteInputError} a typed 400 naming the first refused key
 */
export function assertUpdateInput(
  instance: object,
  data: Record<string, unknown>,
  model?: string,
): void {
  resolveUpdateInput(instance, data, updateInputRulesFor(instance, model));
}

/**
 * Assign an update body onto a loaded object: declared fields and settable
 * accessors only. Every key is checked before the first is assigned.
 *
 * Call it where an update used to `Object.assign(instance, body)`.
 *
 * @param instance - The loaded object
 * @param data - The body, after the caller's own policy removed the keys it
 *   ignores
 * @param model - Registry key of the route's model, used when the instance's
 *   class is not registered
 * @throws {WriteInputError} a typed 400 naming the first refused key
 */
export function applyUpdateInput(
  instance: object,
  data: Record<string, unknown>,
  model?: string,
): void {
  assignUpdateInput(instance, data, updateInputRulesFor(instance, model));
}

/**
 * Refuse create input that names anything but a declared field or settable
 * accessor of `model`, before the object is constructed.
 *
 * A constructor that copies its options onto the instance would otherwise
 * install any request key as an own property, shadowing a method or a
 * serialiser. Request-facing create paths call this after their writable
 * policy and the create-target selector removed the keys they ignore. A model
 * nothing is registered about (no field metadata) is not checked.
 *
 * @param model - Registry key of the model being created
 * @param data - The create input
 * @param collection - The collection that will construct the object, when
 *   known; its item class is the authority over its fields
 * @throws {WriteInputError} a typed 400 naming the first refused key
 */
export function assertCreateInput(
  model: string,
  data: Record<string, unknown>,
  collection?: unknown,
): void {
  // The class the collection constructs decides when it is known: it is the
  // class whose constructor receives the input.
  const itemClass = itemClassOf(collection);
  const registered =
    (itemClass
      ? ObjectRegistry.getEffectiveClassByConstructor(itemClass)
      : undefined) ?? ObjectRegistry.getClass(model);
  const ctor = (itemClass ?? registered?.constructor) as
    | { prototype?: object }
    | undefined;
  if (!registered || !ctor?.prototype) return;
  const name = registered.qualifiedName || registered.name;
  if (!hasFieldMetadata(name)) return;
  const blank = Object.create(ctor.prototype) as object;
  resolveUpdateInput(blank, data, updateInputRulesFor(blank, name));
}

/** The item class a collection constructs, read from its `_itemClass`. */
function itemClassOf(collection: unknown): SmrtObjectConstructor | undefined {
  if (!collection || typeof collection !== 'object') return undefined;
  const own = (collection as { _itemClass?: unknown })._itemClass;
  const fromClass = (
    (collection as { constructor?: { _itemClass?: unknown } }).constructor ?? {}
  )._itemClass;
  const candidate = own ?? fromClass;
  return typeof candidate === 'function'
    ? (candidate as SmrtObjectConstructor)
    : undefined;
}
