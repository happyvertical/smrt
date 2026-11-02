import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #3618: `import-workspace-module` pulls node:fs/path/url into whatever
 * statically imports it. The fields root entry must stay browser-safe, so the
 * helper may only be reached through a dynamic `import()` at its call sites.
 */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.ts$/.test(entry.name) &&
      !/\.(test|spec)\.ts$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

describe('fields root entry browser safety (#3618)', () => {
  it('never statically imports import-workspace-module', () => {
    const staticImport =
      /^\s*(?:import|export)\s[^;]*?from\s*['"][^'"]*import-workspace-module['"]/m;
    const offenders = listSourceFiles(__dirname).filter((file) =>
      staticImport.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('still reaches the helper through dynamic import at both call sites', () => {
    for (const file of ['field-policy-resolver.ts', 'usage-schedules.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source).toMatch(
        /await import\(\s*'@happyvertical\/smrt-core\/utils\/import-workspace-module'/,
      );
    }
  });
});
