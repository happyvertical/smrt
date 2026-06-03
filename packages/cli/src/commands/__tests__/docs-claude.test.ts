/**
 * Unit tests for docs:agents command
 *
 * Tests README section extraction and markdown generation
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectMonorepoRoot,
  extractReadmeSections,
  generateMarkdown,
  type PackageInfo,
  type RootDocInfo,
} from '../docs-claude.js';

describe('docs:agents', () => {
  describe('extractReadmeSections', () => {
    it('should extract H2 sections by exact name match', () => {
      const readme = `# My Package

## Installation

Run \`npm install\` to install.

## Usage

Here's how to use it.

## API
`;

      const sections = extractReadmeSections(readme, ['Installation', 'Usage']);

      expect(sections.Installation).toBe('Run `npm install` to install.');
      expect(sections.Usage).toBe("Here's how to use it.");
    });

    it('should extract sections case-insensitively', () => {
      const readme = `# Package

## key Features

- Feature 1
- Feature 2
`;

      const sections = extractReadmeSections(readme, ['Key Features']);

      expect(sections['Key Features']).toContain('Feature 1');
      expect(sections['Key Features']).toContain('Feature 2');
    });

    it('should extract section by partial match', () => {
      const readme = `# Package

## Advanced Usage Examples

Some examples here.
`;

      const sections = extractReadmeSections(readme, ['Usage']);

      expect(sections.Usage).toBe('Some examples here.');
    });

    it('should handle section at end of file', () => {
      const readme = `# Package

## Installation

Install instructions.

## Notes

Final notes here.`;

      const sections = extractReadmeSections(readme, ['Notes']);

      expect(sections.Notes).toBe('Final notes here.');
    });

    it('should stop extraction at next H2', () => {
      const readme = `# Package

## First Section

Content for first section.

## Second Section

Content for second section.
`;

      const sections = extractReadmeSections(readme, ['First Section']);

      expect(sections['First Section']).toBe('Content for first section.');
      expect(sections['First Section']).not.toContain('second');
    });

    it('should stop extraction at H1', () => {
      const readme = `# Package

## Section

Section content.

# Another Document

Different content.
`;

      const sections = extractReadmeSections(readme, ['Section']);

      expect(sections.Section).toBe('Section content.');
      expect(sections.Section).not.toContain('Different');
    });

    it('should return empty object for non-existent sections', () => {
      const readme = `# Package

## Existing

Some content.
`;

      const sections = extractReadmeSections(readme, ['NonExistent']);

      expect(sections.NonExistent).toBeUndefined();
    });

    it('should handle multiple requested sections', () => {
      const readme = `# Package

## Alpha

Alpha content.

## Beta

Beta content.

## Gamma

Gamma content.
`;

      const sections = extractReadmeSections(readme, ['Alpha', 'Gamma']);

      expect(sections.Alpha).toBe('Alpha content.');
      expect(sections.Gamma).toBe('Gamma content.');
      expect(sections.Beta).toBeUndefined();
    });
  });

  describe('generateMarkdown', () => {
    it('should generate header and package table', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
        {
          name: '@test/pkg-b',
          version: '2.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('# SMRT Framework Context');
      expect(markdown).toContain('| Package | Version |');
      expect(markdown).toContain('| @test/pkg-a | 1.0.0 |');
      expect(markdown).toContain('| @test/pkg-b | 2.0.0 |');
    });

    it('should show placeholder for packages without AGENTS.md', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/no-docs',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('## @test/no-docs');
      expect(markdown).toContain('*No AGENTS.md found for this package.*');
    });

    it('should include AGENTS.md content and strip H1', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/with-agents-md',
          version: '1.0.0',
          readme: null,
          agentMd: '# My Package\n\nThis is the documentation.',
        },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('## @test/with-agents-md');
      expect(markdown).toContain('This is the documentation.');
      expect(markdown).not.toContain('# My Package');
    });

    it('should include footer with regeneration note', () => {
      const packages: PackageInfo[] = [];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('*Generated by `smrt docs:agents`');
      expect(markdown).toContain('regenerate after dependency updates*');
    });

    it('should include contributing section with issue link', () => {
      const packages: PackageInfo[] = [];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('## Contributing to This Documentation');
      expect(markdown).toContain(
        'https://github.com/happyvertical/smrt/issues',
      );
      expect(markdown).toContain('The package name');
      expect(markdown).toContain('Description of the gotcha or pattern');
      expect(markdown).toContain('Example code if applicable');
    });
  });

  describe('generateMarkdown with root docs', () => {
    it('should include framework documentation section when root docs provided', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const rootDocs: RootDocInfo[] = [
        {
          filename: 'AGENTS.md',
          heading: 'Framework Overview',
          content: '# Overview\n\nThis is the framework overview.',
        },
        {
          filename: 'TESTING_STANDARD.md',
          heading: 'Testing Guide',
          content: '# Testing\n\nThis is the testing guide.',
        },
      ];

      const markdown = generateMarkdown(packages, rootDocs);

      expect(markdown).toContain('## Framework Documentation');
      expect(markdown).toContain('### Framework Overview');
      expect(markdown).toContain('*Source: AGENTS.md*');
      expect(markdown).toContain('This is the framework overview.');
      expect(markdown).toContain('### Testing Guide');
      expect(markdown).toContain('*Source: TESTING_STANDARD.md*');
      expect(markdown).toContain('This is the testing guide.');
      expect(markdown).toContain('## Package Documentation');
    });

    it('should not include framework section when no root docs provided', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).not.toContain('## Framework Documentation');
      expect(markdown).not.toContain('## Package Documentation');
    });

    it('should not include framework section when empty root docs array', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages, []);

      expect(markdown).not.toContain('## Framework Documentation');
      expect(markdown).not.toContain('## Package Documentation');
    });

    it('should include all root docs in order', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const rootDocs: RootDocInfo[] = [
        {
          filename: 'AGENTS.md',
          heading: 'Framework Overview',
          content: 'First doc content',
        },
        {
          filename: 'TESTING_STANDARD.md',
          heading: 'Testing Guide',
          content: 'Second doc content',
        },
        {
          filename: 'CONTRIBUTING.md',
          heading: 'Contributing',
          content: 'Third doc content',
        },
        {
          filename: 'WORKFLOW.md',
          heading: 'Development Workflow',
          content: 'Fourth doc content',
        },
      ];

      const markdown = generateMarkdown(packages, rootDocs);

      const overviewIndex = markdown.indexOf('Framework Overview');
      const testingIndex = markdown.indexOf('Testing Guide');
      const contributingIndex = markdown.indexOf('Contributing');
      const workflowIndex = markdown.indexOf('Development Workflow');

      expect(overviewIndex).toBeLessThan(testingIndex);
      expect(testingIndex).toBeLessThan(contributingIndex);
      expect(contributingIndex).toBeLessThan(workflowIndex);
    });

    it('should include separators between root docs', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const rootDocs: RootDocInfo[] = [
        {
          filename: 'AGENTS.md',
          heading: 'Framework Overview',
          content: 'Content',
        },
      ];

      const markdown = generateMarkdown(packages, rootDocs);

      // Should have separators (---) around framework docs
      expect(markdown).toMatch(/---\s+### Framework Overview/);
      expect(markdown).toMatch(/---\s+## Package Documentation/);
    });
  });

  describe('generateMarkdown with SDK packages', () => {
    it('should include SDK packages table when provided', () => {
      const packages: PackageInfo[] = [
        {
          name: '@happyvertical/smrt-core',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const sdkPackages: PackageInfo[] = [
        {
          name: '@happyvertical/ai',
          version: '2.0.0',
          readme: null,
          agentMd: null,
        },
        {
          name: '@happyvertical/sql',
          version: '2.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages, undefined, sdkPackages);

      expect(markdown).toContain('## Installed SMRT Packages');
      expect(markdown).toContain('| @happyvertical/smrt-core | 1.0.0 |');
      expect(markdown).toContain('## Installed SDK Packages');
      expect(markdown).toContain('| @happyvertical/ai | 2.0.0 |');
      expect(markdown).toContain('| @happyvertical/sql | 2.0.0 |');
    });

    it('should include SDK package details with AGENTS.md', () => {
      const packages: PackageInfo[] = [];
      const sdkPackages: PackageInfo[] = [
        {
          name: '@happyvertical/ai',
          version: '2.0.0',
          readme: null,
          agentMd: '# AI Package\n\nMulti-provider AI client.',
        },
      ];

      const markdown = generateMarkdown(packages, undefined, sdkPackages);

      expect(markdown).toContain('## SDK Package Details');
      expect(markdown).toContain('### @happyvertical/ai');
      expect(markdown).toContain('Multi-provider AI client.');
      // H1 should be stripped
      expect(markdown).not.toContain('# AI Package');
    });

    it('should show placeholder for SDK packages without docs', () => {
      const packages: PackageInfo[] = [];
      const sdkPackages: PackageInfo[] = [
        {
          name: '@happyvertical/utils',
          version: '2.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages, undefined, sdkPackages);

      expect(markdown).toContain('### @happyvertical/utils');
      expect(markdown).toContain('*No AGENTS.md found for this package.*');
    });

    it('should not include SDK sections when no SDK packages', () => {
      const packages: PackageInfo[] = [
        {
          name: '@test/pkg-a',
          version: '1.0.0',
          readme: null,
          agentMd: null,
        },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).not.toContain('## Installed SDK Packages');
      expect(markdown).not.toContain('## SDK Package Details');
    });
  });

  describe('detectMonorepoRoot', () => {
    let tempDir: string;
    let originalCwd: string;

    beforeEach(() => {
      // Use realpathSync to normalize path (macOS /var is symlink to /private/var)
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-test-')));
      originalCwd = process.cwd();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should detect monorepo root from cwd', () => {
      // Create monorepo structure
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*',
      );
      mkdirSync(join(tempDir, 'packages'));
      writeFileSync(join(tempDir, 'AGENTS.md'), '# Framework Docs');

      process.chdir(tempDir);
      const root = detectMonorepoRoot();

      expect(root).toBe(tempDir);
    });

    it('should detect monorepo root from subdirectory', () => {
      // Create monorepo structure
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*',
      );
      mkdirSync(join(tempDir, 'packages'));
      writeFileSync(join(tempDir, 'AGENTS.md'), '# Framework Docs');

      // Create and cd into subdirectory
      const subDir = join(tempDir, 'packages', 'cli');
      mkdirSync(subDir, { recursive: true });
      process.chdir(subDir);

      const root = detectMonorepoRoot();

      expect(root).toBe(tempDir);
    });

    it('should return null when not in monorepo', () => {
      // Create directory without monorepo markers
      process.chdir(tempDir);
      const root = detectMonorepoRoot();

      expect(root).toBeNull();
    });

    it('should return null when missing pnpm-workspace.yaml', () => {
      // Missing pnpm-workspace.yaml
      mkdirSync(join(tempDir, 'packages'));
      writeFileSync(join(tempDir, 'AGENTS.md'), '# Framework Docs');

      process.chdir(tempDir);
      const root = detectMonorepoRoot();

      expect(root).toBeNull();
    });

    it('should return null when missing packages directory', () => {
      // Missing packages/
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*',
      );
      writeFileSync(join(tempDir, 'AGENTS.md'), '# Framework Docs');

      process.chdir(tempDir);
      const root = detectMonorepoRoot();

      expect(root).toBeNull();
    });

    it('should return null when missing AGENTS.md', () => {
      // Missing AGENTS.md
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*',
      );
      mkdirSync(join(tempDir, 'packages'));

      process.chdir(tempDir);
      const root = detectMonorepoRoot();

      expect(root).toBeNull();
    });
  });
});
