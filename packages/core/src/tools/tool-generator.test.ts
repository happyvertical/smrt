/**
 * Tests for AI function calling tool generation
 */

import { describe, expect, it } from 'vitest';
import type { MethodDefinition } from '../scanner/types';
import {
  convertTypeToJsonSchema,
  generateToolFromMethod,
  generateToolManifest,
  shouldIncludeMethod,
  type AiConfig,
} from './tool-generator';

describe('convertTypeToJsonSchema', () => {
  it('converts primitive types', () => {
    expect(convertTypeToJsonSchema('string')).toEqual({ type: 'string' });
    expect(convertTypeToJsonSchema('number')).toEqual({ type: 'number' });
    expect(convertTypeToJsonSchema('boolean')).toEqual({ type: 'boolean' });
    expect(convertTypeToJsonSchema('null')).toEqual({ type: 'null' });
  });

  it('converts any and unknown to no type constraint', () => {
    expect(convertTypeToJsonSchema('any')).toEqual({});
    expect(convertTypeToJsonSchema('unknown')).toEqual({});
  });

  it('converts array types', () => {
    expect(convertTypeToJsonSchema('string[]')).toEqual({
      type: 'array',
      items: { type: 'string' },
    });

    expect(convertTypeToJsonSchema('Array<number>')).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
  });

  it('converts union types with string literals to enum', () => {
    expect(convertTypeToJsonSchema("'shallow' | 'deep'")).toEqual({
      type: 'string',
      enum: ['shallow', 'deep'],
    });
  });

  it('converts object types', () => {
    expect(convertTypeToJsonSchema('{ foo: string }')).toEqual({
      type: 'object',
    });
    expect(convertTypeToJsonSchema('Record<string, any>')).toEqual({
      type: 'object',
    });
  });

  it('handles complex nested types', () => {
    expect(convertTypeToJsonSchema('Array<string | number>')).toEqual({
      type: 'array',
      items: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
      },
    });
  });
});

describe('shouldIncludeMethod', () => {
  const publicAsyncMethod: MethodDefinition = {
    name: 'analyze',
    async: true,
    isPublic: true,
    isStatic: false,
    parameters: [],
    returnType: 'Promise<any>',
  };

  const publicSyncMethod: MethodDefinition = {
    name: 'validate',
    async: false,
    isPublic: true,
    isStatic: false,
    parameters: [],
    returnType: 'boolean',
  };

  const privateMethod: MethodDefinition = {
    name: 'internal',
    async: true,
    isPublic: false,
    isStatic: false,
    parameters: [],
    returnType: 'Promise<void>',
  };

  const staticMethod: MethodDefinition = {
    name: 'create',
    async: true,
    isPublic: true,
    isStatic: true,
    parameters: [],
    returnType: 'Promise<any>',
  };

  it('returns false when no config provided', () => {
    expect(shouldIncludeMethod(publicAsyncMethod)).toBe(false);
  });

  it('returns false when no callable config provided', () => {
    expect(shouldIncludeMethod(publicAsyncMethod, {})).toBe(false);
  });

  it('excludes methods in exclude list', () => {
    const config: AiConfig = {
      callable: 'all',
      exclude: ['analyze'],
    };
    expect(shouldIncludeMethod(publicAsyncMethod, config)).toBe(false);
  });

  it('excludes private methods always', () => {
    const config: AiConfig = {
      callable: 'all',
    };
    expect(shouldIncludeMethod(privateMethod, config)).toBe(false);
  });

  it('excludes static methods always', () => {
    const config: AiConfig = {
      callable: 'all',
    };
    expect(shouldIncludeMethod(staticMethod, config)).toBe(false);
  });

  it('includes all public non-static methods with callable: all', () => {
    const config: AiConfig = {
      callable: 'all',
    };
    expect(shouldIncludeMethod(publicAsyncMethod, config)).toBe(true);
    expect(shouldIncludeMethod(publicSyncMethod, config)).toBe(true);
  });

  it('includes only public async methods with callable: public-async', () => {
    const config: AiConfig = {
      callable: 'public-async',
    };
    expect(shouldIncludeMethod(publicAsyncMethod, config)).toBe(true);
    expect(shouldIncludeMethod(publicSyncMethod, config)).toBe(false);
  });

  it('includes only specified methods with array', () => {
    const config: AiConfig = {
      callable: ['analyze'],
    };
    expect(shouldIncludeMethod(publicAsyncMethod, config)).toBe(true);
    expect(shouldIncludeMethod(publicSyncMethod, config)).toBe(false);
  });
});

describe('generateToolFromMethod', () => {
  it('generates tool with parameters', () => {
    const method: MethodDefinition = {
      name: 'analyze',
      async: true,
      isPublic: true,
      isStatic: false,
      parameters: [
        { name: 'type', type: 'string', optional: false },
        { name: 'depth', type: 'number', optional: true, default: 1 },
      ],
      returnType: 'Promise<any>',
      description: 'Analyzes the content',
    };

    const tool = generateToolFromMethod(method);

    expect(tool).toEqual({
      type: 'function',
      function: {
        name: 'analyze',
        description: 'Analyzes the content',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            depth: { type: 'number', default: 1 },
          },
          required: ['type'],
        },
      },
    });
  });

  it('generates tool with no required parameters', () => {
    const method: MethodDefinition = {
      name: 'summarize',
      async: true,
      isPublic: true,
      isStatic: false,
      parameters: [{ name: 'options', type: 'any', optional: true }],
      returnType: 'Promise<string>',
    };

    const tool = generateToolFromMethod(method);

    expect(tool.function.parameters).toEqual({
      type: 'object',
      properties: {
        options: {},
      },
    });
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('uses custom description from config', () => {
    const method: MethodDefinition = {
      name: 'analyze',
      async: true,
      isPublic: true,
      isStatic: false,
      parameters: [],
      returnType: 'Promise<any>',
    };

    const config: AiConfig = {
      descriptions: {
        analyze: 'Custom analysis description',
      },
    };

    const tool = generateToolFromMethod(method, config);

    expect(tool.function.description).toBe('Custom analysis description');
  });

  it('uses default description when no JSDoc or custom description', () => {
    const method: MethodDefinition = {
      name: 'process',
      async: true,
      isPublic: true,
      isStatic: false,
      parameters: [],
      returnType: 'Promise<void>',
    };

    const tool = generateToolFromMethod(method);

    expect(tool.function.description).toBe('Call the process method');
  });
});

describe('generateToolManifest', () => {
  it('generates tools from multiple methods', () => {
    const methods: MethodDefinition[] = [
      {
        name: 'analyze',
        async: true,
        isPublic: true,
        isStatic: false,
        parameters: [{ name: 'type', type: 'string', optional: false }],
        returnType: 'Promise<any>',
      },
      {
        name: 'validate',
        async: false,
        isPublic: true,
        isStatic: false,
        parameters: [],
        returnType: 'boolean',
      },
      {
        name: 'internal',
        async: true,
        isPublic: false,
        isStatic: false,
        parameters: [],
        returnType: 'Promise<void>',
      },
    ];

    const config: AiConfig = {
      callable: 'public-async',
    };

    const tools = generateToolManifest(methods, config);

    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('analyze');
  });

  it('returns empty array when no methods match', () => {
    const methods: MethodDefinition[] = [
      {
        name: 'internal',
        async: true,
        isPublic: false,
        isStatic: false,
        parameters: [],
        returnType: 'Promise<void>',
      },
    ];

    const config: AiConfig = {
      callable: 'public-async',
    };

    const tools = generateToolManifest(methods, config);

    expect(tools).toHaveLength(0);
  });

  it('applies exclusions correctly', () => {
    const methods: MethodDefinition[] = [
      {
        name: 'analyze',
        async: true,
        isPublic: true,
        isStatic: false,
        parameters: [],
        returnType: 'Promise<any>',
      },
      {
        name: 'summarize',
        async: true,
        isPublic: true,
        isStatic: false,
        parameters: [],
        returnType: 'Promise<string>',
      },
    ];

    const config: AiConfig = {
      callable: 'public-async',
      exclude: ['summarize'],
    };

    const tools = generateToolManifest(methods, config);

    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('analyze');
  });
});
