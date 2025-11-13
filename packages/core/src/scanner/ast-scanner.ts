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
  private baseClassProperties: Set<string> = new Set();

  constructor(filePaths: string[], options: ScanOptions = {}) {
    this.options = {
      includePrivateMethods: false,
      includeStaticMethods: true,
      followImports: false,
      baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
      ...options,
    };

    // Create TypeScript program
    // Use project's tsconfig.json if available to properly resolve modules
    const configPath = ts.findConfigFile(
      process.cwd(),
      ts.sys.fileExists,
      'tsconfig.json',
    );

    let compilerOptions: ts.CompilerOptions;
    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        process.cwd(),
      );
      compilerOptions = {
        ...parsedConfig.options,
        // Override key options to ensure proper scanning
        skipLibCheck: true, // Skip type checking for faster scanning
        noEmit: true, // We're just scanning, not emitting
      };
      console.log(`[ast-scanner] Using tsconfig from: ${configPath}`);
    } else {
      // Fallback to default options if no tsconfig found
      compilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
        declaration: true,
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false, // Don't enforce strict mode for scanning
        noEmit: true,
      };
      console.log(
        '[ast-scanner] No tsconfig.json found, using default options',
      );
    }

    this.program = ts.createProgram(filePaths, compilerOptions);

    // Log TypeScript diagnostics if any
    const diagnostics = ts.getPreEmitDiagnostics(this.program);
    if (diagnostics.length > 0 && process.env.DEBUG_SCANNER) {
      console.log(
        `[ast-scanner] TypeScript diagnostics: ${diagnostics.length} issues`,
      );
      diagnostics.forEach((diagnostic) => {
        if (diagnostic.file && diagnostic.start !== undefined) {
          const { line, character } =
            diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
          const message = ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            '\n',
          );
          console.log(
            `  ${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`,
          );
        }
      });
    }

    // Extract properties defined on base classes to exclude from subclass schemas
    this.baseClassProperties = this.extractBaseClassProperties();
  }

  /**
   * Scan files for SMRT object definitions
   */
  scanFiles(): ScanResult[] {
    const results: ScanResult[] = [];

    const sourceFilePaths: string[] = [];
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;

      sourceFilePaths.push(sourceFile.fileName);
      const result = this.scanFile(sourceFile);
      if (result.objects.length > 0 || result.errors.length > 0) {
        results.push(result);
      }
    }

    // Debug: Log which files were actually scanned
    console.log(`[ast-scanner] Scanned ${sourceFilePaths.length} files`);
    if (process.env.DEBUG_SCANNER) {
      console.log('[ast-scanner] Files scanned:');
      sourceFilePaths.forEach((f) => {
        console.log(`  - ${f}`);
      });
    }

    return results;
  }

  /**
   * Extract properties defined on base classes
   * These properties should be excluded from subclass schemas to avoid circular serialization
   */
  private extractBaseClassProperties(): Set<string> {
    const baseProperties = new Set<string>();

    for (const sourceFile of this.program.getSourceFiles()) {
      // Skip declaration files - we only want actual source files
      if (sourceFile.isDeclarationFile) continue;

      ts.forEachChild(sourceFile, (node) => {
        if (ts.isClassDeclaration(node)) {
          const className = node.name?.text;

          // Check if this is one of our base classes
          if (className && this.options.baseClasses?.includes(className)) {
            // Extract all property declarations from this base class
            for (const member of node.members) {
              if (ts.isPropertyDeclaration(member)) {
                const propName = this.getPropertyName(member);
                if (propName) {
                  baseProperties.add(propName);
                }
              }
            }
          }
        }
      });
    }

    return baseProperties;
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

    // Extract parent class name from extends clause
    const parentClass = this.extractParentClassName(node);

    const objectDef: SmartObjectDefinition = {
      name: className.toLowerCase(),
      className,
      collection,
      filePath: sourceFile.fileName,
      fields: {},
      methods: {},
      decoratorConfig,
      extends: parentClass, // NEW: Capture inheritance
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
   * Check if class extends a SMRT base class (recursively)
   *
   * This method now recursively walks the inheritance chain to check if ANY ancestor
   * is a framework base class. This enables multi-level inheritance:
   * - ExtendedContent extends BaseContent extends SmrtObject ✅
   * - Previously only: SomeClass extends SmrtObject ✅
   *
   * @param node - Class declaration to check
   * @param visited - Set of visited class names to prevent infinite loops
   * @returns True if this class or any ancestor extends a framework base class
   */
  private extendsBaseClass(
    node: ts.ClassDeclaration,
    visited: Set<string> = new Set(),
  ): boolean {
    const className = node.name?.text;
    if (!className || visited.has(className)) return false;
    visited.add(className);

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

          if (!baseClassName) continue;

          // Check if this is a framework base class
          if (this.options.baseClasses?.includes(baseClassName)) {
            return true;
          }

          // Recursively check if the parent class extends a framework base class
          // This enables multi-level inheritance (e.g., Child → Parent → SmrtObject)
          const parentClassNode = this.findClassDeclaration(baseClassName);
          if (
            parentClassNode &&
            this.extendsBaseClass(parentClassNode, visited)
          ) {
            return true;
          }

          // Parent class not found - might be in external package
          // Fail build if followImports is disabled and class has @smrt() decorator
          if (!parentClassNode && !this.options.followImports) {
            const hasDecorator = this.findSmrtDecorator(node);
            if (hasDecorator) {
              throw new Error(
                `[ast-scanner] Cannot verify inheritance for '@smrt() class ${className} extends ${baseClassName}'.\n\n` +
                  `The parent class '${baseClassName}' is not found in scanned files.\n` +
                  `This is likely because it's imported from an external package.\n\n` +
                  `To fix this, add 'followImports: true' to your smrtPlugin config in vite.config.ts:\n\n` +
                  `  smrtPlugin({\n` +
                  `    include: ['src/**/*.ts'],\n` +
                  `    followImports: true,  // ← Add this\n` +
                  `    // ... other options\n` +
                  `  })\n\n` +
                  `Without followImports enabled, '${className}' will be excluded from the manifest\n` +
                  `and will not be available at runtime (no fields, no queries, no persistence).\n\n` +
                  `File: ${node.getSourceFile?.().fileName || 'unknown'}`,
              );
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Find a class declaration by name in the program
   *
   * Used by extendsBaseClass to recursively check inheritance chains.
   *
   * @param className - Name of the class to find
   * @returns Class declaration node or undefined if not found
   */
  private findClassDeclaration(
    className: string,
  ): ts.ClassDeclaration | undefined {
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;

      let found: ts.ClassDeclaration | undefined;
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isClassDeclaration(node) && node.name?.text === className) {
          found = node;
        }
      });

      if (found) return found;
    }

    return undefined;
  }

  /**
   * Extract parent class name from extends clause
   *
   * Returns the direct parent class name, or undefined if no extends clause.
   * This enables inheritance chain tracking in the ObjectRegistry.
   *
   * @param node - Class declaration node
   * @returns Parent class name or undefined
   */
  private extractParentClassName(
    node: ts.ClassDeclaration,
  ): string | undefined {
    if (!node.heritageClauses) return undefined;

    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        // Get the first extends type (TypeScript only allows single inheritance)
        const type = clause.types[0];
        if (!type) continue;

        // Handle both simple identifiers and complex expressions
        if (ts.isIdentifier(type.expression)) {
          return type.expression.text;
        } else if (ts.isPropertyAccessExpression(type.expression)) {
          // Handle cases like 'SmrtBase.SubClass'
          return type.expression.name?.text;
        } else if (type.expression) {
          // Try to extract text from any expression
          const expressionText = type.expression.getText?.();
          return expressionText?.split('.').pop()?.trim();
        }
      }
    }

    return undefined;
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

    // Skip protected and private properties - only public properties should be in schema
    const isProtected =
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword) ??
      false;
    const isPrivate =
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ??
      false;

    if (isProtected || isPrivate) {
      return null;
    }

    const propertyName = this.getPropertyName(node);
    if (!propertyName) return null;

    // Skip properties inherited from base classes to avoid circular serialization
    if (this.baseClassProperties.has(propertyName)) {
      // Exception: Allow specific SmrtObject schema properties that should be persisted
      // These match the SCHEMA_PROPERTIES list in registry.ts
      const SCHEMA_PROPERTIES = [
        'id',
        'slug',
        'context',
        'created_at',
        'updated_at',
      ];
      if (!SCHEMA_PROPERTIES.includes(propertyName)) {
        return null;
      }
    }

    // Check if this is a function type (transient by default)
    const isFunction = this.isFunctionType(node, sourceFile);

    // Determine field type from initializer or type annotation
    const fieldType = this.inferFieldType(node, sourceFile);
    // Required if no question token and no undefined/null type
    const isRequired =
      !node.questionToken && !this.hasOptionalType(node, sourceFile);

    const field: FieldDefinition = {
      type: fieldType,
      required: isRequired,
    };

    // Mark function types as transient (non-persisted) by default
    if (isFunction) {
      field.transient = true;
    }

    // Extract default value from initializer
    if (node.initializer) {
      field.default = this.extractDefaultValue(node.initializer);

      // Extract options from field helper calls (e.g., integer({ min: 0, max: 100 }))
      const options = this.extractFieldOptions(node.initializer, sourceFile);
      if (options && Object.keys(options).length > 0) {
        field.options = options;
        // Check if explicitly marked as transient via option
        if (options.transient !== undefined) {
          field.transient = options.transient;
        }
      }
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
   * Check if a property is a function type
   */
  private isFunctionType(
    node: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile,
  ): boolean {
    // Check type annotation
    if (node.type) {
      const typeNode = node.type;
      // Function type signature: (param: type) => ReturnType
      if (ts.isFunctionTypeNode(typeNode)) {
        return true;
      }
      // Arrow function expression type
      const typeText = typeNode.getText(sourceFile).toLowerCase();
      if (typeText.includes('=>') || typeText.startsWith('function')) {
        return true;
      }
    }

    // Check initializer (arrow function or function expression)
    if (node.initializer) {
      if (ts.isArrowFunction(node.initializer)) {
        return true;
      }
      if (ts.isFunctionExpression(node.initializer)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Infer field type from TypeScript AST with enhanced type preservation
   */
  private inferFieldType(
    node: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile,
  ): FieldDefinition['type'] {
    // Special case: If type annotation is 'number' AND there's an initializer,
    // use the initializer to determine integer vs decimal (0 vs 0.0 heuristic)
    if (node.type && node.initializer) {
      const typeText = node.type.getText(sourceFile).toLowerCase();
      if (typeText === 'number') {
        // Defer to initializer for integer/decimal distinction
        return this.inferTypeFromInitializer(node.initializer, sourceFile);
      }
    }

    // Check type annotation first with enhanced detection
    if (node.type) {
      return this.analyzeTypeNode(node.type, sourceFile);
    }

    // Infer from initializer with enhanced detection
    if (node.initializer) {
      return this.inferTypeFromInitializer(node.initializer, sourceFile);
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

    // Handle Meta<T> wrapper for STI (Single Table Inheritance)
    // Meta<T> fields are stored in _meta_data JSONB column
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName.getText();
      if (typeName === 'Meta') {
        // This is a Meta<T> field - mark as 'meta' type
        return 'meta';
      }
    }

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
    sourceFile?: ts.SourceFile,
  ): FieldDefinition['type'] {
    if (ts.isStringLiteral(initializer)) return 'text';

    // Handle negative numbers (PrefixUnaryExpression with minus operator)
    if (ts.isPrefixUnaryExpression(initializer)) {
      if (
        initializer.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(initializer.operand)
      ) {
        // Get original source text to check for decimal point
        if (sourceFile) {
          const sourceText = initializer.operand.getText(sourceFile);
          return sourceText.includes('.') ? 'decimal' : 'integer';
        }
        // Fallback to checking the parsed number value
        const numText = initializer.operand.text;
        return numText.includes('.') ? 'decimal' : 'integer';
      }
    }

    if (ts.isNumericLiteral(initializer)) {
      // Use 0 vs 0.0 heuristic: decimal point indicates DECIMAL, otherwise INTEGER
      // Get original source text to check for decimal point (TypeScript normalizes in AST)
      if (sourceFile) {
        const sourceText = initializer.getText(sourceFile);
        return sourceText.includes('.') ? 'decimal' : 'integer';
      }
      // Fallback to checking the text property
      const numText = initializer.text;
      return numText.includes('.') ? 'decimal' : 'integer';
    }
    if (
      initializer.kind === ts.SyntaxKind.TrueKeyword ||
      initializer.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return 'boolean';
    }
    if (ts.isArrayLiteralExpression(initializer)) return 'json';
    if (ts.isObjectLiteralExpression(initializer)) return 'json';

    // Handle call expressions (Field helpers like text(), integer(), datetime())
    if (ts.isCallExpression(initializer)) {
      const expression = initializer.expression;
      if (ts.isIdentifier(expression)) {
        const funcName = expression.text.toLowerCase();
        // Map field helper function names to types
        if (funcName === 'text') return 'text';
        if (funcName === 'integer') return 'integer';
        if (funcName === 'decimal') return 'decimal';
        if (funcName === 'boolean') return 'boolean';
        if (funcName === 'datetime') return 'datetime';
        if (funcName === 'json') return 'json';
        if (funcName === 'foreignkey') return 'foreignKey';
        if (funcName === 'onetomany') return 'oneToMany';
        if (funcName === 'manytomany') return 'manyToMany';
        if (funcName === 'meta') return 'meta'; // STI meta field helper
      }
    }

    if (ts.isNewExpression(initializer)) {
      const expression = initializer.expression;
      if (ts.isIdentifier(expression)) {
        const typeName = expression.text.toLowerCase();
        if (typeName === 'date') return 'datetime';
        if (typeName === 'array') return 'json';
        if (typeName === 'field') {
          // new Field('type', options) - extract type from first argument
          if (initializer.arguments && initializer.arguments.length > 0) {
            const firstArg = initializer.arguments[0];
            if (ts.isStringLiteral(firstArg)) {
              return firstArg.text as FieldDefinition['type'];
            }
          }
        }
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

    // Handle negative numbers (PrefixUnaryExpression)
    if (ts.isPrefixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
      ) {
        return -Number(node.operand.text);
      }
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return [];
    if (ts.isObjectLiteralExpression(node)) return {};

    return undefined;
  }

  /**
   * Extract options object from field helper calls
   * Extracts options from: integer({ min: 0, max: 100 }), text({ required: true }), etc.
   */
  private extractFieldOptions(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
  ): Record<string, any> | undefined {
    // Only extract from call expressions (field helpers)
    if (!ts.isCallExpression(node)) {
      return undefined;
    }

    const expression = node.expression;
    if (!ts.isIdentifier(expression)) {
      return undefined;
    }

    const funcName = expression.text.toLowerCase();
    const fieldHelpers = [
      'text',
      'integer',
      'decimal',
      'boolean',
      'datetime',
      'json',
      'foreignkey',
      'onetomany',
      'manytomany',
    ];

    // Only extract options from known field helpers
    if (!fieldHelpers.includes(funcName)) {
      return undefined;
    }

    // Get first argument (options object)
    if (!node.arguments || node.arguments.length === 0) {
      return undefined;
    }

    const firstArg = node.arguments[0];

    // Options should be an object literal
    if (!ts.isObjectLiteralExpression(firstArg)) {
      return undefined;
    }

    // Extract properties from the object literal
    const options: Record<string, any> = {};

    for (const prop of firstArg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;

      const key = prop.name?.getText(sourceFile);
      if (!key) continue;

      const value = this.extractPropertyValue(prop.initializer, sourceFile);
      if (value !== undefined) {
        options[key] = value;
      }
    }

    return options;
  }

  /**
   * Extract value from a property assignment in an options object
   */
  private extractPropertyValue(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
  ): any {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;

    // Handle negative numbers
    if (ts.isPrefixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
      ) {
        return -Number(node.operand.text);
      }
    }

    // Handle arrays and objects (serialize as JSON for now)
    if (
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node)
    ) {
      return node.getText(sourceFile);
    }

    // For complex expressions, store the source text
    // (e.g., regex patterns, function calls)
    return node.getText(sourceFile);
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
