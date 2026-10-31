#!/usr/bin/env node
/**
 * Final planner gate of the release pipeline (publish.yml), run after the
 * release tarballs are packed and before anything is published.
 *
 * Every check runs against this release's own artifacts, never the registry:
 *
 *   planner checks
 *     - the planner's MCP widget browser suite (`test:mcp-browser`)
 *     - the planner's live preview browser suite (`test:live-preview-browser`)
 *     - the packed planner installed as a consumer, its smrt dependencies
 *       resolved from the release tarballs (`test:package`)
 *   framework checks
 *     - `smrt cookbook validate` of every library cookbook against the
 *       workspace manifests
 *     - `smrt cookbook apply` of one library cookbook into a new project from
 *       the canonical template (https://github.com/happyvertical/smrt-start,
 *       as a user gets it), every @happyvertical package overridden to the release tarballs, then
 *       the project's install, build and typecheck
 *     - the release consumer canary (`release-consumer-canary.mjs`, #2975): a
 *       hermetic in-repo app installed from the release tarballs must build,
 *       import its generated `.smrt/register.js` under plain Node and under
 *       smrt-vitest, resolve schemas, typecheck, and `smrt db:migrate`
 *
 * Each check gets one retry; a check that passes only on retry is reported as
 * flaky but does not fail the gate. A failure names who broke: the planner
 * (its own suites) or the framework (a release package rejects a cookbook or
 * a generated app no longer builds against the release). When the generated
 * app fails, a control repeats the apply as the published release generates
 * it (the published CLI and manifests, every release package pinned to the
 * latest published version): if that fails too, the cause is upstream drift (the
 * smrt-start template or a third-party release), not this release, and the
 * failure says so. When the control cannot be built from the published
 * release (a package the app uses or the CLI is not published at that
 * version, or the published CLI cannot apply this release's cookbook), it is
 * inconclusive and the failure stays the framework's. The gate fails in every case; a release is
 * never published past an app that does not build.
 *
 * Usage: node scripts/planner-release-gate.mjs --packs <dir>
 *          [--cookbook bakery] [--template <path|github:owner/repo[#ref]|git URL>]
 *          [--only planner|framework]
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runReleaseConsumerCanary } from './release-consumer-canary.mjs';
import { OWN_REGISTRY, RELEASE_SCOPE, registryArgs } from './release-registry.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLANNER = join(ROOT, 'packages/planner');
const CLI = join(ROOT, 'packages/cli/bin/smrt.js');
const PLANNER_NAME = '@happyvertical/smrt-planner';
// The CLI's default template, fetched with plain git and no credentials (the
// repository is public). Named explicitly so the release app and the control
// (the published CLI) use the same source.
const TEMPLATE = 'https://github.com/happyvertical/smrt-start';

const OWNERS = {
  planner: {
    label: 'PLANNER',
    meaning:
      'the planner itself broke: its own suite fails against this release. Fix packages/planner.',
  },
  framework: {
    label: 'FRAMEWORK',
    meaning:
      'the framework broke the planner or a consumer: a release package rejects a library cookbook, an app generated from one no longer installs, builds or typechecks against the release tarballs, or the release consumer canary (scripts/fixtures/release-consumer-canary) no longer builds, registers, resolves schemas, tests or migrates. Fix the package that changed (or, if the contract change is intended, update the cookbook in packages/planner/src/lib/library/library.json in the same PR).',
  },
  upstream: {
    label: 'UPSTREAM',
    meaning:
      'not this release: the generated app also fails against the published packages, so the smrt-start template or a third-party release drifted. Fix the template (happyvertical/smrt-start) or pin the offending dependency, then re-run the release.',
  },
};

export function parseArgs(argv) {
  const options = {
    packs: undefined,
    cookbook: 'bakery',
    template: undefined,
    only: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = () => inline ?? argv[++i];
    if (flag === '--packs') options.packs = value();
    else if (flag === '--cookbook') options.cookbook = value();
    else if (flag === '--template') options.template = value();
    else if (flag === '--only') options.only = value();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!options.packs) throw new Error('--packs <dir of release tarballs> is required');
  if (options.only && !(options.only in OWNERS)) {
    throw new Error('--only must be planner or framework');
  }
  return options;
}

/** `{ name -> absolute tarball path }` for every tarball in `dir`. */
export function readTarballs(dir, readManifest = readPackedManifest) {
  const tarballs = new Map();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.tgz')) continue;
    const path = resolve(dir, file);
    tarballs.set(readManifest(path).name, path);
  }
  return tarballs;
}

function readPackedManifest(path) {
  const result = spawnSync('tar', ['-xzOf', path, 'package/package.json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`cannot read ${path}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * The project's pnpm-workspace.yaml with every release package overridden to
 * the given spec (`file:<tarball>` for the release, a version for the
 * control). An existing `overrides:` block keeps its entries; ours follow.
 */
export function withOverrides(workspaceYaml, specs) {
  const lines = [...specs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => `  '${name}': '${spec}'`);
  const text = workspaceYaml.endsWith('\n') || workspaceYaml === '' ? workspaceYaml : `${workspaceYaml}\n`;
  if (/^overrides:\s*$/m.test(text)) {
    return text.replace(/^overrides:\s*$/m, `overrides:\n${lines.join('\n')}`);
  }
  return `${text}overrides:\n${lines.join('\n')}\n`;
}

/** Run checks with one retry each; returns `{ failed, flaky }`. */
export function runChecks(checks, { log = console.log, attempts = 2 } = {}) {
  const failed = [];
  const flaky = [];
  for (const check of checks) {
    let passed = false;
    for (let attempt = 1; attempt <= attempts && !passed; attempt += 1) {
      log(`\n▶ [${OWNERS[check.owner].label}] ${check.name} (attempt ${attempt}/${attempts})`);
      try {
        check.run();
        passed = true;
        if (attempt > 1) flaky.push(check);
        log(`✓ ${check.name}${attempt > 1 ? ' (passed on retry: flaky)' : ''}`);
      } catch (error) {
        log(`✗ ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!passed) {
      // A check may re-attribute its failure (the generated app's control run).
      const owner = check.classify?.() ?? check.owner;
      failed.push(owner === check.owner ? check : { ...check, owner });
    }
  }
  return { failed, flaky };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}

/** The latest published smrt line (smrt-core's version on the primary registry). */
function publishedVersion() {
  const result = spawnSync(
    'npm',
    ['view', '@happyvertical/smrt-core', 'version', ...registryArgs(OWN_REGISTRY)],
    { encoding: 'utf8' },
  );
  const version = result.stdout?.trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`cannot read the published smrt version: ${result.stderr}`);
  }
  return version;
}

/** `npm exec` of the published smrt CLI at `version`, as a command prefix. */
function publishedCli(version) {
  return [
    'npm',
    'exec',
    '--yes',
    `--package=@happyvertical/smrt-cli@${version}`,
    // Scope mapping only, deliberately not registryArgs(): --registry would
    // send the CLI's third-party dependencies to our registry, which serves
    // only @happyvertical (401 for the rest).
    `--${RELEASE_SCOPE}:registry=${OWN_REGISTRY}`,
    '--',
    'smrt',
  ];
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/** The `@happyvertical/smrt-*` packages a generated app's package.json names. */
function appSmrtDependencies(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter((name) => name.startsWith('@happyvertical/smrt-'))
      .sort();
  } catch {
    return [];
  }
}

function isPublished(name, version) {
  const result = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', ...registryArgs(OWN_REGISTRY)],
    { encoding: 'utf8' },
  );
  return result.status === 0 && result.stdout.trim() === version;
}

function libraryCookbooks() {
  const library = JSON.parse(
    readFileSync(join(PLANNER, 'src/lib/library/library.json'), 'utf8'),
  );
  return library.cookbooks.map((cookbook) => ({
    id: cookbook.id,
    document: cookbook.document,
  }));
}

function plannerChecks(tarballs) {
  const tarball = tarballs.get(PLANNER_NAME);
  return [
    {
      owner: 'planner',
      name: 'MCP widget browser suite',
      run: () => run('pnpm', ['--filter', PLANNER_NAME, 'test:mcp-browser'], { cwd: ROOT }),
    },
    {
      owner: 'planner',
      name: 'live preview browser suite',
      run: () =>
        run('pnpm', ['--filter', PLANNER_NAME, 'test:live-preview-browser'], { cwd: ROOT }),
    },
    {
      owner: 'planner',
      name: 'packed planner consumer against the release tarballs',
      run: () => {
        if (!tarball) throw new Error(`no ${PLANNER_NAME} tarball among the release packs`);
        run('pnpm', ['--filter', PLANNER_NAME, 'test:package', '--', tarball], {
          cwd: ROOT,
          env: { PLANNER_PACKED_DEPS_DIR: dirOf(tarball) },
        });
      },
    },
  ];
}

function dirOf(path) {
  return resolve(path, '..');
}

function frameworkChecks(tarballs, options, scratch) {
  const cookbooks = libraryCookbooks();
  const chosen = cookbooks.find((cookbook) => cookbook.id === options.cookbook);
  const manifests = join(ROOT, 'packages');
  const files = new Map();
  for (const cookbook of cookbooks) {
    const file = join(scratch, `${cookbook.id}.cookbook.json`);
    writeFileSync(file, `${JSON.stringify(cookbook.document, null, 2)}\n`);
    files.set(cookbook.id, file);
  }
  const app = join(scratch, `app-${options.cookbook}`);
  // Both runs apply smrt-start as a user gets it; --template overrides it.
  const template = options.template ?? TEMPLATE;
  /**
   * Apply the chosen cookbook into `dir` (template as a user gets it), then
   * install, build and typecheck. The applying CLI pins every smrt package to
   * its own version and drops the template's lockfile (#4057), so the release
   * app targets this release; with `overrides`, every release package resolves
   * from its tarball.
   */
  const generateApp = (dir, overrides, { published } = {}) => {
    rmSync(dir, { recursive: true, force: true });
    // The release app uses this release's CLI; the control the published
    // release's CLI, so nothing of this release takes part in it.
    const [command, ...prefix] = published ? publishedCli(published) : [process.execPath, CLI];
    try {
      run(
        command,
        [
          ...prefix,
          'cookbook',
          'apply',
          files.get(options.cookbook),
          dir,
          // The release app is generated from this release's manifests; the
          // control from the published ones, as a user of that release gets it.
          ...(published ? [] : ['--manifests', manifests, '--no-registry']),
          '--no-install',
          '--template',
          template,
        ],
        { cwd: scratch },
      );
    } catch (error) {
      // Tag apply failures: in the control they mean the published CLI or
      // manifests rejected this release's cookbook, not that the app broke.
      throw Object.assign(new Error(`cookbook apply: ${errorText(error)}`), {
        stage: 'apply',
      });
    }
    if (overrides) {
      const workspaceFile = join(dir, 'pnpm-workspace.yaml');
      const current = existsSync(workspaceFile) ? readFileSync(workspaceFile, 'utf8') : '';
      writeFileSync(workspaceFile, withOverrides(current, overrides));
    }
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: dir, env: { CI: 'true' } });
    run('pnpm', ['run', 'build'], { cwd: dir });
    run('pnpm', ['run', 'typecheck'], { cwd: dir });
  };
  return [
    {
      owner: 'framework',
      // #2975: no control run. The canary installs only release tarballs and
      // pinned tools, so a failure is this release's.
      name: 'release consumer canary: an app installed from the release tarballs builds, registers, resolves schemas, typechecks, tests and migrates',
      run: () => runReleaseConsumerCanary({ tarballs }),
    },
    {
      owner: 'framework',
      name: `smrt cookbook validate: ${cookbooks.length} library cookbooks against the workspace manifests`,
      run: () => {
        const invalid = [];
        for (const [id, file] of files) {
          const result = spawnSync(
            process.execPath,
            [CLI, 'cookbook', 'validate', file, '--manifests', manifests, '--no-registry'],
            { cwd: scratch, stdio: 'inherit' },
          );
          if (result.status !== 0) invalid.push(id);
        }
        if (invalid.length > 0) throw new Error(`invalid: ${invalid.join(', ')}`);
      },
    },
    {
      owner: 'framework',
      name: `smrt cookbook apply ${options.cookbook}, then install, build and typecheck against the release tarballs`,
      run: () => {
        if (!chosen) throw new Error(`no library cookbook ${options.cookbook}`);
        generateApp(
          app,
          new Map([...tarballs].map(([name, path]) => [name, `file:${path}`])),
        );
      },
      // Control: the same apply with every release package pinned to the
      // latest published version (one consistent smrt line, as the release
      // run has). If it fails too, the template or a third-party release
      // drifted, not this release.
      classify: () => {
        if (!chosen) return 'framework';
        console.log(
          `\n▶ control: smrt cookbook apply ${options.cookbook} as the published release generates it`,
        );
        let published;
        try {
          published = publishedVersion();
        } catch (error) {
          console.log(`control inconclusive (${errorText(error)}): reporting the framework`);
          return 'framework';
        }
        // The published CLI runs the control apply, so it must exist too.
        const used = [...new Set([...appSmrtDependencies(app), '@happyvertical/smrt-cli'])];
        const unpublished = used.filter((name) => !isPublished(name, published));
        if (unpublished.length > 0) {
          console.log(
            `control inconclusive: ${unpublished.join(', ')} not published at ${published}; reporting the framework`,
          );
          return 'framework';
        }
        const [cliCommand, ...cliArgs] = publishedCli(published);
        const cli = spawnSync(cliCommand, [...cliArgs, '--version'], {
          cwd: scratch,
          encoding: 'utf8',
        });
        if (cli.status !== 0) {
          console.log(
            `control inconclusive: the published smrt CLI ${published} could not be run; reporting the framework`,
          );
          return 'framework';
        }
        try {
          console.log(`control pins every release package to ${published}`);
          generateApp(
            `${app}-control`,
            new Map([...tarballs.keys()].map((name) => [name, published])),
            { published },
          );
          console.log('✓ control passed: the release tarballs broke the app');
          return 'framework';
        } catch (error) {
          if (error?.stage === 'apply') {
            console.log(
              `control inconclusive: the published release cannot apply this cookbook (${errorText(error)}); reporting the framework`,
            );
            return 'framework';
          }
          console.log(`✗ control failed too (${errorText(error)}): upstream drift`);
          return 'upstream';
        }
      },
    },
  ];
}

function report({ failed, flaky }) {
  const summary = [];
  for (const check of flaky) {
    const line = `[${OWNERS[check.owner].label}] ${check.name} passed only on retry (flaky)`;
    console.log(`::warning title=Planner release gate::${line}`);
    summary.push(`- ⚠️ ${line}`);
  }
  for (const owner of Object.keys(OWNERS)) {
    const mine = failed.filter((check) => check.owner === owner);
    if (mine.length === 0) continue;
    const line = `${OWNERS[owner].label} BROKE — ${OWNERS[owner].meaning} Failing: ${mine.map((check) => check.name).join('; ')}`;
    console.log(`::error title=Planner release gate: ${OWNERS[owner].label} broke::${line}`);
    summary.push(`- ❌ ${line}`);
  }
  if (failed.length === 0) summary.push('- ✅ planner and framework checks passed');
  const text = `## Planner release gate\n\n${summary.join('\n')}\n`;
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tarballs = readTarballs(resolve(options.packs));
  if (tarballs.size === 0) throw new Error(`no tarballs in ${options.packs}`);
  // A scratch root with no ancestor node_modules, so the generated project
  // resolves only what it installs.
  mkdirSync(tmpdir(), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'smrt-planner-gate-'));
  try {
    const checks = [
      ...(options.only === 'framework' ? [] : plannerChecks(tarballs)),
      ...(options.only === 'planner' ? [] : frameworkChecks(tarballs, options, scratch)),
    ];
    const result = runChecks(checks);
    report(result);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
