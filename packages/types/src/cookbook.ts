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
 * `OverviewOverride` are assignable to {@link CookbookLayout} and
 * {@link CookbookOverviewOverride}; those packages own deep validation.
 *
 * Versioning: new optional fields are added within `version: 1`; readers
 * ignore keys they do not know. A breaking change means `version: 2`.
 */

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

/** Structural view of smrt-svelte's `ShellLayout` (version 1). */
export interface CookbookLayout {
  version: 1;
  sectionOrder?: string[];
  itemOrder?: Record<string, string[]>;
  hidden?: string[];
  moved?: Record<string, string>;
  sections?: Record<string, object>;
  items?: Record<string, object>;
  customSections?: Array<{ id: string; label: string }>;
  panels?: Record<string, object>;
  placements?: Record<string, string>;
}

/** Structural view of smrt-svelte's `OverviewOverride` (version 1). */
export interface CookbookOverviewOverride {
  version: 1;
  order?: string[];
  removed?: string[];
  added?: object[];
  changed?: Record<string, object>;
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
