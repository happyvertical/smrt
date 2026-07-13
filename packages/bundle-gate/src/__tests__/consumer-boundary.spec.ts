/**
 * Consumer bundle reachability and size regression gate (#1978/#1980).
 *
 * The SMRT 0.39.7 release made heavyweight messaging-provider SDKs
 * (googleapis, nodemailer, imapflow, mailparser, @slack/web-api, and the
 * @happyvertical/email//messages/files SDK wrappers around them) reachable
 * from provider-neutral chat/persona imports:
 *
 *   app → smrt-chat → smrt-personas → smrt-messages (root barrel)
 *       → EmailAccount.createClient() / SlackSender.send() / TweetSender.send()
 *       → await import('@happyvertical/email' | '@happyvertical/messages')
 *
 * SvelteKit's production server build bundles every dependency by default
 * (ssr.noExternal semantics — only `ssr.external` opts out), and Rollup
 * follows statically-analyzable dynamic imports, so "lazy at runtime" still
 * meant ~90 MB of provider SDK code in downstream server output and a
 * 4 GB heap exhaustion while writing the chunk + sourcemap (Ergot rehearsal:
 * server output 18 MB → 109 MB, largest chunk 31.6 MB).
 *
 * This gate rebuilds that consumer viewpoint deterministically:
 *
 *  - It bundles fixture entries with `vite build` in SSR mode with
 *    `ssr.noExternal: true`, resolving the workspace packages through their
 *    package.json export maps (dist output — the same files npm consumers
 *    get). Run `pnpm build` for chat/personas/messages before this test;
 *    in CI turbo's `test` task already depends on `^build`.
 *  - A resolveId guard records every attempt to resolve a forbidden provider
 *    module together with its importer, then externalizes it so a regression
 *    reports every offending edge instead of spending minutes (and gigabytes)
 *    bundling provider SDKs.
 *  - The provider-neutral fixture must resolve zero forbidden modules and
 *    stay under a coarse size budget. The explicit-provider fixture must
 *    still reach the SDK wrappers, proving providers remain available.
 *
 * ## Updating the size budgets intentionally
 *
 * The budgets are coarse ceilings, not golden numbers — ordinary chunk
 * rearrangement or bundler patch releases should never trip them. If a
 * legitimate feature grows the neutral surface, rerun this spec, read the
 * "[bundle-gate]" report line it prints, and raise the budget to roughly
 * 1.5× the new measured size in the same change that grows the surface,
 * with a sentence in the PR description explaining the growth. If the gate
 * instead fails on FORBIDDEN modules, do not touch the budget — a provider
 * SDK became reachable and the reported import chain is the bug.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, 'fixtures', name);

/**
 * Messaging-provider SDKs (and their SDK wrappers) that must never be
 * reachable from a provider-neutral consumer surface. Matched against raw
 * import specifiers and resolved module ids.
 */
const FORBIDDEN_PROVIDER_MODULES = [
  // SDK wrappers whose roots statically import the heavy vendors.
  '@happyvertical/email',
  '@happyvertical/messages',
  '@happyvertical/files',
  // The heavy vendors themselves, in case a future edge skips the wrappers.
  // 'google-auth-library' is deliberately NOT listed: the @happyvertical/ai
  // stack reaches it through @google/genai (a small auth client, pre-existing
  // since before 0.39.x) — the messaging regression marker is googleapis.
  'googleapis',
  'nodemailer',
  'imapflow',
  'mailparser',
  'node-pop3',
  '@slack/web-api',
  '@aws-sdk/client-s3',
];

/**
 * Native/driver modules a real deployment keeps external (SvelteKit consumers
 * list these in `ssr.external`, e.g. sharp/resvg in Ergot). Kept external here
 * so the fixture builds match deployment reality and stay CI-fast.
 */
const RUNTIME_EXTERNAL = [
  'better-sqlite3',
  'pg',
  'pg-native',
  'pg-query-stream',
  'duckdb',
  '@duckdb/node-api',
  '@duckdb/node-bindings',
  'sharp',
  'bufferutil',
  'utf-8-validate',
];

/**
 * Coarse ceilings — see "Updating the size budgets intentionally" above.
 * Measured 2026-07-12 after the #1979 boundary repair: 12.55 MB total,
 * 7.44 MB largest chunk. Budgets sit at ~2× measured; any single messaging
 * provider SDK regression adds ≥20 MB and blows straight through them.
 */
const NEUTRAL_TOTAL_OUTPUT_BUDGET_BYTES = 25 * 1024 * 1024;
const NEUTRAL_LARGEST_CHUNK_BUDGET_BYTES = 15 * 1024 * 1024;

interface ForbiddenHits {
  /** forbidden specifier/id → importers that requested it */
  map: Map<string, Set<string>>;
}

function matchForbidden(id: string): string | undefined {
  return FORBIDDEN_PROVIDER_MODULES.find(
    (name) =>
      id === name ||
      id.startsWith(`${name}/`) ||
      id.includes(`/node_modules/${name}/`),
  );
}

/**
 * Records every resolution attempt for a forbidden module and externalizes it,
 * so a regressed graph reports all offending edges without bundling ~200 MB of
 * provider SDK code (the failure mode that exhausted a 4 GB heap downstream).
 */
function providerBoundaryGuard(hits: ForbiddenHits): Plugin {
  return {
    name: 'smrt-provider-boundary-guard',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!matchForbidden(source)) return null;
      const importers = hits.map.get(source) ?? new Set<string>();
      if (importer) importers.add(importer);
      hits.map.set(source, importers);
      return { id: source, external: true };
    },
  };
}

function formatHits(hits: ForbiddenHits): string {
  return [...hits.map.entries()]
    .map(
      ([specifier, importers]) =>
        `${specifier}\n${[...importers].map((i) => `    imported by ${i}`).join('\n')}`,
    )
    .join('\n');
}

interface FixtureBuildResult {
  hits: ForbiddenHits;
  /** Module ids that ended up inside emitted chunks. */
  bundledModuleIds: string[];
  totalBytes: number;
  largestChunk: { fileName: string; bytes: number };
  chunkCount: number;
}

async function buildConsumerFixture(
  entryFile: string,
): Promise<FixtureBuildResult> {
  const outDir = await mkdtemp(path.join(tmpdir(), 'smrt-bundle-gate-'));
  const hits: ForbiddenHits = { map: new Map() };
  try {
    const result = (await build({
      configFile: false,
      logLevel: 'error',
      plugins: [providerBoundaryGuard(hits)],
      build: {
        ssr: true,
        outDir,
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        target: 'node20',
        rollupOptions: {
          input: { server: entryFile },
        },
      },
      ssr: {
        // SvelteKit adapter parity: production server builds bundle every
        // dependency unless explicitly listed in ssr.external.
        noExternal: true,
        external: RUNTIME_EXTERNAL,
      },
    })) as Rollup.RollupOutput;

    const chunks = result.output.filter(
      (item): item is Rollup.OutputChunk => item.type === 'chunk',
    );
    const bundledModuleIds = chunks.flatMap((chunk) =>
      Object.keys(chunk.modules),
    );
    let totalBytes = 0;
    let largestChunk = { fileName: '<none>', bytes: 0 };
    for (const item of result.output) {
      const bytes =
        item.type === 'chunk'
          ? Buffer.byteLength(item.code)
          : typeof item.source === 'string'
            ? Buffer.byteLength(item.source)
            : item.source.byteLength;
      totalBytes += bytes;
      if (item.type === 'chunk' && bytes > largestChunk.bytes) {
        largestChunk = { fileName: item.fileName, bytes };
      }
    }
    return {
      hits,
      bundledModuleIds,
      totalBytes,
      largestChunk,
      chunkCount: chunks.length,
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

describe('consumer bundle boundary (#1978/#1980)', () => {
  it('provider-neutral chat/persona/message imports never reach messaging-provider SDKs and stay within budget', async () => {
    const result = await buildConsumerFixture(fixture('consumer-neutral.ts'));

    // Reachability contract: no forbidden module may even be *resolved* from
    // the provider-neutral graph. On failure the message lists each forbidden
    // specifier with the modules that imported it.
    expect(
      formatHits(result.hits),
      'forbidden messaging-provider modules became reachable from the provider-neutral consumer surface',
    ).toBe('');

    // Belt and braces: nothing forbidden made it into an emitted chunk either.
    const bundledForbidden = result.bundledModuleIds.filter(matchForbidden);
    expect(bundledForbidden).toEqual([]);

    // CI visibility + budget. Coarse on purpose; see header for update rules.
    console.log(
      `[bundle-gate] neutral server output: total ${megabytes(result.totalBytes)}` +
        ` across ${result.chunkCount} chunks; largest chunk ${result.largestChunk.fileName}` +
        ` at ${megabytes(result.largestChunk.bytes)}` +
        ` (budgets: total ${megabytes(NEUTRAL_TOTAL_OUTPUT_BUDGET_BYTES)},` +
        ` largest ${megabytes(NEUTRAL_LARGEST_CHUNK_BUDGET_BYTES)})`,
    );
    expect(
      result.totalBytes,
      `total server output ${megabytes(result.totalBytes)} exceeded the ${megabytes(
        NEUTRAL_TOTAL_OUTPUT_BUDGET_BYTES,
      )} budget — if this growth is intentional, follow the budget-update instructions in this spec's header`,
    ).toBeLessThan(NEUTRAL_TOTAL_OUTPUT_BUDGET_BYTES);
    expect(
      result.largestChunk.bytes,
      `largest chunk ${result.largestChunk.fileName} (${megabytes(
        result.largestChunk.bytes,
      )}) exceeded the ${megabytes(NEUTRAL_LARGEST_CHUNK_BUDGET_BYTES)} budget`,
    ).toBeLessThan(NEUTRAL_LARGEST_CHUNK_BUDGET_BYTES);
  });

  it('explicit provider entry points still make the provider SDK wrappers reachable', async () => {
    const result = await buildConsumerFixture(
      fixture('consumer-with-providers.ts'),
    );

    const reached = [...result.hits.map.keys()];
    expect(
      reached.some((id) => matchForbidden(id) === '@happyvertical/email'),
      `expected '@happyvertical/smrt-messages/providers/all' to make @happyvertical/email reachable; reached: ${reached.join(', ') || '<nothing>'}`,
    ).toBe(true);
    expect(
      reached.some((id) => matchForbidden(id) === '@happyvertical/messages'),
      `expected '@happyvertical/smrt-messages/providers/all' to make @happyvertical/messages reachable; reached: ${reached.join(', ') || '<nothing>'}`,
    ).toBe(true);
  });
});
