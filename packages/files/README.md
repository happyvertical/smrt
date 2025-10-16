# @have/files

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

File system interface abstraction layer for the HAVE SDK with Node.js-focused implementation.

## Overview

The `@have/files` package provides a standardized interface for file system operations using Node.js built-in modules. It offers a unified API for local file operations with plans for remote provider support, implementing modern Node.js filesystem capabilities including Web Streams integration and async resource management.

## Key Features

- **Node.js-First Design**: Built exclusively for Node.js using fs/promises and path modules
- **Modern API**: Leverages latest Node.js LTS filesystem features including Web Streams integration
- **Provider Pattern**: Extensible architecture supporting local filesystem with remote providers planned
- **Comprehensive Error Handling**: Typed errors for file operations with proper error codes
- **Stream Support**: Efficient handling of large files using Node.js streams
- **Path Security**: Cross-platform path handling with directory traversal protection
- **Legacy Compatibility**: Backward compatibility with existing @have/files APIs

## Installation

```bash
# Install with bun (recommended)
bun add @have/files

# Or with npm
npm install @have/files

# Or with yarn
yarn add @have/files
```

## Usage

### Quick Start

```typescript
import { getFilesystem } from '@have/files';

// Create a local filesystem instance
const fs = await getFilesystem({ type: 'local', basePath: '/app/data' });

// Read a file
const content = await fs.read('config.json');
console.log(content);

// Write a file with automatic parent directory creation
await fs.write('output/result.txt', 'Hello, world!');

// Check if a file exists
const exists = await fs.exists('config.json');
console.log(`File exists: ${exists}`);

// List files in a directory with filtering
const files = await fs.list('.', { filter: /\.json$/, detailed: true });
files.forEach(file => {
  console.log(`${file.name}: ${file.size} bytes, ${file.mimeType}`);
});
```

### Advanced File Operations

```typescript
// Copy and move files
await fs.copy('source.txt', 'backup/source-copy.txt');
await fs.move('temp.txt', 'archive/temp.txt');

// Create directories with permissions
await fs.createDirectory('secure-data', { mode: 0o700 });

// Get detailed file statistics
const stats = await fs.getStats('document.pdf');
console.log(`File size: ${stats.size} bytes`);
console.log(`Modified: ${stats.mtime}`);
console.log(`Permissions: ${stats.mode.toString(8)}`);

// Delete files and directories
await fs.delete('temporary-file.txt');
```

### Stream Processing for Large Files

```typescript
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

// Process large files efficiently using Node.js streams
const readStream = createReadStream('/path/to/large-file.txt');
const writeStream = createWriteStream('/path/to/processed-file.txt');

// Transform stream example
const transformStream = new Transform({
  transform(chunk, encoding, callback) {
    // Process chunk (e.g., convert to uppercase)
    this.push(chunk.toString().toUpperCase());
    callback();
  }
});

await pipeline(readStream, transformStream, writeStream);
```

### Error Handling

```typescript
import {
  FileNotFoundError,
  PermissionError,
  DirectoryNotEmptyError
} from '@have/files';

try {
  await fs.write('/protected/file.txt', 'content');
} catch (error) {
  if (error instanceof FileNotFoundError) {
    console.error('File not found:', error.path);
  } else if (error instanceof PermissionError) {
    console.error('Permission denied:', error.path);
  } else if (error instanceof DirectoryNotEmptyError) {
    console.error('Directory not empty:', error.path);
  }
}
```

### Legacy API Compatibility

```typescript
// Legacy functions are still available for backward compatibility
import {
  isFile,
  isDirectory,
  ensureDirectoryExists,
  download,
  listFiles,
  getCached,
  setCached
} from '@have/files';

// Check file type (legacy)
const fileStats = await isFile('/path/to/file.txt');
if (fileStats) {
  console.log('File size:', fileStats.size);
}

// Directory operations (legacy)
const isDir = await isDirectory('/path/to/dir');
await ensureDirectoryExists('/path/to/new/dir');
```

## Current Implementation Status

### Available Providers

- **Local Filesystem**: ✅ Full implementation using Node.js fs/promises
- **S3-Compatible**: 🚧 Planned (AWS S3, MinIO, DigitalOcean Spaces)
- **WebDAV**: 🚧 Planned (Nextcloud, ownCloud, Apache)
- **Google Drive**: 🚧 Planned (Google Drive API v3)

### Node.js Features Utilized

- **fs/promises**: Modern async filesystem operations
- **path module**: Cross-platform path manipulation
- **stream**: Efficient large file processing
- **Web Streams**: Integration with latest Node.js stream APIs (where available)
- **Async Resource Management**: Proper cleanup with async disposal patterns

## Development

```bash
# Run tests
bun test

# Build the package
bun run build

# Watch for changes during development
bun run dev

# Generate API documentation
bun run docs
```

## API Reference

The package generates comprehensive API documentation using TypeDoc. See the generated documentation for detailed method signatures, options, and examples.

## Dependencies

- **@have/utils**: Core utilities for path handling and temporary directories
- **Node.js built-ins**: fs/promises, path, stream (no external filesystem dependencies)

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.