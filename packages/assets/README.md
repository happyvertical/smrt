---
id: assets
title: '@smrt/assets: Asset Management System'
sidebar_label: '@smrt/assets'
sidebar_position: 5
---

# @smrt/assets

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Asset management system with versioning, metadata, and AI-powered operations for SMRT framework.

## Overview

The `@smrt/assets` package provides a comprehensive asset management system built on the SMRT framework. It enables storage, versioning, and organization of digital assets with rich metadata, tagging integration, and automatic REST API, CLI, and MCP tool generation.

**Key capabilities:**
- **Asset Storage**: Track digital assets with URI-based references to files
- **Versioning**: Built-in version control with parent-child relationships for derivatives
- **Metadata Management**: Flexible metadata with controlled vocabulary and validation
- **Tagging Integration**: Full integration with `@smrt/tags` for hierarchical organization
- **Type & Status**: Extensible asset type and lifecycle status classification
- **AI-Powered Operations**: Leverage SMRT's AI methods for intelligent asset operations
- **Auto-Generated Interfaces**: REST APIs, CLI commands, and MCP tools created automatically

## Features

- **Asset Management**: Store and track digital assets with URIs, MIME types, and descriptions
- **Version Control**: Track asset versions with primary version references and derivatives
- **Hierarchical Structure**: Parent-child relationships for derivative assets
- **Type Classification**: Extensible asset types (image, video, document, etc.)
- **Lifecycle Status**: Track asset status (draft, published, archived, etc.)
- **Metadata System**: Controlled vocabulary for metadata with JSON validation rules
- **Tag Integration**: Full support for hierarchical tagging via `@smrt/tags`
- **Owner Tracking**: Associate assets with profile owners
- **Automatic APIs**: REST endpoints auto-generated for all CRUD operations
- **CLI Tools**: Command-line interface auto-generated for asset management
- **MCP Integration**: AI-accessible tools for Model Context Protocol servers
- **Type Safety**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
# Install with pnpm (recommended)
pnpm add @smrt/assets

# Or with npm
npm install @smrt/assets

# Or with yarn
yarn add @smrt/assets
```

## Quick Start

### Basic Asset Creation

```typescript
import { Asset, AssetType, AssetStatus } from '@smrt/assets';

// Create an asset type
const imageType = new AssetType({
  slug: 'image',
  name: 'Image',
  description: 'Image files'
});
await imageType.save();

// Create an asset status
const publishedStatus = new AssetStatus({
  slug: 'published',
  name: 'Published',
  description: 'Published and available'
});
await publishedStatus.save();

// Create an asset
const asset = new Asset({
  name: 'Product Photo',
  slug: 'product-photo-001',
  sourceUri: 's3://mybucket/products/photo-001.jpg',
  mimeType: 'image/jpeg',
  description: 'Main product photograph',
  typeSlug: 'image',
  statusSlug: 'published',
  version: 1
});

await asset.save();
console.log(`Asset created: ${asset.id}`);
```

### Asset Versioning

```typescript
// Create a new version of an existing asset
const originalAsset = await Asset.getBySlug('product-photo-001');

const newVersion = new Asset({
  name: 'Product Photo',
  slug: 'product-photo-002',
  sourceUri: 's3://mybucket/products/photo-002.jpg',
  mimeType: 'image/jpeg',
  description: 'Updated product photograph',
  typeSlug: 'image',
  statusSlug: 'published',
  version: 2,
  primaryVersionId: originalAsset.id // Link to original
});

await newVersion.save();
```

### Parent-Child Relationships (Derivatives)

```typescript
// Create a thumbnail derivative
const thumbnail = new Asset({
  name: 'Product Photo Thumbnail',
  slug: 'product-photo-001-thumb',
  sourceUri: 's3://mybucket/products/photo-001-thumb.jpg',
  mimeType: 'image/jpeg',
  description: 'Thumbnail version',
  typeSlug: 'image',
  statusSlug: 'published',
  version: 1,
  parentId: originalAsset.id // Link to parent asset
});

await thumbnail.save();

// Get all derivatives
const derivatives = await originalAsset.getChildren();
console.log(`Found ${derivatives.length} derivative assets`);

// Get parent asset
const parent = await thumbnail.getParent();
console.log(`Parent asset: ${parent?.name}`);
```

### Working with Tags

```typescript
import { Tag } from '@smrt/tags';

// Create and tag an asset
const asset = await Asset.getBySlug('product-photo-001');

// Get all tags for an asset
const tags = await asset.getTags();
console.log(`Asset has ${tags.length} tags`);

// Check if asset has a specific tag
const hasTag = await asset.hasTag('featured');
console.log(`Is featured: ${hasTag}`);
```

### Metadata Management

```typescript
import { AssetMetafield } from '@smrt/assets';

// Define a metadata field with validation
const widthField = new AssetMetafield({
  slug: 'width',
  name: 'Width',
  validation: JSON.stringify({
    type: 'integer',
    minimum: 1,
    maximum: 10000
  })
});
await widthField.save();

// Get validation rules
const rules = widthField.getValidation();
console.log('Validation rules:', rules);

// Update validation rules
widthField.setValidation({
  type: 'integer',
  minimum: 100,
  maximum: 5000
});
await widthField.save();
```

### Querying Assets

```typescript
import { AssetCollection } from '@smrt/assets';

// List all assets
const allAssets = await AssetCollection.list();
console.log(`Total assets: ${allAssets.length}`);

// Filter by type
const images = await AssetCollection.list({
  where: { typeSlug: 'image' }
});

// Filter by status
const published = await AssetCollection.list({
  where: { statusSlug: 'published' }
});

// Get a specific asset
const asset = await AssetCollection.get({ id: 'asset-123' });
const assetBySlug = await Asset.getBySlug('product-photo-001');
```

### AI-Powered Asset Operations

```typescript
// Use SMRT's AI-powered methods for intelligent operations
const asset = await Asset.getBySlug('product-photo-001');

// AI-powered validation
const isValid = await asset.is('a high-quality product image');
console.log(`Is high quality: ${isValid}`);

// AI-powered actions
await asset.do('optimize for web display');

// AI-powered description generation
const description = await asset.describe('in detail');
console.log(`Asset description: ${description}`);
```

### Asset Types and Statuses

```typescript
import { AssetTypeCollection, AssetStatusCollection } from '@smrt/assets';

// Create common asset types
const types = [
  { slug: 'image', name: 'Image', description: 'Image files' },
  { slug: 'video', name: 'Video', description: 'Video files' },
  { slug: 'document', name: 'Document', description: 'Document files' },
  { slug: 'audio', name: 'Audio', description: 'Audio files' }
];

for (const typeData of types) {
  const type = new AssetType(typeData);
  await type.save();
}

// Create lifecycle statuses
const statuses = [
  { slug: 'draft', name: 'Draft', description: 'Work in progress' },
  { slug: 'review', name: 'In Review', description: 'Under review' },
  { slug: 'published', name: 'Published', description: 'Published and available' },
  { slug: 'archived', name: 'Archived', description: 'Archived and inactive' }
];

for (const statusData of statuses) {
  const status = new AssetStatus(statusData);
  await status.save();
}

// Get asset type and status
const asset = await Asset.getBySlug('product-photo-001');
const type = await asset.getType();
const status = await asset.getStatus();

console.log(`Type: ${type?.name}, Status: ${status?.name}`);
```

## Usage

### Core Models

The package provides four main models:

1. **Asset**: Core asset entity with versioning and relationships
2. **AssetType**: Type classification (image, video, document, etc.)
3. **AssetStatus**: Lifecycle status (draft, published, archived, etc.)
4. **AssetMetafield**: Controlled vocabulary for metadata fields

### Collections

Each model has an associated collection for bulk operations:

- `AssetCollection`: Manage multiple assets
- `AssetTypeCollection`: Manage asset types
- `AssetStatusCollection`: Manage asset statuses
- `AssetMetafieldCollection`: Manage metadata field definitions

### Asset Properties

```typescript
interface AssetOptions {
  // Core fields
  name: string;                    // User-friendly name
  slug: string;                    // URL-friendly identifier
  sourceUri: string;               // URI to actual file
  mimeType: string;                // MIME type (e.g., 'image/jpeg')
  description?: string;            // Optional description
  version: number;                 // Version number (default: 1)

  // Relationships
  primaryVersionId?: string | null; // First version's ID
  typeSlug: string;                // Asset type reference
  statusSlug: string;              // Asset status reference
  ownerProfileId?: string | null;  // Owner profile reference
  parentId?: string | null;        // Parent asset (for derivatives)

  // Timestamps
  createdAt?: Date;                // Creation timestamp
  updatedAt?: Date;                // Last update timestamp
}
```

### Asset Methods

```typescript
// Relationship methods
await asset.getTags();              // Get all tags
await asset.hasTag(tagSlug);        // Check for specific tag
await asset.getParent();            // Get parent asset
await asset.getChildren();          // Get derivative assets
await asset.getType();              // Get AssetType instance
await asset.getStatus();            // Get AssetStatus instance

// Static methods
await Asset.getBySlug(slug);        // Find asset by slug

// AI-powered methods (from SMRT)
await asset.is(condition);          // AI validation
await asset.do(action);             // AI-powered action
await asset.describe(prompt);       // AI description
```

### Auto-Generated Interfaces

The `@smrt()` decorator automatically generates:

**REST API Endpoints:**
```
GET    /api/assets         # List assets
GET    /api/assets/:id     # Get asset
POST   /api/assets         # Create asset
PUT    /api/assets/:id     # Update asset
DELETE /api/assets/:id     # Delete asset
```

**CLI Commands:**
```bash
smrt assets list            # List all assets
smrt assets get <id>        # Get asset details
smrt assets create          # Create new asset
smrt assets update <id>     # Update asset
smrt assets delete <id>     # Delete asset
```

**MCP Tools:**
- `list_assets`: List and query assets
- `get_asset`: Get asset details
- `create_asset`: Create new asset
- `update_asset`: Update existing asset

## Advanced Usage

### Owner Integration with Profiles

```typescript
// Associate asset with owner (requires @smrt/profiles)
const asset = new Asset({
  name: 'User Avatar',
  slug: 'user-avatar-123',
  sourceUri: 's3://mybucket/avatars/user-123.jpg',
  mimeType: 'image/jpeg',
  typeSlug: 'image',
  statusSlug: 'published',
  ownerProfileId: 'profile-123' // FK to Profile.id
});

await asset.save();
```

### Complex Queries

```typescript
// Find all published images
const publishedImages = await AssetCollection.list({
  where: {
    typeSlug: 'image',
    statusSlug: 'published'
  }
});

// Find all derivatives of a parent asset
const derivatives = await AssetCollection.list({
  where: {
    parentId: parentAsset.id
  }
});

// Find all versions of an asset
const versions = await AssetCollection.list({
  where: {
    primaryVersionId: originalAsset.id
  }
});
```

### Validation Rules for Metadata

```typescript
// Define numeric validation
const widthField = new AssetMetafield({
  slug: 'width',
  name: 'Width',
  validation: JSON.stringify({
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    description: 'Image width in pixels'
  })
});

// Define enum validation
const orientationField = new AssetMetafield({
  slug: 'orientation',
  name: 'Orientation',
  validation: JSON.stringify({
    type: 'string',
    enum: ['portrait', 'landscape', 'square']
  })
});

// Define pattern validation
const colorCodeField = new AssetMetafield({
  slug: 'color_code',
  name: 'Color Code',
  validation: JSON.stringify({
    type: 'string',
    pattern: '^#[0-9A-Fa-f]{6}$',
    description: 'Hex color code'
  })
});
```

## TypeScript Support

The package is written in TypeScript and provides comprehensive type definitions:

```typescript
import type {
  AssetOptions,
  AssetTypeOptions,
  AssetStatusOptions,
  AssetMetafieldOptions
} from '@smrt/assets';

import {
  Asset,
  AssetType,
  AssetStatus,
  AssetMetafield,
  AssetCollection,
  AssetTypeCollection,
  AssetStatusCollection,
  AssetMetafieldCollection
} from '@smrt/assets';
```

## API Reference

For complete API documentation, see the generated TypeDoc documentation at [/api/assets/globals](/api/assets/globals).

**Core Classes:**
- `Asset`: Main asset entity with versioning
- `AssetType`: Asset type classification
- `AssetStatus`: Lifecycle status tracking
- `AssetMetafield`: Metadata field definitions

**Collections:**
- `AssetCollection`: Asset collection management
- `AssetTypeCollection`: Asset type collection
- `AssetStatusCollection`: Asset status collection
- `AssetMetafieldCollection`: Metadata field collection

**Types:**
- `AssetOptions`: Asset configuration interface
- `AssetTypeOptions`: Asset type configuration
- `AssetStatusOptions`: Asset status configuration
- `AssetMetafieldOptions`: Metadata field configuration

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
