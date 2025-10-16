# @have/files: File System Interface Package

## Purpose and Responsibilities

The `@have/files` package provides a standardized interface for file system operations with multi-provider support. It serves as the file system abstraction layer for the HAVE SDK and handles:

- **Local and Remote File Systems**: Unified API for local filesystem with planned support for S3-compatible services, Google Drive, and WebDAV (Nextcloud/ownCloud)
- **Cross-Platform Operations**: Consistent file operations across different Node.js platforms
- **Stream Processing**: Efficient handling of large files through Node.js streams and Web Streams integration
- **Temporary File Management**: Secure temporary file creation with automatic cleanup via @have/utils
- **Caching and Performance**: Built-in caching for files and optimized data transfer
- **Rate-Limited Fetch**: Automatic rate limiting for HTTP requests by domain
- **Legacy Compatibility**: Backward compatibility with existing @have/files APIs
- **Path Normalization**: Cross-platform path handling and URL-to-filesystem conversion
- **Modern Node.js Features**: Utilizes latest fs/promises, async resource management, and Web Streams APIs

This package abstracts away the complexities of different file systems, allowing other packages to work with files consistently regardless of the underlying storage provider.

**Expert Agent Expertise**: When working with this package, always proactively check the latest Node.js LTS documentation for fs/promises, path, and stream modules as they frequently add new methods, performance improvements, and security enhancements that can benefit file operations.

## Package Architecture

### Core Components

```
@have/files/
├── src/
│   ├── index.ts                    # Main exports and module initialization
│   ├── shared/
│   │   ├── types.ts               # TypeScript interfaces and error classes
│   │   ├── base.ts                # BaseFilesystemProvider abstract class
│   │   └── factory.ts             # Provider factory and registration system
│   ├── node/
│   │   └── local.ts               # LocalFilesystemProvider (Node.js)
│   ├── fetch.ts                   # Rate-limited fetch utilities
│   ├── filesystem.ts              # FilesystemAdapter base class (legacy)
│   └── legacy.ts                  # Backward-compatible standalone functions
```

### Provider System

The package uses a **factory pattern** with dynamic provider registration:

- **Provider Registry**: Map-based registry allows runtime provider registration
- **Factory Function**: `getFilesystem(options)` creates provider instances
- **Auto-Detection**: Automatic provider type detection from options
- **Validation**: Comprehensive options validation before instantiation
- **Lazy Loading**: Providers are initialized on first use

### Error Hierarchy

```typescript
FilesystemError (base)
├── FileNotFoundError (ENOENT)
├── PermissionError (EACCES)
├── DirectoryNotEmptyError (ENOTEMPTY)
└── InvalidPathError (EINVAL)
```

All errors include: message, code, path (optional), and provider (optional).

## Key APIs

### Provider Factory and Configuration

```typescript
import { getFilesystem, getAvailableProviders } from '@have/files';

// Get local filesystem provider (default)
const fs = await getFilesystem({ type: 'local', basePath: '/app/data' });

// Auto-detect based on options (no explicit type needed)
const autoFs = await getFilesystem({ basePath: '/data' }); // Defaults to local

// S3-compatible provider (planned)
const s3fs = await getFilesystem({
  type: 's3',
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'your-key',
  secretAccessKey: 'your-secret'
});

// WebDAV provider (planned)
const webdavfs = await getFilesystem({
  type: 'webdav',
  baseUrl: 'https://cloud.example.com',
  username: 'user',
  password: 'pass',
  davPath: '/remote.php/dav/files/user/'
});

// List available providers
const providers = getAvailableProviders();
console.log(providers); // ['local'] (more to come)
```

### Core File Operations

```typescript
import { getFilesystem } from '@have/files';

const fs = await getFilesystem({ type: 'local' });

// Read file with encoding options
const content = await fs.read('/path/to/file.txt', { encoding: 'utf-8' });

// Read binary data as Buffer
const buffer = await fs.read('/path/to/image.png', { raw: true });

// Write file with parent directory creation
await fs.write('/path/to/new/file.txt', 'Content', {
  createParents: true,
  encoding: 'utf-8'
});

// Write with specific permissions (Unix/Linux)
await fs.write('/path/to/secure.txt', 'sensitive', {
  mode: 0o600 // Owner read/write only
});

// Check file existence
const exists = await fs.exists('/path/to/file.txt');

// Copy and move files
await fs.copy('/source/file.txt', '/dest/file.txt');
await fs.move('/old/path.txt', '/new/path.txt');

// Delete files and directories (directory must be empty)
await fs.delete('/path/to/file.txt');
```

### Directory Management

```typescript
// Create directory with options
await fs.createDirectory('/path/to/new/dir', {
  recursive: true,
  mode: 0o755
});

// List directory contents with filtering
const files = await fs.list('/path/to/dir', {
  recursive: true,
  filter: /\.js$/,
  detailed: true
});

// Access detailed file information
for (const file of files) {
  console.log(`${file.name}: ${file.size} bytes, modified: ${file.lastModified}`);
  console.log(`Type: ${file.isDirectory ? 'Directory' : 'File'}`);
  console.log(`MIME: ${file.mimeType}`);
  console.log(`Extension: ${file.extension}`);
}

// Filter with string pattern (converted to RegExp)
const jsonFiles = await fs.list('/data', { filter: '\\.json$' });

// Get file statistics
const stats = await fs.getStats('/path/to/file.txt');
console.log(`Size: ${stats.size} bytes`);
console.log(`Modified: ${stats.mtime}`);
console.log(`Is file: ${stats.isFile}`);
console.log(`Permissions: ${stats.mode.toString(8)}`);
```

### Stream Processing for Large Files

```typescript
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';

// Stream large file processing
const readStream = createReadStream('/path/to/large/file.txt');
const writeStream = createWriteStream('/path/to/output.txt');

// Transform stream example
const transformStream = new Transform({
  transform(chunk, encoding, callback) {
    // Process chunk
    this.push(chunk.toString().toUpperCase());
    callback();
  }
});

await pipeline(readStream, transformStream, writeStream);

// Compress large file without loading into memory
const input = createReadStream('/path/to/large/file.txt');
const gzip = createGzip();
const output = createWriteStream('/path/to/compressed.gz');
await pipeline(input, gzip, output);

// Process files in chunks
async function processLargeFile(filePath: string) {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

  for await (const chunk of stream) {
    // Process chunk without loading entire file
    await processChunk(chunk);
  }
}
```

### Rate-Limited Fetch Utilities

```typescript
import {
  fetchText,
  fetchJSON,
  fetchBuffer,
  fetchToFile,
  addRateLimit,
  getRateLimit
} from '@have/files';

// Configure rate limits for specific domains
await addRateLimit('api.github.com', 30, 60000); // 30 requests per minute
await addRateLimit('my-api.example.com', 10, 5000); // 10 requests per 5 seconds

// Get current rate limit for a domain
const config = await getRateLimit('api.github.com');
console.log(`GitHub API: ${config.limit} requests per ${config.interval}ms`);

// Fetch text content (HTML, plain text, etc.)
const html = await fetchText('https://example.com');

// Fetch and parse JSON (REST APIs)
const data = await fetchJSON('https://api.github.com/user');

// Fetch binary data as Buffer
const imageBuffer = await fetchBuffer('https://example.com/image.png');

// Fetch and save directly to file
await fetchToFile('https://example.com/large-file.zip', './downloads/file.zip');

// All fetch functions automatically respect rate limits by domain
```

### Temporary File Management

```typescript
import { getTempDirectory } from '@have/utils';
import { getFilesystem } from '@have/files';
import { join } from 'path';
import { mkdir, rmdir } from 'fs/promises';

const fs = await getFilesystem({ type: 'local' });

// Create temporary files using getTempDirectory from @have/utils
const tempDir = getTempDirectory('processing');
const tempFile = join(tempDir, 'data.json');

try {
  // Write temporary file
  await fs.write(tempFile, JSON.stringify({ key: 'value' }));

  // Use temporary file
  const data = await fs.read(tempFile);
  console.log(JSON.parse(data));
} finally {
  // Clean up temporary file
  if (await fs.exists(tempFile)) {
    await fs.delete(tempFile);
  }
}

// Create custom temporary directory for batch operations
const customTempDir = join(getTempDirectory('batch-operations'), 'session-' + Date.now());
await mkdir(customTempDir, { recursive: true });

try {
  // Use temporary directory for batch operations
  await fs.write(join(customTempDir, 'file1.txt'), 'data1');
  await fs.write(join(customTempDir, 'file2.txt'), 'data2');

  // Process files...
  const files = await fs.list(customTempDir);
  console.log('Temp files created:', files.map(f => f.name));
} finally {
  // Clean up entire directory
  await rmdir(customTempDir, { recursive: true });
}
```

### Cross-Platform Path Utilities

```typescript
import path from 'path';

// Modern path handling with Node.js built-ins
const absolutePath = path.resolve('~/documents/file.txt');
const normalizedPath = path.normalize('./folder/../file.txt');

// Cross-platform path joining
const filePath = path.join(process.cwd(), 'data', 'files', 'document.pdf');

// Path analysis
const pathInfo = path.parse('/home/user/documents/file.txt');
console.log(pathInfo);
// {
//   root: '/',
//   dir: '/home/user/documents',
//   base: 'file.txt',
//   ext: '.txt',
//   name: 'file'
// }

// Platform-specific operations
const isAbsolute = path.isAbsolute('/home/user/file.txt'); // true
const relativePath = path.relative('/home/user', '/home/user/documents/file.txt'); // documents/file.txt

// Extract components
const extension = path.extname('/path/to/document.pdf'); // '.pdf'
const filename = path.basename('/path/to/document.pdf'); // 'document.pdf'
const directory = path.dirname('/path/to/document.pdf'); // '/path/to'
```

### Caching Operations

```typescript
// Manual cache management
await fs.cache.set('user-data', JSON.stringify(userData));

const cachedData = await fs.cache.get('user-data', 300000); // 5 minutes expiry
if (cachedData) {
  const userData = JSON.parse(cachedData);
}

// Clear specific cache entry
await fs.cache.clear('user-data');

// Clear all cache
await fs.cache.clear();
```

### Legacy API Compatibility

```typescript
// Legacy functions still available for backward compatibility
import {
  isFile,
  isDirectory,
  ensureDirectoryExists,
  download,
  upload,
  listFiles,
  getCached,
  setCached,
  getMimeType
} from '@have/files';

// Check file type (legacy)
const fileStats = await isFile('/path/to/file.txt');
if (fileStats) {
  console.log('File size:', fileStats.size);
}

// Directory operations (legacy)
const isDir = await isDirectory('/path/to/dir');
await ensureDirectoryExists('/path/to/new/dir');

// File listing (legacy)
const files = await listFiles('/path/to/dir', { match: /\.txt$/ });

// Get MIME type from file or URL
const mimeType = getMimeType('/path/to/document.pdf'); // 'application/pdf'
const urlMime = getMimeType('https://example.com/image.jpg'); // 'image/jpeg'
```

## Dependencies

The package has carefully chosen dependencies for optimal performance:

### Internal Dependencies
- **@have/utils**: Core utilities for path handling, temporary directory management (`getTempDirectory`), and cross-platform operations

### Runtime Dependencies
- **Node.js fs/promises**: Modern async file system operations
- **Node.js path**: Cross-platform path manipulation and normalization
- **Node.js stream**: Efficient large file processing through streams
- **Node.js http/https**: Built-in fetch for HTTP operations

### Provider-Specific Dependencies (Planned)
- **AWS SDK v3**: For S3-compatible storage providers (planned implementation)
- **Google APIs**: For Google Drive integration (planned implementation)
- **WebDAV clients**: For Nextcloud/ownCloud/Apache WebDAV servers (planned implementation)

The core package currently uses only Node.js built-ins for local filesystem operations. Remote providers will have optional external dependencies loaded dynamically when implemented and used.

## Development Guidelines

### Multi-Provider Architecture

The package uses a provider pattern for different storage backends:

```typescript
// Each provider implements the FilesystemInterface
interface FilesystemInterface {
  exists(path: string): Promise<boolean>;
  read(path: string, options?: ReadOptions): Promise<string | Buffer>;
  write(path: string, content: string | Buffer, options?: WriteOptions): Promise<void>;
  delete(path: string): Promise<void>;
  copy(sourcePath: string, destPath: string): Promise<void>;
  move(sourcePath: string, destPath: string): Promise<void>;
  createDirectory(path: string, options?: CreateDirOptions): Promise<void>;
  list(path: string, options?: ListOptions): Promise<FileInfo[]>;
  getStats(path: string): Promise<FileStats>;
  getMimeType(path: string): Promise<string>;
  upload(localPath: string, remotePath: string, options?: UploadOptions): Promise<void>;
  download(remotePath: string, localPath?: string, options?: DownloadOptions): Promise<string>;
  downloadWithCache(remotePath: string, options?: CacheOptions): Promise<string>;
  cache: {
    get(key: string, expiry?: number): Promise<string | undefined>;
    set(key: string, data: string): Promise<void>;
    clear(key?: string): Promise<void>;
  };
  getCapabilities(): Promise<FilesystemCapabilities>;
  // Legacy method compatibility
  isFile(file: string): Promise<false | FileStats>;
  isDirectory(dir: string): Promise<boolean>;
  ensureDirectoryExists(dir: string): Promise<void>;
  uploadToUrl(url: string, data: string | Buffer): Promise<Response>;
  downloadFromUrl(url: string, filepath: string): Promise<void>;
  downloadFileWithCache(url: string, targetPath?: string | null): Promise<string>;
  listFiles(dirPath: string, options?: ListFilesOptions): Promise<string[]>;
  getCached(file: string, expiry?: number): Promise<string | undefined>;
  setCached(file: string, data: string): Promise<void>;
}

// Providers are registered and available based on runtime environment
const availableProviders = getAvailableProviders();

// Register custom providers
registerProvider('custom', async () => {
  const { CustomProvider } = await import('./custom-provider.js');
  return CustomProvider;
});
```

### Creating Custom Providers

To create a custom provider:

1. **Extend BaseFilesystemProvider**:
```typescript
import { BaseFilesystemProvider } from '@have/files';

export class MyCustomProvider extends BaseFilesystemProvider {
  constructor(options: MyCustomOptions) {
    super(options);
    // Initialize custom provider
  }

  async exists(path: string): Promise<boolean> {
    // Implement exists
  }

  async read(path: string, options?: ReadOptions): Promise<string | Buffer> {
    // Implement read
  }

  // ... implement all required methods
}
```

2. **Register the provider**:
```typescript
import { registerProvider } from '@have/files';

registerProvider('mycustom', async () => {
  const { MyCustomProvider } = await import('./my-custom-provider.js');
  return MyCustomProvider;
});
```

3. **Use the provider**:
```typescript
const fs = await getFilesystem({ type: 'mycustom', customOption: 'value' });
```

### Error Handling and Recovery

Implement comprehensive error handling for different failure modes:

```typescript
import {
  FilesystemError,
  FileNotFoundError,
  PermissionError,
  DirectoryNotEmptyError
} from '@have/files';

try {
  await fs.write('/protected/file.txt', 'content');
} catch (error) {
  if (error instanceof FileNotFoundError) {
    console.error('File not found:', error.path);
    console.error('Provider:', error.provider);
  } else if (error instanceof PermissionError) {
    console.error('Permission denied:', error.path);
    // Try with different permissions or path
  } else if (error instanceof DirectoryNotEmptyError) {
    console.error('Directory not empty:', error.path);
    // Recursively delete or handle differently
  } else if (error.code === 'ENOSPC') {
    console.error('Disk full');
    // Clean up temp files or use different location
  } else {
    console.error('Unexpected error:', error.message);
  }
}
```

### Stream Processing Best Practices

Use streams for large files to manage memory efficiently, leveraging the latest Node.js LTS features:

```typescript
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { createReadStream, createWriteStream } from 'fs';

// Compress large file without loading into memory
const input = createReadStream('/path/to/large/file.txt');
const gzip = createGzip();
const output = createWriteStream('/path/to/compressed.gz');

await pipeline(input, gzip, output);

// Process files in chunks
async function processLargeFile(filePath: string) {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

  for await (const chunk of stream) {
    // Process chunk without loading entire file
    await processChunk(chunk);
  }
}

// Error handling in pipelines
try {
  await pipeline(
    createReadStream('input.txt'),
    transformStream,
    createWriteStream('output.txt')
  );
} catch (error) {
  console.error('Pipeline failed:', error);
  // Clean up partial output if needed
}
```

### Cross-Platform Considerations

Always use path utilities for cross-platform compatibility:

```typescript
// ✅ Good - cross-platform
const configPath = path.join(process.cwd(), 'config', 'app.json');
const absolutePath = path.resolve('./data/files');
const normalized = path.normalize(userPath);

// ❌ Bad - platform-specific
const badPath = process.cwd() + '/config/app.json'; // Unix-only
const windowsPath = 'C:\\data\\files'; // Windows-only

// Handle different path separators
const posixPath = path.posix.join('home', 'user', 'file.txt'); // Always forward slashes
const winPath = path.win32.join('C:', 'Users', 'file.txt'); // Always backslashes

// Safe path resolution within base directory
function resolveSafePath(basePath: string, userPath: string): string {
  const normalized = path.normalize(userPath);
  const resolved = path.resolve(basePath, normalized);

  // Ensure resolved path is within base directory
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error('Path outside allowed directory');
  }

  return resolved;
}
```

### Security Considerations

Implement secure file operations:

```typescript
// Validate and sanitize file paths
function validatePath(userPath: string): string {
  const normalized = path.normalize(userPath);

  // Prevent directory traversal
  if (normalized.includes('..')) {
    throw new Error('Directory traversal not allowed');
  }

  // Ensure path is within allowed base directory
  const basePath = '/app/data';
  const fullPath = path.resolve(basePath, normalized);

  if (!fullPath.startsWith(path.resolve(basePath))) {
    throw new Error('Path outside allowed directory');
  }

  return fullPath;
}

// Set appropriate file permissions (Unix/Linux)
await fs.write('/path/to/sensitive.txt', 'data', { mode: 0o600 }); // Owner read/write only
await fs.createDirectory('/path/to/private', { mode: 0o700 }); // Owner access only

// Sanitize filenames from user input
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-z0-9._-]/gi, '_') // Replace invalid chars
    .replace(/\.+/g, '.') // Collapse multiple dots
    .replace(/^\./, '') // Remove leading dot
    .slice(0, 255); // Limit length
}

// Use temporary directories for untrusted content
const tempDir = getTempDirectory('untrusted-uploads');
const safePath = path.join(tempDir, sanitizeFilename(userFilename));
```

### Testing Strategies

```typescript
// Use temporary directories for tests
import { describe, it, beforeEach, afterEach } from 'vitest';
import { getTempDirectory } from '@have/utils';
import { getFilesystem } from '@have/files';

describe('FileSystem Tests', () => {
  let fs: FilesystemInterface;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = getTempDirectory('test-files');
    fs = await getFilesystem({ type: 'local', basePath: tempDir });
  });

  afterEach(async () => {
    // Clean up temp directory
    await rmdir(tempDir, { recursive: true, force: true });
  });

  it('should write and read files', async () => {
    await fs.write('test.txt', 'test content');
    const content = await fs.read('test.txt');
    expect(content).toBe('test content');
  });

  it('should handle errors gracefully', async () => {
    await expect(fs.read('nonexistent.txt')).rejects.toThrow(FileNotFoundError);
  });

  it('should list files with filter', async () => {
    await fs.write('file1.txt', 'data1');
    await fs.write('file2.json', 'data2');
    await fs.write('file3.txt', 'data3');

    const files = await fs.list('.', { filter: /\.txt$/ });
    expect(files).toHaveLength(2);
    expect(files.map(f => f.name)).toContain('file1.txt');
  });
});
```

### Performance Optimization

```typescript
// Batch operations for multiple files
async function processMultipleFiles(files: string[]) {
  // Use Promise.all for independent operations
  const contents = await Promise.all(
    files.map(file => fs.read(file))
  );

  return contents.map(content => processContent(content));
}

// Use Promise.allSettled for error handling
async function readMultipleWithErrors(files: string[]) {
  const results = await Promise.allSettled(
    files.map(file => fs.read(file))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      console.log('Content:', result.value);
    } else {
      console.error('Error:', result.reason);
    }
  }
}

// Cache file stats when doing multiple operations
const statsCache = new Map<string, FileStats>();

async function getFileInfoCached(filePath: string) {
  if (!statsCache.has(filePath)) {
    statsCache.set(filePath, await fs.getStats(filePath));
  }
  return statsCache.get(filePath)!;
}

// Use streams for large file operations
async function copyLargeFile(source: string, dest: string) {
  await pipeline(
    createReadStream(source),
    createWriteStream(dest)
  );
}

// Rate limiting for fetch operations
// Automatically handled by fetchText, fetchJSON, fetchBuffer, fetchToFile
// Configure custom limits for specific domains
await addRateLimit('api.example.com', 100, 60000); // 100 req/min
```

### Building and Testing

```bash
# Development workflow
npm test                    # Run tests once
npm run test:watch         # Run tests in watch mode
npm run build              # Build the Node.js package
npm run build:watch        # Build in watch mode
npm run dev                # Build and test in watch mode
npm run docs               # Generate API documentation
npm run docs:watch         # Generate docs in watch mode
npm run clean              # Clean build artifacts
```

### Best Practices Summary

- **Always use path utilities** for cross-platform compatibility
- **Implement proper error handling** for all file operations with typed error classes
- **Use streams for large files** to manage memory efficiently
- **Clean up temporary files** promptly to avoid resource leaks
- **Validate file paths** to prevent security issues (directory traversal)
- **Use appropriate file permissions** for sensitive data (Unix/Linux)
- **Cache wisely** to improve performance without stale data
- **Test with temporary directories** to avoid side effects
- **Handle encoding explicitly** when working with text files
- **Use the factory pattern** (`getFilesystem`) rather than direct instantiation
- **Leverage rate limiting** for external HTTP requests
- **Check provider capabilities** before using advanced features
- **Use batch operations** with Promise.all for independent operations
- **Sanitize user input** before using in file paths

## Implementation Details

### LocalFilesystemProvider Internals

The LocalFilesystemProvider is the primary implementation:

- **Root Path**: Operates within a configurable root path for security
- **Path Resolution**: All paths resolved relative to root with validation
- **Parent Directory Creation**: Automatic parent directory creation when `createParents: true`
- **Error Mapping**: Node.js error codes mapped to typed error classes
- **Cache**: File-based cache using OS temp directory via getTempDirectory
- **MIME Type Detection**: Extension-based MIME type lookup (30+ types)
- **Legacy Support**: Full backward compatibility with legacy API

### BaseFilesystemProvider Features

The abstract base class provides:

- **Path Validation**: Prevents directory traversal (.. and ~ checks)
- **Path Normalization**: Removes leading/trailing slashes, combines with base path
- **Cache Key Generation**: Provider-specific cache key generation
- **Default Implementations**: Common method implementations for legacy compatibility
- **Error Handling**: Standardized error throwing for unsupported operations
- **Cache Directory**: Context-aware cache directory setup

### Factory Pattern Details

The factory system provides:

- **Provider Registry**: Map-based registry for dynamic provider registration
- **Lazy Loading**: Providers loaded on-demand, not at module import
- **Option Validation**: Comprehensive validation of provider-specific options
- **Auto-Detection**: Heuristic-based provider type detection from options
- **Provider Info**: Capability and status queries for registered providers

### Rate Limiter Implementation

The rate limiter provides:

- **Domain-Based**: Separate limits per domain (hostname)
- **Queue Management**: Request queuing when limits exceeded
- **Automatic Delays**: Automatic waiting when over limit
- **Default Limits**: 6 requests per 500ms (configurable per domain)
- **Singleton Pattern**: Single rate limiter instance for entire application

## Common Patterns

### Safe File Writing

```typescript
// Pattern: Ensure directory exists before writing
await fs.write('/path/to/new/file.txt', content, { createParents: true });

// Pattern: Atomic write with temporary file
const tempFile = join(getTempDirectory('writes'), `${Date.now()}.tmp`);
await fs.write(tempFile, content);
await fs.move(tempFile, finalPath);

// Pattern: Write with error recovery
async function safeWrite(path: string, content: string) {
  const backupPath = `${path}.backup`;

  // Create backup if file exists
  if (await fs.exists(path)) {
    await fs.copy(path, backupPath);
  }

  try {
    await fs.write(path, content);
    // Delete backup on success
    if (await fs.exists(backupPath)) {
      await fs.delete(backupPath);
    }
  } catch (error) {
    // Restore from backup on failure
    if (await fs.exists(backupPath)) {
      await fs.copy(backupPath, path);
      await fs.delete(backupPath);
    }
    throw error;
  }
}
```

### Temporary File Operations

```typescript
// Pattern: Simple temp file with cleanup
const tempDir = getTempDirectory('processing');
const tempFile = join(tempDir, 'data.json');

try {
  await fs.write(tempFile, JSON.stringify(data));
  // Process file...
} finally {
  if (await fs.exists(tempFile)) {
    await fs.delete(tempFile);
  }
}

// Pattern: Batch temp directory with cleanup
const batchDir = join(getTempDirectory('batch'), `session-${Date.now()}`);
await mkdir(batchDir, { recursive: true });

try {
  // Process multiple files...
  for (const item of items) {
    await fs.write(join(batchDir, item.name), item.content);
  }
  // Process batch...
} finally {
  await rmdir(batchDir, { recursive: true, force: true });
}
```

### Stream Processing

```typescript
// Pattern: Transform and compress
await pipeline(
  createReadStream(inputPath),
  transformStream,
  createGzip(),
  createWriteStream(outputPath)
);

// Pattern: Chunked processing
for await (const chunk of createReadStream(filePath)) {
  await processChunk(chunk);
}

// Pattern: Multiple outputs
const input = createReadStream(sourcePath);
const output1 = createWriteStream(dest1);
const output2 = createWriteStream(dest2);

// Duplicate stream to multiple destinations
input.pipe(output1);
input.pipe(output2);
```

## API Documentation

The @have/files package generates comprehensive API documentation in markdown format using TypeDoc:

### Generated Documentation

**Markdown Documentation**:
- Generated in `packages/files/docs/` directory
- Markdown format perfect for IDE integration and version control
- Includes complete API reference with function signatures
- Cross-linked type definitions and examples

### Generating Documentation

```bash
# Generate documentation for this package
npm run docs

# Generate and watch for changes during development
npm run docs:watch

# Documentation is also generated during build
npm run build
```

### Development Workflow

Documentation is automatically generated during the build process:

1. **During Development**: Use `npm run docs:watch` to regenerate docs as you code
2. **IDE Integration**: Point your editor to `packages/files/docs/` for offline markdown reference
3. **Build Pipeline**: Documentation generated automatically as part of `npm run build`

The documentation includes complete API coverage, usage examples, and cross-references to related HAVE SDK packages.

## Documentation Links

Always reference the latest Node.js LTS documentation when implementing file system solutions, as the core modules frequently receive performance improvements and new features:

### Core Node.js Modules

- **Node.js fs/promises API**: [https://nodejs.org/api/fs.html](https://nodejs.org/api/fs.html)
  - Complete async file system operations including new Web Streams support
  - Check for new methods like `filehandle.readableWebStream()` and async disposal patterns

- **Node.js path module**: [https://nodejs.org/api/path.html](https://nodejs.org/api/path.html)
  - Cross-platform path manipulation and normalization utilities
  - Review for new methods like `path.matchesGlob()` (Node.js 24+)

- **Node.js stream API**: [https://nodejs.org/api/stream.html](https://nodejs.org/api/stream.html)
  - Stream processing for efficient large file operations
  - Monitor for Web Streams integration and performance improvements

- **Complete Node.js API**: [https://nodejs.org/api/all.html](https://nodejs.org/api/all.html)
  - Comprehensive reference for all Node.js APIs and recent additions

### Expert Agent Instructions

When working with @have/files:

1. **Always check latest Node.js LTS documentation** before implementing solutions using WebFetch tool
2. **Stay current with fs/promises API changes** - new methods are regularly added
3. **Review stream module updates** for performance and memory optimization opportunities
4. **Check for new path manipulation methods** that can simplify cross-platform operations
5. **Look for security improvements** in file handling and permission management
6. **Monitor Web Streams integration** for modern async patterns
7. **Utilize async resource management** with Symbol.asyncDispose and `await using` syntax (Node.js 20+)
8. **Leverage filehandle.readableWebStream()** for modern byte-oriented streaming (Node.js 17+)

Example workflow:

```typescript
// Before implementing a file solution, check latest docs
await WebFetch('https://nodejs.org/api/fs.html', 'What are the latest fs/promises methods in Node.js LTS?');

// Then implement with current best practices
const fileHandle = await open(filePath, 'r');
try {
  const content = await fileHandle.readFile({ encoding: 'utf-8' });
  return content;
} finally {
  await fileHandle.close();
}
```

### Provider-Specific Documentation

When implementing or debugging specific providers:

- **AWS S3 SDK**: Latest S3 client documentation and best practices (when implementing S3 provider)
- **Google Drive API**: Current API reference and authentication methods (when implementing Google Drive provider)
- **WebDAV Protocol**: RFC 4918 and server-specific implementation guides (when implementing WebDAV provider)

## Troubleshooting

### Common Issues

**Permission errors (EACCES)**:
- Check file/directory permissions with `ls -la` (Unix) or file properties (Windows)
- Ensure process has write access to parent directory
- On Unix, consider `chmod` to adjust permissions
- Use `mode` option in write/createDirectory for proper permissions

**Path issues**:
- Always use `path.join()` or `path.resolve()` for cross-platform compatibility
- Use `path.normalize()` to clean up user-provided paths
- Verify path resolution with `path.isAbsolute()` checks
- Check for directory traversal attempts (.., ~)

**Temp file cleanup**:
- Always use try/finally blocks for cleanup
- Implement cleanup in error handlers
- Consider using process exit handlers for critical cleanup
- Use `getTempDirectory` from @have/utils for consistent temp paths

**Memory issues with large files**:
- Use streams instead of loading entire files into memory
- Set appropriate `highWaterMark` in stream options
- Process files in chunks with `for await`
- Monitor memory usage with `process.memoryUsage()`

**Race conditions**:
- Use atomic operations (move) when possible
- Implement file locking for concurrent access
- Use temporary files with unique names
- Consider using transactions for multi-file operations

**Rate limiting errors**:
- Configure appropriate limits with `addRateLimit()`
- Check current limits with `getRateLimit()`
- Implement exponential backoff for retries
- Cache frequently accessed remote resources

This package provides the essential file system abstraction needed by AI agents and applications to work with data consistently across different storage environments while maintaining security, performance, and cross-platform compatibility in Node.js environments.