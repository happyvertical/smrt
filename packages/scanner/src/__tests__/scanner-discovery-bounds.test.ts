import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxcScanner } from '../scanner.js';

/**
 * Discovery must terminate and stay proportional to a project's own sources
 * when the scanner is pointed at an application root (#2275).
 *
 * Two settings are load-bearing and were both wrong:
 *
 * 1. `dot`. Without it a `**` cannot cross a dot segment, so
 *    `**\/node_modules/**` pruned `node_modules` at the root but nothing
 *    beneath `.svelte-kit/`, `.vercel/`, or any other dot directory. Those
 *    subtrees were walked in full and every entry then discarded, because the
 *    positive patterns could not match there either.
 * 2. `followSymbolicLinks`. A pnpm `node_modules` is a symlink graph with
 *    cycles rather than a tree, so a link-following walk reaches the same real
 *    directory once per path leading to it — and never finishes.
 *
 * The cyclic fixtures below hang forever on the old behaviour, which is the
 * failure this regression guards. An output assertion alone could not catch it:
 * the runaway traversal produced no extra matches, only unbounded work.
 */
describe('OxcScanner file discovery bounds', () => {
  let dir: string;

  function write(rel: string, source: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
  }

  function writeSmrtClass(rel: string, className: string): void {
    write(
      rel,
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt()\nexport class ${className} extends SmrtObject { name = ''; }\n`,
    );
  }

  /**
   * A pnpm-shaped store: each materialized package carries links to every
   * sibling, so descending into one package leads straight into the next and
   * the graph closes on itself exactly as a real store does.
   *
   * Branching is the point. A self-referential link is harmless — the kernel
   * stops resolving it after MAXSYMLINKS hops — but a clique multiplies into
   * `siblings ** MAXSYMLINKS` distinct paths to the same real directories,
   * which is unbounded in every practical sense.
   *
   * @param packageDir - Where the store materializes `<name>`, relative to the
   *   fixture root. Varying this is how the same graph gets tested both inside
   *   and outside a `node_modules` path.
   */
  function writeSymlinkClique(
    names: string[],
    packageDir: (name: string) => string,
  ): void {
    for (const name of names) {
      write(
        join(packageDir(name), 'package.json'),
        JSON.stringify({ name: `@happyvertical/${name}`, version: '1.0.0' }),
      );
      write(
        join(packageDir(name), 'index.ts'),
        `export const ${name.replaceAll('-', '_')} = 1;\n`,
      );
      mkdirSync(join(dir, packageDir(name), 'links'), { recursive: true });
    }
    for (const name of names) {
      for (const sibling of names.filter((other) => other !== name)) {
        symlinkSync(
          join(dir, packageDir(sibling)),
          join(dir, packageDir(name), 'links', sibling),
        );
      }
    }
  }

  const pnpmStorePath = (prefix: string) => (name: string) =>
    join(
      prefix,
      'node_modules',
      '.pnpm',
      `@happyvertical+${name}@1.0.0`,
      'node_modules',
      '@happyvertical',
      name,
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-scanner-bounds-'));
    writeSmrtClass('src/widget.ts', 'Widget');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prunes node_modules and dot directories even when a caller empties exclude', async () => {
    // `exclude` REPLACES the defaults, so a caller that narrows it used to
    // reopen `node_modules`; and `dot: true` alone would make generated and
    // tool state discoverable. Both prunes have to survive `exclude: []`.
    writeSmrtClass(
      'node_modules/@happyvertical/smrt-x/src/model.ts',
      'Vendored',
    );
    writeSmrtClass('.agent-scratch/checkout/src/ghost.ts', 'Ghost');
    writeSmrtClass('.svelte-kit/generated/shadow.ts', 'Shadow');
    writeSmrtClass('src/.hidden.ts', 'Hidden');

    const scanner = new OxcScanner({ cwd: dir, exclude: [] });
    const { resolved } = await scanner.scanAndResolve();

    expect(resolved.map((entry) => entry.className)).toEqual(['Widget']);
  });

  it('does not follow a symlinked directory back into itself', async () => {
    // The cheap, deterministic half of the symlink guard: the kernel stops a
    // self-referential link after MAXSYMLINKS, so the pre-fix walk terminated
    // here — with one copy of the same file per hop.
    symlinkSync(join(dir, 'src'), join(dir, 'src', 'loop'));

    const { results, resolved } = await new OxcScanner({
      cwd: dir,
    }).scanAndResolve();

    expect(results.fileCount).toBe(1);
    expect(resolved.map((entry) => entry.className)).toEqual(['Widget']);
  });

  it('rewrites absolute include patterns so the dot prune cannot swallow them', async () => {
    // A checkout under `~/.worktrees` or `~/.cache` matched by an absolute
    // pattern would otherwise hand `**\/.*\/**` its own ancestors and discover
    // nothing at all, silently.
    const nested = join(dir, '.worktrees', 'app');
    mkdirSync(join(nested, 'src'), { recursive: true });
    writeSmrtClass('.worktrees/app/src/nested.ts', 'Nested');

    const { resolved } = await new OxcScanner({
      cwd: nested,
      include: [`${nested}/**/*.ts`],
    }).scanAndResolve();

    expect(resolved.map((entry) => entry.className)).toEqual(['Nested']);
  });

  it('terminates on a cyclic pnpm store beneath a dot directory', async () => {
    writeSymlinkClique(
      ['smrt-a', 'smrt-b', 'smrt-c', 'smrt-d'],
      pnpmStorePath('.agent-scratch/checkout'),
    );

    const scanner = new OxcScanner({ cwd: dir });
    const { results, resolved } = await scanner.scanAndResolve();

    expect(resolved.map((entry) => entry.className)).toEqual(['Widget']);
    expect(results.fileCount).toBe(1);
    // Bounded deliberately: a regression here does not fail, it never returns,
    // and an unbounded wait would take the rest of the suite down with it.
  }, 5000);

  it('terminates on a cyclic symlink graph outside node_modules', async () => {
    // Termination must not depend on a path segment being named
    // `node_modules`: a vendored checkout, a workspace link, or an agent
    // worktree can close the same loop anywhere in the tree.
    writeSymlinkClique(['dep-a', 'dep-b', 'dep-c', 'dep-d'], (name) =>
      join('vendor', name),
    );

    const scanner = new OxcScanner({ cwd: dir });
    const { resolved } = await scanner.scanAndResolve();

    expect(resolved.map((entry) => entry.className)).toEqual(['Widget']);
  }, 5000);

  it('still reaches symlinked sources when a caller opts in', async () => {
    // Link following is opt-in rather than removed: a project that really does
    // keep sources behind a link can ask for them, and accepts the cost.
    mkdirSync(join(dir, 'external'), { recursive: true });
    writeSmrtClass('external/models/linked.ts', 'Linked');
    symlinkSync(join(dir, 'external', 'models'), join(dir, 'src', 'linked'));

    const strict = await new OxcScanner({
      cwd: join(dir, 'src'),
    }).scanAndResolve();
    expect(strict.resolved.map((entry) => entry.className)).toEqual(['Widget']);

    const permissive = await new OxcScanner({
      cwd: join(dir, 'src'),
      followSymbolicLinks: true,
    }).scanAndResolve();
    expect(permissive.resolved.map((entry) => entry.className).sort()).toEqual([
      'Linked',
      'Widget',
    ]);
  });
});
