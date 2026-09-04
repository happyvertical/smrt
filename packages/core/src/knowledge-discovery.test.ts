import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverScopedPackageDirectories,
  readPackageAgentDoc,
} from './knowledge-discovery.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-discovery-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lightweight scope discovery', () => {
  it('enumerates links once per scope without traversing their dependency graph', () => {
    const scope = join(root, 'node_modules', '@happyvertical');
    const store = join(root, 'store');
    mkdirSync(scope, { recursive: true });
    mkdirSync(store);
    // A cycle would make recursive discovery unsafe. No manifest is needed.
    symlinkSync(store, join(store, 'cycle'), 'dir');
    symlinkSync(store, join(scope, 'smrt-a'), 'dir');
    symlinkSync(store, join(scope, 'alias'), 'dir');
    symlinkSync(join(root, 'missing'), join(scope, 'dangling'), 'dir');
    writeFileSync(join(scope, 'not-a-package'), 'plain file');
    const found = discoverScopedPackageDirectories([
      scope,
      scope,
      join(root, 'absent'),
    ]);
    expect(found).toHaveLength(2);
    expect(found.map((entry) => entry.name).sort()).toEqual([
      'alias',
      'smrt-a',
    ]);
    expect(found.every((entry) => entry.realDirectory === store)).toBe(true);
    expect(found.every((entry) => entry.directory.startsWith(scope))).toBe(
      true,
    );
  });
});

describe('authored document discovery', () => {
  it('prefers even an empty AGENTS file and optionally inspects the adapter', () => {
    writeFileSync(join(root, 'AGENTS.md'), '');
    writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\n');
    expect(readPackageAgentDoc(root)).toMatchObject({
      source: 'AGENTS.md',
      content: '',
    });
    expect(
      readPackageAgentDoc(root, { inspectAdapter: true }).hasClaudeShim,
    ).toBe(true);
  });
  it('uses legacy documentation but never emits an orphan shim as expertise', () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'Legacy expertise');
    expect(readPackageAgentDoc(root)).toMatchObject({
      source: 'CLAUDE.md',
      content: 'Legacy expertise',
    });
    writeFileSync(join(root, 'CLAUDE.md'), ' @AGENTS.md\n');
    expect(readPackageAgentDoc(root)).toMatchObject({
      source: null,
      content: null,
      hasClaudeShim: true,
    });
  });
  it('does not read an irrelevant adapter when canonical docs exist', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'Canonical');
    mkdirSync(join(root, 'CLAUDE.md'));
    expect(readPackageAgentDoc(root).content).toBe('Canonical');
    expect(() => readPackageAgentDoc(root, { inspectAdapter: true })).toThrow();
  });
});
