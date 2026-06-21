/**
 * Tests for the pre-build TypeScript declaration generator (src/prebuild/index.ts).
 *
 * generateDeclarations() is a pure function that reads a SMRT manifest (object
 * or JSON-file path) and writes .d.ts files to a directory. These tests run it
 * against real temp directories and assert on the emitted file contents — in
 * particular the SMRT-field-type -> TypeScript-type mapping and the virtual
 * module declarations. No fs mocking; temp dirs are removed in afterEach.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateDeclarations, generateDeclarationsFromCLI } from './index.js';

function buildManifest(): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 1,
    objects: {
      Article: {
        className: 'Article',
        collection: 'articles',
        // Every supported field type so mapFieldTypeToTypeScript is fully exercised.
        fields: {
          title: { type: 'text', required: true },
          body: { type: 'text' },
          views: { type: 'integer' },
          rating: { type: 'decimal' },
          published: { type: 'boolean' },
          publishedAt: { type: 'datetime' },
          metadata: { type: 'json' },
          authorId: { type: 'foreignKey' },
          weird: { type: 'somethingUnknown' as any },
        },
        methods: {},
        decoratorConfig: {},
      } as any,
      Author: {
        className: 'Author',
        collection: 'authors',
        fields: {
          name: { type: 'text', required: true },
        },
        methods: {},
        decoratorConfig: {},
      } as any,
    },
  };
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'smrt-prebuild-'));
});

afterEach(() => {
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('generateDeclarations', () => {
  it('writes object-type declarations mapping field types to TS types', async () => {
    await generateDeclarations({
      manifest: buildManifest(),
      outDir,
      includeVirtualModules: false,
      includeObjectTypes: true,
    });

    const objectsPath = join(outDir, 'smrt-objects.d.ts');
    expect(existsSync(objectsPath)).toBe(true);
    const content = readFileSync(objectsPath, 'utf-8');

    expect(content).toContain('export interface ArticleData {');
    expect(content).toContain('export interface AuthorData {');
    // Standard SmrtObject properties.
    expect(content).toContain('id?: string;');
    expect(content).toContain('created_at?: string;');
    expect(content).toContain('updated_at?: string;');
    // Field type mapping.
    expect(content).toContain('title: string;'); // text + required -> no ?
    expect(content).toContain('body?: string;'); // text optional
    expect(content).toContain('views?: number;'); // integer
    expect(content).toContain('rating?: number;'); // decimal
    expect(content).toContain('published?: boolean;'); // boolean
    expect(content).toContain('publishedAt?: string | Date;'); // datetime
    expect(content).toContain('metadata?: any;'); // json
    expect(content).toContain('authorId?: string;'); // foreignKey
    expect(content).toContain('weird?: any;'); // unknown -> any
  });

  it('writes virtual module declarations for every @smrt virtual module', async () => {
    await generateDeclarations({
      manifest: buildManifest(),
      outDir,
      includeVirtualModules: true,
      includeObjectTypes: false,
    });

    const files = [
      'smrt-manifest.d.ts',
      'smrt-client.d.ts',
      'smrt-routes.d.ts',
      'smrt-mcp.d.ts',
      'smrt-types.d.ts',
    ];
    for (const file of files) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }

    const manifestDecl = readFileSync(
      join(outDir, 'smrt-manifest.d.ts'),
      'utf-8',
    );
    expect(manifestDecl).toContain("declare module '@smrt/manifest'");

    const clientDecl = readFileSync(join(outDir, 'smrt-client.d.ts'), 'utf-8');
    expect(clientDecl).toContain("declare module '@smrt/client'");
    // Client interface derives CRUD operations keyed by unique collection name.
    expect(clientDecl).toContain('articles: CrudOperations<ArticleData>;');
    expect(clientDecl).toContain('authors: CrudOperations<AuthorData>;');

    const typesDecl = readFileSync(join(outDir, 'smrt-types.d.ts'), 'utf-8');
    expect(typesDecl).toContain("declare module '@smrt/types'");
    // Object imports re-export the generated object data types.
    expect(typesDecl).toContain(
      "export type ArticleData = import('./smrt-objects').ArticleData;",
    );
  });

  it('generates both object and virtual declarations by default', async () => {
    await generateDeclarations({ manifest: buildManifest(), outDir });
    expect(existsSync(join(outDir, 'smrt-objects.d.ts'))).toBe(true);
    expect(existsSync(join(outDir, 'smrt-manifest.d.ts'))).toBe(true);
  });

  it('reads the manifest from a JSON file path when given a string', async () => {
    const manifestFile = join(outDir, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(buildManifest()), 'utf-8');

    const typesOut = join(outDir, 'types');
    await generateDeclarations({
      manifest: manifestFile,
      outDir: typesOut,
      includeVirtualModules: false,
    });

    expect(existsSync(join(typesOut, 'smrt-objects.d.ts'))).toBe(true);
  });

  it('resolves a relative outDir against projectRoot', async () => {
    await generateDeclarations({
      manifest: buildManifest(),
      outDir: 'generated/types',
      projectRoot: outDir,
      includeVirtualModules: false,
    });
    expect(
      existsSync(join(outDir, 'generated', 'types', 'smrt-objects.d.ts')),
    ).toBe(true);
  });

  it('handles an empty manifest without throwing', async () => {
    await generateDeclarations({
      manifest: { version: '1.0.0', timestamp: 1, objects: {} },
      outDir,
    });
    // Object declaration file is still written (with no interfaces).
    expect(existsSync(join(outDir, 'smrt-objects.d.ts'))).toBe(true);
  });
});

describe('generateDeclarationsFromCLI', () => {
  it('generates declarations from a manifest path argument', async () => {
    const manifestFile = join(outDir, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(buildManifest()), 'utf-8');
    const typesOut = join(outDir, 'cli-out');

    await generateDeclarationsFromCLI([manifestFile, typesOut]);

    expect(existsSync(join(typesOut, 'smrt-objects.d.ts'))).toBe(true);
    expect(existsSync(join(typesOut, 'smrt-manifest.d.ts'))).toBe(true);
  });

  it('exits with an error when no manifest path is provided', async () => {
    // Real process.exit halts execution; emulate that by throwing so the guard
    // short-circuits exactly as it would at runtime.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(generateDeclarationsFromCLI([])).rejects.toThrow(
      'process.exit called',
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with an error when the manifest file does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      generateDeclarationsFromCLI([join(outDir, 'missing.json')]),
    ).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Manifest file not found'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
