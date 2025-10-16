/**
 * Code validation utilities for checking generated code before execution
 *
 * Provides functions to validate code syntax, check for dangerous patterns,
 * and verify code meets security requirements before sandbox execution.
 */

/**
 * Options for code validation
 */
export interface ValidationOptions {
  /**
   * List of allowed global variables
   * If provided, code will be checked for undeclared variables
   */
  allowedGlobals?: string[];

  /**
   * List of disallowed patterns (regex)
   * Code containing these patterns will fail validation
   */
  disallowedPatterns?: RegExp[];

  /**
   * Maximum code length in characters
   * Default: 50000
   */
  maxLength?: number;

  /**
   * Whether to allow require() calls
   * Default: false (dangerous in untrusted code)
   */
  allowRequire?: boolean;

  /**
   * Whether to allow import statements
   * Default: false (dangerous in untrusted code)
   */
  allowImport?: boolean;

  /**
   * Whether to allow eval() and Function() constructor
   * Default: false (dangerous in any code)
   */
  allowEval?: boolean;

  /**
   * Whether to perform syntax check
   * Default: true
   */
  checkSyntax?: boolean;
}

/**
 * Result of code validation
 */
export interface ValidationResult {
  /**
   * Whether the code passed all validation checks
   */
  valid: boolean;

  /**
   * Critical errors that prevent execution
   */
  errors: string[];

  /**
   * Non-critical warnings about the code
   */
  warnings: string[];

  /**
   * Statistics about the code
   */
  stats?: {
    length: number;
    lines: number;
    hasAsync: boolean;
    hasArrowFunctions: boolean;
    hasClasses: boolean;
  };
}

/**
 * Default dangerous patterns that should be disallowed
 */
const DANGEROUS_PATTERNS = [
  /require\s*\(/i, // No require()
  /import\s+/i, // No import statements
  /eval\s*\(/i, // No eval()
  /Function\s*\(/i, // No Function constructor
  /process\./i, // No process access
  /fs\./i, // No filesystem module
  /child_process/i, // No child process
  /__dirname/i, // No directory access
  /__filename/i, // No file access
  /global\./i, // No global object manipulation
];

/**
 * Validates code before execution in a sandbox
 *
 * @param code - The code to validate
 * @param options - Validation options
 * @returns Validation result with errors and warnings
 *
 * @example
 * ```typescript
 * const result = validateCode(`
 *   function parse(data) {
 *     return JSON.parse(data);
 *   }
 * `, {
 *   allowedGlobals: ['JSON'],
 *   maxLength: 10000
 * });
 *
 * if (!result.valid) {
 *   console.error('Code validation failed:', result.errors);
 * }
 * ```
 */
export function validateCode(
  code: string,
  options: ValidationOptions = {},
): ValidationResult {
  const {
    allowedGlobals,
    disallowedPatterns = DANGEROUS_PATTERNS,
    maxLength = 50000,
    allowRequire = false,
    allowImport = false,
    allowEval = false,
    checkSyntax = true,
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for empty code
  if (!code || code.trim().length === 0) {
    errors.push('Code is empty');
    return { valid: false, errors, warnings };
  }

  // Check length
  if (code.length > maxLength) {
    errors.push(
      `Code exceeds maximum length (${code.length} > ${maxLength} characters)`,
    );
  }

  // Create explicit pattern to flag mapping for more reliable filtering
  const patternFlags = new Map([
    [DANGEROUS_PATTERNS[0], 'require'], // /require\s*\(/i
    [DANGEROUS_PATTERNS[1], 'import'],  // /import\s+/i
    [DANGEROUS_PATTERNS[2], 'eval'],    // /eval\s*\(/i
    [DANGEROUS_PATTERNS[3], 'eval'],    // /Function\s*\(/i - also controlled by allowEval
    // Patterns 4-9 are always dangerous (process, fs, child_process, etc.)
  ]);

  // Filter dangerous patterns based on options using explicit mapping
  const effectivePatterns = disallowedPatterns.filter((pattern, index) => {
    const patternType = patternFlags.get(DANGEROUS_PATTERNS[index]);

    if (patternType === 'require' && allowRequire) {
      return false;
    }
    if (patternType === 'import' && allowImport) {
      return false;
    }
    if (patternType === 'eval' && allowEval) {
      return false;
    }
    return true;
  });

  // Check for dangerous patterns
  for (const pattern of effectivePatterns) {
    if (pattern.test(code)) {
      errors.push(
        `Code contains disallowed pattern: ${pattern.source.replace(/\\/g, '')}`,
      );
    }
  }

  // Check for undeclared variables (if allowed globals specified)
  if (allowedGlobals) {
    const undeclaredVars = findUndeclaredVariables(code, allowedGlobals);
    if (undeclaredVars.length > 0) {
      warnings.push(
        `Potentially undeclared variables: ${undeclaredVars.join(', ')}`,
      );
    }
  }

  // Syntax check
  if (checkSyntax) {
    const syntaxErrors = checkCodeSyntax(code);
    errors.push(...syntaxErrors);
  }

  // Generate statistics
  const stats = {
    length: code.length,
    lines: code.split('\n').length,
    hasAsync: /\basync\b\s*(function|\([\w\s,={}[\]]*\)\s*=>|\w+\s*\()/m.test(code),
    hasArrowFunctions: /=>/.test(code),
    hasClasses: /\bclass\s+\w+/.test(code),
  };

  // Add warnings for complex patterns
  if (stats.lines > 100) {
    warnings.push(`Code is long (${stats.lines} lines) - consider breaking into smaller functions`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

/**
 * Checks code syntax without executing it
 *
 * @param code - The code to check
 * @returns Array of syntax error messages (empty if valid)
 */
function checkCodeSyntax(code: string): string[] {
  const errors: string[] = [];

  try {
    // Try to parse as a function body
    new Function(code);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // If it fails because of top-level await, try wrapping in async function
      const message = error.message;
      if (message.includes('await is only valid') && /\bawait\b/.test(code)) {
        try {
          // Wrap in async function and try again
          new Function(`(async function() { ${code} })()`);
          // If this succeeds, the code is valid async code
          return errors;
        } catch (asyncError) {
          // Real syntax error even in async context
          if (asyncError instanceof SyntaxError) {
            errors.push(`Syntax error: ${asyncError.message}`);
          }
        }
      } else {
        // Not an await issue, report original error
        errors.push(`Syntax error: ${message}`);
      }
    }
  }

  return errors;
}

/**
 * Finds potentially undeclared variables in code
 *
 * **Important Limitations:**
 * This is a basic regex-based static analysis with known limitations:
 * - Cannot detect variables in destructuring assignments
 * - May miss variables declared in nested scopes
 * - Cannot handle dynamic variable access (e.g., obj[varName])
 * - Will have false positives for method calls and object properties
 * - Does not understand scope chains or closures
 *
 * For production use cases requiring accurate variable analysis, consider using
 * a proper AST parser like @babel/parser or acorn.
 *
 * @param code - The code to analyze
 * @param allowedGlobals - List of allowed global variables
 * @returns Array of potentially undeclared variable names (may include false positives)
 */
function findUndeclaredVariables(
  code: string,
  allowedGlobals: string[],
): string[] {
  // This is a simplified regex-based check with known limitations (see JSDoc)
  // A full implementation would use an AST parser for accurate analysis

  const undeclaredVars: Set<string> = new Set();

  // Find all variable references (word boundaries)
  const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  const matches = code.matchAll(identifierRegex);

  const declaredVars = new Set<string>();

  // Find declared variables (var, let, const, function)
  const declarationRegex =
    /\b(?:var|let|const|function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  const declarations = code.matchAll(declarationRegex);

  for (const match of declarations) {
    if (match[1]) {
      declaredVars.add(match[1]);
    }
  }

  // Check each identifier
  for (const match of matches) {
    const identifier = match[1];

    // Skip keywords
    if (isJavaScriptKeyword(identifier)) {
      continue;
    }

    // Skip if declared in code
    if (declaredVars.has(identifier)) {
      continue;
    }

    // Skip if in allowed globals
    if (allowedGlobals.includes(identifier)) {
      continue;
    }

    // Skip common built-ins
    if (isCommonBuiltin(identifier)) {
      continue;
    }

    undeclaredVars.add(identifier);
  }

  return Array.from(undeclaredVars);
}

/**
 * Checks if a word is a JavaScript keyword
 */
function isJavaScriptKeyword(word: string): boolean {
  const keywords = [
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'async',
    'await',
  ];

  return keywords.includes(word);
}

/**
 * Checks if a word is a common JavaScript built-in
 */
function isCommonBuiltin(word: string): boolean {
  const builtins = [
    'Array',
    'Object',
    'String',
    'Number',
    'Boolean',
    'Date',
    'Math',
    'JSON',
    'RegExp',
    'Error',
    'Map',
    'Set',
    'Promise',
    'Symbol',
    'undefined',
    'null',
    'true',
    'false',
    'console',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',
  ];

  return builtins.includes(word);
}

/**
 * Quick validation to check if code is safe for execution
 * Returns true if code passes basic safety checks
 *
 * @param code - The code to check
 * @returns true if code is safe, false otherwise
 *
 * @example
 * ```typescript
 * if (isSafeCode('return x + y')) {
 *   // Safe to execute
 * }
 * ```
 */
export function isSafeCode(code: string): boolean {
  const result = validateCode(code, {
    maxLength: 50000,
    checkSyntax: true,
  });

  return result.valid;
}
