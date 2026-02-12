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
  specifiers?: ImportSpecifier[];
  source: Literal;
}

interface ImportSpecifier extends BaseNode {
  type: 'ImportSpecifier';
  imported: Identifier;
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
 * Parse a single TypeScript file and extract class definitions
 */
export function parseFile(filePath: string): FileScanResult {
  const startTime = performance.now();
  const errors: ScanError[] = [];
  const classes: RawClassDefinition[] = [];

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

  return {
    filePath,
    classes,
    errors,
    parseTimeMs: performance.now() - startTime,
  };
}

/**
 * Parse source text directly (for testing)
 */
export function parseSource(
  sourceText: string,
  filename = 'test.ts',
): FileScanResult {
  const startTime = performance.now();
  const errors: ScanError[] = [];
  const classes: RawClassDefinition[] = [];

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

  return {
    filePath: filename,
    classes,
    errors,
    parseTimeMs: performance.now() - startTime,
  };
}

// ============================================================================
// AST Extraction Helpers
// ============================================================================

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
  const hasSmartDecorator = !!smrtDecorator;
  const decoratorConfig = smrtDecorator
    ? extractDecoratorConfig(smrtDecorator, sourceText)
    : null;

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
  const expr = decorator.expression;

  // @smrt() - CallExpression
  if (expr.type === 'CallExpression') {
    const callee = expr.callee;
    if (callee.type === 'Identifier' && callee.name === 'smrt') {
      return true;
    }
  }

  // @smrt - Identifier (no parentheses)
  if (expr.type === 'Identifier' && expr.name === 'smrt') {
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
      if (key) {
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
    extendsClause = importAliases.get(extendsClause)!;
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

  // Get type annotation
  const typeAnnotation = node.typeAnnotation
    ? extractTypeName(node.typeAnnotation.typeAnnotation)
    : null;

  // Get initializer
  let initializer: string | null = null;
  let hasDecimalPoint = false;
  let numericValue: number | null = null;

  if (node.value) {
    // Check for numeric literal with decimal point
    if (node.value.type === 'Literal' && typeof node.value.value === 'number') {
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
