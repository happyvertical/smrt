# @happyvertical/smrt-scanner

High-performance TypeScript AST scanner using [OXC](https://oxc-project.github.io/) for SMRT manifest generation. Extracts class, field, method, and decorator metadata from source files without executing them.

## Installation

```bash
pnpm add @happyvertical/smrt-scanner
```

## Usage

```typescript
import { OxcScanner, InheritanceResolver, ManifestAdapter } from '@happyvertical/smrt-scanner';
import { parseFile, parseSource, extractSmrtImports } from '@happyvertical/smrt-scanner';

// Scan a single file
const result = parseFile('/path/to/Product.ts');
// result.classes → RawClassDefinition[]
// result.imports → import declarations

// Scan from source string
const source = `
  @smrt({ api: true })
  class Product extends SmrtObject {
    name: string = '';
    price: number = 0.0;
  }
`;
const parsed = parseSource(source, 'Product.ts');

// Full scanner with glob support
const scanner = new OxcScanner();
const classes = await scanner.scan(['src/**/*.ts']);

// Resolve inheritance across files
const resolver = new InheritanceResolver(classes);
const resolved = resolver.resolve();

// Convert to SMRT manifest format
const adapter = new ManifestAdapter(resolved);
const manifest = adapter.toManifest();
```

### CLI

```bash
# Scan and output manifest
smrt-scan src/**/*.ts
```

## API

### Classes

| Export | Description |
|--------|------------|
| `OxcScanner` | Scans TypeScript files for `@smrt()` decorated classes |
| `InheritanceResolver` | Resolves class inheritance chains across files |
| `ManifestAdapter` | Converts raw scan results to SMRT manifest format |

### Functions

| Export | Description |
|--------|------------|
| `parseFile` | Parse a single TypeScript file and extract metadata |
| `parseSource` | Parse a TypeScript source string |
| `extractSmrtImports` | Extract SMRT-related imports from a file |

### Key Types

`RawClassDefinition`, `RawFieldDefinition`, `RawMethodDefinition`, `RawDecoratorConfig`

## Dependencies

- Peer (optional): `@happyvertical/smrt-core`
