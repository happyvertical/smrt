import { libraryCookbooks } from '../library/index.ts';
import { FEATURE_SECTION } from '../recipes/features.ts';
import { buildNavSections, recipes } from '../recipes/index.ts';

/** The icon of a section the visitor made, or one the host knows nothing of. */
export const DEFAULT_SECTION_ICON = 'folder';

/** What the app suggests for a navigation section: its icon and its blurb. */
export interface SectionInfo {
  icon?: string;
  description?: string;
}

const NAV_SECTIONS = new Map(
  buildNavSections(recipes).map((section) => [section.id, section]),
);

/** `custom:` descriptions come with the cookbooks; ids are shared by name. */
const CUSTOM_DESCRIPTIONS = new Map<string, string>(
  libraryCookbooks.flatMap((cookbook) =>
    Object.entries(cookbook.sectionDescriptions ?? {}),
  ),
);

/**
 * The suggested icon and description of a layout section id. A recipe's
 * section carries both in the recipe data (the group summary stands in for a
 * missing description); the More section is the app's own; a cookbook's custom
 * sections have a description in the cookbook, and an icon in its layout.
 */
export function sectionInfo(id: string): SectionInfo {
  if (id === `section:${FEATURE_SECTION.id}`) {
    return {
      icon: FEATURE_SECTION.icon,
      description: FEATURE_SECTION.description,
    };
  }
  if (id.startsWith('section:')) {
    const section = NAV_SECTIONS.get(id.slice('section:'.length));
    if (!section) return {};
    const summary = section.recipes.find((r) => r.group?.summary)?.group
      ?.summary;
    return {
      icon: section.icon,
      description: section.description ?? summary,
    };
  }
  const description = CUSTOM_DESCRIPTIONS.get(id);
  return description ? { description } : {};
}

/** The title of a section page: its label once the layout has resolved, never the raw id. */
export function sectionTitle(heading: string | null | undefined): string {
  return heading?.trim() || 'Planner';
}
