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

  it('only approvals.ts and Approval.decide call decideApproval', () => {
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

  it('decideApproval has exactly two callers: Approval.decide and the owner-apply path', () => {
    const approvals =
      files.find(([f]) => f === 'lib/server/approvals.ts')?.[1] ?? '';
    // the definition plus the one call inside applyOwnBatch
    expect(approvals.match(/decideApproval\s*\(/g)?.length).toBe(2);
    expect(approvals).toMatch(
      /export async function applyOwnBatch[\s\S]*await assertOwner\(\)[\s\S]*typeof expect !== 'string'[\s\S]*requestApply\(expect, owner\.id, opts\)[\s\S]*decideApproval\(pending\.approvalId, true, owner\)/,
    );
  });

  it('only the owner session route POST /api/shell/changes/apply uses applyOwnBatch', () => {
    // never a tool, the assistant, /mcp or the generated REST: none can apply
    const users = files
      .filter(
        ([f, t]) =>
          f !== 'lib/server/approvals.ts' &&
          /applyOwnBatch\s*\(|\{[^}]*\bapplyOwnBatch\b[^}]*\}\s*from/.test(t),
      )
      .map(([f]) => f);
    // test-support.ts is the test harness (it imports vitest); no runtime path imports it
    expect(users.filter((f) => f !== 'lib/server/test-support.ts')).toEqual([
      'routes/api/shell/changes/apply/+server.ts',
    ]);
    const route = files.find(
      ([f]) => f === 'routes/api/shell/changes/apply/+server.ts',
    )?.[1];
    expect(route).toMatch(/await ownerOf\(event\)/);
    expect(route).toMatch(
      /runAs\(owner, \(\) =>\s*applyOwnBatch\(body\.expect/,
    );
  });

  it('the checks pipeline can only read and store check results: it cannot apply, approve or edit a card', () => {
    const strip = (t: string) => t.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    const sched = strip(
      files.find(([f]) => f === 'lib/server/check-scheduler.ts')?.[1] ?? '',
    );
    // pure plumbing: imports nothing, so it can reach nothing
    expect(sched).not.toMatch(/^\s*import\s/m);
    expect(sched).not.toMatch(/approved|apply|publish|decideApproval/i);
    const changes = strip(
      files.find(([f]) => f === 'lib/server/changes.ts')?.[1] ?? '',
    );
    const job = changes.slice(
      changes.indexOf('async function runChecksJob'),
      changes.indexOf('let scheduler'),
    );
    expect(job.length).toBeGreaterThan(200);
    expect(job).not.toMatch(
      /approved|requestApply|applyApproved|publishApproved|requestApproval|decideApproval|publishDraft|\.execute\(|\.status\s*=[^=]|\.revision\s*=[^=]|\.commands\s*=[^=]/,
    );
    // the review hook is registered only through setAfterChecks, by the review
    // module alone; nothing in a tool, /mcp, the assistant or App can reach it
    const users = files
      .filter(([, t]) => /\b(setAfterChecks|configureChecks)\b/.test(strip(t)))
      .map(([f]) => f);
    expect(users.sort()).toEqual([
      'lib/server/change-review.ts',
      'lib/server/changes.ts',
    ]);
  });

  it('"Remove those too" is an owner-session route over one service function', () => {
    const users = files
      .filter(([, t]) => /\bremoveDependentCards\b/.test(t))
      .map(([f]) => f);
    expect(users.sort()).toEqual([
      'lib/server/changes.ts',
      'routes/api/shell/changes/cards/[id]/remove-dependents/+server.ts',
    ]);
    const route =
      files.find(
        ([f]) =>
          f ===
          'routes/api/shell/changes/cards/[id]/remove-dependents/+server.ts',
      )?.[1] ?? '';
    expect(route).toMatch(/await ownerOf\(event\)/);
    expect(route).toMatch(/runAs\(owner, \(\) =>\s*removeDependentCards\(/);
    expect(route).not.toMatch(/approved/);
  });

  it('apply and undo are reachable only from their owner routes', () => {
    // changes.ts holds requestApply / applyApproved / undoOwnBatch; the
    // change engine (src/engine, outside this walk) holds undoBatch, which
    // acts on live. None may appear in a tool, /mcp, the assistant or App.
    const allowed: Record<string, string[]> = {
      'requestApply|applyApproved': [
        'lib/server/approvals.ts',
        'lib/server/changes.ts',
      ],
      undoOwnBatch: [
        'lib/server/changes.ts',
        'routes/api/shell/changes/undo/+server.ts',
      ],
      'undoBatch|createSqliteChangeEngine|SqliteChangeEngine': [
        'lib/server/changes.ts',
      ],
    };
    for (const [names, ok] of Object.entries(allowed)) {
      const re = new RegExp(`\\b(${names})\\b`);
      const users = files
        .filter(([, t]) => re.test(t.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
        .map(([f]) => f);
      expect(users.sort(), names).toEqual([...ok].sort());
    }
    const undo = files.find(
      ([f]) => f === 'routes/api/shell/changes/undo/+server.ts',
    )?.[1];
    expect(undo).toMatch(/await ownerOf\(event\)/);
    const changes =
      files.find(([f]) => f === 'lib/server/changes.ts')?.[1] ?? '';
    expect(changes).not.toMatch(/approved\s*:\s*true/);
    for (const f of [
      'lib/server/catalog.ts',
      'lib/server/engine-tools.ts',
      'lib/objects/App.ts',
      'lib/server/policy.ts',
      'lib/server/mcp-server.ts',
    ]) {
      const t = files.find(([n]) => n === f)?.[1] ?? '';
      expect(t, f).not.toMatch(/applyOwnBatch|undoOwnBatch|applyApproved/);
    }
    for (const [f, t] of files.filter(([f]) =>
      f.startsWith('lib/server/assistant/'),
    ))
      expect(t, f).not.toMatch(
        /applyOwnBatch|undoOwnBatch|applyApproved|requestApply/,
      );
  });

  it('the assistant parts (revise, comment, answer, review, Apply now rule) cannot reach apply, approve, undo or execute', () => {
    const strip = (t: string) => t.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    const forbidden =
      /applyOwnBatch|undoOwnBatch|applyApproved|requestApply|requestApproval|decideApproval|publishApproved|publishDraft|undoBatch|approved\s*:\s*true|\.execute\(/;
    const src = (f: string) => strip(files.find(([n]) => n === f)?.[1] ?? '');
    // whole files
    for (const f of [
      'lib/server/change-review.ts',
      'lib/server/apply-now.ts',
      'lib/components/ChangeCardExtras.svelte',
      'routes/api/shell/changes/cards/[id]/comment/+server.ts',
      'routes/api/shell/changes/questions/[id]/answer/+server.ts',
    ]) {
      expect(src(f).length, f).toBeGreaterThan(100);
      expect(src(f), f).not.toMatch(forbidden);
    }
    // the revise / comment / answer / review part of changes.ts
    const rawChanges =
      files.find(([n]) => n === 'lib/server/changes.ts')?.[1] ?? '';
    const part = strip(
      rawChanges.slice(
        rawChanges.indexOf('// ---------- the assistant'),
        rawChanges.indexOf('// ---------- preview'),
      ),
    );
    expect(part.length).toBeGreaterThan(2000);
    expect(part).not.toMatch(forbidden);
    // change_revise's dispatch in the catalog
    const catalog = src('lib/server/catalog.ts');
    const revise = catalog.slice(
      catalog.indexOf('if (tool.name === CHANGE_REVISE_TOOL.name)'),
      catalog.indexOf('if (isEngineTool(tool.name))'),
    );
    expect(revise.length).toBeGreaterThan(200);
    expect(revise).not.toMatch(forbidden);
    // and who may call each of them
    const callers: Record<string, string[]> = {
      reviseChangeCard: ['lib/server/catalog.ts', 'lib/server/changes.ts'],
      'beginCardComment|endCardComment': [
        'lib/server/assistant/routes.ts',
        'lib/server/changes.ts',
      ],
      answerReviewQuestion: [
        'lib/server/changes.ts',
        'routes/api/shell/changes/questions/[id]/answer/+server.ts',
      ],
      setReviewQuestions: [
        'lib/server/change-review.ts',
        'lib/server/changes.ts',
      ],
      'installChangeReview|reviewBatch': [
        'hooks.server.ts',
        'lib/server/change-review.ts',
      ],
    };
    for (const [names, ok] of Object.entries(callers)) {
      const re = new RegExp(`\\b(${names})\\b`);
      const users = files
        .filter(([f, t]) => !f.startsWith('lib/ui/') && re.test(strip(t)))
        .map(([f]) => f);
      expect(users.sort(), names).toEqual([...ok].sort());
    }
    // the comment route verifies the owner and only hands over to the assistant's comment turn
    const route = src('routes/api/shell/changes/cards/[id]/comment/+server.ts');
    expect(route).toMatch(/await ownerOf\(event\)/);
    expect(route).toMatch(/assistantRoutes\.comment\(/);
    // the answer route reads only a choice INDEX (never a command) and the owner session
    const answer = src(
      'routes/api/shell/changes/questions/[id]/answer/+server.ts',
    );
    expect(answer).toMatch(/await ownerOf\(event\)/);
    expect(answer).toMatch(/body\.choice/);
    expect(answer).not.toMatch(/body\.command|body\.commands/);
    // the assistant's tools: change_revise is the only one it gains, and nothing
    // in the tool catalog, MCP server or assistant names apply/undo/publish
    for (const f of [
      'lib/server/catalog.ts',
      'lib/server/engine-tools.ts',
      'lib/server/mcp-server.ts',
      'lib/server/policy.ts',
      'lib/server/assistant/turn.ts',
      'lib/server/assistant/scope.ts',
      'lib/server/assistant/routes.ts',
    ])
      expect(src(f), f).not.toMatch(
        /name:\s*['"](change_apply|apply_changes|change_undo|undo_changes|publish_changes)/,
      );
    // production registers the review (not only a test's injected one)
    expect(src('hooks.server.ts')).toMatch(/installChangeReview\(\)/);
    const review = src('lib/server/change-review.ts');
    expect(review).toMatch(/setAfterChecks\(/);
    expect(review).toMatch(/isCurrent\(\)/);
    expect(review).toMatch(/tools: \[\]/);
  });

  it('a workbook import can only record its own commands: it cannot apply, approve, undo or reach live', () => {
    const strip = (t: string) => t.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    const src = (f: string) => strip(files.find(([n]) => n === f)?.[1] ?? '');
    const forbidden =
      /applyOwnBatch|undoOwnBatch|applyApproved|requestApply|requestApproval|decideApproval|publishApproved|publishDraft|undoBatch|approved\s*:\s*true|\.execute\(|getHost\(/;
    for (const f of [
      'lib/server/import-workflow.ts',
      'lib/server/import-assistant.ts',
    ])
      expect(src(f), f).not.toMatch(forbidden);
    // the recording function and its one caller
    const users = files
      .filter(([, t]) => /\brecordImportCommand\b/.test(strip(t)))
      .map(([f]) => f)
      .sort();
    expect(users).toEqual([
      'lib/server/changes.ts',
      'lib/server/import-workflow.ts',
    ]);
    // it refuses unless the import holds the copy, and it only records
    const changes = src('lib/server/changes.ts');
    const part = changes.slice(
      changes.indexOf('export function recordImportCommand'),
      changes.indexOf('export const settled'),
    );
    expect(part.length).toBeGreaterThan(500);
    expect(part).toMatch(/slot\?\.hold/);
    expect(part).toMatch(/requireOwner\(owner\)/);
    expect(part).not.toMatch(
      /applyOwnBatch|applyApproved|requestApply|publishApproved|publishDraft|undoBatch|approved\s*:\s*true|\.execute\(/,
    );
    // no route or tool reaches it
    for (const [f, t] of files.filter(
      ([f]) => f.startsWith('routes/') || f.startsWith('lib/server/assistant/'),
    ))
      expect(strip(t), f).not.toMatch(/recordImportCommand/);
  });

  it('only changes.ts and approvals.ts-owned paths execute commands on a host', () => {
    // a direct `.execute(` is a structural write: allow-listed on purpose
    const users = files
      .filter(
        ([f, t]) =>
          f.startsWith('lib/') && f.endsWith('.ts') && /\.execute\(/.test(t),
      )
      .map(([f]) => f)
      .sort();
    expect(users).toEqual([
      'lib/server/approvals.ts',
      'lib/server/builder.ts',
      'lib/server/changes.ts',
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

  it('every route handler is builder (ownerOf), record (callerOf) or a named public/delegating one (#5197)', () => {
    // Per HANDLER, not per file: a file may mix classes (a record GET and an
    // owner-only DELETE). `callerOf` admits staff, so it may appear ONLY in
    // the pinned record handlers; every other handler calls `ownerOf`, or is
    // named below with the reason it needs neither.
    const RECORD = [
      'routes/+layout.server.ts#load',
      'routes/api/app/[...path]/+server.ts#GET',
      'routes/api/app/[...path]/+server.ts#HEAD',
      'routes/api/app/[...path]/+server.ts#POST',
      'routes/api/app/[...path]/+server.ts#PUT',
      'routes/api/app/[...path]/+server.ts#PATCH',
      'routes/api/events/+server.ts#GET',
      'routes/api/shell/records/[model]/+server.ts#GET',
      'routes/api/shell/records/[model]/+server.ts#POST',
      'routes/api/shell/records/[model]/[id]/+server.ts#GET',
      'routes/api/shell/records/[model]/[id]/+server.ts#PUT',
      'routes/api/shell/reports/[name]/+server.ts#GET',
      'routes/api/shell/reports/[name]/csv/+server.ts#GET',
      'routes/m/[model]/+page.server.ts#load',
      'routes/m/[model]/[id]/+page.server.ts#load',
      'routes/m/[model]/new/+page.server.ts#load',
      'routes/reports/+page.server.ts#load',
      'routes/reports/[name]/+page.server.ts#load',
    ].sort();
    // Neither: public, or one delegating to code that checks (and is itself
    // pinned elsewhere in this file or by its own test).
    const PUBLIC_OR_DELEGATING = [
      // liveness, sign-in and sign-out
      'routes/api/_runtime/health/+server.ts#GET',
      'routes/api/_runtime/owner-link/+server.ts#GET',
      'routes/auth/[provider]/callback/+server.ts#GET',
      'routes/auth/[provider]/login/+server.ts#GET',
      'routes/sign-out/+server.ts#POST',
      // the owner bootstrap and the pages that only read the profile
      'routes/setup/+page.server.ts#actions',
      'routes/setup/+page.server.ts#load',
      'routes/welcome/+page.server.ts#load',
      'routes/settings/assistant/+page.server.ts#load',
      // the home page only reads counts through the record routes (each is callerOf)
      'routes/+page.server.ts#load',
      // the owner check is `asOwner` (smrt-inference's shared controller)
      'routes/settings/inference/+page.server.ts#actions',
      'routes/settings/inference/+page.server.ts#load',
      // the owner session or a one-use link token (never staff)
      'routes/api/shell/app/receive/+server.ts#POST',
      // one-line delegates whose implementations call ownerOf (pinned below)
      'routes/api/assistant/status/+server.ts#GET',
      'routes/api/assistant/threads/+server.ts#GET',
      'routes/api/assistant/threads/[id]/+server.ts#GET',
      'routes/api/assistant/turn/+server.ts#POST',
      'routes/api/shell/onboarding/+server.ts#GET',
      'routes/api/shell/onboarding/chatgpt/+server.ts#GET',
      'routes/api/shell/onboarding/chatgpt/+server.ts#POST',
      'routes/api/shell/onboarding/complete/+server.ts#POST',
      'routes/api/shell/onboarding/connect/+server.ts#POST',
      'routes/api/shell/onboarding/engine/+server.ts#POST',
      'routes/api/shell/onboarding/skip/+server.ts#POST',
      // the MCP policy: owner everything, staff only their granted record tools
      'routes/mcp/+server.ts#POST',
    ].sort();
    const strip = (t: string) => t.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    const handlers: { id: string; text: string }[] = [];
    for (const [f, raw] of files) {
      if (!/^routes\/.*\+(server|page\.server|layout\.server)\.ts$/.test(f))
        continue;
      // `svelte-kit sync` writes the generated model REST (gitignored); the
      // hand-written routes are the ones this rule is about.
      if (raw.startsWith('// Auto-generated by @smrt/core')) continue;
      const text = strip(raw);
      // top-level declarations, so an alias can be followed to its body
      const decl =
        /^(?:export\s+)?(?:async\s+)?(?:const|function|let)\s+(\w+)/gm;
      const marks = [...text.matchAll(decl)].map((m) => ({
        name: m[1],
        at: m.index as number,
        exported: m[0].startsWith('export'),
      }));
      const body = (i: number) =>
        text.slice(marks[i].at, marks[i + 1]?.at ?? text.length);
      for (let i = 0; i < marks.length; i++) {
        if (
          !marks[i].exported ||
          !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|load|actions)$/.test(
            marks[i].name,
          )
        )
          continue;
        let code = body(i);
        const alias = /=\s*(\w+);?\s*$/.exec(code);
        const target = alias ? marks.findIndex((m) => m.name === alias[1]) : -1;
        if (target >= 0) code = body(target);
        handlers.push({ id: `${f}#${marks[i].name}`, text: code });
      }
    }
    expect(handlers.length).toBeGreaterThan(60);
    const ids = new Set(handlers.map((h) => h.id));
    for (const id of [...RECORD, ...PUBLIC_OR_DELEGATING])
      expect(ids.has(id), `${id} is listed but not found`).toBe(true);
    const named = new Set([...RECORD, ...PUBLIC_OR_DELEGATING]);
    expect(named.size).toBe(RECORD.length + PUBLIC_OR_DELEGATING.length);
    const callers = handlers
      .filter((h) => /\bcallerOf\(/.test(h.text))
      .map((h) => h.id)
      .sort();
    // callerOf only where pinned, and every pinned one calls it
    expect(callers).toEqual(RECORD);
    for (const h of handlers) {
      if (named.has(h.id)) {
        // a public/delegating handler claims no verified owner of its own
        if (!RECORD.includes(h.id))
          expect(h.text, h.id).not.toMatch(/\bcallerOf\(/);
        continue;
      }
      // everything else is a builder handler
      expect(h.text, h.id).toMatch(/\bownerOf\(/);
      expect(h.text, h.id).not.toMatch(/\bcallerOf\(/);
    }
    // a record handler never admits staff to a structural command or a delete
    for (const h of handlers.filter((x) => RECORD.includes(x.id)))
      expect(h.text, h.id).not.toMatch(
        /runCommand\(|requestRecordDelete\(|decideApproval|requestApproval\(/,
      );
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
      /export function openDraftHost[\s\S]{0,600}autoApprove: true/,
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
        /hostFor\('live'\)|requestRecordDelete|describeCopy|historyFor|runCommand|runRest|App\./,
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
    expect(adapter).toMatch(/structureHost\(\)/);
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

describe('engine principal invariants (#5188)', () => {
  it('nothing outside the engine mints the system principal', () => {
    const offenders = files
      .filter(([, t]) => /mintSystemPrincipal/.test(t))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
    const index = readFileSync(join(root, 'engine', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/mintSystemPrincipal/);
  });

  it('no route or shell source builds a principal by hand', () => {
    // `enginePrincipal` is called only from owner.ts (`principalFor`), which
    // takes an owner that `requireOwner` verified.
    const offenders = files
      .filter(
        ([f, t]) =>
          !f.endsWith('lib/server/owner.ts') &&
          !f.startsWith('test/') &&
          /enginePrincipal\s*\(/.test(t),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
