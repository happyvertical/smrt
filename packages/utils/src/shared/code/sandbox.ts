/**
 * Sandbox creation and safe code execution utilities
 *
 * Provides secure execution of generated code in isolated VM contexts with
 * controlled globals, timeouts, and resource constraints.
 */

import * as vm from 'node:vm';

/**
 * Options for creating a sandbox execution context
 */
export interface SandboxOptions {
  /**
   * Global variables to make available in the sandbox
   * These will be accessible as global variables in the executed code
   */
  globals?: Record<string, any>;

  /**
   * Maximum execution time in milliseconds
   * Default: 5000ms (5 seconds)
   */
  timeout?: number;

  /**
   * Allowed built-in JavaScript objects
   * Default: ['Array', 'Object', 'JSON', 'Math', 'Date', 'String', 'Number', 'Boolean', 'RegExp']
   */
  allowedBuiltins?: string[];

  /**
   * Whether to allow console access (useful for debugging)
   * Default: false (console will be undefined unless provided in globals)
   */
  allowConsole?: boolean;
}

/**
 * Options for executing code in a sandbox
 */
export interface ExecuteOptions {
  /**
   * Maximum execution time in milliseconds
   * Overrides the sandbox-level timeout if provided
   */
  timeout?: number;

  /**
   * Filename to use in error messages and stack traces
   * Default: 'generated-code.js'
   */
  filename?: string;

  /**
   * Whether to capture and return the last expression value
   * Default: true
   */
  captureResult?: boolean;
}

/**
 * Default safe built-in objects available in the sandbox
 */
const DEFAULT_BUILTINS = [
  'Array',
  'Object',
  'JSON',
  'Math',
  'Date',
  'String',
  'Number',
  'Boolean',
  'RegExp',
  'Set',
  'Map',
  'WeakSet',
  'WeakMap',
  'Symbol',
  'Promise',
];

/**
 * Creates a secure sandbox execution context with controlled globals
 *
 * @param options - Configuration for the sandbox
 * @returns A VM context that can be used with executeCode()
 *
 * @example
 * ```typescript
 * const sandbox = createSandbox({
 *   globals: {
 *     cheerio: require('cheerio'),
 *     data: { foo: 'bar' }
 *   },
 *   timeout: 5000,
 *   allowedBuiltins: ['Array', 'Object', 'JSON']
 * });
 *
 * const result = executeCode('data.foo', sandbox);
 * // Returns: "bar"
 * ```
 */
export function createSandbox(options: SandboxOptions = {}): vm.Context {
  const {
    globals = {},
    allowedBuiltins = DEFAULT_BUILTINS,
    allowConsole = false,
  } = options;

  // Start with an empty object with null prototype to avoid inheriting anything
  const sandbox: Record<string, any> = Object.create(null);

  // Add allowed built-ins
  for (const builtin of allowedBuiltins) {
    if (builtin in globalThis) {
      sandbox[builtin] = (globalThis as any)[builtin];
    }
  }

  // Add console if allowed (otherwise it remains undefined)
  if (allowConsole) {
    sandbox.console = console;
  }

  // Add user-provided globals
  Object.assign(sandbox, globals);

  // Create and return the context
  return vm.createContext(sandbox);
}

/**
 * Executes code in a sandbox with timeout and error handling
 *
 * @param code - The JavaScript code to execute
 * @param sandbox - The VM context created by createSandbox()
 * @param options - Execution options
 * @returns The result of the code execution
 * @throws {Error} If code execution fails or times out
 *
 * @example
 * ```typescript
 * const sandbox = createSandbox({
 *   globals: { x: 10, y: 20 }
 * });
 *
 * const result = executeCode('x + y', sandbox);
 * // Returns: 30
 *
 * // With a function
 * const funcResult = executeCode(`
 *   function add(a, b) {
 *     return a + b;
 *   }
 *   add(x, y);
 * `, sandbox);
 * // Returns: 30
 * ```
 */
export function executeCode<T = any>(
  code: string,
  sandbox: vm.Context,
  options: ExecuteOptions = {},
): T {
  const {
    timeout = 5000,
    filename = 'generated-code.js',
    captureResult = true,
  } = options;

  try {
    // For simple expressions, wrap in return. For complex code, execute directly
    let wrappedCode: string;

    if (captureResult) {
      // Check if code has multiple statements or function definitions
      const hasMultipleStatements = code.includes(';') || (code.includes('\n') && code.trim().split('\n').length > 1);
      const hasFunctionDef = /function\s+\w+|const\s+\w+\s*=\s*function|const\s+\w+\s*=\s*\(/i.test(code);

      if (hasMultipleStatements || hasFunctionDef) {
        // Execute code as-is (will return last expression)
        wrappedCode = code;
      } else {
        // Simple expression - wrap in return
        wrappedCode = `(function() { return (${code}); })();`;
      }
    } else {
      wrappedCode = code;
    }

    const result = vm.runInContext(wrappedCode, sandbox, {
      timeout,
      filename,
      displayErrors: true,
    });

    return result as T;
  } catch (error) {
    // Enhanced error message with context
    if (error instanceof Error) {
      const message = `Code execution failed: ${error.message}`;
      const enhancedError = new Error(message);
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
    throw error;
  }
}

/**
 * Executes async code in a sandbox with timeout and error handling
 *
 * @param code - The JavaScript code to execute (can contain async/await)
 * @param sandbox - The VM context created by createSandbox()
 * @param options - Execution options
 * @returns Promise resolving to the result of the code execution
 * @throws {Error} If code execution fails or times out
 *
 * @example
 * ```typescript
 * const sandbox = createSandbox({
 *   globals: {
 *     fetch: require('node-fetch')
 *   }
 * });
 *
 * const result = await executeCodeAsync(`
 *   const response = await fetch('https://api.example.com/data');
 *   const data = await response.json();
 *   data;
 * `, sandbox);
 * ```
 */
export async function executeCodeAsync<T = any>(
  code: string,
  sandbox: vm.Context,
  options: ExecuteOptions = {},
): Promise<T> {
  const {
    timeout = 5000,
    filename = 'generated-code.js',
    captureResult = true,
  } = options;

  try {
    // For async code, wrap in async function with smart return handling
    let wrappedCode: string;

    if (captureResult) {
      // For multi-line code, wrap in async IIFE and return last expression
      // Split into statements and make last one a return
      const trimmedCode = code.trim();
      const lines = trimmedCode.split('\n');

      if (lines.length > 1 || trimmedCode.includes(';')) {
        // Multi-line or multiple statements - find last expression
        const statements = trimmedCode.split('\n').filter(line => line.trim());
        const lastLine = statements[statements.length - 1];
        const otherLines = statements.slice(0, -1);

        // If last line is already a return statement, keep code as-is
        if (lastLine.trim().startsWith('return ')) {
          wrappedCode = `(async function() {
            ${trimmedCode}
          })();`;
        } else {
          // Make last line a return (remove trailing semicolon if present)
          const lastExpression = lastLine.trim().replace(/;$/, '');
          wrappedCode = `(async function() {
            ${otherLines.join('\n')}
            return ${lastExpression};
          })();`;
        }
      } else {
        // Single expression - wrap in return
        wrappedCode = `(async function() {
          return (${trimmedCode});
        })();`;
      }
    } else {
      wrappedCode = `(async function() {
        ${code}
      })();`;
    }

    const result = await vm.runInContext(wrappedCode, sandbox, {
      timeout,
      filename,
      displayErrors: true,
    });

    return result as T;
  } catch (error) {
    // Enhanced error message with context
    if (error instanceof Error) {
      const message = `Async code execution failed: ${error.message}`;
      const enhancedError = new Error(message);
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
    throw error;
  }
}

/**
 * Convenience function to create a sandbox and execute code in one step
 *
 * @param code - The JavaScript code to execute
 * @param options - Combined sandbox and execution options
 * @returns The result of the code execution
 *
 * @example
 * ```typescript
 * const result = executeInSandbox('Math.sqrt(16)', {
 *   globals: { x: 10 },
 *   timeout: 1000
 * });
 * // Returns: 4
 * ```
 */
export function executeInSandbox<T = any>(
  code: string,
  options: SandboxOptions & ExecuteOptions = {},
): T {
  const sandbox = createSandbox(options);
  return executeCode<T>(code, sandbox, options);
}

/**
 * Convenience function to create a sandbox and execute async code in one step
 *
 * @param code - The JavaScript code to execute (can contain async/await)
 * @param options - Combined sandbox and execution options
 * @returns Promise resolving to the result of the code execution
 *
 * @example
 * ```typescript
 * const result = await executeInSandboxAsync(`
 *   const data = await Promise.resolve({ value: 42 });
 *   data.value;
 * `, {
 *   timeout: 2000
 * });
 * // Returns: 42
 * ```
 */
export async function executeInSandboxAsync<T = any>(
  code: string,
  options: SandboxOptions & ExecuteOptions = {},
): Promise<T> {
  const sandbox = createSandbox(options);
  return executeCodeAsync<T>(code, sandbox, options);
}
