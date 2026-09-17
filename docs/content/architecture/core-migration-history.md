# SMRT Migration Guide

## v0.13.0 Breaking Changes

### Registry Export Renamed: `registry` → `smrtRegistry`

**Breaking Change**: The object registry export has been renamed from `registry` to `smrtRegistry` for consistency with the framework's naming convention.

#### Why This Change?

To maintain consistency with our naming convention:
- Lowercase `smrt` for singleton/factory exports
- PascalCase `SmrtClass` for class names
- camelCase with `smrt` prefix for related utilities

#### Migration Steps

**Before (v0.12.x and earlier):**
```typescript
import { registry } from '@smrt/core';

// Register a class
registry.register(MyClass, config);

// Get class metadata
const metadata = registry.getClass('MyClass');

// Get all registered classes
const allClasses = registry.getAllClasses();

// Get collection
const collection = await registry.getCollection('MyClass', options);
```

**After (v0.13.0+):**
```typescript
import { smrtRegistry } from '@smrt/core';

// Register a class
smrtRegistry.register(MyClass, config);

// Get class metadata
const metadata = smrtRegistry.getClass('MyClass');

// Get all registered classes
const allClasses = smrtRegistry.getAllClasses();

// Get collection
const collection = await smrtRegistry.getCollection('MyClass', options);
```

#### Using Both Configuration and Registry

Note that there are now **two separate exports** with different purposes:

```typescript
// Global configuration singleton
import { smrt } from '@smrt/core';
smrt.configure({
  logging: { level: 'debug' },
  metrics: { enabled: true }
});

// Object registry for runtime introspection
import { smrtRegistry } from '@smrt/core';
const productClass = smrtRegistry.getClass('Product');
```

#### Automated Migration

For large codebases, use this find-and-replace pattern:

**Find:**
```regex
import \{ registry \} from '@smrt/core'
```

**Replace with:**
```typescript
import { smrtRegistry } from '@smrt/core'
```

**Find:**
```regex
\bregistry\.
```

**Replace with:**
```typescript
smrtRegistry.
```

#### Backward Compatibility

**There is no backward compatibility layer** for this change. All imports and usages of `registry` must be updated to `smrtRegistry`.

#### Type Changes

If you're using TypeScript and importing the registry type:

**Before:**
```typescript
import type { ObjectRegistry } from '@smrt/core';
```

**After:**
```typescript
import type { ObjectRegistry } from '@smrt/core';
// Type name unchanged, only export name changed
```

The `ObjectRegistry` type itself is unchanged; only the exported instance name has changed.

#### Migration Checklist

- [ ] Update all `import { registry }` to `import { smrtRegistry }`
- [ ] Update all `registry.` calls to `smrtRegistry.`
- [ ] Run TypeScript compiler to catch any missed references
- [ ] Update tests that reference the registry
- [ ] Update documentation and examples
- [ ] Run full test suite to verify functionality

#### Additional Resources

- [Core framework README](https://github.com/happyvertical/smrt/blob/main/packages/core/README.md) — objects, collections, decorators, registry, configuration
- [Changelog](https://github.com/happyvertical/smrt/blob/main/CHANGELOG.md)

---

## Other Changes in v0.13.0

### Universal Signaling System

New universal signaling system for method execution tracking with automatic signal sanitization:

```typescript
import { smrt } from '@smrt/core';

// Configure global defaults
smrt.configure({
  logging: { level: 'info' },       // Default logging
  metrics: { enabled: true },       // Opt-in metrics
  sanitization: {                   // Automatic data sanitization
    redactKeys: ['password', 'token', 'apiKey']
  }
});
```

**Key Features:**
- Automatic method execution tracking
- Built-in data sanitization (prevents PII/credential leakage)
- Logging, metrics, and pub/sub adapters
- Fire-and-forget error handling
- Memory leak prevention with `destroy()` method

**See:** [Signals documentation in the core README](https://github.com/happyvertical/smrt/blob/main/packages/core/README.md#signals-observability)

### Memory Leak Prevention

New cleanup methods to prevent memory leaks:

```typescript
// SmrtClass instances
const product = new Product({ name: 'Widget' });
await product.initialize();
// ... use product ...
product.destroy(); // Clean up adapters

// SignalBus
const bus = new SignalBus();
bus.register(adapter1);
bus.register(adapter2);
// ... use bus ...
bus.clear(); // Remove all adapters
```

**See:** [Memory management in the core README](https://github.com/happyvertical/smrt/blob/main/packages/core/README.md#context-memory)

---

## Need Help?

- [GitHub Issues](https://github.com/happyvertical/smrt/issues)
- [Documentation](https://happyvertical.github.io/smrt/)
- [Application template](https://github.com/happyvertical/smrt/tree/main/packages/template-sveltekit)
