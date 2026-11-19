/**
 * Update input for a registered model: the one place every request-facing
 * update path assigns a body onto a loaded object.
 *
 * Runtime REST, the generated SvelteKit routes and both sync apply hosts
 * pass a write body through {@link prepareWriteInput}: server-managed keys and
 * service options are skipped, and a field the caller may not write
 * (read-only, outside `api.writable`, `_`-prefixed) is refused when the body
 * would change it. The in-process and both emitted MCP servers, the CLI and
 * the assistant tool loop still strip those fields with their own policy.
 * Every path then calls {@link applyUpdateInput}: what is left may set a
 * declared field or a settable accessor and nothing else; see
 * `write-input.ts` for the rule.
 */

import { ObjectRegistry } from './registry';
import type { SmrtObjectConstructor } from './registry/types';
import {
  assignUpdateInput,
  resolveUpdateInput,
  resolveWriteBody,
  sameStoredValue,
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

/** The field definitions of a model and its ancestors, nearest first. */
function fieldDefinitionsOf(
  name: string,
): Map<string, { type?: string; readonly?: boolean; _meta?: unknown }> {
  const fields = new Map<
    string,
    { type?: string; readonly?: boolean; _meta?: unknown }
  >();
  const registered = ObjectRegistry.getClass(name);
  const sources = [
    ObjectRegistry.getFields(name),
    registered?.inheritedFields,
    ...ObjectRegistry.getInheritanceChain(
      registered?.qualifiedName ?? registered?.name ?? name,
    ).map((ancestor) => ObjectRegistry.getFields(ancestor)),
  ];
  for (const source of sources) {
    if (!source) continue;
    for (const [field, def] of source) {
      if (!fields.has(field) && def) fields.set(field, def);
    }
  }
  return fields;
}

function isReadonlyDefinition(def: {
  readonly?: boolean;
  _meta?: unknown;
}): boolean {
  return (
    def.readonly === true ||
    (def._meta as { readonly?: unknown } | undefined)?.readonly === true
  );
}

/**
 * The write policy of one or more models: which keys the caller may not
 * write, which are output-only, and how a value compares with what is stored.
 * A key is protected when any of the models protects it, so an STI row
 * written through its base route keeps both the base's and its own policy.
 */
function writePolicyOf(names: readonly string[]): {
  isEmittedOnly(key: string): boolean;
  isProtected(key: string): boolean;
  sameValue(key: string, stored: unknown, incoming: unknown): boolean;
} {
  let fields:
    | Map<string, { type?: string; readonly?: boolean; _meta?: unknown }>
    | undefined;
  const definitions = () => {
    if (!fields) {
      fields = new Map();
      for (const name of names) {
        for (const [field, def] of fieldDefinitionsOf(name)) {
          const known = fields.get(field);
          // Read-only anywhere is read-only.
          if (
            !known ||
            (isReadonlyDefinition(def) && !isReadonlyDefinition(known))
          )
            fields.set(field, def);
        }
      }
    }
    return fields;
  };
  const configs = names.map((name) => ObjectRegistry.getConfig(name));
  const allowlists = configs
    .map((config) => {
      const api = config.api;
      return api &&
        typeof api === 'object' &&
        Array.isArray((api as { writable?: unknown }).writable)
        ? ((api as { writable: unknown[] }).writable as string[])
        : undefined;
    })
    .filter((list): list is string[] => list !== undefined);
  const projectsDisplayLabel = configs.some(
    (config) => typeof config.display?.label === 'object',
  );
  return {
    isEmittedOnly: (key) => projectsDisplayLabel && key === 'displayLabel',
    isProtected: (key) => {
      if (key.startsWith('_')) return true;
      if (allowlists.some((list) => !list.includes(key))) return true;
      const def = definitions().get(key);
      return !!def && isReadonlyDefinition(def);
    },
    sameValue: (key, stored, incoming) =>
      sameStoredValue(definitions().get(key)?.type, stored, incoming),
  };
}

/**
 * The update rules of a model.
 *
 * @param instance - The loaded object the body will be assigned onto
 * @param model - Registry key of the route's model. Its write policy holds
 *   together with the policy of the instance's own class, and it is the model
 *   used when the instance's class is not registered (a structural row, a
 *   test double)
 */
export function updateInputRulesFor(
  instance: object,
  model?: string,
): UpdateInputRules {
  const own = modelOfInstance(instance);
  const name = own ?? model;
  if (!name) return { declaresField: () => false, hasFieldMetadata: false };

  let writeThrough: Record<string, unknown> | undefined;
  const declaresField = (key: string): boolean => {
    if (ObjectRegistry.declaresField(name, key)) return true;
    // Write-through fields are declared on the model's config, not as columns.
    writeThrough ??= ObjectRegistry.getWriteThroughFields(name);
    return Object.hasOwn(writeThrough, key);
  };
  // The write policy of the object's own class and of the route's model. An
  // STI row loaded through its base route is its own subtype, whose read-only
  // fields and `api.writable` allowlist hold too.
  const policy = writePolicyOf(
    model && model !== name && ObjectRegistry.getClass(model)
      ? [name, model]
      : [name],
  );

  return {
    declaresField,
    hasFieldMetadata: hasFieldMetadata(name),
    isEmittedOnly: policy.isEmittedOnly,
    isProtected: policy.isProtected,
    sameValue: policy.sameValue,
  };
}

/**
 * The write body a request-facing write path hands to its model: the rule of
 * `resolveWriteBody` (`write-input.ts`) bound to a registered model.
 *
 * The one write-input rule of runtime REST, the generated SvelteKit routes
 * and sync apply:
 *
 * - Server-managed keys (`SERVER_MANAGED_WRITE_KEYS`: the id, the tenant,
 *   the timestamps, the STI discriminator columns), the keys that configure a
 *   service of the object, and a projected `displayLabel` are skipped and
 *   never compared.
 * - A field the caller may not write (read-only, including database
 *   generated fields; outside the model's `api.writable` allowlist;
 *   `_`-prefixed) is compared with what the row stores, after the
 *   normalisation of the field's declared type (`sameStoredValue`):
 *   - on an update (`stored` given), it is accepted and left out when its
 *     value would persist as the stored value, so a record read from the API
 *     can be sent back as is, and refused otherwise;
 *   - on a create (no `stored`), it is refused when sent with a non-null
 *     value, since there is no stored value to match, and left out when null.
 *   The policy of the route's model and of the stored row's own class both
 *   hold, so an STI row written through its base route keeps both.
 * - Every other key is kept; {@link applyUpdateInput} and
 *   {@link assertCreateInput} then refuse a key that is not a declared field
 *   or settable accessor.
 *
 * @param model - Registry key of the route's model, or of the create target
 * @param data - The request body
 * @param stored - The loaded object an update targets; omit for a create
 * @throws {FieldNotWritableError} a typed 400 naming the first protected
 *   field the body would change
 */
export function prepareWriteInput(
  model: string | undefined,
  data: unknown,
  stored?: object,
): Record<string, unknown> {
  const ownModel = stored ? modelOfInstance(stored) : undefined;
  const names = [ownModel, model].filter(
    (name, index, all): name is string =>
      typeof name === 'string' &&
      all.indexOf(name) === index &&
      !!ObjectRegistry.getClass(name),
  );
  const policy = writePolicyOf(names);
  const serviceModel = names[0] ?? model;
  return resolveWriteBody(
    data,
    {
      isProtected: policy.isProtected,
      isSkipped: (key) =>
        ObjectRegistry.isServiceOptionInput(serviceModel, key) ||
        policy.isEmittedOnly(key),
      sameValue: policy.sameValue,
    },
    stored,
  );
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
