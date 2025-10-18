import { ScanOptions, ScanResult } from './types';
export declare class ASTScanner {
    private program;
    private options;
    constructor(filePaths: string[], options?: ScanOptions);
    /**
     * Scan files for SMRT object definitions
     */
    scanFiles(): ScanResult[];
    /**
     * Scan a single source file
     */
    private scanFile;
    /**
     * Parse a class declaration for SMRT metadata
     */
    private parseClassDeclaration;
    /**
     * Find @smrt() decorator on class
     */
    private findSmrtDecorator;
    /**
     * Check if class extends a SMRT base class
     */
    private extendsBaseClass;
    /**
     * Parse decorator configuration from @smrt(config)
     * Uses safe AST parsing instead of eval()
     */
    private parseDecoratorConfig;
    /**
     * Safely parse an object literal expression from AST
     * Replaces eval() with proper AST traversal
     */
    private parseObjectLiteralExpression;
    /**
     * Get property key from property name
     */
    private getPropertyKey;
    /**
     * Parse expression value safely
     */
    private parseExpressionValue;
    /**
     * Parse property declaration to field definition
     */
    private parsePropertyDeclaration;
    /**
     * Parse method declaration to method definition
     */
    private parseMethodDeclaration;
    /**
     * Get property/method name as string
     */
    private getPropertyName;
    /**
     * Infer field type from TypeScript AST with enhanced type preservation
     */
    private inferFieldType;
    /**
     * Analyze TypeScript type node for enhanced type inference
     */
    private analyzeTypeNode;
    /**
     * Infer type from initializer expression
     */
    private inferTypeFromInitializer;
    /**
     * Extract default value from initializer
     */
    private extractDefaultValue;
    /**
     * Check if type annotation includes undefined or optional types
     */
    private hasOptionalType;
    /**
     * Simple pluralization (can be enhanced)
     */
    private pluralize;
}
/**
 * Convenience function to scan files
 */
export declare function scanFiles(filePaths: string[], options?: ScanOptions): ScanResult[];
/**
 * Scan a single file
 */
export declare function scanFile(filePath: string, options?: ScanOptions): ScanResult;
//# sourceMappingURL=ast-scanner.d.ts.map