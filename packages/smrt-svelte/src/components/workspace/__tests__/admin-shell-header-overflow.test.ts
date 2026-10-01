/**
 * The header row hosts actions that open menus (a notifications bell, an
 * account menu). Its overflow must clip sideways only, or every dropdown
 * opened from it is cut off at the header's bottom edge.
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

function ruleBody(selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('}', start));
}

describe('AdminShell header overflow', () => {
  it('lets header menus drop below the header row', () => {
    const header = ruleBody('.smrt-admin-shell__header');
    expect(header).not.toMatch(/(^|\s)overflow:\s*hidden/);
    expect(header).toMatch(/overflow-x:\s*clip/);
    expect(header).toMatch(/overflow-y:\s*visible/);
  });
});
