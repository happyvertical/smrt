import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import {
  getThemeName,
  isValidPreset,
} from '@happyvertical/smrt-ui/themes/presets';
import { humanize } from '../data/format.ts';
import { FEATURE_SECTION } from '../recipes/features.ts';
import { buildNavSections, recipes, recipesById } from '../recipes/index.ts';
import type { FieldPolicyRow } from '../recipes/policy.ts';
import { DEFAULT_PRESET, type ThemeSetting } from '../theme/theme.ts';
import type { Cookbook } from './types.ts';

/**
 * The Export page's summary of a cookbook: one line per dimension that has
 * content, so a person sees what a download carries and what Import or Reset
 * would replace. Pure; the page renders `chips` as chips and `text` as prose.
 */
export interface SummaryLine {
  id:
    | 'recipes'
    | 'features'
    | 'options'
    | 'exposure'
    | 'theme'
    | 'layout'
    | 'pages';
  label: string;
  chips?: string[];
  text?: string;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const NAV_SECTION_LABELS = new Map(
  buildNavSections(recipes).map((section) => [section.id, section.label]),
);

/** The last segment of a qualified model name, humanized: `@scope/pkg:StockLevel` -> `Stock level`. */
export function modelLabel(qualified: string): string {
  return humanize(qualified.slice(qualified.lastIndexOf(':') + 1));
}

/** Saved options grouped by model: `Customer: payment terms, currency`. */
export function describeOptions(policies: readonly FieldPolicyRow[]): string[] {
  const byModel = new Map<string, string[]>();
  for (const row of policies) {
    const model = modelLabel(row.objectRef);
    const fields = byModel.get(model) ?? [];
    const field = humanize(row.fieldName).toLowerCase();
    if (!fields.includes(field)) fields.push(field);
    byModel.set(model, fields);
  }
  return [...byModel].map(
    ([model, fields]) => `${model}: ${fields.join(', ')}`,
  );
}

/** The theme as a few words: preset or brand colour, then what differs from the defaults. */
export function describeTheme(theme: ThemeSetting): string[] {
  const parts: string[] = [];
  if (theme.custom) parts.push(`brand colour ${theme.custom.primary}`);
  else if (theme.preset && theme.preset !== DEFAULT_PRESET) {
    parts.push(
      `${isValidPreset(theme.preset) ? getThemeName(theme.preset) : theme.preset} preset`,
    );
  }
  if (theme.colorScheme && theme.colorScheme !== 'system') {
    parts.push(`${theme.colorScheme} scheme`);
  }
  const font = theme.fontFamily ?? theme.custom?.fontFamily;
  if (font) parts.push(`${font} font`);
  if (theme.borderRadius) parts.push(`${theme.borderRadius} corners`);
  if (theme.density === 'touch') parts.push('touch density');
  if (theme.contrast && theme.contrast !== 'auto') {
    parts.push(`${theme.contrast} contrast`);
  }
  if (theme.customCss?.trim()) parts.push('custom CSS');
  return parts;
}

/** The layout delta in counts: custom sections by name, then hidden, renamed, moved, reordered. */
export function describeLayout(layout: ShellLayout): string[] {
  const parts: string[] = [];
  const custom = layout.customSections ?? [];
  if (custom.length) {
    const names = custom.map((section) => section.label).filter(Boolean);
    parts.push(
      `${plural(custom.length, 'custom section')}${names.length && names.length <= 4 ? ` (${names.join(', ')})` : ''}`,
    );
  }
  const hidden = layout.hidden?.length ?? 0;
  if (hidden) parts.push(`${hidden} hidden`);
  const renamed =
    Object.values(layout.items ?? {}).filter((item) => item.label).length +
    Object.values(layout.sections ?? {}).filter(
      (section) => section.label || section.icon || section.showTitle === false,
    ).length;
  if (renamed) parts.push(`${renamed} renamed or restyled`);
  const moved = Object.keys(layout.moved ?? {}).length;
  if (moved) parts.push(`${moved} moved`);
  if (
    layout.sectionOrder?.length ||
    Object.keys(layout.itemOrder ?? {}).length
  ) {
    parts.push('reordered');
  }
  const placed = Object.keys(layout.placements ?? {}).length;
  if (placed) parts.push(`${plural(placed, 'shell item')} placed`);
  if (Object.keys(layout.panels ?? {}).length) parts.push('panel settings');
  return parts;
}

/** A customised page's name from its overview id. */
export function pageLabel(id: string, layout?: ShellLayout): string {
  if (id === `section:${FEATURE_SECTION.id}`) return FEATURE_SECTION.label;
  if (id.startsWith('section:')) {
    const key = id.slice('section:'.length);
    return (
      layout?.sections?.[id]?.label ??
      NAV_SECTION_LABELS.get(key) ??
      humanize(key)
    );
  }
  if (id.startsWith('custom:')) {
    return (
      layout?.customSections?.find((section) => section.id === id)?.label ??
      humanize(id.slice('custom:'.length))
    );
  }
  if (id.startsWith('detail:')) {
    const model = id.slice(id.lastIndexOf('.') + 1);
    return `${humanize(model)} record`;
  }
  return humanize(id);
}

/** Every line with content, in display order; empty for an empty cookbook. */
export function describeCookbook(cookbook: Cookbook): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (cookbook.recipes.length) {
    lines.push({
      id: 'recipes',
      label: plural(cookbook.recipes.length, 'recipe'),
      chips: cookbook.recipes.map((id) => recipesById.get(id)?.label ?? id),
    });
  }
  if (cookbook.features.length) {
    lines.push({
      id: 'features',
      label: plural(cookbook.features.length, 'feature'),
      chips: cookbook.features.map(modelLabel),
    });
  }
  if (cookbook.policies.length) {
    lines.push({
      id: 'options',
      label: plural(cookbook.policies.length, 'saved option'),
      chips: describeOptions(cookbook.policies),
    });
  }
  const narrowed = Object.entries(cookbook.exposure ?? {}).filter(
    ([, surfaces]) => surfaces.length,
  );
  if (narrowed.length) {
    lines.push({
      id: 'exposure',
      label: 'Surfaces switched off',
      chips: narrowed.map(
        ([model, surfaces]) => `${modelLabel(model)}: ${surfaces.join(', ')}`,
      ),
    });
  }
  const theme = cookbook.theme ? describeTheme(cookbook.theme) : [];
  if (theme.length) {
    lines.push({ id: 'theme', label: 'Theme', text: theme.join(', ') });
  }
  const layout = cookbook.layout ? describeLayout(cookbook.layout) : [];
  if (layout.length) {
    lines.push({ id: 'layout', label: 'Layout', text: layout.join(', ') });
  }
  const pages = Object.keys(cookbook.overviews ?? {});
  if (pages.length) {
    lines.push({
      id: 'pages',
      label: plural(pages.length, 'customised page'),
      chips: pages.map((id) => pageLabel(id, cookbook.layout)),
    });
  }
  return lines;
}

/** One sentence for confirm dialogs: "3 recipes, 2 saved options, a theme and a layout". */
export function summarizeCookbook(cookbook: Cookbook): string {
  const lines = describeCookbook(cookbook);
  if (!lines.length) return 'an empty cookbook';
  const words = lines.map((line) =>
    line.id === 'theme'
      ? 'a theme'
      : line.id === 'layout'
        ? 'a layout'
        : line.id === 'exposure'
          ? 'narrowed surfaces'
          : line.label,
  );
  return words.length === 1
    ? words[0]
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
