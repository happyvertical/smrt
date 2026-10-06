/**
 * Recipe matcher (#3590).
 *
 * A recipe is a class that extends `SmrtRecipe` and declares static
 * properties. It is not `@smrt()`-decorated and not persisted, so the class
 * scanner (which discovers classes by decorator) never sees it. This module is
 * the second recognizable shape: a **class whose `extends` clause resolves to
 * the `SmrtRecipe` import binding** from smrt-core.
 *
 * It keeps the discipline the agent-surface matcher keeps:
 *
 * - **structural only** — nothing is evaluated and no module is loaded. A
 *   value that is not spelled literally cannot be read;
 * - **never a silent drop** — a recipe that is recognized but unreadable
 *   produces a scan error, and scan errors fail the build;
 * - **binding-aware** — `extends X` matches only when `X` is the local name of
 *   an import of `SmrtRecipe` from `@happyvertical/smrt-core`, so aliased
 *   imports (`import { SmrtRecipe as Recipe }`) and namespace imports
 *   (`Core.SmrtRecipe`) are recognized and a local class that merely shares the
 *   name is not.
 *
 * Model class references (`static models = [Order]`) are resolved to the class
 * they import, through the import binding, never by evaluating anything:
 * a relative specifier selects the scanned class by file, then by name (a
 * barrel re-export keeps the same class name); a bare package specifier is
 * another package's class and is rejected, because a recipe's models belong to
 * its own package.
 */

import { dirname, resolve as resolvePath } from 'node:path';
import type {
  RecipeDefinition,
  RecipeExposureNarrowing,
  RecipeFieldOptions,
  RecipeModelOptions,
} from '@happyvertical/smrt-types';
import { getLineColumn } from './source-location.js';
import type { ResolvedClassDefinition, ScanError } from './types.js';

type AstNode = { type: string } & Record<string, unknown>;

const RECIPE_BASE = 'SmrtRecipe';
const CORE_SPECIFIER_PREFIX = '@happyvertical/smrt-core';

/** `commerce.sales`: dotted, lowercase, at least two segments. */
const RECIPE_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const RECIPE_ID_MAX_LENGTH = 128;

const FIELD_OPTION_KEYS = new Set([
  'default',
  'label',
  'help',
  'order',
  'visibility',
  'locked',
]);
const VISIBILITIES = new Set(['basic', 'advanced', 'hidden']);
const EXPOSURE_TRANSPORTS = ['api', 'mcp', 'cli'] as const;

/**
 * A model reference as authored: the local binding, the name it was exported
 * under, and the module it came from (`null` when declared in the same file).
 */
export interface RawRecipeModelRef {
  /** Identifier as written (`Order`, or `Models.Order` for a namespace). */
  local: string;
  /** Exported name the binding refers to. */
  imported: string;
  /** Import specifier, or `null` for a same-file declaration. */
  source: string | null;
  line?: number;
}

/** One recipe as read from source, before models are resolved. */
export interface RawRecipe {
  className: string;
  filePath: string;
  line?: number;
  id: string | null;
  label: string | null;
  summary: string | null;
  synonyms: string[];
  models: RawRecipeModelRef[];
  nav: Array<{ label: string; model: RawRecipeModelRef; line?: number }>;
  requires: string[];
  /** Options entries in authored order; the key is a model name. */
  options: Array<{ key: string; value: unknown; line?: number }>;
}

/** Cheap pre-filter: a file that never names the base cannot declare one. */
export function sourceMayDeclareRecipe(sourceText: string): boolean {
  return sourceText.includes(RECIPE_BASE);
}

class RecipeReadError extends Error {
  constructor(
    message: string,
    readonly node?: AstNode,
  ) {
    super(message);
  }
}

interface ImportBinding {
  imported: string;
  source: string;
  namespace: boolean;
}

function collectImports(body: AstNode[]): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = (node.source as AstNode | undefined)?.value;
    if (typeof source !== 'string') continue;
    for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
      const local = (spec.local as AstNode | undefined)?.name;
      if (typeof local !== 'string') continue;
      if (spec.type === 'ImportSpecifier') {
        const imported = spec.imported as AstNode | undefined;
        const name = (imported?.name ?? imported?.value) as string | undefined;
        if (typeof name === 'string') {
          bindings.set(local, { imported: name, source, namespace: false });
        }
      } else if (spec.type === 'ImportDefaultSpecifier') {
        bindings.set(local, { imported: local, source, namespace: false });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        bindings.set(local, { imported: '*', source, namespace: true });
      }
    }
  }
  return bindings;
}

function unwrap(node: AstNode): AstNode {
  let current = node;
  for (let depth = 0; depth < 8; depth++) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression'
    ) {
      current = current.expression as AstNode;
      continue;
    }
    break;
  }
  return current;
}

function isRecipeBase(
  superClass: AstNode | null | undefined,
  imports: Map<string, ImportBinding>,
): boolean {
  if (!superClass) return false;
  const node = unwrap(superClass);
  if (node.type === 'Identifier') {
    const binding = imports.get(node.name as string);
    return (
      !!binding &&
      binding.imported === RECIPE_BASE &&
      binding.source.startsWith(CORE_SPECIFIER_PREFIX)
    );
  }
  if (node.type === 'MemberExpression' && node.computed !== true) {
    const object = node.object as AstNode;
    const property = node.property as AstNode;
    const binding =
      object.type === 'Identifier'
        ? imports.get(object.name as string)
        : undefined;
    return (
      !!binding &&
      binding.namespace &&
      binding.source.startsWith(CORE_SPECIFIER_PREFIX) &&
      property.name === RECIPE_BASE
    );
  }
  return false;
}

function keyName(node: AstNode): string | null {
  if (node.computed === true) return null;
  const key = node.key as AstNode | undefined;
  if (!key) return null;
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function stringValue(node: AstNode, what: string): string {
  const value = unwrap(node);
  if (value.type === 'Literal' && typeof value.value === 'string') {
    return value.value;
  }
  if (
    value.type === 'TemplateLiteral' &&
    (value.expressions as unknown[]).length === 0
  ) {
    const quasi = (value.quasis as AstNode[])[0];
    const cooked = (quasi?.value as { cooked?: string } | undefined)?.cooked;
    if (typeof cooked === 'string') return cooked;
  }
  throw new RecipeReadError(`${what} must be a string literal`, node);
}

function arrayElements(node: AstNode, what: string): AstNode[] {
  const value = unwrap(node);
  if (value.type !== 'ArrayExpression') {
    throw new RecipeReadError(`${what} must be an array literal`, node);
  }
  return (value.elements as Array<AstNode | null>).map((element) => {
    if (!element || element.type === 'SpreadElement') {
      throw new RecipeReadError(
        `${what} must list its entries literally (no spread or holes)`,
        element ?? node,
      );
    }
    return element;
  });
}

function objectEntries(
  node: AstNode,
  what: string,
): Array<{ key: string; value: AstNode; node: AstNode }> {
  const value = unwrap(node);
  if (value.type !== 'ObjectExpression') {
    throw new RecipeReadError(`${what} must be an object literal`, node);
  }
  return (value.properties as AstNode[]).map((property) => {
    if (property.type !== 'Property' || property.kind !== 'init') {
      throw new RecipeReadError(
        `${what} must use plain \`key: value\` properties (no spread, getters, or methods)`,
        property,
      );
    }
    if (property.method === true) {
      throw new RecipeReadError(`${what} cannot contain methods`, property);
    }
    const key = keyName(property);
    if (key === null) {
      throw new RecipeReadError(
        `${what} cannot use computed property keys`,
        property,
      );
    }
    return { key, value: property.value as AstNode, node: property };
  });
}

/** JSON-shaped literal reader for option values. */
function literalValue(node: AstNode, what: string, depth = 0): unknown {
  if (depth > 16) {
    throw new RecipeReadError(`${what} is nested too deeply`, node);
  }
  const value = unwrap(node);
  switch (value.type) {
    case 'Literal':
      if (value.regex || typeof value.value === 'bigint') break;
      return value.value;
    case 'TemplateLiteral':
      return stringValue(value, what);
    case 'UnaryExpression': {
      const argument = unwrap(value.argument as AstNode);
      if (
        (value.operator === '-' || value.operator === '+') &&
        argument.type === 'Literal' &&
        typeof argument.value === 'number'
      ) {
        return value.operator === '-' ? -argument.value : argument.value;
      }
      break;
    }
    case 'ArrayExpression':
      return arrayElements(value, what).map((element) =>
        literalValue(element, what, depth + 1),
      );
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const entry of objectEntries(value, what)) {
        if (isUnsafeKey(entry.key)) {
          throw new RecipeReadError(
            `${what} cannot use the key \`${entry.key}\``,
            entry.node,
          );
        }
        out[entry.key] = literalValue(entry.value, what, depth + 1);
      }
      return out;
    }
    default:
      break;
  }
  throw new RecipeReadError(
    `${what} must be a literal value; the scanner cannot evaluate expressions`,
    node,
  );
}

function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function modelRef(
  node: AstNode,
  imports: Map<string, ImportBinding>,
  declaredHere: Set<string>,
  what: string,
  sourceText: string,
): RawRecipeModelRef {
  const value = unwrap(node);
  const line = lineOf(sourceText, value);
  if (value.type === 'Identifier') {
    const local = value.name as string;
    const binding = imports.get(local);
    if (binding && !binding.namespace) {
      return {
        local,
        imported: binding.imported,
        source: binding.source,
        line,
      };
    }
    if (declaredHere.has(local)) {
      return { local, imported: local, source: null, line };
    }
    throw new RecipeReadError(
      `${what} \`${local}\` is neither imported nor declared in this file`,
      node,
    );
  }
  if (
    value.type === 'MemberExpression' &&
    value.computed !== true &&
    (value.object as AstNode).type === 'Identifier'
  ) {
    const object = (value.object as AstNode).name as string;
    const binding = imports.get(object);
    const property = (value.property as AstNode).name as string;
    if (binding?.namespace && typeof property === 'string') {
      return {
        local: `${object}.${property}`,
        imported: property,
        source: binding.source,
        line,
      };
    }
  }
  throw new RecipeReadError(
    `${what} must be a class reference (an imported or same-file class identifier), not an expression or a string`,
    node,
  );
}

function lineOf(sourceText: string, node: AstNode): number | undefined {
  const start = node.start;
  return typeof start === 'number'
    ? getLineColumn(sourceText, start)?.line
    : undefined;
}

/**
 * Find every `SmrtRecipe` subclass in a parsed module and read its statics.
 * Read errors are returned, never swallowed.
 */
export function extractRecipes(input: {
  body: unknown[];
  sourceText: string;
  filePath: string;
}): { recipes: RawRecipe[]; errors: ScanError[] } {
  const body = input.body as AstNode[];
  const imports = collectImports(body);
  const recipes: RawRecipe[] = [];
  const errors: ScanError[] = [];
  const classes: AstNode[] = [];
  const declaredHere = new Set<string>();

  for (const statement of body) {
    let node = statement;
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportDefaultDeclaration') &&
      node.declaration
    ) {
      node = node.declaration as AstNode;
    }
    if (node.type === 'ClassDeclaration') {
      classes.push(node);
      const name = (node.id as AstNode | undefined)?.name;
      if (typeof name === 'string') declaredHere.add(name);
    }
  }

  for (const node of classes) {
    if (!isRecipeBase(node.superClass as AstNode | null, imports)) continue;
    const className = ((node.id as AstNode | undefined)?.name ??
      'AnonymousRecipe') as string;
    const report = (message: string, at?: AstNode) => {
      const loc =
        typeof at?.start === 'number'
          ? getLineColumn(input.sourceText, at.start)
          : undefined;
      errors.push({
        message: `Recipe ${className}: ${message}`,
        filePath: input.filePath,
        line: loc?.line,
        column: loc?.column,
        severity: 'error',
      });
    };

    const recipe: RawRecipe = {
      className,
      filePath: input.filePath,
      line: lineOf(input.sourceText, node),
      id: null,
      label: null,
      summary: null,
      synonyms: [],
      models: [],
      nav: [],
      requires: [],
      options: [],
    };
    const seen = new Set<string>();

    for (const member of (node.body as { body: AstNode[] }).body) {
      if (member.type !== 'PropertyDefinition' || member.static !== true) {
        continue;
      }
      const name = keyName(member);
      if (!name || !member.value) continue;
      const value = member.value as AstNode;
      try {
        switch (name) {
          case 'id':
            recipe.id = stringValue(value, 'static id');
            break;
          case 'label':
            recipe.label = stringValue(value, 'static label');
            break;
          case 'summary':
            recipe.summary = stringValue(value, 'static summary');
            break;
          case 'synonyms':
            recipe.synonyms = arrayElements(value, 'static synonyms').map(
              (entry) => stringValue(entry, 'static synonyms entries'),
            );
            break;
          case 'requires':
            recipe.requires = arrayElements(value, 'static requires').map(
              (entry) => stringValue(entry, 'static requires entries'),
            );
            break;
          case 'models':
            recipe.models = arrayElements(value, 'static models').map((entry) =>
              modelRef(
                entry,
                imports,
                declaredHere,
                'static models entry',
                input.sourceText,
              ),
            );
            break;
          case 'nav':
            recipe.nav = arrayElements(value, 'static nav').map((entry) => {
              const fields = objectEntries(entry, 'static nav entries');
              const label = fields.find((field) => field.key === 'label');
              const model = fields.find((field) => field.key === 'model');
              const extra = fields.find(
                (field) => field.key !== 'label' && field.key !== 'model',
              );
              if (extra) {
                throw new RecipeReadError(
                  `static nav entries accept only \`label\` and \`model\`, not \`${extra.key}\``,
                  extra.node,
                );
              }
              if (!label || !model) {
                throw new RecipeReadError(
                  'static nav entries need both `label` and `model`',
                  entry,
                );
              }
              return {
                label: stringValue(label.value, 'static nav label'),
                model: modelRef(
                  model.value,
                  imports,
                  declaredHere,
                  'static nav model',
                  input.sourceText,
                ),
                line: lineOf(input.sourceText, entry),
              };
            });
            break;
          case 'options':
            recipe.options = objectEntries(value, 'static options').map(
              (entry) => ({
                key: entry.key,
                value: literalValue(entry.value, 'static options'),
                line: lineOf(input.sourceText, entry.node),
              }),
            );
            break;
          default:
            continue;
        }
        seen.add(name);
      } catch (error) {
        if (!(error instanceof RecipeReadError)) throw error;
        report(error.message, error.node ?? member);
      }
    }

    for (const required of ['id', 'label', 'summary', 'models'] as const) {
      if (!seen.has(required)) {
        report(
          `must declare a readable \`static ${required}\``,
          node.id as AstNode,
        );
      }
    }
    recipes.push(recipe);
  }

  return { recipes, errors };
}

// ============================================================================
// Resolution and validation
// ============================================================================

function stripExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?|svelte)$/, '');
}

function isRelativeSpecifier(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

/**
 * A specifier that names another package: bare, and not one of the common
 * in-project alias forms (`$lib/...`, `~/...`, `#internal`, `@/...`).
 */
function isExternalPackageSpecifier(source: string): boolean {
  if (isRelativeSpecifier(source) || source.startsWith('/')) return false;
  if (/^[$~#]/.test(source) || source.startsWith('@/')) return false;
  return true;
}

function resolveModel(
  ref: RawRecipeModelRef,
  recipe: RawRecipe,
  classes: ResolvedClassDefinition[],
  what: string,
): ResolvedClassDefinition {
  const byName = classes.filter(
    (candidate) => candidate.className === ref.imported,
  );
  let candidates = byName;
  if (ref.source === null) {
    candidates = byName.filter((c) => c.filePath === recipe.filePath);
  } else if (isExternalPackageSpecifier(ref.source)) {
    throw new RecipeReadError(
      `${what} \`${ref.local}\` is imported from \`${ref.source}\`, another package; a recipe's models must belong to its own package`,
    );
  } else if (isRelativeSpecifier(ref.source)) {
    const target = stripExtension(
      resolvePath(dirname(recipe.filePath), ref.source),
    );
    const byFile = byName.filter((c) => {
      const file = stripExtension(c.filePath);
      return file === target || file === `${target}/index`;
    });
    // A barrel re-export keeps the class name but not the file.
    candidates = byFile.length > 0 ? byFile : byName;
  }
  if (candidates.length === 0) {
    throw new RecipeReadError(
      `${what} \`${ref.local}\` does not resolve to a model class scanned in this package`,
    );
  }
  if (candidates.length > 1) {
    throw new RecipeReadError(
      `${what} \`${ref.local}\` is ambiguous: ${candidates.length} scanned classes are named \`${ref.imported}\``,
    );
  }
  return candidates[0];
}

function isNarrowing(value: unknown): value is RecipeExposureNarrowing {
  if (value === false) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const exclude = (value as { exclude?: unknown }).exclude;
  return (
    keys.length === 1 &&
    keys[0] === 'exclude' &&
    Array.isArray(exclude) &&
    exclude.every((entry) => typeof entry === 'string')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate one model's options, reporting EVERY problem rather than the first
 * so an author fixes a recipe in one pass.
 */
function readModelOptions(
  raw: unknown,
  model: ResolvedClassDefinition,
  where: string,
  bad: (message: string) => void,
): RecipeModelOptions | undefined {
  if (!isPlainObject(raw)) {
    bad(`${where} must be an object`);
    return undefined;
  }
  let ok = true;
  const fail = (message: string) => {
    ok = false;
    bad(message);
  };
  const out: RecipeModelOptions = {};
  const known = new Set(
    model.allFields.filter((f) => !f.isStatic).map((f) => f.name),
  );
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'fields') {
      if (!isPlainObject(value)) {
        fail(`${where}.fields must be an object`);
        continue;
      }
      const fields: Record<string, RecipeFieldOptions> = {};
      for (const [field, hints] of Object.entries(value)) {
        if (!known.has(field)) {
          fail(
            `${where}.fields.${field}: \`${model.className}\` declares no field \`${field}\`; options only refine fields the model already declares`,
          );
          continue;
        }
        if (!isPlainObject(hints)) {
          fail(`${where}.fields.${field} must be an object`);
          continue;
        }
        const entry: Record<string, unknown> = {};
        for (const [hint, hintValue] of Object.entries(hints)) {
          const at = `${where}.fields.${field}.${hint}`;
          if (!FIELD_OPTION_KEYS.has(hint)) {
            fail(
              `${at} is not a field option; use default, label, help, order, visibility, or locked`,
            );
          } else if (
            (hint === 'label' || hint === 'help') &&
            typeof hintValue !== 'string'
          ) {
            fail(`${at} must be a string`);
          } else if (
            hint === 'order' &&
            (typeof hintValue !== 'number' || !Number.isFinite(hintValue))
          ) {
            fail(`${at} must be a finite number`);
          } else if (hint === 'locked' && typeof hintValue !== 'boolean') {
            fail(`${at} must be a boolean`);
          } else if (
            hint === 'visibility' &&
            !(typeof hintValue === 'string' && VISIBILITIES.has(hintValue))
          ) {
            fail(`${at} must be one of basic, advanced, hidden`);
          } else {
            entry[hint] = hintValue;
          }
        }
        fields[field] = entry as RecipeFieldOptions;
      }
      out.fields = fields;
    } else if (key === 'exposure') {
      if (!isPlainObject(value)) {
        fail(`${where}.exposure must be an object`);
        continue;
      }
      const exposure: NonNullable<RecipeModelOptions['exposure']> = {};
      for (const [transport, narrowing] of Object.entries(value)) {
        if (!(EXPOSURE_TRANSPORTS as readonly string[]).includes(transport)) {
          fail(
            `${where}.exposure.${transport} is not a transport; use api, mcp, or cli`,
          );
        } else if (!isNarrowing(narrowing)) {
          fail(
            `${where}.exposure.${transport} may only be \`false\` or \`{ exclude: string[] }\`: options narrow exposure and never widen it, so \`true\` and \`include\` are rejected`,
          );
        } else {
          exposure[transport as (typeof EXPOSURE_TRANSPORTS)[number]] =
            narrowing;
        }
      }
      out.exposure = exposure;
    } else {
      fail(
        `${where}.${key} is not a model option; use \`fields\` or \`exposure\``,
      );
    }
  }
  return ok ? out : undefined;
}

/**
 * Resolve every raw recipe against the scanned classes and validate the set.
 *
 * Model names in the result are class names; qualification with the package
 * name belongs to the manifest adapter, which knows it. Errors carry the
 * recipe's file and line and fail the build like any other scan error.
 */
export function resolveRecipes(
  raws: RawRecipe[],
  classes: ResolvedClassDefinition[],
): { recipes: RecipeDefinition[]; errors: ScanError[] } {
  const errors: ScanError[] = [];
  const recipes: RecipeDefinition[] = [];
  const ids = new Map<string, RawRecipe>();

  for (const raw of raws) {
    const report = (message: string, line?: number) =>
      errors.push({
        message: `Recipe ${raw.className}: ${message}`,
        filePath: raw.filePath,
        line: line ?? raw.line,
        severity: 'error',
      });
    const attempt = <T>(work: () => T, line?: number): T | undefined => {
      try {
        return work();
      } catch (error) {
        if (!(error instanceof RecipeReadError)) throw error;
        report(error.message, line);
        return undefined;
      }
    };

    if (raw.id === null || raw.label === null || raw.summary === null) {
      // Missing statics were already reported at extraction.
      continue;
    }
    const id = raw.id;
    if (id.length > RECIPE_ID_MAX_LENGTH || !RECIPE_ID_PATTERN.test(id)) {
      report(
        `id \`${id}\` must be dotted lowercase segments such as \`commerce.sales\``,
      );
    }
    const first = ids.get(id);
    if (first) {
      report(
        `id \`${id}\` is already declared by ${first.className} (${first.filePath})`,
      );
    } else {
      ids.set(id, raw);
    }
    if (raw.label.trim() === '') report('label must not be empty');
    if (raw.models.length === 0) report('models must list at least one model');

    // Resolve models; remember the class each local name denotes.
    const byLocal = new Map<string, ResolvedClassDefinition>();
    const models: ResolvedClassDefinition[] = [];
    for (const ref of raw.models) {
      const model = attempt(
        () => resolveModel(ref, raw, classes, 'static models entry'),
        ref.line,
      );
      if (!model) continue;
      if (models.includes(model)) {
        report(`models lists \`${model.className}\` more than once`, ref.line);
        continue;
      }
      models.push(model);
      byLocal.set(ref.local, model);
      byLocal.set(model.className, model);
    }

    const nav: RecipeDefinition['nav'] = [];
    for (const entry of raw.nav) {
      const model = attempt(
        () => resolveModel(entry.model, raw, classes, 'static nav model'),
        entry.line,
      );
      if (!model) continue;
      if (!models.includes(model)) {
        report(
          `nav entry \`${entry.label}\` points at \`${model.className}\`, which is not listed in models`,
          entry.line,
        );
        continue;
      }
      nav.push({ label: entry.label, model: model.className });
    }

    const requires: string[] = [];
    for (const required of raw.requires) {
      if (
        required.length > RECIPE_ID_MAX_LENGTH ||
        !RECIPE_ID_PATTERN.test(required)
      ) {
        report(`requires \`${required}\` is not a recipe id`);
      } else if (required === id) {
        report('a recipe cannot require itself');
      } else if (requires.includes(required)) {
        report(`requires lists \`${required}\` more than once`);
      } else {
        requires.push(required);
      }
    }

    let options: Record<string, RecipeModelOptions> | undefined;
    for (const entry of raw.options) {
      const model = byLocal.get(entry.key);
      if (!model) {
        report(
          `options.${entry.key} does not name one of the recipe's models`,
          entry.line,
        );
        continue;
      }
      const read = readModelOptions(
        entry.value,
        model,
        `options.${entry.key}`,
        (message) => report(message, entry.line),
      );
      if (read) {
        options ??= {};
        if (options[model.className]) {
          report(
            `options names \`${model.className}\` more than once`,
            entry.line,
          );
        } else {
          options[model.className] = read;
        }
      }
    }

    recipes.push({
      id,
      className: raw.className,
      label: raw.label,
      summary: raw.summary,
      synonyms: raw.synonyms,
      models: models.map((model) => model.className),
      nav,
      requires,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    });
  }

  // `requires` cycles among this package's own recipes.
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const reported = new Set<string>();
  const visit = (recipe: RecipeDefinition, trail: string[]) => {
    if (trail.includes(recipe.id)) {
      const cycle = [...trail.slice(trail.indexOf(recipe.id)), recipe.id];
      const key = [...cycle].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        const raw = ids.get(recipe.id);
        errors.push({
          message: `Recipe ${recipe.className}: requires cycle ${cycle.join(' -> ')}`,
          filePath: raw?.filePath ?? '',
          line: raw?.line,
          severity: 'error',
        });
      }
      return;
    }
    for (const required of recipe.requires) {
      const next = byId.get(required);
      if (next) visit(next, [...trail, recipe.id]);
    }
  };
  for (const recipe of recipes) visit(recipe, []);

  recipes.sort((a, b) => a.id.localeCompare(b.id));
  return { recipes, errors };
}
