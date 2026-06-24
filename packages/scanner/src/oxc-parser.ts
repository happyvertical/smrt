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
import type {
  FileScanResult,
  RawClassDefinition,
  RawDecorator,
  RawDecoratorConfig,
  RawFieldDefinition,
  RawMethodDefinition,
  RawParameterDefinition,
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

/**
 * Extract line/column from offset in source text
 * Note: oxc-parser v0.108+ removed magicString, so we compute manually
 * @internal Exported for testing
 */
export function getLineColumn(
  sourceText: string,
  offset: number,
): { line: number; column: number } | undefined {
  if (offset < 0 || offset > sourceText.length) {
    return undefined;
  }

  let line = 1;
  let lastNewlinePos = -1;

  for (let i = 0; i < offset; i++) {
    if (sourceText[i] === '\n') {
      line++;
      lastNewlinePos = i;
    }
  }

  return {
    line,
    column: offset - lastNewlinePos, // 1-based column
  };
}

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
}

type ImportSpecifierLike =
  | ImportSpecifier
  | ImportNamespaceSpecifier
  | ImportDefaultSpecifier;

interface ImportSpecifier extends BaseNode {
  type: 'ImportSpecifier';
  imported: Identifier;
  local: Identifier;
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
  | any;

interface ClassDeclaration extends BaseNode {
  type: 'ClassDeclaration';
  id: Identifier | null;
  superClass: Expression | null;
  superTypeParameters?: TSTypeParameterInstantiation;
  body: ClassBody;
  decorators?: Decorator[];
}

interface ClassBody extends BaseNode {
  type: 'ClassBody';
  body: ClassElement[];
}

type ClassElement = PropertyDefinition | MethodDefinition | any;

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
  | ArrayPattern
  | any;

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
  | any;

interface Literal extends BaseNode {
  type: 'Literal';
  value: string | number | boolean | null | RegExp | bigint;
  raw?: string;
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
  declaration: Statement | null;
  specifiers: ExportSpecifier[];
}

interface ExportDefaultDeclaration extends BaseNode {
  type: 'ExportDefaultDeclaration';
  declaration: Statement | Expression;
}

interface ExportSpecifier extends BaseNode {
  type: 'ExportSpecifier';
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
  | TSVoidKeyword
  | TSNullKeyword
  | TSUndefinedKeyword
  | TSTypeReference
  | TSArrayType
  | TSUnionType
  | TSTypeLiteral
  | any;

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

interface TSVoidKeyword extends BaseNode {
  type: 'TSVoidKeyword';
}

interface TSNullKeyword extends BaseNode {
  type: 'TSNullKeyword';
}

interface TSUndefinedKeyword extends BaseNode {
  type: 'TSUndefinedKeyword';
}

interface TSTypeReference extends BaseNode {
  type: 'TSTypeReference';
  typeName: Identifier | TSQualifiedName;
  typeParameters?: TSTypeParameterInstantiation;
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

type TSTypeElement =
  | TSPropertySignature
  | TSMethodSignature
  | TSIndexSignature
  | any;

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
      for (const node of program.body) {
        const extracted = extractClassFromNode(
          node,
          filePath,
          sourceText,
          importAliases,
        );
        if (extracted) {
          classes.push(extracted);
        }
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
  return result2;
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
      for (const node of program.body) {
        const extracted = extractClassFromNode(
          node,
          filename,
          sourceText,
          importAliases,
        );
        if (extracted) {
          classes.push(extracted);
        }
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
    if (!source || !source.value) continue;

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
      if (name && isSafeObjectKey(name) && members?.length > 0) {
        const values = members
          .map((m: any) => {
            if (m.initializer?.type === 'Literal') {
              const val = m.initializer.value;
              if (typeof val === 'string') return `'${val}'`;
              if (typeof val === 'number') return String(val);
            }
            return null;
          })
          .filter(Boolean);

        if (values.length > 0) {
          // All string values → string union, all numeric → number union
          const allStrings = values.every((v: string) => v.startsWith("'"));
          if (allStrings) {
            aliases[name] = values.join(' | ');
          }
        }
      }
    }
  }
  return aliases;
}

/**
 * Extract class definition from an AST node
 */
function extractClassFromNode(
  node: Statement,
  filePath: string,
  sourceText: string,
  importAliases: Map<string, string>,
): RawClassDefinition | null {
  // Handle export declarations
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    return extractClassFromNode(
      node.declaration,
      filePath,
      sourceText,
      importAliases,
    );
  }
  if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
    return extractClassFromNode(
      node.declaration as Statement,
      filePath,
      sourceText,
      importAliases,
    );
  }

  // Handle class declaration
  if (node.type === 'ClassDeclaration') {
    return extractClassDeclaration(node, filePath, sourceText, importAliases);
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
): RawClassDefinition {
  const className = node.id?.name || 'AnonymousClass';

  // Extract decorators
  const decorators = node.decorators || [];
  const smrtDecorator = decorators.find((d) => isSmrtDecorator(d));
  const reportDecorator = decorators.find((d) => isNamedDecorator(d, 'report'));
  const tenantScopedDecorator = decorators.find((d) =>
    isNamedDecorator(d, 'TenantScoped'),
  );
  const hasSmartDecorator = !!smrtDecorator;
  const smrtConfig = smrtDecorator
    ? extractDecoratorConfig(smrtDecorator, sourceText)
    : null;
  const decoratorConfig =
    tenantScopedDecorator || reportDecorator
      ? {
          ...(smrtConfig ?? {}),
          ...(reportDecorator
            ? { report: extractDecoratorConfig(reportDecorator, sourceText) }
            : {}),
          ...(tenantScopedDecorator
            ? {
                tenantScoped: extractDecoratorConfig(
                  tenantScopedDecorator,
                  sourceText,
                ),
              }
            : {}),
        }
      : smrtConfig;

  // Extract extends clause
  const { extendsClause, extendsTypeArg } = extractExtendsClause(
    node,
    importAliases,
  );

  // Extract fields and methods
  const fields: RawFieldDefinition[] = [];
  const methods: RawMethodDefinition[] = [];

  for (const member of node.body.body) {
    if (member.type === 'PropertyDefinition') {
      const field = extractPropertyDefinition(member, sourceText);
      if (field) {
        fields.push(field);
      }
    } else if (member.type === 'MethodDefinition') {
      const method = extractMethodDefinition(member, sourceText);
      if (method) {
        methods.push(method);
      }
    }
  }

  return {
    className,
    filePath,
    extendsClause,
    extendsTypeArg,
    decoratorConfig,
    hasSmartDecorator,
    fields,
    methods,
    startLine: node.loc?.start.line || 1,
    endLine: node.loc?.end.line || 1,
  };
}

/**
 * Check if a decorator is @smrt()
 */
function isSmrtDecorator(decorator: Decorator): boolean {
  return isNamedDecorator(decorator, 'smrt');
}

function isNamedDecorator(decorator: Decorator, name: string): boolean {
  const expr = decorator.expression;

  // @decoratorName() - CallExpression
  if (expr.type === 'CallExpression') {
    const callee = expr.callee;
    if (callee.type === 'Identifier' && callee.name === name) {
      return true;
    }
  }

  // @decoratorName - Identifier (no parentheses)
  if (expr.type === 'Identifier' && expr.name === name) {
    return true;
  }

  return false;
}

/**
 * Extract @smrt() decorator configuration
 */
function extractDecoratorConfig(
  decorator: Decorator,
  sourceText: string,
): RawDecoratorConfig | null {
  const expr = decorator.expression;

  if (expr.type === 'CallExpression' && expr.arguments.length > 0) {
    const arg = expr.arguments[0];
    if (arg.type === 'ObjectExpression') {
      return extractObjectLiteral(arg, sourceText) as RawDecoratorConfig;
    }
  }

  // @smrt() with no config or @smrt
  return {};
}

/**
 * Extract object literal to plain object
 */
function extractObjectLiteral(
  node: ObjectExpression,
  sourceText: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const prop of node.properties) {
    if (prop.type === 'Property' && !prop.computed) {
      const key = getPropertyKey(prop.key);
      // Skip prototype-pollution keys (__proto__/constructor/prototype) so a
      // decorator-config property of that name cannot mutate the metadata
      // object's prototype.
      if (key && isSafeObjectKey(key)) {
        result[key] = extractValue(prop.value, sourceText);
      }
    }
  }

  return result;
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
  return null;
}

/**
 * Extract value from expression
 */
function extractValue(node: Expression, sourceText: string): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;

    case 'Identifier':
      // Handle special identifiers
      if (node.name === 'undefined') return undefined;
      if (node.name === 'null') return null;
      if (node.name === 'true') return true;
      if (node.name === 'false') return false;
      return node.name; // Return as string for class references

    case 'ArrayExpression':
      return node.elements
        .filter(
          (el: Expression | SpreadElement | null): el is Expression =>
            el !== null &&
            typeof el === 'object' &&
            'type' in el &&
            el.type !== 'SpreadElement',
        )
        .map((el: Expression) => extractValue(el, sourceText));

    case 'ObjectExpression':
      return extractObjectLiteral(node, sourceText);

    case 'UnaryExpression':
      if (node.operator === '-' && node.argument?.type === 'Literal') {
        const value = node.argument.value;
        if (typeof value === 'number') {
          return -value;
        }
      }
      break;

    case 'CallExpression':
    case 'NewExpression': {
      // Return the raw source for complex expressions
      const src = sliceSource(node, sourceText);
      if (src) return src;
      break;
    }
  }

  // For complex expressions, return raw source if available
  const rawSrc = sliceSource(node, sourceText);
  if (rawSrc) return rawSrc;

  return undefined;
}

/**
 * Extract extends clause information
 */
function extractExtendsClause(
  node: ClassDeclaration,
  importAliases: Map<string, string>,
): {
  extendsClause: string | null;
  extendsTypeArg: string | null;
} {
  if (!node.superClass) {
    return { extendsClause: null, extendsTypeArg: null };
  }

  let extendsClause: string | null = null;
  let extendsTypeArg: string | null = null;

  // Get class name
  if (node.superClass.type === 'Identifier') {
    extendsClause = node.superClass.name;
  } else if (node.superClass.type === 'MemberExpression') {
    // Handle Namespace.Class
    extendsClause = getMemberExpressionString(node.superClass);
  }

  // Resolve import aliases (e.g., import { Performer as PerformerBase })
  if (extendsClause && importAliases.has(extendsClause)) {
    const aliasedExtends = importAliases.get(extendsClause);
    if (aliasedExtends) {
      extendsClause = aliasedExtends;
    }
  }

  // Get type argument (e.g., Meeting from SmrtCollection<Meeting>)
  // Note: oxc-parser v0.108+ renamed superTypeParameters to superTypeArguments
  const params =
    (node as any).superTypeArguments?.params ||
    node.superTypeParameters?.params;
  if (params && params.length > 0) {
    const typeParam = params[0];
    extendsTypeArg = extractTypeName(typeParam);
  }

  return { extendsClause, extendsTypeArg };
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
        (type as any).typeArguments?.params || type.typeParameters?.params;
      if (baseName && typeParams?.length) {
        const typeArgs = typeParams
          .map((p: TSType) => extractTypeName(p))
          .filter(Boolean);
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
    case 'TSVoidKeyword':
      return 'void';
    case 'TSNullKeyword':
      return 'null';
    case 'TSUndefinedKeyword':
      return 'undefined';

    case 'TSLiteralType': {
      const literal = (type as any).literal;
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
      const types = type.types
        .map((t: TSType) => extractTypeName(t))
        .filter(Boolean);
      return types.join(' | ');
    }

    // Inline object type literal: { subject?: string; from?: string; body?: string }
    // Maps to 'object' which the ManifestAdapter resolves as json
    case 'TSTypeLiteral':
      return 'object';
    case 'TSFunctionType':
      return 'Function';
  }

  return null;
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
      const extracted = extractFieldDecorator(dec, sourceText);
      if (extracted) {
        decorators.push(extracted);
      }
    }
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
  };
}

/**
 * Extract field decorator
 */
function extractFieldDecorator(
  decorator: Decorator,
  sourceText: string,
): RawDecorator | null {
  const expr = decorator.expression;

  let name: string | null = null;
  const args: string[] = [];

  if (expr.type === 'CallExpression') {
    if (expr.callee.type === 'Identifier') {
      name = expr.callee.name;
    }
    // Extract arguments as strings
    for (const arg of expr.arguments) {
      const argSrc = sliceSource(arg, sourceText);
      if (argSrc) args.push(argSrc);
    }
  } else if (expr.type === 'Identifier') {
    name = expr.name;
  }

  if (!name) return null;

  return { name, arguments: args };
}

/**
 * Extract method definition
 */
function extractMethodDefinition(
  node: MethodDefinition,
  sourceText: string,
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

  return {
    name,
    async: func.async,
    isStatic: node.static,
    accessibility: node.accessibility || 'public',
    parameters,
    returnType,
    description: null, // TODO: Extract JSDoc
    line: node.loc?.start.line || 0,
  };
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
        type: left.typeAnnotation
          ? extractTypeName(left.typeAnnotation.typeAnnotation)
          : null,
        optional: true,
        defaultValue: sliceSource(param.right, sourceText),
      };
    }
    // Handle destructured parameter with default
    if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
      return {
        name: 'options',
        type: left.typeAnnotation
          ? extractTypeName(left.typeAnnotation.typeAnnotation)
          : 'any',
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
        type: param.typeAnnotation
          ? extractTypeName(param.typeAnnotation.typeAnnotation)
          : null,
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
      type: param.typeAnnotation
        ? extractTypeName(param.typeAnnotation.typeAnnotation)
        : null,
      optional: param.optional || false,
      defaultValue: null,
    };
  }

  // Handle object pattern (destructured)
  if (param.type === 'ObjectPattern') {
    return {
      name: 'options',
      type: param.typeAnnotation
        ? extractTypeName(param.typeAnnotation.typeAnnotation)
        : 'any',
      optional: false,
      defaultValue: null,
    };
  }

  return null;
}
