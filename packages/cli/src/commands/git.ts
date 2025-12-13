/**
 * Git Commands
 *
 * JSON-aware git merge driver for SMRT data files
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CLICommand } from '../cli-generator.js';

/**
 * Default patterns for SMRT data files
 */
const DEFAULT_DATA_PATTERNS = ['data/*.json', '*.data.json'];

/**
 * Merge two arrays of objects by ID
 *
 * Logic:
 * - Union of all objects from both arrays
 * - When same ID exists in both, newer `updated_at` wins
 * - Deduplicate by `id` field
 * - Preserve `_meta_type` for STI support
 * - Sort by `created_at` (ascending) or `id` for consistent ordering
 */
export function mergeArraysByKey(
  base: any[],
  ours: any[],
  theirs: any[],
  keyField: string = 'id',
): any[] {
  const merged = new Map<string, any>();

  // Helper to get key from object
  const getKey = (obj: any): string | null => {
    if (!obj || typeof obj !== 'object') return null;
    return obj[keyField] ?? obj.slug ?? null;
  };

  // Helper to get timestamp for conflict resolution
  const getTimestamp = (obj: any): number => {
    if (obj.updated_at) {
      return new Date(obj.updated_at).getTime();
    }
    if (obj.created_at) {
      return new Date(obj.created_at).getTime();
    }
    return 0;
  };

  // Add base objects first
  for (const obj of base) {
    const key = getKey(obj);
    if (key) {
      merged.set(key, { ...obj, _source: 'base' });
    }
  }

  // Process "ours" - overwrites base if same ID
  for (const obj of ours) {
    const key = getKey(obj);
    if (key) {
      const existing = merged.get(key);
      if (!existing || existing._source === 'base') {
        // New in ours or replacing base
        merged.set(key, { ...obj, _source: 'ours' });
      }
    }
  }

  // Process "theirs" - conflict resolution by timestamp
  for (const obj of theirs) {
    const key = getKey(obj);
    if (key) {
      const existing = merged.get(key);
      if (!existing) {
        // New in theirs only
        merged.set(key, { ...obj, _source: 'theirs' });
      } else if (existing._source === 'base') {
        // Theirs modified, ours didn't - take theirs
        merged.set(key, { ...obj, _source: 'theirs' });
      } else if (existing._source === 'ours') {
        // Both modified - resolve by timestamp
        const oursTime = getTimestamp(existing);
        const theirsTime = getTimestamp(obj);

        if (theirsTime > oursTime) {
          // Theirs is newer
          merged.set(key, { ...obj, _source: 'theirs' });
        }
        // Otherwise keep ours (existing)
      }
    }
  }

  // Remove _source markers and convert to array
  const result = Array.from(merged.values()).map((obj) => {
    const { _source, ...rest } = obj;
    return rest;
  });

  // Sort by created_at (ascending) for consistent ordering
  result.sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    // Fallback to ID comparison for stable sort
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return result;
}

/**
 * Merge two JSON objects (non-array case)
 *
 * For nested objects, recursively merge.
 * For arrays of objects with IDs, use array merge logic.
 * For other values, prefer ours over theirs.
 */
export function mergeObjects(base: any, ours: any, theirs: any): any {
  // Handle arrays at root level
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const baseArray = Array.isArray(base) ? base : [];
    return mergeArraysByKey(baseArray, ours, theirs);
  }

  // Handle non-object types
  if (typeof ours !== 'object' || ours === null) {
    return ours;
  }
  if (typeof theirs !== 'object' || theirs === null) {
    return ours;
  }

  const result: any = {};
  const allKeys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  for (const key of allKeys) {
    const baseVal = base?.[key];
    const oursVal = ours[key];
    const theirsVal = theirs[key];

    // Check if this key holds an array of objects (common SMRT pattern)
    if (Array.isArray(oursVal) || Array.isArray(theirsVal)) {
      const baseArray = Array.isArray(baseVal) ? baseVal : [];
      const oursArray = Array.isArray(oursVal) ? oursVal : [];
      const theirsArray = Array.isArray(theirsVal) ? theirsVal : [];

      // Check if array contains objects with IDs
      const hasIds = [...oursArray, ...theirsArray].some(
        (item) =>
          item && typeof item === 'object' && ('id' in item || 'slug' in item),
      );

      if (hasIds) {
        result[key] = mergeArraysByKey(baseArray, oursArray, theirsArray);
      } else {
        // Simple array - prefer ours, fallback to theirs, then base
        result[key] = oursVal ?? theirsVal ?? baseVal;
      }
    } else if (
      typeof oursVal === 'object' &&
      oursVal !== null &&
      typeof theirsVal === 'object' &&
      theirsVal !== null
    ) {
      // Nested object - recursive merge
      result[key] = mergeObjects(baseVal, oursVal, theirsVal);
    } else if (oursVal !== undefined) {
      // Prefer ours
      result[key] = oursVal;
    } else if (theirsVal !== undefined) {
      // Fallback to theirs
      result[key] = theirsVal;
    } else if (baseVal !== undefined) {
      // Final fallback to base (key exists only in base)
      result[key] = baseVal;
    }
  }

  return result;
}

/**
 * Check if running inside a git repository
 */
function isGitRepository(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory
 */
function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Git commands for SMRT
 */
export const gitCommands: Record<string, CLICommand> = {
  'git:init': {
    name: 'git:init',
    description: 'Configure JSON-aware git merge driver for SMRT data files',
    aliases: ['git-init', 'setup-git'],
    args: [],
    options: {
      patterns: {
        type: 'string',
        description:
          'Comma-separated file patterns to use merge driver (default: data/*.json)',
        default: DEFAULT_DATA_PATTERNS.join(','),
      },
      global: {
        type: 'boolean',
        description: 'Configure merge driver globally instead of locally',
        default: false,
      },
      force: {
        type: 'boolean',
        description: 'Overwrite existing configuration',
        default: false,
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔧 Configuring SMRT JSON merge driver...\n');

      // Check if in a git repository
      if (!isGitRepository()) {
        console.error('❌ Not a git repository. Run `git init` first.');
        process.exit(1);
      }

      const gitRoot = getGitRoot();
      const patterns = options.patterns
        .split(',')
        .map((p: string) => p.trim())
        .filter(Boolean);

      const configScope = options.global ? '--global' : '--local';

      // Track changes
      const changes: string[] = [];

      // 1. Configure git merge driver
      console.log('📝 Configuring git merge driver...');

      try {
        // Set the merge driver name
        execSync(
          `git config ${configScope} merge.smrt-json.name "SMRT JSON merge driver"`,
          { stdio: 'inherit' },
        );

        // Set the merge driver command
        // %O = base, %A = ours (current), %B = theirs (incoming)
        execSync(
          `git config ${configScope} merge.smrt-json.driver "npx smrt merge-json %O %A %B"`,
          { stdio: 'inherit' },
        );

        changes.push(
          `Git merge driver configured (${options.global ? 'global' : 'local'})`,
        );
        console.log(`   ✓ Merge driver "smrt-json" configured`);
      } catch (error) {
        console.error('❌ Failed to configure git merge driver');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
        process.exit(1);
      }

      // 2. Update .gitattributes
      console.log('\n📄 Updating .gitattributes...');

      const gitattributesPath = resolve(gitRoot, '.gitattributes');
      let gitattributesContent = '';

      if (existsSync(gitattributesPath)) {
        gitattributesContent = readFileSync(gitattributesPath, 'utf-8');
      }

      // Check for existing SMRT patterns
      const existingPatterns: string[] = [];
      const lines = gitattributesContent.split('\n');

      for (const line of lines) {
        if (line.includes('merge=smrt-json')) {
          const pattern = line.split(/\s+/)[0];
          if (pattern) {
            existingPatterns.push(pattern);
          }
        }
      }

      // Add new patterns
      const newPatterns: string[] = [];
      for (const pattern of patterns) {
        if (!existingPatterns.includes(pattern)) {
          newPatterns.push(pattern);
        }
      }

      if (newPatterns.length > 0 || options.force) {
        // Build new content
        let newContent = gitattributesContent;

        // Remove trailing whitespace and ensure newline
        newContent = newContent.trimEnd();
        if (newContent && !newContent.endsWith('\n')) {
          newContent += '\n';
        }

        // Add SMRT section if not present
        if (!gitattributesContent.includes('# SMRT JSON merge driver')) {
          if (newContent) {
            newContent += '\n';
          }
          newContent += '# SMRT JSON merge driver\n';
          newContent += '# Auto-merges JSON data files to prevent conflicts\n';
        }

        // Add new patterns
        for (const pattern of newPatterns) {
          newContent += `${pattern} merge=smrt-json\n`;
          console.log(`   ✓ Added pattern: ${pattern}`);
        }

        if (existingPatterns.length > 0 && newPatterns.length === 0) {
          console.log(
            `   ℹ️  Patterns already configured: ${existingPatterns.join(', ')}`,
          );
        }

        writeFileSync(gitattributesPath, newContent);
        changes.push('.gitattributes updated');
      } else {
        console.log(`   ℹ️  All patterns already configured`);
      }

      // 3. Summary
      console.log('\n✅ SMRT JSON merge driver configured!\n');

      if (changes.length > 0) {
        console.log('Changes made:');
        for (const change of changes) {
          console.log(`   • ${change}`);
        }
        console.log();
      }

      console.log('📋 How it works:');
      console.log(
        '   When git encounters a merge conflict in a JSON file matching',
      );
      console.log('   the configured patterns, it will:');
      console.log('   1. Parse both versions as JSON');
      console.log('   2. Merge arrays by ID (union, deduplicated)');
      console.log('   3. Resolve conflicts using updated_at timestamp');
      console.log('   4. Preserve _meta_type for STI support\n');

      console.log('📁 Configured patterns:');
      for (const pattern of [...existingPatterns, ...newPatterns]) {
        console.log(`   • ${pattern}`);
      }
      console.log();

      console.log('💡 Usage:');
      console.log('   • JSON files matching these patterns will auto-merge');
      console.log('   • Commit .gitattributes to share with your team');
      console.log('   • Team members need to run `smrt git:init` once\n');

      console.log('🔍 Test the merge driver:');
      console.log('   smrt merge-json <base> <ours> <theirs>\n');
    },
  },

  'merge-json': {
    name: 'merge-json',
    description: 'JSON-aware merge driver for SMRT data files (called by git)',
    args: ['base', 'ours', 'theirs'],
    options: {
      verbose: {
        type: 'boolean',
        description: 'Show detailed merge information',
        default: false,
        short: 'v',
      },
      'dry-run': {
        type: 'boolean',
        description: 'Show merged result without modifying files',
        default: false,
      },
    },
    handler: async (args: string[], options: any) => {
      const [basePath, oursPath, theirsPath] = args;

      if (!basePath || !oursPath || !theirsPath) {
        console.error('Usage: smrt merge-json <base> <ours> <theirs>');
        console.error(
          '\nThis command is typically called by git during a merge.',
        );
        console.error('To set up the merge driver, run: smrt git:init');
        process.exit(1);
      }

      if (options.verbose) {
        console.error('[smrt merge-json] Starting merge...');
        console.error(`  Base:   ${basePath}`);
        console.error(`  Ours:   ${oursPath}`);
        console.error(`  Theirs: ${theirsPath}`);
      }

      try {
        // Read all three files
        let base: any = {};
        let ours: any = {};
        let theirs: any = {};

        // Base might not exist for new files
        if (existsSync(basePath)) {
          const baseContent = readFileSync(basePath, 'utf-8');
          if (baseContent.trim()) {
            base = JSON.parse(baseContent);
          }
        }

        if (!existsSync(oursPath)) {
          console.error(`Error: "ours" file not found: ${oursPath}`);
          process.exit(1);
        }
        const oursContent = readFileSync(oursPath, 'utf-8');
        if (oursContent.trim()) {
          ours = JSON.parse(oursContent);
        }

        if (!existsSync(theirsPath)) {
          console.error(`Error: "theirs" file not found: ${theirsPath}`);
          process.exit(1);
        }
        const theirsContent = readFileSync(theirsPath, 'utf-8');
        if (theirsContent.trim()) {
          theirs = JSON.parse(theirsContent);
        }

        if (options.verbose) {
          console.error(`  Base objects: ${countObjects(base)}`);
          console.error(`  Ours objects: ${countObjects(ours)}`);
          console.error(`  Theirs objects: ${countObjects(theirs)}`);
        }

        // Perform merge
        const merged = mergeObjects(base, ours, theirs);

        if (options.verbose) {
          console.error(`  Merged objects: ${countObjects(merged)}`);
        }

        // Format output (preserve pretty-printing)
        const output = JSON.stringify(merged, null, 2);

        if (options.dryRun) {
          // Dry run - output to stdout
          console.log(output);
        } else {
          // Write merged result to "ours" path (git convention)
          writeFileSync(oursPath, `${output}\n`);

          if (options.verbose) {
            console.error(
              `[smrt merge-json] Merge complete. Written to: ${oursPath}`,
            );
          }
        }

        // Exit 0 = merge succeeded
        process.exit(0);
      } catch (error) {
        console.error('[smrt merge-json] Merge failed:');
        if (error instanceof Error) {
          console.error(`  ${error.message}`);
          if (error instanceof SyntaxError) {
            console.error('  One or more files contain invalid JSON.');
          }
        }
        // Exit 1 = merge failed, git will report conflict
        process.exit(1);
      }
    },
  },
};

/**
 * Helper to count objects in a structure
 */
function countObjects(data: any): number {
  if (Array.isArray(data)) {
    return data.length;
  }
  if (typeof data === 'object' && data !== null) {
    let count = 0;
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key])) {
        count += data[key].length;
      } else {
        count += 1;
      }
    }
    return count;
  }
  return 0;
}
