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
  isCollectionManifestClass,
  isStiChildModel,
  resolveCollectionItemObject,
} from '../vite-plugin/web-collections.js';

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
    if (def.decoratorConfig?.collection) continue;
    if (!isStiChildModel(source, def)) continue;
    const collection = defaultCollectionName(def.className);
    if (collection === def.collection) continue;
    moved.set(def, collection);
    objects ??= { ...source.objects };
    objects[key] = { ...def, collection } as SmartObjectDefinition;
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
