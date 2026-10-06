import { recipesById } from '../recipes/index.ts';
import type { FieldPolicyRow } from '../recipes/policy.ts';
import { withRequirements } from '../recipes/resolve.ts';
import type { ExposureSurface } from '../recipes/types.ts';
import type { ShellLayout } from '../upstream/shellLayout.ts';
import {
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  type Blueprint,
  type BlueprintResult,
} from './types.ts';

const VISIBILITIES = new Set(['basic', 'advanced', 'hidden']);
const SURFACES = new Set<string>(['api', 'mcp', 'cli']);

const fail = (error: string): BlueprintResult => ({ ok: false, error });

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

/** `layout` only needs to be the right kind of object until smrt#3603 ships. */
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
  return value as unknown as ShellLayout;
}

/**
 * Check an unknown value (a parsed file or stored JSON) and return a
 * normalised blueprint, or one clear sentence saying why not. Strict on
 * purpose: nothing is silently dropped, so a bad file never half-applies.
 */
export function parseBlueprint(input: unknown): BlueprintResult {
  if (!isObject(input))
    return fail('This is not a blueprint: expected a JSON object.');

  const { version } = input;
  if (version === undefined) {
    return fail('This is not a blueprint: it has no "version".');
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return fail('The blueprint "version" must be a whole number.');
  }
  if (version > BLUEPRINT_VERSION) {
    return fail(
      `This blueprint is version ${version}, newer than this planner understands (${BLUEPRINT_VERSION}). Update the planner or re-export it.`,
    );
  }
  if (version !== BLUEPRINT_VERSION) {
    return fail(
      `Blueprint version ${version} is not supported (this planner reads version ${BLUEPRINT_VERSION}).`,
    );
  }

  if (!isStrings(input.recipes)) {
    return fail('The blueprint "recipes" must be a list of recipe ids.');
  }
  const unknown = input.recipes.filter((id) => !recipesById.has(id));
  if (unknown.length) {
    return fail(`The blueprint names unknown recipes: ${unknown.join(', ')}.`);
  }

  if (!Array.isArray(input.policies)) {
    return fail('The blueprint "policies" must be a list.');
  }
  const policies: FieldPolicyRow[] = [];
  for (const [index, value] of input.policies.entries()) {
    const row = parseRow(value, `policies[${index}]`);
    if (typeof row === 'string') return fail(`Invalid blueprint: ${row}.`);
    policies.push(row);
  }

  let exposure: Record<string, ExposureSurface[]> | undefined;
  if (input.exposure !== undefined) {
    if (!isObject(input.exposure)) {
      return fail('The blueprint "exposure" must be an object.');
    }
    exposure = {};
    for (const [ref, surfaces] of Object.entries(input.exposure)) {
      if (!isStrings(surfaces) || !surfaces.every((s) => SURFACES.has(s))) {
        return fail(
          `Invalid blueprint: exposure for ${ref} must list api, mcp or cli.`,
        );
      }
      if (surfaces.length) exposure[ref] = [...surfaces] as ExposureSurface[];
    }
  }

  let layout: ShellLayout | undefined;
  if (input.layout !== undefined) {
    const parsed = parseLayout(input.layout);
    if (typeof parsed === 'string')
      return fail(`Invalid blueprint: ${parsed}.`);
    layout = parsed;
  }

  const blueprint: Blueprint = {
    $schema: BLUEPRINT_SCHEMA,
    version: BLUEPRINT_VERSION,
    recipes: withRequirements(input.recipes, recipesById),
    policies,
  };
  if (exposure && Object.keys(exposure).length) blueprint.exposure = exposure;
  if (layout) blueprint.layout = layout;
  return { ok: true, blueprint };
}

/** Parse JSON text, then `parseBlueprint` it. */
export function parseBlueprintText(text: string): BlueprintResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('This file is not valid JSON.');
  }
  return parseBlueprint(value);
}
