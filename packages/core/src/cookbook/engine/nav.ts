import type { Cookbook, CookbookLayout } from '@happyvertical/smrt-types';
import type { EngineCatalog, EngineModel } from './types.js';

/** A menu entry after the layout is applied. */
export interface NavItem {
  id: string;
  label: string;
  defaultLabel: string;
  hidden: boolean;
}

export interface NavSection {
  /** `section:<id>`, or the id of a custom section. */
  id: string;
  label: string;
  defaultLabel: string;
  custom: boolean;
  hidden: boolean;
  items: NavItem[];
}

/** The section that holds feature models no recipe covers. */
export const FEATURE_SECTION = { id: 'more', label: 'More' } as const;

const QUALIFIED = /^@[^/]+\/(?:smrt-)?([^:]+):(.+)$/;

/** Class name and package id of a qualified model name, from the catalog or the name itself. */
export function modelParts(
  catalog: EngineCatalog,
  qualified: string,
): { packageId: string; name: string } {
  const known = catalog.models.find((m) => m.id === qualified);
  if (known) return { packageId: known.packageId, name: known.name };
  const match = QUALIFIED.exec(qualified);
  return match
    ? { packageId: match[1], name: match[2] }
    : { packageId: 'unknown', name: qualified };
}

/** The stable layout id of a navigation item (same as smrt-svelte's `navItemId`). */
export const navItemId = (
  packageId: string,
  modelName: string,
  key?: string,
): string => `item:${packageId}:${modelName}${key ? `:${key}` : ''}`;

/** `Purchase Order` from `PurchaseOrder`. */
export const humanize = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

export const modelLabel = (catalog: EngineCatalog, id: string): string =>
  humanize(modelParts(catalog, id).name);

interface RawSection {
  id: string;
  label: string;
  items: { id: string; label: string }[];
}

/** The menu a document generates, before its layout. */
function generated(
  catalog: EngineCatalog,
  doc: Pick<Cookbook, 'recipes' | 'features'>,
): RawSection[] {
  const byId = new Map(catalog.recipes.map((r) => [r.id, r]));
  const sections = new Map<string, RawSection>();
  for (const recipeId of [...doc.recipes].sort()) {
    const recipe = byId.get(recipeId);
    if (!recipe) continue;
    const suggested = recipe.section ?? {
      id: recipe.group?.id ?? recipe.id,
      label: recipe.group?.label ?? recipe.label,
    };
    const id = `section:${suggested.id}`;
    const section = sections.get(id) ?? {
      id,
      label: suggested.label,
      items: [],
    };
    for (const entry of recipe.nav) {
      const { packageId, name } = modelParts(catalog, entry.model);
      const itemId = navItemId(packageId, name, entry.key);
      if (!section.items.some((i) => i.id === itemId)) {
        section.items.push({ id: itemId, label: entry.label });
      }
    }
    sections.set(id, section);
  }
  const out = [...sections.values()].filter((s) => s.items.length > 0);
  const known = new Set(
    catalog.models.filter((m) => m.exposed !== false).map((m) => m.id),
  );
  const features = doc.features.filter((id) => known.has(id));
  if (features.length) {
    out.push({
      id: `section:${FEATURE_SECTION.id}`,
      label: FEATURE_SECTION.label,
      items: features.map((id) => {
        const { packageId, name } = modelParts(catalog, id);
        return { id: navItemId(packageId, name), label: humanize(name) };
      }),
    });
  }
  return out;
}

const order = <T extends { id: string }>(
  list: T[],
  wanted: readonly string[] | undefined,
): T[] => {
  if (!wanted?.length) return list;
  const rank = (id: string) => {
    const i = wanted.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...list].sort((a, b) => rank(a.id) - rank(b.id));
};

/** The menu with the document's layout applied: moves, order, hides, renames. */
export function buildNav(
  catalog: EngineCatalog,
  doc: Pick<Cookbook, 'recipes' | 'features'> & { layout?: CookbookLayout },
): NavSection[] {
  const layout = doc.layout;
  const raw = generated(catalog, doc);
  const sections: NavSection[] = raw.map((s) => ({
    id: s.id,
    label: s.label,
    defaultLabel: s.label,
    custom: false,
    hidden: false,
    items: s.items.map((i) => ({
      id: i.id,
      label: i.label,
      defaultLabel: i.label,
      hidden: false,
    })),
  }));
  for (const custom of layout?.customSections ?? []) {
    if (sections.some((s) => s.id === custom.id)) continue;
    sections.push({
      id: custom.id,
      label: custom.label,
      defaultLabel: custom.label,
      custom: true,
      hidden: false,
      items: [],
    });
  }
  for (const [itemId, target] of Object.entries(layout?.moved ?? {})) {
    const to = sections.find((s) => s.id === target);
    if (!to) continue;
    for (const from of sections) {
      const at = from.items.findIndex((i) => i.id === itemId);
      if (at >= 0 && from !== to) to.items.push(...from.items.splice(at, 1));
    }
  }
  const hidden = new Set(layout?.hidden ?? []);
  for (const section of sections) {
    const label = layout?.sections?.[section.id]?.label?.trim();
    if (label && !section.custom) section.label = label;
    section.hidden = hidden.has(section.id);
    section.items = order(section.items, layout?.itemOrder?.[section.id]);
    for (const item of section.items) {
      const own = layout?.items?.[item.id]?.label?.trim();
      if (own) item.label = own;
      item.hidden = hidden.has(item.id);
    }
  }
  return order(
    sections.filter((s) => s.custom || s.items.length > 0),
    layout?.sectionOrder,
  );
}

/** Is this model known as exposed by the catalog? */
export const findModel = (
  catalog: EngineCatalog,
  id: string,
): EngineModel | undefined => catalog.models.find((m) => m.id === id);

const compact = (layout: CookbookLayout): CookbookLayout | undefined => {
  const out: CookbookLayout = { ...layout };
  for (const key of ['hidden', 'customSections', 'sectionOrder'] as const) {
    if (!out[key]?.length) delete out[key];
  }
  for (const key of [
    'sections',
    'items',
    'itemOrder',
    'moved',
    'panels',
    'placements',
  ] as const) {
    if (out[key] && Object.keys(out[key] as object).length === 0)
      delete out[key];
  }
  return Object.keys(out).length > 1 ? out : undefined;
};

/** A section rename; blank or the default label removes the override. */
export function withSectionRenamed(
  layout: CookbookLayout | undefined,
  section: NavSection,
  label: string,
): CookbookLayout | undefined {
  const base: CookbookLayout = layout
    ? structuredClone(layout)
    : { version: 1 };
  const clean = label.trim();
  if (section.custom) {
    if (!clean) return layout;
    base.customSections = base.customSections?.map((c) =>
      c.id === section.id ? { ...c, label: clean } : c,
    );
    return compact(base);
  }
  const sections = { ...(base.sections ?? {}) };
  const entry = { ...(sections[section.id] ?? {}) };
  if (!clean || clean === section.defaultLabel) delete entry.label;
  else entry.label = clean;
  if (Object.keys(entry).length) sections[section.id] = entry;
  else delete sections[section.id];
  base.sections = sections;
  return compact(base);
}

/** An item rename; `null`, blank or the default label removes the override. */
export function withItemRenamed(
  layout: CookbookLayout | undefined,
  item: NavItem,
  label: string | null,
): CookbookLayout | undefined {
  const base: CookbookLayout = layout
    ? structuredClone(layout)
    : { version: 1 };
  const clean = label?.trim() ?? '';
  const items = { ...(base.items ?? {}) };
  const entry = { ...(items[item.id] ?? {}) };
  if (!clean || clean === item.defaultLabel) delete entry.label;
  else entry.label = clean;
  if (Object.keys(entry).length) items[item.id] = entry;
  else delete items[item.id];
  base.items = items;
  return compact(base);
}

export function withHidden(
  layout: CookbookLayout | undefined,
  id: string,
  hide: boolean,
): CookbookLayout | undefined {
  const base: CookbookLayout = layout
    ? structuredClone(layout)
    : { version: 1 };
  const hidden = (base.hidden ?? []).filter((h) => h !== id);
  base.hidden = hide ? [...hidden, id] : hidden;
  return compact(base);
}
