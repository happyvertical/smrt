/**
 * Cookbook v1: the portable document that says what an app is made of
 * (recipes, features, field policies, surface exposure, shell layout, theme,
 * overview pages). Type-only; the parser/validator is
 * `@happyvertical/smrt-core/cookbook` and the JSON Schema ships as
 * `@happyvertical/smrt-core/cookbook/v1.schema.json`. The `$schema`
 * URL constants live there too (this package holds no runtime code).
 *
 * Layout, theme and overview values are typed structurally so this package
 * never depends on smrt-svelte or smrt-ui. smrt-svelte's `ShellLayout` and
 * `OverviewOverride` are identical to {@link CookbookLayout} and
 * {@link CookbookOverviewOverride} (a type test in smrt-svelte enforces it);
 * those packages own deep validation.
 *
 * Versioning: new optional fields are added within `version: 1`; readers
 * ignore keys they do not know. A breaking change means `version: 2`.
 */

import type { RecipeShellSlot } from './recipe.js';

export type CookbookExposureSurface = 'api' | 'mcp' | 'cli';

export type CookbookFieldVisibility = 'basic' | 'advanced' | 'hidden';

/** One app-scope smrt-fields policy row. Only changed keys are present. */
export interface CookbookPolicyRow {
  /** Qualified class name, `@scope/pkg:Class`. */
  objectRef: string;
  fieldName: string;
  scopeType: 'app';
  /** Encoded channel: JSON text as the column stores it (`'"Net 30"'`). */
  defaultValue?: string | null;
  visibility?: CookbookFieldVisibility | null;
  help?: string | null;
  label?: string | null;
  displayOrder?: number | null;
  locked?: boolean | null;
}

/** Structural copy of smrt-svelte's `ShellLayoutSection`. */
export interface CookbookLayoutSection {
  label?: string;
  showTitle?: boolean;
  icon?: string;
}

/** Structural copy of smrt-svelte's `ShellLayoutItem`. */
export interface CookbookLayoutItem {
  label?: string;
  description?: string;
}

/** Structural copy of smrt-svelte's `ShellLayoutPanel`. */
export interface CookbookLayoutPanel {
  visible?: boolean;
  initial?: 'collapsed' | 'expanded';
}

/**
 * Structural copy of smrt-svelte's `ShellLayout` (version 1). A type-level test
 * in smrt-svelte (`cookbook/__tests__/contract-types.test.ts`) requires the two
 * to be identical, so a field added on either side fails typecheck.
 */
export interface CookbookLayout {
  version: 1;
  sectionOrder?: string[];
  itemOrder?: Record<string, string[]>;
  hidden?: string[];
  moved?: Record<string, string>;
  sections?: Record<string, CookbookLayoutSection>;
  items?: Record<string, CookbookLayoutItem>;
  customSections?: Array<{ id: string; label: string }>;
  panels?: Partial<
    Record<'top' | 'left' | 'right' | 'bottom', CookbookLayoutPanel>
  >;
  /** Shell item id to the slot it was moved to. */
  placements?: Record<string, RecipeShellSlot>;
}

/** A widget on an overview page (structural copy of smrt-svelte's `OverviewWidget`). */
export interface CookbookOverviewWidget {
  id: string;
  type: string;
  span: number;
  options: Record<string, string | number | boolean | null>;
  version?: number;
}

/** Structural copy of smrt-svelte's `OverviewOverride` (version 1), checked the same way. */
export interface CookbookOverviewOverride {
  version: 1;
  order?: string[];
  removed?: string[];
  added?: CookbookOverviewWidget[];
  changed?: Record<
    string,
    {
      span?: number;
      options?: Record<string, string | number | boolean | null>;
      version?: number;
    }
  >;
}

export interface CookbookTheme {
  /** A built-in smrt-ui preset name. */
  preset?: string;
  colorScheme?: 'light' | 'dark' | 'system';
  /** A brand colour theme; wins over `preset` while present. */
  custom?: { primary: string; fontFamily?: string };
}

export interface Cookbook {
  $schema: string;
  version: 1;
  /** Optional human name (e.g. for the project `apply` creates). */
  name?: string;
  description?: string;
  /** Recipe ids; requirements already included, sorted. */
  recipes: string[];
  /** Extra models (qualified names) no recipe covers. Absent reads as `[]`. */
  features: string[];
  policies: CookbookPolicyRow[];
  /** Surfaces switched off per qualified model name. */
  exposure?: Record<string, CookbookExposureSurface[]>;
  layout?: CookbookLayout;
  theme?: CookbookTheme;
  /** Customised overview pages keyed by overview id. */
  overviews?: Record<string, CookbookOverviewOverride>;
}
