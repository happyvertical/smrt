/**
 * CLI Generator Tests - Simplified approach to avoid import issues
 */

import { describe, expect, it, vi } from 'vitest';

// Simplified test approach using dynamic imports to avoid module resolution issues

describe('CLI Generator - Simplified Tests', () => {
  it('should import and instantiate CLI generator', async () => {
    // Import from source to avoid dependency resolution issues with built chunks
    const { CLIGenerator } = await import('./cli-generator.ts');

    const generator = new CLIGenerator({
      name: 'test-cli',
      version: '1.0.0',
      description: 'Test CLI application',
      colors: false,
    });

    expect(generator).toBeDefined();

    const handler = generator.generateHandler();
    expect(typeof handler).toBe('function');
  });

  it('should handle basic commands without crashing', async () => {
    // Set NODE_ENV to test to prevent process.exit
    process.env.NODE_ENV = 'test';

    const { CLIGenerator } = await import('./cli-generator.ts');

    const generator = new CLIGenerator({
      name: 'test-cli',
      version: '1.0.0',
      description: 'Test CLI application',
      colors: false,
    });

    const handler = generator.generateHandler();

    // Mock console.log to prevent output during tests
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // Test help command - should complete without throwing
      await handler(['--help']);

      // Test version command - should complete without throwing
      await handler(['--version']);
    } finally {
      consoleSpy.mockRestore();
      process.env.NODE_ENV = undefined;
    }
  });

  it('should not crash in non-TTY environments (Issue #80)', async () => {
    // Mock non-TTY environment
    const originalIsTTY = process.stdout.isTTY;
    const originalClearLine = process.stdout.clearLine;
    const originalCursorTo = process.stdout.cursorTo;

    try {
      // Simulate non-TTY environment (tsx, CI/CD, pipes)
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });

      // Remove clearLine and cursorTo to simulate non-TTY
      delete (process.stdout as any).clearLine;
      delete (process.stdout as any).cursorTo;

      const { CLIGenerator } = await import('./cli-generator.ts');

      const generator = new CLIGenerator({
        name: 'test-cli',
        version: '1.0.0',
        description: 'Test CLI',
        colors: true, // Enabled to trigger spinner path
      });

      // Mock console.log to capture output
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
        logs.push(msg);
      });

      try {
        // This tests that spinner creation doesn't crash
        // by directly calling the private createSpinner method
        const spinner = (generator as any).createSpinner('Testing...');

        // In non-TTY, this should NOT throw an error
        expect(() => spinner.succeed('Done')).not.toThrow();
        expect(() => spinner.fail('Failed')).not.toThrow();

        // Verify fallback to console.log was used
        expect(logs.some((log) => log.includes('Testing'))).toBe(true);
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      // Restore original properties
      if (originalIsTTY !== undefined) {
        Object.defineProperty(process.stdout, 'isTTY', {
          value: originalIsTTY,
          writable: true,
          configurable: true,
        });
      }
      if (originalClearLine) {
        (process.stdout as any).clearLine = originalClearLine;
      }
      if (originalCursorTo) {
        (process.stdout as any).cursorTo = originalCursorTo;
      }
    }
  });
});
