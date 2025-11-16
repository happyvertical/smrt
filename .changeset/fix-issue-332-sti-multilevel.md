---
"@happyvertical/smrt-core": patch
---

fix(core): refactor schema setup to be manifest-only, fixing STI multi-level hierarchies

Replaces runtime class references with manifest-only schema generation, fixing multi-level STI (Single Table Inheritance) hierarchies and improving architecture.

**Root Cause:**
The schema setup system was using runtime class constructor references (`setupTableFromClass(db, ClassType)`), a holdover from the old runtime introspection system (removed in #131). This caused issues with STI child classes because:
1. Class references were unnecessary - all schema info is in the manifest
2. STI recursion used class constructors instead of registry metadata
3. Cache keys included class object references, causing inconsistencies

**Solution:**
Refactored to pure manifest-based schema generation:

**1. Added ObjectRegistry.getTableName() (registry.ts:1276)**
```typescript
static getTableName(name: string): string | undefined {
  const registered = ObjectRegistry.classes.get(name);
  return registered?.schema?.tableName;
}
```
Retrieves table name from manifest metadata instead of class static property.

**2. Created ensureSchema() function (schema/utils.ts:292)**
```typescript
export async function ensureSchema(db: any, className: string): Promise<void>
```
Modern replacement for `setupTableFromClass()` that:
- Takes class name (string) instead of class constructor
- Gets table name from `ObjectRegistry.getTableName(className)`
- Handles STI recursion using class names: `await ensureSchema(db, stiBase)`
- Eliminates runtime class references entirely

**3. Simplified setupDb() (collection.ts:956-976)**
```typescript
// Before: Complex STI logic with class constructors
if (tableStrategy === 'sti') {
  const BaseClass = ObjectRegistry.getClass(stiBase);
  await setupTableFromClass(this.db, BaseClass);
}

// After: Simple manifest-only call
const { ensureSchema } = await import('./schema/utils.js');
await ensureSchema(this.db, className);
```
Reduced from 45 lines to 17 lines - STI logic moved to `ensureSchema()`.

**4. Updated SmrtObject.ensureDbSetup() (object.ts:361-379)**
```typescript
// Before: Used class constructor
await setupTableFromClass(this.db, this.constructor);

// After: Uses class name
const { ensureSchema } = await import('./schema/utils.js');
await ensureSchema(this.db, this.constructor.name);
```

**5. toJSON() inherited fields fix (object.ts:577)**
```typescript
// Use cached inheritedFields for multi-level hierarchies
const registered = ObjectRegistry.getClass(this.constructor.name);
const registeredFields = registered?.inheritedFields || ObjectRegistry.getFields(this.constructor.name);
```
Ensures all parent class fields are serialized in STI hierarchies.

**Why This Fixes STI:**
- **No more class constructor dependency**: Schema setup works purely from manifest data
- **Consistent cache keys**: Uses `dbUrl::tableName` instead of class object references
- **Proper STI recursion**: `ensureSchema(db, 'Council')` → `ensureSchema(db, 'Profile')` using class names
- **Early base class table creation**: Manifest knows the inheritance chain, sets up base table first

**Changes:**
- `packages/core/src/registry.ts`: Add `getTableName()` method
- `packages/core/src/schema/utils.ts`: Add `ensureSchema()` function (keeps `setupTableFromClass()` for backwards compatibility)
- `packages/core/src/collection.ts`: Simplify `setupDb()` to use `ensureSchema()`
- `packages/core/src/object.ts`: Update `ensureDbSetup()` and `toJSON()`
- `packages/core/src/__tests__/sti-multilevel.test.ts`: Remove test workarounds - tests pass without artificial base class priming

**Testing:**
- 6 integration tests covering CREATE, READ, and polymorphic queries
- Validates Council → Organization → Profile → SmrtObject hierarchy (4 levels)
- **All tests pass WITHOUT artificial schema priming** 🎉

**Architecture Improvement:**
This change completes the transition from runtime introspection (issue #131) to pure manifest-based schema generation. The schema setup system no longer needs class constructor references - everything works from manifest metadata.

**Fixes #332**
