import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8',
);
const batchWorkflow = readFileSync(
  new URL('../.github/workflows/on-merge-main.yml', import.meta.url),
  'utf8',
);
const publishDryRunWorkflow = readFileSync(
  new URL('../.github/workflows/publish-dry-run.yml', import.meta.url),
  'utf8',
);

function job(name, source = workflow) {
  const match = source.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `workflow job ${name} must exist`);
  return match[0];
}

test('publish dry-run summary terminalizes cancellation without using metal', () => {
  const summary = job('publish-dry-run-summary', publishDryRunWorkflow);

  assert.match(summary, /^      !cancelled\(\) && always\(\) &&$/m);
  assert.match(summary, /^    runs-on: ubuntu-latest$/m);
  assert.match(summary, /^    timeout-minutes: 10$/m);
  assert.doesNotMatch(summary, /arc-happyvertical/);
});

test('final publisher skips workspace installation and allows recovery headroom', () => {
  const publisher = job('publish-release');

  assert.match(publisher, /^    timeout-minutes: 45$/m);
  assert.match(
    publisher,
    /- name: Setup Environment[\s\S]*?install-deps: 'false'/,
  );
});

test('release regenerates and commits tracked SvelteKit registration snapshots', () => {
  const prepare = job('prepare-release');
  const publisher = job('publish-release');
  const versionPatch = prepare.indexOf('git diff --binary > release-version.patch');
  const build = prepare.indexOf('TURBO_FORCE=true pnpm run build');
  const snapshotPatch = prepare.indexOf('>> release-version.patch');
  assert.ok(versionPatch >= 0 && build >= 0 && snapshotPatch >= 0);
  assert.ok(versionPatch < build);
  for (const name of ['assets', 'content', 'images']) {
    const sync = prepare.indexOf(
      `pnpm --filter @happyvertical/smrt-${name} exec svelte-kit sync`,
    );
    assert.ok(sync >= 0);
    assert.ok(build < sync);
    assert.ok(sync < snapshotPatch);
    assert.match(
      prepare,
      new RegExp(`packages/${name}/src/lib/server/smrt-register\\.ts`),
    );
  }
  assert.match(publisher, /':\(glob\)packages\/\*\*\/smrt-register\.ts'/);
  // scripts/sync-template-versions.mjs also rewrites the optional MCP Apps
  // pins (mcp-apps-template/package.dependencies.json); the versioned
  // workspace archive and the release commit must both carry them (#3356).
  assert.match(prepare, /-name 'package\.dependencies\.json'/);
  assert.match(
    publisher,
    /':\(glob\)packages\/\*\*\/package\.dependencies\.json'/,
  );
  assert.ok(
    publisher.indexOf("packages/**/smrt-register.ts'") <
      publisher.indexOf('git commit -m "chore(release):'),
  );
});

test('release commit collection never stages ignored output (#4711, #4989)', () => {
  // Build output (`packages/core/dist`, `packages/*/.svelte-kit`, ...) can hold
  // copies of source fixture files. Staging an ignored path makes `git add`
  // refuse it and fails the release before tagging, so the list must come from
  // git itself rather than a hand-maintained find prune list.
  const collect =
    /^ +mapfile -d '' -t release_files < <\((git ls-files .*\| sort -z)\)$/m;
  const commands = ['seal-release', 'publish-release'].map((name) => {
    const match = job(name).match(collect);
    assert.ok(match, `${name} must collect release files with git ls-files`);
    return match[1];
  });
  assert.equal(commands[0], commands[1], 'both seal steps must collect identically');

  const root = mkdtempSync(join(tmpdir(), 'release-files-'));
  const git = (...args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    const files = {
      collected: [
        'packages/core/package.json',
        'packages/core/CHANGELOG.md',
        'packages/core/scripts/fixtures/pglite-peer/package.json',
        'packages/assets/src/lib/server/smrt-register.ts',
        'packages/cli/templates/app/template.config.js',
        'packages/cli/templates/mcp-apps-template/package.dependencies.json',
      ],
      excluded: [
        'packages/core/dist/scripts/fixtures/pglite-peer/package.json',
        'packages/core/dist/CHANGELOG.md',
        'packages/core/node_modules/some-dep/package.json',
        'packages/cli/templates/app/node_modules/x/template.config.js',
        'packages/smrt-svelte/.svelte-kit/package.json',
        'packages/smrt-svelte/.svelte-kit/generated/smrt-register.ts',
      ],
    };
    assert.equal(git('init', '-q').status, 0);
    writeFileSync(join(root, '.gitignore'), 'dist\nnode_modules\n.svelte-kit\n');
    for (const file of [...files.collected, ...files.excluded]) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), '{}');
    }
    const result = spawnSync('sh', ['-c', commands[0]], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const listed = result.stdout.split('\0').filter(Boolean);
    // Compare as sets: `sort` ordering follows the runner's locale.
    assert.deepEqual([...listed].sort(), [...files.collected].sort());
    // The collected list must be stageable exactly as the workflow stages it.
    const added = git('add', '--', ...listed);
    assert.equal(added.status, 0, added.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('routine releases batch instead of publishing after every main push', () => {
  const publisher = job('publish-release');

  assert.doesNotMatch(batchWorkflow, /^  push:/m);
  assert.match(batchWorkflow, /^  schedule:\n    - cron: '17 7 \* \* \*'$/m);
  assert.match(batchWorkflow, /^  workflow_dispatch:$/m);
  assert.match(batchWorkflow, /^  queue-idle:$/m);
  assert.match(batchWorkflow, /needs: \[queue-idle, test, build, docs-scope\]/);
  assert.match(
    batchWorkflow,
    /needs\.queue-idle\.result == 'success'/,
  );
  assert.match(
    batchWorkflow,
    /needs\.docs-scope\.result == 'success'/,
  );
  assert.match(
    batchWorkflow,
    /run: node scripts\/check-merge-queue-idle\.mjs/,
  );
  assert.match(batchWorkflow, /^  docs-scope:$/m);
  assert.match(batchWorkflow, /fetch-depth: 0/);
  assert.match(batchWorkflow, /git tag --merged HEAD --list 'v\*'/);
  assert.doesNotMatch(
    batchWorkflow,
    /git tag --merged HEAD --list 'v\*' --sort=-version:refname \| head -n 1/,
  );
  assert.match(batchWorkflow, /tag=\$\{tag%%\$'\\n'\*\}/);
  assert.match(
    batchWorkflow,
    /base: \$\{\{ steps\.release-base\.outputs\.ref \}\}/,
  );
  assert.match(
    batchWorkflow,
    /github\.event_name == 'schedule' && needs\.docs-scope\.outputs\.docs == 'true'/,
  );
  assert.match(
    publisher,
    /- name: Recheck merge queue before publication[\s\S]*?run: node scripts\/check-merge-queue-idle\.mjs/,
  );
  assert.ok(
    publisher.lastIndexOf('node scripts/check-merge-queue-idle.mjs') <
      publisher.indexOf('node scripts/publish-validated-artifacts.mjs'),
  );
});

test('releases are published to the primary registry, with npmjs as a mirror', () => {
  const publisher = job('publish-release');
  const mirror = job('mirror-npmjs');

  // A literal: the publish token is sent to this host, so it must not come
  // from an unreviewed repository variable or input.
  assert.match(
    workflow,
    /^  RELEASE_PRIMARY_REGISTRY: 'https:\/\/npm\.happyvertical\.com\/'$/m,
  );
  assert.doesNotMatch(workflow, /RELEASE_PRIMARY_REGISTRY:.*(vars\.|inputs\.|secrets\.)/);
  // The release record must not claim a mirror that has not run yet.
  assert.doesNotMatch(publisher, /and mirrored to npmjs/);

  // The token is proven valid against the primary before anything
  // irreversible; a non-empty check is what let an expired token through.
  const auth = publisher.indexOf('- name: Authenticate to the primary registry');
  assert.ok(auth > publisher.indexOf('- name: Setup Environment'));
  assert.ok(auth < publisher.indexOf('git commit -m'));
  assert.match(publisher, /npm whoami --registry "\$RELEASE_PRIMARY_REGISTRY" \\\n\s+"--@happyvertical:registry=\$RELEASE_PRIMARY_REGISTRY"/);
  // The host is checked against the reviewed allowlist before the token is
  // written for it or sent to it.
  const allowlist = publisher.indexOf("primaryRegistry();");
  assert.ok(allowlist > auth && allowlist < publisher.indexOf('_authToken=%s'));
  // The credential goes into a fresh file of its own, never appended to
  // setup-node's npmrc, which ends without a newline (#3005).
  assert.match(publisher, /rc="\$RUNNER_TEMP\/release-npmrc"/);
  assert.match(publisher, /_authToken=%s\\n' "\$host" "\$PRIMARY_TOKEN" > "\$rc"/);
  const authStep = publisher.slice(
    publisher.indexOf('- name: Authenticate to the primary registry'),
    publisher.indexOf('- name: Configure Git'),
  );
  assert.doesNotMatch(authStep, />> "\$rc"/);
  assert.match(publisher, /echo "NPM_CONFIG_USERCONFIG=\$rc" >> "\$GITHUB_ENV"/);
  // Not in changesets mode: that path needs setup-node's npmjs credential.
  assert.match(authStep, /if: inputs\.publish-mode != 'changesets'/);

  // A release must not depend on the npmjs credential existing.
  assert.doesNotMatch(job('prepare-release'), /NPM_TOKEN secret is required/);
  assert.doesNotMatch(publisher, /NPM_TOKEN secret is required/);
  assert.match(job('prepare-release'), /NPM_HAPPYVERTICAL_PUBLISH_TOKEN is required/);

  // The mirror can never fail the release, never holds the primary's
  // credential, and also runs when no release was cut so it self-heals.
  assert.match(mirror, /^    continue-on-error: true$/m);
  assert.match(mirror, /^    needs: \[prepare-release, publish-release, publish-window\]$/m);
  assert.match(
    mirror,
    /MIRROR_RELEASE_VERSION: \$\{\{ needs\.prepare-release\.outputs\.version \}\}/,
  );
  assert.match(mirror, /needs\.publish-release\.result == 'skipped'/);
  assert.match(mirror, /run: node scripts\/mirror-release-to-npmjs\.mjs/);
  assert.doesNotMatch(mirror, /NPM_HAPPYVERTICAL_PUBLISH_TOKEN/);
  assert.doesNotMatch(mirror, /contents: write/);
});

// Publish credentials live only in the main-only `release` environment
// (happyvertical/iac#2165): a pull_request run executes the PR's own workflow
// files, so any repository or organisation secret is readable by PR code.
const PUBLISH_SECRET = /secrets\.(NPM_HAPPYVERTICAL_PUBLISH_TOKEN|NPM_TOKEN)\b/;
const workflowDir = new URL('../.github/workflows/', import.meta.url);

function allWorkflows() {
  return readdirSync(workflowDir, { recursive: true })
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({
      file: f,
      source: readFileSync(new URL(f, workflowDir), 'utf8'),
    }));
}

function jobsOf(source) {
  const start = source.search(/^jobs:\s*$/m);
  if (start < 0) return [];
  const body = source.slice(start).replace(/^jobs:\s*\n/, '');
  return body
    .split(/^(?=  [A-Za-z_][\w-]*:\s*$)/m)
    .filter((chunk) => /^  [A-Za-z_][\w-]*:\s*$/m.test(chunk));
}

function jobCondition(chunk) {
  // The job-level `if:` only (4-space indent, plus its indented continuation
  // lines), never a step condition or a comment.
  const match = chunk.match(/^    if:(.*(?:\n {6,}.*)*)/m);
  return match ? match[1].replace(/#.*$/gm, '') : '';
}

function requiresMain(condition) {
  // No YAML parser is a root dependency here, so accept one canonical form
  // only: the literal main comparison as the FIRST operand, followed by the
  // end or a top-level `&&`, and no top-level `||`. Anything else (an
  // inverted or compared-again expression, an `||`, a prefix operand) fails.
  const text = condition
    .replace(/^\s*[|>][-+]?\s*/, '')
    .replace(/\$\{\{|\}\}/g, '')
    .trim();
  let depth = 0;
  let topLevel = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0) topLevel += ch;
  }
  return (
    /^github\.ref == 'refs\/heads\/main'(\s*&&|\s*$)/.test(text) &&
    !topLevel.includes('||')
  );
}

test('every job that reads a publish token runs in the release environment', () => {
  let seen = 0;
  for (const { file, source } of allWorkflows()) {
    for (const chunk of jobsOf(source)) {
      if (!PUBLISH_SECRET.test(chunk)) continue;
      // A job that calls a reusable workflow only forwards the secret; the
      // environment is declared on the called job that uses it.
      if (/^    uses: /m.test(chunk)) continue;
      seen += 1;
      const id = chunk.split('\n', 1)[0].trim();
      assert.match(
        chunk,
        /^    environment: release$/m,
        `${file} job ${id} reads a publish secret and must declare environment: release`,
      );
      assert.ok(
        requiresMain(jobCondition(chunk)),
        `${file} job ${id} must be skipped outside main by a job-level if`,
      );
    }
  }
  assert.ok(seen >= 4, 'publish.yml publish jobs must be found');
});

test('no pull_request, pull_request_target or merge_group workflow references a publish secret', () => {
  for (const { file, source } of allWorkflows()) {
    const head = source.slice(0, source.search(/^jobs:\s*$/m));
    if (!/^\s+(pull_request|pull_request_target|merge_group):|^on:.*(pull_request|merge_group)/m.test(head)) {
      continue;
    }
    assert.doesNotMatch(source, PUBLISH_SECRET, `${file} must not reference a publish secret`);
  }
});

test('the main-ref check only counts when it is on the job-level if', () => {
  const guarded = "  j:\n    if: github.ref == 'refs/heads/main'\n    steps:\n";
  const stepOnly = "  j:\n    steps:\n      - if: github.ref == 'refs/heads/main'\n";
  const commentOnly = "  j:\n    # if: github.ref == 'refs/heads/main'\n    if: true\n";
  assert.match(jobCondition(guarded), /refs\/heads\/main/);
  assert.doesNotMatch(jobCondition(stepOnly), /refs\/heads\/main/);
  assert.doesNotMatch(jobCondition(commentOnly), /refs\/heads\/main/);
  assert.ok(requiresMain(jobCondition(guarded)));
  assert.ok(
    requiresMain(
      jobCondition("  j:\n    if: |\n      github.ref == 'refs/heads/main' &&\n      (a == 1 || b == 2)\n"),
    ),
  );
  const offMain = "  j:\n    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'\n";
  assert.ok(!requiresMain(jobCondition(offMain)));
  for (const bad of [
    "github.ref == 'refs/heads/main' == false",
    "${{ github.ref == 'refs/heads/main' == false }}",
    "always() && github.ref == 'refs/heads/main'",
    "!(github.ref == 'refs/heads/main')",
    "github.ref == 'refs/heads/main' || true",
    "github.ref != 'refs/heads/main'",
  ]) {
    assert.ok(!requiresMain(bad), bad);
  }
  assert.ok(requiresMain("${{ github.ref == 'refs/heads/main' && !inputs.dry-run }}"));
});

test('the wrapper crate version follows the release: synced, archived and committed (smrt#4965)', () => {
  const cargo = [
    'packages/smrt-desktop/wrapper/Cargo.toml',
    'packages/smrt-desktop/wrapper/Cargo.lock',
  ];
  const sync = workflow.indexOf('node scripts/sync-desktop-wrapper-version.mjs');
  assert.ok(sync > workflow.indexOf('pnpm run changeset:version'));
  assert.ok(sync < workflow.indexOf('git diff --binary > release-version.patch'));
  const archive = workflow.slice(
    workflow.indexOf('name: Create versioned workspace archive'),
    workflow.indexOf('name: Upload release version patch'),
  );
  for (const file of cargo) assert.ok(archive.includes(file), `archive lists ${file}`);
  const commits = workflow.split('mapfile -d \'\' -t release_files').slice(1);
  assert.equal(commits.length, 2);
  for (const part of commits) {
    const head = part.slice(0, part.indexOf('git commit'));
    for (const file of cargo) assert.ok(head.includes(file), `release commit stages ${file}`);
  }
});
