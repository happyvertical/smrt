/**
 * Agent-docs refresh engine shared by `smrt docs:agents` and the `smrt app`
 * lifecycle (#4878 item C).
 *
 * `refreshAgentDocs` is the body of the docs:agents handler: it resolves the
 * docs root, writes the framework reference, the knowledge bundle, the skills
 * and the AGENTS.md block, and returns a structured result. It never calls
 * `process.exit`; the command interprets `failed` / `skipped-nothing-installed`
 * into its historical exit codes. Lifecycle callers (`install`, `dev`) use
 * {@link safeRefreshAgentDocs}, which additionally never throws: a broken agent
 * doc must not fail a build or a start.
 *
 * `inspectAgentDocs` is the read-only side (bundle, block, skills) used by
 * `smrt app build` and `smrt doctor`. Version comparison is
 * `checkOkfBundleFreshness`'s from `@happyvertical/smrt-dev-mcp/knowledge`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve } from 'node:path';
import { checkKnowledgeGraphFreshness } from '@happyvertical/smrt-core/knowledge';
import {
  checkOkfBundleFreshness,
  OKF_BUNDLE_DIR_NAME,
  readOkfBundleManifest,
} from '@happyvertical/smrt-dev-mcp/knowledge';
import {
  type AgentsBlockCheck,
  type AgentsBlockInputs,
  type AgentsBlockResult,
  applyAgentsBlock,
  checkAgentsBlock,
  renderAgentsBlock,
} from './docs-agents-block.js';
import {
  collectWorkspacePackages,
  detectMonorepoRoot,
  generateMarkdown,
  isSmrtRepository,
  loadRootDocs,
} from './docs-claude.js';
import {
  type BundleExportResult,
  exportKnowledgeBundle,
  filterInstalledIntents,
  isBundleSafePackage,
  loadIntentRows,
  renderIntentSection,
  resolveIntentSource,
  unscopedName,
} from './docs-knowledge-bundle.js';
import {
  installAgentSkills,
  SKILL_INSTALL_DIRS,
} from './docs-skills-install.js';
import {
  collectWorkspacePackageEntries,
  type DocsRoot,
  resolveDocsRoot,
} from './docs-workspace.js';

/** The skill whose presence `smrt doctor` checks (installed by default). */
export const AGENT_DOCS_SKILL = 'smrt-catalog';

const BUNDLE_DIR_NAME = 'smrt-knowledge';

export type RefreshMode = 'write' | 'if-stale';

export type RefreshStatus =
  | 'written'
  | 'skipped-fresh'
  | 'skipped-disabled'
  | 'skipped-nothing-installed'
  | 'failed';

/** Output sink seam; defaults to `console` (the command's historical output). */
export interface RefreshLog {
  out(text: string): void;
  err(text: string): void;
}

export interface RefreshAgentDocsOptions {
  /** Directory the command runs in. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * `write` always writes; `if-stale` writes only when the bundle is missing
   * or `bundle.json` no longer matches the installed versions. Default `write`.
   */
  mode?: RefreshMode;
  dryRun?: boolean;
  here?: boolean;
  complete?: boolean;
  /** Install the agent skills (default true). */
  skills?: boolean;
  /** Maintain the AGENTS.md block (default true). */
  agentsBlock?: boolean;
  /** Explicit `--output`, relative to `cwd`. */
  output?: string;
  /** Default output when `output` is absent. */
  defaultOutput?: string;
  /** Attribution written into generated files. */
  generatedBy?: string;
  /** Sinks for progress and warnings. */
  log?: Partial<RefreshLog>;
  /** Print progress lines. Warnings are always printed. Default true. */
  verbose?: boolean;
}

export interface RefreshFailure {
  code: 'stale-graph' | 'error';
  message: string;
  /** Extra lines (the stale-graph issues). */
  details?: string[];
}

export interface RefreshAgentDocsResult {
  status: RefreshStatus;
  /** Resolved docs root. */
  root: string;
  /** Warnings already sent to `log.err`, for callers that aggregate. */
  warnings: string[];
  /** Set when `status` is `failed`. */
  failure?: RefreshFailure;
  dryRun?: boolean;
}

const consoleLog: RefreshLog = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

function reportAgentsBlock(
  result: AgentsBlockResult,
  dryRun: boolean,
  cwd: string,
  log: RefreshLog,
  warnings: string[],
): void {
  const out = dryRun ? log.err : log.out;
  const verb = dryRun ? 'would be ' : '';
  const where = relativePath(cwd, result.path) || result.path;
  if (result.status === 'refused') {
    // The warning below carries the reason.
  } else if (result.status === 'unchanged') {
    out(`   AGENTS.md block unchanged (${where})`);
  } else {
    out(`   AGENTS.md block ${verb}${result.status} (${where})`);
  }
  if (result.claude === 'created') {
    out(`   CLAUDE.md ${verb}created (imports AGENTS.md)`);
  }
  if (dryRun) out(`\n${result.block}\n`);
  for (const warning of result.warnings) {
    warnings.push(warning);
    log.err(`   ⚠️  ${warning}`);
  }
}

/** Read-only state of the agent docs under one docs root. */
export interface AgentDocsInspection {
  root: string;
  /** True when at least one `@happyvertical/smrt*` package is installed. */
  installed: boolean;
  bundle: 'missing' | 'stale' | 'fresh';
  /** Messages of the findings that made the bundle stale. */
  staleReasons: string[];
  block: AgentsBlockCheck['state'];
  blockReason?: string;
  skills: Array<{ name: string; dir: string; present: boolean }>;
}

function hasSmrtPackage(docsRoot: DocsRoot): boolean {
  return collectWorkspacePackageEntries(docsRoot).some(
    (entry) => entry.name === 'smrt' || entry.name.startsWith('smrt-'),
  );
}

const REFRESH_BUNDLE_PARENT = '.agents';

function inspectBundle(docsRoot: DocsRoot): {
  state: 'missing' | 'stale' | 'fresh';
  reasons: string[];
} {
  // The lifecycle refresh writes only the default `.agents` bundle; a legacy
  // `.claude` one (deprecated `docs:claude`) is never rewritten here, so it
  // must not decide freshness or the refresh would run on every start.
  const parentDirs = [REFRESH_BUNDLE_PARENT];
  const present = parentDirs.some((parent) => {
    try {
      return (
        readOkfBundleManifest(
          join(docsRoot.root, parent, OKF_BUNDLE_DIR_NAME),
        ) !== null
      );
    } catch {
      // An unreadable manifest is present but invalid: checked below.
      return true;
    }
  });
  if (!present) return { state: 'missing', reasons: [] };
  // `okf-bundle-aged` and the age `info` line are not version drift.
  const reasons = checkOkfBundleFreshness(docsRoot.root, {
    installRoots: docsRoot.installRoots,
    parentDirs,
  })
    .filter(
      (issue) =>
        issue.code === 'stale-okf-bundle' ||
        issue.code === 'okf-bundle-invalid',
    )
    .map((issue) => issue.message);
  return reasons.length > 0
    ? { state: 'stale', reasons }
    : { state: 'fresh', reasons };
}

/**
 * Read-only: the bundle, AGENTS.md block and skill state at the docs root
 * resolved from `cwd` (the pnpm workspace root when `cwd` is a member, unless
 * `here`). Writes nothing and never throws for filesystem state.
 */
export function inspectAgentDocs(
  cwd: string,
  options: { here?: boolean } = {},
): AgentDocsInspection {
  const docsRoot = resolveDocsRoot({ cwd, here: options.here });
  const installed = hasSmrtPackage(docsRoot);
  const bundle = installed
    ? inspectBundle(docsRoot)
    : { state: 'missing' as const, reasons: [] };
  const block = checkAgentsBlock(docsRoot.root);
  const skills = SKILL_INSTALL_DIRS.map((dir) => ({
    name: AGENT_DOCS_SKILL,
    dir,
    present: existsSync(join(docsRoot.root, dir, AGENT_DOCS_SKILL, 'SKILL.md')),
  }));
  return {
    root: docsRoot.root,
    installed,
    bundle: bundle.state,
    staleReasons: bundle.reasons,
    block: block.state,
    blockReason: block.reason,
    skills,
  };
}

/**
 * Generates the agent docs. Throws only on unexpected errors; the two outcomes
 * the command turns into `exit(1)` (nothing installed, stale cross-package
 * graph) are results. See {@link safeRefreshAgentDocs} for lifecycle callers.
 */
export async function refreshAgentDocs(
  options: RefreshAgentDocsOptions = {},
): Promise<RefreshAgentDocsResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const mode = options.mode ?? 'write';
  const dryRun = options.dryRun === true;
  const verbose = options.verbose !== false;
  const log: RefreshLog = { ...consoleLog, ...options.log };
  const say = verbose ? log.out : () => {};
  const warnings: string[] = [];
  const defaultOutput = options.defaultOutput ?? '.agents/smrt-framework.md';
  const generatedBy = options.generatedBy ?? 'smrt docs:agents';

  const docsRoot = resolveDocsRoot({ cwd, here: options.here });
  const result = (
    status: RefreshStatus,
    failure?: RefreshFailure,
  ): RefreshAgentDocsResult => ({
    status,
    root: docsRoot.root,
    warnings,
    ...(failure ? { failure } : {}),
    ...(dryRun ? { dryRun } : {}),
  });

  if (mode === 'if-stale') {
    if (!hasSmrtPackage(docsRoot)) return result('skipped-nothing-installed');
    if (inspectBundle(docsRoot).state === 'fresh') {
      return result('skipped-fresh');
    }
  }

  // A consumer workspace root writes its default output under the root; an
  // explicit --output stays relative to where the command ran.
  const outputPath = options.output
    ? options.output
    : docsRoot.workspace
      ? join(docsRoot.root, defaultOutput)
      : defaultOutput;
  const absoluteOutput = resolve(cwd, outputPath);
  // Checkout-only inputs (root docs, checkout intents, the knowledge graph)
  // apply to the smrt repository itself. A consumer pnpm workspace also matches
  // the detector once it has a root AGENTS.md, and must never feed them (#4878).
  const detectedRoot = detectMonorepoRoot(cwd);
  const monorepoRoot = isSmrtRepository(detectedRoot) ? detectedRoot : null;
  const rootDocs = monorepoRoot ? loadRootDocs(monorepoRoot) : [];
  const { packages, sdkPackages } = await collectWorkspacePackages(
    docsRoot,
    options.complete,
  );

  if (packages.length === 0 && sdkPackages.length === 0) {
    return result('skipped-nothing-installed');
  }

  if (docsRoot.workspace) {
    // stdout carries the document under --dry-run, so report on stderr.
    (dryRun ? log.err : say)(
      `\n📦 pnpm workspace root: ${docsRoot.root}${
        docsRoot.liftedFromMember
          ? ` (resolved from ${cwd}; pass --here to stay local)`
          : ''
      }`,
    );
  }

  // Knowledge bundle (#4689): the intent section lists only intents whose home
  // package is installed in this project.
  const bundlePackages = packages.filter(isBundleSafePackage).map((pkg) => ({
    ...pkg,
    versions: pkg.versionLocations?.map((entry) => entry.version),
  }));
  const installedVersions = new Map(
    bundlePackages.map((pkg) => [unscopedName(pkg.name), pkg.version]),
  );
  const intentSource = resolveIntentSource({
    monorepoRoot,
    installedCliDirectory: packages.find(
      (pkg) => pkg.specifier === '@happyvertical/smrt-cli',
    )?.directory,
  });
  const intentRows = intentSource ? loadIntentRows(intentSource) : [];

  const content = generateMarkdown(
    packages,
    rootDocs.length > 0 ? rootDocs : undefined,
    sdkPackages.length > 0 ? sdkPackages : undefined,
    generatedBy,
    {
      complete: options.complete,
      intentSection: renderIntentSection(
        intentRows,
        installedVersions,
        BUNDLE_DIR_NAME,
      ),
    },
  );

  const agentsBlockInputs = (intentsExported: boolean): AgentsBlockInputs => {
    const versioned =
      bundlePackages.find((pkg) => pkg.name === '@happyvertical/smrt-cli') ??
      bundlePackages.find((pkg) => pkg.name === '@happyvertical/smrt-core');
    const bundleRel = relativePath(
      resolve(docsRoot.root),
      resolve(dirname(absoluteOutput), BUNDLE_DIR_NAME),
    );
    return {
      version: versioned?.version,
      versionPackage: versioned?.name,
      frameworkPath: relativePath(
        resolve(docsRoot.root),
        resolve(absoluteOutput),
      ),
      intentIndexPath: intentsExported
        ? `${bundleRel}/intents/index.md`
        : undefined,
    };
  };

  const wantBlock = options.agentsBlock !== false;

  if (dryRun) {
    log.out(content);
    // stdout carries the document, so the block report goes to stderr.
    if (wantBlock) {
      const blockResult = applyAgentsBlock({
        root: docsRoot.root,
        block: renderAgentsBlock(
          agentsBlockInputs(
            filterInstalledIntents(intentRows, installedVersions).length > 0 &&
              intentSource !== null,
          ),
        ),
        dryRun: true,
      });
      reportAgentsBlock(blockResult, true, cwd, log, warnings);
    }
    return result('written');
  }

  const outputDir = dirname(absoluteOutput);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(absoluteOutput, content, 'utf-8');

  const bundle: BundleExportResult | null = exportKnowledgeBundle({
    bundleDir: join(outputDir, BUNDLE_DIR_NAME),
    packages: bundlePackages,
    monorepoRoot,
    intentSource,
    intentRows,
    exportedBy: generatedBy,
  });

  // Export the merged cross-package knowledge graph (#2863) alongside the
  // per-package snapshot, when this run is inside the monorepo that generated
  // one. A consumer app installing individual packages has no root graph.
  let graphExported = false;
  if (monorepoRoot) {
    const graphPath = join(monorepoRoot, '.smrt', 'smrt-knowledge-graph.json');
    if (existsSync(graphPath)) {
      // A stale graph must not be copied out as if it were current. Fail
      // rather than regenerate: this command reads artifacts, it does not own
      // the scanner run `pnpm knowledge:graph` needs (#2872 review).
      const graphErrors = checkKnowledgeGraphFreshness(
        monorepoRoot,
        '.smrt/smrt-knowledge-graph.json',
        { requireArtifact: true },
      ).filter((issue) => issue.severity === 'error');
      if (graphErrors.length > 0) {
        return result('failed', {
          code: 'stale-graph',
          message:
            'Cross-package knowledge graph is stale; run `pnpm knowledge:graph` first:',
          details: graphErrors.map(
            (issue) => `${issue.code}: ${issue.message}`,
          ),
        });
      }
      writeFileSync(
        join(outputDir, 'smrt-knowledge-graph.json'),
        readFileSync(graphPath, 'utf-8'),
      );
      graphExported = true;
    }
  }

  // Skills (#4708): installed under the docs root. The smrt repository itself
  // (root package @happyvertical/smrt, not any pnpm monorepo) also gets
  // smrt-contribute (#4709).
  const skillResults =
    options.skills === false
      ? []
      : installAgentSkills({
          projectRoot: docsRoot.root,
          bundleDir: relativePath(
            resolve(docsRoot.root),
            resolve(outputDir, BUNDLE_DIR_NAME),
          ),
          skills: isSmrtRepository(monorepoRoot)
            ? ['smrt-catalog', 'smrt-contribute']
            : ['smrt-catalog'],
          generatedBy,
          warn: (message) => {
            warnings.push(message.trim());
            // The command's historical channel is console.warn.
            (options.log?.err ?? console.warn)(message);
          },
        });

  // AGENTS.md block (#4878): never fails the command.
  let agentsBlock: AgentsBlockResult | null = null;
  if (wantBlock) {
    agentsBlock = applyAgentsBlock({
      root: docsRoot.root,
      block: renderAgentsBlock(agentsBlockInputs((bundle?.intents ?? 0) > 0)),
    });
  }

  const totalPackages = packages.length + sdkPackages.length;
  say(`\n✅ Generated ${outputPath}`);
  say(`   ${totalPackages} packages documented`);
  if (packages.length > 0) say(`   ${packages.length} SMRT packages`);
  if (sdkPackages.length > 0) say(`   ${sdkPackages.length} SDK packages`);
  const allPackages = [...packages, ...sdkPackages];
  const withAgentDocs = allPackages.filter((p) => p.agentMd).length;
  if (withAgentDocs > 0) say(`   ${withAgentDocs} with AGENTS.md`);
  const moduleDocCount = allPackages.reduce(
    (total, p) =>
      total + (p.moduleDocPaths?.length ?? p.moduleDocs?.length ?? 0),
    0,
  );
  if (moduleDocCount > 0) say(`   ${moduleDocCount} linked module docs`);
  if (rootDocs.length > 0) {
    say(`   ${rootDocs.length} framework documents included`);
  }
  if (graphExported) say('   cross-package knowledge graph exported');
  if (bundle) {
    say(
      `   knowledge bundle exported to ${join(dirname(outputPath), BUNDLE_DIR_NAME)} (${bundle.components} component pages, ${bundle.intents} intent pages)`,
    );
    if (bundle.withoutPages.length > 0) {
      say(
        `   ${bundle.withoutPages.length} installed packages ship no knowledge page`,
      );
    }
  }
  const written = skillResults.filter(
    (r) => r.status === 'installed' || r.status === 'updated',
  );
  if (written.length > 0) {
    say(
      `   ${written.length} agent skill files written (${[...new Set(written.map((r) => r.skill))].join(', ')})`,
    );
  }
  if (agentsBlock) {
    reportAgentsBlock(
      agentsBlock,
      false,
      cwd,
      verbose ? log : { ...log, out: () => {} },
      warnings,
    );
  }
  say('');
  return result('written');
}

/**
 * {@link refreshAgentDocs} for lifecycle callers: catches everything, never
 * exits, and reports a failure (including the stale-graph one) as a warning on
 * the result and through `log.err` instead of throwing. Quiet unless something
 * needs saying.
 */
export async function safeRefreshAgentDocs(
  options: RefreshAgentDocsOptions = {},
): Promise<RefreshAgentDocsResult> {
  const cwd = options.cwd ?? process.cwd();
  const emit = (text: string): void => {
    try {
      (options.log?.err ?? console.error)(text);
    } catch {
      // A broken sink must not fail the caller either.
    }
  };
  try {
    const result = await refreshAgentDocs({ verbose: false, ...options });
    if (result.status === 'failed' && result.failure) {
      const text = `agent docs refresh failed: ${[result.failure.message, ...(result.failure.details ?? [])].join(' ')}`;
      result.warnings.push(text);
      emit(text);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = `agent docs refresh failed: ${message}`;
    emit(text);
    return {
      status: 'failed',
      root: cwd,
      warnings: [text],
      failure: { code: 'error', message },
    };
  }
}
