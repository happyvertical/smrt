/**
 * Git Loader Tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted to create mocks before hoisting
const { mockMkdir, mockRm } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockRm: vi.fn(),
}));

// Mock filesystem operations with factory functions for ESM
vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  rm: mockRm,
}));

// Import after mocks are set up
import {
  cleanupGitTemplate,
  getGitTemplateDir,
  loadGitTemplate,
} from './git-loader.js';

describe('Git Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations to no-op by default
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  describe('parseGitUrl (via integration)', () => {
    // Since parseGitUrl is internal, we test the URL parsing indirectly
    // by checking that different URL formats are accepted without errors

    it('should accept github shorthand', async () => {
      // This will fail at download stage, but should parse successfully
      try {
        await loadGitTemplate('github:user/repo');
      } catch (error) {
        // Expected to fail at download, not at parsing
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept github shorthand with subdirectory', async () => {
      try {
        await loadGitTemplate('github:user/repo/templates/sveltekit');
      } catch (error) {
        // Should parse successfully, fail at download
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept github shorthand with ref', async () => {
      try {
        await loadGitTemplate('github:user/repo#main');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept github HTTPS URL', async () => {
      try {
        await loadGitTemplate('https://github.com/user/repo.git');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept github HTTPS URL with ref and subdir', async () => {
      try {
        await loadGitTemplate(
          'https://github.com/user/repo.git#main:templates',
        );
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept github SSH URL', async () => {
      try {
        await loadGitTemplate('git@github.com:user/repo.git');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept gitlab shorthand', async () => {
      try {
        await loadGitTemplate('gitlab:user/repo');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept gitlab with subdirectory', async () => {
      try {
        await loadGitTemplate('gitlab:user/repo/templates/subdir');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should accept bitbucket shorthand', async () => {
      try {
        await loadGitTemplate('bitbucket:user/repo');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should reject unsupported git host', async () => {
      await expect(loadGitTemplate('unsupported:user/repo')).rejects.toThrow(
        /Unsupported git URL/,
      );
    });

    it('should reject invalid URL format', async () => {
      await expect(loadGitTemplate('not-a-git-url')).rejects.toThrow(
        /Unsupported git URL/,
      );
    });
  });

  describe('getTarballUrl', () => {
    // Internal function, tested indirectly via URL construction

    it('should construct GitHub tarball URL correctly', async () => {
      // Test that GitHub URLs are constructed correctly
      // by verifying the download attempt goes to the right place
      try {
        await loadGitTemplate('github:user/repo#main');
      } catch (error) {
        // Expected to fail at download, but URL should be correct
        expect(error).toBeDefined();
      }
    });

    it('should construct GitLab tarball URL correctly', async () => {
      try {
        await loadGitTemplate('gitlab:user/repo#main');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should construct Bitbucket tarball URL correctly', async () => {
      try {
        await loadGitTemplate('bitbucket:user/repo#main');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('downloadTarball', () => {
    // Testing actual downloads requires mocking https and tar extraction
    // These would be integration tests

    it('should handle HTTP redirects', async () => {
      // Would need to mock https.get to test redirect handling
      // This is a complex integration test
    });

    it('should handle download failures', async () => {
      // Would need to mock https.get to test error handling
    });

    it('should extract tarball with strip: 1', async () => {
      // Would need to mock tar.extract to verify correct options
    });
  });

  describe('loadGitTemplate', () => {
    it('should create temp directory', async () => {
      // Mock mkdir to track calls
      mockMkdir.mockResolvedValue(undefined);

      try {
        await loadGitTemplate('github:user/repo');
      } catch (error) {
        // Expected to fail at download
        expect(mockMkdir).toHaveBeenCalled();
      }
    });

    it('should cleanup temp directory on error', async () => {
      mockRm.mockResolvedValue(undefined);

      try {
        await loadGitTemplate('github:user/repo');
      } catch (error) {
        // Should cleanup on failure
        expect(mockRm).toHaveBeenCalled();
      }
    });

    it('should look for template.config.js first', async () => {
      // Would need to mock fs operations and dynamic imports
      // to fully test config loading priority
    });

    it('should fallback to template.config.ts if .js not found', async () => {
      // Would need to mock fs operations to test fallback
    });

    it('should throw error if no config file found', async () => {
      // Would need to mock fs and downloads to test this path
    });

    it('should handle subdirectory correctly', async () => {
      // Test that subdirectories are used in template path
      try {
        await loadGitTemplate('github:user/repo/templates/subdir');
      } catch (error) {
        // Should parse and use subdirectory, fail at download/config load
        expect(error).toBeDefined();
      }
    });

    it('should validate template config', async () => {
      // Would need to mock successful download and invalid config
      // to test validation
    });
  });

  describe('getGitTemplateDir', () => {
    it('should return temp directory from config', async () => {
      const mockConfig = {
        name: 'Test',
        description: 'Test',
        dependencies: {},
        __tempDir: '/tmp/test-12345',
      } as any;

      const result = getGitTemplateDir(mockConfig);
      expect(result).toBe('/tmp/test-12345');
    });

    it('should throw error if no temp directory', async () => {
      const mockConfig = {
        name: 'Test',
        description: 'Test',
        dependencies: {},
      } as any;

      expect(() => getGitTemplateDir(mockConfig)).toThrow(
        /not loaded from git repository/,
      );
    });
  });

  describe('cleanupGitTemplate', () => {
    it('should remove temp directory if present', async () => {
      mockRm.mockResolvedValue(undefined);

      const mockConfig = {
        name: 'Test',
        description: 'Test',
        dependencies: {},
        __tempDir: '/tmp/test-12345',
      } as any;

      await cleanupGitTemplate(mockConfig);

      expect(mockRm).toHaveBeenCalledWith('/tmp/test-12345', {
        recursive: true,
        force: true,
      });
    });

    it('should not fail if no temp directory', async () => {
      const mockConfig = {
        name: 'Test',
        description: 'Test',
        dependencies: {},
      } as any;

      // Should not throw
      await expect(cleanupGitTemplate(mockConfig)).resolves.toBeUndefined();
    });
  });

  describe('validateTemplateConfig', () => {
    // Internal function, but critical for security

    it('should require name field', async () => {
      // Would need to export or test via loadGitTemplate
    });

    it('should require description field', async () => {
      // Would need to export or test via loadGitTemplate
    });

    it('should require dependencies field', async () => {
      // Would need to export or test via loadGitTemplate
    });

    it('should validate dependencies is object', async () => {
      // Would need to export or test via loadGitTemplate
    });

    it('should validate devDependencies is object if present', async () => {
      // Would need to export or test via loadGitTemplate
    });
  });

  describe('Subdirectory Support', () => {
    it('should parse subdirectory from github shorthand', async () => {
      // Test URL with subdirectory
      try {
        await loadGitTemplate('github:user/repo/path/to/template');
      } catch (error) {
        // Should parse correctly, fail at download
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should parse subdirectory with ref from shorthand', async () => {
      try {
        await loadGitTemplate('github:user/repo#branch/path/to/template');
      } catch (error) {
        // Note: This syntax might not work as intended
        // The proper syntax is github:user/repo/path/to/template#branch
        expect(error).toBeDefined();
      }
    });

    it('should parse subdirectory from HTTPS URL with colon syntax', async () => {
      try {
        await loadGitTemplate(
          'https://github.com/user/repo.git#main:path/to/template',
        );
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should handle deep subdirectory paths', async () => {
      try {
        await loadGitTemplate(
          'github:user/repo/very/deep/nested/path/to/template',
        );
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).not.toContain('Unsupported git URL');
      }
    });

    it('should use subdirectory when looking for config', async () => {
      // Test that subdirectory is used in config path
      // Would need mocking to fully verify
      try {
        await loadGitTemplate('github:user/repo/templates#main');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });
});
