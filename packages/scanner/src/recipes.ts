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

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import type {
  RecipeDefinition,
  RecipeDemoSeed,
  RecipeExportRef,
  RecipeExposureNarrowing,
  RecipeFieldOptions,
  RecipeGroup,
  RecipeHelp,
  RecipeModelOptions,
  RecipeProvider,
  RecipeRuntime,
  RecipeSection,
  RecipeSurface,
} from '@happyvertical/smrt-types';
import {
  RECIPE_RUNTIMES,
  RECIPE_SHELL_SLOTS,
  RECIPE_SURFACE_KINDS,
} from '@happyvertical/smrt-types';
import { getLineColumn } from './source-location.js';
import type { ResolvedClassDefinition, ScanError } from './types.js';

type AstNode = { type: string } & Record<string, unknown>;

const RECIPE_BASE = 'SmrtRecipe';
const CORE_SPECIFIER = '@happyvertical/smrt-core';

/** The core package itself or one of its subpaths (`/browser`), nothing else. */
function isCoreSpecifier(source: string): boolean {
  return source === CORE_SPECIFIER || source.startsWith(`${CORE_SPECIFIER}/`);
}

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
  'required',
]);
const NAV_EXTRA_KEYS = ['icon', 'description', 'key', 'noun'] as const;
const GROUP_KEYS = new Set(['id', 'label', 'summary']);
const SECTION_KEYS = new Set(['id', 'label', 'icon', 'description']);
/** Ids of groups, sections and nav keys: lowercase, digits, `-`, `_`. */
const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ICON_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
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
  nav: Array<{
    label: string;
    model: RawRecipeModelRef;
    line?: number;
    icon?: string;
    description?: string;
    key?: string;
    noun?: string;
    filter?: unknown;
  }>;
  requires: string[];
  /** `static requiresAny`, as authored (shape checked at resolve). */
  requiresAny: { value: unknown; line?: number } | null;
  /** `static group`, as authored (shape checked at resolve). */
  group: { value: unknown; line?: number } | null;
  /** `static section`, as authored (shape checked at resolve). */
  section: { value: unknown; line?: number } | null;
  /** Options entries in authored order; the key is a model name. */
  options: Array<{ key: string; value: unknown; line?: number }>;
  /** `static help`: a path to a Markdown file, relative to the recipe's file. */
  help: { path: string; line?: number } | null;
  /** `static surfaces` / `providers` / `runtime` / `demoSeed`, as authored (#3708). */
  surfaces: { value: unknown; line?: number } | null;
  providers: { value: unknown; line?: number } | null;
  runtime: { value: unknown; line?: number } | null;
  demoSeed: { value: unknown; line?: number } | null;
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
      isCoreSpecifier(binding.source)
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
      isCoreSpecifier(binding.source) &&
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

  // A recipe must extend `SmrtRecipe` directly. Anything that extends another
  // recipe, or declares the base through a class expression, would otherwise
  // vanish from the artifacts with the build still green.
  const recipeNames = new Set<string>();
  for (const node of classes) {
    if (isRecipeBase(node.superClass as AstNode | null, imports)) {
      recipeNames.add(((node.id as AstNode | undefined)?.name ?? '') as string);
    }
  }
  const reportAt = (message: string, at: AstNode) => {
    const loc =
      typeof at.start === 'number'
        ? getLineColumn(input.sourceText, at.start)
        : undefined;
    errors.push({
      message,
      filePath: input.filePath,
      line: loc?.line,
      column: loc?.column,
      severity: 'error',
    });
  };
  for (const node of classes) {
    const base = node.superClass
      ? unwrap(node.superClass as AstNode)
      : undefined;
    if (
      base?.type === 'Identifier' &&
      recipeNames.has(base.name as string) &&
      !isRecipeBase(base, imports)
    ) {
      reportAt(
        `Recipe ${(node.id as AstNode | undefined)?.name ?? 'AnonymousRecipe'}: extends the recipe ${base.name as string}; a recipe must extend SmrtRecipe directly`,
        node,
      );
    }
  }
  for (const found of findClassExpressions(body)) {
    if (isRecipeBase(found.superClass as AstNode | null, imports)) {
      reportAt(
        'Recipe declared as a class expression or inside a block; declare it as a top-level `class X extends SmrtRecipe`',
        found,
      );
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
      requiresAny: null,
      group: null,
      section: null,
      options: [],
      help: null,
      surfaces: null,
      providers: null,
      runtime: null,
      demoSeed: null,
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
                (field) =>
                  field.key !== 'label' &&
                  field.key !== 'model' &&
                  field.key !== 'filter' &&
                  !(NAV_EXTRA_KEYS as readonly string[]).includes(field.key),
              );
              if (extra) {
                throw new RecipeReadError(
                  `static nav entries accept only \`label\`, \`model\`, \`icon\`, \`description\`, \`key\`, \`noun\` and \`filter\`, not \`${extra.key}\``,
                  extra.node,
                );
              }
              const extras: Record<string, string> = {};
              for (const name of NAV_EXTRA_KEYS) {
                const found = fields.find((field) => field.key === name);
                if (found) {
                  extras[name] = stringValue(found.value, `static nav ${name}`);
                }
              }
              const filter = fields.find((field) => field.key === 'filter');
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
                ...extras,
                ...(filter
                  ? {
                      filter: literalValue(filter.value, 'static nav filter'),
                    }
                  : {}),
              };
            });
            break;
          case 'requiresAny':
          case 'group':
          case 'section':
          case 'surfaces':
          case 'providers':
          case 'runtime':
          case 'demoSeed':
            recipe[name] = {
              value: literalValue(value, `static ${name}`),
              line: lineOf(input.sourceText, member),
            };
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
          case 'help':
            recipe.help = {
              path: stringValue(value, 'static help'),
              line: lineOf(input.sourceText, member),
            };
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

const HELP_EXTENSION = '.md';
const FIELD_REF_PATTERN =
  /\{field:([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}/g;

/**
 * Distinct `{field:...}` references in help Markdown, as written, sorted.
 * Mirrors core's `extractFieldRefs` (`recipe-help.ts`): a reference inside an
 * inline code span is code, not a reference. The scanner cannot import core, so
 * core re-derives the list from the same Markdown at manifest generation and
 * fails the build if the two ever disagree.
 */
export function deriveHelpFieldRefs(markdown: string): string[] {
  const refs = new Set<string>();
  for (const block of markdown.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    for (const match of block
      .replace(/`[^`]+`/g, '')
      .matchAll(FIELD_REF_PATTERN)) {
      refs.add(match[1] as string);
    }
  }
  return [...refs].sort();
}

/**
 * Read a recipe's help file. The path is relative to the recipe's own file and
 * must stay beside it or below it, so a recipe cannot reach outside its package.
 */
function readHelp(
  help: NonNullable<RawRecipe['help']>,
  raw: RawRecipe,
): RecipeHelp {
  const fail = (message: string): never => {
    throw new RecipeReadError(`static help ${message}`);
  };
  if (
    help.path.trim() === '' ||
    isAbsolute(help.path) ||
    help.path.split(/[\\/]/).includes('..') ||
    !help.path.toLowerCase().endsWith(HELP_EXTENSION)
  ) {
    return fail(
      `must be a relative path to a ${HELP_EXTENSION} file beside the recipe (got \`${help.path}\`)`,
    );
  }
  const absolute = resolvePath(dirname(raw.filePath), help.path);
  let markdown: string;
  try {
    markdown = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return fail(
      `file \`${help.path}\` cannot be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  markdown = markdown.replace(/\r\n?/g, '\n');
  if (markdown.trim() === '') return fail(`file \`${help.path}\` is empty`);
  return { markdown, fieldRefs: deriveHelpFieldRefs(markdown) };
}

/**
 * Class expressions and non-top-level class declarations anywhere in the
 * module, so a recipe declared there is reported instead of silently skipped.
 */
function findClassExpressions(body: AstNode[]): AstNode[] {
  const found: AstNode[] = [];
  const topLevel = new Set<unknown>();
  for (const statement of body) {
    const node =
      (statement.type === 'ExportNamedDeclaration' ||
        statement.type === 'ExportDefaultDeclaration') &&
      statement.declaration
        ? (statement.declaration as AstNode)
        : statement;
    if (node.type === 'ClassDeclaration') topLevel.add(node);
  }
  const visit = (value: unknown, depth: number): void => {
    if (depth > 200 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const node = value as AstNode;
    if (
      (node.type === 'ClassExpression' || node.type === 'ClassDeclaration') &&
      !topLevel.has(node)
    ) {
      found.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'range') continue;
      visit(child, depth + 1);
    }
  };
  visit(body, 0);
  return found;
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

/**
 * The generated CRUD verbs, mirrored from `CRUD_OPERATIONS` in smrt-core
 * (`generators/custom-action.ts`); this package cannot import core. An
 * `exclude` entry must be one of these or a method the model declares, so a
 * typo cannot pass as a narrowing that narrows nothing.
 */
const CRUD_VERBS = ['list', 'get', 'create', 'update', 'delete'];

function isNarrowing(
  value: unknown,
  operations: ReadonlySet<string>,
): value is RecipeExposureNarrowing {
  if (value === false) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const exclude = (value as { exclude?: unknown }).exclude;
  return (
    keys.length === 1 &&
    keys[0] === 'exclude' &&
    Array.isArray(exclude) &&
    exclude.length > 0 &&
    exclude.every((entry) => typeof entry === 'string' && operations.has(entry))
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
  classes: ResolvedClassDefinition[],
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
  // Public instance methods of the model and every ancestor it inherits from.
  const operations = new Set<string>(CRUD_VERBS);
  const chain = new Set([model.className, ...model.inheritanceChain]);
  for (const candidate of classes) {
    if (!chain.has(candidate.className)) continue;
    for (const method of candidate.methods) {
      if (
        !method.isStatic &&
        method.accessibility === 'public' &&
        method.name !== 'constructor'
      ) {
        operations.add(method.name);
      }
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'fields') {
      if (!isPlainObject(value)) {
        fail(`${where}.fields must be an object`);
        continue;
      }
      const fields: Record<string, RecipeFieldOptions> = {};
      // Field NAMES are validated against the final manifest in smrt-core
      // (`assertRecipeOptions`): only that merged view knows STI-merged,
      // injected tenant, and framework-base fields such as `parentId`.
      for (const [field, hints] of Object.entries(value)) {
        if (!isPlainObject(hints)) {
          fail(`${where}.fields.${field} must be an object`);
          continue;
        }
        const entry: Record<string, unknown> = {};
        for (const [hint, hintValue] of Object.entries(hints)) {
          const at = `${where}.fields.${field}.${hint}`;
          if (!FIELD_OPTION_KEYS.has(hint)) {
            fail(
              `${at} is not a field option; use default, label, help, order, visibility, locked, or required`,
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
          } else if (
            (hint === 'locked' || hint === 'required') &&
            typeof hintValue !== 'boolean'
          ) {
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
        } else if (!isNarrowing(narrowing, operations)) {
          fail(
            `${where}.exposure.${transport} may only be \`false\` or a non-empty \`{ exclude: [...] }\` naming ${[...CRUD_VERBS].join('/')} or a method of \`${model.className}\`: options narrow exposure and never widen it, so \`true\` and \`include\` are rejected`,
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
/** Validate a nav `filter`: `{ field, value }` naming a field of the model. */
function readNavFilter(
  value: unknown,
  fail: (message: string) => void,
): { field: string; value: string } | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    fail('filter must be an object `{ field, value }`');
    return undefined;
  }
  const extra = Object.keys(value).find((k) => k !== 'field' && k !== 'value');
  if (extra) {
    fail(`filter accepts only \`field\` and \`value\`, not \`${extra}\``);
    return undefined;
  }
  if (typeof value.field !== 'string' || typeof value.value !== 'string') {
    fail('filter needs a string `field` and a string `value`');
    return undefined;
  }
  // Field names are checked against the merged manifest in core
  // (`assertRecipeOptions`), which also knows inherited and tenant fields.
  return { field: value.field, value: value.value };
}

/** `requiresAny`: a non-empty list of non-empty lists of recipe ids. */
function readRequiresAny(
  raw: RawRecipe,
  id: string,
  report: (message: string, line?: number) => void,
): string[][] | undefined {
  if (!raw.requiresAny) return undefined;
  const { value, line } = raw.requiresAny;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((alt) => Array.isArray(alt) && alt.length > 0)
  ) {
    report(
      "requiresAny must be a non-empty list of non-empty id lists, e.g. [['a.b', 'c.d']]",
      line,
    );
    return undefined;
  }
  const out: string[][] = [];
  for (const alt of value as unknown[][]) {
    const ids: string[] = [];
    for (const entry of alt) {
      if (
        typeof entry !== 'string' ||
        entry.length > RECIPE_ID_MAX_LENGTH ||
        !RECIPE_ID_PATTERN.test(entry)
      ) {
        report(
          `requiresAny entry \`${String(entry)}\` is not a recipe id`,
          line,
        );
      } else if (entry === id) {
        report('a recipe cannot require itself', line);
      } else if (ids.includes(entry)) {
        report(`requiresAny lists \`${entry}\` more than once`, line);
      } else {
        ids.push(entry);
      }
    }
    out.push(ids);
  }
  return out;
}

/** Validate `group` / `section`: `{ id, label, ... }` strings, known keys only. */
function readLabelled(
  raw: { value: unknown; line?: number } | null,
  name: string,
  allowed: Set<string>,
  report: (message: string, line?: number) => void,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const { value, line } = raw;
  if (!isPlainObject(value)) {
    report(`${name} must be an object literal`, line);
    return undefined;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) {
      report(
        `${name} accepts only ${[...allowed].join(', ')}, not \`${key}\``,
        line,
      );
      ok = false;
    } else if (typeof entry !== 'string' || entry.trim() === '') {
      report(`${name}.${key} must be a non-empty string`, line);
      ok = false;
    } else {
      out[key] = entry;
    }
  }
  if (!out.id || !out.label) {
    if (ok) report(`${name} needs both \`id\` and \`label\``, line);
    return undefined;
  }
  if (!SLUG_PATTERN.test(out.id)) {
    report(
      `${name}.id \`${out.id}\` must be lowercase letters, digits, \`-\` or \`_\``,
      line,
    );
    return undefined;
  }
  if (out.icon !== undefined && !ICON_PATTERN.test(out.icon)) {
    report(`${name}.icon \`${out.icon}\` must be an icon name`, line);
    return undefined;
  }
  return ok ? out : undefined;
}

/** `pkg#Name` / `@scope/pkg/sub#Name`: a bare package specifier and an export. */
const EXPORT_REF_PATTERN =
  /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*)#([A-Za-z_$][A-Za-z0-9_$]*)$/;
const ROUTE_PATH_PATTERN = /^\/[^\s?#]*$/;
const PROVIDER_SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEMO_SEED_MAX_BYTES = 8192;

type Report = (message: string, line?: number) => void;

function readExportRef(
  value: unknown,
  at: string,
  report: Report,
  line?: number,
): string | undefined {
  if (typeof value !== 'string') {
    report(`${at}.export must be a string like \`pkg/svelte#Component\``, line);
    return undefined;
  }
  const match = EXPORT_REF_PATTERN.exec(value);
  if (!match || match[1].split('/').includes('..')) {
    report(
      `${at}.export \`${value}\` must be \`<package specifier>#<ExportName>\` (a package specifier, not a relative path)`,
      line,
    );
    return undefined;
  }
  return value;
}

function readNonEmpty(
  value: unknown,
  at: string,
  report: Report,
  line?: number,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    report(`${at} must be a non-empty string`, line);
    return undefined;
  }
  return value;
}

/** Validate `static surfaces` (#3708). */
function readSurfaces(
  raw: RawRecipe['surfaces'],
  report: Report,
): RecipeSurface[] | undefined {
  if (!raw) return undefined;
  const { value, line } = raw;
  if (!Array.isArray(value) || value.length === 0) {
    report('surfaces must be a non-empty array of surface objects', line);
    return undefined;
  }
  const out: RecipeSurface[] = [];
  const seen = new Set<string>();
  let ok = true;
  value.forEach((entry, index) => {
    const at = `surfaces[${index}]`;
    if (!isPlainObject(entry)) {
      report(`${at} must be an object literal`, line);
      ok = false;
      return;
    }
    const kind = entry.kind;
    if (
      typeof kind !== 'string' ||
      !(RECIPE_SURFACE_KINDS as readonly string[]).includes(kind)
    ) {
      report(
        `${at}.kind must be one of ${RECIPE_SURFACE_KINDS.join(', ')} (got \`${String(kind)}\`)`,
        line,
      );
      ok = false;
      return;
    }
    const allowed: Record<string, string[]> = {
      'shell-widget': ['kind', 'slot', 'export', 'label', 'icon'],
      route: ['kind', 'path', 'export', 'label'],
      'settings-panel': ['kind', 'export', 'label'],
      playground: ['kind', 'export', 'label'],
    };
    for (const key of Object.keys(entry)) {
      if (!allowed[kind].includes(key)) {
        report(`${at} (${kind}) does not accept \`${key}\``, line);
        ok = false;
      }
    }
    const before = ok;
    const ref = readExportRef(
      entry.export,
      at,
      (m, l) => {
        report(m, l);
        ok = false;
      },
      line,
    );
    const fail = (message: string) => {
      report(message, line);
      ok = false;
    };
    let label: string | undefined;
    if (kind === 'playground' && entry.label === undefined) {
      label = undefined;
    } else {
      label = readNonEmpty(entry.label, `${at}.label`, fail, line);
    }
    let identity = `${kind}:${ref}`;
    const surface: Record<string, unknown> = { kind };
    if (kind === 'shell-widget') {
      const slot = entry.slot;
      if (
        typeof slot !== 'string' ||
        !(RECIPE_SHELL_SLOTS as readonly string[]).includes(slot)
      ) {
        fail(
          `${at}.slot \`${String(slot)}\` is not a shell slot (${RECIPE_SHELL_SLOTS.join(', ')})`,
        );
      }
      surface.slot = slot;
      if (entry.icon !== undefined) {
        if (typeof entry.icon !== 'string' || !ICON_PATTERN.test(entry.icon)) {
          fail(`${at}.icon must be an icon name`);
        } else {
          surface.icon = entry.icon;
        }
      }
      identity = `${identity}@${String(slot)}`;
    } else if (kind === 'route') {
      const path = entry.path;
      if (typeof path !== 'string' || !ROUTE_PATH_PATTERN.test(path)) {
        fail(
          `${at}.path must start with \`/\` and contain no whitespace, \`?\` or \`#\``,
        );
      } else if (path.split('/').includes('..')) {
        fail(`${at}.path cannot contain \`..\``);
      } else {
        surface.path = path;
        identity = `route-path:${path}`;
      }
    }
    if (seen.has(identity)) fail(`${at} repeats an earlier surface`);
    seen.add(identity);
    if (ok === before && ref !== undefined) {
      surface.export = ref;
      if (label !== undefined) surface.label = label;
      // Stable key order for deterministic artifacts.
      const ordered: Record<string, unknown> = { kind };
      for (const key of ['slot', 'path', 'export', 'label', 'icon']) {
        if (surface[key] !== undefined) ordered[key] = surface[key];
      }
      out.push(ordered as unknown as RecipeSurface);
    }
  });
  return ok ? out : undefined;
}

/** Validate `static providers` (#3708). */
function readProviders(
  raw: RawRecipe['providers'],
  report: Report,
): RecipeProvider[] | undefined {
  if (!raw) return undefined;
  const { value, line } = raw;
  if (!Array.isArray(value) || value.length === 0) {
    report('providers must be a non-empty array of provider objects', line);
    return undefined;
  }
  const out: RecipeProvider[] = [];
  const ids = new Set<string>();
  let ok = true;
  const fail = (message: string) => {
    report(message, line);
    ok = false;
  };
  value.forEach((entry, index) => {
    const at = `providers[${index}]`;
    if (!isPlainObject(entry)) {
      fail(`${at} must be an object literal`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!['id', 'kind', 'options', 'required', 'secrets'].includes(key)) {
        fail(`${at} does not accept \`${key}\``);
      }
    }
    const { id, kind, options, required, secrets } = entry;
    if (typeof id !== 'string' || !PROVIDER_SLUG_PATTERN.test(id)) {
      fail(`${at}.id must be a lowercase slug`);
    } else if (ids.has(id)) {
      fail(`${at}.id \`${id}\` is declared more than once`);
    } else {
      ids.add(id);
    }
    if (typeof kind !== 'string' || !PROVIDER_SLUG_PATTERN.test(kind)) {
      fail(`${at}.kind must be a lowercase slug such as email, oauth, storage`);
    }
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every(
        (o) => typeof o === 'string' && PROVIDER_SLUG_PATTERN.test(o),
      ) ||
      new Set(options).size !== options.length
    ) {
      fail(
        `${at}.options must be a non-empty list of distinct lowercase slugs`,
      );
    }
    if (typeof required !== 'boolean') {
      fail(`${at}.required must be written as true or false`);
    }
    if (
      secrets !== undefined &&
      (!Array.isArray(secrets) ||
        !secrets.every(
          (n) => typeof n === 'string' && SECRET_NAME_PATTERN.test(n),
        ) ||
        new Set(secrets).size !== secrets.length)
    ) {
      fail(
        `${at}.secrets must be distinct UPPER_SNAKE names (names, not values)`,
      );
    }
    if (ok) {
      out.push({
        id: id as string,
        kind: kind as string,
        options: options as string[],
        required: required as boolean,
        ...(secrets ? { secrets: secrets as string[] } : {}),
      });
    }
  });
  return ok ? out : undefined;
}

/** Validate `static runtime` (#3708). Returns `undefined` for the default. */
function readRuntime(
  raw: RawRecipe['runtime'],
  report: Report,
): RecipeRuntime | undefined {
  if (!raw) return undefined;
  const { value, line } = raw;
  if (
    typeof value !== 'string' ||
    !(RECIPE_RUNTIMES as readonly string[]).includes(value)
  ) {
    report(`runtime must be one of ${RECIPE_RUNTIMES.join(', ')}`, line);
    return undefined;
  }
  return value as RecipeRuntime;
}

/** Validate `static demoSeed` (#3708): a fixture export or small inline JSON. */
function readDemoSeed(
  raw: RawRecipe['demoSeed'],
  report: Report,
): RecipeDemoSeed | undefined {
  if (!raw) return undefined;
  const { value, line } = raw;
  if (!isPlainObject(value)) {
    report('demoSeed must be { export } or { data }', line);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== 'export' && keys[0] !== 'data')) {
    report('demoSeed must have exactly one of `export` or `data`', line);
    return undefined;
  }
  if (keys[0] === 'export') {
    const ref = readExportRef(value.export, 'demoSeed', report, line);
    return ref ? { export: ref as RecipeExportRef } : undefined;
  }
  const size = Buffer.byteLength(JSON.stringify(value.data ?? null));
  if (value.data === undefined || value.data === null) {
    report('demoSeed.data must be JSON data', line);
    return undefined;
  }
  if (size > DEMO_SEED_MAX_BYTES) {
    report(
      `demoSeed.data is ${size} bytes; inline seeds are limited to ${DEMO_SEED_MAX_BYTES}, reference a fixture export instead`,
      line,
    );
    return undefined;
  }
  return { data: value.data };
}

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
      const filter = readNavFilter(entry.filter, (message) =>
        report(`nav entry \`${entry.label}\`: ${message}`, entry.line),
      );
      if (entry.key !== undefined && !SLUG_PATTERN.test(entry.key)) {
        report(
          `nav entry \`${entry.label}\`: key \`${entry.key}\` must be lowercase letters, digits, \`-\` or \`_\``,
          entry.line,
        );
      }
      if (entry.icon !== undefined && !ICON_PATTERN.test(entry.icon)) {
        report(
          `nav entry \`${entry.label}\`: icon \`${entry.icon}\` must be an icon name`,
          entry.line,
        );
      }
      for (const text of ['description', 'noun'] as const) {
        if (entry[text] !== undefined && entry[text]?.trim() === '') {
          report(
            `nav entry \`${entry.label}\`: ${text} must not be empty`,
            entry.line,
          );
        }
      }
      if (filter && entry.key === undefined) {
        report(
          `nav entry \`${entry.label}\`: a filter needs a key, which names its view`,
          entry.line,
        );
      }
      nav.push({
        label: entry.label,
        model: model.className,
        ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
        ...(entry.description !== undefined
          ? { description: entry.description }
          : {}),
        ...(entry.key !== undefined ? { key: entry.key } : {}),
        ...(entry.noun !== undefined ? { noun: entry.noun } : {}),
        ...(filter ? { filter } : {}),
      });
    }
    // One view per (model, key): a second entry over a model needs its own key.
    const viewKeys = new Set<string>();
    for (const entry of nav) {
      const view = `${entry.model}:${entry.key ?? ''}`;
      if (viewKeys.has(view)) {
        report(
          `nav entry \`${entry.label}\` repeats the view of ${entry.model}${entry.key ? ` key \`${entry.key}\`` : ''}; give each extra entry over a model its own key`,
        );
      }
      viewKeys.add(view);
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

    const requiresAny = readRequiresAny(raw, id, report);
    const group = readLabelled(raw.group, 'group', GROUP_KEYS, report);
    const section = readLabelled(raw.section, 'section', SECTION_KEYS, report);

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
        classes,
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

    const surfaces = readSurfaces(raw.surfaces, report);
    const providers = readProviders(raw.providers, report);
    const runtime = readRuntime(raw.runtime, report);
    const demoSeed = readDemoSeed(raw.demoSeed, report);

    const help = raw.help
      ? attempt(
          () => readHelp(raw.help as NonNullable<RawRecipe['help']>, raw),
          raw.help.line,
        )
      : undefined;

    recipes.push({
      id,
      className: raw.className,
      label: raw.label,
      summary: raw.summary,
      synonyms: raw.synonyms,
      models: models.map((model) => model.className),
      nav,
      requires,
      ...(requiresAny ? { requiresAny } : {}),
      ...(group ? { group: group as unknown as RecipeGroup } : {}),
      ...(section ? { section: section as unknown as RecipeSection } : {}),
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
      ...(help ? { help } : {}),
      ...(surfaces ? { surfaces } : {}),
      ...(providers ? { providers } : {}),
      ...(runtime ? { runtime } : {}),
      ...(demoSeed ? { demoSeed } : {}),
    });
  }

  // Cross-recipe consistency within the package: a nav key names one layout id
  // (`item:<pkg>:<Model>:<key>`), and a shared group or section id means one
  // card or section, so its labels must agree.
  const navKeys = new Map<string, string>();
  const labelled = new Map<string, { label: string; recipe: string }>();
  for (const recipe of recipes) {
    const raw = ids.get(recipe.id);
    const note = (message: string) =>
      errors.push({
        message: `Recipe ${recipe.className}: ${message}`,
        filePath: raw?.filePath ?? '',
        line: raw?.line,
        severity: 'error',
      });
    for (const entry of recipe.nav) {
      if (!entry.key) continue;
      const slot = `${entry.model}:${entry.key}`;
      const owner = navKeys.get(slot);
      if (owner && owner !== recipe.id) {
        note(
          `nav key \`${entry.key}\` over ${entry.model} is already used by recipe ${owner}; layout ids must be unique`,
        );
      }
      navKeys.set(slot, owner ?? recipe.id);
    }
    for (const [kind, value] of [
      ['group', recipe.group],
      ['section', recipe.section],
    ] as const) {
      if (!value) continue;
      const slot = `${kind}:${value.id}`;
      const first = labelled.get(slot);
      if (first && first.label !== value.label) {
        note(
          `${kind} \`${value.id}\` is labelled "${value.label}" here but "${first.label}" in recipe ${first.recipe}`,
        );
      } else if (!first) {
        labelled.set(slot, { label: value.label, recipe: recipe.id });
      }
    }
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
