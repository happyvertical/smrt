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
      // `src/engine` is the standalone engine; a route may be named `engine`.
      if (name === 'node_modules' || (name === 'engine' && dir === root))
        continue;
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
      expect(
        /ownerOf\(|createShellMcpServer\(|onboardingRoutes\./.test(t),
        f,
      ).toBe(true);
  });

  it('every onboarding route is a one-line delegate, and each handler checks the owner', () => {
    const routes = files.filter(([f]) =>
      /^routes\/api\/shell\/onboarding\/(.*\/)?\+server\.ts$/.test(f),
    );
    expect(routes.length).toBe(6);
    for (const [f, t] of routes)
      expect(t, f).toMatch(
        /onboardingRoutes\.(state|connect|engine|chatgptState|chatgpt|complete|skip)\(/,
      );
    const impl = files.find(([f]) => f === 'lib/server/onboarding.ts');
    expect((impl?.[1].match(/await ownerOf\(event\)/g) ?? []).length).toBe(7);
  });

  it('the agent CLI engine never decides approvals or sets `approved`', () => {
    for (const [f, t] of files.filter(
      ([f]) =>
        f.startsWith('lib/server/agent-cli/') ||
        f === 'lib/server/assistant/agent-turn.ts' ||
        f === 'lib/server/assistant/model.ts' ||
        f === 'lib/server/chatgpt.ts' ||
        f === 'lib/server/onboarding.ts',
    ))
      expect(t, f).not.toMatch(
        /decideApproval|approved\s*:\s*true|'approval_decide'/,
      );
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

  it('only host.ts turns on `autoApprove`, and only for a draft copy', () => {
    const offenders = files
      .filter(
        ([f, text]) =>
          f !== 'lib/server/host.ts' && /autoApprove\s*:\s*true/.test(text),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
    const host = files.find(([f]) => f === 'lib/server/host.ts')?.[1] ?? '';
    // exactly one site, inside the function that opens a draft's host
    expect(host.match(/autoApprove\s*:\s*true/g)?.length).toBe(1);
    expect(host).toMatch(
      /export function openDraftHost[\s\S]{0,400}autoApprove: true/,
    );
  });

  it('no request path reaches a host without naming the copy (hostFor, never getHost)', () => {
    const named = [
      'lib/server/builder.ts',
      'lib/server/catalog.ts',
      'lib/objects/App.ts',
      'routes/api/shell/describe/+server.ts',
      'routes/api/shell/history/+server.ts',
      'routes/api/shell/undo/+server.ts',
      'routes/api/shell/undo-to/+server.ts',
      'routes/api/shell/records/[model]/+server.ts',
      'routes/api/shell/records/[model]/[id]/+server.ts',
      'routes/api/app/[...path]/+server.ts',
    ];
    for (const f of named) {
      const text = files.find(([name]) => name === f)?.[1];
      expect(text, f).toBeTruthy();
      expect(text, f).not.toMatch(/\bgetHost\(/);
    }
    // and each of the routes reads the copy from the request
    for (const f of named.filter((n) => n.startsWith('routes/')))
      expect(files.find(([name]) => name === f)?.[1], f).toMatch(
        /targetOf\(|headerTargetOf\(|requestRecordDelete/,
      );
  });

  it('the assistant never decides approvals or reads a login', () => {
    for (const [f, t] of files.filter(([f]) =>
      f.startsWith('lib/server/assistant/'),
    )) {
      if (f === 'lib/server/assistant/turn.ts')
        // only the deny list may name it
        expect(t.match(/'approval_decide'/g)?.length ?? 0).toBe(1);
      else expect(t, f).not.toMatch(/'approval_decide'|decideApproval/);
    }
  });
  it('new engine catalog adapters keep the owner, target and approval boundaries', () => {
    const adapter =
      files.find(([f]) => f === 'lib/server/engine-tools.ts')?.[1] ?? '';
    expect(adapter).toMatch(/await assertOwner\(\)/);
    expect(adapter).toMatch(/hostFor\(scope.records\)/);
    expect(adapter).toMatch(/runCommand\(/);
    expect(adapter).not.toMatch(/\.execute\(|approved\s*:/);
    for (const name of [
      'setcalculation',
      'definereport',
      'renamereport',
      'removereport',
      'loadrecords',
      'extractmodel',
      'mergerecords',
      'runreport',
    ])
      expect(adapter).toContain(`app_${name}`);
  });
});
