import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import type { FieldPolicyRow } from '../recipes/policy.ts';
import type { ExposureSurface } from '../recipes/types.ts';
import type { ThemeSetting } from '../theme/theme.ts';

/**
 * Placeholder until happyvertical/smrt#3604 publishes the real schema URL.
 * The planner writes it so a file says what it is; it does not fetch it.
 */
export const COOKBOOK_SCHEMA = 'https://s-m-r-t.dev/schemas/cookbook/v1.json';

/**
 * The URL files carried while the document was called a blueprint. Import
 * still accepts it; nothing writes it.
 */
export const PREVIOUS_SCHEMA = 'https://s-m-r-t.dev/schemas/blueprint/v1.json';

export const COOKBOOK_VERSION = 1;

/**
 * Everything a visitor builds, in one portable document. This is the first
 * concrete instance of the format happyvertical/smrt#3604 will pin; the
 * planner's saved state, its JSON export and the localStorage value are all
 * this one shape.
 *
 * Sample or created records are NOT part of it: they are demo data the
 * in-memory `DataSource` reseeds, not something that scaffolds an app.
 */
export interface Cookbook {
  $schema: string;
  version: typeof COOKBOOK_VERSION;
  /** Added recipe ids, sorted; requirements are already included. */
  recipes: string[];
  /**
   * Added feature models (qualified names), sorted and unique: exposed
   * catalog models no recipe covers. Absent in older files, read as `[]`.
   */
  features: string[];
  /** App-scope smrt-fields policy rows (the recipe options). */
  policies: FieldPolicyRow[];
  /**
   * Surfaces switched off per model, keyed by qualified model name. Omitted
   * when nothing is narrowed.
   */
  exposure?: Record<string, ExposureSurface[]>;
  /** The shell layout (smrt-svelte `ShellLayout`), applied by `AppShell`. */
  layout?: ShellLayout;
  /**
   * The app's look: a smrt-ui preset, colour scheme and optional brand colour.
   * Absent in older files, read as the default theme.
   */
  theme?: ThemeSetting;
}

export type CookbookResult =
  | { ok: true; cookbook: Cookbook }
  | { ok: false; error: string };
