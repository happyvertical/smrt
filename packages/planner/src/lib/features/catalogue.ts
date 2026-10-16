import type { CatalogPackage } from '../catalog/types.ts';
import { humanize } from '../data/format.ts';
import { withRequirements } from '../recipes/resolve.ts';
import type {
  Recipe,
  RecipeProvider,
  RecipeSurface,
} from '../recipes/types.ts';
import {
  browserNote,
  type DemoBadge,
  demoBadge,
  effectiveDemo,
} from './demo.ts';

/**
 * The Features catalogue: every recipe the catalog carries, presented as a
 * feature (what it is, where it runs, what it needs, what you get) and
 * browsable by the recipe's `group`. Pure and data-driven: a recipe a smrt
 * release adds shows up with no change here.
 */

/** Browse facet. A recipe without a `group` falls under its package. */
export interface FeatureGroup {
  id: string;
  label: string;
  summary?: string;
}

/** What a recipe adds that is not a model: one line each. */
export interface FeatureGets {
  /** `menu` for a list-and-form entry, else the surface kind. */
  kind: 'menu' | RecipeSurface['kind'] | 'data';
  /** The kind in words, e.g. "Shell widget". */
  kindLabel: string;
  /** The thing's name, e.g. "Assistant". */
  label: string;
  /** Where it lands, e.g. "header, right side" or "/analytics/summary". */
  where?: string;
}

/** A provider need with the secret NAMES (never values). */
export interface FeatureProvider {
  id: string;
  kind: string;
  kindLabel: string;
  required: boolean;
  options: string[];
  /** Options that run in a browser with none of the secrets. */
  browserOptions: string[];
  secrets: string[];
}

export interface FeatureCard {
  recipe: Recipe;
  id: string;
  label: string;
  /** The one-line help. */
  summary: string;
  group: FeatureGroup;
  packageId: string;
  /** Browser-demo label including what the recipe requires; absent if unreported. */
  demo: DemoBadge | undefined;
  /** The recipe's own mode when it differs from the effective one. */
  ownMode: DemoBadge['mode'] | undefined;
  /** What the package's own browser capability says, when reported. */
  packageNote: string | undefined;
  providers: FeatureProvider[];
  gets: FeatureGets[];
  /** Ids of recipes it requires. */
  requires: string[];
  runtime: Recipe['runtime'];
}

const SLOT_WORDS: Readonly<Record<string, string>> = {
  'header.start': 'header, left side',
  'header.center': 'header, middle',
  'header.end': 'header, right side',
  'footer.start': 'footer, left side',
  'footer.center': 'footer, middle',
  'footer.end': 'footer, right side',
  'leftSidebar.header': 'left sidebar, top',
  'leftSidebar.footer': 'left sidebar, bottom',
  'rightSidebar.header': 'right sidebar, top',
  'rightSidebar.footer': 'right sidebar, bottom',
};

const PROVIDER_KIND_WORDS: Readonly<Record<string, string>> = {
  llm: 'Language model',
  email: 'Email',
  oauth: 'Sign-in (OAuth)',
  storage: 'File storage',
  sms: 'Text messages',
  payments: 'Payments',
};

const OPTION_WORDS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  webllm: 'WebLLM',
  bitgpu: 'BitGPU',
  smtp: 'SMTP',
  imap: 'IMAP',
  s3: 'S3',
  github: 'GitHub',
};

/** An option id in words (`webllm` -> "WebLLM", `mock` -> "Mock"). */
export function optionLabel(option: string): string {
  return OPTION_WORDS[option] ?? humanize(option);
}

/** `a, b or c` / `a and b`: option ids as a readable list. */
export function optionList(
  options: readonly string[],
  joiner: 'and' | 'or' = 'or',
): string {
  const labels = options.map(optionLabel);
  if (labels.length <= 1) return labels.join('');
  if (labels.length === 2) return `${labels[0]} ${joiner} ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} ${joiner} ${labels[labels.length - 1]}`;
}

/** One surface as a line of "what you get". */
export function describeSurface(surface: RecipeSurface): FeatureGets {
  switch (surface.kind) {
    case 'shell-widget':
      return {
        kind: surface.kind,
        kindLabel: 'Shell widget',
        label: surface.label,
        where: SLOT_WORDS[surface.slot] ?? humanize(surface.slot),
      };
    case 'route':
      return {
        kind: surface.kind,
        kindLabel: 'Page',
        label: surface.label,
        where: surface.path,
      };
    case 'settings-panel':
      return {
        kind: surface.kind,
        kindLabel: 'Settings panel',
        label: surface.label,
      };
    case 'playground':
      return {
        kind: surface.kind,
        kindLabel: 'Playground',
        label: surface.label ?? 'Try it',
      };
    case 'widget':
      return {
        kind: surface.kind,
        kindLabel: 'Overview widget',
        label: surface.label,
      };
  }
}

function describeProvider(provider: RecipeProvider): FeatureProvider {
  return {
    id: provider.id,
    kind: provider.kind,
    kindLabel: PROVIDER_KIND_WORDS[provider.kind] ?? humanize(provider.kind),
    required: provider.required,
    options: provider.options,
    browserOptions: provider.browserOptions ?? [],
    secrets: provider.secrets ?? [],
  };
}

/**
 * What adding the recipe gives: its menu entries (a list and form each), then
 * its surfaces. A recipe with neither stores records only.
 */
export function featureGets(recipe: Recipe): FeatureGets[] {
  const menu: FeatureGets[] = recipe.nav.map((entry) => ({
    kind: 'menu',
    kindLabel: 'List and form',
    label: entry.label,
  }));
  const surfaces = (recipe.surfaces ?? []).map(describeSurface);
  const gets = [...menu, ...surfaces];
  if (gets.length > 0) return gets;
  return [
    {
      kind: 'data',
      kindLabel: 'Records only',
      label: `${recipe.models.length} ${recipe.models.length === 1 ? 'model' : 'models'}, no screens of their own`,
    },
  ];
}

/**
 * The browse group of a recipe: its declared `group`, else its package (so a
 * feature that declares no group is still found next to its siblings).
 */
export function groupOf(recipe: Recipe, packageId: string): FeatureGroup {
  if (recipe.group) {
    return {
      id: `group:${recipe.group.id}`,
      label: recipe.group.label,
      ...(recipe.group.summary ? { summary: recipe.group.summary } : {}),
    };
  }
  return { id: `package:${packageId}`, label: humanize(packageId) };
}

/**
 * One card per recipe, in the recipes' order. `packages` says which package
 * declared each recipe (a recipe the catalog does not place falls back to the
 * package of its first model).
 */
export function buildFeatureCards(
  recipes: readonly Recipe[],
  packages: readonly CatalogPackage[],
): FeatureCard[] {
  const declaredBy = new Map<string, CatalogPackage>();
  for (const pkg of packages) {
    for (const recipe of pkg.recipes ?? []) declaredBy.set(recipe.id, pkg);
  }
  const owner = (recipe: Recipe): CatalogPackage | undefined =>
    declaredBy.get(recipe.id) ??
    packages.find((pkg) => pkg.models.some((m) => m.id === recipe.models[0]));

  return recipes.map((recipe) => {
    const pkg = owner(recipe);
    const packageId = pkg?.id ?? recipe.id.split('.')[0];
    const effective = effectiveDemo(recipe);
    const badge = demoBadge(effective);
    return {
      recipe,
      id: recipe.id,
      label: recipe.label,
      summary: recipe.summary,
      group: groupOf(recipe, packageId),
      packageId,
      demo: badge,
      ownMode:
        recipe.demo && effective && recipe.demo.mode !== effective.mode
          ? recipe.demo.mode
          : undefined,
      packageNote: browserNote(pkg?.browser),
      providers: (recipe.providers ?? []).map(describeProvider),
      gets: featureGets(recipe),
      requires: recipe.requires,
      runtime: recipe.runtime,
    };
  });
}

/** Groups present in `cards`, by label. */
export function featureGroups(cards: readonly FeatureCard[]): FeatureGroup[] {
  const groups = new Map<string, FeatureGroup>();
  for (const card of cards) {
    const existing = groups.get(card.group.id);
    if (!existing) groups.set(card.group.id, card.group);
    else if (!existing.summary && card.group.summary) {
      groups.set(card.group.id, { ...existing, summary: card.group.summary });
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Cards matching every search term, and the group when one is chosen. */
export function filterFeatureCards(
  cards: readonly FeatureCard[],
  query: string,
  groupId?: string | null,
): FeatureCard[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((card) => {
    if (groupId && card.group.id !== groupId) return false;
    if (terms.length === 0) return true;
    const haystack = [
      card.label,
      card.summary,
      card.id,
      card.group.label,
      card.packageId,
      ...card.recipe.synonyms,
      ...card.gets.flatMap((g) => [g.kindLabel, g.label, g.where ?? '']),
      ...card.providers.flatMap((p) => [p.kindLabel, ...p.options]),
      card.demo?.label ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Cards by group, groups by label, cards in their given order. */
export function cardsByGroup(
  cards: readonly FeatureCard[],
): { group: FeatureGroup; cards: FeatureCard[] }[] {
  return featureGroups(cards).map((group) => ({
    group,
    cards: cards.filter((card) => card.group.id === group.id),
  }));
}

/**
 * The recipes switching `id` on would add besides itself, i.e. its
 * `requires` (transitively) and the first alternative of an unmet
 * `requiresAny`; the same resolution the Recipes tab applies.
 */
export function alsoAdds(
  id: string,
  selected: readonly string[],
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  const before = new Set(withRequirements(selected, recipes));
  return withRequirements([...selected, id], recipes).filter(
    (other) => other !== id && !before.has(other),
  );
}

/** The secrets a card needs by name, deduplicated across its providers. */
export function secretNames(card: FeatureCard): string[] {
  return [...new Set(card.providers.flatMap((p) => p.secrets))];
}
