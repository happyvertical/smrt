/**
 * The sidebar content fade must not start when `data-motion` lands. That flag
 * is set after hydration; a rule that begins matching then would start a
 * fade-from-transparent on content already on screen (a dimmed sidebar after a
 * direct navigation). The animation is declared from first paint with a zero
 * duration and gains its duration only under `data-motion`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd().endsWith('packages/smrt-svelte')
  ? process.cwd()
  : join(process.cwd(), 'packages/smrt-svelte');
const source = readFileSync(
  join(packageRoot, 'src/components/workspace/admin-shell/AdminShell.svelte'),
  'utf8',
);

const rules = [
  ...source.matchAll(
    /([^{}]*tenant-stack:not\(\[hidden\]\)[^{}]*)\{([^}]*)\}/g,
  ),
];

describe('AdminShell sidebar content fade', () => {
  it('declares the animation without depending on data-motion', () => {
    const base = rules.find(([, sel]) => !sel.includes('[data-motion]'));
    expect(base).toBeDefined();
    expect(base?.[2]).toMatch(/animation:\s*smrt-admin-shell-content-in\s+0s/);
  });

  it('gives the animation its duration only under data-motion', () => {
    const motion = rules.find(([, sel]) => sel.includes('[data-motion]'));
    expect(motion).toBeDefined();
    expect(motion?.[2]).toMatch(
      /animation-duration:\s*var\(--smrt-duration-short2\)/,
    );
    expect(motion?.[2]).not.toMatch(/animation:\s/);
  });
});
