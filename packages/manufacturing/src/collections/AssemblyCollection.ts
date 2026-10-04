/**
 * AssemblyCollection — collection for {@link Assembly} rows.
 *
 * Assemblies share the `products` table with every other `Product` subtype;
 * the STI framework filters this collection to assembly rows by
 * `_meta_type`, so `list()` and `get()` only ever return assemblies.
 *
 * @packageDocumentation
 */

import { ProductCollection } from '@happyvertical/smrt-products/collections';
import { Assembly } from '../models/Assembly.js';

export class AssemblyCollection extends ProductCollection {
  static override readonly _itemClass = Assembly;
}
