/**
 * Code extraction utilities for parsing code from text (e.g., AI responses)
 *
 * Provides functions to extract code blocks, JSON data, and function definitions
 * from markdown-formatted text or AI-generated responses.
 */
/**
 * Extracts a code block from markdown-formatted text
 *
 * @param text - The text containing markdown code blocks
 * @param language - Optional language specifier to match (e.g., 'javascript', 'typescript', 'json')
 * @returns The extracted code without markdown delimiters, or empty string if not found
 *
 * @example
 * ```typescript
 * const code = extractCodeBlock(`
 * Here's the function:
 * \`\`\`javascript
 * function hello() {
 *   return 'world';
 * }
 * \`\`\`
 * `, 'javascript');
 * // Returns: "function hello() {\n  return 'world';\n}"
 * ```
 */
export declare function extractCodeBlock(text: string, language?: string): string;
/**
 * Extracts and parses JSON from text, handling markdown code blocks
 *
 * @param text - The text containing JSON data
 * @returns The parsed JSON object
 * @throws {SyntaxError} If the JSON is invalid
 *
 * @example
 * ```typescript
 * const data = extractJSON<{ name: string }>(`
 * The result is:
 * \`\`\`json
 * {
 *   "name": "example"
 * }
 * \`\`\`
 * `);
 * // Returns: { name: "example" }
 * ```
 */
export declare function extractJSON<T = any>(text: string): T;
/**
 * Extracts all code blocks from markdown-formatted text
 *
 * @param text - The text containing markdown code blocks
 * @param language - Optional language specifier to filter by
 * @returns Array of extracted code blocks
 *
 * @example
 * ```typescript
 * const blocks = extractAllCodeBlocks(`
 * \`\`\`javascript
 * const a = 1;
 * \`\`\`
 *
 * \`\`\`typescript
 * const b: number = 2;
 * \`\`\`
 * `);
 * // Returns: ["const a = 1;", "const b: number = 2;"]
 * ```
 */
export declare function extractAllCodeBlocks(text: string, language?: string): string[];
/**
 * Extracts a specific function definition from code
 *
 * @param code - The code containing function definitions
 * @param functionName - The name of the function to extract
 * @returns The function definition, or empty string if not found
 *
 * @example
 * ```typescript
 * const code = `
 * function foo() { return 1; }
 * function bar() { return 2; }
 * `;
 *
 * const fooFunc = extractFunctionDefinition(code, 'foo');
 * // Returns: "function foo() { return 1; }"
 * ```
 */
export declare function extractFunctionDefinition(code: string, functionName: string): string;
//# sourceMappingURL=extraction.d.ts.map