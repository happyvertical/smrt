/**
 * Own route collections for hosted STI subclasses (#3749).
 *
 * An STI subclass shares its base's table, and the manifest generator also
 * gives it the base's `collection` unless it declares one
 * (`@smrt({ collection })`, "collection controls routes/permissions
 * independently of shared storage"). Hosting `Order` and `ProductionOrder`
 * beside each other would therefore claim `/contracts` twice, and one handler
 * would silently shadow the other.
 *
 * A hosted subclass that has not declared a collection gets its class-derived
 * one (`orders`), the name it would have had as a plain model. Its generated
 * route then lists and reads through its own collection, which already scopes
 * every read to the subclass `_meta_type`; the base keeps the shared name and
 * the base-collection semantics (every row of the table). The same rewritten
 * manifest feeds the `@smrt/web` definitions and the generated client, so each
 * hosted class advertises exactly the endpoint its route serves.
 */
import { defaultCollectionName } from '@happyvertical/smrt-scanner';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  findManifestObjectByName,
  isCollectionManifestClass,
  isStiChildModel,
  resolveCollectionItemObject,
} from '../vite-plugin/web-collections.js';

/**
 * The `api` config of the nearest STI ancestor that declares one. An omitted
 * `api` means full CRUD, so a hosted subclass that says nothing would expose
 * `DELETE /orders/:id` even though its base (`Contract`) allows only
 * list/get/create/update. Hosting fails closed: the subclass inherits the base's
 * exposure unless it declares its own (hosting path only; the framework-wide
 * default is unchanged).
 */
function inheritedApi(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): unknown {
  const seen = new Set<string>();
  let child = obj;
  let parentName = child.extendsQualified || child.extends;
  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findManifestObjectByName(manifest, parentName, child);
    if (!parent) return undefined;
    // Only an STI relative lends its exposure: it shares the table (and so the
    // inherited collection) or is the declared STI base.
    const sti =
      parent.collection === obj.collection ||
      parent.decoratorConfig?.tableStrategy === 'sti';
    if (!sti) return undefined;
    const api = parent.decoratorConfig?.api;
    if (api !== undefined) return api;
    child = parent;
    parentName = parent.extendsQualified || parent.extends;
  }
  return undefined;
}

/**
 * @param manifest - The aggregated manifest of every consumed package.
 * @param hosted - Provider-qualified refs the consumer hosts.
 * @param refOf - The qualified ref of a manifest entry.
 * @returns The manifest with each hosted, collection-inheriting STI subclass
 *   moved to its own collection; `manifest` itself when none needs it.
 */
export function separateHostedStiCollections<M extends object>(
  manifest: M,
  hosted: readonly string[],
  refOf: (key: string, def: SmartObjectDefinition) => string | undefined,
): M {
  const source = manifest as unknown as SmartObjectManifest;
  const wanted = new Set(hosted);
  let objects: SmartObjectManifest['objects'] | undefined;
  const moved = new Map<SmartObjectDefinition, string>();
  for (const [key, def] of Object.entries(source.objects)) {
    const ref = refOf(key, def);
    if (!ref || !wanted.has(ref)) continue;
    // An explicit `collection` is already independent; only an inherited one
    // collides.
    const separable =
      !def.decoratorConfig?.collection && isStiChildModel(source, def);
    const collection = separable
      ? defaultCollectionName(def.className)
      : def.collection;
    const api =
      def.decoratorConfig?.api === undefined
        ? inheritedApi(source, def)
        : undefined;
    if (collection === def.collection && api === undefined) continue;
    if (collection !== def.collection) moved.set(def, collection);
    objects ??= { ...source.objects };
    objects[key] = {
      ...def,
      collection,
      ...(api === undefined
        ? {}
        : { decoratorConfig: { ...def.decoratorConfig, api } }),
    } as SmartObjectDefinition;
  }
  if (!objects) return manifest;

  // A collection class follows its item class (the manifest generator gives it
  // the item's collection); left behind it would keep the shared route and
  // collide with its siblings' collection classes on custom-action routes.
  for (const [key, def] of Object.entries(source.objects)) {
    if (!isCollectionManifestClass(source, def)) continue;
    const item = resolveCollectionItemObject(source, def);
    const collection = item ? moved.get(item) : undefined;
    if (collection && def.collection !== collection) {
      objects[key] = { ...def, collection } as SmartObjectDefinition;
    }
  }
  return { ...manifest, objects } as M;
}
