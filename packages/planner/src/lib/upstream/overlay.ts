/**
 * Applies the local stand-ins (`enums.ts`, `widgets.ts`, `relations.ts`) to the
 * generated catalog when it loads, so every consumer reads `field.enum`,
 * `field.ui.widget` and `field.related` exactly where the manifest will put
 * them. Nothing already in the catalog is overwritten: once a package's
 * manifest carries a value, it wins.
 */
import type {
  Catalog,
  CatalogField,
  CatalogModel,
  CatalogPackage,
} from '../catalog/types.ts';
import { ENUM_VALUES } from './enums.ts';
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

function overlayField(
  field: CatalogField,
  chain: readonly string[],
): CatalogField {
  let next = field;
  const values = field.enum
    ? undefined
    : lookup(ENUM_VALUES, chain, field.name);
  if (values) next = { ...next, enum: [...values] };
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
          fields: model.fields.map((field) => overlayField(field, chain)),
        };
      }),
    }),
  );
  return { ...catalog, packages };
}
