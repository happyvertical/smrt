/**
 * AST scanner for parsing @smrt() decorated classes
 * Uses TypeScript Compiler API to extract metadata
 */

import * as ts from 'typescript';
import type {
  FieldDefinition,
  MethodDefinition,
  ScanOptions,
  ScanResult,
  SmartObjectDefinition,
} from './types';

export class ASTScanner {
  private program: ts.Program;
  private options: ScanOptions;

  constructor(filePaths: string[], options: ScanOptions = {}) {
    this.options = {
      includePrivateMethods: false,
      includeStaticMethods: true,
      followImports: false,
      baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
      ...options,
    };

    // Create TypeScript program
    this.program = ts.createProgram(filePaths, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: true,
    });
  }

  /**
   * Scan files for SMRT object definitions
   */
  scanFiles(): ScanResult[] {
    const results: ScanResult[] = [];

    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;

      const result = this.scanFile(sourceFile);
      if (result.objects.length > 0 || result.errors.length > 0) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Scan a single source file
   */
  private scanFile(sourceFile: ts.SourceFile): ScanResult {
    const result: ScanResult = {
      filePath: sourceFile.fileName,
      objects: [],
      errors: [],
    };

    try {
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isClassDeclaration(node)) {
          try {
            const objectDef = this.parseClassDeclaration(node, sourceFile);
            if (objectDef) {
              result.objects.push(objectDef);
            }
          } catch (classError) {
            result.errors.push({
              message:
                classError instanceof Error
                  ? `Error parsing class: ${classError.message}\nStack: ${classError.stack}`
                  : 'Unknown class parsing error',
              line: 0,
              column: 0,
            });
          }
        }
      });
    } catch (error) {
      result.errors.push({
        message:
          error instanceof Error ? error.message : 'Unknown parsing error',
        line: 0,
        column: 0,
      });
    }

    return result;
  }

  /**
   * Parse a class declaration for SMRT metadata
   */
  private parseClassDeclaration(
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
  ): SmartObjectDefinition | null {
    const className = node.name?.text;
    if (!className) return null;

    // Skip base classes themselves (they shouldn't be in the manifest)
    if (this.options.baseClasses?.includes(className)) return null;

    // Check if class extends a SMRT base class (primary requirement)
    if (!this.extendsBaseClass(node)) return null;

    // Look for @smrt() decorator (optional - only needed for custom config)
    const smrtDecorator = this.findSmrtDecorator(node);

    // Extract decorator configuration (use defaults if no decorator)
    const decoratorConfig = smrtDecorator
      ? this.parseDecoratorConfig(smrtDecorator)
      : {}; // Default empty config when no decorator present

    // Generate collection name (pluralized)
    const collection = this.pluralize(className.toLowerCase());

    const objectDef: SmartObjectDefinition = {
      name: className.toLowerCase(),
      className,
      collection,
      filePath: sourceFile.fileName,
      fields: {},
      methods: {},
      decoratorConfig,
    };

    // Parse class members
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) {
        const field = this.parsePropertyDeclaration(member, sourceFile);
        if (field) {
          const fieldName = this.getPropertyName(member);
          if (fieldName) {
            objectDef.fields[fieldName] = field;
          }
        }
      } else if (ts.isMethodDeclaration(member)) {
        const method = this.parseMethodDeclaration(member, sourceFile);
        if (method) {
          objectDef.methods[method.name] = method;
        }
      }
    }

    return objectDef;
  }

  /**
   * Find @smrt() decorator on class
   */
  private findSmrtDecorator(node: ts.ClassDeclaration): ts.Decorator | null {
    if (!node.modifiers) return null;

    for (const modifier of node.modifiers) {
      if (ts.isDecorator(modifier)) {
        const expression = modifier.expression;

        // Handle @smrt() or @smrt
        if (ts.isCallExpression(expression)) {
          if (
            ts.isIdentifier(expression.expression) &&
            expression.expression.text === 'smrt'
          ) {
            return modifier;
          }
        } else if (ts.isIdentifier(expression) && expression.text === 'smrt') {
          return modifier;
        }
      }
    }

    return null;
  }

  /**
   * Check if class extends a SMRT base class
   */
  private extendsBaseClass(node: ts.ClassDeclaration): boolean {
    if (!node.heritageClauses) return false;

    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of clause.types) {
          // Handle both simple identifiers and complex expressions
          let baseClassName: string | undefined;

          if (ts.isIdentifier(type.expression)) {
            baseClassName = type.expression.text;
          } else if (ts.isPropertyAccessExpression(type.expression)) {
            // Handle cases like 'SmrtBase.SubClass'
            baseClassName = type.expression.name?.text;
          } else if (type.expression) {
            // Try to extract text from any expression
            const expressionText = type.expression.getText?.();
            baseClassName = expressionText?.split('.').pop()?.trim();
          }

          if (baseClassName && this.options.baseClasses?.includes(baseClassName)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Parse decorator configuration from @smrt(config)
   * Uses safe AST parsing instead of eval()
   */
  private parseDecoratorConfig(decorator: ts.Decorator): any {
    const defaultConfig = { api: {}, mcp: {}, cli: false };

    if (!ts.isCallExpression(decorator.expression)) {
      return defaultConfig;
    }

    const args = decorator.expression.arguments;
    if (args.length === 0) return defaultConfig;

    const configArg = args[0];
    if (!ts.isObjectLiteralExpression(configArg)) {
      return defaultConfig;
    }

    try {
      // Safe AST-based parsing
      return this.parseObjectLiteralExpression(configArg);
    } catch (error) {
      console.warn('[ast-scanner] Error parsing decorator config:', error);
      return defaultConfig;
    }
  }

  /**
   * Safely parse an object literal expression from AST
   * Replaces eval() with proper AST traversal
   */
  private parseObjectLiteralExpression(node: ts.ObjectLiteralExpression): any {
    const result: any = {};

    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = this.getPropertyKey(property.name);
        if (key) {
          result[key] = this.parseExpressionValue(property.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const key = property.name.text;
        result[key] = true; // Shorthand properties default to true
      }
    }

    return result;
  }

  /**
   * Get property key from property name
   */
  private getPropertyKey(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name)) {
      return name.text;
    }
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return null;
  }

  /**
   * Parse expression value safely
   */
  private parseExpressionValue(expr: ts.Expression): any {
    // Handle literals
    if (ts.isStringLiteral(expr)) {
      return expr.text;
    }
    if (ts.isNumericLiteral(expr)) {
      return Number(expr.text);
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
    if (expr.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }
    if (expr.kind === ts.SyntaxKind.NullKeyword) {
      return null;
    }

    // Handle arrays
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements
        .map((element) =>
          ts.isExpression(element)
            ? this.parseExpressionValue(element)
            : undefined,
        )
        .filter((val) => val !== undefined);
    }

    // Handle nested objects
    if (ts.isObjectLiteralExpression(expr)) {
      return this.parseObjectLiteralExpression(expr);
    }

    // For complex expressions, return a safe fallback
    return expr.getText().trim();
  }

  /**
   * Parse property declaration to field definition
   */
  private parsePropertyDeclaration(
    node: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile,
  ): FieldDefinition | null {
    // Skip static properties for now
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
      return null;
    }

    // Determine field type from initializer or type annotation
    const fieldType = this.inferFieldType(node, sourceFile);
    // Required if no question token and no undefined/null type
    const isRequired =
      !node.questionToken && !this.hasOptionalType(node, sourceFile);

    const field: FieldDefinition = {
      type: fieldType,
      required: isRequired,
    };

    // Extract default value from initializer
    if (node.initializer) {
      field.default = this.extractDefaultValue(node.initializer);
    }

    return field;
  }

  /**
   * Parse method declaration to method definition
   */
  private parseMethodDeclaration(
    node: ts.MethodDeclaration,
    sourceFile: ts.SourceFile,
  ): MethodDefinition | null {
    const methodName = this.getPropertyName(node);
    if (!methodName) return null;

    // Check visibility modifiers
    const isStatic =
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ??
      false;
    const isPrivate =
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ??
      false;
    const isPublic = !isPrivate;

    // Skip based on options
    if (!this.options.includeStaticMethods && isStatic) return null;
    if (!this.options.includePrivateMethods && isPrivate) return null;

    // Parse parameters
    const parameters = node.parameters.map((param) => ({
      name: param.name.getText(sourceFile),
      type: param.type?.getText(sourceFile) ?? 'any',
      optional: !!param.questionToken,
      default: param.initializer
        ? this.extractDefaultValue(param.initializer)
        : undefined,
    }));

    const method: MethodDefinition = {
      name: methodName,
      async:
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ??
        false,
      parameters,
      returnType: node.type?.getText(sourceFile) ?? 'void',
      isStatic,
      isPublic,
    };

    return method;
  }

  /**
   * Get property/method name as string
   */
  private getPropertyName(
    node: ts.PropertyDeclaration | ts.MethodDeclaration,
  ): string | null {
    if (ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (ts.isStringLiteral(node.name)) {
      return node.name.text;
    }
    return null;
  }

  /**
   * Infer field type from TypeScript AST with enhanced type preservation
   */
  private inferFieldType(
    node: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile,
  ): FieldDefinition['type'] {
    // Check type annotation first with enhanced detection
    if (node.type) {
      return this.analyzeTypeNode(node.type, sourceFile);
    }

    // Infer from initializer with enhanced detection
    if (node.initializer) {
      return this.inferTypeFromInitializer(node.initializer);
    }

    return 'text'; // Default fallback
  }

  /**
   * Analyze TypeScript type node for enhanced type inference
   */
  private analyzeTypeNode(
    typeNode: ts.TypeNode,
    sourceFile: ts.SourceFile,
  ): FieldDefinition['type'] {
    const typeText = typeNode.getText(sourceFile).toLowerCase();

    // Handle primitive types
    if (typeText === 'string') return 'text';
    if (typeText === 'number') return 'decimal';
    if (typeText === 'boolean') return 'boolean';
    if (typeText === 'date') return 'datetime';

    // Handle union types with null/undefined
    if (ts.isUnionTypeNode(typeNode)) {
      // Find the main type (non-null/undefined)
      const mainType = typeNode.types.find(
        (t) =>
          t.kind !== ts.SyntaxKind.UndefinedKeyword &&
          t.kind !== ts.SyntaxKind.NullKeyword,
      );
      if (mainType) {
        return this.analyzeTypeNode(mainType, sourceFile);
      }
    }

    // Handle array types
    if (ts.isArrayTypeNode(typeNode)) {
      return 'json'; // Arrays stored as JSON
    }

    // Handle Record/object types
    if (ts.isTypeLiteralNode(typeNode) || typeText.startsWith('record<')) {
      return 'json';
    }

    // Handle specific type references
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName.getText().toLowerCase();

      // Built-in types
      if (typeName === 'date') return 'datetime';
      if (typeName === 'array') return 'json';
      if (typeName === 'record') return 'json';
      if (typeName === 'object') return 'json';

      // String literal types become text
      if (typeName.includes('string')) return 'text';
      if (typeName.includes('number')) return 'decimal';
      if (typeName.includes('boolean')) return 'boolean';
    }

    // Handle string literal types and template literals
    if (ts.isLiteralTypeNode(typeNode)) {
      if (ts.isStringLiteral(typeNode.literal)) {
        return 'text';
      }
      if (ts.isNumericLiteral(typeNode.literal)) {
        return 'decimal';
      }
    }

    // Complex type patterns
    if (typeText.includes('[]') || typeText.includes('array')) return 'json';
    if (typeText.includes('record<') || typeText.includes('object'))
      return 'json';
    if (typeText.includes('string')) return 'text';
    if (typeText.includes('number') || typeText.includes('decimal'))
      return 'decimal';
    if (typeText.includes('boolean')) return 'boolean';
    if (typeText.includes('date')) return 'datetime';

    // Default for complex types
    return 'json';
  }

  /**
   * Infer type from initializer expression
   */
  private inferTypeFromInitializer(
    initializer: ts.Expression,
  ): FieldDefinition['type'] {
    if (ts.isStringLiteral(initializer)) return 'text';
    if (ts.isNumericLiteral(initializer)) return 'decimal';
    if (
      initializer.kind === ts.SyntaxKind.TrueKeyword ||
      initializer.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return 'boolean';
    }
    if (ts.isArrayLiteralExpression(initializer)) return 'json';
    if (ts.isObjectLiteralExpression(initializer)) return 'json';
    if (ts.isNewExpression(initializer)) {
      const expression = initializer.expression;
      if (ts.isIdentifier(expression)) {
        const typeName = expression.text.toLowerCase();
        if (typeName === 'date') return 'datetime';
        if (typeName === 'array') return 'json';
      }
    }

    return 'text'; // Default fallback
  }

  /**
   * Extract default value from initializer
   */
  private extractDefaultValue(node: ts.Expression): any {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return [];
    if (ts.isObjectLiteralExpression(node)) return {};

    return undefined;
  }

  /**
   * Check if type annotation includes undefined or optional types
   */
  private hasOptionalType(
    node: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile,
  ): boolean {
    if (!node.type) return false;

    const typeText = node.type.getText(sourceFile).toLowerCase();
    return typeText.includes('undefined') || typeText.includes('?');
  }

  /**
   * Simple pluralization (can be enhanced)
   */
  private pluralize(word: string): string {
    if (word.endsWith('y')) {
      return `${word.slice(0, -1)}ies`;
    }
    if (word.endsWith('s') || word.endsWith('sh') || word.endsWith('ch')) {
      return `${word}es`;
    }
    return `${word}s`;
  }
}

/**
 * Convenience function to scan files
 */
export function scanFiles(
  filePaths: string[],
  options?: ScanOptions,
): ScanResult[] {
  const scanner = new ASTScanner(filePaths, options);
  return scanner.scanFiles();
}

/**
 * Scan a single file
 */
export function scanFile(filePath: string, options?: ScanOptions): ScanResult {
  const scanner = new ASTScanner([filePath], options);
  const results = scanner.scanFiles();
  return results[0] || { filePath, objects: [], errors: [] };
}
