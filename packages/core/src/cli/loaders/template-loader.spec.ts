/**
 * Template Loader Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitLoader from './git-loader.js';
import * as localLoader from './local-loader.js';
import * as npmLoader from './npm-loader.js';
import { loadTemplate, resolveTemplate } from './template-loader.js';

describe('Template Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveTemplate', () => {
    it('should resolve npm package with @ prefix', async () => {
      const mockResolve = vi
        .spyOn(npmLoader, 'resolveNpmPackage')
        .mockResolvedValue('/node_modules/@org/package');

      const result = await resolveTemplate('@org/package');

      expect(result.type).toBe('npm');
      expect(result.location).toBe('@org/package');
      expect(mockResolve).toHaveBeenCalledWith('@org/package');
    });

    it('should resolve npm package with / in name', async () => {
      const mockResolve = vi
        .spyOn(npmLoader, 'resolveNpmPackage')
        .mockResolvedValue('/node_modules/org/package');

      const result = await resolveTemplate('org/package');

      expect(result.type).toBe('npm');
      expect(result.location).toBe('org/package');
      expect(mockResolve).toHaveBeenCalledWith('org/package');
    });

    it('should resolve github: shorthand as git', async () => {
      const result = await resolveTemplate('github:user/repo');

      expect(result.type).toBe('git');
      expect(result.location).toBe('github:user/repo');
      expect(result.resolved).toBe('github:user/repo');
    });

    it('should resolve gitlab: shorthand as git', async () => {
      const result = await resolveTemplate('gitlab:user/repo');

      expect(result.type).toBe('git');
      expect(result.location).toBe('gitlab:user/repo');
      expect(result.resolved).toBe('gitlab:user/repo');
    });

    it('should resolve HTTPS GitHub URL as git', async () => {
      const result = await resolveTemplate('https://github.com/user/repo.git');

      expect(result.type).toBe('git');
      expect(result.location).toBe('https://github.com/user/repo.git');
      expect(result.resolved).toBe('https://github.com/user/repo.git');
    });

    it('should resolve SSH GitHub URL as git', async () => {
      const result = await resolveTemplate('git@github.com:user/repo.git');

      expect(result.type).toBe('git');
      expect(result.location).toBe('git@github.com:user/repo.git');
      expect(result.resolved).toBe('git@github.com:user/repo.git');
    });

    it('should resolve absolute path as local', async () => {
      const mockResolve = vi
        .spyOn(localLoader, 'resolveLocalPath')
        .mockResolvedValue('/absolute/path');

      const result = await resolveTemplate('/absolute/path');

      expect(result.type).toBe('local');
      expect(result.location).toBe('/absolute/path');
      expect(mockResolve).toHaveBeenCalledWith('/absolute/path');
    });

    it('should resolve relative path as local', async () => {
      const mockResolve = vi
        .spyOn(localLoader, 'resolveLocalPath')
        .mockResolvedValue('/resolved/path');

      const result = await resolveTemplate('./relative/path');

      expect(result.type).toBe('local');
      expect(result.location).toBe('./relative/path');
      expect(mockResolve).toHaveBeenCalledWith('./relative/path');
    });

    it('should resolve home directory path as local', async () => {
      const mockResolve = vi
        .spyOn(localLoader, 'resolveLocalPath')
        .mockResolvedValue('/home/user/path');

      const result = await resolveTemplate('~/path');

      expect(result.type).toBe('local');
      expect(result.location).toBe('~/path');
      expect(mockResolve).toHaveBeenCalledWith('~/path');
    });

    it('should search installed packages for short name', async () => {
      const mockFind = vi
        .spyOn(npmLoader, 'findTemplateInPackages')
        .mockResolvedValue('/node_modules/@org/templates/shortname');
      const mockResolve = vi
        .spyOn(npmLoader, 'resolveNpmPackage')
        .mockResolvedValue('/node_modules/@org/templates/shortname');

      const result = await resolveTemplate('shortname');

      expect(result.type).toBe('npm');
      expect(mockFind).toHaveBeenCalledWith('shortname');
      expect(mockResolve).toHaveBeenCalled();
    });

    it('should throw error if short name not found', async () => {
      const mockFind = vi
        .spyOn(npmLoader, 'findTemplateInPackages')
        .mockResolvedValue(null);

      await expect(resolveTemplate('nonexistent')).rejects.toThrow(
        /Template 'nonexistent' not found/,
      );
    });
  });

  describe('loadTemplate', () => {
    it('should load npm template', async () => {
      const mockConfig = {
        name: 'Test Template',
        description: 'Test description',
        dependencies: {},
      };

      const mockLoad = vi
        .spyOn(npmLoader, 'loadNpmTemplate')
        .mockResolvedValue(mockConfig);

      const source = {
        type: 'npm' as const,
        location: '@org/template',
        resolved: '/node_modules/@org/template',
      };

      const result = await loadTemplate(source);

      expect(result).toEqual(mockConfig);
      expect(mockLoad).toHaveBeenCalledWith('/node_modules/@org/template');
    });

    it('should load git template', async () => {
      const mockConfig = {
        name: 'Git Template',
        description: 'From git',
        dependencies: {},
      };

      const mockLoad = vi
        .spyOn(gitLoader, 'loadGitTemplate')
        .mockResolvedValue(mockConfig);

      const source = {
        type: 'git' as const,
        location: 'github:user/repo',
        resolved: 'github:user/repo',
      };

      const result = await loadTemplate(source);

      expect(result).toEqual(mockConfig);
      expect(mockLoad).toHaveBeenCalledWith('github:user/repo');
    });

    it('should load local template', async () => {
      const mockConfig = {
        name: 'Local Template',
        description: 'From filesystem',
        dependencies: {},
      };

      const mockLoad = vi
        .spyOn(localLoader, 'loadLocalTemplate')
        .mockResolvedValue(mockConfig);

      const source = {
        type: 'local' as const,
        location: '/absolute/path',
        resolved: '/absolute/path',
      };

      const result = await loadTemplate(source);

      expect(result).toEqual(mockConfig);
      expect(mockLoad).toHaveBeenCalledWith('/absolute/path');
    });

    it('should throw error for unknown source type', async () => {
      const source = {
        type: 'unknown' as any,
        location: 'test',
        resolved: 'test',
      };

      await expect(loadTemplate(source)).rejects.toThrow(
        /Unknown template type/,
      );
    });
  });
});
