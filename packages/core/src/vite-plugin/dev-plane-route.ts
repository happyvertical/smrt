/**
 * Generated `_dev/[...tool]/+server.ts` route: the in-app runtime dev-plane
 * (#2782). Opt-in via `sveltekit: { devPlaneRoute: { enabled: true } }`.
 *
 * The route is dev-only twice over: it 404s unless SvelteKit's `dev` flag is
 * set, and it refuses to start without `SMRT_DEV_MCP_TOKEN`. Everything else
 * — loopback checks, bearer auth, the positive read-only catalog, the MCP
 * endpoint — lives in `@happyvertical/smrt-dev-mcp/dev-plane`, which the
 * generated file imports at consumer runtime. Like `_resources`, the route is
 * only emitted when that subpath resolves from the consumer.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

/** Whether `@happyvertical/smrt-dev-mcp/dev-plane` resolves from the consumer. */
export function consumerHasSmrtDevMcp(projectRoot: string): boolean {
  try {
    const consumerRequire = createRequire(
      pathToFileURL(join(projectRoot, 'package.json')).href,
    );
    consumerRequire.resolve('@happyvertical/smrt-dev-mcp/dev-plane');
    return true;
  } catch {
    return false;
  }
}

export function generateDevPlaneRoute(
  projectRoot: string,
  options: SvelteKitOptions,
): boolean {
  if (options.devPlaneRoute?.enabled !== true) {
    return false;
  }
  if (!consumerHasSmrtDevMcp(projectRoot)) {
    console.log(
      '[smrt] Skipping _dev route - @happyvertical/smrt-dev-mcp/dev-plane is ' +
        'not resolvable; install @happyvertical/smrt-dev-mcp as a devDependency',
    );
    return false;
  }
  const configPath = options.configPath || 'src/lib/server';
  const configFileName = (options.configFileName || 'smrt.ts').replace(
    /\.ts$/,
    '',
  );
  const routeDir = join(projectRoot, options.routesDir, '_dev', '[...tool]');
  if (!existsSync(routeDir)) {
    mkdirSync(routeDir, { recursive: true });
  }
  const filePath = join(routeDir, '+server.ts');
  writeFileSync(
    filePath,
    generateDevPlaneRouteTemplate(
      `$lib/${configPath.replace(/^src\/lib\//, '')}/${configFileName}`,
    ),
    'utf-8',
  );
  console.log(`[smrt] Generated: ${filePath}`);
  return true;
}

function generateDevPlaneRouteTemplate(configImport: string): string {
  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten
//
// In-app runtime dev-plane (#2782). Dev mode only. Serves the read-only
// runtime tools over JSON (GET|POST /_dev/<tool>, GET /_dev for the catalog)
// and MCP (POST /_dev/mcp) against this app's live registry and database.
// Requires SMRT_DEV_MCP_TOKEN; every request must present it as a bearer
// token from loopback. Never mounted in production builds.
import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createDevPlane, type DevPlane } from '@happyvertical/smrt-dev-mcp/dev-plane';
import { getSmrtConfig } from '${configImport}';

let plane: DevPlane | null = null;

function getPlane(): DevPlane | null {
  if (!dev) return null;
  const token = process.env.SMRT_DEV_MCP_TOKEN?.trim();
  if (!token) return null;
  if (!plane) {
    // The default config's db is what the app itself opens; passing its
    // url/type makes the SDK connection cache hand the plane the same handle.
    const db = getSmrtConfig('__smrt_dev_plane__').db as
      | { url?: string; type?: string }
      | undefined;
    plane = createDevPlane({ token, projectRoot: process.cwd(), db });
  }
  return plane;
}

const handle: RequestHandler = async ({ request, url }) => {
  if (!dev) throw error(404, 'Not found');
  const active = getPlane();
  if (!active) {
    throw error(503, 'SMRT_DEV_MCP_TOKEN is not set; the dev-plane is disabled');
  }
  const base = url.pathname.slice(0, url.pathname.indexOf('/_dev') + '/_dev'.length);
  return active.handleRequest(request, base);
};

export const GET = handle;
export const POST = handle;
`;
}
