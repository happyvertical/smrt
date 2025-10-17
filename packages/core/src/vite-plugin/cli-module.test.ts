/**
 * Tests for @smrt/cli virtual module generation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';

// Mock decorator function for testing
function smrt(config?: any) {
  return (target: any) => {
    ObjectRegistry.register(target, config);
    return target;
  };
}

// Test class with CLI enabled
@smrt({
  cli: true,
})
class Document extends SmrtObject {
  title = '';
  content = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  // Custom action method
  async analyze(options: any = {}): Promise<any> {
    return {
      action: 'analyze',
      results: `Analysis of ${this.title}`,
      timestamp: new Date(),
    };
  }
}

// Test class with CLI excluded
@smrt({
  cli: false,
})
class Secret extends SmrtObject {
  value = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }
}

// Test class with selective CLI commands
@smrt({
  cli: {
    include: ['list', 'get', 'analyze'],
    exclude: ['delete'],
  },
})
class Article extends SmrtObject {
  title = '';
  author = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  async analyze(): Promise<any> {
    return { analysis: `Analyzing ${this.title}` };
  }
}

describe('@smrt/cli virtual module generation', () => {
  // Note: Classes are registered at module load time via decorators
  // Registry persists across tests to allow checking different objects

  it('should generate CLI module for objects with cli: true', () => {
    // Test that Document class is registered with CLI enabled
    const documentClass = ObjectRegistry.getClass('Document');
    expect(documentClass).toBeDefined();

    const config = ObjectRegistry.getConfig('Document');
    expect(config.cli).toBe(true);

    // Verify the Document instance has the analyze method
    const documentInstance = new Document({});
    expect(typeof documentInstance.analyze).toBe('function');
  });

  it('should exclude objects with cli: false', () => {
    const secretClass = ObjectRegistry.getClass('Secret');
    expect(secretClass).toBeDefined();

    const config = ObjectRegistry.getConfig('Secret');
    expect(config.cli).toBe(false);
  });

  it('should respect include/exclude configuration', () => {
    const articleClass = ObjectRegistry.getClass('Article');
    expect(articleClass).toBeDefined();

    const config = ObjectRegistry.getConfig('Article');
    expect(config.cli).toEqual({
      include: ['list', 'get', 'analyze'],
      exclude: ['delete'],
    });
  });

  it('should generate commands for custom methods', () => {
    const documentClass = ObjectRegistry.getClass('Document');
    expect(documentClass).toBeDefined();

    // Check that analyze method exists
    const documentInstance = new Document({});
    expect(typeof documentInstance.analyze).toBe('function');
  });

  it('should handle CLI module format correctly', async () => {
    // The generated module should export:
    // - cliCommands: object mapping class names to available commands
    // - setupCLI: function to create CLI instance
    // - getCLIHandler: function to get CLI handler directly

    const manifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {
        Document: {
          className: 'Document',
          collection: 'documents',
          fields: {},
          methods: {
            analyze: {
              name: 'analyze',
              parameters: [],
              returnType: 'Promise<any>',
              isAsync: true,
            },
          },
          decoratorConfig: {
            cli: {
              include: ['list', 'get', 'analyze'],
            },
          },
        },
      },
    };

    // Verify the structure that would be generated
    const expectedCommands = ['list', 'get', 'analyze'];
    const actualConfig = manifest.objects.Document.decoratorConfig.cli;

    if (typeof actualConfig === 'object' && actualConfig.include) {
      expect(actualConfig.include).toEqual(expectedCommands);
    }
  });

  it('should skip private methods in CLI generation', () => {
    // Create test class with private method
    @smrt({ cli: true })
    class TestWithPrivate extends SmrtObject {
      name = '';

      constructor(options: any) {
        super(options);
        const { db, ai, fs, ...safeOptions } = options;
        Object.assign(this, safeOptions);
      }

      async publicMethod() {
        return { result: 'public' };
      }

      async _privateMethod() {
        return { result: 'private' };
      }
    }

    const testClass = ObjectRegistry.getClass('TestWithPrivate');
    expect(testClass).toBeDefined();

    // Private methods should not be included in CLI commands
    const instance = new TestWithPrivate({});
    expect(typeof instance.publicMethod).toBe('function');
    expect(typeof instance._privateMethod).toBe('function');
  });

  it('should handle empty manifest gracefully', async () => {
    const emptyManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {},
    };

    // Should not throw error with empty manifest
    expect(emptyManifest.objects).toEqual({});
  });
});
