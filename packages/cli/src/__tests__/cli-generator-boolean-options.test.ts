/**
 * Tests for CLI generator boolean option handling
 *
 * Issue #569: CLI generator registers boolean options as type 'string',
 * breaking flag parsing.
 *
 * @see https://github.com/happyvertical/smrt/issues/569
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

describe('CLI Generator - Boolean Options', () => {
  let cli: CLIGenerator;

  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isObjectTypeParameter', () => {
    it('should detect inline object type parameters', () => {
      // Access private method via type assertion
      const generator = cli as any;
      expect(
        generator.isObjectTypeParameter(
          '{ meetingId?: string; fetch?: boolean }',
        ),
      ).toBe(true);
      expect(generator.isObjectTypeParameter('string')).toBe(false);
      expect(generator.isObjectTypeParameter('boolean')).toBe(false);
      expect(generator.isObjectTypeParameter('number')).toBe(false);
    });
  });

  describe('generateObjectCommands', () => {
    beforeEach(() => {
      // Clear registry
      (ObjectRegistry as any)._classes = new Map();
      (ObjectRegistry as any)._methods = new Map();
    });

    afterEach(() => {
      // Clear registry after each test
      (ObjectRegistry as any)._classes = new Map();
      (ObjectRegistry as any)._methods = new Map();
    });

    it('should register boolean properties in object type params as type boolean', async () => {
      // Register a mock object with methods that have boolean options
      const mockMethods = new Map([
        [
          'analyze',
          {
            name: 'analyze',
            isPublic: true,
            parameters: [
              {
                name: 'options',
                type: '{ meetingId?: string; fetch?: boolean; limit?: number }',
                optional: true,
              },
            ],
          },
        ],
      ]);

      // Mock ObjectRegistry methods
      vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
        constructor: class MockClass {},
        packageName: 'test',
      });
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        cli: { include: ['analyze'] },
        api: false,
        mcp: false,
      });
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
      vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(mockMethods);

      // Generate commands (access private method)
      const commands = await (cli as any).generateObjectCommands(
        'MockObject',
        {},
      );

      // Find the analyze command
      const analyzeCmd = commands.find(
        (cmd: any) => cmd.name === 'mockobject:analyze',
      );
      expect(analyzeCmd).toBeDefined();

      // Check that boolean option is registered as boolean type
      expect(analyzeCmd.options.fetch).toEqual({
        type: 'boolean',
        description: 'boolean (optional)',
      });

      // Check that string option is registered as string type
      expect(analyzeCmd.options['meeting-id']).toEqual({
        type: 'string',
        description: 'string (optional)',
      });

      // Check that number option is registered as string type (default for non-boolean)
      expect(analyzeCmd.options.limit).toEqual({
        type: 'string',
        description: 'number (optional)',
      });
    });

    it('should register flat boolean params as type boolean', async () => {
      // Register a mock object with a method that has a flat boolean parameter
      const mockMethods = new Map([
        [
          'refresh',
          {
            name: 'refresh',
            isPublic: true,
            parameters: [
              {
                name: 'force',
                type: 'boolean',
                optional: true,
              },
              {
                name: 'source',
                type: 'string',
                optional: true,
              },
            ],
          },
        ],
      ]);

      vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
        constructor: class MockClass {},
        packageName: 'test',
      });
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        cli: { include: ['refresh'] },
        api: false,
        mcp: false,
      });
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
      vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(mockMethods);

      const commands = await (cli as any).generateObjectCommands(
        'MockObject',
        {},
      );

      const refreshCmd = commands.find(
        (cmd: any) => cmd.name === 'mockobject:refresh',
      );
      expect(refreshCmd).toBeDefined();

      // Check that boolean param is registered as boolean type
      expect(refreshCmd.options.force).toEqual({
        type: 'boolean',
        description: 'boolean (optional)',
      });

      // Check that string param is registered as string type
      expect(refreshCmd.options.source).toEqual({
        type: 'string',
        description: 'string (optional)',
      });
    });

    it('should handle mixed required and optional boolean params', async () => {
      const mockMethods = new Map([
        [
          'configure',
          {
            name: 'configure',
            isPublic: true,
            parameters: [
              {
                name: 'options',
                type: '{ enabled: boolean; verbose?: boolean; name: string }',
                optional: false,
              },
            ],
          },
        ],
      ]);

      vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
        constructor: class MockClass {},
        packageName: 'test',
      });
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        cli: { include: ['configure'] },
        api: false,
        mcp: false,
      });
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
      vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(mockMethods);

      const commands = await (cli as any).generateObjectCommands(
        'MockObject',
        {},
      );

      const configureCmd = commands.find(
        (cmd: any) => cmd.name === 'mockobject:configure',
      );
      expect(configureCmd).toBeDefined();

      // Required boolean
      expect(configureCmd.options.enabled.type).toBe('boolean');
      expect(configureCmd.options.enabled.description).not.toContain(
        'optional',
      );

      // Optional boolean
      expect(configureCmd.options.verbose.type).toBe('boolean');
      expect(configureCmd.options.verbose.description).toContain('optional');

      // Required string
      expect(configureCmd.options.name.type).toBe('string');
    });
  });
});
