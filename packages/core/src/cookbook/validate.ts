import type {
  Cookbook,
  CookbookExposureSurface,
  CookbookLayout,
  CookbookOverviewOverride,
  CookbookPolicyRow,
  CookbookTheme,
} from '@happyvertical/smrt-types';

export type { Cookbook } from '@happyvertical/smrt-types';

/** What a v1 document carries in `$schema`. */
export const COOKBOOK_SCHEMA_URL =
  'https://s-m-r-t.dev/schemas/cookbook/v1.json';
/** Accepted on read (the document used to be called a blueprint); never written. */
export const COOKBOOK_LEGACY_SCHEMA_URL =
  'https://s-m-r-t.dev/schemas/blueprint/v1.json';
export const COOKBOOK_VERSION = 1;

export interface CookbookValidateOptions {
  /**
   * The recipe ids that exist (from published manifests). When given, an id
   * outside it is an error. When absent no existence check runs: that is the
   * seam `smrt cookbook validate` fills.
   */
  recipes?: Iterable<string>;
}

export type CookbookValidation =
  | { ok: true; cookbook: Cookbook; warnings: string[] }
  | { ok: false; errors: string[] };

const VISIBILITIES = new Set(['basic', 'advanced', 'hidden']);
const SURFACES = new Set(['api', 'mcp', 'cli']);
const SCHEMES = new Set(['light', 'dark', 'system']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStringRecord = (v: unknown, valid: (x: unknown) => boolean) =>
  isObject(v) &&
  !Object.hasOwn(v, '__proto__') &&
  Object.values(v).every(valid);

function checkPolicy(value: unknown, at: string, errors: string[]) {
  if (!isObject(value)) return errors.push(`${at} must be an object`);
  for (const key of ['objectRef', 'fieldName'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) {
      errors.push(`${at}.${key} must be a non-empty string`);
    }
  }
  if (value.scopeType !== 'app') errors.push(`${at}.scopeType must be "app"`);
  for (const key of ['defaultValue', 'help', 'label'] as const) {
    const v = value[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      errors.push(`${at}.${key} must be a string or null`);
    }
  }
  const vis = value.visibility;
  if (vis != null && !(typeof vis === 'string' && VISIBILITIES.has(vis))) {
    errors.push(`${at}.visibility must be basic, advanced or hidden`);
  }
  const order = value.displayOrder;
  if (order != null && !(typeof order === 'number' && Number.isFinite(order))) {
    errors.push(`${at}.displayOrder must be a finite number`);
  }
  if (value.locked != null && typeof value.locked !== 'boolean') {
    errors.push(`${at}.locked must be a boolean`);
  }
}

function checkLayout(value: unknown, errors: string[]) {
  if (!isObject(value) || value.version !== 1) {
    return errors.push('layout must be an object with version 1');
  }
  for (const key of ['sectionOrder', 'hidden'] as const) {
    if (value[key] !== undefined && !isStrings(value[key])) {
      errors.push(`layout.${key} must be a list of strings`);
    }
  }
  for (const key of ['itemOrder', 'moved', 'placements'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    const ok =
      key === 'itemOrder'
        ? isStringRecord(v, isStrings)
        : isStringRecord(v, (x) => typeof x === 'string');
    if (!ok) {
      errors.push(
        key === 'itemOrder'
          ? 'layout.itemOrder must map ids to lists of strings'
          : `layout.${key} must map ids to strings`,
      );
    }
  }
  for (const key of ['sections', 'items', 'panels'] as const) {
    if (
      value[key] !== undefined &&
      !isStringRecord(value[key], (x) => isObject(x))
    ) {
      errors.push(`layout.${key} must map ids to objects`);
    }
  }
  const custom = value.customSections;
  if (
    custom !== undefined &&
    !(
      Array.isArray(custom) &&
      custom.every(
        (c) =>
          isObject(c) &&
          typeof c.id === 'string' &&
          typeof c.label === 'string',
      )
    )
  ) {
    errors.push('layout.customSections must be a list of { id, label }');
  }
}

function checkTheme(value: unknown, errors: string[]) {
  if (!isObject(value)) return errors.push('theme must be an object');
  if (value.preset !== undefined && typeof value.preset !== 'string') {
    errors.push('theme.preset must be a string');
  }
  if (
    value.colorScheme !== undefined &&
    !(typeof value.colorScheme === 'string' && SCHEMES.has(value.colorScheme))
  ) {
    errors.push('theme.colorScheme must be light, dark or system');
  }
  const custom = value.custom;
  if (custom !== undefined) {
    if (!isObject(custom) || typeof custom.primary !== 'string') {
      errors.push('theme.custom must be an object with a string primary');
    } else if (!/^#[0-9a-fA-F]{6}$/.test(custom.primary)) {
      errors.push('theme.custom.primary must be a hex colour like #c2410c');
    } else if (
      custom.fontFamily !== undefined &&
      typeof custom.fontFamily !== 'string'
    ) {
      errors.push('theme.custom.fontFamily must be a string');
    }
  }
}

function checkOverview(value: unknown, at: string, errors: string[]) {
  if (!isObject(value) || value.version !== 1) {
    return errors.push(`${at} must be an object with version 1`);
  }
  for (const key of ['order', 'removed'] as const) {
    if (value[key] !== undefined && !isStrings(value[key])) {
      errors.push(`${at}.${key} must be a list of strings`);
    }
  }
  const added = value.added;
  if (
    added !== undefined &&
    !(Array.isArray(added) && added.every((w) => isObject(w)))
  ) {
    errors.push(`${at}.added must be a list of widgets`);
  }
  if (
    value.changed !== undefined &&
    !isStringRecord(value.changed, (x) => isObject(x))
  ) {
    errors.push(`${at}.changed must map widget ids to objects`);
  }
}

/**
 * Structural validation of an unknown value (parsed JSON). Returns the
 * normalised document (legacy `$schema` rewritten, `features` defaulted,
 * recipes sorted and unique) or every problem found, each a readable line
 * naming the path. Unknown top-level keys are kept (additive fields in v1).
 *
 * Deep checks that need other packages (overview widgets against a page
 * definition, nav ids against recipes, theme presets) are the consumer's job;
 * recipe existence runs only when `options.recipes` is given.
 */
export function validateCookbook(
  input: unknown,
  options: CookbookValidateOptions = {},
): CookbookValidation {
  if (!isObject(input)) {
    return { ok: false, errors: ['expected a JSON object'] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  const { $schema, version } = input;
  if (
    $schema !== undefined &&
    $schema !== COOKBOOK_SCHEMA_URL &&
    $schema !== COOKBOOK_LEGACY_SCHEMA_URL
  ) {
    errors.push(`$schema must be ${COOKBOOK_SCHEMA_URL}`);
  }
  if (version === undefined) {
    errors.push('version is required');
  } else if (typeof version !== 'number' || !Number.isInteger(version)) {
    errors.push('version must be a whole number');
  } else if (version > COOKBOOK_VERSION) {
    errors.push(
      `version ${version} is newer than this reader understands (${COOKBOOK_VERSION})`,
    );
  } else if (version !== COOKBOOK_VERSION) {
    errors.push(`version ${version} is not supported`);
  }
  if ($schema === COOKBOOK_LEGACY_SCHEMA_URL) {
    warnings.push('$schema uses the legacy blueprint URL; migrated');
  }

  for (const key of ['name', 'description'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }

  let recipes: string[] = [];
  if (!isStrings(input.recipes)) {
    errors.push('recipes must be a list of recipe ids');
  } else {
    recipes = [...new Set(input.recipes)].sort();
    if (options.recipes) {
      const known = new Set(options.recipes);
      for (const id of recipes) {
        if (!known.has(id)) errors.push(`recipes: unknown recipe "${id}"`);
      }
    }
  }

  let features: string[] = [];
  if (input.features !== undefined) {
    if (!isStrings(input.features)) {
      errors.push('features must be a list of model names');
    } else {
      features = [...new Set(input.features)].sort();
      if (features.length !== input.features.length) {
        warnings.push('features listed a model more than once; deduplicated');
      }
    }
  }

  const policies: CookbookPolicyRow[] = [];
  if (!Array.isArray(input.policies)) {
    errors.push('policies must be a list');
  } else {
    for (const [i, row] of input.policies.entries()) {
      checkPolicy(row, `policies[${i}]`, errors);
      policies.push(row as CookbookPolicyRow);
    }
  }

  if (input.exposure !== undefined) {
    const ok = isStringRecord(
      input.exposure,
      (s) => isStrings(s) && s.every((x) => SURFACES.has(x)),
    );
    if (!ok)
      errors.push('exposure must map model names to lists of api, mcp or cli');
  }
  if (input.layout !== undefined) checkLayout(input.layout, errors);
  if (input.theme !== undefined) checkTheme(input.theme, errors);
  if (input.overviews !== undefined) {
    if (
      !isObject(input.overviews) ||
      Object.hasOwn(input.overviews, '__proto__')
    ) {
      errors.push('overviews must map overview ids to overrides');
    } else {
      for (const [id, value] of Object.entries(input.overviews)) {
        checkOverview(value, `overviews.${id}`, errors);
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  const cookbook = {
    ...input,
    $schema: COOKBOOK_SCHEMA_URL,
    version: COOKBOOK_VERSION,
    recipes,
    features,
    policies,
  } as unknown as Cookbook;
  if (input.exposure !== undefined) {
    cookbook.exposure = input.exposure as Record<
      string,
      CookbookExposureSurface[]
    >;
  }
  if (input.layout !== undefined)
    cookbook.layout = input.layout as CookbookLayout;
  if (input.theme !== undefined) cookbook.theme = input.theme as CookbookTheme;
  if (input.overviews !== undefined) {
    cookbook.overviews = input.overviews as Record<
      string,
      CookbookOverviewOverride
    >;
  }
  return { ok: true, cookbook, warnings };
}

/** Parse JSON text, then {@link validateCookbook} it. */
export function parseCookbookText(
  text: string,
  options: CookbookValidateOptions = {},
): CookbookValidation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not valid JSON'] };
  }
  return validateCookbook(value, options);
}
