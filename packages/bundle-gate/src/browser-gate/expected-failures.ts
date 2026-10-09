import type { ExpectedFailure } from './boundary.js';

/**
 * Browser-gate ratchet (#3621, epic #3622). Packages whose root entry does
 * not yet build for the browser, each tied to the issue(s) that fix it.
 *
 * The gate fails when a package NOT listed here breaks, and when a listed
 * package now passes (stale entry). A fix PR therefore deletes its own
 * entry in the same change (or trims `issue`/`reason` while other causes
 * remain); the goal is an empty object. Findings are attributed to the
 * package that owns the fix, so a dependency's defect is listed once on the
 * dependency, not on every dependent.
 *
 * Keep entries sorted by package name. Reflects main at 141ed973c.
 */
export const EXPECTED_BROWSER_FAILURES: Record<string, ExpectedFailure> = {
  '@happyvertical/smrt-agents': {
    issue: '#3624, #3626',
    reason: 'node:crypto in root; core migrations (node:os)',
  },
  '@happyvertical/smrt-chat': {
    issue: '#3624',
    reason: 'node:crypto + node:async_hooks',
  },
  '@happyvertical/smrt-commerce': {
    issue: '#3627, #3626',
    reason:
      '@happyvertical/payments btcpay (node:crypto); core migrations (node:os). The jobs runner edge (#3615) is reported on smrt-jobs',
  },
  '@happyvertical/smrt-content': {
    issue: '#3624, #3627',
    reason:
      'node:crypto; documents/spider/files/images/ai SDK graph (crawlee, undici, googleapis, native addons); CJS parse error',
  },
  '@happyvertical/smrt-core': {
    issue: '#3635',
    reason:
      "model roots import server-only helpers (manifest loader, route helpers, startRestServer) the browser entry deliberately omits; core's own graph reaches no Node-only module (#2838, held by the browser-boundary core-entry test)",
  },
  '@happyvertical/smrt-events': {
    issue: '#3624',
    reason: 'node:crypto',
  },
  '@happyvertical/smrt-expenses': {
    issue: '#3624',
    reason: 'node:crypto',
  },
  '@happyvertical/smrt-features': {
    issue: '#3618',
    reason:
      'imports core utils/import-workspace-module (node:url, node:fs, node:path)',
  },
  '@happyvertical/smrt-fields': {
    issue: '#3618',
    reason:
      'imports core utils/import-workspace-module (node:url, node:fs, node:path)',
  },
  '@happyvertical/smrt-images': {
    issue: '#3628, #3624',
    reason: 'sharp, node:fs/promises, node:crypto, resvg native addon',
  },
  '@happyvertical/smrt-jobs': {
    issue: '#3615, #3624, #3627',
    reason:
      'worker_threads runner (the edge commerce inherits), node:events/crypto, bull/bullmq/cloud-tasks SDK graph',
  },
  '@happyvertical/smrt-languages': {
    issue: '#3624',
    reason: 'node:crypto',
  },
  '@happyvertical/smrt-ledgers': {
    issue: '#3626',
    reason: 'core migrations (node:os, node:crypto)',
  },
  '@happyvertical/smrt-places': {
    issue: '#3627',
    reason: 'geo -> cache -> redis, node:zlib; url-signature node:crypto',
  },
  '@happyvertical/smrt-products': {
    issue: '#3616, #3626',
    reason:
      'server bootstrap (startRestServer, express/cors), core generators/mcp',
  },
  '@happyvertical/smrt-profiles': {
    issue: '#3617, #3626',
    reason: 'node:crypto in root; core migrations (node:os)',
  },
  '@happyvertical/smrt-projects': {
    issue: '#3624, #3626, #3627',
    reason: 'node:crypto/async_hooks; core migrations; repos and ai SDKs',
  },
  '@happyvertical/smrt-reports': {
    issue: '#3624, #3625',
    reason:
      'node:crypto/events; @happyvertical/sql root: the sync query builders it needs (validateColumnName, buildWhere, buildAggregate, bucketExpr, tableExists) have no browser-safe SDK entry',
  },
  '@happyvertical/smrt-sales': {
    issue: '#3624',
    reason: 'node:crypto',
  },
  '@happyvertical/smrt-secrets': {
    issue: '#3627',
    reason: '@happyvertical/secrets (node:child_process, node:crypto) and sql',
  },
  '@happyvertical/smrt-social': {
    issue: '#3624',
    reason: 'node:crypto',
  },
  '@happyvertical/smrt-subscriptions': {
    issue: '#3626',
    reason: 'core migrations (node:crypto, node:os)',
  },
  '@happyvertical/smrt-support': {
    issue: '#3626',
    reason: 'core migrations (node:os)',
  },
  '@happyvertical/smrt-tenancy': {
    issue: '#3624',
    reason: 'node:async_hooks',
  },
  '@happyvertical/smrt-timesheets': {
    issue: '#3624',
    reason: 'node:crypto',
  },
  '@happyvertical/smrt-users': {
    issue: '#3624, #3626',
    reason: 'node:crypto/async_hooks; core migrations',
  },
  '@happyvertical/smrt-video': {
    issue: '#3627',
    reason: 'documents/spider SDK graph; CJS parse error',
  },
  '@happyvertical/smrt-voice': {
    issue: '#3627',
    reason: 'documents/spider SDK graph; CJS parse error',
  },
};
