import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import { humanize } from '../data/format.ts';
import type {
  ExposureSurface,
  RecipeFieldHint,
  RecipeModelHints,
} from './types.ts';

/**
 * Field policies in the vocabulary of `@happyvertical/smrt-fields`
 * (`FieldPolicyOptions`, `FieldPolicyVisibility`). The shapes are mirrored
 * here, not imported: the package becomes a dependency with PGlite in
 * smrt-planner#4, when these rows become real `_smrt_field_policies` rows.
 */
export type FieldPolicyVisibility = 'basic' | 'advanced' | 'hidden';

/**
 * One stored policy row, as `FieldPolicyOptions` names it. Only the keys a
 * person changed are present; everything else inherits from the code seed (the
 * catalog's `ui` hints plus the recipe's hints).
 */
export interface FieldPolicyRow {
  /** Qualified class name, `@scope/pkg:Class`. */
  objectRef: string;
  fieldName: string;
  /** The planner writes app-scope rows only. */
  scopeType: 'app';
  /** ENCODED channel: JSON text exactly as the column stores it (`'"Net 30"'`). */
  defaultValue?: string | null;
  visibility?: FieldPolicyVisibility | null;
  help?: string | null;
  label?: string | null;
  displayOrder?: number | null;
  locked?: boolean | null;
}

/** A field's merged policy: catalog hints, then recipe hints, then rows. */
export interface ResolvedField {
  field: CatalogField;
  visibility: FieldPolicyVisibility;
  label: string;
  help: string | null;
  order: number;
  group: string | null;
  /** Policy-locked: rows may not change it. */
  locked: boolean;
  required: boolean;
  hasDefault: boolean;
  default: unknown;
  /** The required-field invariant forced `basic`. */
  visibilityForced?: boolean;
}

/** A field as the generated list and form show it. */
export interface ViewField extends CatalogField {
  label: string;
  help?: string;
}

/** Fields a person edits: everything the framework does not manage. */
export function policyFields(model: CatalogModel): CatalogField[] {
  return model.fields.filter((f) => !f.system);
}

/** The cold-start rule: with no `ui.basic` marker anywhere, all fields are basic. */
function hasBasicMarkers(fields: readonly CatalogField[]): boolean {
  return fields.some((f) => f.ui?.basic === true);
}

function usableRequiredDefault(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function parseDefault(encoded: string | null | undefined): {
  value: unknown;
} | null {
  if (encoded === null || encoded === undefined) return null;
  try {
    return { value: JSON.parse(encoded) };
  } catch {
    return null;
  }
}

/**
 * Merge a model's field policies: catalog `ui` hints and the recipe's hints are
 * the code seed, `rows` (app scope) layer on top. A locked field ignores rows
 * unless a row explicitly unlocks it. Result is ordered by `order`, then by
 * declaration.
 */
export function resolveFields(
  model: CatalogModel,
  hints: RecipeModelHints | undefined,
  rows: readonly FieldPolicyRow[] = [],
): ResolvedField[] {
  const fields = policyFields(model);
  const markers = hasBasicMarkers(fields);
  const own = new Map(
    rows.filter((r) => r.objectRef === model.id).map((r) => [r.fieldName, r]),
  );

  const resolved = fields.map((field, index): ResolvedField => {
    const hint: RecipeFieldHint = hints?.fields?.[field.name] ?? {};
    let visibility: FieldPolicyVisibility =
      hint.visibility ??
      (!markers || field.ui?.basic === true ? 'basic' : 'advanced');
    let label = hint.label ?? humanize(field.name);
    let help: string | null = hint.help ?? null;
    let order = hint.order ?? field.ui?.order ?? index;
    let locked = hint.locked ?? field.ui?.locked ?? false;
    let hasDefault = 'default' in hint || field.default !== undefined;
    let value: unknown = 'default' in hint ? hint.default : field.default;

    const row = own.get(field.name);
    if (row && (!locked || row.locked === false)) {
      if (row.visibility) visibility = row.visibility;
      if (row.label) label = row.label;
      if (row.help !== undefined) help = row.help || null;
      if (typeof row.displayOrder === 'number') order = row.displayOrder;
      const parsed = parseDefault(row.defaultValue);
      if (parsed) {
        hasDefault = true;
        value = parsed.value;
      }
      if (typeof row.locked === 'boolean') locked = row.locked;
    }

    // The required-field invariant: a required field may only leave the basic
    // tier when a usable default fills it in.
    let visibilityForced: boolean | undefined;
    if (
      field.required &&
      visibility !== 'basic' &&
      !(hasDefault && usableRequiredDefault(value))
    ) {
      visibility = 'basic';
      visibilityForced = true;
    }

    return {
      field,
      visibility,
      label,
      help,
      order,
      group: field.ui?.group ?? null,
      locked,
      required: field.required,
      hasDefault,
      default: value,
      ...(visibilityForced ? { visibilityForced } : {}),
    };
  });

  return resolved
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
    .map(({ entry }) => entry);
}

function primitive(value: unknown): CatalogField['default'] | undefined {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
    ? value
    : undefined;
}

/** The fields the generated list and form show: basic ones, policy applied. */
export function viewFields(resolved: readonly ResolvedField[]): ViewField[] {
  return resolved
    .filter((r) => r.visibility === 'basic')
    .map((r) => {
      const { default: _unused, ...rest } = r.field;
      const fallback = r.hasDefault ? primitive(r.default) : undefined;
      return {
        ...rest,
        ...(fallback !== undefined ? { default: fallback } : {}),
        label: r.label,
        ...(r.help ? { help: r.help } : {}),
      };
    });
}

/**
 * Defaults for fields the views do not show (hidden or off), so records still
 * carry them: the `contractType` discriminator of a shared Contract table.
 */
export function backgroundDefaults(
  resolved: readonly ResolvedField[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const r of resolved) {
    if (r.visibility !== 'basic' && r.hasDefault && r.default !== undefined) {
      values[r.field.name] = r.default;
    }
  }
  return values;
}

// -- Options form -----------------------------------------------------------

/** What the options form edits for one field. */
export interface FieldDraft {
  /** The "use this field" switch. */
  use: boolean;
  label: string;
  help: string;
  default: unknown;
  order: number;
}

export type ExposureDraft = Record<ExposureSurface, boolean>;

export interface ModelDraft {
  fields: Record<string, FieldDraft>;
  exposure: ExposureDraft;
}

export const SURFACES: readonly ExposureSurface[] = ['api', 'mcp', 'cli'];

export const SURFACE_LABEL: Record<ExposureSurface, string> = {
  api: 'REST',
  mcp: 'MCP',
  cli: 'CLI',
};

export function surfaceAvailable(
  model: CatalogModel,
  surface: ExposureSurface,
): boolean {
  const count =
    surface === 'api'
      ? model.rest.length
      : surface === 'mcp'
        ? model.mcp.length
        : model.cli.length;
  return count > 0;
}

export interface ExposureState {
  /** The class declares this surface. */
  available: boolean;
  /** Currently exposed. */
  on: boolean;
  /** Cannot be changed: the class has none, or the recipe already narrowed it. */
  locked: boolean;
}

/**
 * Exposure can only be narrowed: a surface is on when the class declares it,
 * the recipe did not narrow it off, and the person did not switch it off.
 */
export function resolveExposure(
  model: CatalogModel,
  hints: RecipeModelHints | undefined,
  narrowed: readonly ExposureSurface[] = [],
): Record<ExposureSurface, ExposureState> {
  const result = {} as Record<ExposureSurface, ExposureState>;
  for (const surface of SURFACES) {
    const available = surfaceAvailable(model, surface);
    const recipeOff = hints?.exposure?.[surface] === false;
    result[surface] = {
      available,
      on: available && !recipeOff && !narrowed.includes(surface),
      locked: !available || recipeOff,
    };
  }
  return result;
}

/** The model as exposed: narrowed surfaces list nothing. */
export function narrowModel(
  model: CatalogModel,
  exposure: Record<ExposureSurface, ExposureState>,
): CatalogModel {
  const mcp = exposure.mcp.on;
  return {
    ...model,
    rest: exposure.api.on ? model.rest : [],
    mcp: mcp ? model.mcp : [],
    cli: exposure.cli.on ? model.cli : [],
    methods: model.methods.map((m) => ({
      ...m,
      aiCallable: m.aiCallable && mcp,
    })),
  };
}

/** Fields the options form lets a person switch off or edit. */
export function formFields(
  model: CatalogModel,
  hints: RecipeModelHints | undefined,
  rows: readonly FieldPolicyRow[] = [],
): ResolvedField[] {
  return resolveFields(model, hints, rows).filter(
    (r) => hints?.fields?.[r.field.name]?.visibility !== 'hidden',
  );
}

/** Can the "use this field" switch move? Required and locked fields cannot. */
export function isFieldLockedOn(r: ResolvedField): boolean {
  return r.required || r.locked;
}

export function draftFrom(
  model: CatalogModel,
  hints: RecipeModelHints | undefined,
  rows: readonly FieldPolicyRow[],
  narrowed: readonly ExposureSurface[],
): ModelDraft {
  const fields: Record<string, FieldDraft> = {};
  for (const r of formFields(model, hints, rows)) {
    fields[r.field.name] = {
      use: r.visibility === 'basic',
      label: r.label,
      help: r.help ?? '',
      default: r.hasDefault ? r.default : null,
      order: r.order,
    };
  }
  const exposure = resolveExposure(model, hints, narrowed);
  return {
    fields,
    exposure: {
      api: exposure.api.on,
      mcp: exposure.mcp.on,
      cli: exposure.cli.on,
    },
  };
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Turn a draft into app-scope policy rows. Only differences from the code seed
 * are written, so an untouched form writes nothing and a row never repeats a
 * value the seed already gives.
 */
export function rowsFromDraft(
  model: CatalogModel,
  hints: RecipeModelHints | undefined,
  draft: ModelDraft,
): FieldPolicyRow[] {
  const seed = formFields(model, hints);
  const rows: FieldPolicyRow[] = [];
  for (const base of seed) {
    const edited = draft.fields[base.field.name];
    if (!edited || base.locked) continue;
    const row: FieldPolicyRow = {
      objectRef: model.id,
      fieldName: base.field.name,
      scopeType: 'app',
    };
    const use = isFieldLockedOn(base) ? true : edited.use;
    const seedUse = base.visibility === 'basic';
    if (use !== seedUse) row.visibility = use ? 'basic' : 'hidden';
    if (edited.label.trim() && edited.label !== base.label) {
      row.label = edited.label.trim();
    }
    if (edited.help !== (base.help ?? '')) row.help = edited.help || null;
    if (!sameJson(edited.default, base.hasDefault ? base.default : null)) {
      row.defaultValue = JSON.stringify(edited.default ?? null);
    }
    if (edited.order !== base.order) row.displayOrder = edited.order;
    if (Object.keys(row).length > 3) rows.push(row);
  }
  return rows;
}

/** The surfaces a draft switches off, beyond what the recipe already narrowed. */
export function narrowedFromDraft(
  model: CatalogModel,
  hints: RecipeModelHints | undefined,
  draft: ModelDraft,
): ExposureSurface[] {
  const seed = resolveExposure(model, hints);
  return SURFACES.filter(
    (surface) => seed[surface].on && !draft.exposure[surface],
  );
}
