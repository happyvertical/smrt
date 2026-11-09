import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, '..');
const read = (path: string) => readFileSync(resolve(packageDir, path), 'utf8');

/** Names listed in `export { ... } from '<prefix>...'` statements of a file. */
function exportedNames(file: string, prefixes?: string[]): Set<string> {
  const names = new Set<string>();
  const statement = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
  for (const match of read(file).matchAll(statement)) {
    if (prefixes && !prefixes.some((p) => (match[2] as string).startsWith(p))) {
      continue;
    }
    for (const item of (match[1] as string).split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/, '')
        .split(' as ')
        .at(-1);
      if (name) names.add(name);
    }
  }
  return names;
}

const sources = (dir: string): string[] =>
  readdirSync(resolve(srcDir, dir))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join('src', dir, name));

const DEFINITION =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_]+)/;

/** The doc comment directly above each exported declaration, by name. */
function docs(files: string[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      const name = DEFINITION.exec(line)?.[1];
      if (name === undefined) return;
      let end = index - 1;
      while (end >= 0 && lines[end]?.trim() === '') end--;
      let comment = '';
      if (end >= 0 && lines[end]?.trim().endsWith('*/')) {
        let start = end;
        while (start > 0 && !lines[start]?.includes('/*')) start--;
        comment = lines.slice(start, end + 1).join('\n');
      }
      byName.set(name, [...(byName.get(name) ?? []), comment]);
    });
  }
  return byName;
}

describe('contracts (b) and (c) are marked experimental', () => {
  const contractNames = new Set([
    ...exportedNames('src/index.ts', ['./rendezvous/', './credentials/']),
    ...exportedNames('src/reference/index.ts'),
  ]);
  const documented = docs([
    ...sources('rendezvous'),
    ...sources('credentials'),
    'src/errors.ts',
  ]);

  it('finds a meaningful number of exported names', () => {
    expect(contractNames.size).toBeGreaterThan(100);
  });

  it('puts an @experimental TSDoc tag on every exported type and function', () => {
    const untagged: string[] = [];
    for (const name of contractNames) {
      const comments = documented.get(name);
      if (comments === undefined) {
        untagged.push(`${name} (definition not found)`);
      } else if (!comments.every((c) => /@experimental\b/.test(c))) {
        untagged.push(name);
      }
    }
    expect(untagged.sort()).toEqual([]);
  });

  it('tags the error-code unions of (b) and (c) but not contract (a)', () => {
    const all = docs(['src/errors.ts']);
    expect(all.get('RendezvousErrorCode')?.[0]).toMatch(/@experimental/);
    expect(all.get('CredentialErrorCode')?.[0]).toMatch(/@experimental/);
    expect(all.get('InstallErrorCode')?.[0] ?? '').not.toMatch(/@experimental/);
    const stable = docs(sources('install'));
    expect(stable.get('locateInstallation')?.[0] ?? '').not.toMatch(
      /@experimental/,
    );
  });

  it('says so in the README, in both contract sections, and in the package description', () => {
    const readme = read('README.md');
    expect(readme).toMatch(
      /Contracts \*\*\(b\) supervisor rendezvous\*\* and \*\*\(c\) native\s+> credential handoff are EXPERIMENTAL/,
    );
    const rendezvous = readme.indexOf('### Supervisor rendezvous');
    expect(readme.slice(rendezvous, rendezvous + 400)).toContain(
      'EXPERIMENTAL (contract b)',
    );
    const handoff = readme.indexOf('### Native credential handoff');
    expect(readme.slice(handoff, handoff + 400)).toContain(
      'EXPERIMENTAL (contract c)',
    );
    expect(JSON.parse(read('package.json')).description).toMatch(
      /EXPERIMENTAL/,
    );
  });
});
