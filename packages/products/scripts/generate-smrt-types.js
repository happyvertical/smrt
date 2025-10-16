#!/usr/bin/env node
/**
 * Generate SMRT type declarations for products package
 * This creates the TypeScript declarations needed for virtual modules
 */

import { generateDeclarations } from '@smrt/core/prebuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Generate basic type declarations for virtual modules
const basicManifest = {
  version: '1.0.0',
  timestamp: Date.now(),
  objects: {
    product: {
      name: 'product',
      className: 'Product',
      collection: 'products',
      filePath: 'src/lib/models/Product.ts',
      fields: {
        name: { type: 'text', required: true },
        description: { type: 'text', required: false },
        category: { type: 'text', required: false },
        manufacturer: { type: 'text', required: false },
        model: { type: 'text', required: false },
        price: { type: 'decimal', required: false },
        inStock: { type: 'boolean', required: false },
        specifications: { type: 'json', required: false },
        tags: { type: 'json', required: false }
      },
      methods: {},
      decoratorConfig: {
        api: { include: ['list', 'get', 'create', 'update'] },
        mcp: { include: ['list', 'get'] },
        cli: true
      }
    },
    category: {
      name: 'category',
      className: 'Category',
      collection: 'categories',
      filePath: 'src/lib/models/Category.ts',
      fields: {
        name: { type: 'text', required: true },
        description: { type: 'text', required: false },
        slug: { type: 'text', required: false },
        parentId: { type: 'text', required: false },
        level: { type: 'integer', required: false },
        productCount: { type: 'integer', required: false },
        active: { type: 'boolean', required: false }
      },
      methods: {},
      decoratorConfig: {
        api: { include: ['list', 'get', 'create', 'update'] },
        mcp: { include: ['list', 'get'] },
        cli: true
      }
    }
  }
};

try {
  console.log('[products] Generating SMRT type declarations...');

  await generateDeclarations({
    manifest: basicManifest,
    outDir: 'src/lib/types/smrt-generated',
    projectRoot,
    includeVirtualModules: true,
    includeObjectTypes: true
  });

  console.log('[products] ✅ Generated SMRT type declarations');
} catch (error) {
  console.error('[products] Error generating type declarations:', error);
  process.exit(1);
}