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
  readAgentModuleDocs,
  readPackageAgentDoc,
  resolveAgentModuleDocPaths,
} from './knowledge.js';

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

// Exercise the public knowledge entry, rather than core compatibility reexports.
describe('linked module documentation', () => {
  it('keeps local Markdown links in document order and ignores non-module targets', () => {
    mkdirSync(join(root, 'agents'));
    writeFileSync(join(root, 'agents', 'one.md'), 'First module');
    writeFileSync(join(root, 'agents', 'two.md'), 'Second module');
    writeFileSync(join(root, 'AGENTS.md'), 'Canonical');
    mkdirSync(join(root, 'directory.md'));
    const doc =
      '[Second](agents/two.md#details "Title") [First](agents/one.md) [Duplicate](agents/two.md) [Missing](absent.md) [Parent](../outside.md) [Remote](https://example.com/a.md) [Self](AGENTS.md) [Directory](directory.md)';
    expect(resolveAgentModuleDocPaths(root, doc)).toEqual([
      'agents/two.md',
      'agents/one.md',
    ]);
    expect(readAgentModuleDocs(root, doc)).toEqual([
      { path: 'agents/two.md', module: 'two', content: 'Second module' },
      { path: 'agents/one.md', module: 'one', content: 'First module' },
    ]);
  });
  it('returns no authored module docs when the package has none', () => {
    expect(resolveAgentModuleDocPaths(root, undefined)).toEqual([]);
    expect(readPackageAgentDoc(root)).toMatchObject({
      source: null,
      content: null,
    });
  });
});
