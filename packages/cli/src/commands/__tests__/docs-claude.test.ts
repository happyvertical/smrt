/**
 * Unit tests for docs:claude command
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
  type ClaudeMeta,
  detectMonorepoRoot,
  extractReadmeSections,
  generateMarkdown,
  type PackageInfo,
  type RootDocInfo,
} from '../docs-claude.js';

describe('docs:claude', () => {
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
        { name: '@test/pkg-a', version: '1.0.0', meta: null, readme: null },
        { name: '@test/pkg-b', version: '2.0.0', meta: null, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('# SMRT Framework Context');
      expect(markdown).toContain('| Package | Version |');
      expect(markdown).toContain('| @test/pkg-a | 1.0.0 |');
      expect(markdown).toContain('| @test/pkg-b | 2.0.0 |');
    });

    it('should show placeholder for packages without meta', () => {
      const packages: PackageInfo[] = [
        { name: '@test/no-meta', version: '1.0.0', meta: null, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('## @test/no-meta');
      expect(markdown).toContain(
        '*No .claude-meta.json found for this package.*',
      );
    });

    it('should include purpose from meta', () => {
      const meta: ClaudeMeta = {
        purpose: 'A test package for unit testing.',
      };
      const packages: PackageInfo[] = [
        { name: '@test/with-meta', version: '1.0.0', meta, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('A test package for unit testing.');
    });

    it('should include patterns with examples', () => {
      const meta: ClaudeMeta = {
        purpose: 'Test',
        patterns: [
          {
            name: 'Factory Pattern',
            description: 'Use factory for object creation.',
            example: 'const obj = Factory.create();',
          },
        ],
      };
      const packages: PackageInfo[] = [
        { name: '@test/patterns', version: '1.0.0', meta, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('### Patterns');
      expect(markdown).toContain('#### Factory Pattern');
      expect(markdown).toContain('Use factory for object creation.');
      expect(markdown).toContain('```typescript');
      expect(markdown).toContain('const obj = Factory.create();');
    });

    it('should include pitfalls as bullet list', () => {
      const meta: ClaudeMeta = {
        purpose: 'Test',
        pitfalls: [
          'Do not call method X before Y',
          'Always check return value',
        ],
      };
      const packages: PackageInfo[] = [
        { name: '@test/pitfalls', version: '1.0.0', meta, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('### Pitfalls');
      expect(markdown).toContain('- Do not call method X before Y');
      expect(markdown).toContain('- Always check return value');
    });

    it('should include key exports', () => {
      const meta: ClaudeMeta = {
        purpose: 'Test',
        exports: ['ClassA', 'ClassB', 'helperFn'],
      };
      const packages: PackageInfo[] = [
        { name: '@test/exports', version: '1.0.0', meta, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('### Key Exports');
      expect(markdown).toContain('`ClassA`, `ClassB`, `helperFn`');
    });

    it('should extract README sections when specified', () => {
      const meta: ClaudeMeta = {
        purpose: 'Test',
        readmeSections: ['Features'],
      };
      const readme = `# Package

## Features

- Feature 1
- Feature 2
`;
      const packages: PackageInfo[] = [
        { name: '@test/readme', version: '1.0.0', meta, readme },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('### Features');
      expect(markdown).toContain('- Feature 1');
      expect(markdown).toContain('- Feature 2');
    });

    it('should include footer with regeneration note', () => {
      const packages: PackageInfo[] = [];

      const markdown = generateMarkdown(packages);

      expect(markdown).toContain('*Generated by `smrt docs:claude`');
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
        { name: '@test/pkg-a', version: '1.0.0', meta: null, readme: null },
      ];

      const rootDocs: RootDocInfo[] = [
        {
          filename: 'CLAUDE.md',
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
      expect(markdown).toContain('*Source: CLAUDE.md*');
      expect(markdown).toContain('This is the framework overview.');
      expect(markdown).toContain('### Testing Guide');
      expect(markdown).toContain('*Source: TESTING_STANDARD.md*');
      expect(markdown).toContain('This is the testing guide.');
      expect(markdown).toContain('## Package Documentation');
    });

    it('should not include framework section when no root docs provided', () => {
      const packages: PackageInfo[] = [
        { name: '@test/pkg-a', version: '1.0.0', meta: null, readme: null },
      ];

      const markdown = generateMarkdown(packages);

      expect(markdown).not.toContain('## Framework Documentation');
      expect(markdown).not.toContain('## Package Documentation');
    });

    it('should not include framework section when empty root docs array', () => {
      const packages: PackageInfo[] = [
        { name: '@test/pkg-a', version: '1.0.0', meta: null, readme: null },
      ];

      const markdown = generateMarkdown(packages, []);

      expect(markdown).not.toContain('## Framework Documentation');
      expect(markdown).not.toContain('## Package Documentation');
    });

    it('should include all root docs in order', () => {
      const packages: PackageInfo[] = [
        { name: '@test/pkg-a', version: '1.0.0', meta: null, readme: null },
      ];

      const rootDocs: RootDocInfo[] = [
        {
          filename: 'CLAUDE.md',
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
        { name: '@test/pkg-a', version: '1.0.0', meta: null, readme: null },
      ];

      const rootDocs: RootDocInfo[] = [
        {
          filename: 'CLAUDE.md',
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
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Framework Docs');

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
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Framework Docs');

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
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Framework Docs');

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
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Framework Docs');

      process.chdir(tempDir);
      const root = detectMonorepoRoot();

      expect(root).toBeNull();
    });

    it('should return null when missing CLAUDE.md', () => {
      // Missing CLAUDE.md
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
