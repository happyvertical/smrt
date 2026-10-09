import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import { recipesById } from '../recipes/index.ts';
import type { FieldPolicyRow } from '../recipes/policy.ts';
import { withRequirements } from '../recipes/resolve.ts';
import type { ExposureSurface } from '../recipes/types.ts';
import { isSettingRow } from '../settings/app-settings.ts';
import { parseTheme } from '../theme/theme.ts';
import { migrateLegacySections, migrateNavItemIds } from './migrate.ts';
import {
  COOKBOOK_SCHEMA,
  COOKBOOK_VERSION,
  type Cookbook,
  type CookbookResult,
  PREVIOUS_SCHEMA,
} from './types.ts';

const VISIBILITIES = new Set(['basic', 'advanced', 'hidden']);
const SURFACES = new Set<string>(['api', 'mcp', 'cli']);

const fail = (error: string): CookbookResult => ({ ok: false, error });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** One policy row, or the reason it is not one. */
function parseRow(value: unknown, at: string): FieldPolicyRow | string {
  if (!isObject(value)) return `${at} is not an object`;
  const { objectRef, fieldName } = value;
  if (typeof objectRef !== 'string' || !objectRef) {
    return `${at} has no objectRef`;
  }
  if (typeof fieldName !== 'string' || !fieldName) {
    return `${at} has no fieldName`;
  }
  if (value.scopeType !== 'app') return `${at} must have scopeType "app"`;
  const row: FieldPolicyRow = { objectRef, fieldName, scopeType: 'app' };
  for (const key of ['defaultValue', 'help', 'label'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' && v !== null) return `${at}.${key} is invalid`;
    row[key] = v;
  }
  if (value.visibility !== undefined) {
    const v = value.visibility;
    if (v !== null && !(typeof v === 'string' && VISIBILITIES.has(v))) {
      return `${at}.visibility is invalid`;
    }
    row.visibility = v as FieldPolicyRow['visibility'];
  }
  if (value.displayOrder !== undefined) {
    const v = value.displayOrder;
    if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) {
      return `${at}.displayOrder is invalid`;
    }
    row.displayOrder = v;
  }
  if (value.locked !== undefined) {
    if (value.locked !== null && typeof value.locked !== 'boolean') {
      return `${at}.locked is invalid`;
    }
    row.locked = value.locked;
  }
  return row;
}

/** Strictly checked here; the shell's `normalizeShellLayout` is lenient. */
function parseLayout(value: unknown): ShellLayout | string {
  if (!isObject(value) || value.version !== 1) {
    return 'layout must be an object with version 1';
  }
  for (const key of ['sectionOrder', 'hidden'] as const) {
    if (value[key] !== undefined && !isStrings(value[key])) {
      return `layout.${key} must be a list of strings`;
    }
  }
  for (const key of ['itemOrder', 'moved', 'panels'] as const) {
    if (value[key] !== undefined && !isObject(value[key])) {
      return `layout.${key} must be an object`;
    }
  }
  const itemOrder = value.itemOrder;
  if (isObject(itemOrder)) {
    for (const [key, ids] of Object.entries(itemOrder)) {
      if (key === '__proto__' || !isStrings(ids))
        return `layout.itemOrder.${key} must be a list of strings`;
    }
  }
  const moved = value.moved;
  if (isObject(moved)) {
    for (const [key, to] of Object.entries(moved)) {
      if (key === '__proto__' || typeof to !== 'string')
        return `layout.moved.${key} must be a string`;
    }
  }
  return value as unknown as ShellLayout;
}

/**
 * Check an unknown value (a parsed file or stored JSON) and return a
 * normalised cookbook, or one clear sentence saying why not. Strict on
 * purpose: nothing is silently dropped, so a bad file never half-applies.
 */
export function parseCookbook(
  input: unknown,
  options: { dropUnknownRecipes?: boolean } = {},
): CookbookResult {
  if (!isObject(input))
    return fail('This is not a cookbook: expected a JSON object.');

  if (
    input.$schema !== undefined &&
    input.$schema !== COOKBOOK_SCHEMA &&
    input.$schema !== PREVIOUS_SCHEMA
  ) {
    return fail(
      'This is not a cookbook: its "$schema" is not a cookbook schema this planner knows.',
    );
  }

  const { version } = input;
  if (version === undefined) {
    return fail('This is not a cookbook: it has no "version".');
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return fail('The cookbook "version" must be a whole number.');
  }
  if (version > COOKBOOK_VERSION) {
    return fail(
      `This cookbook is version ${version}, newer than this planner understands (${COOKBOOK_VERSION}). Update the planner or re-export it.`,
    );
  }
  if (version !== COOKBOOK_VERSION) {
    return fail(
      `Cookbook version ${version} is not supported (this planner reads version ${COOKBOOK_VERSION}).`,
    );
  }

  if (!isStrings(input.recipes)) {
    return fail('The cookbook "recipes" must be a list of recipe ids.');
  }
  // Ids this version does not know (renamed, removed, or from a newer
  // catalog) are kept in the document, not applied: dropping them here would
  // make the loss permanent on the next save. The store surfaces them.
  const unknown = input.recipes.filter((id) => !recipesById.has(id));
  const recipes = [
    ...new Set([
      ...withRequirements(
        input.recipes.filter((id) => recipesById.has(id)),
        recipesById,
      ),
      ...unknown,
    ]),
  ].sort();
  // Absent in files from before features: read as none.
  let features: string[] = [];
  if (input.features !== undefined) {
    if (!isStrings(input.features)) {
      return fail('The cookbook "features" must be a list of model names.');
    }
    const seen = new Set<string>();
    for (const name of input.features) {
      if (seen.has(name)) {
        return fail(`The cookbook lists the feature ${name} more than once.`);
      }
      seen.add(name);
    }
    // Features this catalog lacks are kept like unknown recipes.
    features = [...input.features].sort();
  }
  // Options only mean something for models an added recipe or feature covers, as in the
  // app itself; dropping the rest keeps export then import an exact round trip.
  const covered = new Set([
    ...recipes.flatMap((id) => recipesById.get(id)?.models ?? []),
    ...features,
  ]);

  if (!Array.isArray(input.policies)) {
    return fail('The cookbook "policies" must be a list.');
  }
  const policies: FieldPolicyRow[] = [];
  for (const [index, value] of input.policies.entries()) {
    const row = parseRow(value, `policies[${index}]`);
    if (typeof row === 'string') return fail(`Invalid cookbook: ${row}.`);
    if (covered.has(row.objectRef) || isSettingRow(row)) policies.push(row);
  }

  let exposure: Record<string, ExposureSurface[]> | undefined;
  if (input.exposure !== undefined) {
    if (!isObject(input.exposure)) {
      return fail('The cookbook "exposure" must be an object.');
    }
    const entries: [string, ExposureSurface[]][] = [];
    for (const [ref, surfaces] of Object.entries(input.exposure)) {
      if (!isStrings(surfaces) || !surfaces.every((s) => SURFACES.has(s))) {
        return fail(
          `Invalid cookbook: exposure for ${ref} must list api, mcp or cli.`,
        );
      }
      if (surfaces.length && covered.has(ref)) {
        entries.push([ref, [...surfaces] as ExposureSurface[]]);
      }
    }
    // fromEntries defines own keys, so a "__proto__" ref cannot rewrite the prototype.
    exposure = Object.fromEntries(entries);
  }

  let layout: ShellLayout | undefined;
  if (input.layout !== undefined) {
    const parsed = parseLayout(input.layout);
    if (typeof parsed === 'string') return fail(`Invalid cookbook: ${parsed}.`);
    layout = migrateNavItemIds(migrateLegacySections(parsed));
  }

  let theme: Cookbook['theme'];
  if (input.theme !== undefined) {
    const parsed = parseTheme(input.theme);
    if (parsed.ok) theme = parsed.theme;
    // A saved value from an older build may name a preset this one lacks:
    // keep the rest rather than discarding the visitor's work.
    else if (!options.dropUnknownRecipes) return fail(parsed.error);
  }

  const cookbook: Cookbook = {
    $schema: COOKBOOK_SCHEMA,
    version: COOKBOOK_VERSION,
    recipes,
    features,
    policies,
  };
  if (exposure && Object.keys(exposure).length) cookbook.exposure = exposure;
  if (layout) cookbook.layout = layout;
  if (theme) cookbook.theme = theme;
  return { ok: true, cookbook };
}

/** Parse JSON text, then `parseCookbook` it. */
export function parseCookbookText(
  text: string,
  options: { dropUnknownRecipes?: boolean } = {},
): CookbookResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('This file is not valid JSON.');
  }
  try {
    return parseCookbook(value, options);
  } catch {
    return fail('This file is not a valid cookbook.');
  }
}
