/**
 * Schema Aggregator
 *
 * Aggregates database schemas across multiple SMRT package manifests.
 * Handles STI table deduplication, index merging, and sorting for deterministic output.
 *
 * Tables and indexes are rendered from the manifests' structured `columns` /
 * `indexes` through the dialect's DDL strategy (`getDDLStrategy`), the same
 * renderer `smrt db:migrate` uses — never from the cached `schema.ddl` string,
 * which carries no indexes and no per-engine types (#2358). Objects that expose
 * no structured columns fall back to their cached `ddl` for the CREATE TABLE.
 *
 * This replaces the manual generate-schema.ts pattern used by downstream
 * projects like blindmanpress.com (Issue #1013).
 *
 * @example
 * ```typescript
 * import { SchemaAggregator } from '@happyvertical/smrt-core/schema';
 *
 * // Auto-discover from installed @happyvertical packages in node_modules
 * const aggregator = new SchemaAggregator();
 * const result = aggregator.aggregate();
 *
 * // Or with explicit packages
 * const result = aggregator.aggregate({
 *   packages: ['@happyvertical/smrt-profiles', '@happyvertical/smrt-events'],
 * });
 *
 * console.log(result.sql);        // Combined CREATE TABLE + INDEX SQL
 * console.log(result.tables);     // Map of table info
 * console.log(result.manifests);  // Loaded manifests by package
 * ```
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSmrtPackages } from '../manifest/discover-smrt-packages.js';
import { loadExternalManifestSync } from '../manifest/manifest-loader.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import type { DatabaseEngine } from './ddl/types.js';
import {
  collectManifestTables,
  type ManifestColumnLike,
  renderCollectedManifestTable,
} from './manifest-schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Aggregated table information including DDL, indexes, and source tracking.
 */
export interface AggregatedTable {
  /** Table name */
  tableName: string;
  /**
   * CREATE TABLE statement rendered by the dialect's DDL strategy from the
   * merged structured columns of every contributing class (STI union). A
   * table with a column-less contributor (hand-authored manifest) has that
   * contributor's cached `ddl` merged on top; a table with no structured
   * columns at all is the merged cached `ddl`.
   */
  ddl: string;
  /**
   * CREATE INDEX statements rendered by the same strategy (partial `WHERE`
   * and JSON-path targets included), deduplicated by index name across
   * sources.
   */
  indexes: string[];
  /** Package:className sources that contribute to this table */
  sources: string[];
  /**
   * Manifest column metadata as published in `manifest.json` (`default`,
   * not `defaultValue`), merged across contributors — first contributor wins
   * per column name, matching the rendered DDL.
   */
  columns?: Record<string, ManifestColumnLike>;
}

/**
 * Result of schema aggregation across packages.
 */
export interface AggregationResult {
  /** Aggregated tables keyed by table name */
  tables: Map<string, AggregatedTable>;
  /** Combined SQL string (CREATE TABLE + CREATE INDEX statements) */
  sql: string;
  /** Loaded manifests keyed by package name */
  manifests: Map<string, SmartObjectManifest>;
  /** Summary statistics */
  stats: {
    packagesLoaded: number;
    packagesSkipped: number;
    totalObjects: number;
    uniqueTables: number;
    stiTables: number;
  };
}

/**
 * Options for schema aggregation.
 */
export interface AggregateOptions {
  /**
   * Explicit list of packages to scan. If omitted, auto-discovers
   * installed `@happyvertical/smrt-*` packages from `node_modules`
   * via `discoverSmrtPackages()`.
   */
  packages?: string[];

  /**
   * Additional local filesystem paths to check for manifests,
   * keyed by package name. Useful for development when local
   * packages have newer schemas than node_modules.
   */
  localPaths?: Record<string, string>;

  /**
   * Skip collection tables and infrastructure tables.
   * Useful for generating minimal schemas for lightweight deployments.
   */
  minimal?: boolean;

  /**
   * Table name patterns to skip in minimal mode.
   * Defaults to common infrastructure tables.
   */
  minimalSkipPatterns?: RegExp[];

  /**
   * Specific table names to skip in minimal mode.
   */
  minimalSkipTables?: string[];

  /**
   * SQL dialect for the output. Affects PRAGMA statements and syntax.
   * @default 'postgres'
   */
  dialect?: 'postgres' | 'sqlite';

  /** Log progress to console */
  verbose?: boolean;
}

// ============================================================================
// Default minimal-mode skip lists
// ============================================================================

const DEFAULT_MINIMAL_SKIP_PATTERNS: RegExp[] = [
  /^api_key/,
  /^magic_link/,
  /^nostr_/,
  /^audit_log/,
  /_metafield/,
  /_metadata/,
  /_relationship_term/,
  /_relationship_type/,
];

// ============================================================================
// SchemaAggregator
// ============================================================================

/**
 * Aggregates database schemas from multiple SMRT package manifests.
 *
 * Handles the complete workflow of discovering packages, loading manifests,
 * extracting DDL, deduplicating STI tables, and producing combined SQL.
 */
export class SchemaAggregator {
  /**
   * Aggregate schemas from SMRT packages.
   *
   * @param options - Aggregation options
   * @returns Aggregated schemas with combined SQL
   */
  aggregate(options: AggregateOptions = {}): AggregationResult {
    const verbose = options.verbose ?? false;

    // 1. Discover packages
    const packages = options.packages || discoverSmrtPackages();

    if (verbose) {
      console.log(`[SchemaAggregator] Scanning ${packages.length} packages...`);
    }

    // 2. Load manifests
    const manifests = new Map<string, SmartObjectManifest>();
    let packagesSkipped = 0;

    for (const pkg of packages) {
      const manifest = this.loadManifest(pkg, options.localPaths);
      if (manifest) {
        manifests.set(pkg, manifest);
        if (verbose) {
          const objectCount = Object.keys(manifest.objects).length;
          console.log(`  ✓ ${pkg} (${objectCount} objects)`);
        }
      } else {
        packagesSkipped++;
        if (verbose) {
          console.log(`  [skip] ${pkg} - manifest not found`);
        }
      }
    }

    // 3. Extract and deduplicate schemas
    const tables = this.extractSchemas(
      Array.from(manifests.values()),
      options.dialect,
    );

    // 4. Apply minimal filtering if requested
    if (options.minimal) {
      this.applyMinimalFilter(tables, options);
    }

    // 5. Count STI tables and total objects
    let stiTables = 0;
    let totalObjects = 0;
    for (const table of tables.values()) {
      if (table.sources.length > 1) stiTables++;
    }
    for (const manifest of manifests.values()) {
      totalObjects += Object.keys(manifest.objects).length;
    }

    // 6. Generate combined SQL
    const sql = this.generateSQL(tables, options);

    return {
      tables,
      sql,
      manifests,
      stats: {
        packagesLoaded: manifests.size,
        packagesSkipped,
        totalObjects,
        uniqueTables: tables.size,
        stiTables,
      },
    };
  }

  /**
   * Load a manifest from local path or node_modules.
   */
  private loadManifest(
    packageName: string,
    localPaths?: Record<string, string>,
  ): SmartObjectManifest | null {
    // Try local development path first (may have newer schemas)
    if (localPaths?.[packageName]) {
      const localPath = localPaths[packageName];
      if (existsSync(localPath)) {
        try {
          const content = JSON.parse(
            readFileSync(localPath, 'utf-8'),
          ) as SmartObjectManifest;
          // Only use local if it has schemas
          const hasSchemas = Object.values(content.objects || {}).some(
            (obj) =>
              obj.schema?.tableName &&
              (Object.keys(obj.schema.columns || {}).length > 0 ||
                obj.schema.ddl),
          );
          if (hasSchemas) return content;
        } catch {
          // Fall through to node_modules
        }
      }
    }

    // Try loadExternalManifestSync (handles node_modules resolution)
    const manifest = loadExternalManifestSync(packageName);
    if (manifest) return manifest;

    // Fallback: try common node_modules paths relative to cwd
    const root = process.cwd();
    const paths = [
      join(root, 'node_modules', packageName, 'dist', 'manifest.json'),
      join(root, 'node_modules', packageName, 'manifest.json'),
    ];

    for (const manifestPath of paths) {
      if (existsSync(manifestPath)) {
        try {
          return JSON.parse(readFileSync(manifestPath, 'utf-8'));
        } catch {}
      }
    }

    return null;
  }

  /**
   * Extract schemas from manifests, deduplicating STI tables.
   *
   * STI tables (shared by multiple classes across packages) are merged
   * structurally — columns first-wins by name, indexes deduplicated by name —
   * and every table is rendered through the dialect's DDL strategy, the same
   * renderer `db:migrate` uses. The manifest's cached `schema.ddl` string is
   * consulted only for objects that expose no structured columns (#2358).
   */
  private extractSchemas(
    manifests: SmartObjectManifest[],
    dialect?: 'postgres' | 'sqlite',
  ): Map<string, AggregatedTable> {
    // Default mirrors `AggregateOptions.dialect` (`@default 'postgres'`) so
    // unspecified callers get the documented shape.
    const engine: DatabaseEngine = dialect === 'sqlite' ? 'sqlite' : 'postgres';

    const entries: Array<{
      schema: NonNullable<SmartObjectManifest['objects'][string]['schema']>;
      source: string;
    }> = [];
    // Published manifest column metadata, merged first-wins per table so
    // `AggregatedTable.columns` keeps its manifest shape for downstream
    // generate-schema scripts.
    const manifestColumns = new Map<
      string,
      Record<string, ManifestColumnLike>
    >();
    for (const manifest of manifests) {
      for (const [_key, object] of Object.entries(manifest.objects)) {
        const schema = object.schema;
        if (!schema?.tableName) continue;
        const className: string = object.className || _key;
        entries.push({
          schema,
          source: `${manifest.packageName || '?'}:${className}`,
        });
        if (schema.columns && Object.keys(schema.columns).length > 0) {
          const merged = manifestColumns.get(schema.tableName) ?? {};
          for (const [name, column] of Object.entries(schema.columns)) {
            if (!(name in merged)) merged[name] = column;
          }
          manifestColumns.set(schema.tableName, merged);
        }
      }
    }

    const tables = new Map<string, AggregatedTable>();
    for (const [tableName, table] of collectManifestTables(entries)) {
      const rendered = renderCollectedManifestTable(table, engine);
      tables.set(tableName, {
        tableName,
        ddl: rendered.createTable,
        indexes: rendered.indexes,
        sources: table.sources,
        columns: manifestColumns.get(tableName),
      });
    }

    return tables;
  }

  /**
   * Apply minimal filtering to remove infrastructure/collection tables.
   */
  private applyMinimalFilter(
    tables: Map<string, AggregatedTable>,
    options: AggregateOptions,
  ): void {
    const skipPatterns =
      options.minimalSkipPatterns || DEFAULT_MINIMAL_SKIP_PATTERNS;
    const skipTables = new Set(options.minimalSkipTables || []);

    for (const tableName of Array.from(tables.keys())) {
      if (skipTables.has(tableName)) {
        tables.delete(tableName);
        continue;
      }
      for (const pattern of skipPatterns) {
        if (pattern.test(tableName)) {
          tables.delete(tableName);
          break;
        }
      }
    }
  }

  /**
   * Generate combined SQL from aggregated tables.
   */
  private generateSQL(
    tables: Map<string, AggregatedTable>,
    options: AggregateOptions,
  ): string {
    const lines: string[] = [
      '-- Combined SMRT Database Schema',
      `-- Generated: ${new Date().toISOString()}`,
      '',
    ];

    if (options.dialect === 'sqlite') {
      lines.push('PRAGMA foreign_keys = ON;', '');
    }

    // Sort tables by name for deterministic output
    const sortedTables = Array.from(tables.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    for (const [tableName, table] of sortedTables) {
      lines.push(`-- Table: ${tableName}`);
      if (table.sources.length > 1) {
        lines.push(`-- STI table, sources: ${table.sources.join(', ')}`);
      } else {
        lines.push(`-- Source: ${table.sources[0]}`);
      }
      lines.push(table.ddl);
      lines.push('');

      if (table.indexes.length > 0) {
        for (const idx of table.indexes) {
          lines.push(idx);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}
