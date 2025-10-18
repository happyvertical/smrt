import * as ts from "typescript";
import { M, g } from "./manifest-generator-Bb3IuFsV.js";
class ASTScanner {
  program;
  options;
  constructor(filePaths, options = {}) {
    this.options = {
      includePrivateMethods: false,
      includeStaticMethods: true,
      followImports: false,
      baseClasses: ["SmrtObject", "SmrtClass", "SmrtCollection"],
      ...options
    };
    this.program = ts.createProgram(filePaths, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: true
    });
    this.checker = this.program.getTypeChecker();
  }
  /**
   * Scan files for SMRT object definitions
   */
  scanFiles() {
    const results = [];
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
  scanFile(sourceFile) {
    const result = {
      filePath: sourceFile.fileName,
      objects: [],
      errors: []
    };
    try {
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isClassDeclaration(node)) {
          const objectDef = this.parseClassDeclaration(node, sourceFile);
          if (objectDef) {
            result.objects.push(objectDef);
          }
        }
      });
    } catch (error) {
      result.errors.push({
        message: error instanceof Error ? error.message : "Unknown parsing error",
        line: 0,
        column: 0
      });
    }
    return result;
  }
  /**
   * Parse a class declaration for SMRT metadata
   */
  parseClassDeclaration(node, sourceFile) {
    const className = node.name?.text;
    if (!className) return null;
    if (this.options.baseClasses?.includes(className)) return null;
    if (!this.extendsBaseClass(node)) return null;
    const smrtDecorator = this.findSmrtDecorator(node);
    const decoratorConfig = smrtDecorator ? this.parseDecoratorConfig(smrtDecorator) : {};
    const collection = this.pluralize(className.toLowerCase());
    const objectDef = {
      name: className.toLowerCase(),
      className,
      collection,
      filePath: sourceFile.fileName,
      fields: {},
      methods: {},
      decoratorConfig
    };
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) {
        const field = this.parsePropertyDeclaration(member);
        if (field) {
          const fieldName = this.getPropertyName(member);
          if (fieldName) {
            objectDef.fields[fieldName] = field;
          }
        }
      } else if (ts.isMethodDeclaration(member)) {
        const method = this.parseMethodDeclaration(member);
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
  findSmrtDecorator(node) {
    if (!node.modifiers) return null;
    for (const modifier of node.modifiers) {
      if (ts.isDecorator(modifier)) {
        const expression = modifier.expression;
        if (ts.isCallExpression(expression)) {
          if (ts.isIdentifier(expression.expression) && expression.expression.text === "smrt") {
            return modifier;
          }
        } else if (ts.isIdentifier(expression) && expression.text === "smrt") {
          return modifier;
        }
      }
    }
    return null;
  }
  /**
   * Check if class extends a SMRT base class
   */
  extendsBaseClass(node) {
    if (!node.heritageClauses) return false;
    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of clause.types) {
          if (ts.isIdentifier(type.expression)) {
            const baseClassName = type.expression.text;
            if (this.options.baseClasses?.includes(baseClassName)) {
              return true;
            }
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
  parseDecoratorConfig(decorator) {
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
      return this.parseObjectLiteralExpression(configArg);
    } catch (error) {
      console.warn("[ast-scanner] Error parsing decorator config:", error);
      return defaultConfig;
    }
  }
  /**
   * Safely parse an object literal expression from AST
   * Replaces eval() with proper AST traversal
   */
  parseObjectLiteralExpression(node) {
    const result = {};
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = this.getPropertyKey(property.name);
        if (key) {
          result[key] = this.parseExpressionValue(property.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const key = property.name.text;
        result[key] = true;
      }
    }
    return result;
  }
  /**
   * Get property key from property name
   */
  getPropertyKey(name) {
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
  parseExpressionValue(expr) {
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
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements.map(
        (element) => ts.isExpression(element) ? this.parseExpressionValue(element) : void 0
      ).filter((val) => val !== void 0);
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return this.parseObjectLiteralExpression(expr);
    }
    return expr.getText().trim();
  }
  /**
   * Parse property declaration to field definition
   */
  parsePropertyDeclaration(node) {
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
      return null;
    }
    const fieldType = this.inferFieldType(node);
    const isRequired = !node.questionToken && !this.hasOptionalType(node);
    const field = {
      type: fieldType,
      required: isRequired
    };
    if (node.initializer) {
      field.default = this.extractDefaultValue(node.initializer);
    }
    return field;
  }
  /**
   * Parse method declaration to method definition
   */
  parseMethodDeclaration(node) {
    const methodName = this.getPropertyName(node);
    if (!methodName) return null;
    const isStatic = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
    const isPrivate = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ?? false;
    const isPublic = !isPrivate;
    if (!this.options.includeStaticMethods && isStatic) return null;
    if (!this.options.includePrivateMethods && isPrivate) return null;
    const parameters = node.parameters.map((param) => ({
      name: param.name.getText(),
      type: param.type?.getText() ?? "any",
      optional: !!param.questionToken,
      default: param.initializer ? this.extractDefaultValue(param.initializer) : void 0
    }));
    const method = {
      name: methodName,
      async: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
      parameters,
      returnType: node.type?.getText() ?? "void",
      isStatic,
      isPublic
    };
    return method;
  }
  /**
   * Get property/method name as string
   */
  getPropertyName(node) {
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
  inferFieldType(node) {
    if (node.type) {
      return this.analyzeTypeNode(node.type);
    }
    if (node.initializer) {
      return this.inferTypeFromInitializer(node.initializer);
    }
    return "text";
  }
  /**
   * Analyze TypeScript type node for enhanced type inference
   */
  analyzeTypeNode(typeNode) {
    const typeText = typeNode.getText().toLowerCase();
    if (typeText === "string") return "text";
    if (typeText === "number") return "decimal";
    if (typeText === "boolean") return "boolean";
    if (typeText === "date") return "datetime";
    if (ts.isUnionTypeNode(typeNode)) {
      const mainType = typeNode.types.find(
        (t) => t.kind !== ts.SyntaxKind.UndefinedKeyword && t.kind !== ts.SyntaxKind.NullKeyword
      );
      if (mainType) {
        return this.analyzeTypeNode(mainType);
      }
    }
    if (ts.isArrayTypeNode(typeNode)) {
      return "json";
    }
    if (ts.isTypeLiteralNode(typeNode) || typeText.startsWith("record<")) {
      return "json";
    }
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName.getText().toLowerCase();
      if (typeName === "date") return "datetime";
      if (typeName === "array") return "json";
      if (typeName === "record") return "json";
      if (typeName === "object") return "json";
      if (typeName.includes("string")) return "text";
      if (typeName.includes("number")) return "decimal";
      if (typeName.includes("boolean")) return "boolean";
    }
    if (ts.isLiteralTypeNode(typeNode)) {
      if (ts.isStringLiteral(typeNode.literal)) {
        return "text";
      }
      if (ts.isNumericLiteral(typeNode.literal)) {
        return "decimal";
      }
    }
    if (typeText.includes("[]") || typeText.includes("array")) return "json";
    if (typeText.includes("record<") || typeText.includes("object"))
      return "json";
    if (typeText.includes("string")) return "text";
    if (typeText.includes("number") || typeText.includes("decimal"))
      return "decimal";
    if (typeText.includes("boolean")) return "boolean";
    if (typeText.includes("date")) return "datetime";
    return "json";
  }
  /**
   * Infer type from initializer expression
   */
  inferTypeFromInitializer(initializer) {
    if (ts.isStringLiteral(initializer)) return "text";
    if (ts.isNumericLiteral(initializer)) return "decimal";
    if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return "boolean";
    }
    if (ts.isArrayLiteralExpression(initializer)) return "json";
    if (ts.isObjectLiteralExpression(initializer)) return "json";
    if (ts.isNewExpression(initializer)) {
      const expression = initializer.expression;
      if (ts.isIdentifier(expression)) {
        const typeName = expression.text.toLowerCase();
        if (typeName === "date") return "datetime";
        if (typeName === "array") return "json";
      }
    }
    return "text";
  }
  /**
   * Extract default value from initializer
   */
  extractDefaultValue(node) {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return [];
    if (ts.isObjectLiteralExpression(node)) return {};
    return void 0;
  }
  /**
   * Check if type annotation includes undefined or optional types
   */
  hasOptionalType(node) {
    if (!node.type) return false;
    const typeText = node.type.getText().toLowerCase();
    return typeText.includes("undefined") || typeText.includes("?");
  }
  /**
   * Simple pluralization (can be enhanced)
   */
  pluralize(word) {
    if (word.endsWith("y")) {
      return `${word.slice(0, -1)}ies`;
    }
    if (word.endsWith("s") || word.endsWith("sh") || word.endsWith("ch")) {
      return `${word}es`;
    }
    return `${word}s`;
  }
}
function scanFiles(filePaths, options) {
  const scanner = new ASTScanner(filePaths, options);
  return scanner.scanFiles();
}
function scanFile(filePath, options) {
  const scanner = new ASTScanner([filePath], options);
  const results = scanner.scanFiles();
  return results[0] || { filePath, objects: [], errors: [] };
}
export {
  ASTScanner,
  M as ManifestGenerator,
  g as generateManifest,
  scanFile,
  scanFiles
};
//# sourceMappingURL=index-Bbf5mQLx.js.map
