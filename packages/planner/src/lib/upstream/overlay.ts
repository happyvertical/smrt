/**
 * Applies the local stand-ins (`widgets.ts`, `relations.ts`, and the inherited
 * enumeration below) to the generated catalog when it loads, so every consumer
 * reads `field.ui.widget`, `field.related` and `field.enum` exactly where the
 * manifest will put them. Nothing already in the catalog is overwritten: once a
 * package's manifest carries a value, it wins.
 *
 * Inherited enumeration: smrt 0.56.0's manifest drops `enum` and `description`
 * from a field an STI grandchild re-declares (`override contractType =
 * ContractType.ORDER` on `Order`, under `SalesContract` under `Contract`), so
 * the leaves' discriminator reads as a free text box. A field with no
 * enumeration takes its nearest ancestor's, same name and type: an STI child
 * shares its parent's column. Delete this once the leaves carry it again
 * (https://github.com/happyvertical/smrt/issues/4005; `tests/upstream-gaps.test.ts`
 * fails when they do).
 */
import type {
  Catalog,
  CatalogField,
  CatalogModel,
  CatalogPackage,
} from '../catalog/types.ts';
import { UNDECLARED_RELATIONS } from './relations.ts';
import { FIELD_WIDGETS } from './widgets.ts';

/** A model and its ancestors, nearest first (STI children inherit hints). */
function lineage(
  model: CatalogModel,
  all: ReadonlyMap<string, CatalogModel>,
): string[] {
  const chain: string[] = [];
  let current: CatalogModel | undefined = model;
  while (current && !chain.includes(current.id)) {
    chain.push(current.id);
    current = current.extends ? all.get(current.extends) : undefined;
  }
  return chain;
}

function lookup<T>(
  table: Readonly<Record<string, Readonly<Record<string, T>>>>,
  chain: readonly string[],
  field: string,
): T | undefined {
  for (const id of chain) {
    const found = table[id]?.[field];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The nearest ancestor's same-named field that carries an enumeration. */
function inheritedEnum(
  field: CatalogField,
  chain: readonly string[],
  all: ReadonlyMap<string, CatalogModel>,
): CatalogField | undefined {
  for (const id of chain.slice(1)) {
    const parent = all.get(id)?.fields.find((f) => f.name === field.name);
    if (parent?.enum && parent.type === field.type) return parent;
  }
  return undefined;
}

function overlayField(
  field: CatalogField,
  chain: readonly string[],
  all: ReadonlyMap<string, CatalogModel>,
): CatalogField {
  let next = field;
  if (!field.enum) {
    const parent = inheritedEnum(field, chain, all);
    if (parent?.enum) {
      next = { ...next, enum: parent.enum };
      if (!next.description && parent.description) {
        next = { ...next, description: parent.description };
      }
    }
  }
  const widget = field.ui?.widget
    ? undefined
    : lookup(FIELD_WIDGETS, chain, field.name);
  if (widget) next = { ...next, ui: { ...next.ui, widget } };
  if (!field.related) {
    const target = lookup(UNDECLARED_RELATIONS, chain, field.name);
    if (target) next = { ...next, type: 'foreignKey', related: target };
  }
  return next;
}

/** The catalog with the stand-ins applied; the input is not modified. */
export function applyUpstreamOverlay(catalog: Catalog): Catalog {
  const all = new Map<string, CatalogModel>(
    catalog.packages.flatMap((pkg) => pkg.models.map((m) => [m.id, m])),
  );
  const packages = catalog.packages.map(
    (pkg): CatalogPackage => ({
      ...pkg,
      models: pkg.models.map((model) => {
        const chain = lineage(model, all);
        return {
          ...model,
          fields: model.fields.map((field) => overlayField(field, chain, all)),
        };
      }),
    }),
  );
  return { ...catalog, packages };
}
