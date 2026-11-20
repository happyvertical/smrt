/**
 * OXC-based TypeScript parser for SMRT class extraction
 *
 * Uses oxc-parser for high-performance syntactic parsing of TypeScript files.
 * Extracts @smrt() decorated classes with their fields, methods, and inheritance.
 *
 * @see https://oxc.rs/docs/guide/usage/parser.html
 */

import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';
import {
  extractAgentSurface,
  sourceMayDeclareAgentSurface,
} from './agent-surface.js';
import {
  extractRecipes,
  type RawRecipe,
  sourceMayDeclareRecipe,
} from './recipes.js';
import { getLineColumn } from './source-location.js';
import type {
  AgentSurface,
  FileScanResult,
  RawClassDefinition,
  RawDecorator,
  RawDecoratorArgumentValue,
  RawDecoratorConfig,
  RawFieldDefinition,
  RawMethodDefinition,
  RawModuleExports,
  RawParameterDefinition,
  RawReExport,
  RawReferenceImport,
  ScanError,
} from './types.js';

/**
 * Get file extension for oxc-parser lang option
 */
function getLangFromFilename(filename: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (filename.endsWith('.tsx')) return 'tsx';
  if (filename.endsWith('.ts')) return 'ts';
  if (filename.endsWith('.jsx')) return 'jsx';
  return 'js';
}

export { getLineColumn };

// ============================================================================
// AST Node Types (TS-ESTree format from oxc-parser)
// ============================================================================

interface Position {
  line: number;
  column: number;
}

interface SourceLocation {
  start: Position;
  end: Position;
}

interface BaseNode {
  type: string;
  loc?: SourceLocation;
  range?: [number, number];
  start?: number;
  end?: number;
}

/**
 * Get source range from an AST node.
 * oxc-parser v0.108+ uses start/end instead of range.
 */
function getRange(node: BaseNode): [number, number] | null {
  if (node.range) return node.range;
  if (node.start !== undefined && node.end !== undefined)
    return [node.start, node.end];
  return null;
}

/**
 * Slice source text from an AST node's range.
 */
function sliceSource(node: BaseNode, sourceText: string): string | null {
  const range = getRange(node);
  return range ? sourceText.slice(range[0], range[1]) : null;
}

interface Program extends BaseNode {
  type: 'Program';
  body: Statement[];
  comments?: Comment[];
}

interface Comment extends BaseNode {
  type: 'Line' | 'Block';
  value: string;
}

interface ImportDeclaration extends BaseNode {
  type: 'ImportDeclaration';
  specifiers?: ImportSpecifierLike[];
  source: Literal;
  importKind?: 'value' | 'type';
}

type ImportSpecifierLike =
  | ImportSpecifier
  | ImportNamespaceSpecifier
  | ImportDefaultSpecifier;

interface ImportSpecifier extends BaseNode {
  type: 'ImportSpecifier';
  imported: Identifier;
  local: Identifier;
  importKind?: 'value' | 'type';
}

interface ImportNamespaceSpecifier extends BaseNode {
  type: 'ImportNamespaceSpecifier';
  local: Identifier;
}

interface ImportDefaultSpecifier extends BaseNode {
  type: 'ImportDefaultSpecifier';
  local: Identifier;
}

type Statement =
  | ClassDeclaration
  | ExportNamedDeclaration
  | ExportDefaultDeclaration
  | ImportDeclaration
  | TSTypeAliasDeclaration
  | TSEnumDeclaration
  | VariableDeclaration;

interface VariableDeclaration extends BaseNode {
  type: 'VariableDeclaration';
  kind: 'const' | 'let' | 'var';
  declarations: VariableDeclarator[];
}

interface VariableDeclarator extends BaseNode {
  type: 'VariableDeclarator';
  id: Identifier | Pattern;
  init: Expression | null;
}

/**
 * `expr as const` / `expr satisfies T`. OXC emits these wrappers around the
 * initializer, so a `const CFG = {...} as const` would otherwise never be seen
 * as an `ObjectExpression`. Not part of the {@link Expression} union — the
 * union is a hand-maintained subset — so it is unwrapped via {@link unwrapTypeAssertion}.
 */
interface TSTypeAssertionExpression extends BaseNode {
  type:
    | 'TSAsExpression'
    | 'TSSatisfiesExpression'
    | 'TSNonNullExpression'
    | 'TSTypeAssertion'
    | 'ParenthesizedExpression';
  expression: Expression;
}

interface ClassDeclaration extends BaseNode {
  type: 'ClassDeclaration';
  id: Identifier | null;
  superClass: Expression | null;
  superTypeParameters?: TSTypeParameterInstantiation;
  // oxc-parser v0.108+ renamed superTypeParameters to superTypeArguments
  superTypeArguments?: TSTypeParameterInstantiation;
  body: ClassBody;
  decorators?: Decorator[];
}

interface TSTypeAliasDeclaration extends BaseNode {
  type: 'TSTypeAliasDeclaration';
  id: Identifier;
  typeAnnotation: TSType;
}

interface TSEnumDeclaration extends BaseNode {
  type: 'TSEnumDeclaration';
  id: Identifier;
  // oxc-parser wraps members in a TSEnumBody node; older shapes expose
  // `members` directly on the declaration.
  body?: TSEnumBody;
  members?: TSEnumMember[];
}

interface TSEnumBody extends BaseNode {
  type: 'TSEnumBody';
  members: TSEnumMember[];
}

interface TSEnumMember extends BaseNode {
  type: 'TSEnumMember';
  id?: Identifier | Literal;
  initializer?: Expression;
}

interface ClassBody extends BaseNode {
  type: 'ClassBody';
  body: ClassElement[];
}

type ClassElement = PropertyDefinition | MethodDefinition;

interface PropertyDefinition extends BaseNode {
  type: 'PropertyDefinition';
  key: Expression;
  value: Expression | null;
  computed: boolean;
  static: boolean;
  readonly?: boolean;
  optional?: boolean;
  accessibility?: 'public' | 'private' | 'protected';
  typeAnnotation?: TSTypeAnnotation;
  decorators?: Decorator[];
}

interface MethodDefinition extends BaseNode {
  type: 'MethodDefinition';
  key: Expression;
  value: FunctionExpression;
  kind: 'constructor' | 'method' | 'get' | 'set';
  computed: boolean;
  static: boolean;
  accessibility?: 'public' | 'private' | 'protected';
  decorators?: Decorator[];
}

interface FunctionExpression extends BaseNode {
  type: 'FunctionExpression';
  async: boolean;
  params: Pattern[];
  returnType?: TSTypeAnnotation;
  body: BlockStatement;
}

interface BlockStatement extends BaseNode {
  type: 'BlockStatement';
  body: Statement[];
}

type Pattern =
  | Identifier
  | AssignmentPattern
  | RestElement
  | ObjectPattern
  | ArrayPattern;

interface Identifier extends BaseNode {
  type: 'Identifier';
  name: string;
  typeAnnotation?: TSTypeAnnotation;
  optional?: boolean;
}

interface AssignmentPattern extends BaseNode {
  type: 'AssignmentPattern';
  left: Pattern;
  right: Expression;
}

interface RestElement extends BaseNode {
  type: 'RestElement';
  argument: Pattern;
  typeAnnotation?: TSTypeAnnotation;
}

interface ObjectPattern extends BaseNode {
  type: 'ObjectPattern';
  properties: (Property | RestElement)[];
  typeAnnotation?: TSTypeAnnotation;
}

interface ArrayPattern extends BaseNode {
  type: 'ArrayPattern';
  elements: (Pattern | null)[];
  typeAnnotation?: TSTypeAnnotation;
}

interface Property extends BaseNode {
  type: 'Property';
  key: Expression;
  value: Expression | Pattern;
  kind: 'init' | 'get' | 'set';
  method: boolean;
  shorthand: boolean;
  computed: boolean;
}

type Expression =
  | Identifier
  | Literal
  | CallExpression
  | MemberExpression
  | ObjectExpression
  | ArrayExpression
  | NewExpression
  | UnaryExpression;

interface Literal extends BaseNode {
  type: 'Literal';
  value: string | number | boolean | null | RegExp | bigint;
  raw?: string;
  /** Present on a regular-expression literal. */
  regex?: { pattern: string; flags: string };
}

interface UnaryExpression extends BaseNode {
  type: 'UnaryExpression';
  operator: string;
  argument: Expression;
}

interface CallExpression extends BaseNode {
  type: 'CallExpression';
  callee: Expression;
  arguments: Expression[];
  typeParameters?: TSTypeParameterInstantiation;
}

interface MemberExpression extends BaseNode {
  type: 'MemberExpression';
  object: Expression;
  property: Expression;
  computed: boolean;
}

interface ObjectExpression extends BaseNode {
  type: 'ObjectExpression';
  properties: (Property | SpreadElement)[];
}

interface SpreadElement extends BaseNode {
  type: 'SpreadElement';
  argument: Expression;
}

interface ArrayExpression extends BaseNode {
  type: 'ArrayExpression';
  elements: (Expression | SpreadElement | null)[];
}

interface NewExpression extends BaseNode {
  type: 'NewExpression';
  callee: Expression;
  arguments: Expression[];
}

interface Decorator extends BaseNode {
  type: 'Decorator';
  expression: Expression;
}

interface ExportNamedDeclaration extends BaseNode {
  type: 'ExportNamedDeclaration';
  source?: Literal | null;
  exportKind?: string;
  declaration: Statement | null;
  specifiers: ExportSpecifier[];
}

interface ExportDefaultDeclaration extends BaseNode {
  type: 'ExportDefaultDeclaration';
  declaration: Statement | Expression;
}

interface ExportSpecifier extends BaseNode {
  type: 'ExportSpecifier';
  exportKind?: string;
  local: Identifier;
  exported: Identifier;
}

interface TSTypeAnnotation extends BaseNode {
  type: 'TSTypeAnnotation';
  typeAnnotation: TSType;
}

type TSType =
  | TSStringKeyword
  | TSNumberKeyword
  | TSBooleanKeyword
  | TSAnyKeyword
  | TSUnknownKeyword
  | TSNeverKeyword
  | TSObjectKeyword
  | TSBigIntKeyword
  | TSSymbolKeyword
  | TSVoidKeyword
  | TSNullKeyword
  | TSUndefinedKeyword
  | TSThisType
  | TSTypeReference
  | TSArrayType
  | TSUnionType
  | TSTypeLiteral
  | TSLiteralType
  | TSFunctionType;

interface TSLiteralType extends BaseNode {
  type: 'TSLiteralType';
  // oxc-parser models the literal as a generic `Literal` node.
  literal?: Literal;
}

interface TSFunctionType extends BaseNode {
  type: 'TSFunctionType';
}

interface TSStringKeyword extends BaseNode {
  type: 'TSStringKeyword';
}

interface TSNumberKeyword extends BaseNode {
  type: 'TSNumberKeyword';
}

interface TSBooleanKeyword extends BaseNode {
  type: 'TSBooleanKeyword';
}

interface TSAnyKeyword extends BaseNode {
  type: 'TSAnyKeyword';
}

interface TSUnknownKeyword extends BaseNode {
  type: 'TSUnknownKeyword';
}

interface TSNeverKeyword extends BaseNode {
  type: 'TSNeverKeyword';
}

interface TSObjectKeyword extends BaseNode {
  type: 'TSObjectKeyword';
}

interface TSBigIntKeyword extends BaseNode {
  type: 'TSBigIntKeyword';
}

interface TSSymbolKeyword extends BaseNode {
  type: 'TSSymbolKeyword';
}

interface TSVoidKeyword extends BaseNode {
  type: 'TSVoidKeyword';
}

interface TSNullKeyword extends BaseNode {
  type: 'TSNullKeyword';
}

interface TSUndefinedKeyword extends BaseNode {
  type: 'TSUndefinedKeyword';
}

interface TSThisType extends BaseNode {
  type: 'TSThisType';
}

interface TSTypeReference extends BaseNode {
  type: 'TSTypeReference';
  typeName: Identifier | TSQualifiedName;
  typeParameters?: TSTypeParameterInstantiation;
  // oxc-parser v0.108+ renamed typeParameters to typeArguments
  typeArguments?: TSTypeParameterInstantiation;
}

interface TSQualifiedName extends BaseNode {
  type: 'TSQualifiedName';
  left: Identifier | TSQualifiedName;
  right: Identifier;
}

interface TSArrayType extends BaseNode {
  type: 'TSArrayType';
  elementType: TSType;
}

interface TSUnionType extends BaseNode {
  type: 'TSUnionType';
  types: TSType[];
}

interface TSTypeLiteral extends BaseNode {
  type: 'TSTypeLiteral';
  members: TSTypeElement[];
}

type TSTypeElement = TSPropertySignature | TSMethodSignature | TSIndexSignature;

interface TSPropertySignature extends BaseNode {
  type: 'TSPropertySignature';
  key: Expression;
  typeAnnotation?: TSTypeAnnotation;
  optional?: boolean;
  readonly?: boolean;
}

interface TSMethodSignature extends BaseNode {
  type: 'TSMethodSignature';
  key: Expression;
  params: Pattern[];
  returnType?: TSTypeAnnotation;
}

interface TSIndexSignature extends BaseNode {
  type: 'TSIndexSignature';
  parameters: Identifier[];
  typeAnnotation?: TSTypeAnnotation;
}

interface TSTypeParameterInstantiation extends BaseNode {
  type: 'TSTypeParameterInstantiation';
  params: TSType[];
}

// ============================================================================
// Parser Implementation
// ============================================================================

/**
 * Parse a single TypeScript file and extract SMRT class definitions.
 *
 * Reads the file from disk, runs oxc-parser on it, and returns all class
 * definitions found, any parse errors, accumulated type aliases, and
 * `@happyvertical/smrt-*` import metadata.
 *
 * @param filePath - Absolute path to the `.ts` or `.tsx` file to parse.
 * @returns A {@link FileScanResult} containing classes, errors, type aliases,
 *   SMRT imports, and timing information for the file.
 *
 * @example
 * ```typescript
 * import { parseFile } from '@happyvertical/smrt-scanner';
 *
 * const result = parseFile('/project/src/models/Product.ts');
 * console.log(result.classes.map((c) => c.className));
 * // ['Product', 'ProductCollection']
 * ```
 *
 * @see {@link parseSource} to parse a source string directly (e.g. in tests).
 */
export function parseFile(filePath: string): FileScanResult {
  const startTime = performance.now();
  const errors: ScanError[] = [];
  const classes: RawClassDefinition[] = [];
  let typeAliases: Record<string, string> = {};
  let smrtImports: Map<string, Set<string>> | undefined;
  let agentSurface: AgentSurface | undefined;
  let recipes: RawRecipe[] | undefined;
  let reExports: RawReExport[] | undefined;
  let moduleExports: RawModuleExports | undefined;
  let imports: Record<string, ImportBinding> | undefined;

  try {
    const sourceText = readFileSync(filePath, 'utf-8');
    const result = parseSync(filePath, sourceText, {
      lang: getLangFromFilename(filePath),
      preserveParens: false,
    });

    // Collect parse errors
    if (result.errors && result.errors.length > 0) {
      for (const error of result.errors) {
        const loc = error.labels?.[0]
          ? getLineColumn(sourceText, error.labels[0].start)
          : undefined;
        errors.push({
          message: error.message || 'Parse error',
          filePath,
          line: loc?.line,
          column: loc?.column,
          severity: error.severity === 'Error' ? 'error' : 'warning',
        });
      }
    }

    // Extract classes from AST
    const program = result.program as Program;
    if (program?.body) {
      const importAliases = extractImportAliases(program.body);
      typeAliases = extractTypeAliases(program.body);
      smrtImports = extractSmrtImports(program.body);
      const ctx = createDecoratorConfigContext(
        program.body,
        sourceText,
        importAliases,
      );
      for (const node of program.body) {
        const extracted = extractClassFromNode(
          node,
          filePath,
          sourceText,
          importAliases,
          ctx,
        );
        if (extracted) {
          classes.push(extracted);
        }
      }
      resolveReplacementExports(classes, program.body);
      reExports = extractReExports(program.body);
      moduleExports = extractModuleExports(program.body);
      imports = Object.fromEntries(ctx.importBindings ?? []);
      resolveLocalParameterAliases(classes, typeAliases);
      reportUnresolvedSpreads(ctx.unresolved, filePath, sourceText, errors);
      agentSurface = maybeExtractAgentSurface(program, sourceText, filePath);
      if (sourceMayDeclareRecipe(sourceText)) {
        const found = extractRecipes({
          body: program.body,
          sourceText,
          filePath: filePath,
        });
        errors.push(...found.errors);
        if (found.recipes.length > 0) recipes = found.recipes;
      }
    }
  } catch (error) {
    errors.push({
      message: error instanceof Error ? error.message : String(error),
      filePath,
      severity: 'error',
    });
  }

  const result2: FileScanResult = {
    filePath,
    classes,
    errors,
    parseTimeMs: performance.now() - startTime,
    typeAliases,
  };
  if (smrtImports && smrtImports.size > 0) {
    result2.smrtImports = smrtImports;
  }
  if (agentSurface) {
    result2.agentSurface = agentSurface;
  }
  if (recipes) {
    result2.recipes = recipes;
  }
  if (reExports && reExports.length > 0) {
    result2.reExports = reExports;
  }
  if (moduleExports) result2.moduleExports = moduleExports;
  if (imports && Object.keys(imports).length > 0) result2.imports = imports;
  return result2;
}

/**
 * Run the agent-surface matcher when — and only when — the source names one of
 * its helpers, and return the surface only when it found something.
 *
 * The token pre-check keeps a full AST walk off the hot path of a large scan;
 * dropping an empty result keeps `FileScanResult.agentSurface` absent for the
 * overwhelming majority of files that declare nothing.
 */
function maybeExtractAgentSurface(
  program: Program,
  sourceText: string,
  filePath: string,
): AgentSurface | undefined {
  if (!sourceMayDeclareAgentSurface(sourceText)) return undefined;
  const surface = extractAgentSurface({
    body: program.body,
    sourceText,
    filePath,
  });
  return surface.intents.length > 0 ||
    surface.playbooks.length > 0 ||
    surface.diagnostics.length > 0
    ? surface
    : undefined;
}

/**
 * Read one file for agent-surface declarations ONLY (#2591).
 *
 * Exists because the agent surface must not be confined to the class scan's
 * `include` glob: an application that scans `src/lib/objects/**` for its models
 * — the shipped template does exactly that — would otherwise never see a
 * `src/lib/agent/Foo.intents.ts` sidecar, and the declaration would vanish from
 * every artifact with no diagnostic. Silent omission is the one failure this
 * matcher exists to prevent, so declarations are discovered on their own terms.
 *
 * The token pre-filter runs before the parse, so a file that declares nothing
 * costs one read and one `String.includes`.
 *
 * @returns The file's surface, or `undefined` when it declares nothing or
 *   cannot be read.
 */
export function parseAgentSurfaceFile(
  filePath: string,
): AgentSurface | undefined {
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  if (!sourceMayDeclareAgentSurface(sourceText)) return undefined;

  try {
    const result = parseSync(filePath, sourceText, {
      lang: getLangFromFilename(filePath),
      preserveParens: false,
    });
    const program = result.program as Program;
    if (!program?.body) return undefined;
    return maybeExtractAgentSurface(program, sourceText, filePath);
  } catch {
    return undefined;
  }
}

/**
 * Read one file for `SmrtRecipe` declarations ONLY (#3590).
 *
 * The class scan's `include` is routinely narrowed to where models live, while
 * a recipe may sit beside them or elsewhere; binding recipe discovery to that
 * glob would drop the declaration with no diagnostic. A read or parse failure is
 * reported as a scan error for the same reason.
 */
export function parseRecipeFile(filePath: string): {
  recipes: RawRecipe[];
  errors: ScanError[];
} {
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, 'utf-8');
  } catch (error) {
    return {
      recipes: [],
      errors: [
        {
          message: `Cannot read file for recipe discovery: ${error instanceof Error ? error.message : String(error)}`,
          filePath,
          severity: 'error',
        },
      ],
    };
  }
  if (!sourceMayDeclareRecipe(sourceText)) return { recipes: [], errors: [] };
  try {
    const result = parseSync(filePath, sourceText, {
      lang: getLangFromFilename(filePath),
      preserveParens: false,
    });
    const program = result.program as Program;
    if (!program?.body) return { recipes: [], errors: [] };
    return extractRecipes({ body: program.body, sourceText, filePath });
  } catch (error) {
    return {
      recipes: [],
      errors: [
        {
          message: error instanceof Error ? error.message : String(error),
          filePath,
          severity: 'error',
        },
      ],
    };
  }
}

/**
 * Parse TypeScript source text directly and extract SMRT class definitions.
 *
 * Identical to {@link parseFile} but accepts a source string instead of a
 * file path. Primarily used in tests and tooling that constructs source
 * programmatically.
 *
 * @param sourceText - Raw TypeScript source code to parse.
 * @param filename - Virtual filename used to determine the parser language
 *   mode (`.ts`, `.tsx`, `.js`, `.jsx`) and to populate `filePath` fields in
 *   the result. Defaults to `'test.ts'`.
 * @returns A {@link FileScanResult} containing classes, errors, type aliases,
 *   and SMRT import metadata extracted from the source text.
 *
 * @example
 * ```typescript
 * import { parseSource } from '@happyvertical/smrt-scanner';
 *
 * const src = `
 *   import { smrt } from '@happyvertical/smrt-core';
 *   @smrt()
 *   export class Widget extends SmrtObject {
 *     label: string = '';
 *   }
 * `;
 * const result = parseSource(src, 'Widget.ts');
 * console.log(result.classes[0].className); // 'Widget'
 * ```
 *
 * @see {@link parseFile} to parse a file from disk.
 */
export function parseSource(
  sourceText: string,
  filename = 'test.ts',
): FileScanResult {
  const startTime = performance.now();
  const errors: ScanError[] = [];
  const classes: RawClassDefinition[] = [];
  let typeAliases: Record<string, string> = {};
  let smrtImports: Map<string, Set<string>> | undefined;
  let agentSurface: AgentSurface | undefined;
  let recipes: RawRecipe[] | undefined;
  let reExports: RawReExport[] | undefined;
  let moduleExports: RawModuleExports | undefined;
  let imports: Record<string, ImportBinding> | undefined;

  try {
    const result = parseSync(filename, sourceText, {
      lang: getLangFromFilename(filename),
      preserveParens: false,
    });

    if (result.errors && result.errors.length > 0) {
      for (const error of result.errors) {
        const loc = error.labels?.[0]
          ? getLineColumn(sourceText, error.labels[0].start)
          : undefined;
        errors.push({
          message: error.message || 'Parse error',
          filePath: filename,
          line: loc?.line,
          column: loc?.column,
          severity: error.severity === 'Error' ? 'error' : 'warning',
        });
      }
    }

    const program = result.program as Program;
    if (program?.body) {
      const importAliases = extractImportAliases(program.body);
      typeAliases = extractTypeAliases(program.body);
      smrtImports = extractSmrtImports(program.body);
      const ctx = createDecoratorConfigContext(
        program.body,
        sourceText,
        importAliases,
      );
      for (const node of program.body) {
        const extracted = extractClassFromNode(
          node,
          filename,
          sourceText,
          importAliases,
          ctx,
        );
        if (extracted) {
          classes.push(extracted);
        }
      }
      resolveReplacementExports(classes, program.body);
      reExports = extractReExports(program.body);
      moduleExports = extractModuleExports(program.body);
      imports = Object.fromEntries(ctx.importBindings ?? []);
      resolveLocalParameterAliases(classes, typeAliases);
      reportUnresolvedSpreads(ctx.unresolved, filename, sourceText, errors);
      agentSurface = maybeExtractAgentSurface(program, sourceText, filename);
      if (sourceMayDeclareRecipe(sourceText)) {
        const found = extractRecipes({
          body: program.body,
          sourceText,
          filePath: filename,
        });
        errors.push(...found.errors);
        if (found.recipes.length > 0) recipes = found.recipes;
      }
    }
  } catch (error) {
    errors.push({
      message: error instanceof Error ? error.message : String(error),
      filePath: filename,
      severity: 'error',
    });
  }

  const result2: FileScanResult = {
    filePath: filename,
    classes,
    errors,
    parseTimeMs: performance.now() - startTime,
    typeAliases,
  };
  if (smrtImports && smrtImports.size > 0) {
    result2.smrtImports = smrtImports;
  }
  if (agentSurface) {
    result2.agentSurface = agentSurface;
  }
  if (recipes) {
    result2.recipes = recipes;
  }
  if (reExports && reExports.length > 0) {
    result2.reExports = reExports;
  }
  if (moduleExports) result2.moduleExports = moduleExports;
  if (imports && Object.keys(imports).length > 0) result2.imports = imports;
  return result2;
}

// ============================================================================
// AST Extraction Helpers
// ============================================================================

/**
 * Property keys that must never be assigned onto a plain object built from
 * parsed source. Assigning `obj['__proto__'] = value` mutates the object's
 * prototype rather than adding an own property, which is a prototype-pollution
 * vector. `constructor` / `prototype` are blocked for defense-in-depth.
 *
 * Scanner input is developer-authored source consumed at build time (trusted),
 * so this is a hardening guard, not a fix for a remotely reachable bug: a class
 * field, decorator-config property, or type alias literally named `__proto__`
 * would otherwise silently corrupt the metadata object it is collected into.
 */
const FORBIDDEN_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Whether a key is safe to assign as an own property on a plain object built
 * from parsed AST. See {@link FORBIDDEN_OBJECT_KEYS}.
 *
 * @internal Exported for testing.
 */
export function isSafeObjectKey(key: string): boolean {
  return !FORBIDDEN_OBJECT_KEYS.has(key);
}

/**
 * Extract import aliases from program body.
 * Maps local alias names to their original imported names.
 * e.g., `import { Performer as PerformerBase }` → Map { "PerformerBase" → "Performer" }
 */
function extractImportAliases(body: Statement[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const node of body) {
    if (node.type === 'ImportDeclaration' && node.specifiers) {
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportSpecifier' && spec.imported && spec.local) {
          const original = spec.imported.name;
          const local = spec.local.name;
          if (original !== local) {
            aliases.set(local, original);
          }
        }
      }
    }
  }
  return aliases;
}

/**
 * Where one local import binding comes from (#4145).
 * `imported` is the exported name for a named import, `'default'` for a
 * default import, `null` for a namespace import (`import * as ns`).
 */
interface ImportBinding {
  source: string;
  imported: string | null;
}

/**
 * Map each local name bound by a named, default or namespace VALUE import to
 * its module specifier. A default import is recorded with `imported:
 * 'default'`: its source is known, the exported class's own name is not.
 * Type-only imports are left out (they cannot be extended).
 */
function extractImportBindings(body: Statement[]): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of body) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') {
      continue;
    }
    const source = node.source?.value;
    if (typeof source !== 'string' || !node.specifiers) continue;
    for (const spec of node.specifiers) {
      if (!spec.local?.name) continue;
      if (spec.type === 'ImportSpecifier') {
        if (spec.importKind === 'type' || !spec.imported?.name) continue;
        bindings.set(spec.local.name, { source, imported: spec.imported.name });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        bindings.set(spec.local.name, { source, imported: null });
      } else if (spec.type === 'ImportDefaultSpecifier') {
        bindings.set(spec.local.name, { source, imported: 'default' });
      }
    }
  }
  return bindings;
}

/**
 * Extract `@happyvertical/smrt-*` import declarations from an OXC program body.
 *
 * Scans the top-level AST statements for `ImportDeclaration` nodes whose
 * module specifier begins with `@happyvertical/smrt-` and collects the
 * PascalCase identifiers being imported.  The result is used for tree-shaking:
 * only externally imported SMRT classes that appear in project source are
 * included in the generated manifest.
 *
 * Handles all import forms:
 * - Side-effect imports — `import '@happyvertical/smrt-messages'` (recorded as `'*'`)
 * - Named imports — `import { Person, Organization } from '@happyvertical/smrt-profiles'`
 * - Renamed named imports — `import { Person as PersonBase } from '...'` (records original name `Person`)
 * - Namespace imports — `import * as Profiles from '@happyvertical/smrt-profiles'` (recorded as `'*'`)
 * - Default imports — `import SomeClass from '@happyvertical/smrt-profiles'`
 *
 * Only PascalCase identifiers are recorded; utility function names (lowercase)
 * are ignored.
 *
 * @param body - The top-level statement array from the OXC-parsed `Program` node.
 * @returns A `Map` keyed by package name (e.g. `'@happyvertical/smrt-profiles'`)
 *   whose values are `Set`s of the imported PascalCase class names (or `'*'`
 *   for namespace imports).
 *
 * @example
 * ```typescript
 * import { parseSource, extractSmrtImports } from '@happyvertical/smrt-scanner';
 * import { parseSync } from 'oxc-parser';
 *
 * const src = `import { Person, Organization } from '@happyvertical/smrt-profiles';`;
 * const { program } = parseSync('file.ts', src, { lang: 'ts' });
 * const imports = extractSmrtImports(program.body);
 * // Map { '@happyvertical/smrt-profiles' => Set { 'Person', 'Organization' } }
 * ```
 *
 * @internal Exported for testing; use {@link OxcScanner.scanSmrtImports} for
 *   production use cases.
 */
export function extractSmrtImports(
  body: Statement[],
): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();

  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue;

    // Get module specifier string
    const source = node.source;
    if (!source || typeof source.value !== 'string') continue;

    const moduleName = source.value;

    // Only process @happyvertical/smrt-* packages
    if (!moduleName.startsWith('@happyvertical/smrt-')) continue;

    // Get or create the set for this package
    let classSet = imports.get(moduleName);
    if (!classSet) {
      classSet = new Set();
      imports.set(moduleName, classSet);
    }

    if (!node.specifiers || node.specifiers.length === 0) {
      classSet.add('*');
      continue;
    }

    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.imported && spec.local) {
        // Named import: use original (imported) name, not local alias
        const importedName = spec.imported.name;
        // Only include PascalCase names (likely classes)
        if (/^[A-Z][A-Za-z0-9]*$/.test(importedName)) {
          classSet.add(importedName);
        }
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        // Namespace import: import * as X from '...'
        classSet.add('*');
      } else if (spec.type === 'ImportDefaultSpecifier' && spec.local) {
        // Default import: import SomeClass from '...'
        const defaultName = spec.local.name;
        if (/^[A-Z][A-Za-z0-9]*$/.test(defaultName)) {
          classSet.add(defaultName);
        }
      }
    }
  }

  return imports;
}

/**
 * Extract type alias declarations from program body.
 * Maps alias names to their resolved type strings.
 * e.g., `type Status = 'active' | 'inactive'` → { Status: "'active' | 'inactive'" }
 * @internal Exported for testing
 */
export function extractTypeAliases(body: Statement[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const node of body) {
    if (node.type === 'TSTypeAliasDeclaration') {
      const name = node.id?.name;
      const resolved = node.typeAnnotation
        ? extractTypeName(node.typeAnnotation)
        : null;
      if (name && resolved && isSafeObjectKey(name)) aliases[name] = resolved;
    }
    // Also check `export type X = ...` (ExportNamedDeclaration wrapping)
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'TSTypeAliasDeclaration'
    ) {
      const decl = node.declaration;
      const name = decl.id?.name;
      const resolved = decl.typeAnnotation
        ? extractTypeName(decl.typeAnnotation)
        : null;
      if (name && resolved && isSafeObjectKey(name)) aliases[name] = resolved;
    }

    // Extract enum declarations as string union types
    // e.g., enum Status { PENDING = 'pending', ACTIVE = 'active' }
    // → Status: "'pending' | 'active'"
    const enumDecl =
      node.type === 'TSEnumDeclaration'
        ? node
        : node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'TSEnumDeclaration'
          ? node.declaration
          : null;
    if (enumDecl) {
      const name = enumDecl.id?.name;
      // OXC wraps members in a TSEnumBody node: enumDecl.body.members
      const members = enumDecl.body?.members ?? enumDecl.members;
      if (name && isSafeObjectKey(name) && members && members.length > 0) {
        const union = enumMembersToUnion(members);
        if (union) aliases[name] = union;
      }
    }
  }
  return aliases;
}

/** Alias-chain bound; a longer chain is treated like a cycle. */
const MAX_PARAMETER_ALIAS_DEPTH = 8;

const BARE_TYPE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Resolve a method parameter whose declared type is a bare identifier naming
 * a type alias (or enum) declared in the SAME module (#4327).
 *
 * The manifest keeps the authored name in `type` (generated code and docs
 * still read it) and records the alias target as `resolvedType`, which the
 * schema and coercion consumers read instead. Only the declaring module's own
 * aliases are consulted -- never the project-wide flattened map -- so a
 * same-named alias in another file or package cannot leak in, and an
 * inherited method keeps the resolution made in its declaring file. A cyclic
 * or over-long chain sets `aliasUnresolved` instead of guessing. An imported
 * or otherwise unknown name is left untouched.
 *
 * @internal Exported for testing
 */
export function resolveParameterAlias(
  type: string | null,
  aliases: Record<string, string>,
): { resolvedType: string } | { aliasUnresolved: true } | undefined {
  if (
    !type ||
    !BARE_TYPE_IDENTIFIER.test(type) ||
    !Object.hasOwn(aliases, type)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  let current = type;
  while (
    BARE_TYPE_IDENTIFIER.test(current) &&
    Object.hasOwn(aliases, current)
  ) {
    if (seen.has(current) || seen.size >= MAX_PARAMETER_ALIAS_DEPTH) {
      return { aliasUnresolved: true };
    }
    seen.add(current);
    current = aliases[current].trim();
  }
  return { resolvedType: current };
}

/** Apply {@link resolveParameterAlias} to every method parameter of `classes`. */
function resolveLocalParameterAliases(
  classes: RawClassDefinition[],
  aliases: Record<string, string>,
): void {
  if (Object.keys(aliases).length === 0) return;
  for (const classDef of classes) {
    for (const method of classDef.methods) {
      for (const parameter of method.parameters) {
        if (parameter.typeUnresolved) continue;
        const resolution = resolveParameterAlias(parameter.type, aliases);
        if (resolution) Object.assign(parameter, resolution);
      }
    }
  }
}

/**
 * Render an enum's members as the union string the alias map stores
 * (`'a' | 'b'` or `0 | 1`), in declaration order, using the member VALUES
 * rather than their names (#3598).
 *
 * Handles string, numeric, negative and substitution-free template
 * initializers, plus TypeScript's auto-increment for members without one
 * (`enum E { A, B }` is `0 | 1`; `const enum` parses to the same node).
 * Returns `null` when any member is not statically resolvable or when string
 * and numeric members are mixed: a partial value list would be wrong, and a
 * mixed enum has no single column type.
 */
function enumMembersToUnion(members: TSEnumMember[]): string | null {
  const values = enumMemberValues(members);
  if (!values) return null;
  const allStrings = values.every((v) => typeof v === 'string');
  const allNumbers = values.every((v) => typeof v === 'number');
  if (!allStrings && !allNumbers) return null;
  return values
    .map((v) => {
      if (typeof v !== 'string') return String(v);
      const encoded = JSON.stringify(v);
      return `'${encoded.slice(1, -1).replaceAll("'", "\\'")}'`;
    })
    .join(' | ');
}

/**
 * The value of each enum member in declaration order, applying TypeScript's
 * auto-increment, or `null` when any member is not statically resolvable.
 */
function enumMemberValues(
  members: TSEnumMember[],
): Array<string | number> | null {
  const values: Array<string | number> = [];
  let next = 0;
  for (const member of members) {
    const init = member.initializer as
      | {
          type?: string;
          value?: unknown;
          operator?: string;
          argument?: { type?: string; value?: unknown };
          quasis?: Array<{ value?: { cooked?: string | null } }>;
          expressions?: unknown[];
        }
      | undefined;
    if (!init) {
      values.push(next);
      next += 1;
    } else if (init.type === 'Literal' && typeof init.value === 'string') {
      values.push(init.value);
    } else if (init.type === 'Literal' && typeof init.value === 'number') {
      values.push(init.value);
      next = init.value + 1;
    } else if (
      init.type === 'UnaryExpression' &&
      init.operator === '-' &&
      init.argument?.type === 'Literal' &&
      typeof init.argument.value === 'number'
    ) {
      values.push(-init.argument.value);
      next = -init.argument.value + 1;
    } else if (
      init.type === 'TemplateLiteral' &&
      init.expressions?.length === 0 &&
      typeof init.quasis?.[0]?.value?.cooked === 'string'
    ) {
      values.push(init.quasis[0].value.cooked);
    } else {
      return null;
    }
  }
  return values;
}

/**
 * Unwrap `as const` / `satisfies T` / `!` wrappers to reach the underlying
 * expression. `const CFG = { api: false } as const` is the idiomatic way to
 * declare a shared surface policy, so the wrapper must be transparent here or
 * the object literal is never found.
 */
function unwrapTypeAssertion(node: Expression | null): Expression | null {
  let current = node;
  // Bounded: assertions can legally nest (`x as unknown as T`), but not deeply.
  for (let depth = 0; current && depth < 8; depth++) {
    const type = (current as unknown as TSTypeAssertionExpression).type;
    if (
      type === 'TSAsExpression' ||
      type === 'TSSatisfiesExpression' ||
      type === 'TSNonNullExpression' ||
      type === 'TSTypeAssertion' ||
      type === 'ParenthesizedExpression'
    ) {
      current = (current as unknown as TSTypeAssertionExpression).expression;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * A spread inside an `@smrt()` or `@method()` config that could not be
 * resolved statically.
 *
 * Recorded rather than silently dropped: an unresolvable spread may carry
 * `api`/`mcp`/`cli` keys, and because an absent surface key means *default
 * open* (full CRUD), dropping it silently turns a deliberate lockdown into a
 * public surface. The same reasoning covers `@method({ expose: false })`,
 * where a dropped key restores the default-routed behavior the author was
 * withholding. See issues #2100 and #2686.
 */
interface UnresolvedSpread {
  /** Source text of the spread, e.g. `...IMPORTED_SURFACE`. */
  expression: string;
  /** Byte offset of the spread node, for line/column resolution. */
  start?: number;
  /**
   * Decorator whose config the expression appeared in, for the diagnostic.
   * Defaults to `@smrt()` when omitted.
   */
  decorator?: string;
  /** Class the decorator is applied to, or that declares the decorated member. */
  className?: string;
  /** Method the decorator is applied to, when it is not the class itself. */
  member?: string;
  /** Dotted path of the option the expression is the value of. */
  option?: string;
  /** The fix, when the expression has a known supported spelling. */
  hint?: string;
}

/**
 * Marks a value the static reader could not resolve. It never leaves this
 * module: a container drops the entry it would have filled, and the reader
 * records an {@link UnresolvedSpread} for the scan error. A config key is
 * therefore either its real value or absent with a diagnostic, never the
 * source text or identifier name standing in for a value.
 */
const UNRESOLVED: unique symbol = Symbol('smrt.scanner.unresolved');

/**
 * A module-scope `const` object literal available for spread resolution.
 *
 * `unresolved` carries any spread inside the constant's OWN initializer that
 * could not be resolved (e.g. `const CFG = { ...IMPORTED }`). Such a constant
 * is "tainted": `value` is only a partial view of what it holds at runtime.
 * Resolving a decorator spread against it silently would reintroduce the
 * silent-drop failure mode one level removed, so the taint is replayed into the
 * use site's diagnostics instead.
 */
interface ModuleConstant {
  /**
   * `object` and `array` constants are shared by reference at runtime, so
   * they can be mutated after declaration and carry taint. A `scalar` (string,
   * number, boolean, `null`) is immutable and never does.
   */
  kind: 'object' | 'array' | 'scalar';
  value: unknown;
  unresolved: UnresolvedSpread[];
  unsafeReferences: UnresolvedSpread[];
  dependencies: Array<{
    name: string;
    start?: number;
    /**
     * The dependent constant holds this one BY REFERENCE (`{ api: BASE }`),
     * not a spread copy, so taint flows both ways regardless of position.
     */
    shared?: boolean;
  }>;
}

/**
 * Context threaded through decorator-config extraction so object spreads can be
 * resolved against module-scope constants, and unresolvable ones reported.
 */
interface DecoratorConfigContext {
  /** Module-scope `const` literals (objects, arrays, scalars), by identifier name. */
  constants: Map<string, ModuleConstant>;
  /** Same-file `enum` member values, by enum name then member name. */
  enums?: Map<string, Map<string, string | number>>;
  /** Collector for spreads that could not be statically resolved. */
  unresolved: UnresolvedSpread[];
  /** Constant spreads recorded while another module constant is extracted. */
  dependencies?: ModuleConstant['dependencies'];
  /** Require values to be statically literal for security-sensitive @smrt config. */
  requireLiteralValues?: boolean;
  /**
   * Resolve identifier, member, and shorthand values through
   * {@link constants} and {@link enums}, and drop what cannot be resolved
   * (with a diagnostic) instead of recording its source text. Every decorator
   * reader sets this. Only the standalone
   * {@link extractModuleObjectConstants} entry point leaves it off, where a
   * consumer inspects the raw literal shape of a declaration.
   */
  resolveReferences?: boolean;
  /** Dotted option path of the value being read, for diagnostics. */
  path?: string;
  /**
   * Option paths whose value names a class (`@report({ source: Model })`).
   * A class cannot be read as a literal, so an identifier there is recorded
   * by name, the same as a relationship decorator's target.
   */
  classReference?: (path: string | undefined) => boolean;
  /**
   * Where each class reference read at a {@link classReference} path came
   * from, for one imported through a module: the option path and the import.
   * `OxcScanner.resolve()` follows it to the declaring class.
   */
  referenceImports?: RawReferenceImport[];
  /**
   * Option paths whose value only exists at runtime (a callback such as a
   * field's `validate`). The value is not read; the key is kept, holding
   * {@link RUNTIME_ONLY_OPTION}, so the manifest can record that the option
   * was stated.
   */
  runtimeOnly?: (path: string | undefined) => boolean;
  /** Same-file `const name = () => Target` thunks, by name, to their target. */
  thunks?: Map<string, string>;
  /**
   * Local-name -> imported-name for this file's renamed named imports, so a
   * decorator reached through an alias is still recognized. Without it
   * `import { method as action }` made `@action({ expose: false })` invisible
   * to the scanner while the runtime decorator still ran — a withheld method
   * would silently keep its generated route (#2686).
   */
  importAliases?: Map<string, string>;
  /**
   * Local name -> import source for this file's named and namespace value
   * imports, so a class's `extends` can be traced to the module that
   * exports its parent (#4145).
   */
  importBindings?: Map<string, ImportBinding>;
  /** Classes declared at the top level of this file, by name. */
  localClasses?: ReadonlySet<string>;
}

/**
 * Collect module-scope `const NAME = { ... }` object literals, exactly as
 * written: an identifier or call used as a value is recorded as its source
 * text (and listed in the constant's `unresolved`), and nothing is resolved
 * through other declarations.
 *
 * This is the raw-shape entry point for consumers that inspect a declaration
 * rather than a decorator config (`ui-selectors.ts`). Decorator readers use
 * the reference-resolving table built by `createDecoratorConfigContext`.
 *
 * @param body - Top-level statement array from the OXC-parsed `Program` node.
 * @param sourceText - Full source text, used for nested value reconstruction.
 * @returns Map of constant name to its extracted value plus any taint.
 */
export function extractModuleObjectConstants(
  body: Statement[],
  sourceText: string,
): Map<string, ModuleConstant> {
  return collectModuleConstants(body, sourceText, {});
}

/**
 * Build the context every decorator reader in one file shares: the module
 * constant table, same-file enum members, and the import tables used to
 * recognize a decorator reached through an alias or a namespace.
 */
function createDecoratorConfigContext(
  body: Statement[],
  sourceText: string,
  importAliases: Map<string, string>,
): DecoratorConfigContext {
  const importBindings = extractImportBindings(body);
  const enums = extractEnumMemberValues(body);
  const constants = collectModuleConstants(body, sourceText, {
    resolveReferences: true,
    enums,
    importAliases,
    importBindings,
  });
  CONSTANTS_BY_BINDINGS.set(importBindings, constants);
  return {
    constants,
    enums,
    thunks: extractModuleThunks(body),
    unresolved: [],
    importAliases,
    importBindings,
    localClasses: extractTopLevelClassNames(body),
    requireLiteralValues: true,
    resolveReferences: true,
  };
}

/** Names of the classes declared at the top level of a file. */
function extractTopLevelClassNames(body: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const node of body) {
    const declaration =
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportDefaultDeclaration'
        ? (node.declaration as Statement | null | undefined)
        : node;
    if (
      declaration?.type === 'ClassDeclaration' &&
      declaration.id?.type === 'Identifier'
    ) {
      names.add(declaration.id.name);
    }
  }
  return names;
}

/**
 * A class reference written as `reference` (an identifier, or `ns.Class` /
 * `ns['Class']` through a namespace import), as far as this file can tell:
 *
 * - a class declared in this file: its name, final;
 * - an imported binding (named, default, or a namespace member): the import
 *   it comes from. The name is provisional; `OxcScanner.resolve()` follows
 *   the import to the declaring class (or the package export) and records
 *   that, or reports a scan error.
 *
 * `undefined` for anything else: a namespace object itself, a local alias or
 * `let`, a member of a local object.
 */
function classIdentity(
  reference: string,
  ctx: DecoratorConfigContext,
):
  | { value: string; import?: { source: string; imported: string } }
  | undefined {
  const parts = reference.split('.');
  if (parts.length === 1) {
    const binding = ctx.importBindings?.get(reference);
    if (binding) {
      if (binding.imported === null) return undefined;
      return {
        value: binding.imported === 'default' ? reference : binding.imported,
        import: { source: binding.source, imported: binding.imported },
      };
    }
    return ctx.localClasses?.has(reference) ? { value: reference } : undefined;
  }
  if (parts.length === 2) {
    const binding = ctx.importBindings?.get(parts[0]);
    if (binding && binding.imported === null) {
      return {
        value: parts[1],
        import: { source: binding.source, imported: parts[1] },
      };
    }
  }
  return undefined;
}

/** The provisional name of a class reference; records where it was imported from. */
function recordReference(
  identity: { value: string; import?: { source: string; imported: string } },
  ctx: DecoratorConfigContext,
): string {
  if (ctx.referenceImports && ctx.path) {
    ctx.referenceImports.push(
      identity.import
        ? { path: ctx.path, ...identity.import }
        : // A class declared in this file: checked to be a model.
          { path: ctx.path, source: '', imported: identity.value, local: true },
    );
  }
  return identity.value;
}

/**
 * Forget the class-reference provenance recorded for `path` (and anything
 * below it) before index `before` of `ctx.referenceImports`: a later
 * property or spread wrote that key, so the earlier class reference is no
 * longer the value the decorator receives.
 */
function clearReferenceProvenance(
  ctx: DecoratorConfigContext | undefined,
  path: string,
  before: number,
): void {
  const recorded = ctx?.referenceImports;
  if (!recorded) return;
  for (let index = Math.min(before, recorded.length) - 1; index >= 0; index--) {
    const entry = recorded[index];
    if (entry.path === path || entry.path.startsWith(`${path}.`)) {
      recorded.splice(index, 1);
    }
  }
}

/**
 * Module-scope `const lazyTarget = () => Target` declarations. The runtime
 * relationship decorators invoke a thunk passed by name, so the scanner must
 * read the same target rather than record the constant's own name.
 */
function extractModuleThunks(body: Statement[]): Map<string, string> {
  const thunks = new Map<string, string>();
  for (const node of body) {
    const decl =
      node.type === 'VariableDeclaration'
        ? node
        : node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration'
          ? (node.declaration as VariableDeclaration)
          : null;
    if (decl?.kind !== 'const') continue;
    for (const declarator of decl.declarations) {
      if (declarator.id?.type !== 'Identifier' || !declarator.init) continue;
      const target = thunkTarget(declarator.init);
      if (target) thunks.set(declarator.id.name, target);
    }
  }
  return thunks;
}

/** The class a zero-argument arrow returns: `() => Target` or `() => { return Target; }`. */
function thunkTarget(node: Expression): string | undefined {
  const arrow = unwrapTypeAssertion(node) as unknown as {
    type?: string;
    params?: unknown[];
    body?: BaseNode & {
      type: string;
      body?: Array<{ type: string; argument?: Expression | null }>;
    };
  } | null;
  if (arrow?.type !== 'ArrowFunctionExpression' || arrow.params?.length !== 0) {
    return undefined;
  }
  let returned: Expression | null | undefined;
  if (arrow.body?.type === 'BlockStatement') {
    const statements = arrow.body.body ?? [];
    if (statements.length !== 1 || statements[0].type !== 'ReturnStatement') {
      return undefined;
    }
    returned = statements[0].argument;
  } else {
    returned = arrow.body as unknown as Expression | undefined;
  }
  return returned ? classReferenceName(returned) : undefined;
}

/**
 * `Target`, `ns.Target`, or a member path such as `Target.column` (which
 * `classIdentity` then refuses unless `ns` is a namespace import), else
 * `undefined`.
 */
function classReferenceName(node: Expression): string | undefined {
  const expression = unwrapTypeAssertion(node);
  if (expression?.type === 'Identifier') return expression.name;
  if (expression?.type === 'MemberExpression') {
    const chain = staticMemberChain(expression);
    if (chain?.path.every((part) => /^[A-Za-z_$][\w$]*$/.test(part))) {
      return [chain.root.name, ...chain.path].join('.');
    }
  }
  return undefined;
}

/**
 * Collect module-scope `const` literals so decorator configs can be resolved
 * at scan time: `@smrt({ ...NAME })`, `@smrt(NAME)`, `{ field: NAME }`.
 *
 * Declaration order is honoured: a constant may use an earlier constant, and
 * each is extracted against the map built so far. Only `const` is considered —
 * `let`/`var` could be reassigned between declaration and decorator evaluation,
 * so treating them as static would be unsound.
 *
 * With `resolveReferences`, three kinds are collected: object literals, array
 * literals, and scalars (string, number, boolean, `null`, including a
 * constant folded from other scalars). Without it, only object literals are,
 * with the raw-shape rules of {@link extractModuleObjectConstants}.
 *
 * Imported constants are intentionally NOT resolved (that would require
 * cross-file resolution); they surface as unresolved values and are reported
 * as scan errors instead of being silently dropped.
 *
 * A constant whose own initializer contains an unresolvable value is recorded
 * as TAINTED rather than dropped: its extracted value is only partial, so any
 * decorator that uses it replays the taint into its own diagnostics. Without
 * that, `const CFG = { ...IMPORTED }` followed by `@smrt({ ...CFG })` would
 * resolve cleanly against a partial object and report nothing — the exact
 * silent-drop failure mode this guard exists to prevent, one level removed.
 */
function collectModuleConstants(
  body: Statement[],
  sourceText: string,
  options: {
    resolveReferences?: boolean;
    enums?: DecoratorConfigContext['enums'];
    importAliases?: Map<string, string>;
    importBindings?: Map<string, ImportBinding>;
  },
): Map<string, ModuleConstant> {
  const constants = new Map<string, ModuleConstant>();

  for (const node of body) {
    // Both `const X = {}` and `export const X = {}`.
    const decl =
      node.type === 'VariableDeclaration'
        ? node
        : node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration'
          ? (node.declaration as VariableDeclaration)
          : null;

    if (decl?.kind !== 'const') continue;

    for (const declarator of decl.declarations) {
      if (declarator.id?.type !== 'Identifier') continue;
      const name = declarator.id.name;
      if (!name || !isSafeObjectKey(name)) continue;

      const init = unwrapTypeAssertion(declarator.init);
      if (!init) continue;
      const kind: ModuleConstant['kind'] =
        init.type === 'ObjectExpression'
          ? 'object'
          : init.type === 'ArrayExpression'
            ? 'array'
            : 'scalar';
      if (kind !== 'object' && !options.resolveReferences) continue;

      // Extract against the constants seen so far, so `const B = { ...A }`
      // resolves — and capture this constant's OWN unresolvable values as
      // taint rather than discarding them. Nothing is reported here: an unused
      // constant is not a manifest problem. The taint only becomes an error
      // when a decorator actually uses it, and it propagates transitively
      // because using a tainted constant re-collects its taint below.
      const unresolved: UnresolvedSpread[] = [];
      const dependencies: ModuleConstant['dependencies'] = [];
      const value = extractValue(init, sourceText, {
        constants,
        enums: options.enums,
        unresolved,
        dependencies,
        requireLiteralValues: true,
        resolveReferences: options.resolveReferences,
      });
      if (kind === 'scalar') {
        // Only an immutable value read in full is a scalar constant. An alias
        // of an object constant (`const ALIAS = CFG`) is not registered, so
        // the reference stays an escape of `CFG` and taints it.
        if (
          unresolved.length > 0 ||
          (value !== null &&
            typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean')
        ) {
          continue;
        }
        // Keep what the scalar was read from: a scalar copied from an object
        // constant's member (`const S = POLICY.sensitive`) is only as good as
        // that object, so a write to it anywhere in the module taints the
        // scalar too (see `propagateModuleConstantTaint`).
        constants.set(name, {
          kind,
          value,
          unresolved: [],
          unsafeReferences: [],
          dependencies,
        });
        continue;
      }
      constants.set(name, {
        kind,
        value: value === UNRESOLVED ? (kind === 'array' ? [] : {}) : value,
        unresolved,
        unsafeReferences: [],
        dependencies,
      });
    }
  }

  taintUnsafeModuleConstantReferences(body, constants, sourceText, options);
  propagateModuleConstantTaint(constants);
  return constants;
}

/**
 * Member values of each same-file `enum` whose members are all statically
 * known, so `Status.Active` reads as its value in a decorator config. A
 * computed or mixed enum yields no entry: a partial table would resolve some
 * members and silently miss others.
 */
function extractEnumMemberValues(
  body: Statement[],
): Map<string, Map<string, string | number>> {
  const enums = new Map<string, Map<string, string | number>>();
  for (const node of body) {
    const enumDecl =
      node.type === 'TSEnumDeclaration'
        ? node
        : node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'TSEnumDeclaration'
          ? node.declaration
          : null;
    const name = enumDecl?.id?.name;
    const members = enumDecl?.body?.members ?? enumDecl?.members;
    if (!name || !isSafeObjectKey(name) || !members) continue;
    const values = enumMemberValues(members);
    if (!values) continue;
    const table = new Map<string, string | number>();
    members.forEach((member, index) => {
      const key =
        member.id?.type === 'Identifier'
          ? member.id.name
          : typeof member.id?.value === 'string'
            ? member.id.value
            : undefined;
      if (key !== undefined) table.set(key, values[index]);
    });
    enums.set(name, table);
  }
  return enums;
}

/**
 * Conservatively taint shared config objects that escape their declaration or
 * a spread expression.
 *
 * `const` prevents rebinding, not mutation: `const CFG = { api: true };
 * CFG.api = false` is legal JavaScript. Snapshotting only the initializer would
 * therefore make the manifest say open while the runtime decorator sees
 * closed. A reference used as the direct argument of a spread is safe; any
 * other reference (property access, aliasing, function argument, assignment)
 * may mutate or escape the object, so decorators that later spread it fail
 * loudly instead of trusting a stale snapshot.
 */
function taintUnsafeModuleConstantReferences(
  body: Statement[],
  constants: Map<string, ModuleConstant>,
  sourceText: string,
  imports: {
    importAliases?: Map<string, string>;
    importBindings?: Map<string, ImportBinding>;
  } = {},
): void {
  if (![...constants.values()].some((constant) => constant.kind !== 'scalar')) {
    return;
  }

  const tainted = new Set<string>();
  // Every read-only reference of each object/array constant, to judge the
  // ones a static property holds once the walk is complete.
  const safeReferences = new Map<
    string,
    Array<{
      node: Record<string, unknown>;
      staticInitializer?: boolean;
      /** The module constant whose initializer holds this reference. */
      inConstant?: string;
    }>
  >();
  const taint = (node: Record<string, unknown>): void => {
    const name = node.name as string;
    if (tainted.has(name)) return;
    tainted.add(name);
    const unresolved = {
      expression: sliceSource(node as unknown as BaseNode, sourceText) ?? name,
      start:
        typeof node.start === 'number' ? (node.start as number) : undefined,
    };
    const constant = constants.get(name);
    constant?.unsafeReferences.push(unresolved);
    constant?.unresolved.push(unresolved);
  };

  const visit = (
    value: unknown,
    ancestors: Array<Record<string, unknown>>,
    shadowed: ReadonlySet<string>,
  ): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, ancestors, shadowed);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const node = value as Record<string, unknown>;
    if (typeof node.type !== 'string') {
      for (const child of Object.values(node))
        visit(child, ancestors, shadowed);
      return;
    }

    if (
      node.type === 'Identifier' &&
      typeof node.name === 'string' &&
      // A scalar cannot be mutated through a reference, so it never taints.
      (constants.get(node.name)?.kind ?? 'scalar') !== 'scalar' &&
      !shadowed.has(node.name) &&
      !isTypeOnlyReference(node, ancestors)
    ) {
      const via: { name?: boolean; staticInitializer?: boolean } = {};
      if (
        !isSafeModuleConstantReference(node, ancestors, constants, imports, via)
      ) {
        taint(node);
      } else if (!via.name) {
        const references = safeReferences.get(node.name) ?? [];
        references.push({
          node,
          staticInitializer: via.staticInitializer,
          inConstant: enclosingConstant(ancestors, constants),
        });
        safeReferences.set(node.name, references);
      }
    }

    const nextShadowed = createsLexicalScope(node)
      ? new Set([...shadowed, ...collectScopeBindings(node)])
      : shadowed;
    const nextAncestors = [...ancestors, node];
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end')
        continue;
      visit(child, nextAncestors, nextShadowed);
    }
  };

  visit(body, [], new Set());

  // A static property that holds a constant keeps a second, writable
  // reference to it on the class, which runtime code reaches through the
  // class or `this.constructor` where no static walk can follow. A write
  // through it changes every object reachable from that constant: the
  // constant itself, every constant it holds by reference or spreads with
  // nested objects, and every constant that holds one of those, at any depth.
  // So the static property is safe only when it is the sole reader of that
  // whole group; otherwise its reference taints the constant like an escape
  // (taint then propagates through the group, see
  // `propagateModuleConstantTaint`).
  const groups = sharedObjectGroups(constants);
  for (const [name, references] of safeReferences) {
    for (const held of references.filter((r) => r.staticInitializer)) {
      const group = groups.get(name) ?? new Set([name]);
      let readers = 0;
      for (const member of group) {
        for (const reference of safeReferences.get(member) ?? []) {
          // A reference inside another member's initializer is the edge
          // that put it in the group, not a reader of its own.
          if (reference.inConstant && group.has(reference.inConstant)) continue;
          readers++;
        }
      }
      if (readers > 1) taint(held.node);
    }
  }
}

/** The top-level module constant whose initializer `ancestors` lie in. */
function enclosingConstant(
  ancestors: Array<Record<string, unknown>>,
  constants: Map<string, ModuleConstant>,
): string | undefined {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index];
    if (node.type !== 'VariableDeclarator') continue;
    const id = node.id as Record<string, unknown> | undefined;
    return id?.type === 'Identifier' &&
      typeof id.name === 'string' &&
      constants.has(id.name)
      ? id.name
      : undefined;
  }
  return undefined;
}

/**
 * For each object or array constant, the constants that share objects with
 * it: linked by a by-reference use (`{ inner: POLICY }`) or by a spread whose
 * source holds nested objects (`{ ...WRAPPER }`), in either direction and
 * transitively. A write to any object of a group is visible to every reader
 * of the group.
 */
function sharedObjectGroups(
  constants: Map<string, ModuleConstant>,
): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!links.has(a)) links.set(a, new Set());
    links.get(a)?.add(b);
  };
  for (const [name, constant] of constants) {
    // A scalar copies a value out of the group when it is declared: it is a
    // reader of the group, never part of it.
    if (constant.kind === 'scalar') continue;
    for (const dependency of constant.dependencies) {
      const source = constants.get(dependency.name);
      if (!source || source.kind === 'scalar') continue;
      if (dependency.shared || hasNestedReferenceValue(source.value)) {
        link(name, dependency.name);
        link(dependency.name, name);
      }
    }
  }
  const groups = new Map<string, Set<string>>();
  for (const start of links.keys()) {
    if (groups.has(start)) continue;
    const group = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      for (const linked of links.get(next) ?? []) {
        if (!group.has(linked)) {
          group.add(linked);
          queue.push(linked);
        }
      }
    }
    for (const member of group) groups.set(member, group);
  }
  return groups;
}

function createsLexicalScope(node: Record<string, unknown>): boolean {
  return (
    node.type === 'BlockStatement' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'CatchClause' ||
    node.type === 'ForStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement' ||
    node.type === 'ClassDeclaration' ||
    node.type === 'ClassExpression'
  );
}

function collectScopeBindings(node: Record<string, unknown>): Set<string> {
  const bindings = new Set<string>();
  const addPattern = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const pattern = value as Record<string, unknown>;
    if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
      bindings.add(pattern.name);
      return;
    }
    if (pattern.type === 'RestElement') {
      addPattern(pattern.argument);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      addPattern(pattern.left);
      return;
    }
    if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
      for (const element of pattern.elements) addPattern(element);
      return;
    }
    if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
      for (const property of pattern.properties) {
        if (!property || typeof property !== 'object') continue;
        const propertyNode = property as Record<string, unknown>;
        addPattern(
          propertyNode.type === 'RestElement'
            ? propertyNode.argument
            : propertyNode.value,
        );
      }
    }
  };

  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    if (node.type !== 'ArrowFunctionExpression') addPattern(node.id);
    if (Array.isArray(node.params)) {
      for (const parameter of node.params) addPattern(parameter);
    }
    collectFunctionVarBindings(node.body, bindings);
  } else if (node.type === 'CatchClause') {
    addPattern(node.param);
  } else if (
    node.type === 'ForStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement'
  ) {
    const declaration = node.type === 'ForStatement' ? node.init : node.left;
    if (
      declaration &&
      typeof declaration === 'object' &&
      (declaration as Record<string, unknown>).type === 'VariableDeclaration'
    ) {
      for (const declarator of (declaration as Record<string, unknown>)
        .declarations as Array<Record<string, unknown>>) {
        addPattern(declarator.id);
      }
    }
  } else if (
    (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') &&
    node.id
  ) {
    addPattern(node.id);
  }

  if (node.type === 'BlockStatement' && Array.isArray(node.body)) {
    for (const statement of node.body as Array<Record<string, unknown>>) {
      const declaration =
        statement.type === 'ExportNamedDeclaration'
          ? (statement.declaration as Record<string, unknown> | undefined)
          : statement;
      if (declaration?.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations as Array<
          Record<string, unknown>
        >) {
          addPattern(declarator.id);
        }
      } else if (
        declaration?.type === 'FunctionDeclaration' ||
        declaration?.type === 'ClassDeclaration'
      ) {
        addPattern(declaration.id);
      }
    }
  }

  return bindings;
}

function collectFunctionVarBindings(
  value: unknown,
  bindings: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectFunctionVarBindings(entry, bindings);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return;
  }
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declarator of node.declarations as Array<
      Record<string, unknown>
    >) {
      const id = declarator.id as Record<string, unknown> | undefined;
      if (id?.type === 'Identifier' && typeof id.name === 'string') {
        bindings.add(id.name);
      }
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end')
      continue;
    collectFunctionVarBindings(child, bindings);
  }
}

function isTypeOnlyReference(
  identifier: Record<string, unknown>,
  ancestors: Array<Record<string, unknown>>,
): boolean {
  let child = identifier;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index];
    if (
      (parent.type === 'TSAsExpression' ||
        parent.type === 'TSSatisfiesExpression' ||
        parent.type === 'TSNonNullExpression' ||
        parent.type === 'TSTypeAssertion') &&
      parent.expression === child
    ) {
      child = parent;
      continue;
    }
    if (typeof parent.type === 'string' && parent.type.startsWith('TS')) {
      return true;
    }
    break;
  }
  return false;
}

function propagateModuleConstantTaint(
  constants: Map<string, ModuleConstant>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const constant of constants.values()) {
      for (const dependency of constant.dependencies) {
        const source = constants.get(dependency.name);
        if (!source) continue;
        for (const unresolved of source.unresolved) {
          if (
            !dependency.shared &&
            dependency.start !== undefined &&
            unresolved.start !== undefined &&
            unresolved.start > dependency.start &&
            !hasNestedReferenceValue(source.value)
          ) {
            continue;
          }
          if (
            !constant.unresolved.some(
              (existing) =>
                existing.expression === unresolved.expression &&
                existing.start === unresolved.start,
            )
          ) {
            constant.unresolved.push(unresolved);
            changed = true;
          }
        }
        if (dependency.shared || hasNestedReferenceValue(source.value)) {
          for (const unsafeReference of constant.unsafeReferences) {
            const matchesUnsafeReference = (existing: UnresolvedSpread) =>
              existing.expression === unsafeReference.expression &&
              existing.start === unsafeReference.start;
            if (!source.unresolved.some(matchesUnsafeReference)) {
              source.unresolved.push(unsafeReference);
              changed = true;
            }
            if (!source.unsafeReferences.some(matchesUnsafeReference)) {
              source.unsafeReferences.push(unsafeReference);
              changed = true;
            }
          }
        }
      }
    }
  }
}

function hasNestedReferenceValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(
    (entry) => entry !== null && typeof entry === 'object',
  );
}

/**
 * Whether `node` is the call of a decorator this scanner reads, as opposed to
 * an arbitrary function the constant would escape into. `parent` is the
 * node's direct ancestor.
 */
function isReadDecoratorCall(
  node: Record<string, unknown>,
  parent: Record<string, unknown> | undefined,
  imports: {
    importAliases?: Map<string, string>;
    importBindings?: Map<string, ImportBinding>;
  },
): boolean {
  if (
    node.type !== 'CallExpression' ||
    parent?.type !== 'Decorator' ||
    parent.expression !== node
  ) {
    return false;
  }
  const name = resolveDecoratorName(
    parent as unknown as Decorator,
    imports.importAliases,
    imports.importBindings,
  );
  return name !== null && READ_DECORATOR_NAMES.has(name);
}

function isSafeModuleConstantReference(
  identifier: Record<string, unknown>,
  ancestors: Array<Record<string, unknown>>,
  constants: Map<string, ModuleConstant>,
  imports: {
    importAliases?: Map<string, string>;
    importBindings?: Map<string, ImportBinding>;
  } = {},
  /**
   * Set to how the occurrence was judged safe: `name` when it is not a
   * reference at all (a declaration, a property key), `staticInitializer`
   * when a manifest static property holds it.
   */
  via: { name?: boolean; staticInitializer?: boolean } = {},
): boolean {
  let child = identifier;
  // Set once the walk passes a position that READS the constant as a value
  // (`{ api: CFG }`, `[CFG]`, `CFG.api`, `@smrt(CFG)`) rather than copying it.
  let readAsValue = false;

  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index];

    if (child === identifier) {
      if (parent.type === 'VariableDeclarator' && parent.id === child) {
        via.name = true;
        return true;
      }

      // A non-computed key is a name, not a reference. For a shorthand
      // property the key and value are distinct nodes over the same text;
      // the VALUE occurrence is the reference and is judged below.
      if (
        parent.type === 'Property' &&
        parent.key === child &&
        parent.computed === false &&
        parent.value !== child
      ) {
        via.name = true;
        return true;
      }

      if (
        parent.type === 'MemberExpression' &&
        parent.property === child &&
        parent.computed === false
      ) {
        via.name = true;
        return true;
      }
    }

    if (
      (parent.type === 'TSAsExpression' ||
        parent.type === 'TSSatisfiesExpression' ||
        parent.type === 'TSNonNullExpression' ||
        parent.type === 'TSTypeAssertion' ||
        parent.type === 'ParenthesizedExpression') &&
      parent.expression === child
    ) {
      child = parent;
      continue;
    }

    if (
      !readAsValue &&
      parent.type === 'SpreadElement' &&
      parent.argument === child
    ) {
      const name =
        typeof identifier.name === 'string' ? identifier.name : undefined;
      const constant = name ? constants.get(name) : undefined;
      if (!constant || !hasNestedReferenceValue(constant.value)) return true;

      const moduleConstantInitializer = [...constants.values()].some(
        (candidate) =>
          candidate.dependencies.some(
            (dependency) =>
              dependency.name === name && dependency.start === parent.start,
          ),
      );
      if (moduleConstantInitializer) return true;

      // A spread copies only the top level, so nested values stay shared with
      // whatever receives the copy. A decorator this scanner reads does not
      // mutate its config; anything else might.
      return ancestors.some((ancestor, at) =>
        isReadDecoratorCall(ancestor, ancestors[at - 1], imports),
      );
    }

    // The constant itself, or one of its members, is read as a value. Keep
    // walking through the literal that holds it: the reference is safe only
    // if that literal ends up as a read decorator's argument or as another
    // module constant's initializer.
    if (
      (parent.type === 'MemberExpression' &&
        parent.object === child &&
        (parent.computed === false ||
          (parent.property as Record<string, unknown> | undefined)?.type ===
            'Literal')) ||
      (parent.type === 'Property' && parent.value === child) ||
      (parent.type === 'SpreadElement' && parent.argument === child) ||
      parent.type === 'ObjectExpression' ||
      parent.type === 'ArrayExpression'
    ) {
      child = parent;
      readAsValue = true;
      continue;
    }

    if (
      parent.type === 'CallExpression' &&
      Array.isArray(parent.arguments) &&
      parent.arguments.includes(child)
    ) {
      return isReadDecoratorCall(parent, ancestors[index - 1], imports);
    }

    // The initializer of a static property the scanner reads into the
    // manifest: a read by the class, like a decorator argument.
    if (
      parent.type === 'PropertyDefinition' &&
      parent.value === child &&
      parent.static === true &&
      parent.computed === false
    ) {
      const key = parent.key as Record<string, unknown> | undefined;
      const read =
        key?.type === 'Identifier' &&
        typeof key.name === 'string' &&
        MANIFEST_STATIC_PROPERTIES.has(key.name);
      if (read) via.staticInitializer = true;
      return read;
    }

    if (parent.type === 'VariableDeclarator' && parent.init === child) {
      // Recorded while that declarator was extracted as a module constant;
      // any other declaration (a `let`, a function-local alias) is an escape.
      return [...constants.values()].some((candidate) =>
        candidate.dependencies.some(
          (dependency) =>
            dependency.shared === true &&
            dependency.name === identifier.name &&
            dependency.start === identifier.start,
        ),
      );
    }

    return false;
  }

  return false;
}

/**
 * Turn unresolvable decorator config values into `severity: 'error'` scan
 * diagnostics.
 *
 * Deliberately fail-loud rather than fail-quiet. A dropped value may have
 * carried `api`/`mcp`/`cli`, and an absent surface key means *default open* —
 * so silently discarding one converts a deliberate lockdown into a published
 * CRUD surface with no signal anywhere. Erroring matches the precedent in
 * `verify-completeness.ts`, where scan errors short-circuit so a broken source
 * can never masquerade as a complete manifest.
 *
 * @see https://github.com/happyvertical/smrt/issues/2100
 */
function reportUnresolvedSpreads(
  unresolved: UnresolvedSpread[],
  filePath: string,
  sourceText: string,
  errors: ScanError[],
): void {
  for (const spread of unresolved) {
    errors.push(unresolvedToScanError(spread, filePath, sourceText));
  }
}

/** One diagnostic naming the file, the class, the decorator and the option. */
function unresolvedToScanError(
  spread: UnresolvedSpread,
  filePath: string,
  sourceText: string,
): ScanError {
  const loc =
    spread.start === undefined
      ? undefined
      : getLineColumn(sourceText, spread.start);
  const target = spread.className
    ? spread.member
      ? `on \`${spread.className}.${spread.member}\``
      : `on class \`${spread.className}\``
    : undefined;
  const where = [
    target,
    spread.option ? `option \`${spread.option}\`` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
  return {
    message:
      `Cannot statically resolve \`${spread.expression}\` while expanding a ${spread.decorator ?? '@smrt()'} config${where ? ` (${where})` : ''}. ` +
      (spread.hint ??
        `Only literal keys/values and unescaped module-scope \`const\` literals ` +
          `in the same file are supported. Inline the value, or move it into such a ` +
          `constant and remove any mutation/alias of it — ` +
          `an unresolved expression would drop keys from the manifest, and every ` +
          `absent exposure key defaults to open.`),
    filePath,
    line: loc?.line,
    column: loc?.column,
    severity: 'error',
  };
}

/**
 * Name the decorator and its target on every diagnostic a single decorator
 * read added to the shared collector, which carries no identity of its own.
 */
function labelUnresolved(
  ctx: DecoratorConfigContext | undefined,
  from: number,
  label: Pick<UnresolvedSpread, 'decorator' | 'className' | 'member'>,
): void {
  if (!ctx) return;
  for (let index = from; index < ctx.unresolved.length; index++) {
    Object.assign(ctx.unresolved[index], label);
  }
}

/**
 * Extract class definition from an AST node
 */
function extractClassFromNode(
  node: Statement,
  filePath: string,
  sourceText: string,
  importAliases: Map<string, string>,
  ctx?: DecoratorConfigContext,
  outerStart?: number,
): RawClassDefinition | null {
  // Handle export declarations. `outerStart` carries the `export` keyword's
  // offset so the class JSDoc is found above it (decorators and `export` can
  // both sit between the comment and the `class` keyword).
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    return extractClassFromNode(
      node.declaration,
      filePath,
      sourceText,
      importAliases,
      ctx,
      node.start ?? outerStart,
    );
  }
  if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
    return extractClassFromNode(
      node.declaration as Statement,
      filePath,
      sourceText,
      importAliases,
      ctx,
      node.start ?? outerStart,
    );
  }

  // Handle class declaration
  if (node.type === 'ClassDeclaration') {
    return extractClassDeclaration(
      node,
      filePath,
      sourceText,
      importAliases,
      ctx,
      outerStart,
    );
  }

  return null;
}

/**
 * Extract class declaration details
 */
function extractClassDeclaration(
  node: ClassDeclaration,
  filePath: string,
  sourceText: string,
  importAliases: Map<string, string>,
  ctx?: DecoratorConfigContext,
  outerStart?: number,
): RawClassDefinition {
  const className = node.id?.name || 'AnonymousClass';

  // Extract decorators
  const decorators = node.decorators || [];
  const smrtDecorator = decorators.find((d) =>
    isSmrtDecorator(d, importAliases, ctx?.importBindings),
  );
  const reportDecorator = decorators.find((d) =>
    isNamedDecorator(d, 'report', importAliases, ctx?.importBindings),
  );
  const tenantScopedDecorator = decorators.find((d) =>
    isNamedDecorator(d, 'TenantScoped', importAliases, ctx?.importBindings),
  );
  const hasSmartDecorator = !!smrtDecorator;
  // Every class decorator is read with the same rules: a value is a literal,
  // resolves through a same-file constant, or is a scan error. `@report` and
  // `@TenantScoped` feed the schema (source model, tenant column), so a value
  // that silently became its own identifier name is as wrong there as a
  // dropped `api: false` is on `@smrt`.
  const referenceImports: RawReferenceImport[] = [];
  const readClassDecorator = (
    decorator: Decorator,
    label: string,
    classReference?: DecoratorConfigContext['classReference'],
  ): RawDecoratorConfig | null => {
    const from = ctx?.unresolved.length ?? 0;
    const config = extractDecoratorConfig(
      decorator,
      sourceText,
      ctx
        ? {
            ...ctx,
            requireLiteralValues: true,
            path: undefined,
            classReference,
            referenceImports,
          }
        : ctx,
    );
    labelUnresolved(ctx, from, { decorator: label, className });
    return config;
  };
  const smrtConfig = smrtDecorator
    ? readClassDecorator(smrtDecorator, '@smrt()')
    : null;
  const decoratorConfig =
    tenantScopedDecorator || reportDecorator
      ? {
          ...(smrtConfig ?? {}),
          ...(reportDecorator
            ? {
                report: readClassDecorator(
                  reportDecorator,
                  '@report()',
                  isReportClassReferencePath,
                ),
              }
            : {}),
          ...(tenantScopedDecorator
            ? {
                tenantScoped: readClassDecorator(
                  tenantScopedDecorator,
                  '@TenantScoped()',
                ),
              }
            : {}),
        }
      : smrtConfig;

  // Extract extends clause
  const {
    extendsClause,
    extendsTypeArg,
    extendsSource,
    extendsDefaultImport,
    extendsUnreadable,
  } = extractExtendsClause(node, importAliases, ctx?.importBindings);

  // Extract fields and methods
  const fields: RawFieldDefinition[] = [];
  const methods: RawMethodDefinition[] = [];

  // Field decorators and static properties are read into their own collector:
  // whether they are diagnostics at all depends on the class being a model,
  // which is known here only when it carries `@smrt()`.
  const memberCtx = ctx ? { ...ctx, unresolved: [] } : ctx;
  // A class decorator decides whether the class is a model at all
  // (`@smrt`), so one the reader cannot name is reported now, before model
  // filtering could drop the class and its diagnostic together.
  recordUnnamedNamespaceDecorators(decorators, sourceText, ctx, {
    className,
  });
  for (const member of node.body.body) {
    if (member.type === 'PropertyDefinition') {
      const field = extractPropertyDefinition(
        member,
        sourceText,
        memberCtx,
        className,
      );
      if (field) {
        fields.push(field);
      }
    } else if (member.type === 'MethodDefinition') {
      recordUnnamedNamespaceDecorators(
        member.decorators,
        sourceText,
        memberCtx,
        {
          className,
          member:
            member.key.type === 'Identifier' ? member.key.name : undefined,
        },
      );
      const method = extractMethodDefinition(
        member,
        sourceText,
        ctx,
        className,
      );
      if (method) {
        methods.push(method);
      }
    }
  }

  // A `@smrt()` class is a model: report now. Any other class is held back
  // until inheritance shows whether it reaches the manifest
  // (`RawClassDefinition.configErrors`).
  const configErrors: ScanError[] = [];
  if (ctx && memberCtx && memberCtx.unresolved.length > 0) {
    if (hasSmartDecorator) {
      ctx.unresolved.push(...memberCtx.unresolved);
    } else {
      for (const unresolved of memberCtx.unresolved) {
        configErrors.push(
          unresolvedToScanError(unresolved, filePath, sourceText),
        );
      }
    }
  }

  const explicitDescription =
    typeof smrtConfig?.description === 'string'
      ? normalizeModelDescription(smrtConfig.description)
      : undefined;
  const description =
    explicitDescription ??
    extractClassJsDocDescription(
      sourceText,
      className,
      [node.start, outerStart, ...decorators.map((d) => d.start)].filter(
        (n): n is number => typeof n === 'number',
      ),
    );

  return {
    className,
    filePath,
    extendsClause,
    extendsTypeArg,
    ...(extendsSource ? { extendsSource } : {}),
    ...(extendsDefaultImport ? { extendsDefaultImport } : {}),
    ...(extendsUnreadable ? { extendsUnreadable } : {}),
    decoratorConfig,
    hasSmartDecorator,
    ...(description ? { description } : {}),
    fields,
    methods,
    startLine: node.loc?.start.line || 1,
    endLine: node.loc?.end.line || 1,
    ...(typeof node.body?.start === 'number'
      ? { bodyStart: node.body.start }
      : {}),
    ...(configErrors.length > 0 ? { configErrors } : {}),
    ...(referenceImports.length > 0 ? { referenceImports } : {}),
  };
}

/**
 * The value re-exports of a module: `export { A as B } from './a'`,
 * `export * from './a'`, and the local rename `export { A as B }`. The
 * inheritance resolver follows them to find the file that declares a class
 * imported through a barrel.
 */
function extractReExports(statements: Statement[]): RawReExport[] {
  const reExports: RawReExport[] = [];
  for (const node of statements) {
    const loose = node as unknown as {
      type: string;
      source?: Literal | null;
      exportKind?: string;
      exported?: unknown;
    };
    if (loose.type === 'ExportAllDeclaration') {
      const source = loose.source?.value;
      // `export * as ns from` binds a namespace object, not the classes.
      if (
        typeof source === 'string' &&
        !loose.exported &&
        loose.exportKind !== 'type'
      ) {
        reExports.push({ source });
      }
      continue;
    }
    if (
      node.type !== 'ExportNamedDeclaration' ||
      node.declaration ||
      node.exportKind === 'type'
    ) {
      continue;
    }
    const source = node.source?.value;
    for (const specifier of node.specifiers) {
      if (specifier.exportKind === 'type') continue;
      const imported = specifier.local?.name;
      const exported = specifier.exported?.name;
      if (!imported || !exported) continue;
      if (typeof source === 'string') {
        reExports.push({ source, imported, exported });
      } else if (imported !== exported) {
        reExports.push({ imported, exported });
      }
    }
  }
  return reExports;
}

/**
 * What a module exports, by exported name, and the modules it re-exports
 * whole (`export *`). A named export is a local binding of the file (a
 * declaration, or an import it re-exports: `import { A } from './a';
 * export { A }`) or a binding of another module (`export { A as B } from
 * './a'`). The module resolver follows these to the declaring class.
 */
function extractModuleExports(statements: Statement[]): RawModuleExports {
  const named: RawModuleExports['named'] = {};
  const star: string[] = [];
  // Interfaces and type aliases: `export { Name }` of one exports no value.
  const typeNames = new Set<string>();
  const classNames = extractTopLevelClassNames(statements);
  for (const node of statements) {
    const declaration = (
      node.type === 'ExportNamedDeclaration' ? node.declaration : node
    ) as { type?: string; id?: { name?: string } | null } | null | undefined;
    if (
      (declaration?.type === 'TSInterfaceDeclaration' ||
        declaration?.type === 'TSTypeAliasDeclaration') &&
      declaration.id?.name
    ) {
      typeNames.add(declaration.id.name);
    }
  }
  for (const node of statements) {
    const loose = node as unknown as {
      type: string;
      source?: Literal | null;
      exportKind?: string;
      exported?: { name?: string; value?: string } | null;
      declaration?: {
        type?: string;
        id?: { name?: string } | null;
        name?: string;
        declarations?: Array<{ id?: { type?: string; name?: string } }>;
      } | null;
    };
    if (loose.exportKind === 'type') continue;
    if (loose.type === 'ExportAllDeclaration') {
      const source = loose.source?.value;
      if (typeof source !== 'string') continue;
      const as = loose.exported?.name ?? loose.exported?.value;
      if (as) named[as] = { from: source, imported: null };
      else star.push(source);
      continue;
    }
    if (loose.type === 'ExportDefaultDeclaration') {
      const declaration = loose.declaration;
      const local =
        declaration?.type === 'Identifier'
          ? declaration.name
          : declaration?.type === 'ClassDeclaration'
            ? declaration.id?.name
            : undefined;
      named.default = local ? { local } : { local: '' };
      continue;
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    const declaration = loose.declaration;
    if (declaration) {
      // Types and ambient declarations bind no runtime value.
      if (
        (declaration as { declare?: boolean }).declare === true ||
        declaration.type === 'TSInterfaceDeclaration' ||
        declaration.type === 'TSTypeAliasDeclaration' ||
        declaration.type === 'TSModuleDeclaration' ||
        declaration.type === 'TSDeclareFunction'
      ) {
        continue;
      }
      if (declaration.type === 'ClassDeclaration' && declaration.id?.name) {
        named[declaration.id.name] = { local: declaration.id.name };
      } else if (declaration.type === 'VariableDeclaration') {
        for (const d of declaration.declarations ?? []) {
          if (d.id?.type === 'Identifier' && d.id.name) {
            named[d.id.name] = { local: d.id.name };
          }
        }
      } else if (declaration.id?.name) {
        named[declaration.id.name] = { local: declaration.id.name };
      }
      continue;
    }
    const source = node.source?.value;
    for (const specifier of node.specifiers) {
      if (specifier.exportKind === 'type') continue;
      const local = specifier.local as { name?: string; value?: string };
      const exported = specifier.exported as { name?: string; value?: string };
      const localName = local?.name ?? local?.value;
      const exportedName = exported?.name ?? exported?.value;
      if (!localName || !exportedName) continue;
      if (
        typeof source !== 'string' &&
        typeNames.has(localName) &&
        !classNames.has(localName)
      ) {
        continue;
      }
      named[exportedName] =
        typeof source === 'string'
          ? { from: source, imported: localName }
          : { local: localName };
    }
  }
  return { named, star };
}

/** Only a local value export matching the imported parent names a replacement. */
function resolveReplacementExports(
  classes: RawClassDefinition[],
  statements: Statement[],
): void {
  for (const node of statements) {
    if (
      node.type !== 'ExportNamedDeclaration' ||
      node.source ||
      node.exportKind === 'type'
    )
      continue;
    for (const specifier of node.specifiers) {
      if (specifier.exportKind === 'type') continue;
      const model = classes.find(
        (entry) => entry.className === specifier.local.name,
      );
      if (
        model?.extendsSource &&
        specifier.exported.name === model.extendsClause
      ) {
        model.exportName = specifier.exported.name;
      }
    }
  }
}

const MODEL_DESCRIPTION_MAX = 200;

/** Collapse whitespace and cap at {@link MODEL_DESCRIPTION_MAX}, cutting at a sentence boundary. */
function normalizeModelDescription(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= MODEL_DESCRIPTION_MAX) return text;
  const head = text.slice(0, MODEL_DESCRIPTION_MAX);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
  );
  if (sentenceEnd > 0) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(' ');
  return `${(wordEnd > 0 ? head.slice(0, wordEnd) : head).replace(/[,;:\s]+$/, '')}…`;
}

/**
 * Summarize the JSDoc block directly above a class (before any `export` or
 * decorators) as a one-line model description: the first paragraph, minus a
 * leading `ClassName - ` / `ClassName: ` prefix, tags and inline markup.
 * `@internal` classes yield nothing. Pure text work on the already-parsed
 * source; nothing is executed.
 */
export function extractClassJsDocDescription(
  sourceText: string,
  className: string,
  anchors: number[],
): string | undefined {
  if (anchors.length === 0) return undefined;
  const before = sourceText.slice(0, Math.min(...anchors)).trimEnd();
  if (!before.endsWith('*/')) return undefined;
  const open = before.lastIndexOf('/**');
  if (open < 0 || before.indexOf('*/', open) !== before.length - 2) {
    return undefined;
  }
  return summarizeJsDoc(before.slice(open, before.length), className);
}

/** @internal Exported for testing. */
export function summarizeJsDoc(
  block: string,
  className: string,
): string | undefined {
  const lines = block
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd());
  const summary: string[] = [];
  let internal = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*@internal\b/.test(line)) internal = true;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*@\w+/.test(line)) {
      summary.push('\u0000');
      continue;
    }
    summary.push(line);
  }
  if (internal) return undefined;
  const paragraph: string[] = [];
  for (const line of summary) {
    if (line === '\u0000') break;
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  let text = paragraph.join(' ');
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text
    .replace(new RegExp(`^${escaped}\\s*(?:[-\u2013\u2014:]+)\\s*`), '')
    .replace(
      /\{@(?:link|linkcode|linkplain)\s+([^}|\s]+)(?:[|\s]+([^}]*))?\}/g,
      (_m, target, label) => (label?.trim() ? label.trim() : target),
    )
    .replace(/\{@\w+\s*([^}]*)\}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2');
  if (text.length > 0) text = text[0].toUpperCase() + text.slice(1);
  return normalizeModelDescription(text);
}

/**
 * Decorators whose arguments this scanner reads into the manifest. A module
 * constant handed to one of them is read, not mutated, so the reference is
 * not an escape.
 */
const READ_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'smrt',
  'TenantScoped',
  'report',
  'method',
  'field',
  'meta',
  'tenantId',
  'foreignKey',
  'crossPackageRef',
  'oneToMany',
  'manyToMany',
  'groupBy',
  'aggregate',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);

/**
 * What each positional argument of a field decorator holds, by decorator.
 *
 * - `options`: an options object. Read statically; an unreadable value is a
 *   scan diagnostic.
 * - `text`: a string (a column, a qualified model name), or an options object
 *   where the decorator accepts either. Read statically.
 * - `target`: a relationship target — a class name string, a class
 *   reference, or a `() => Class` thunk. A class cannot be read as a literal,
 *   so a reference is recorded by name; only an expression that identifies no
 *   class at all is a diagnostic.
 */
const FIELD_DECORATOR_ARGUMENTS: Readonly<
  Record<string, ReadonlyArray<'options' | 'text' | 'target'>>
> = {
  field: ['options'],
  meta: ['options'],
  tenantId: ['options'],
  foreignKey: ['target', 'options'],
  oneToMany: ['target', 'options'],
  manyToMany: ['target', 'options'],
  crossPackageRef: ['text', 'options'],
  groupBy: ['text'],
  aggregate: ['options'],
  sum: ['text', 'options'],
  avg: ['text', 'options'],
  min: ['text', 'options'],
  max: ['text', 'options'],
  count: ['text', 'options'],
  minute: ['text'],
  hour: ['text'],
  day: ['text'],
  week: ['text'],
  month: ['text'],
  quarter: ['text'],
  year: ['text'],
};

/**
 * What argument `index` of field decorator `name` holds, or `undefined` for
 * a decorator or position the scanner does not read.
 */
export function fieldDecoratorArgumentKind(
  name: string,
  index: number,
): 'options' | 'text' | 'target' | undefined {
  return Object.hasOwn(FIELD_DECORATOR_ARGUMENTS, name)
    ? FIELD_DECORATOR_ARGUMENTS[name][index]
    : undefined;
}

/** Static properties the manifest carries for agent classes. */
export const MANIFEST_STATIC_PROPERTIES: ReadonlySet<string> = new Set([
  'uiSlots',
  'adminRoutes',
  'signalSubscriptions',
  'createEntries',
]);

/**
 * Decorators whose `validate` option is a runtime callback: a custom
 * validator function on a plain field (`@field`, and `@meta`, which takes the
 * same options). Nowhere else is `validate` a callback; on
 * `@crossPackageRef` it is a boolean that turns on save-time checking, and on
 * every other decorator it is not an option. There it is read with the
 * static rules like any option, so an unreadable value is a scan error and
 * never silently drops the check.
 */
const RUNTIME_VALIDATE_DECORATORS: ReadonlySet<string> = new Set([
  'field',
  'meta',
]);

function isValidateOption(path: string | undefined): boolean {
  return path === 'validate';
}

/**
 * The runtime-only option rule for one field decorator: the option paths
 * whose value is accepted without being read (recorded as stated, with no
 * value). `undefined` for a decorator that has none, so every option of it is
 * read statically. Keyed on the decorator, never on the option name alone.
 */
export function runtimeOnlyFieldOptions(
  decoratorName: string,
): ((path: string | undefined) => boolean) | undefined {
  return RUNTIME_VALIDATE_DECORATORS.has(decoratorName)
    ? isValidateOption
    : undefined;
}

/**
 * `@report()` option paths that hold a model class: the report source and
 * each join's source. Recorded by class name, like a relationship target.
 */
function isReportClassReferencePath(path: string | undefined): boolean {
  return path === 'source' || /^joins\.[^.]+\.source$/.test(path ?? '');
}

/**
 * The exported name of the decorator applied by `@x`, `@x()`, `@ns.x` or
 * `@ns.x()`, or `null` for any other expression.
 *
 * A renamed import binds the decorator to a different local identifier
 * (`import { smrt as model }`), and a namespace import reaches it as a member
 * (`import * as core` then `@core.smrt()`). Both still run the real decorator,
 * so both must be recognized here: a decorator the scanner does not see
 * leaves the manifest without the config the runtime applies.
 */
function resolveDecoratorName(
  decorator: Decorator,
  importAliases?: Map<string, string>,
  importBindings?: Map<string, ImportBinding>,
): string | null {
  const expr = decorator.expression;
  const callee = expr.type === 'CallExpression' ? expr.callee : expr;
  if (callee.type === 'Identifier') {
    return importAliases?.get(callee.name) ?? callee.name;
  }
  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    importBindings?.get(callee.object.name)?.imported === null
  ) {
    // `ns.field` and `ns['field']` name the same export.
    if (!callee.computed && callee.property.type === 'Identifier') {
      return callee.property.name;
    }
    if (
      callee.computed &&
      callee.property.type === 'Literal' &&
      typeof callee.property.value === 'string'
    ) {
      return callee.property.value;
    }
    // `ns[KEY]` with `const KEY = 'smrt'` in this file names that export,
    // but only through a clean read: a scalar copied from an object member
    // that a module statement writes is not the string its initializer
    // shows, so the decorator stays unnamed (and is reported).
    if (callee.computed && callee.property.type === 'Identifier') {
      const constant = CONSTANTS_BY_BINDINGS.get(importBindings)?.get(
        callee.property.name,
      );
      if (
        constant?.kind === 'scalar' &&
        typeof constant.value === 'string' &&
        constant.unresolved.length === 0 &&
        constant.unsafeReferences.length === 0
      ) {
        return constant.value;
      }
    }
  }
  return null;
}

/**
 * Each file's module constants, keyed by its import-binding table, so the
 * decorator-name reader (which receives the bindings) can resolve a
 * computed namespace member through a same-file string constant.
 */
const CONSTANTS_BY_BINDINGS = new WeakMap<
  Map<string, ImportBinding>,
  Map<string, ModuleConstant>
>();

/**
 * A decorator reached through a namespace import by a computed member the
 * reader cannot name (`ns[key]`). Which export it is cannot be known, so it
 * may be a field decorator whose options would be lost: a scan error.
 */
/**
 * Record every decorator in `decorators` reached through a namespace import
 * by a computed member the reader cannot name, labeled with the class and
 * member it decorates. Class and method decorators carry exposure and
 * tenancy (`@smrt`, `@TenantScoped`, `@method`): one silently not read is a
 * model published open.
 */
function recordUnnamedNamespaceDecorators(
  decorators: readonly Decorator[] | undefined,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
  target: { className?: string; member?: string },
): void {
  if (!ctx?.resolveReferences || !decorators) return;
  for (const decorator of decorators) {
    if (!isUnnamedNamespaceDecorator(decorator, ctx.importBindings)) continue;
    const from = ctx.unresolved.length;
    ctx.unresolved.push({
      expression:
        sliceSource(decorator.expression, sourceText) ?? '<decorator>',
      start: decorator.start,
    });
    labelUnresolved(ctx, from, {
      decorator: '@<namespace member>()',
      className: target.className,
      member: target.member,
    });
  }
}

function isUnnamedNamespaceDecorator(
  decorator: Decorator,
  importBindings?: Map<string, ImportBinding>,
): boolean {
  if (resolveDecoratorName(decorator, undefined, importBindings) !== null) {
    return false;
  }
  const expr = decorator.expression;
  const callee = expr.type === 'CallExpression' ? expr.callee : expr;
  return (
    callee.type === 'MemberExpression' &&
    callee.computed &&
    callee.object.type === 'Identifier' &&
    importBindings?.get(callee.object.name)?.imported === null &&
    !(
      callee.property.type === 'Literal' &&
      typeof callee.property.value === 'string'
    )
  );
}

/**
 * Check if a decorator is @smrt()
 */
function isSmrtDecorator(
  decorator: Decorator,
  importAliases?: Map<string, string>,
  importBindings?: Map<string, ImportBinding>,
): boolean {
  return isNamedDecorator(decorator, 'smrt', importAliases, importBindings);
}

function isNamedDecorator(
  decorator: Decorator,
  name: string,
  importAliases?: Map<string, string>,
  importBindings?: Map<string, ImportBinding>,
): boolean {
  return (
    resolveDecoratorName(decorator, importAliases, importBindings) === name
  );
}

/**
 * Extract a class or method decorator's configuration object.
 *
 * `@smrt()` and a bare `@smrt` declare no config and read as `{}`. Any
 * argument that IS supplied must resolve to an object: a literal, or an
 * identifier naming a same-file module constant (`@smrt(MODEL_CONFIG)`).
 * Anything else — a call, an imported constant, a non-object — is recorded
 * as unresolved and becomes a scan error. Supplied config that cannot be read
 * is never the same thing as no config: `{}` here would publish every
 * default-open surface the argument was written to close.
 */
function extractDecoratorConfig(
  decorator: Decorator,
  sourceText: string,
  ctx?: DecoratorConfigContext,
): RawDecoratorConfig | null {
  const expr = decorator.expression;

  if (expr.type === 'CallExpression' && expr.arguments.length > 0) {
    const arg = unwrapTypeAssertion(expr.arguments[0]);
    if (arg?.type === 'ObjectExpression') {
      return extractObjectLiteral(arg, sourceText, ctx) as RawDecoratorConfig;
    }
    if (arg && ctx?.resolveReferences) {
      const value = extractValue(arg, sourceText, ctx);
      if (isPlainRecord(value)) return value as RawDecoratorConfig;
      // `extractValue` already recorded an expression it could not resolve.
      // One that resolved to something other than an object is not a config.
      if (value !== UNRESOLVED && value !== undefined) {
        ctx.unresolved.push({
          expression: sliceSource(arg, sourceText) ?? '<argument>',
          start: arg.start,
        });
      }
    }
  }

  // @smrt() with no config or @smrt
  return {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof RegExp)
  );
}

/**
 * Extract object literal to plain object
 */
function extractObjectLiteral(
  node: ObjectExpression,
  sourceText: string,
  ctx?: DecoratorConfigContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const recordUnresolved = (expression: BaseNode, fallback: string): void => {
    ctx?.unresolved.push({
      expression: sliceSource(expression, sourceText) ?? fallback,
      start: expression.start,
      ...(ctx.path ? { option: ctx.path } : {}),
    });
  };

  // Iterate in source order so spread/property precedence matches runtime
  // semantics: `{ api: true, ...CFG }` takes `api` from CFG, while
  // `{ ...CFG, api: true }` overrides it.
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      // A spread that reaches the manifest as "absent" is indistinguishable
      // from a surface the author never declared — and absent means default
      // *open*. Resolve it, or record it for a scan error. Never drop it
      // silently. See issue #2100.
      const argument = unwrapTypeAssertion(prop.argument);
      // Class-reference provenance recorded before this spread; the spread
      // replaces it for every key it writes.
      const provenanceBefore = ctx?.referenceImports?.length ?? 0;
      const constant =
        argument?.type === 'Identifier'
          ? ctx?.constants.get(argument.name)
          : undefined;
      const copied = constant?.kind === 'object' ? constant : undefined;
      let resolved: unknown = copied?.value;
      if (!copied && argument) {
        if (argument.type === 'ObjectExpression') {
          resolved = extractObjectLiteral(argument, sourceText, ctx);
        } else if (ctx?.resolveReferences && argument.type !== 'Identifier') {
          // `...CFG.api`, `...Enum.x`: read like any other value. A failure is
          // recorded by `extractValue` itself.
          resolved = extractValue(argument, sourceText, ctx);
          if (resolved === UNRESOLVED) continue;
        }
      }

      if (isPlainRecord(resolved)) {
        if (copied && ctx?.dependencies && argument?.type === 'Identifier') {
          ctx.dependencies.push({
            name: argument.name,
            start: prop.start,
          });
        }
        for (const [key, value] of Object.entries(resolved)) {
          if (isSafeObjectKey(key)) {
            clearReferenceProvenance(
              ctx,
              ctx?.path ? `${ctx.path}.${key}` : key,
              provenanceBefore,
            );
            // Copy nested values: two classes that spread one constant must
            // not end up sharing a nested config object in the manifest. The
            // raw-shape reader keeps identity, which its consumer dedupes on.
            result[key] =
              copied && ctx?.resolveReferences
                ? cloneStaticValue(value)
                : value;
          }
        }
        // A tainted constant resolved to a PARTIAL object — replay the spreads
        // its own initializer could not resolve, or the drop would go unnoticed
        // here even though this site depends on the missing keys.
        if (copied?.unresolved.length && ctx && !ctx.dependencies) {
          ctx.unresolved.push(
            ...copied.unresolved
              .filter(
                (unresolved) =>
                  hasNestedReferenceValue(copied.value) ||
                  prop.start === undefined ||
                  unresolved.start === undefined ||
                  unresolved.start <= prop.start,
              )
              .map((unresolved) => ({ ...unresolved })),
          );
        }
      } else if (ctx) {
        recordUnresolved(prop, '...<unknown>');
      }
      continue;
    }

    if (prop.type === 'Property') {
      const key = getPropertyKey(prop.key);
      // A key the reader cannot name (a computed expression, a bigint) is a
      // scan error, never a silently missing property.
      if (
        key === null ||
        (prop.shorthand && !ctx?.resolveReferences) ||
        (prop.computed && prop.key.type !== 'Literal')
      ) {
        recordUnresolved(prop, '<unknown property>');
        continue;
      }
      // Skip prototype-pollution keys (__proto__/constructor/prototype) so a
      // decorator-config property of that name cannot mutate the metadata
      // object's prototype.
      // `''` is a valid key; test against null, not truthiness.
      if (isSafeObjectKey(key)) {
        const path = ctx?.path ? `${ctx.path}.${key}` : key;
        // This property replaces whatever an earlier property or spread
        // wrote for the key, provenance included.
        clearReferenceProvenance(ctx, path, ctx?.referenceImports?.length ?? 0);
        const child = ctx ? { ...ctx, path } : ctx;
        const value = ctx?.runtimeOnly?.(path)
          ? extractRuntimeOnlyValue(prop.value, sourceText, child)
          : extractValue(prop.value, sourceText, child);
        if (value !== UNRESOLVED) result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Copy a statically read value, so one module constant used by several
 * decorators never becomes one shared object across their manifest entries.
 */
function cloneStaticValue<T>(value: T): T {
  return value !== null && typeof value === 'object'
    ? structuredClone(value)
    : value;
}

/**
 * Get property key as string
 */
function getPropertyKey(node: Expression): string | null {
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  // A numeric key names the property by its JavaScript string form:
  // `{ 0: 'draft' }` and `{ 1.50: x }` have keys "0" and "1.5".
  if (
    node.type === 'Literal' &&
    typeof node.value === 'number' &&
    Number.isFinite(node.value)
  ) {
    return String(node.value);
  }
  return null;
}

/**
 * Record a value the reader cannot resolve and return what stands in for it:
 * {@link UNRESOLVED} for a decorator reader (the key is dropped and the scan
 * fails), or the expression's source text for the raw-shape reader.
 */
function unresolvedValue(
  node: BaseNode,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
  fallback?: string,
): unknown {
  const source = sliceSource(node, sourceText) ?? fallback;
  if (ctx?.requireLiteralValues && source !== undefined) {
    ctx.unresolved.push({
      expression: source,
      start: node.start,
      ...(ctx.path ? { option: ctx.path } : {}),
    });
  }
  return ctx?.resolveReferences ? UNRESOLVED : source;
}

/**
 * Read `root` (or `root.path…`) from the module constant table or a same-file
 * enum. Returns {@link UNRESOLVED}, without recording anything, when the name
 * is not a static declaration of this file.
 */
function resolveStaticReference(
  root: Identifier,
  path: string[],
  ctx: DecoratorConfigContext,
): unknown {
  const constant = ctx.constants.get(root.name);
  if (constant) {
    let value = constant.value;
    for (const key of path) {
      if (
        value === null ||
        typeof value !== 'object' ||
        !isSafeObjectKey(key) ||
        !Object.hasOwn(value, key)
      ) {
        return UNRESOLVED;
      }
      value = (value as Record<string, unknown>)[key];
    }
    // An object or array constant: the decorator receives the constant
    // itself, not a copy, so a mutation anywhere in the module changes what
    // the runtime sees and every taint on it applies here, whatever its
    // position. A scalar carries the taint of the object it was copied from.
    if (constant.kind !== 'scalar' || constant.dependencies.length > 0) {
      if (ctx.dependencies) {
        ctx.dependencies.push({
          name: root.name,
          start: root.start,
          shared: true,
        });
      } else if (constant.unresolved.length > 0) {
        ctx.unresolved.push(
          ...constant.unresolved.map((unresolved) => ({ ...unresolved })),
        );
      }
    }
    return cloneStaticValue(value);
  }
  if (path.length === 1) {
    const member = ctx.enums?.get(root.name)?.get(path[0]);
    if (member !== undefined) return member;
  }
  return UNRESOLVED;
}

/**
 * `A.b.c` or `A['b']` as its root identifier and key path, or `null` for a
 * member expression with a computed, non-literal step.
 */
function staticMemberChain(
  node: MemberExpression,
): { root: Identifier; path: string[] } | null {
  const path: string[] = [];
  let current: Expression = node;
  while (current.type === 'MemberExpression') {
    const property = current.property;
    if (!current.computed && property.type === 'Identifier') {
      path.unshift(property.name);
    } else if (
      current.computed &&
      property.type === 'Literal' &&
      (typeof property.value === 'string' || typeof property.value === 'number')
    ) {
      path.unshift(String(property.value));
    } else {
      return null;
    }
    const object = unwrapTypeAssertion(current.object);
    if (!object) return null;
    current = object;
  }
  return current.type === 'Identifier' ? { root: current, path } : null;
}

/**
 * Extract value from expression
 */
function extractValue(
  node: Expression | Pattern,
  sourceText: string,
  ctx?: DecoratorConfigContext,
): unknown {
  const value = extractValueOf(node, sourceText, ctx);
  // A manifest is JSON: `Infinity`, `NaN` and a non-finite folded result
  // would be written as `null`, which clears a limit instead of carrying it.
  if (
    ctx?.resolveReferences &&
    typeof value === 'number' &&
    !Number.isFinite(value)
  ) {
    return unresolvedValue(node, sourceText, ctx);
  }
  return value;
}

function extractValueOf(
  node: Expression | Pattern,
  sourceText: string,
  ctx?: DecoratorConfigContext,
): unknown {
  const unwrapped = unwrapTypeAssertion(node as Expression);
  if (unwrapped && unwrapped !== node) {
    return extractValue(unwrapped, sourceText, ctx);
  }
  const resolving = ctx?.resolveReferences === true;

  switch (node.type) {
    case 'Literal':
      if (resolving) {
        if (node.regex) {
          // A regular-expression literal is static syntax; constructing it
          // runs no source.
          try {
            return new RegExp(node.regex.pattern, node.regex.flags);
          } catch {
            return unresolvedValue(node, sourceText, ctx);
          }
        }
        // A bigint has no JSON form to carry into the manifest.
        if (typeof node.value === 'bigint') {
          return unresolvedValue(node, sourceText, ctx);
        }
      }
      return node.value;

    case 'Identifier':
      // Handle special identifiers
      if (node.name === 'undefined') return undefined;
      if (node.name === 'null') return null;
      if (node.name === 'true') return true;
      if (node.name === 'false') return false;
      if (resolving && ctx) {
        const resolved = resolveStaticReference(node, [], ctx);
        if (resolved !== UNRESOLVED) return resolved;
        if (ctx.classReference?.(ctx.path)) {
          const identity = classIdentity(node.name, ctx);
          if (identity) return recordReference(identity, ctx);
        }
        return unresolvedValue(node, sourceText, ctx, node.name);
      }
      if (ctx?.requireLiteralValues) {
        ctx.unresolved.push({
          expression: sliceSource(node, sourceText) ?? node.name,
          start: node.start,
        });
      }
      return node.name; // Return as string for class references

    case 'ArrayExpression': {
      const elements: unknown[] = [];
      for (const el of node.elements) {
        if (el === null || typeof el !== 'object' || !('type' in el)) {
          // A hole (`[, true]`) is `undefined` at its index at runtime;
          // skipping it would shift every later element. It is unreadable.
          elements.push(undefined);
          ctx?.unresolved.push({
            expression: `a hole in ${sliceSource(node, sourceText) ?? 'an array'}`,
            start: node.start,
            ...(ctx.path ? { option: ctx.path } : {}),
          });
          continue;
        }
        if (el.type === 'SpreadElement') {
          // `include: [...BASE_ACTIONS, 'archive']` must not vanish silently:
          // a dropped element changes an include/exclude allowlist. Resolve a
          // same-file array, or record it for a scan error.
          const spread = resolving
            ? resolveArraySpread(el, sourceText, ctx)
            : UNRESOLVED;
          if (Array.isArray(spread)) {
            elements.push(...spread);
          } else if (ctx) {
            ctx.unresolved.push({
              expression: sliceSource(el, sourceText) ?? '...<unknown>',
              start: el.start,
              ...(ctx.path ? { option: ctx.path } : {}),
            });
          }
          continue;
        }
        const value = extractValue(el, sourceText, ctx);
        // An unreadable element is reported; its slot keeps later indices.
        elements.push(value === UNRESOLVED ? undefined : value);
      }
      return elements;
    }

    case 'ObjectExpression':
      return extractObjectLiteral(node, sourceText, ctx);

    case 'UnaryExpression': {
      if (resolving) return extractUnaryValue(node, sourceText, ctx);
      if (node.operator === '-' && node.argument?.type === 'Literal') {
        const value = node.argument.value;
        if (typeof value === 'number') {
          return -value;
        }
      }
      break;
    }

    case 'MemberExpression': {
      if (!resolving || !ctx) break;
      const chain = staticMemberChain(node);
      if (chain) {
        const resolved = resolveStaticReference(chain.root, chain.path, ctx);
        if (resolved !== UNRESOLVED) return resolved;
      }
      if (ctx.classReference?.(ctx.path)) {
        const reference = chain
          ? [chain.root.name, ...chain.path].join('.')
          : undefined;
        const identity = reference ? classIdentity(reference, ctx) : undefined;
        if (identity) return recordReference(identity, ctx);
      }
      break;
    }

    case 'NewExpression': {
      if (!resolving) break;
      const date = extractStaticDate(node, sourceText, ctx);
      if (date !== NOT_FOLDABLE) return date;
      break;
    }

    case 'CallExpression':
      break;
  }

  if (resolving) {
    const folded = extractFoldedValue(node as BaseNode, sourceText, ctx);
    if (folded !== NOT_FOLDABLE) return folded;
  }

  // Anything else is not a static value: record it (and, for the raw-shape
  // reader, hand back its source text).
  return unresolvedValue(node, sourceText, ctx);
}

/** A spread inside an array literal: an inline array or a same-file array constant. */
function resolveArraySpread(
  spread: SpreadElement,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
): unknown {
  const argument = unwrapTypeAssertion(spread.argument);
  if (!argument || !ctx) return UNRESOLVED;
  if (argument.type === 'ArrayExpression') {
    return extractValue(argument, sourceText, ctx);
  }
  if (argument.type !== 'Identifier') return UNRESOLVED;
  const constant = ctx.constants.get(argument.name);
  if (constant?.kind !== 'array') return UNRESOLVED;
  // Same copy semantics as an object spread of a module constant.
  if (ctx.dependencies) {
    ctx.dependencies.push({ name: argument.name, start: spread.start });
  } else if (constant.unresolved.length > 0) {
    ctx.unresolved.push(
      ...constant.unresolved
        .filter(
          (unresolved) =>
            hasNestedReferenceValue(constant.value) ||
            spread.start === undefined ||
            unresolved.start === undefined ||
            unresolved.start <= spread.start,
        )
        .map((unresolved) => ({ ...unresolved })),
    );
  }
  return cloneStaticValue(constant.value);
}

function extractUnaryValue(
  node: UnaryExpression,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
): unknown {
  const argument = extractValue(node.argument, sourceText, ctx);
  if (argument === UNRESOLVED) return UNRESOLVED;
  if (typeof argument === 'number') {
    if (node.operator === '-') return -argument;
    if (node.operator === '+') return argument;
  }
  if (node.operator === '!' && typeof argument === 'boolean') return !argument;
  if (node.operator === 'void') return undefined;
  return unresolvedValue(node, sourceText, ctx);
}

const NOT_FOLDABLE: unique symbol = Symbol('smrt.scanner.not-foldable');

/**
 * Stands in for the value of an option that only exists at runtime — a
 * callback such as a field's `validate`. A function cannot be carried in a
 * manifest, and it is not configuration the manifest would otherwise lose:
 * the runtime decorator holds the real one. The key is kept so a reader knows
 * the option was stated; `ManifestAdapter` lists it in `__statedOptions` and
 * emits no value for it.
 */
export const RUNTIME_ONLY_OPTION: unique symbol = Symbol.for(
  'smrt.scanner.runtime-only-option',
);

/**
 * Read an option whose value may be a runtime callback. A value that IS
 * static is returned as usual (`validate: true` on `@crossPackageRef`);
 * anything else is, by declaration of the option, a runtime value and is
 * replaced by {@link RUNTIME_ONLY_OPTION} without a diagnostic.
 */
function extractRuntimeOnlyValue(
  node: Expression | Pattern,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
): unknown {
  const expression = unwrapTypeAssertion(node as Expression) as
    | (BaseNode & { type: string })
    | null;
  if (
    !expression ||
    expression.type === 'ArrowFunctionExpression' ||
    expression.type === 'FunctionExpression'
  ) {
    return RUNTIME_ONLY_OPTION;
  }
  const probe: UnresolvedSpread[] = [];
  const value = extractValue(
    node,
    sourceText,
    ctx ? { ...ctx, unresolved: probe } : ctx,
  );
  return value === UNRESOLVED || probe.length > 0 ? RUNTIME_ONLY_OPTION : value;
}

/**
 * `new Date(<static arguments>)` as the `Date` it constructs. Building a
 * `Date` from literal arguments runs no source and is the same on every
 * build. `new Date()` reads the build clock, so it is left unresolved.
 */
function extractStaticDate(
  node: NewExpression,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
): unknown {
  if (
    node.callee.type !== 'Identifier' ||
    node.callee.name !== 'Date' ||
    node.arguments.length === 0
  ) {
    return NOT_FOLDABLE;
  }
  const args: Array<string | number> = [];
  for (const argument of node.arguments) {
    const probe: UnresolvedSpread[] = [];
    const value = extractValue(
      argument,
      sourceText,
      ctx ? { ...ctx, unresolved: probe } : ctx,
    );
    if (
      probe.length > 0 ||
      (typeof value !== 'string' && typeof value !== 'number')
    ) {
      return NOT_FOLDABLE;
    }
    args.push(value);
  }
  const date = new Date(...(args as [number]));
  return Number.isNaN(date.getTime()) ? NOT_FOLDABLE : date;
}

/**
 * Fold the constant expressions authors write in place of a literal:
 * a template literal and arithmetic or string concatenation over values that
 * are themselves static (`60 * 60`, `` `${PREFIX}_id` ``). Returns
 * {@link NOT_FOLDABLE} for any other node type. Nothing is evaluated beyond
 * these operators on already-read values.
 */
function extractFoldedValue(
  node: BaseNode,
  sourceText: string,
  ctx: DecoratorConfigContext | undefined,
): unknown {
  const loose = node as BaseNode & {
    quasis?: Array<{ value?: { cooked?: string | null } }>;
    expressions?: Expression[];
    operator?: string;
    left?: Expression;
    right?: Expression;
  };
  if (loose.type === 'TemplateLiteral') {
    const quasis = loose.quasis ?? [];
    const expressions = loose.expressions ?? [];
    let text = '';
    for (let index = 0; index < quasis.length; index++) {
      const cooked = quasis[index].value?.cooked;
      if (typeof cooked !== 'string') {
        return unresolvedValue(node, sourceText, ctx);
      }
      text += cooked;
      if (index >= expressions.length) continue;
      const part = extractValue(expressions[index], sourceText, ctx);
      if (part === UNRESOLVED) return UNRESOLVED;
      if (
        typeof part !== 'string' &&
        typeof part !== 'number' &&
        typeof part !== 'boolean'
      ) {
        return unresolvedValue(expressions[index], sourceText, ctx);
      }
      text += String(part);
    }
    return text;
  }
  if (loose.type === 'BinaryExpression' && loose.left && loose.right) {
    const left = extractValue(loose.left, sourceText, ctx);
    const right = extractValue(loose.right, sourceText, ctx);
    if (left === UNRESOLVED || right === UNRESOLVED) return UNRESOLVED;
    if (typeof left === 'number' && typeof right === 'number') {
      switch (loose.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '%':
          return left % right;
        case '**':
          return left ** right;
      }
    }
    if (
      loose.operator === '+' &&
      (typeof left === 'string' || typeof right === 'string') &&
      (typeof left === 'string' || typeof left === 'number') &&
      (typeof right === 'string' || typeof right === 'number')
    ) {
      return `${left}${right}`;
    }
    return unresolvedValue(node, sourceText, ctx);
  }
  return NOT_FOLDABLE;
}

/**
 * Extract extends clause information
 */
function extractExtendsClause(
  node: ClassDeclaration,
  importAliases: Map<string, string>,
  importBindings?: Map<string, ImportBinding>,
): {
  extendsClause: string | null;
  extendsTypeArg: string | null;
  extendsSource?: string;
  extendsDefaultImport?: boolean;
  extendsUnreadable?: string;
} {
  if (!node.superClass) {
    return { extendsClause: null, extendsTypeArg: null };
  }

  let extendsClause: string | null = null;
  let extendsTypeArg: string | null = null;
  let extendsSource: string | undefined;
  let extendsDefaultImport = false;
  // A superclass written as anything but `X` or `ns.X` is recorded as
  // unreadable, so the scan reports it for a model. A TypeScript-only
  // wrapper (`X as T`, `X!`, `X satisfies T`) is looked through for the
  // binding it wraps, so whether the class reaches the manifest at all (an
  // undecorated collection) is still decided, and the error still reported.
  let extendsUnreadable: string | undefined;
  let superClass: Expression | null = node.superClass;
  for (let depth = 0; superClass && depth < 8; depth++) {
    const type = (superClass as unknown as { type: string }).type;
    if (type === 'ParenthesizedExpression') {
      superClass = (superClass as unknown as TSTypeAssertionExpression)
        .expression;
      continue;
    }
    if (
      type === 'TSAsExpression' ||
      type === 'TSSatisfiesExpression' ||
      type === 'TSNonNullExpression' ||
      type === 'TSTypeAssertion'
    ) {
      extendsUnreadable ??= type;
      superClass = (superClass as unknown as TSTypeAssertionExpression)
        .expression;
      continue;
    }
    break;
  }

  // Get class name
  if (superClass?.type === 'Identifier') {
    extendsClause = superClass.name;
    const binding = importBindings?.get(extendsClause);
    if (binding?.imported) extendsSource = binding.source;
    if (binding?.imported === 'default') extendsDefaultImport = true;
  } else if (superClass?.type === 'MemberExpression') {
    const member = superClass;
    // `ns.Class` and `ns['Class']` name the same export.
    const memberName =
      !member.computed && member.property.type === 'Identifier'
        ? member.property.name
        : member.computed &&
            member.property.type === 'Literal' &&
            typeof member.property.value === 'string'
          ? member.property.value
          : undefined;
    const namespace =
      memberName && member.object.type === 'Identifier'
        ? importBindings?.get(member.object.name)
        : undefined;
    if (namespace && namespace.imported === null && memberName) {
      // `ns.Class` through `import * as ns from '...'`: the parent is that
      // module's export `Class` (#4145).
      extendsClause = memberName;
      extendsSource = namespace.source;
    } else {
      // Any other member (`Base.inner`, `Base['inner']`, `a.b.C`) is a
      // property of a value, not a binding the scan can prove: record the
      // whole path and mark it unreadable, never its object alone.
      const parts: string[] = [];
      let current: Expression = member;
      while (current.type === 'MemberExpression') {
        const property = current.property;
        parts.unshift(
          !current.computed && property.type === 'Identifier'
            ? property.name
            : property.type === 'Literal' && typeof property.value === 'string'
              ? `['${property.value}']`
              : '[…]',
        );
        current = current.object;
      }
      parts.unshift(current.type === 'Identifier' ? current.name : '…');
      extendsClause = parts.join('.').replace(/\.\[/g, '[');
      extendsUnreadable ??= 'MemberExpression';
    }
  } else if (superClass) {
    // A call (`Mixin(Base)`), a conditional, a class expression: no binding
    // the scan can name.
    extendsUnreadable ??= (superClass as unknown as { type: string }).type;
  }

  // Resolve import aliases (e.g., import { Performer as PerformerBase }).
  // A namespace member's name is an export name, never a local alias.
  if (
    superClass?.type === 'Identifier' &&
    extendsClause &&
    importAliases.has(extendsClause)
  ) {
    const aliasedExtends = importAliases.get(extendsClause);
    if (aliasedExtends) {
      extendsClause = aliasedExtends;
    }
  }

  // Get type argument (e.g., Meeting from SmrtCollection<Meeting>)
  // Note: oxc-parser v0.108+ renamed superTypeParameters to superTypeArguments
  const params =
    node.superTypeArguments?.params || node.superTypeParameters?.params;
  if (params && params.length > 0) {
    const typeParam = params[0];
    extendsTypeArg = extractTypeName(typeParam);
  }

  return {
    extendsClause,
    extendsTypeArg,
    ...(extendsSource ? { extendsSource } : {}),
    ...(extendsDefaultImport ? { extendsDefaultImport } : {}),
    ...(extendsUnreadable ? { extendsUnreadable } : {}),
  };
}

/**
 * Get member expression as dotted string
 */
function getMemberExpressionString(node: MemberExpression): string {
  const parts: string[] = [];

  let current: Expression = node;
  while (current.type === 'MemberExpression') {
    if (current.property.type === 'Identifier') {
      parts.unshift(current.property.name);
    }
    current = current.object;
  }

  if (current.type === 'Identifier') {
    parts.unshift(current.name);
  }

  return parts.join('.');
}

/**
 * Reconstruct call expression string from AST
 * e.g., foreignKey(Customer) or decimal({ required: true })
 */
function reconstructCallExpression(
  node: CallExpression,
  sourceText: string,
): string | null {
  // Try range first
  const src = sliceSource(node, sourceText);
  if (src) return src;

  // Reconstruct from AST
  let callee = '';
  if (node.callee.type === 'Identifier') {
    callee = node.callee.name;
  } else if (node.callee.type === 'MemberExpression') {
    callee = getMemberExpressionString(node.callee);
  } else {
    return null;
  }

  // Reconstruct arguments
  const args: string[] = [];
  for (const arg of node.arguments) {
    const argSrc = sliceSource(arg, sourceText);
    if (argSrc) {
      args.push(argSrc);
    } else if (arg.type === 'Identifier') {
      args.push(arg.name);
    } else if (arg.type === 'Literal') {
      args.push(arg.raw || String(arg.value));
    } else if (arg.type === 'ObjectExpression') {
      // Simplified object reconstruction
      const objStr = reconstructObjectExpression(arg, sourceText);
      if (objStr) args.push(objStr);
    } else {
      // Skip complex arguments
      args.push('...');
    }
  }

  return `${callee}(${args.join(', ')})`;
}

/**
 * Reconstruct object expression string from AST
 */
function reconstructObjectExpression(
  node: ObjectExpression,
  sourceText: string,
): string | null {
  const src = sliceSource(node, sourceText);
  if (src) return src;

  const props: string[] = [];
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') continue;
    if (prop.type === 'Property') {
      let key = '';
      if (prop.key.type === 'Identifier') {
        key = prop.key.name;
      } else if (prop.key.type === 'Literal') {
        key = String(prop.key.value);
      }
      if (!key) continue;

      let value = '';
      const valSrc = sliceSource(prop.value, sourceText);
      if (valSrc) {
        value = valSrc;
      } else if (prop.value.type === 'ObjectExpression') {
        // Recursively reconstruct nested objects (e.g., uiSlots.sources)
        value =
          reconstructObjectExpression(
            prop.value as ObjectExpression,
            sourceText,
          ) || '';
      } else if (prop.value.type === 'ArrayExpression') {
        value =
          reconstructArrayExpression(
            prop.value as ArrayExpression,
            sourceText,
          ) || '';
      } else if (prop.value.type === 'Identifier') {
        value = prop.value.name;
      } else if (prop.value.type === 'Literal') {
        value = prop.value.raw || String(prop.value.value);
      }

      if (value) {
        props.push(`${key}: ${value}`);
      }
    }
  }

  return `{ ${props.join(', ')} }`;
}

/**
 * Reconstruct array expression string from AST
 */
function reconstructArrayExpression(
  node: ArrayExpression,
  sourceText: string,
): string | null {
  const src = sliceSource(node, sourceText);
  if (src) return src;

  const elements: string[] = [];
  for (const el of node.elements) {
    if (!el) continue;
    if (el.type === 'SpreadElement') {
      elements.push('...');
    } else {
      const elSrc = sliceSource(el, sourceText);
      if (elSrc) {
        elements.push(elSrc);
      } else if (el.type === 'Identifier') {
        elements.push(el.name);
      } else if (el.type === 'Literal') {
        elements.push(el.raw || String(el.value));
      } else if (el.type === 'ObjectExpression') {
        const objStr = reconstructObjectExpression(
          el as ObjectExpression,
          sourceText,
        );
        if (objStr) elements.push(objStr);
      }
    }
  }

  return `[${elements.join(', ')}]`;
}

/**
 * Extract type name from TSType
 */
function extractTypeName(type: TSType): string | null {
  switch (type.type) {
    case 'TSTypeReference': {
      let baseName: string | null = null;
      if (type.typeName.type === 'Identifier') {
        baseName = type.typeName.name;
      } else if (type.typeName.type === 'TSQualifiedName') {
        baseName = getQualifiedName(type.typeName);
      }

      // Include type parameters (e.g., Promise<any>, Map<string, number>)
      // Note: oxc-parser v0.108+ renamed typeParameters to typeArguments
      const typeParams =
        type.typeArguments?.params || type.typeParameters?.params;
      if (baseName && typeParams?.length) {
        const typeArgs = typeParams.map((p: TSType) => extractTypeName(p));
        // An unresolvable ARGUMENT makes the whole reference unresolvable.
        // Dropping it left `Array<[string, Asset]>` as the bare string
        // `'Array'`, which carries no `typeUnresolved` provenance and is then
        // default-accepted by core's wire-ability gate -- a silent widening
        // through the exact channel that provenance exists to close (#2686).
        if (typeArgs.some((arg) => arg === null)) return null;
        if (typeArgs.length > 0) {
          return `${baseName}<${typeArgs.join(', ')}>`;
        }
      }
      return baseName;
    }

    case 'TSStringKeyword':
      return 'string';
    case 'TSNumberKeyword':
      return 'number';
    case 'TSBooleanKeyword':
      return 'boolean';
    case 'TSAnyKeyword':
      return 'any';
    // `unknown` used to fall through to `null`, which every consumer then read
    // as the string `'any'` -- indistinguishable from syntax the scanner
    // genuinely could not express. It is an ordinary, resolvable annotation, so
    // it is named here and `null` is left to mean "not resolved" (#2686).
    case 'TSUnknownKeyword':
      return 'unknown';
    // NOTE: `TSObjectKeyword` is deliberately NOT resolved here, only in
    // `describeParameterType`. `ManifestAdapter.inferFromAnnotation` gives an
    // `object`-typed FIELD a `{}` column default, so naming the bare keyword
    // here would add a DDL default to an existing nullable column
    // (`VideoWorkflow.workflowJson: object | null = null`) that contradicts its
    // own `= null` initializer -- a schema change, and a wrong one. Parameters
    // run through no such inference, so the keyword is safe to name there.
    case 'TSNeverKeyword':
      return 'never';
    case 'TSBigIntKeyword':
      return 'bigint';
    case 'TSSymbolKeyword':
      return 'symbol';
    case 'TSVoidKeyword':
      return 'void';
    // `this` in a parameter position (`moveTo(p: this | string | null)`) is an
    // instance of the declaring class. Naming it keeps the surrounding union
    // resolvable -- leaving it unresolved would withhold a method whose
    // `string` branch a caller can genuinely satisfy. Consumers judge the name
    // itself; core's wire-ability gate treats it as a model instance (#2686).
    case 'TSThisType':
      return 'this';
    case 'TSNullKeyword':
      return 'null';
    case 'TSUndefinedKeyword':
      return 'undefined';

    case 'TSLiteralType': {
      const literal = type.literal;
      if (!literal) return null;
      // oxc-parser uses generic 'Literal' node type — distinguish by value type
      if (typeof literal.value === 'string') return `'${literal.value}'`;
      if (typeof literal.value === 'number') return String(literal.value);
      if (typeof literal.value === 'boolean') return String(literal.value);
      return null;
    }

    case 'TSArrayType': {
      const elementType = extractTypeName(type.elementType);
      return elementType ? `${elementType}[]` : null;
    }

    case 'TSUnionType': {
      const types = type.types.map((t: TSType) => extractTypeName(t));
      // Same reason as the type-argument case above: silently dropping an
      // unresolvable branch produced a partial union (or, when every branch
      // failed, the empty string, which the adapter maps to `'any'`) with no
      // provenance attached (#2686).
      if (types.some((branch) => branch === null)) return null;
      return types.join(' | ');
    }

    // Inline object type literal: { subject?: string; from?: string; body?: string }
    // Maps to 'object' which the ManifestAdapter resolves as json
    case 'TSTypeLiteral':
      return 'object';
    case 'TSFunctionType':
      return 'Function';
    // oxc-parser emits many TSType kinds the scanner does not resolve
    // (e.g. intersections, tuples, conditional types); fall through to null.
    default:
      return null;
  }
}

/**
 * Get qualified name as string
 */
function getQualifiedName(node: TSQualifiedName): string {
  const parts: string[] = [];

  let current: TSQualifiedName | Identifier = node;
  while (current.type === 'TSQualifiedName') {
    parts.unshift(current.right.name);
    current = current.left;
  }

  if (current.type === 'Identifier') {
    parts.unshift(current.name);
  }

  return parts.join('.');
}

/**
 * Extract property definition
 */
function extractPropertyDefinition(
  node: PropertyDefinition,
  sourceText: string,
  ctx?: DecoratorConfigContext,
  className?: string,
): RawFieldDefinition | null {
  // Skip computed properties
  if (node.computed) return null;

  const name = getPropertyKey(node.key);
  if (!name) return null;
  // Reject prototype-polluting field names before they become manifest map keys
  // (a field literally named `__proto__`/`constructor`/`prototype`). The
  // type-alias/enum/object-literal extractors already gate on this; field
  // definitions must too (review #1559).
  if (!isSafeObjectKey(name)) return null;

  // Get type annotation
  const typeAnnotation = node.typeAnnotation
    ? extractTypeName(node.typeAnnotation.typeAnnotation)
    : null;

  // Get initializer
  let initializer: string | null = null;
  let hasDecimalPoint = false;
  let numericValue: number | null = null;

  if (node.value) {
    // Check for numeric literal with decimal point. Unwrap a leading unary
    // minus first: a negative initializer (`= -5`, `= -1.5`) parses as a
    // `UnaryExpression{ operator: '-', argument: Literal }`, not a bare
    // `Literal`, so without this the 0-vs-0.0 heuristic mis-infers negatives as
    // `integer` and drops the default. Mirrors the `extractValue` pattern above.
    if (
      node.value.type === 'UnaryExpression' &&
      node.value.operator === '-' &&
      node.value.argument?.type === 'Literal' &&
      typeof node.value.argument.value === 'number'
    ) {
      numericValue = -node.value.argument.value;
      // Check the inner literal's raw string for a decimal point (0.0 vs 0).
      if (node.value.argument.raw) {
        hasDecimalPoint = node.value.argument.raw.includes('.');
      }
    } else if (
      node.value.type === 'Literal' &&
      typeof node.value.value === 'number'
    ) {
      numericValue = node.value.value;
      // Check raw string for decimal point (0.0 vs 0)
      if (node.value.raw) {
        hasDecimalPoint = node.value.raw.includes('.');
      }
    }

    // Get raw initializer string - try range first for accurate source text
    const valueSrc = sliceSource(node.value, sourceText);
    if (valueSrc) {
      initializer = valueSrc;
    } else if (node.value.type === 'Literal' && node.value.raw) {
      // Fall back to raw property for literals
      initializer = node.value.raw;
    } else if (node.value.type === 'Literal') {
      // Convert literal value to string
      const val = node.value.value;
      if (typeof val === 'string') {
        initializer = `'${val}'`;
      } else if (val !== null && val !== undefined) {
        initializer = String(val);
      }
    } else if (
      node.value.type === 'CallExpression' ||
      node.value.type === 'NewExpression'
    ) {
      // Reconstruct call expression string from AST
      initializer = reconstructCallExpression(
        node.value as CallExpression,
        sourceText,
      );
    } else if (node.value.type === 'ArrayExpression') {
      // Reconstruct array expression
      initializer = reconstructArrayExpression(node.value, sourceText);
    } else if (node.value.type === 'ObjectExpression') {
      // Reconstruct object expression (e.g., static uiSlots = { ... })
      initializer = reconstructObjectExpression(
        node.value as ObjectExpression,
        sourceText,
      );
    }
  }

  // Extract decorators
  const decorators: RawDecorator[] = [];
  if (node.decorators) {
    for (const dec of node.decorators) {
      const extracted = extractFieldDecorator(dec, sourceText, ctx, {
        className,
        member: name,
      });
      if (extracted) {
        decorators.push(extracted);
      }
    }
  }

  // A static property the manifest carries is read from the AST like a
  // decorator config: in full, or with a diagnostic for what cannot be read.
  let initializerValue: RawFieldDefinition['initializerValue'];
  if (
    ctx?.resolveReferences &&
    node.static &&
    node.value &&
    MANIFEST_STATIC_PROPERTIES.has(name)
  ) {
    const from = ctx.unresolved.length;
    const value = extractValue(node.value, sourceText, {
      ...ctx,
      requireLiteralValues: true,
      path: undefined,
      classReference: undefined,
      runtimeOnly: undefined,
    });
    labelUnresolved(ctx, from, {
      decorator: `\`static ${name}\``,
      className,
    });
    initializerValue = { value: value === UNRESOLVED ? undefined : value };
  }

  return {
    name,
    typeAnnotation,
    initializer,
    hasDecimalPoint,
    numericValue,
    decorators,
    optional: node.optional || false,
    isStatic: node.static || false,
    readonly: node.readonly || false,
    accessibility: node.accessibility || 'public',
    line: node.loc?.start.line || 0,
    ...(initializerValue ? { initializerValue } : {}),
  };
}

/**
 * Read a decorator argument or static initializer given only as source text,
 * with the same static rules the parser applies to a file: literals, nested
 * objects and arrays, and constant folding. No module is in scope, so every
 * identifier is unresolved. The text is parsed, never evaluated.
 *
 * `ManifestAdapter` uses this for a hand-built {@link RawDecorator} that
 * carries no `argumentValues`.
 *
 * @returns The value, and the source of each expression that could not be
 *   read (empty when the value is complete).
 */
export function parseStaticLiteralSource(
  source: string,
  options: { runtimeOnly?: (path: string | undefined) => boolean } = {},
): { value: unknown; unresolved: string[] } {
  const text = `(${source}\n)`;
  const unreadable = { value: undefined, unresolved: [source.trim()] };
  let statement: { type?: string; expression?: Expression } | undefined;
  try {
    const result = parseSync('inline.ts', text, {
      lang: 'ts',
      preserveParens: false,
    });
    if (result.errors?.some((error) => error.severity === 'Error')) {
      return unreadable;
    }
    statement = (result.program as Program).body[0] as unknown as
      | { type?: string; expression?: Expression }
      | undefined;
  } catch {
    return unreadable;
  }
  if (statement?.type !== 'ExpressionStatement' || !statement.expression) {
    return unreadable;
  }
  const ctx: DecoratorConfigContext = {
    constants: new Map(),
    unresolved: [],
    requireLiteralValues: true,
    resolveReferences: true,
    runtimeOnly: options.runtimeOnly,
  };
  const value = extractValue(statement.expression, text, ctx);
  return {
    value: value === UNRESOLVED ? undefined : value,
    unresolved: ctx.unresolved.map((entry) => entry.expression),
  };
}

/**
 * Extract field decorator
 *
 * The decorator is named by what it was exported as, so an aliased or
 * namespaced import is read like a direct one. For the decorators in
 * {@link FIELD_DECORATOR_ARGUMENTS} every argument is also read statically
 * into `argumentValues`; nothing downstream evaluates the raw source text.
 */
function extractFieldDecorator(
  decorator: Decorator,
  sourceText: string,
  ctx?: DecoratorConfigContext,
  target?: { className?: string; member: string },
): RawDecorator | null {
  const expr = decorator.expression;
  const name = resolveDecoratorName(
    decorator,
    ctx?.importAliases,
    ctx?.importBindings,
  );
  if (!name) {
    if (
      ctx?.resolveReferences &&
      isUnnamedNamespaceDecorator(decorator, ctx.importBindings)
    ) {
      const from = ctx.unresolved.length;
      ctx.unresolved.push({
        expression: sliceSource(expr, sourceText) ?? '<decorator>',
        start: decorator.start,
      });
      labelUnresolved(ctx, from, {
        decorator: '@<namespace member>()',
        className: target?.className,
        member: target?.member,
      });
    }
    return null;
  }

  const args: string[] = [];
  if (expr.type === 'CallExpression') {
    // Extract arguments as strings
    for (const arg of expr.arguments) {
      const argSrc = sliceSource(arg, sourceText);
      if (argSrc) args.push(argSrc);
    }
  }

  const signature = Object.hasOwn(FIELD_DECORATOR_ARGUMENTS, name)
    ? FIELD_DECORATOR_ARGUMENTS[name]
    : undefined;
  if (!signature || !ctx?.resolveReferences) {
    return { name, arguments: args };
  }

  const from = ctx.unresolved.length;
  const argumentValues: NonNullable<RawDecorator['argumentValues']> = [];
  const callArguments = expr.type === 'CallExpression' ? expr.arguments : [];
  callArguments.forEach((arg, index) => {
    const kind = signature[index];
    if (!kind) {
      argumentValues.push(null);
      return;
    }
    const readCtx: DecoratorConfigContext = {
      ...ctx,
      requireLiteralValues: true,
      path: undefined,
      classReference: undefined,
      runtimeOnly: runtimeOnlyFieldOptions(name),
    };
    if (kind === 'target') {
      argumentValues.push(extractRelationshipTarget(arg, sourceText, readCtx));
      return;
    }
    const value = extractValue(arg, sourceText, readCtx);
    argumentValues.push(value === UNRESOLVED ? null : { value });
  });
  labelUnresolved(ctx, from, {
    decorator: `@${name}()`,
    className: target?.className,
    member: target?.member,
  });

  return { name, arguments: args, argumentValues };
}

/**
 * Read a relationship decorator's target argument.
 *
 * A name that IS statically a string — a literal, a same-file string
 * constant, a same-file `const lazy = () => Target` thunk — is returned as
 * that name. A class reference (`Target`, `ns.Target`) or an inline
 * `() => Target` thunk returns `null`: the class is identified by the name in
 * the raw argument, exactly as the runtime decorator reads `Target.name`.
 * Anything else (a call, a conditional) identifies no class, so it is a
 * diagnostic rather than a relationship without a target.
 */
function extractRelationshipTarget(
  node: Expression,
  sourceText: string,
  ctx: DecoratorConfigContext,
): RawDecoratorArgumentValue {
  const argument = unwrapTypeAssertion(node);
  if (!argument) return null;
  // A class reference, inline or behind a thunk, is recorded by the name the
  // runtime reads from the constructor; one that cannot be identified is a
  // scan error, never its alias or binding name.
  const identify = (reference: string): RawDecoratorArgumentValue => {
    const identity = classIdentity(reference, ctx);
    if (identity) {
      // A class declared in this file is marked, so the scan can check that
      // it is a model rather than a plain class that shares a model's name.
      return identity.import
        ? { value: identity.value, import: identity.import }
        : { value: identity.value, local: true };
    }
    // `Target.column` as code is a property of the class, which the runtime
    // decorator rejects; only the string `'Target.column'` names a column.
    const dot = reference.lastIndexOf('.');
    const owner =
      dot > 0 ? classIdentity(reference.slice(0, dot), ctx) : undefined;
    ctx.unresolved.push({
      expression: sliceSource(argument, sourceText) ?? reference,
      start: argument.start,
      ...(owner
        ? {
            hint:
              reference.slice(dot + 1) === 'name'
                ? // A class's `name` is its name string, which the decorator
                  // reads as the class; the string 'X.name' would instead
                  // reference a column `name`.
                  `\`${reference}\` is the class's name, which the decorator reads as the class \`${owner.value}\`; write \`${reference.slice(0, dot)}\` (or '${owner.value}') to keep that target.`
                : `\`${reference}\` is a property of \`${reference.slice(0, dot)}\`, not a class reference the scan reads. To target the class, write \`${reference.slice(0, dot)}\`; to target its column \`${reference.slice(dot + 1)}\`, write the string '${owner.value}${reference.slice(dot)}'.`,
          }
        : {}),
    });
    return null;
  };
  if (argument.type === 'Identifier') {
    const constant = ctx.constants.get(argument.name);
    if (constant?.kind === 'scalar' && typeof constant.value === 'string') {
      // Through the reference reader, so a scalar copied from an object
      // that is written elsewhere reports that write.
      const before = ctx.unresolved.length;
      const value = resolveStaticReference(argument, [], ctx);
      // A reported write leaves no stale name standing in for the target.
      if (ctx.unresolved.length !== before) return null;
      if (typeof value === 'string' && value.trim() !== '') return { value };
      ctx.unresolved.push({
        expression: sliceSource(argument, sourceText) ?? argument.name,
        start: argument.start,
      });
      return null;
    }
    const thunk = ctx.thunks?.get(argument.name);
    return identify(thunk ?? argument.name);
  }
  const reference = classReferenceName(argument) ?? thunkTarget(argument);
  if (reference) return identify(reference);
  const value = extractValue(argument, sourceText, ctx);
  if (typeof value === 'string' && value.trim() !== '') return { value };
  if (value !== UNRESOLVED) {
    // Static, but not a class name: nothing identifies the target.
    ctx.unresolved.push({
      expression: sliceSource(argument, sourceText) ?? '<target>',
      start: argument.start,
    });
  }
  return null;
}

/**
 * Extract method definition
 */
function extractMethodDefinition(
  node: MethodDefinition,
  sourceText: string,
  ctx?: DecoratorConfigContext,
  className?: string,
): RawMethodDefinition | null {
  // Skip constructors, getters, setters
  if (node.kind !== 'method') return null;

  const name = getPropertyKey(node.key);
  if (!name) return null;

  const func = node.value;

  // Extract parameters
  const parameters: RawParameterDefinition[] = [];
  for (const param of func.params) {
    const extracted = extractParameter(param, sourceText);
    if (extracted) {
      parameters.push(extracted);
    }
  }

  // Extract return type
  const returnType = func.returnType
    ? extractTypeName(func.returnType.typeAnnotation)
    : null;

  const decoratorConfig = extractMethodDecoratorConfig(
    node,
    sourceText,
    ctx,
    className ? { className, member: name } : undefined,
  );

  return {
    name,
    async: func.async,
    isStatic: node.static,
    accessibility: node.accessibility || 'public',
    parameters,
    returnType,
    description: null, // TODO: Extract JSDoc
    ...(decoratorConfig ? { decoratorConfig } : {}),
    line: node.loc?.start.line || 0,
  };
}

/**
 * Extract the config object of an `@method()` decorator on a class method.
 *
 * Read with `requireLiteralValues`, exactly like the class-level `@smrt()`
 * config: an `@method({ expose: EXPOSE_CONST })` the scanner cannot resolve
 * becomes a scan error rather than a dropped key. Dropping `expose: false`
 * silently would restore the default-routed behavior the author was
 * deliberately withholding — the same silent-widening failure mode #2100
 * closed for class configs (#2686).
 *
 * Returns `undefined` for an undecorated method, and `{}` for a bare
 * `@method()`; the two differ, so a bare decorator can still mark a method as
 * deliberately reviewed.
 */
function extractMethodDecoratorConfig(
  node: MethodDefinition,
  sourceText: string,
  ctx?: DecoratorConfigContext,
  target?: { className: string; member: string },
): Record<string, unknown> | undefined {
  const decorator = node.decorators?.find((d) =>
    isNamedDecorator(d, 'method', ctx?.importAliases, ctx?.importBindings),
  );
  if (!decorator) return undefined;

  const unresolvedBefore = ctx?.unresolved.length ?? 0;
  const config = extractDecoratorConfig(
    decorator,
    sourceText,
    ctx ? { ...ctx, requireLiteralValues: true, path: undefined } : ctx,
  );
  // `extractDecoratorConfig` pushes into the SHARED collector, which carries no
  // decorator identity of its own; label only what this call added so the
  // diagnostic names `@method()` instead of `@smrt()`.
  labelUnresolved(ctx, unresolvedBefore, {
    decorator: '@method()',
    ...(target ?? {}),
  });
  return config ?? {};
}

/**
 * Everything the manifest records about one parameter's declared type.
 *
 * `extractTypeName` answers a single question — "what string names this
 * type?" — and answers `null` both for "there is no annotation" and for
 * "there is one but I cannot express it". Consumers that must fail closed on
 * an uncertain type (the #2686 API wire-ability gate) need those two apart,
 * and they need the members of an inline object literal that the string
 * `'object'` throws away. This wraps `extractTypeName` to supply both without
 * changing what it returns anywhere else (return types, fields).
 */
interface ParameterTypeDescription {
  type: string | null;
  typeUnresolved: boolean;
  memberTypes?: string[];
  unionBranches?: ParameterTypeBranch[];
}

/** One branch of a top-level union, with the members IT declared (#2686). */
interface ParameterTypeBranch {
  type: string;
  memberTypes?: string[];
}

/** Depth bound for {@link collectInlineMemberTypes}'s literal recursion. */
const INLINE_MEMBER_TYPE_MAX_DEPTH = 4;

function describeParameterType(
  annotation: TSTypeAnnotation | undefined,
): ParameterTypeDescription {
  // No annotation at all is an implicit `any` the author genuinely wrote by
  // omission — not a scanner failure. Only an annotation that resolves to
  // nothing is unresolved.
  if (!annotation) return { type: null, typeUnresolved: false };

  const node = annotation.typeAnnotation;
  // The bare `object` keyword is resolvable for a parameter even though
  // `extractTypeName` leaves it unnamed for fields -- see the note on its
  // `TSNeverKeyword` case. An inline literal already reaches the manifest as
  // `'object'`, so this simply makes the keyword agree with it.
  if (node.type === 'TSObjectKeyword') {
    return { type: 'object', typeUnresolved: false };
  }
  const type = extractTypeName(node);
  if (type === null) return { type: null, typeUnresolved: true };

  const members: string[] = [];
  const memberUnresolved = collectInlineMemberTypes(node, members, 0);

  // A union's member restrictions belong to the BRANCH that declared them.
  // `collectInlineMemberTypes` flattens across branches, which lets a callback
  // in one branch veto another branch that is perfectly JSON-shaped:
  // `{ callback: () => void } | string` lost its route even though every
  // caller can pass the string. Describe each branch separately so the
  // resolver can apply "any branch is wire-able" as documented (#2686).
  //
  // Only emitted when every branch resolves; an unresolvable branch already
  // makes `extractTypeName` return null above, so this loop never sees one.
  let unionBranches: ParameterTypeBranch[] | undefined;
  if (node.type === 'TSUnionType') {
    const branches: ParameterTypeBranch[] = [];
    for (const branch of node.types) {
      const branchType =
        branch.type === 'TSObjectKeyword' ? 'object' : extractTypeName(branch);
      if (branchType === null) {
        // Fail closed rather than describe a union we cannot fully express.
        return { type, typeUnresolved: true };
      }
      const branchMembers: string[] = [];
      collectInlineMemberTypes(branch, branchMembers, 0);
      branches.push({
        type: branchType,
        ...(branchMembers.length > 0
          ? { memberTypes: [...new Set(branchMembers)] }
          : {}),
      });
    }
    if (branches.length > 0) unionBranches = branches;
  }

  return {
    type,
    typeUnresolved: memberUnresolved,
    ...(members.length > 0 ? { memberTypes: [...new Set(members)] } : {}),
    ...(unionBranches ? { unionBranches } : {}),
  };
}

/**
 * Flatten the member types of every INLINE object literal reachable from
 * `node` into `out`, returning whether any member's own type was unresolvable.
 *
 * Only inline literals are expanded. A named interface, type alias, or
 * `Partial<>`/`Pick<>` wrapper is left alone: resolving those needs cross-file
 * type resolution this AST layer deliberately does not do.
 */
function collectInlineMemberTypes(
  node: TSType,
  out: string[],
  depth: number,
): boolean {
  if (depth > INLINE_MEMBER_TYPE_MAX_DEPTH) return false;

  switch (node.type) {
    case 'TSTypeLiteral': {
      let unresolved = false;
      for (const member of node.members) {
        // A method signature IS a callable member, the same hazard an
        // explicit `() => void` property is.
        if (member.type === 'TSMethodSignature') {
          out.push('Function');
          continue;
        }
        const memberAnnotation = member.typeAnnotation;
        if (!memberAnnotation) continue;
        const memberType = extractTypeName(memberAnnotation.typeAnnotation);
        if (memberType === null) {
          unresolved = true;
          continue;
        }
        out.push(memberType);
        if (
          collectInlineMemberTypes(
            memberAnnotation.typeAnnotation,
            out,
            depth + 1,
          )
        ) {
          unresolved = true;
        }
      }
      return unresolved;
    }
    case 'TSArrayType':
      return collectInlineMemberTypes(node.elementType, out, depth + 1);
    case 'TSUnionType': {
      let unresolved = false;
      for (const branch of node.types) {
        if (collectInlineMemberTypes(branch, out, depth + 1)) unresolved = true;
      }
      return unresolved;
    }
    case 'TSTypeReference': {
      let unresolved = false;
      const typeParams =
        node.typeArguments?.params || node.typeParameters?.params;
      for (const param of typeParams ?? []) {
        if (collectInlineMemberTypes(param, out, depth + 1)) unresolved = true;
      }
      return unresolved;
    }
    default:
      return false;
  }
}

/**
 * Extract parameter definition
 */
function extractParameter(
  param: Pattern,
  sourceText: string,
): RawParameterDefinition | null {
  // Handle assignment pattern (default value)
  if (param.type === 'AssignmentPattern') {
    const left = param.left;
    if (left.type === 'Identifier') {
      return {
        name: left.name,
        ...describeParameterTypeFields(left.typeAnnotation),
        optional: true,
        defaultValue: sliceSource(param.right, sourceText),
      };
    }
    // Handle destructured parameter with default
    if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
      return {
        name: 'options',
        ...describeParameterTypeFields(left.typeAnnotation, 'any'),
        optional: true,
        defaultValue: sliceSource(param.right, sourceText),
      };
    }
    return null;
  }

  // Handle rest parameter
  if (param.type === 'RestElement') {
    const arg = param.argument;
    if (arg.type === 'Identifier') {
      return {
        name: `...${arg.name}`,
        ...describeParameterTypeFields(param.typeAnnotation),
        optional: true,
        defaultValue: null,
      };
    }
    return null;
  }

  // Handle simple identifier
  if (param.type === 'Identifier') {
    return {
      name: param.name,
      ...describeParameterTypeFields(param.typeAnnotation),
      optional: param.optional || false,
      defaultValue: null,
    };
  }

  // Handle object pattern (destructured)
  if (param.type === 'ObjectPattern') {
    return {
      name: 'options',
      ...describeParameterTypeFields(param.typeAnnotation, 'any'),
      optional: false,
      defaultValue: null,
    };
  }

  return null;
}

/**
 * The `type`/`typeUnresolved`/`memberTypes` triple for one parameter, with the
 * optional keys omitted entirely when they carry no information -- keeping the
 * emitted manifest byte-identical for the overwhelming majority of parameters
 * that have a plain resolvable type.
 *
 * `missingAnnotationType` is the historical fallback the destructured-parameter
 * branches use (`'any'` rather than `null`); an absent annotation is never
 * "unresolved" in either branch.
 */
function describeParameterTypeFields(
  annotation: TSTypeAnnotation | undefined,
  missingAnnotationType: string | null = null,
): Pick<
  RawParameterDefinition,
  'type' | 'typeUnresolved' | 'memberTypes' | 'unionBranches'
> {
  if (!annotation) return { type: missingAnnotationType };
  const described = describeParameterType(annotation);
  return {
    type: described.type,
    ...(described.typeUnresolved ? { typeUnresolved: true } : {}),
    ...(described.memberTypes ? { memberTypes: described.memberTypes } : {}),
    ...(described.unionBranches
      ? { unionBranches: described.unionBranches }
      : {}),
  };
}
