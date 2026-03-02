# Issue #270 Impact on STI Implementation

## TL;DR

✅ **Good news**: Issue #270 makes STI implementation **easier** but isn't blocking.
📊 **Recommendation**: Either do #270 first (makes STI cleaner) OR do STI now and benefit from #270 later.

## Issue #270 Summary

**Problem**: Async manifest loading is legacy complexity from runtime introspection era
**Solution**: Use synchronous imports of build-time generated manifests
**Benefit**: Remove async loading, caching, dual discovery functions

```typescript
// Current (async)
await ObjectRegistry.ensureManifestLoaded('Place');
const fields = ObjectRegistry.getFields('Place');

// Proposed (sync)
import { manifest } from './manifest';
const fields = ObjectRegistry.getFields('Place'); // Immediate
```

## Impact on STI Implementation

### Positive Impacts

#### 1. Simpler Field Aggregation (Critical for STI)

STI needs to aggregate fields from **entire class hierarchy**:

```typescript
// Current (async) - STI needs this
async generateSTISchema(baseClass) {
  const descendants = ObjectRegistry.getDescendants(baseClass);

  for (const descendant of descendants) {
    const fields = await ObjectRegistry.getAllFields(descendant); // Async!
    // Aggregate...
  }
}

// With #270 (sync) - Much cleaner
function generateSTISchema(baseClass) {
  const descendants = ObjectRegistry.getDescendants(baseClass);

  for (const descendant of descendants) {
    const fields = ObjectRegistry.getAllFields(descendant); // Sync!
    // Aggregate...
  }
}
```

**Benefit**: No async/await in schema generation, faster performance.

#### 2. Registry Methods Become Synchronous

STI needs several registry methods that currently require async:

```typescript
// Current approach for STI
async getDescendants(baseClass) {
  const descendants = [];
  for (const className of allClasses) {
    await ObjectRegistry.ensureManifestLoaded(className); // Async
    const chain = ObjectRegistry.getInheritanceChain(className);
    if (chain.includes(baseClass)) descendants.push(className);
  }
  return descendants;
}

// With #270 - Pure synchronous
function getDescendants(baseClass) {
  const descendants = [];
  for (const className of allClasses) {
    const chain = ObjectRegistry.getInheritanceChain(className);
    if (chain.includes(baseClass)) descendants.push(className);
  }
  return descendants;
}
```

#### 3. Better Performance for STI Queries

STI queries need to validate class hierarchy on every query:

```typescript
// Current - Async overhead
async list(options) {
  const strategy = await this.getTableStrategy(); // Might need manifest
  if (strategy === 'sti') {
    options.where.type = this.className;
  }
  return db.list(tableName, options);
}

// With #270 - No async
list(options) {
  const strategy = this.getTableStrategy(); // Sync!
  if (strategy === 'sti') {
    options.where.type = this.className;
  }
  return db.list(tableName, options);
}
```

### Potential Conflicts

#### 1. Timing Complexity

Implementing both simultaneously increases complexity:
- STI changes: schema generation, queries, serialization
- #270 changes: manifest loading, registry methods

**Risk**: Harder to debug issues, more test updates needed.

#### 2. Schema Generation Refactor Overlap

Both touch `schema/generator.ts`:
- STI: Add `generateSTISchema()`
- #270: Remove async from `generateSchema()`

**Risk**: Merge conflicts, duplicate refactoring effort.

## Implementation Strategies

### Option A: Do #270 First, Then STI (Recommended)

**Timeline:**
- Weeks 1-3: Implement #270 (sync manifests)
- Weeks 4-8: Implement STI (now simpler!)

**Pros:**
- STI code is cleaner (no async in schema generation)
- No merge conflicts
- Clear separation of concerns
- Better performance for STI

**Cons:**
- Delays STI by 3 weeks
- Two separate refactoring efforts

**Code impact:**
```typescript
// STI with #270 completed
function generateSTISchema(objectDef) {
  const baseClass = this.getSTIBase(objectDef.className);
  const descendants = ObjectRegistry.getDescendants(baseClass); // Sync!

  const allFields = new Map();
  for (const descendant of descendants) {
    const fields = ObjectRegistry.getAllFields(descendant); // Sync!
    for (const [name, field] of fields) {
      allFields.set(name, field);
    }
  }

  return { tableName, columns: generateColumns(allFields), ... };
}
```

### Option B: Do STI Now, Benefit from #270 Later

**Timeline:**
- Weeks 1-5: Implement STI (with async patterns)
- Later: Refactor to sync when #270 is done

**Pros:**
- Get STI functionality sooner
- Changes are orthogonal (low conflict risk)
- Can prove STI value before #270 refactor

**Cons:**
- STI code has more async/await initially
- Will need refactoring when #270 lands

**Code impact:**
```typescript
// STI before #270 (async)
async generateSTISchema(objectDef) {
  const baseClass = this.getSTIBase(objectDef.className);

  // Need async to ensure manifests loaded
  const descendants = ObjectRegistry.getDescendants(baseClass);
  for (const d of descendants) {
    await ObjectRegistry.ensureManifestLoaded(d); // Required now
  }

  const allFields = new Map();
  for (const descendant of descendants) {
    const fields = await ObjectRegistry.getAllFields(descendant); // Async
    for (const [name, field] of fields) {
      allFields.set(name, field);
    }
  }

  return { tableName, columns: generateColumns(allFields), ... };
}

// Later, when #270 done, simplify to sync (like Option A)
```

### Option C: Do Both in Parallel (Not Recommended)

**Timeline:**
- Weeks 1-5: Both #270 and STI simultaneously

**Pros:**
- Fastest to completion (5 weeks total)

**Cons:**
- High risk of conflicts
- Complex testing (two major changes)
- Harder to debug issues
- Mental overhead tracking both

## Recommendation

### **Option A: #270 First, Then STI**

**Why:**
1. **Cleaner STI code**: No async complexity in schema generation
2. **Better architecture**: Build on solid foundation
3. **Easier debugging**: One refactor at a time
4. **Better tests**: Can test #270 in isolation first

**Timeline:**
- Weeks 1-3: Issue #270 (sync manifest loading)
- Weeks 4-8: STI implementation (5 weeks, but simpler)
- **Total: 8 weeks**

vs. Option B (5 weeks now + refactor later) - similar total time, but cleaner.

### Key Question

**Does STI need to ship ASAP?**
- **Yes** → Option B (ship in 5 weeks, refactor later)
- **No** → Option A (better architecture, same total time)

## Changes to STI Plan

If we do **Option A (#270 first)**:

### Week -3 to -1: Issue #270 (Phase 1)
- Add synchronous manifest imports
- Update decorator to accept manifest parameter
- Keep async as fallback

### Week 1: STI Foundation (Simpler Now!)
- Add `tableStrategy` config with inheritance
- Implement `getDescendants()`, `getSTIBase()` - **now synchronous**
- No manifest loading complexity

### Week 2: Schema Generation (Simpler!)
- `generateSTISchema()` - **no async/await needed**
- Field aggregation from descendants - **synchronous loop**
- Generate discriminator + meta columns

### Week 3-5: Rest of STI (Unchanged)
- Serialization, queries, testing

## Bottom Line

✅ **Issue #270 makes STI easier but isn't blocking**
📈 **Recommendation**: Do #270 first for cleaner STI implementation
⏱️ **Timeline impact**: +3 weeks prep, same total effort
🎯 **Result**: Better architecture, simpler code, easier maintenance

---

**Total timeline comparison:**
- **Option A**: 8 weeks (3 + 5), cleaner code
- **Option B**: 5 weeks now + refactor later, similar total
- **Option C**: 5 weeks, high risk

Choose based on urgency vs. architecture quality tradeoff.
