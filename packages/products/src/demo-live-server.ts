#!/usr/bin/env tsx
/**
 * Demo API server for the TanStack DB spike (#1756).
 *
 * Runs the REAL generated REST stack (startRestServer over the Product and
 * Category models, SQLite persistence, schema applied from the package
 * manifest's DDL) with one demo valve: POST bodies whose `name` starts with
 * "FAIL" are rejected with a 500 — the switch the live demo page uses to
 * show optimistic-create rollback.
 *
 * Usage:
 *   pnpm build                 # produces dist/lib/manifest.json (DDL source)
 *   pnpm demo:live-server      # starts http://127.0.0.1:39456/api/v1
 *   pnpm dev:standalone        # vite dev proxies /api/v1 to this server
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectRegistry, startRestServer } from '@happyvertical/smrt-core';
import { getDatabase, syncSchema } from '@happyvertical/sql';
import { Category } from './lib/models/Category';
import { Product } from './lib/models/Product';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const PORT = 39456;

interface ManifestObjectDef {
  className?: string;
  schema?: { tableName?: string; ddl?: string };
}

interface ManifestFile {
  objects: Record<string, ManifestObjectDef>;
}

function loadManifest(): ManifestFile {
  const candidates = [
    join(packageRoot, '.smrt', 'manifest.json'),
    join(packageRoot, 'dist', 'lib', 'manifest.json'),
    join(packageRoot, 'dist', 'manifest.json'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as ManifestFile;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `No manifest found (checked .smrt/ and dist/). Run \`pnpm build\` in packages/products first.`,
  );
}

/**
 * Demo valve doubling as the auth middleware: allows everything, except
 * create/update payloads whose name starts with "FAIL" — those get a 500 so
 * the client demo can show a visible optimistic rollback.
 */
function demoValveMiddleware(_objectName: string, action: string) {
  return async (req: Request): Promise<Request | Response> => {
    if (action === 'create' || action === 'update') {
      try {
        const body = (await req.clone().json()) as { name?: unknown };
        if (typeof body?.name === 'string' && body.name.startsWith('FAIL')) {
          return new Response(
            JSON.stringify({
              error:
                'Forced server error (demo): product names starting with "FAIL" are rejected',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
      } catch {
        // Non-JSON body: let the route handler produce its own error.
      }
    }
    return req;
  };
}

async function main() {
  const manifest = loadManifest();

  // Source-mode runs (tsx) have no build plugin to populate field metadata;
  // register the package manifest explicitly so save()/toJSON() see fields.
  ObjectRegistry.registerPackageManifest(
    manifest as Parameters<typeof ObjectRegistry.registerPackageManifest>[0],
  );

  // In-memory SQLite with schema applied from the manifest's generated DDL —
  // no runtime schema creation, the manifest is the migration source.
  const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  const ddl = Object.values(manifest.objects)
    .filter(
      (obj) =>
        (obj.className === 'Product' || obj.className === 'Category') &&
        obj.schema?.ddl,
    )
    .map((obj) => obj.schema?.ddl)
    .join('\n');
  await syncSchema({ db, schema: ddl });

  const shutdown = await startRestServer([Product, Category], { db }, {
    port: PORT,
    hostname: '127.0.0.1',
    basePath: '/api/v1',
    enableCors: true,
    allowedOrigins: ['http://localhost:3001', 'http://localhost:4173'],
    authMiddleware: demoValveMiddleware,
  });

  // Seed a few rows through the real REST surface so the demo has data.
  const seed = [
    { name: 'Solar Widget', price: 49.99, inStock: true },
    { name: 'Lunar Gadget', price: 19.5, inStock: true },
    { name: 'Comet Gizmo', price: 7.25, inStock: false },
  ];
  for (const product of seed) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product),
    });
    if (!res.ok) {
      console.warn(`[demo] Seed failed for ${product.name}: ${res.status}`);
    }
  }

  console.log(`[demo] Live demo API at http://127.0.0.1:${PORT}/api/v1`);
  console.log('[demo] GET  /api/v1/products      — list (watch for SWR: repeat navigations do not refetch)');
  console.log('[demo] POST /api/v1/products      — create; names starting with "FAIL" get a forced 500');

  return shutdown;
}

main().catch((error) => {
  console.error('[demo] Failed to start demo server:', error);
  process.exit(1);
});
