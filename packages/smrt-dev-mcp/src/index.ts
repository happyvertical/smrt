/**
 * SMRT Development MCP Server
 * Provides code generation, project introspection, knowledge context,
 * review/architecture prompt bundles, and portable agent skills.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { getAgentSkill, listAgentSkills } from './agent-skills.js';
import {
  buildArchitectureContext,
  buildKnowledgeIndex,
  buildPackageSpecialistContext,
  buildReviewContext,
  checkKnowledgeFreshness,
  checkKnowledgeFreshnessFromIndex,
  packageDocPaths,
  smrtArchitecture,
  smrtReview,
} from './knowledge/index.js';
import { REVIEW_SKILL_NAME, TOOLS } from './tool-catalog.js';
import {
  generateSmrtClass,
  introspectProject,
  reviewSmrtProject,
} from './tools/index.js';

export { TOOLS } from './tool-catalog.js';

const SERVER_NAME = 'smrt-dev-mcp';
export const SERVER_VERSION = readPackageVersion();
const DEBUG = process.env.DEBUG === 'true';
const REVIEW_SKILL_URI = `smrt-dev-mcp://agent-skills/${REVIEW_SKILL_NAME}`;
const DOMAIN_CODE_REVIEW_PROMPT = 'domain-code-review';
const DOMAIN_ARCHITECTURE_PROMPT = 'domain-architecture';
const KNOWLEDGE_PROJECT_URI = 'smrt://knowledge/project';
const KNOWLEDGE_PACKAGE_PREFIX = 'smrt://knowledge/package/';
const DEPLOY_STATIC_CATALOG_CACHE_HINT = {
  ttlMs: 86_400_000,
  cacheScope: 'private' as const,
};
// Knowledge resources are rebuilt from the workspace on every request. There
// is no transport-visible project-graph invalidation signal, so a nonzero TTL
// would promise stale data could not be served after an edit.
const LIVE_KNOWLEDGE_CACHE_HINT = {
  ttlMs: 0,
  cacheScope: 'private' as const,
};
const WORKBENCH_PROJECT_URI = 'smrt://workbench/project';
const WORKBENCH_PACKAGE_PREFIX = 'smrt://workbench/package/';
const WORKBENCH_SPECIALIST_SUFFIX = '/specialist';

type KnowledgeIndexResult = Awaited<ReturnType<typeof buildKnowledgeIndex>>;
type KnowledgePackageResult = KnowledgeIndexResult['packages'][number];
type PackageSpecialistResult = Awaited<
  ReturnType<typeof buildPackageSpecialistContext>
>;
type PromptArguments = Record<string, string> | undefined;

export function createServer(): Server {
  if (DEBUG) {
    console.error(`[${SERVER_NAME}] Starting server v${SERVER_VERSION}`);
  }

  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
      cacheHints: {
        'tools/list': DEPLOY_STATIC_CATALOG_CACHE_HINT,
        'prompts/list': DEPLOY_STATIC_CATALOG_CACHE_HINT,
        'resources/list': LIVE_KNOWLEDGE_CACHE_HINT,
        'resources/read': LIVE_KNOWLEDGE_CACHE_HINT,
      },
    },
  );

  // List tools handler
  server.setRequestHandler('tools/list', async () => {
    if (DEBUG) {
      console.error(`[${SERVER_NAME}] ListTools request`);
    }
    return { tools: TOOLS };
  });

  server.setRequestHandler('prompts/list', async () => {
    return {
      prompts: [
        {
          name: REVIEW_SKILL_NAME,
          title: 'SMRT Code Review',
          description:
            'Harness-agnostic downstream SMRT review procedure that uses smrt-dev-mcp deterministic context and prompt bundles.',
        },
        {
          name: DOMAIN_CODE_REVIEW_PROMPT,
          title: 'Domain Code Review',
          description:
            'Model-ready domain-scoped SMRT code review prompt bundle.',
          arguments: [
            {
              name: 'rootDir',
              description: 'Project root directory. Defaults to server cwd.',
              required: false,
            },
            {
              name: 'changedFiles',
              description:
                'Changed file paths as newline-separated, comma-separated, or JSON array text.',
              required: false,
            },
            {
              name: 'focus',
              description: 'Review focus text.',
              required: false,
            },
            {
              name: 'documentation',
              description: 'Additional documentation or notes.',
              required: false,
            },
            {
              name: 'scope',
              description:
                'Knowledge scope: project, local, package, sdk, or installed.',
              required: false,
            },
            {
              name: 'package',
              description: 'Package name or short package selector.',
              required: false,
            },
          ],
        },
        {
          name: DOMAIN_ARCHITECTURE_PROMPT,
          title: 'Domain Architecture',
          description:
            'Model-ready domain-scoped SMRT architecture planning prompt bundle.',
          arguments: [
            {
              name: 'rootDir',
              description: 'Project root directory. Defaults to server cwd.',
              required: false,
            },
            {
              name: 'idea',
              description: 'Architecture idea or product concept.',
              required: false,
            },
            {
              name: 'documentation',
              description: 'Additional documentation or notes.',
              required: false,
            },
            {
              name: 'focus',
              description: 'Planning focus text.',
              required: false,
            },
            {
              name: 'scope',
              description:
                'Knowledge scope: project, local, package, sdk, or installed.',
              required: false,
            },
            {
              name: 'package',
              description: 'Package name or short package selector.',
              required: false,
            },
          ],
        },
      ],
    };
  });

  server.setRequestHandler('prompts/get', async (request) => {
    const { name } = request.params;
    if (name === REVIEW_SKILL_NAME) {
      return {
        description:
          'Use this procedure when reviewing downstream SMRT projects.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: renderAgentSkillMarkdown(REVIEW_SKILL_NAME),
            },
          },
        ],
      };
    }

    if (name === DOMAIN_CODE_REVIEW_PROMPT) {
      const context = await buildReviewContext(
        reviewPromptArguments(request.params.arguments),
      );
      return {
        description: 'Review downstream SMRT code with domain knowledge.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: context.promptBundle.contextMarkdown,
            },
          },
        ],
      };
    }

    if (name === DOMAIN_ARCHITECTURE_PROMPT) {
      const context = await buildArchitectureContext(
        architecturePromptArguments(request.params.arguments),
      );
      return {
        description: 'Plan a downstream SMRT project with domain knowledge.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: context.promptBundle.contextMarkdown,
            },
          },
        ],
      };
    }

    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown prompt: ${name}`,
    );
  });

  server.setRequestHandler('resources/list', async () => {
    const index = await buildKnowledgeIndex();
    return {
      resources: [
        {
          uri: REVIEW_SKILL_URI,
          name: REVIEW_SKILL_NAME,
          title: 'SMRT Code Review Skill',
          description:
            'Bundled Markdown skill for downstream SMRT code reviews.',
          mimeType: 'text/markdown',
        },
        {
          uri: KNOWLEDGE_PROJECT_URI,
          name: 'smrt-domain-knowledge-project',
          title: 'SMRT Domain Knowledge Project Index',
          description:
            'Composed SMRT, downstream domain, and HappyVertical SDK knowledge index.',
          mimeType: 'application/json',
        },
        {
          uri: WORKBENCH_PROJECT_URI,
          name: 'smrt-workbench-project',
          title: 'SMRT Workbench Project',
          description:
            'Workbench-facing package and knowledge resource index for the current project.',
          mimeType: 'application/json',
        },
        ...index.packages.map((pkg) => ({
          uri: `${KNOWLEDGE_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}`,
          name: `smrt-domain-knowledge-${pkg.name}`,
          title: `SMRT Domain Knowledge: ${pkg.name}`,
          description:
            'Package-scoped SMRT domain knowledge, generated surfaces, and authored context.',
          mimeType: 'application/json',
        })),
        ...index.packages
          .filter((pkg) => pkg.kind !== 'sdk')
          .flatMap((pkg) => [
            {
              uri: `${WORKBENCH_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}`,
              name: `smrt-workbench-${pkg.name}`,
              title: `SMRT Workbench Package: ${pkg.name}`,
              description:
                'Workbench package resource with docs, manifest, knowledge, scripts, and surface metadata.',
              mimeType: 'application/json',
            },
            {
              uri: `${WORKBENCH_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}${WORKBENCH_SPECIALIST_SUFFIX}`,
              name: `smrt-workbench-specialist-${pkg.name}`,
              title: `SMRT Package Specialist: ${pkg.name}`,
              description:
                'Deterministic package specialist prompt bundle and source list.',
              mimeType: 'application/json',
            },
          ]),
      ],
    };
  });

  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    if (uri === REVIEW_SKILL_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: renderAgentSkillMarkdown(REVIEW_SKILL_NAME),
          },
        ],
      };
    }

    if (uri === KNOWLEDGE_PROJECT_URI) {
      const index = await buildKnowledgeIndex();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sanitizeKnowledgeIndex(index), null, 2),
          },
        ],
      };
    }

    if (uri === WORKBENCH_PROJECT_URI) {
      const index = await buildKnowledgeIndex();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                project: sanitizeKnowledgeIndex(index),
                workbenchResources: index.packages
                  .filter((pkg) => pkg.kind !== 'sdk')
                  .map((pkg) => ({
                    packageName: pkg.name,
                    packageUri: `${WORKBENCH_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}`,
                    specialistUri: `${WORKBENCH_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}${WORKBENCH_SPECIALIST_SUFFIX}`,
                  })),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (
      uri.startsWith(WORKBENCH_PACKAGE_PREFIX) &&
      uri.endsWith(WORKBENCH_SPECIALIST_SUFFIX)
    ) {
      const packageName = decodeURIComponent(
        uri.slice(
          WORKBENCH_PACKAGE_PREFIX.length,
          -WORKBENCH_SPECIALIST_SUFFIX.length,
        ),
      );
      const specialist = await buildPackageSpecialistContext({
        package: packageName,
      });
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              sanitizePackageSpecialist(specialist),
              null,
              2,
            ),
          },
        ],
      };
    }

    if (uri.startsWith(WORKBENCH_PACKAGE_PREFIX)) {
      const packageName = decodeURIComponent(
        uri.slice(WORKBENCH_PACKAGE_PREFIX.length),
      );
      const index = await buildKnowledgeIndex();
      const pkg = index.packages.find((item) => item.name === packageName);
      if (!pkg) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown workbench package: ${packageName}`,
        );
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                package: sanitizeKnowledgePackage(pkg),
                specialistUri: `${WORKBENCH_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}${WORKBENCH_SPECIALIST_SUFFIX}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (uri.startsWith(KNOWLEDGE_PACKAGE_PREFIX)) {
      const packageName = decodeURIComponent(
        uri.slice(KNOWLEDGE_PACKAGE_PREFIX.length),
      );
      const index = await buildKnowledgeIndex();
      const pkg = index.packages.find((item) => item.name === packageName);
      if (!pkg) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown knowledge package: ${packageName}`,
        );
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sanitizeKnowledgePackage(pkg), null, 2),
          },
        ],
      };
    }

    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown resource: ${uri}`,
    );
  });

  // Call tool handler
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;

    if (DEBUG) {
      console.error(`[${SERVER_NAME}] CallTool: ${name}`);
      console.error(
        `[${SERVER_NAME}] Arguments:`,
        JSON.stringify(args, null, 2),
      );
    }

    try {
      let result: string;

      switch (name) {
        case 'generate-smrt-class':
          result = await generateSmrtClass(
            args as unknown as Parameters<typeof generateSmrtClass>[0],
          );
          break;

        case 'introspect-project':
          result = await introspectProject(
            args as unknown as Parameters<typeof introspectProject>[0],
          );
          break;

        case 'review-smrt-project':
          result = await reviewSmrtProject(
            args as unknown as Parameters<typeof reviewSmrtProject>[0],
          );
          break;

        case 'reflect-knowledge': {
          const index = await buildKnowledgeIndex(
            args as unknown as Parameters<typeof buildKnowledgeIndex>[0],
          );
          const freshness = await checkKnowledgeFreshnessFromIndex(
            index,
            args as unknown as Parameters<
              typeof checkKnowledgeFreshnessFromIndex
            >[1],
          );
          result = JSON.stringify(
            {
              rootDir: index.rootDir,
              packageCount: index.packages.length,
              smrtPackageCount: index.smrtPackages.length,
              sdkPackageCount: index.sdkPackages.length,
              relationshipsV2: index.relationshipsV2,
              coverage: index.coverage,
              diagnostics: index.diagnostics,
              freshness,
            },
            null,
            2,
          );
          break;
        }

        case 'reflect-domain-knowledge': {
          const index = await buildKnowledgeIndex(
            args as unknown as Parameters<typeof buildKnowledgeIndex>[0],
          );
          const freshness = await checkKnowledgeFreshnessFromIndex(
            index,
            args as unknown as Parameters<
              typeof checkKnowledgeFreshnessFromIndex
            >[1],
          );
          result = JSON.stringify(
            {
              rootDir: index.rootDir,
              packageCount: index.packages.length,
              smrtPackageCount: index.smrtPackages.length,
              sdkPackageCount: index.sdkPackages.length,
              domainKnowledgePackageCount: index.packages.filter(
                (pkg) => pkg.hasDomainKnowledge,
              ).length,
              missingDomainKnowledgePackages: index.packages
                .filter(
                  (pkg) =>
                    pkg.exportKeys.includes('./smrt-knowledge.json') &&
                    !pkg.hasDomainKnowledge,
                )
                .map((pkg) => pkg.name),
              relationshipsV2: index.relationshipsV2,
              coverage: index.coverage,
              diagnostics: index.diagnostics,
              freshness,
            },
            null,
            2,
          );
          break;
        }

        case 'check-knowledge-freshness':
          result = JSON.stringify(
            await checkKnowledgeFreshness(
              args as unknown as Parameters<typeof checkKnowledgeFreshness>[0],
            ),
            null,
            2,
          );
          break;

        case 'check-domain-knowledge':
          result = JSON.stringify(
            await checkKnowledgeFreshness(
              args as unknown as Parameters<typeof checkKnowledgeFreshness>[0],
            ),
            null,
            2,
          );
          break;

        case 'build-review-context':
        case 'build-domain-review-context':
          result = JSON.stringify(
            compactContextResult(
              await buildReviewContext(
                args as unknown as Parameters<typeof buildReviewContext>[0],
              ),
              detailArg(args),
            ),
            null,
            2,
          );
          break;

        case 'smrt-review':
          result = JSON.stringify(
            compactContextResult(
              await smrtReview(
                args as unknown as Parameters<typeof smrtReview>[0],
              ),
              detailArg(args),
            ),
            null,
            2,
          );
          break;

        case 'build-package-specialist-context':
          result = JSON.stringify(
            sanitizePackageSpecialist(
              await buildPackageSpecialistContext(
                args as unknown as Parameters<
                  typeof buildPackageSpecialistContext
                >[0],
              ),
            ),
            null,
            2,
          );
          break;

        case 'build-architecture-context':
        case 'build-domain-architecture-context':
          result = JSON.stringify(
            compactContextResult(
              await buildArchitectureContext(
                args as unknown as Parameters<
                  typeof buildArchitectureContext
                >[0],
              ),
              detailArg(args),
            ),
            null,
            2,
          );
          break;

        case 'smrt-architecture':
          result = JSON.stringify(
            compactContextResult(
              await smrtArchitecture(
                args as unknown as Parameters<typeof smrtArchitecture>[0],
              ),
              detailArg(args),
            ),
            null,
            2,
          );
          break;

        case 'list-agent-skills':
          result = JSON.stringify({ skills: listAgentSkills() }, null, 2);
          break;

        case 'get-agent-skill':
          result = JSON.stringify(
            await getAgentSkill(
              args as unknown as Parameters<typeof getAgentSkill>[0],
            ),
            null,
            2,
          );
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
        structuredContent: toDevToolStructuredContent(result),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${SERVER_NAME}] Error:`, error);

      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool ${name}: ${errorMessage}`,
          },
        ],
        isError: true,
        structuredContent: {
          ok: false,
          coverage: null,
          diagnostics: [{ severity: 'error', message: errorMessage }],
          data: null,
        },
      };
    }
  });

  return server;
}

async function main() {
  const handle = serveStdio(() => createServer(), {
    onerror: (error) =>
      console.error(`[${SERVER_NAME}] Protocol error:`, error),
  });

  if (DEBUG) {
    console.error(`[${SERVER_NAME}] Server connected via stdio`);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    if (DEBUG) {
      console.error(`[${SERVER_NAME}] Shutting down...`);
    }
    await handle.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (DEBUG) {
      console.error(`[${SERVER_NAME}] Shutting down...`);
    }
    await handle.close();
    process.exit(0);
  });
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

function readPackageVersion(): string {
  try {
    const packageRoot = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(packageRoot, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function renderAgentSkillMarkdown(name: string): string {
  const skill = getAgentSkill({ name, includeReferences: true });
  const references = skill.referenceFiles.map(
    (file) => `## Reference: ${file.path}\n\n${file.content.trim()}`,
  );
  return [skill.skillMarkdown.trim(), ...references].join('\n\n');
}

function reviewPromptArguments(args: PromptArguments): Record<string, unknown> {
  return compactRecord({
    rootDir: args?.rootDir,
    changedFiles: parseStringList(args?.changedFiles),
    focus: args?.focus,
    documentation: args?.documentation,
    scope: args?.scope,
    package: args?.package,
  });
}

function architecturePromptArguments(
  args: PromptArguments,
): Record<string, unknown> {
  return compactRecord({
    rootDir: args?.rootDir,
    idea: args?.idea,
    documentation: args?.documentation,
    focus: args?.focus,
    scope: args?.scope,
    package: args?.package,
  });
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Fall through to delimiter parsing.
  }

  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function sanitizeKnowledgeIndex(index: KnowledgeIndexResult) {
  const packages = index.packages.map((pkg) => sanitizeKnowledgePackage(pkg));
  return {
    ...index,
    rootDir: '.',
    packages,
    smrtPackages: packages.filter((pkg) => pkg.kind === 'smrt'),
    sdkPackages: packages.filter((pkg) => pkg.kind === 'sdk'),
    // Rebuilt from the sanitized list rather than carried over by the spread.
    // Installed dependencies live outside the project root, so theirs are the
    // absolute host paths this projection exists to strip (#2275).
    installedPackages: packages.filter((pkg) => pkg.isInstalledDependency),
  };
}

/**
 * Compact projection of a context result for MCP callers (#2143).
 *
 * `selectedPackages` carries each package's whole authored `agentDoc`, its
 * module-doc contents, and its full domain manifest. A three-package downstream
 * product serialized to 329,003 characters that way, which is what made these
 * tools unusable as planning aids. `detail: "full"` returns the whole shape.
 */
function compactContextResult(
  result: object,
  detail: string | undefined,
): Record<string, unknown> {
  const source = result as Record<string, unknown>;
  if (detail === 'full') return source;

  const compact: Record<string, unknown> = { ...source, detail: 'summary' };
  for (const key of ['selectedPackages', 'selectedSdkPackages']) {
    const packages = source[key];
    if (!Array.isArray(packages)) continue;
    compact[key] = (packages as KnowledgePackageResult[]).map(
      compactKnowledgePackage,
    );
  }
  return compact;
}

function compactKnowledgePackage(pkg: KnowledgePackageResult) {
  return {
    name: pkg.name,
    version: pkg.version,
    kind: pkg.kind,
    directory: pkg.relativeDirectory,
    objectSource: pkg.objectSource,
    ...(pkg.objectSourceReason
      ? { objectSourceReason: pkg.objectSourceReason }
      : {}),
    // Paths, not prose: the caller reads what it needs.
    docs: packageDocPaths(pkg),
    domainKnowledgePath: pkg.domainKnowledgePath,
    relationshipFeatures: pkg.relationshipFeatures,
    smrtDependencies: pkg.smrtDependencies,
    sdkDependencies: pkg.sdkDependencies,
    exportKeys: pkg.exportKeys,
    objectCount: pkg.objects.length,
    objects: pkg.objects.map((object) =>
      object.tableName
        ? `${object.qualifiedName ?? object.className} (${object.tableName})`
        : (object.qualifiedName ?? object.className),
    ),
    mcpToolCount: pkg.mcpTools.length,
  };
}

function detailArg(args: unknown): string | undefined {
  const detail = (args as Record<string, unknown> | undefined)?.detail;
  return typeof detail === 'string' ? detail : undefined;
}

function toDevToolStructuredContent(result: string) {
  let data: unknown = result;
  try {
    data = JSON.parse(result);
  } catch {
    // `generate-smrt-class` intentionally returns source text, not JSON.
  }

  const source = isRecord(data) ? data : undefined;
  const coverage = isRecord(source?.coverage) ? source.coverage : null;
  const diagnostics = Array.isArray(source?.diagnostics)
    ? source.diagnostics.filter(isRecord)
    : [];
  return { ok: true, coverage, diagnostics, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeKnowledgePackage(pkg: KnowledgePackageResult) {
  const { directory: _directory, objects, checkedObjectPaths, ...rest } = pkg;
  return {
    ...rest,
    // Paths outside the workspace root stay absolute in the index; redact them
    // here the same way object file paths are redacted.
    checkedObjectPaths: checkedObjectPaths.map(
      (path) => sanitizePath(path) ?? path,
    ),
    objects: objects.map((object) => ({
      ...object,
      filePath: sanitizePath(object.filePath),
    })),
  };
}

function sanitizePackageSpecialist(specialist: PackageSpecialistResult) {
  return {
    selectedPackage: sanitizeKnowledgePackage(specialist.selectedPackage),
    selectedSdkPackages: specialist.selectedSdkPackages.map((pkg) =>
      sanitizeKnowledgePackage(pkg),
    ),
    promptBundle: {
      ...specialist.promptBundle,
      contextMarkdown: specialist.promptBundle.contextMarkdown.replace(
        /^Baseline root: .+$/m,
        'Baseline root: .',
      ),
      sourceFiles: sanitizePaths(specialist.promptBundle.sourceFiles),
    },
    sourceFiles: sanitizePaths(specialist.sourceFiles),
  };
}

function sanitizePaths(paths: string[]): string[] {
  return paths
    .map(sanitizePath)
    .filter((path): path is string => typeof path === 'string');
}

function sanitizePath(path: string | undefined): string | undefined {
  if (!path) return path;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    return '<absolute-path>';
  }
  return path;
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
  });
}
