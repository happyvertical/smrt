#!/usr/bin/env node
/**
 * MCP protocol hygiene gate (#2146, epic #2145).
 *
 * The MCP 2026-07-28 spec removes `ping`, `logging/setLevel`, and
 * `notifications/roots/list_changed`, deprecates the Roots / Sampling /
 * Logging capabilities and the HTTP+SSE transport, drops the
 * `Mcp-Session-Id` header (sessions are gone), and remaps resource-not-found
 * from `-32002` to `-32602`. The 2026-07-29 exposure audit found ZERO usage
 * of any of these across SMRT's MCP surfaces — this gate keeps it that way
 * while the SDK line migrates (v1.30.0 interim → v2 scoped packages).
 *
 * Scans `packages/<pkg>/src` TypeScript/JavaScript/Svelte sources (generated
 * runtime templates live there too, so baked-in template output is covered).
 * A finding fails CI. For a genuinely required exception (e.g. a
 * compatibility shim during the v2 migration), annotate the line before it:
 *
 *   // mcp-protocol-hygiene-allow: <reason>
 *
 * Run: `node scripts/check-mcp-protocol-hygiene.mjs` or
 * `pnpm check:mcp-protocol-hygiene`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const ALLOW_ANNOTATION = 'mcp-protocol-hygiene-allow:';

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.svelte']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.generated-tmp', '.smrt']);

/**
 * Substring tokens. Each entry: [token, reason]. Tokens are chosen to be
 * SDK/wire-level identifiers that do not occur in ordinary application code.
 */
const BANNED_TOKENS = [
  // Removed request: ping (SDK answers it protocol-side in the v1 line; the
  // 2026-07-28 revision removes it entirely).
  ['PingRequestSchema', 'ping was removed in MCP 2026-07-28'],
  // Removed: logging/setLevel and the Logging capability (deprecated).
  ['logging/setLevel', 'logging/setLevel was removed in MCP 2026-07-28'],
  ['SetLevelRequestSchema', 'logging/setLevel was removed in MCP 2026-07-28'],
  ['setLoggingLevel', 'logging/setLevel was removed in MCP 2026-07-28'],
  ['sendLoggingMessage', 'the Logging capability is deprecated (per-request _meta log level replaces it)'],
  ['LoggingMessageNotificationSchema', 'the Logging capability is deprecated'],
  // Removed: notifications/roots/list_changed and the Roots capability
  // (deprecated). 'roots/list' also covers the roots/list request.
  ['notifications/roots/list_changed', 'notifications/roots/list_changed was removed in MCP 2026-07-28'],
  ['RootsListChangedNotificationSchema', 'notifications/roots/list_changed was removed in MCP 2026-07-28'],
  ['sendRootsListChanged', 'notifications/roots/list_changed was removed in MCP 2026-07-28'],
  ['ListRootsRequestSchema', 'the Roots capability is deprecated (12-month window from 2026-07-28)'],
  ['roots/list', 'the Roots capability is deprecated (12-month window from 2026-07-28)'],
  // Deprecated: server-initiated Sampling (replaced by MRTR input_required).
  ['sampling/createMessage', 'the Sampling capability is deprecated (MRTR replaces server-initiated requests)'],
  ['CreateMessageRequestSchema', 'the Sampling capability is deprecated'],
  ['CreateMessageResultSchema', 'the Sampling capability is deprecated'],
  // Removed: sessions. State crosses calls via server-minted handles.
  // HTTP header names are case-insensitive and Node lowercases incoming
  // headers, so this token is matched case-insensitively below.
  ['mcp-session-id', 'Mcp-Session-Id was removed in MCP 2026-07-28 (stateless protocol)', { caseInsensitive: true }],
  // Deprecated transport: HTTP+SSE (12-month window). Streamable HTTP replaces it.
  ['SSEServerTransport', 'the HTTP+SSE transport is deprecated; use Streamable HTTP'],
  ['SSEClientTransport', 'the HTTP+SSE transport is deprecated; use Streamable HTTP'],
  // Remapped error code: resource-not-found -32002 becomes -32602; the
  // -32020..-32099 range is reserved for the spec.
  ['-32002', 'resource-not-found is -32602 in MCP 2026-07-28 (-32002 is retired)'],
];

/**
 * Regex rules for shapes a plain token cannot express safely.
 * Each entry: [regex, reason]. Applied per line.
 */
const BANNED_PATTERNS = [
  // Explicit .ping() calls on MCP client/server objects.
  [/\b(?:client|server|mcp[A-Za-z0-9_]*)\s*\.\s*ping\s*\(/, 'ping was removed in MCP 2026-07-28'],
];

/**
 * Capability-declaration heuristic: inside files that touch the MCP SDK,
 * flag `roots:`, `sampling:`, or `logging:` keys that open an object literal
 * (the capability-map idiom). Ordinary app config (`logging: true`) does not
 * match, and non-SDK files are never scanned by this rule.
 */
const CAPABILITY_PATTERN = /\b(roots|sampling|logging)\s*:\s*\{/;

function isLineAllowed(lines, index) {
  const previous = index > 0 ? lines[index - 1] : '';
  return (
    lines[index].includes(ALLOW_ANNOTATION) ||
    previous.includes(ALLOW_ANNOTATION)
  );
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) {
      yield full;
    }
  }
}

const findings = [];

for (const pkg of readdirSync(PACKAGES_DIR)) {
  const srcDir = join(PACKAGES_DIR, pkg, 'src');
  let srcStats;
  try {
    srcStats = statSync(srcDir);
  } catch {
    continue;
  }
  if (!srcStats.isDirectory()) continue;

  for (const file of walk(srcDir)) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const touchesSdk = content.includes('@modelcontextprotocol');

    lines.forEach((line, index) => {
      if (line.includes(ALLOW_ANNOTATION)) return;

      for (const [token, reason, tokenOptions] of BANNED_TOKENS) {
        const haystack = tokenOptions?.caseInsensitive
          ? line.toLowerCase()
          : line;
        if (haystack.includes(token) && !isLineAllowed(lines, index)) {
          findings.push({ file, line: index + 1, token, reason });
        }
      }
      for (const [pattern, reason] of BANNED_PATTERNS) {
        if (pattern.test(line) && !isLineAllowed(lines, index)) {
          findings.push({ file, line: index + 1, token: line.trim().slice(0, 80), reason });
        }
      }
      if (touchesSdk) {
        const capability = line.match(CAPABILITY_PATTERN);
        if (capability && !isLineAllowed(lines, index)) {
          findings.push({
            file,
            line: index + 1,
            token: `${capability[1]}: {`,
            reason: `the ${capability[1]} capability is deprecated in MCP 2026-07-28`,
          });
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error('❌ MCP protocol hygiene violations (removed/deprecated 2026-07-28 features):\n');
  for (const finding of findings) {
    console.error(
      `  ${relative(ROOT, finding.file)}:${finding.line} — "${finding.token}"\n    ${finding.reason}`,
    );
  }
  console.error(
    `\n${findings.length} violation(s). If one is a deliberate compatibility shim, annotate the line above it with:\n  // ${ALLOW_ANNOTATION} <reason>`,
  );
  process.exit(1);
}

console.log('✅ MCP protocol hygiene: no removed/deprecated 2026-07-28 protocol features in packages/*/src.');
