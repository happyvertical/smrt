#!/usr/bin/env tsx
/**
 * Demo API server for the TanStack DB spike (#1756).
 *
 * Runs the REAL generated REST stack (APIGenerator over the Product and
 * Category models, SQLite persistence, schema applied from the package
 * manifest's DDL) with one demo valve: POST/PUT bodies whose `name` starts
 * with "FAIL" are rejected with a 500 — the switch the live demo page uses
 * to show optimistic-create rollback.
 *
 * Spike findings baked into this file's shape:
 * - Collections are registered explicitly under their PLURAL names.
 *   APIGenerator's auto-discovery pluralizes the URL segment again
 *   ("products" -> "productses"), so plural URLs — the ones the generated
 *   client fetches — never match auto-discovery. registerCollection() is
 *   the only path that serves the generated client's URL scheme.
 * - The manifest must be registered before model imports (see
 *   demo-live-register.ts) or decorators register field-less classes.
 *
 * Usage:
 *   pnpm build                 # produces dist/lib/manifest.json (DDL source)
 *   pnpm demo:live-server      # starts http://127.0.0.1:39456/api/v1
 *   pnpm dev:standalone        # vite dev proxies /api/v1 to this server
 */

// Side-effect import: must run before model imports (manifest cache).
import './demo-live-register';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIGenerator } from '@happyvertical/smrt-core';
import { getDatabase, syncSchema } from '@happyvertical/sql';
import { CategoryCollection } from './lib/collections/CategoryCollection';
import { ProductCollection } from './lib/collections/ProductCollection';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const PORT = 39456;

interface ManifestObjectDef {
  className?: string;
  schema?: {
    tableName?: string;
    ddl?: string;
    indexes?: Array<{ name: string; columns: string[]; unique?: boolean }>;
  };
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
    'No manifest found (checked .smrt/ and dist/). Run `pnpm build` in packages/products first.',
  );
}

/**
 * Demo valve doubling as the auth middleware: allows everything, except
 * create/update payloads whose name starts with "FAIL" — those get a 500 so
 * the client demo can show a visible optimistic rollback.
 */
function demoValveMiddleware(_objectName: string, _action: string) {
  return async (req: Request): Promise<Request | Response> => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const body = (await req.clone().json()) as { name?: unknown };
        if (typeof body?.name === 'string' && body.name.startsWith('FAIL')) {
          // Small delay so the optimistic row is visibly on screen before
          // the rollback (localhost roundtrips are otherwise ~5ms).
          await new Promise((resolve) => setTimeout(resolve, 600));
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

  // In-memory SQLite with schema applied from the manifest's generated DDL —
  // no runtime schema creation, the manifest is the migration source.
  const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  const schemaObjects = Object.values(manifest.objects).filter(
    (obj) =>
      (obj.className === 'Product' || obj.className === 'Category') &&
      obj.schema?.ddl,
  );
  const ddl = schemaObjects
    .flatMap((obj) => {
      const schema = obj.schema;
      if (!schema?.ddl || !schema.tableName) return [];
      // Index DDL matters: save() upserts ON CONFLICT(slug, context,
      // _meta_type), which requires the UNIQUE index from the manifest.
      const indexes = (schema.indexes ?? []).map(
        (index) =>
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${index.name}" ON "${schema.tableName}" (${index.columns.map((c) => `"${c}"`).join(', ')});`,
      );
      return [schema.ddl, ...indexes];
    })
    .join('\n');
  await syncSchema({ db, schema: ddl });

  const generator = new APIGenerator(
    {
      port: PORT,
      hostname: '127.0.0.1',
      basePath: '/api/v1',
      enableCors: true,
      allowedOrigins: ['http://localhost:3001', 'http://localhost:4173'],
      authMiddleware: demoValveMiddleware,
    },
    { db },
  );

  // Register collections under their PLURAL names — the URL scheme the
  // generated client (and virt-web definitions) actually use.
  generator.registerCollection(
    'products',
    (await ProductCollection.create({ db })) as never,
  );
  generator.registerCollection(
    'categories',
    (await CategoryCollection.create({ db })) as never,
  );

  const { url } = generator.createServer();

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

  console.log(`[demo] Live demo API at ${url}/api/v1`);
  console.log(
    '[demo] GET  /api/v1/products — list (watch for SWR: repeat navigations do not refetch)',
  );
  console.log(
    '[demo] POST /api/v1/products — create; names starting with "FAIL" get a forced 500',
  );
}

main().catch((error) => {
  console.error('[demo] Failed to start demo server:', error);
  process.exit(1);
});
