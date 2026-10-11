import type {
  Cookbook,
  CookbookExposureSurface,
  CookbookLayout,
  CookbookOverviewOverride,
  CookbookOverviewWidget,
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
  /** Built-in or host-registered theme preset ids. */
  themePresets?: Iterable<string>;
  /** Manifest-derived ids the cookbook layout may reference. */
  layout?: {
    sections?: Iterable<string>;
    items?: Iterable<string>;
  };
  /** Overview page ids defined by the resolved app shell. */
  overviewIds?: Iterable<string>;
  /**
   * Validate and canonicalize one structurally valid override against its page
   * definition and widget registry. The callback is trusted host code; the
   * cookbook value remains plain data and is never executed.
   */
  validateOverview?: (
    id: string,
    override: CookbookOverviewOverride,
  ) => CookbookOverviewValidation;
}

export interface CookbookDiagnostic {
  severity: 'error' | 'warning';
  /** Stable machine-readable category. Host validators may add their own. */
  code: string;
  /** Path into the cookbook, using the existing dotted/indexed notation. */
  path: string;
  message: string;
}

export type CookbookOverviewValidation =
  | {
      ok: true;
      /** `null` means the canonical override is empty and should be omitted. */
      override: CookbookOverviewOverride | null;
      diagnostics?: readonly CookbookDiagnostic[];
    }
  | { ok: false; diagnostics: readonly CookbookDiagnostic[] };

export type CookbookValidation =
  | {
      ok: true;
      cookbook: Cookbook;
      warnings: string[];
      diagnostics: CookbookDiagnostic[];
    }
  | { ok: false; errors: string[]; diagnostics: CookbookDiagnostic[] };

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

const add = (
  diagnostics: CookbookDiagnostic[],
  severity: CookbookDiagnostic['severity'],
  code: string,
  path: string,
  message: string,
): void => {
  diagnostics.push({ severity, code, path, message });
};

const error = (
  diagnostics: CookbookDiagnostic[],
  code: string,
  path: string,
  message: string,
): void => add(diagnostics, 'error', code, path, message);

const warning = (
  diagnostics: CookbookDiagnostic[],
  code: string,
  path: string,
  message: string,
): void => add(diagnostics, 'warning', code, path, message);

function checkPolicy(
  value: unknown,
  at: string,
  diagnostics: CookbookDiagnostic[],
) {
  if (!isObject(value))
    return error(diagnostics, 'invalid_type', at, `${at} must be an object`);
  for (const key of ['objectRef', 'fieldName'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) {
      error(
        diagnostics,
        'invalid_value',
        `${at}.${key}`,
        `${at}.${key} must be a non-empty string`,
      );
    }
  }
  if (value.scopeType !== 'app')
    error(
      diagnostics,
      'invalid_value',
      `${at}.scopeType`,
      `${at}.scopeType must be "app"`,
    );
  for (const key of ['defaultValue', 'help', 'label'] as const) {
    const v = value[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      error(
        diagnostics,
        'invalid_type',
        `${at}.${key}`,
        `${at}.${key} must be a string or null`,
      );
    }
  }
  const vis = value.visibility;
  if (vis != null && !(typeof vis === 'string' && VISIBILITIES.has(vis))) {
    error(
      diagnostics,
      'invalid_value',
      `${at}.visibility`,
      `${at}.visibility must be basic, advanced or hidden`,
    );
  }
  const order = value.displayOrder;
  if (order != null && !(typeof order === 'number' && Number.isFinite(order))) {
    error(
      diagnostics,
      'invalid_value',
      `${at}.displayOrder`,
      `${at}.displayOrder must be a finite number`,
    );
  }
  if (value.locked != null && typeof value.locked !== 'boolean') {
    error(
      diagnostics,
      'invalid_type',
      `${at}.locked`,
      `${at}.locked must be a boolean`,
    );
  }
}

function checkLayout(value: unknown, diagnostics: CookbookDiagnostic[]) {
  if (!isObject(value) || value.version !== 1) {
    return error(
      diagnostics,
      'invalid_value',
      'layout',
      'layout must be an object with version 1',
    );
  }
  for (const key of ['sectionOrder', 'hidden'] as const) {
    if (value[key] !== undefined && !isStrings(value[key])) {
      error(
        diagnostics,
        'invalid_type',
        `layout.${key}`,
        `layout.${key} must be a list of strings`,
      );
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
      error(
        diagnostics,
        'invalid_type',
        `layout.${key}`,
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
      error(
        diagnostics,
        'invalid_type',
        `layout.${key}`,
        `layout.${key} must map ids to objects`,
      );
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
    error(
      diagnostics,
      'invalid_type',
      'layout.customSections',
      'layout.customSections must be a list of { id, label }',
    );
  }
}

function checkTheme(value: unknown, diagnostics: CookbookDiagnostic[]) {
  if (!isObject(value))
    return error(
      diagnostics,
      'invalid_type',
      'theme',
      'theme must be an object',
    );
  if (value.preset !== undefined && typeof value.preset !== 'string') {
    error(
      diagnostics,
      'invalid_type',
      'theme.preset',
      'theme.preset must be a string',
    );
  }
  if (
    value.colorScheme !== undefined &&
    !(typeof value.colorScheme === 'string' && SCHEMES.has(value.colorScheme))
  ) {
    error(
      diagnostics,
      'invalid_value',
      'theme.colorScheme',
      'theme.colorScheme must be light, dark or system',
    );
  }
  const custom = value.custom;
  if (custom !== undefined) {
    if (!isObject(custom) || typeof custom.primary !== 'string') {
      error(
        diagnostics,
        'invalid_value',
        'theme.custom',
        'theme.custom must be an object with a string primary',
      );
    } else if (!/^#[0-9a-fA-F]{6}$/.test(custom.primary)) {
      error(
        diagnostics,
        'invalid_value',
        'theme.custom.primary',
        'theme.custom.primary must be a hex colour like #c2410c',
      );
    } else if (
      custom.fontFamily !== undefined &&
      typeof custom.fontFamily !== 'string'
    ) {
      error(
        diagnostics,
        'invalid_type',
        'theme.custom.fontFamily',
        'theme.custom.fontFamily must be a string',
      );
    }
  }
}

const OVERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const WIDGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WIDGET_TYPE = /^[a-z][a-z0-9-]{0,31}$/;

const isOptionValue = (value: unknown) =>
  value === null ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  typeof value === 'boolean';

function normalizeOverviewWidget(
  value: unknown,
  at: string,
  diagnostics: CookbookDiagnostic[],
): CookbookOverviewWidget | null {
  if (!isObject(value)) {
    warning(diagnostics, 'malformed_overview_widget', at, `${at} was dropped`);
    return null;
  }
  const valid = [
    typeof value.id === 'string' && WIDGET_ID.test(value.id),
    typeof value.type === 'string' && WIDGET_TYPE.test(value.type),
    typeof value.span === 'number' &&
      Number.isInteger(value.span) &&
      value.span >= 1 &&
      value.span <= 4,
    isObject(value.options) &&
      Object.values(value.options).every(isOptionValue),
    value.version === undefined ||
      (typeof value.version === 'number' &&
        Number.isInteger(value.version) &&
        value.version >= 1),
  ];
  if (valid.every(Boolean)) return value as unknown as CookbookOverviewWidget;
  warning(
    diagnostics,
    'malformed_overview_widget',
    at,
    `${at} was dropped because it is not a valid overview widget`,
  );
  return null;
}

function normalizeOverviewPatch(
  value: unknown,
  at: string,
  diagnostics: CookbookDiagnostic[],
): NonNullable<CookbookOverviewOverride['changed']>[string] | null {
  if (!isObject(value)) {
    warning(diagnostics, 'malformed_overview_change', at, `${at} was dropped`);
    return null;
  }
  const valid =
    (value.span === undefined ||
      (typeof value.span === 'number' &&
        Number.isInteger(value.span) &&
        value.span >= 1 &&
        value.span <= 4)) &&
    (value.options === undefined ||
      (isObject(value.options) &&
        Object.values(value.options).every(isOptionValue))) &&
    (value.version === undefined ||
      (typeof value.version === 'number' &&
        Number.isInteger(value.version) &&
        value.version >= 1));
  if (valid) {
    return value as NonNullable<CookbookOverviewOverride['changed']>[string];
  }
  warning(
    diagnostics,
    'malformed_overview_change',
    at,
    `${at} was dropped because it is not a valid widget change`,
  );
  return null;
}

function normalizeOverview(
  value: unknown,
  at: string,
  diagnostics: CookbookDiagnostic[],
): CookbookOverviewOverride | null {
  if (!isObject(value) || value.version !== 1) {
    warning(
      diagnostics,
      'malformed_overview',
      at,
      `${at} was dropped because it must be an object with version 1`,
    );
    return null;
  }
  const override = {
    ...value,
    version: 1,
  } as unknown as CookbookOverviewOverride;
  for (const key of ['order', 'removed'] as const) {
    if (value[key] !== undefined && !isStrings(value[key])) {
      warning(
        diagnostics,
        'malformed_overview_list',
        `${at}.${key}`,
        `${at}.${key} was dropped because it must be a list of strings`,
      );
      delete override[key];
    } else if (value[key] !== undefined) {
      override[key] = [...new Set(value[key])];
    }
  }
  if (value.added !== undefined) {
    if (!Array.isArray(value.added)) {
      warning(
        diagnostics,
        'malformed_overview_widgets',
        `${at}.added`,
        `${at}.added was dropped because it must be a list of widgets`,
      );
      delete override.added;
    } else {
      const added = value.added.flatMap((widget, index) => {
        const normalized = normalizeOverviewWidget(
          widget,
          `${at}.added[${index}]`,
          diagnostics,
        );
        return normalized ? [normalized] : [];
      });
      if (added.length) override.added = added;
      else delete override.added;
    }
  }
  if (value.changed !== undefined) {
    if (!isObject(value.changed) || Object.hasOwn(value.changed, '__proto__')) {
      warning(
        diagnostics,
        'malformed_overview_changes',
        `${at}.changed`,
        `${at}.changed was dropped because it must map widget ids to objects`,
      );
      delete override.changed;
    } else {
      const changed: NonNullable<CookbookOverviewOverride['changed']> = {};
      for (const [id, patch] of Object.entries(value.changed)) {
        if (!WIDGET_ID.test(id)) {
          warning(
            diagnostics,
            'malformed_overview_change',
            `${at}.changed.${id}`,
            `${at}.changed.${id} was dropped because its widget id is invalid`,
          );
          continue;
        }
        const normalized = normalizeOverviewPatch(
          patch,
          `${at}.changed.${id}`,
          diagnostics,
        );
        if (normalized) changed[id] = normalized;
      }
      if (Object.keys(changed).length) override.changed = changed;
      else delete override.changed;
    }
  }
  return override;
}

/**
 * Structural validation of an unknown value (parsed JSON). Returns the
 * normalised document (legacy `$schema` rewritten, `features` defaulted,
 * recipes sorted and unique) or every problem found, each a readable line
 * naming the path. Unknown top-level keys are kept (additive fields in v1).
 *
 * Deep checks use optional host-supplied catalogs. A structurally valid
 * cookbook remains portable when those catalogs are absent. Invalid overview
 * entries are dropped and reported, following the v1 overview contract.
 */
export function validateCookbook(
  input: unknown,
  options: CookbookValidateOptions = {},
): CookbookValidation {
  const diagnostics: CookbookDiagnostic[] = [];
  if (!isObject(input)) {
    error(diagnostics, 'invalid_type', '', 'expected a JSON object');
    return { ok: false, errors: ['expected a JSON object'], diagnostics };
  }

  const { $schema, version } = input;
  if (
    $schema !== undefined &&
    $schema !== COOKBOOK_SCHEMA_URL &&
    $schema !== COOKBOOK_LEGACY_SCHEMA_URL
  ) {
    error(
      diagnostics,
      'invalid_schema',
      '$schema',
      `$schema must be ${COOKBOOK_SCHEMA_URL}`,
    );
  }
  if (version === undefined) {
    error(diagnostics, 'missing_field', 'version', 'version is required');
  } else if (typeof version !== 'number' || !Number.isInteger(version)) {
    error(
      diagnostics,
      'invalid_type',
      'version',
      'version must be a whole number',
    );
  } else if (version > COOKBOOK_VERSION) {
    error(
      diagnostics,
      'unsupported_version',
      'version',
      `version ${version} is newer than this reader understands (${COOKBOOK_VERSION})`,
    );
  } else if (version !== COOKBOOK_VERSION) {
    error(
      diagnostics,
      'unsupported_version',
      'version',
      `version ${version} is not supported`,
    );
  }
  if ($schema === COOKBOOK_LEGACY_SCHEMA_URL) {
    warning(
      diagnostics,
      'migrated_schema',
      '$schema',
      '$schema uses the legacy blueprint URL; migrated',
    );
  }

  for (const key of ['name', 'description'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      error(diagnostics, 'invalid_type', key, `${key} must be a string`);
    }
  }

  let recipes: string[] = [];
  if (!isStrings(input.recipes)) {
    error(
      diagnostics,
      'invalid_type',
      'recipes',
      'recipes must be a list of recipe ids',
    );
  } else {
    recipes = [...new Set(input.recipes)].sort();
    if (options.recipes) {
      const known = new Set(options.recipes);
      for (const id of recipes) {
        if (!known.has(id))
          error(
            diagnostics,
            'unknown_recipe',
            `recipes[${input.recipes.indexOf(id)}]`,
            `recipes: unknown recipe "${id}"`,
          );
      }
    }
  }

  let features: string[] = [];
  if (input.features !== undefined) {
    if (!isStrings(input.features)) {
      error(
        diagnostics,
        'invalid_type',
        'features',
        'features must be a list of model names',
      );
    } else {
      features = [...new Set(input.features)].sort();
      if (features.length !== input.features.length) {
        warning(
          diagnostics,
          'duplicate_value',
          'features',
          'features listed a model more than once; deduplicated',
        );
      }
    }
  }

  const policies: CookbookPolicyRow[] = [];
  if (!Array.isArray(input.policies)) {
    error(diagnostics, 'invalid_type', 'policies', 'policies must be a list');
  } else {
    for (const [i, row] of input.policies.entries()) {
      checkPolicy(row, `policies[${i}]`, diagnostics);
      policies.push(row as CookbookPolicyRow);
    }
  }

  if (input.exposure !== undefined) {
    const ok = isStringRecord(
      input.exposure,
      (s) => isStrings(s) && s.every((x) => SURFACES.has(x)),
    );
    if (!ok)
      error(
        diagnostics,
        'invalid_value',
        'exposure',
        'exposure must map model names to lists of api, mcp or cli',
      );
  }
  if (input.layout !== undefined) checkLayout(input.layout, diagnostics);
  if (input.theme !== undefined) checkTheme(input.theme, diagnostics);

  if (isObject(input.theme) && typeof input.theme.preset === 'string') {
    const presets = options.themePresets
      ? new Set(options.themePresets)
      : undefined;
    if (presets && !presets.has(input.theme.preset)) {
      error(
        diagnostics,
        'unknown_theme_preset',
        'theme.preset',
        `Unknown theme preset "${input.theme.preset}".`,
      );
    }
  }

  if (isObject(input.layout) && input.layout.version === 1 && options.layout) {
    const sections = options.layout.sections
      ? new Set(options.layout.sections)
      : undefined;
    const items = options.layout.items
      ? new Set(options.layout.items)
      : undefined;
    if (sections && Array.isArray(input.layout.customSections)) {
      for (const section of input.layout.customSections) {
        if (isObject(section) && typeof section.id === 'string') {
          sections.add(section.id);
        }
      }
    }
    const known = (id: string, kind: 'section' | 'item' | 'either') =>
      kind === 'section'
        ? sections?.has(id) !== false
        : kind === 'item'
          ? items?.has(id) !== false
          : sections?.has(id) === true ||
            items?.has(id) === true ||
            (!sections && !items);
    const check = (
      id: unknown,
      path: string,
      kind: 'section' | 'item' | 'either',
    ) => {
      if (typeof id === 'string' && !known(id, kind)) {
        error(
          diagnostics,
          'unknown_layout_id',
          path,
          `Unknown layout ${kind === 'either' ? 'section or item' : kind} "${id}".`,
        );
      }
    };
    if (isStrings(input.layout.sectionOrder)) {
      input.layout.sectionOrder.forEach((id, index) => {
        check(id, `layout.sectionOrder[${index}]`, 'section');
      });
    }
    if (isStrings(input.layout.hidden)) {
      input.layout.hidden.forEach((id, index) => {
        check(id, `layout.hidden[${index}]`, 'either');
      });
    }
    if (isObject(input.layout.itemOrder)) {
      for (const [section, order] of Object.entries(input.layout.itemOrder)) {
        check(section, `layout.itemOrder.${section}`, 'section');
        if (isStrings(order)) {
          order.forEach((id, index) => {
            check(id, `layout.itemOrder.${section}[${index}]`, 'item');
          });
        }
      }
    }
    if (isObject(input.layout.moved)) {
      for (const [id, section] of Object.entries(input.layout.moved)) {
        check(id, `layout.moved.${id}`, 'item');
        check(section, `layout.moved.${id}`, 'section');
      }
    }
    for (const key of ['sections', 'items'] as const) {
      if (!isObject(input.layout[key])) continue;
      for (const id of Object.keys(input.layout[key])) {
        check(
          id,
          `layout.${key}.${id}`,
          key === 'sections' ? 'section' : 'item',
        );
      }
    }
    if (isObject(input.layout.placements)) {
      for (const id of Object.keys(input.layout.placements)) {
        check(id, `layout.placements.${id}`, 'item');
      }
    }
  }

  const overviews: Record<string, CookbookOverviewOverride> = {};
  if (input.overviews !== undefined) {
    if (
      !isObject(input.overviews) ||
      Object.hasOwn(input.overviews, '__proto__')
    ) {
      error(
        diagnostics,
        'invalid_type',
        'overviews',
        'overviews must map overview ids to overrides',
      );
    } else {
      const overviewIds = options.overviewIds
        ? new Set(options.overviewIds)
        : undefined;
      for (const [id, value] of Object.entries(input.overviews)) {
        const at = `overviews.${id}`;
        if (!OVERVIEW_ID.test(id)) {
          warning(
            diagnostics,
            'invalid_overview_id',
            at,
            `${at} was dropped because its overview id is invalid`,
          );
          continue;
        }
        if (overviewIds && !overviewIds.has(id)) {
          warning(
            diagnostics,
            'unknown_overview',
            at,
            `Unknown overview "${id}" was dropped.`,
          );
          continue;
        }
        const override = normalizeOverview(value, at, diagnostics);
        if (!override) continue;
        if (!options.validateOverview) {
          overviews[id] = override;
          continue;
        }
        let checked: CookbookOverviewValidation;
        try {
          checked = options.validateOverview(id, override);
        } catch {
          warning(
            diagnostics,
            'overview_validation_failed',
            at,
            `Overview "${id}" was dropped because its host validator failed.`,
          );
          continue;
        }
        for (const issue of checked.diagnostics ?? []) {
          warning(diagnostics, issue.code, issue.path || at, issue.message);
        }
        if (!checked.ok && checked.diagnostics.length === 0) {
          warning(
            diagnostics,
            'overview_rejected',
            at,
            `Overview "${id}" was rejected by its host validator and dropped.`,
          );
        }
        if (checked.ok && checked.override) overviews[id] = checked.override;
      }
    }
  }

  const errors = diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);
  if (errors.length) return { ok: false, errors, diagnostics };

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
  delete cookbook.overviews;
  if (Object.keys(overviews).length) cookbook.overviews = overviews;
  const warnings = diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning')
    .map((diagnostic) => diagnostic.message);
  return { ok: true, cookbook, warnings, diagnostics };
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
    return {
      ok: false,
      errors: ['not valid JSON'],
      diagnostics: [
        {
          severity: 'error',
          code: 'invalid_json',
          path: '',
          message: 'not valid JSON',
        },
      ],
    };
  }
  return validateCookbook(value, options);
}
