/**
 * An app themes the shell through custom properties instead of restyling its
 * internal classes: the page background, themed thin scrollbars, the shell
 * title's font family, and a right rail that never pads wider than its track.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd().endsWith('packages/smrt-svelte')
  ? process.cwd()
  : join(process.cwd(), 'packages/smrt-svelte');
const shellDir = join(packageRoot, 'src/components/workspace/admin-shell');
const shell = readFileSync(join(shellDir, 'AdminShell.svelte'), 'utf8');
const title = readFileSync(join(shellDir, 'ShellTitle.svelte'), 'utf8');

function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n  }', start));
}

describe('AdminShell theme hooks', () => {
  it('reads its page background from --smrt-admin-shell-background', () => {
    expect(ruleBody(shell, '.smrt-admin-shell')).toMatch(
      /background:\s*var\(--smrt-admin-shell-background,\s*var\(--smrt-color-surface\)\)/,
    );
  });

  it('themes thin scrollbars from tokens, overridable per app', () => {
    const root = ruleBody(shell, '.smrt-admin-shell');
    expect(root).toMatch(
      /scrollbar-color:[^;]*--smrt-admin-shell-scrollbar-thumb[^;]*--smrt-admin-shell-scrollbar-track/s,
    );
    expect(ruleBody(shell, '.smrt-admin-shell :global(*)')).toMatch(
      /scrollbar-width:\s*thin/,
    );
    expect(shell).toContain('--smrt-admin-shell-scrollbar-thumb-hover');
  });

  it('keeps a right rail collapsed to 0 from painting padding', () => {
    expect(
      ruleBody(shell, '.smrt-admin-shell__edge--right .smrt-admin-shell__rail'),
    ).toMatch(
      /padding-inline:\s*min\(\s*var\(--smrt-spacing-3\),\s*calc\(var\(--smrt-admin-shell-right-collapsed\) \/ 4\)/,
    );
  });

  it('lets an app set the shell title font family', () => {
    expect(ruleBody(title, '.smrt-shell-title')).toMatch(
      /font-family:\s*var\(--smrt-shell-title-font-family/,
    );
  });
});
