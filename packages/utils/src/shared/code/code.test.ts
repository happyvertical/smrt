/**
 * Tests for code extraction, validation, and execution utilities
 */

import { describe, expect, it } from 'vitest';
import {
  extractCodeBlock,
  extractJSON,
  extractAllCodeBlocks,
  extractFunctionDefinition,
  createSandbox,
  executeCode,
  executeCodeAsync,
  executeInSandbox,
  executeInSandboxAsync,
  validateCode,
  isSafeCode,
} from './index';

describe('Code Extraction', () => {
  describe('extractCodeBlock', () => {
    it('should extract JavaScript code block', () => {
      const text = `
Here's the code:
\`\`\`javascript
function hello() {
  return 'world';
}
\`\`\`
That's it!
      `;

      const code = extractCodeBlock(text, 'javascript');
      expect(code).toBe("function hello() {\n  return 'world';\n}");
    });

    it('should extract TypeScript code block', () => {
      const text = `
\`\`\`typescript
const add = (a: number, b: number): number => a + b;
\`\`\`
      `;

      const code = extractCodeBlock(text, 'typescript');
      expect(code).toContain('const add');
    });

    it('should extract any code block when language not specified', () => {
      const text = `
\`\`\`python
def hello():
    pass
\`\`\`
      `;

      const code = extractCodeBlock(text);
      expect(code).toContain('def hello()');
    });

    it('should return empty string when no code block found', () => {
      const text = 'Just plain text, no code here';
      const code = extractCodeBlock(text);
      expect(code).toBe('');
    });

    it('should handle inline code as fallback', () => {
      const text = 'Use `const x = 10;` in your code';
      const code = extractCodeBlock(text);
      expect(code).toBe('const x = 10;');
    });
  });

  describe('extractJSON', () => {
    it('should extract JSON from markdown code block', () => {
      const text = `
\`\`\`json
{
  "name": "test",
  "value": 42
}
\`\`\`
      `;

      const data = extractJSON<{ name: string; value: number }>(text);
      expect(data.name).toBe('test');
      expect(data.value).toBe(42);
    });

    it('should extract JSON from plain text', () => {
      const text = 'The result is: {"success": true, "count": 5}';
      const data = extractJSON<{ success: boolean; count: number }>(text);
      expect(data.success).toBe(true);
      expect(data.count).toBe(5);
    });

    it('should extract JSON array', () => {
      const text = '[1, 2, 3, 4, 5]';
      const data = extractJSON<number[]>(text);
      expect(data).toEqual([1, 2, 3, 4, 5]);
    });

    it('should throw on invalid JSON', () => {
      const text = 'This is not valid JSON';
      expect(() => extractJSON(text)).toThrow(SyntaxError);
    });

    it('should throw on empty text', () => {
      expect(() => extractJSON('')).toThrow(SyntaxError);
    });
  });

  describe('extractAllCodeBlocks', () => {
    it('should extract multiple code blocks', () => {
      const text = `
\`\`\`javascript
const a = 1;
\`\`\`

Some text here

\`\`\`javascript
const b = 2;
\`\`\`
      `;

      const blocks = extractAllCodeBlocks(text, 'javascript');
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toContain('const a = 1');
      expect(blocks[1]).toContain('const b = 2');
    });

    it('should extract blocks of different languages when no language specified', () => {
      const text = `
\`\`\`javascript
const x = 1;
\`\`\`

\`\`\`python
y = 2
\`\`\`
      `;

      const blocks = extractAllCodeBlocks(text);
      expect(blocks).toHaveLength(2);
    });

    it('should return empty array when no blocks found', () => {
      const blocks = extractAllCodeBlocks('No code here');
      expect(blocks).toEqual([]);
    });
  });

  describe('extractFunctionDefinition', () => {
    it('should extract named function', () => {
      const code = `
function foo() { return 1; }
function bar() { return 2; }
      `;

      const func = extractFunctionDefinition(code, 'foo');
      expect(func).toContain('function foo()');
      expect(func).toContain('return 1');
    });

    it('should extract const function expression', () => {
      const code = `
const add = function(a, b) {
  return a + b;
};
      `;

      const func = extractFunctionDefinition(code, 'add');
      expect(func).toContain('const add = function');
    });

    it('should extract arrow function', () => {
      const code = `
const multiply = (x, y) => {
  return x * y;
};
      `;

      const func = extractFunctionDefinition(code, 'multiply');
      expect(func).toContain('const multiply =');
      expect(func).toContain('=>');
    });

    it('should extract single-expression arrow function', () => {
      const code = 'const square = (n) => n * n;';
      const func = extractFunctionDefinition(code, 'square');
      expect(func).toContain('const square =');
    });

    it('should return empty string when function not found', () => {
      const code = 'function foo() {}';
      const func = extractFunctionDefinition(code, 'bar');
      expect(func).toBe('');
    });

    it('should handle nested braces in function body', () => {
      const code = `
const processData = (input) => {
  const config = { nested: { value: 1 } };
  if (true) {
    return { result: config.nested.value };
  }
};
      `;

      const func = extractFunctionDefinition(code, 'processData');
      expect(func).toContain('const processData =');
      expect(func).toContain('{ nested: { value: 1 } }');
      expect(func).toContain('if (true) {');
      expect(func).toContain('return { result: config.nested.value }');
    });
  });
});

describe('Sandbox Execution', () => {
  describe('createSandbox', () => {
    it('should create sandbox with default builtins', () => {
      const sandbox = createSandbox();
      const result = executeCode('Array.isArray([1, 2, 3])', sandbox);
      expect(result).toBe(true);
    });

    it('should create sandbox with custom globals', () => {
      const sandbox = createSandbox({
        globals: {
          x: 10,
          y: 20,
        },
      });

      const result = executeCode('x + y', sandbox);
      expect(result).toBe(30);
    });

    it('should allow specified builtins', () => {
      const sandbox = createSandbox({
        allowedBuiltins: ['Math', 'JSON'],
      });

      const result = executeCode('Math.sqrt(16)', sandbox);
      expect(result).toBe(4);
    });

    it('should not explicitly add console by default', () => {
      const sandbox = createSandbox();
      // Note: console is available in Node.js VM contexts by default
      // This test verifies we don't explicitly add it to the sandbox object
      expect(sandbox.console).toBeUndefined();
    });

    it('should allow console when enabled', () => {
      const sandbox = createSandbox({ allowConsole: true });
      expect(() => executeCode('console.log("test")', sandbox)).not.toThrow();
    });
  });

  describe('executeCode', () => {
    it('should execute simple expression', () => {
      const sandbox = createSandbox();
      const result = executeCode('2 + 2', sandbox);
      expect(result).toBe(4);
    });

    it('should execute function and return result', () => {
      const sandbox = createSandbox();
      const result = executeCode(
        `
        function add(a, b) {
          return a + b;
        }
        add(5, 3);
      `,
        sandbox,
      );
      expect(result).toBe(8);
    });

    it('should use globals from sandbox', () => {
      const sandbox = createSandbox({
        globals: {
          data: { value: 42 },
        },
      });

      const result = executeCode('data.value * 2', sandbox);
      expect(result).toBe(84);
    });

    it('should timeout on infinite loop', () => {
      const sandbox = createSandbox();
      expect(() =>
        executeCode('while(true) {}', sandbox, { timeout: 100 }),
      ).toThrow();
    });

    it('should throw on syntax errors', () => {
      const sandbox = createSandbox();
      expect(() => executeCode('const x = ', sandbox)).toThrow();
    });

    it('should handle objects and arrays', () => {
      const sandbox = createSandbox();
      const result = executeCode(
        `
        const obj = { a: 1, b: 2 };
        const arr = [1, 2, 3];
        ({ obj, arr });
      `,
        sandbox,
      );

      expect(result.obj).toEqual({ a: 1, b: 2 });
      expect(result.arr).toEqual([1, 2, 3]);
    });
  });

  describe('executeCodeAsync', () => {
    it('should execute async code', async () => {
      const sandbox = createSandbox();
      const result = await executeCodeAsync(
        `
        const data = await Promise.resolve(42);
        data * 2;
      `,
        sandbox,
      );

      expect(result).toBe(84);
    });

    it('should handle Promise rejection', async () => {
      const sandbox = createSandbox();
      await expect(
        executeCodeAsync(
          `
        await Promise.reject(new Error('Failed'));
      `,
          sandbox,
        ),
      ).rejects.toThrow();
    });

    it('should timeout async operations', async () => {
      const sandbox = createSandbox();
      await expect(
        executeCodeAsync(
          `
        await new Promise(resolve => setTimeout(resolve, 5000));
      `,
          sandbox,
          { timeout: 100 },
        ),
      ).rejects.toThrow();
    });
  });

  describe('executeInSandbox', () => {
    it('should create sandbox and execute in one step', () => {
      const result = executeInSandbox('Math.PI * 2', {
        allowedBuiltins: ['Math'],
      });

      expect(result).toBeCloseTo(Math.PI * 2);
    });

    it('should use provided globals', () => {
      const result = executeInSandbox('greeting + " World"', {
        globals: { greeting: 'Hello' },
      });

      expect(result).toBe('Hello World');
    });
  });

  describe('executeInSandboxAsync', () => {
    it('should create sandbox and execute async code', async () => {
      const result = await executeInSandboxAsync(
        `
        const x = await Promise.resolve(10);
        const y = await Promise.resolve(20);
        x + y;
      `,
      );

      expect(result).toBe(30);
    });
  });
});

describe('Code Validation', () => {
  describe('validateCode', () => {
    it('should validate safe code', () => {
      const result = validateCode(`
        function add(a, b) {
          return a + b;
        }
      `);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty code', () => {
      const result = validateCode('');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject code exceeding max length', () => {
      const longCode = 'x'.repeat(10001);
      const result = validateCode(longCode, { maxLength: 10000 });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('exceeds maximum length');
    });

    it('should reject code with require()', () => {
      const result = validateCode('const fs = require("fs");');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('require');
    });

    it('should reject code with import', () => {
      const result = validateCode('import fs from "fs";');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('import');
    });

    it('should reject code with eval', () => {
      const result = validateCode('eval("malicious code")');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('eval');
    });

    it('should reject code with process access', () => {
      const result = validateCode('process.exit(1)');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('process');
    });

    it('should allow require when explicitly enabled', () => {
      const result = validateCode('const data = require("./data");', {
        allowRequire: true,
      });

      // Should not error on require, but may have other issues
      const hasRequireError = result.errors.some((err) =>
        err.toLowerCase().includes('require'),
      );
      expect(hasRequireError).toBe(false);
    });

    it('should detect syntax errors', () => {
      const result = validateCode('const x = ');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Syntax error');
    });

    it('should generate code statistics', () => {
      const result = validateCode(`
        async function fetchData() {
          const response = await fetch(url);
          return response.json();
        }
      `);

      expect(result.stats).toBeDefined();
      expect(result.stats?.hasAsync).toBe(true);
      expect(result.stats?.lines).toBeGreaterThan(0);
    });

    it('should warn about long code', () => {
      const longCode = Array(150)
        .fill('console.log("x");')
        .join('\n');
      const result = validateCode(longCode);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('long');
    });

    it('should skip syntax check when disabled', () => {
      const result = validateCode('const x = ', { checkSyntax: false });
      // Should not have syntax error since check is disabled
      const hasSyntaxError = result.errors.some((err) =>
        err.includes('Syntax error'),
      );
      expect(hasSyntaxError).toBe(false);
    });
  });

  describe('isSafeCode', () => {
    it('should return true for safe code', () => {
      expect(isSafeCode('const x = 10;')).toBe(true);
    });

    it('should return false for unsafe code', () => {
      expect(isSafeCode('require("fs")')).toBe(false);
    });

    it('should return false for invalid syntax', () => {
      expect(isSafeCode('const x = ')).toBe(false);
    });
  });
});

describe('Integration Tests', () => {
  it('should extract, validate, and execute AI-generated code', () => {
    // Simulate AI response with code
    const aiResponse = `
Here's a parser function:

\`\`\`javascript
function parseData(input) {
  const items = input.split(',');
  return items.map(item => item.trim());
}
parseData("apple, banana, cherry");
\`\`\`
    `;

    // Extract code
    const code = extractCodeBlock(aiResponse, 'javascript');
    expect(code).toBeTruthy();

    // Validate code
    const validation = validateCode(code);
    expect(validation.valid).toBe(true);

    // Execute safely
    const sandbox = createSandbox();
    const result = executeCode(code, sandbox);
    expect(result).toEqual(['apple', 'banana', 'cherry']);
  });

  it('should handle extraction, validation, and async execution', async () => {
    const aiResponse = `
\`\`\`javascript
async function processData() {
  const data = await Promise.resolve({ value: 42 });
  return data.value * 2;
}
await processData();
\`\`\`
    `;

    const code = extractCodeBlock(aiResponse, 'javascript');
    const validation = validateCode(code);
    expect(validation.valid).toBe(true);

    const sandbox = createSandbox();
    const result = await executeCodeAsync(code, sandbox);
    expect(result).toBe(84);
  });

  it('should reject and prevent execution of dangerous code', () => {
    const dangerousCode = `
\`\`\`javascript
const fs = require('fs');
fs.unlinkSync('/important/file');
\`\`\`
    `;

    const code = extractCodeBlock(dangerousCode, 'javascript');
    const validation = validateCode(code);

    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);

    // Don't execute if validation fails
    if (!validation.valid) {
      console.log('Blocked dangerous code:', validation.errors);
    }
  });
});
