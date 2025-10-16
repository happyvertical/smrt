/**
 * Gnode Commands Tests
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CLICommand } from '../../generators/cli.js';

// Mock dependencies
const mockResolveTemplate = vi.fn();
const mockLoadTemplate = vi.fn();
const mockGenerate = vi.fn();
const mockCleanupGitTemplate = vi.fn();
const mockDiscoverInstalledTemplates = vi.fn();

vi.mock('../loaders/index.js', () => ({
  resolveTemplate: (...args: any[]) => mockResolveTemplate(...args),
  loadTemplate: (...args: any[]) => mockLoadTemplate(...args),
  cleanupGitTemplate: (...args: any[]) => mockCleanupGitTemplate(...args),
  discoverInstalledTemplates: (...args: any[]) =>
    mockDiscoverInstalledTemplates(...args),
}));

vi.mock('../utils/generator.js', () => ({
  generate: (...args: any[]) => mockGenerate(...args),
}));

describe('Gnode Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('gnode create', () => {
    it('should have correct command definition', async () => {
      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      expect(command).toBeDefined();
      expect(command.name).toBe('gnode create');
      expect(command.description).toContain('gnode');
      expect(command.args).toEqual(['name']);
      expect(command.options).toHaveProperty('template');
      expect(command.options).toHaveProperty('output-dir');
    });

    it('should throw error if name is missing', async () => {
      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      await expect(command.handler([], {})).rejects.toThrow(/name is required/);
    });

    it('should use default template if not specified', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'npm',
        location: 'sveltekit',
        resolved: '/node_modules/sveltekit',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'SvelteKit',
        description: 'SvelteKit template',
        dependencies: {},
      });
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], {});

      expect(mockResolveTemplate).toHaveBeenCalledWith('sveltekit');

      consoleSpy.mockRestore();
    });

    it('should use specified template', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'git',
        location: 'github:user/repo',
        resolved: 'github:user/repo',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'Custom Template',
        description: 'From git',
        dependencies: {},
      });
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], { template: 'github:user/repo' });

      expect(mockResolveTemplate).toHaveBeenCalledWith('github:user/repo');

      consoleSpy.mockRestore();
    });

    it('should use default output directory', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'npm',
        location: 'template',
        resolved: '/node_modules/template',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'Template',
        description: 'Test',
        dependencies: {},
      });
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], {});

      expect(mockGenerate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          name: 'my-gnode',
          outputDir: './my-gnode',
        }),
      );

      consoleSpy.mockRestore();
    });

    it('should use custom output directory if specified', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'npm',
        location: 'template',
        resolved: '/node_modules/template',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'Template',
        description: 'Test',
        dependencies: {},
      });
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], { outputDir: '/custom/path' });

      expect(mockGenerate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          outputDir: '/custom/path',
        }),
      );

      consoleSpy.mockRestore();
    });

    it('should cleanup git templates after creation', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'git',
        location: 'github:user/repo',
        resolved: 'github:user/repo',
      });
      const mockConfig = {
        name: 'Template',
        description: 'Git template',
        dependencies: {},
        __tempDir: '/tmp/test',
      };
      mockLoadTemplate.mockResolvedValue(mockConfig);
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], {});

      expect(mockCleanupGitTemplate).toHaveBeenCalledWith(mockConfig);

      consoleSpy.mockRestore();
    });

    it('should not cleanup non-git templates', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'npm',
        location: 'template',
        resolved: '/node_modules/template',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'Template',
        description: 'NPM template',
        dependencies: {},
      });
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], {});

      expect(mockCleanupGitTemplate).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should display progress messages', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'npm',
        location: 'template',
        resolved: '/node_modules/template',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'Template',
        description: 'Test',
        dependencies: {},
      });
      mockGenerate.mockResolvedValue(undefined);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler(['my-gnode'], {});

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Resolving template'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Found template'),
      );

      consoleSpy.mockRestore();
    });

    it('should throw descriptive error on failure', async () => {
      mockResolveTemplate.mockRejectedValue(new Error('Template not found'));

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(command.handler(['my-gnode'], {})).rejects.toThrow(
        /Failed to create gnode/,
      );
      await expect(command.handler(['my-gnode'], {})).rejects.toThrow(
        /Template not found/,
      );

      consoleSpy.mockRestore();
    });

    it('should handle template resolution errors', async () => {
      mockResolveTemplate.mockRejectedValue(new Error('Network error'));

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      await expect(command.handler(['my-gnode'], {})).rejects.toThrow();
    });

    it('should handle generation errors', async () => {
      mockResolveTemplate.mockResolvedValue({
        type: 'npm',
        location: 'template',
        resolved: '/node_modules/template',
      });
      mockLoadTemplate.mockResolvedValue({
        name: 'Template',
        description: 'Test',
        dependencies: {},
      });
      mockGenerate.mockRejectedValue(new Error('Generation failed'));

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode create'];

      await expect(command.handler(['my-gnode'], {})).rejects.toThrow();
    });
  });

  describe('gnode list-templates', () => {
    it('should have correct command definition', async () => {
      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode list-templates'];

      expect(command).toBeDefined();
      expect(command.name).toBe('gnode list-templates');
      expect(command.description).toContain('available');
      expect(command.aliases).toContain('gnode ls');
    });

    it('should list discovered templates', async () => {
      const mockTemplates = [
        {
          name: 'SvelteKit Template',
          source: '@org/templates/sveltekit',
          config: {
            name: 'SvelteKit Template',
            description: 'SvelteKit starter',
            framework: 'sveltekit',
            dependencies: {},
          },
        },
        {
          name: 'Next.js Template',
          source: '@org/templates/nextjs',
          config: {
            name: 'Next.js Template',
            description: 'Next.js starter',
            framework: 'next',
            dependencies: {},
          },
        },
      ];

      mockDiscoverInstalledTemplates.mockResolvedValue(mockTemplates);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode list-templates'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler([], {});

      expect(mockDiscoverInstalledTemplates).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SvelteKit Template'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Next.js Template'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Found 2 template(s)'),
      );

      consoleSpy.mockRestore();
    });

    it('should display helpful message when no templates found', async () => {
      mockDiscoverInstalledTemplates.mockResolvedValue([]);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode list-templates'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler([], {});

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('No templates found'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('npm install'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('git repository'),
      );

      consoleSpy.mockRestore();
    });

    it('should display template metadata', async () => {
      const mockTemplates = [
        {
          name: 'Test Template',
          source: '@org/template',
          config: {
            name: 'Test Template',
            description: 'Test description',
            framework: 'sveltekit',
            dependencies: {},
          },
        },
      ];

      mockDiscoverInstalledTemplates.mockResolvedValue(mockTemplates);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode list-templates'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler([], {});

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test description'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Source: @org/template'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Framework: sveltekit'),
      );

      consoleSpy.mockRestore();
    });

    it('should handle framework undefined gracefully', async () => {
      const mockTemplates = [
        {
          name: 'Template',
          source: '@org/template',
          config: {
            name: 'Template',
            description: 'Test',
            dependencies: {},
            // No framework specified
          },
        },
      ];

      mockDiscoverInstalledTemplates.mockResolvedValue(mockTemplates);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode list-templates'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler([], {});

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Framework: unknown'),
      );

      consoleSpy.mockRestore();
    });

    it('should display usage examples when templates exist', async () => {
      const mockTemplates = [
        {
          name: 'Template',
          source: '@org/template',
          config: {
            name: 'Template',
            description: 'Test',
            framework: 'test',
            dependencies: {},
          },
        },
      ];

      mockDiscoverInstalledTemplates.mockResolvedValue(mockTemplates);

      const { gnodeCommands } = await import('./gnode.js');

      const command = gnodeCommands['gnode list-templates'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command.handler([], {});

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage:'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('smrt gnode create'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Command Integration', () => {
    it('should export gnodeCommands object', async () => {
      const { gnodeCommands } = await import('./gnode.js');

      expect(gnodeCommands).toBeDefined();
      expect(typeof gnodeCommands).toBe('object');
    });

    it('should have all required commands', async () => {
      const { gnodeCommands } = await import('./gnode.js');

      expect(gnodeCommands['gnode create']).toBeDefined();
      expect(gnodeCommands['gnode list-templates']).toBeDefined();
    });

    it('should have proper command signatures', async () => {
      const { gnodeCommands } = await import('./gnode.js');

      for (const [name, command] of Object.entries(gnodeCommands)) {
        expect(command.name).toBeDefined();
        expect(command.description).toBeDefined();
        expect(typeof command.handler).toBe('function');
      }
    });
  });
});
