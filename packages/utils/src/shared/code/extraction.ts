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
export function extractCodeBlock(
  text: string,
  language?: string,
): string {
  if (!text) {
    return '';
  }

  // Build regex pattern based on language
  const langPattern = language ? `${language}\\s*` : '(?:\\w+\\s*)?';
  const codeBlockRegex = new RegExp(
    `\`\`\`${langPattern}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``,
    'i',
  );

  const match = text.match(codeBlockRegex);
  if (match && match[1]) {
    return match[1].trim();
  }

  // If no markdown code block found, check for inline code
  const inlineRegex = /`([^`]+)`/;
  const inlineMatch = text.match(inlineRegex);
  if (inlineMatch && inlineMatch[1]) {
    return inlineMatch[1].trim();
  }

  return '';
}

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
export function extractJSON<T = any>(text: string): T {
  if (!text) {
    throw new SyntaxError('Cannot extract JSON from empty text');
  }

  // First, try to extract from a JSON code block
  let jsonText = extractCodeBlock(text, 'json');

  // If no JSON code block, try to extract from any code block
  if (!jsonText) {
    jsonText = extractCodeBlock(text);
  }

  // If still no code block, try to find JSON in the raw text
  if (!jsonText) {
    // Look for JSON object or array patterns
    const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = text.match(/\[[\s\S]*\]/);

    if (jsonObjectMatch) {
      jsonText = jsonObjectMatch[0];
    } else if (jsonArrayMatch) {
      jsonText = jsonArrayMatch[0];
    } else {
      // Last resort: use the whole text
      jsonText = text.trim();
    }
  }

  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    throw new SyntaxError(
      `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

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
export function extractAllCodeBlocks(
  text: string,
  language?: string,
): string[] {
  if (!text) {
    return [];
  }

  const langPattern = language ? `${language}\\s*` : '(?:\\w+\\s*)?';
  const codeBlockRegex = new RegExp(
    `\`\`\`${langPattern}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``,
    'gi',
  );

  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]) {
      blocks.push(match[1].trim());
    }
  }

  return blocks;
}

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
export function extractFunctionDefinition(
  code: string,
  functionName: string,
): string {
  if (!code || !functionName) {
    return '';
  }

  // Patterns to find the start of function definitions
  const patterns = [
    // function foo() { ... }
    {
      regex: new RegExp(
        `function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`,
        'i',
      ),
      hasBraces: true,
    },
    // const foo = function() { ... }
    {
      regex: new RegExp(
        `(?:const|let|var)\\s+${functionName}\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{`,
        'i',
      ),
      hasBraces: true,
    },
    // const foo = () => { ... }
    {
      regex: new RegExp(
        `(?:const|let|var)\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
        'i',
      ),
      hasBraces: true,
    },
    // const foo = () => ... (no braces)
    {
      regex: new RegExp(
        `(?:const|let|var)\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*[^;]+;?`,
        'i',
      ),
      hasBraces: false,
    },
  ];

  for (const { regex, hasBraces } of patterns) {
    const match = code.match(regex);
    if (match && match.index !== undefined) {
      const startIdx = match.index;

      // For arrow functions without braces, return the match directly
      if (!hasBraces) {
        return match[0].trim();
      }

      // For functions with braces, extract the full body using brace counting
      // Find the position of the opening brace
      const braceIdx = code.indexOf('{', startIdx);
      if (braceIdx === -1) continue;

      let idx = braceIdx;
      let depth = 0;
      let endIdx = -1;

      // Count braces to find the matching closing brace
      while (idx < code.length) {
        const char = code[idx];

        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            endIdx = idx;
            break;
          }
        }
        idx++;
      }

      // If we found the matching closing brace, extract the full function
      if (endIdx !== -1) {
        return code.slice(startIdx, endIdx + 1).trim();
      }
    }
  }

  return '';
}
