import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function testSources(dir: string): string {
  const parts: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) parts.push(testSources(path));
    else if (name.endsWith('.test.ts') && name !== 'threat-table.test.ts') {
      parts.push(readFileSync(path, 'utf8'));
    }
  }
  return parts.join('\n');
}

describe('the bundler threat table in the README', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');
  const section = readme.slice(
    readme.indexOf('### Threat model and closing tests'),
  );
  const rows = section.split('\n').filter((line) => /^\| B\d+ \|/.test(line));

  it('has the fourteen documented threats', () => {
    expect(rows.map((row) => row.split(' | ')[0])).toEqual(
      Array.from({ length: 14 }, (_, i) => `| B${i + 1}`),
    );
  });

  it('names a test that exists for every closing-test title', () => {
    const sources = testSources(join(packageRoot, 'src'));
    const missing: string[] = [];
    for (const row of rows) {
      const closing = row.split(' | ').at(-1) ?? '';
      const titles = [...closing.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      expect(titles.length, row.slice(0, 8)).toBeGreaterThan(0);
      for (const title of titles as string[]) {
        const quoted = [`'${title}'`, `"${title}"`, `\`${title}\``];
        if (!quoted.some((candidate) => sources.includes(candidate))) {
          missing.push(`${row.slice(0, 6).trim()} ${title}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
