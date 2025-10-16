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
export declare function createSandbox(options?: SandboxOptions): vm.Context;
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
export declare function executeCode<T = any>(code: string, sandbox: vm.Context, options?: ExecuteOptions): T;
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
export declare function executeCodeAsync<T = any>(code: string, sandbox: vm.Context, options?: ExecuteOptions): Promise<T>;
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
export declare function executeInSandbox<T = any>(code: string, options?: SandboxOptions & ExecuteOptions): T;
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
export declare function executeInSandboxAsync<T = any>(code: string, options?: SandboxOptions & ExecuteOptions): Promise<T>;
//# sourceMappingURL=sandbox.d.ts.map