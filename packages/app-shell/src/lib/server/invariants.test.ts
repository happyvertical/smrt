// Source-level invariants that no behaviour test can show are not violated
// by a future edit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'engine') continue;
      walk(p, out);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name))
      out.push(p);
  }
  return out;
}
const files = walk(root).map(
  (p) => [relative(root, p), readFileSync(p, 'utf8')] as const,
);

describe('approval gate invariants', () => {
  it('only approvals.ts passes `approved: true` to the engine', () => {
    const offenders = files
      .filter(
        ([f, text]) =>
          !f.endsWith('lib/server/approvals.ts') &&
          /approved\s*:\s*true/.test(text),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('only approvals.ts calls decideApproval, and only Approval.decide uses it', () => {
    // server code only: the browser's `decideApproval` in lib/ui/api is just
    // the fetch wrapper for POST /api/shell/approvals/<id>
    const users = files
      .filter(
        ([f, t]) =>
          f.endsWith('.ts') &&
          !f.startsWith('lib/ui/') &&
          /decideApproval\s*\(/.test(t),
      )
      .map(([f]) => f)
      .sort();
    expect(users).toEqual([
      'lib/objects/Approval.ts',
      'lib/server/approvals.ts',
    ]);
  });

  it('request handlers never read an `approved` input', () => {
    const routes = files.filter(
      ([f]) => f.startsWith('routes/') && f.endsWith('+server.ts'),
    );
    expect(routes.length).toBeGreaterThan(5);
    for (const [f, t] of routes)
      expect(t, f).not.toMatch(/\.approved\b|get\(['"]approved/);
  });

  it('every hand-written route checks the session (ownerOf / owner policy)', () => {
    const custom = files.filter(
      ([f]) =>
        /^routes\/(api\/(app|events|shell)|mcp)\//.test(f) &&
        f.endsWith('+server.ts'),
    );
    expect(custom.length).toBeGreaterThanOrEqual(9);
    for (const [f, t] of custom)
      expect(/ownerOf\(|createShellMcpServer\(/.test(t), f).toBe(true);
  });

  it('every assistant route is a one-line delegate, and each handler checks the owner', () => {
    const routes = files.filter(([f]) =>
      /^routes\/api\/assistant\/.*\+server\.ts$/.test(f),
    );
    expect(routes.length).toBe(4);
    for (const [f, t] of routes)
      expect(t, f).toMatch(/assistantRoutes\.(status|threads|thread|turn)\(/);
    const impl = files.find(([f]) => f === 'lib/server/assistant/routes.ts');
    expect((impl?.[1].match(/await ownerOf\(event\)/g) ?? []).length).toBe(4);
  });

  it('the assistant never decides approvals or reads a login', () => {
    for (const [f, t] of files.filter(([f]) =>
      f.startsWith('lib/server/assistant/'),
    )) {
      if (f.endsWith('turn.ts'))
        // only the deny list may name it
        expect(t.match(/'approval_decide'/g)?.length ?? 0).toBe(1);
      else expect(t, f).not.toMatch(/'approval_decide'|decideApproval/);
    }
  });
});
