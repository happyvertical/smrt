# STI Phase 5: Error Handling & Documentation Analysis

## Executive Summary

This document provides a comprehensive analysis of error handling and documentation requirements for STI Phase 5 implementation in the SMRT framework. The analysis covers current implementation status, missing error scenarios, documentation gaps, and recommended improvements.

**Status**: STI Phases 1-4 completed. Phases 1-4 cover:
- Phase 1: Synchronous manifest loading (✅ complete)
- Phase 2: Meta field support (✅ complete)  
- Phase 3: Polymorphic queries (✅ complete)
- Phase 4: Base class schema generation (✅ complete)

**Phase 5 Focus**: Comprehensive error handling and end-user documentation

---

## Part 1: Current Error Handling Coverage

### ✅ Implemented Error Scenarios

#### 1. STI Validation Errors (In `object.ts`)

**Missing `_meta_type` discriminator during load** (line 380-384):
```typescript
if (!data._meta_type) {
  throw new Error(
    `STI validation failed: Missing _meta_type discriminator in database row for ${this.constructor.name}. ` +
    `Ensure the row was saved with STI support enabled.`
  );
}
```
- ✅ Detects: Missing discriminator during database load
- ✅ Clear message indicating the problem
- ⚠️ Error type: Plain Error (not typed ValidationError)

**Type mismatch during load** (line 388-394):
```typescript
if (data._meta_type !== this.constructor.name) {
  throw new Error(
    `STI validation failed: Type mismatch when loading ${this.constructor.name}. ` +
    `Database row has _meta_type='${data._meta_type}' but expected '${this.constructor.name}'. ` +
    `This usually means you're trying to load a row with the wrong class.`
  );
}
```
- ✅ Detects: Attempting to load wrong class type
- ✅ Clear message with actual vs expected values
- ⚠️ Error type: Plain Error (not typed ValidationError)

**Missing discriminator during save** (line 745-750):
```typescript
if (!jsonData._meta_type) {
  throw new Error(
    `STI validation failed: Missing _meta_type discriminator when saving ${this.constructor.name}. ` +
    `This should have been set automatically by toJSON(). Please report this bug.`
  );
}
```
- ✅ Detects: Internal bug (missing auto-set discriminator)
- ✅ Instructs user to report if encountered
- ⚠️ Error type: Plain Error (should be RuntimeError)

**Discriminator mismatch during save** (line 751-757):
```typescript
if (jsonData._meta_type !== this.constructor.name) {
  throw new Error(
    `STI validation failed: _meta_type mismatch when saving ${this.constructor.name}. ` +
    `Expected '${this.constructor.name}' but got '${jsonData._meta_type}'. ` +
    `This should not happen - please report this bug.`
  );
}
```
- ✅ Detects: Internal state inconsistency
- ✅ Instructs user to report bug
- ⚠️ Error type: Plain Error (should be RuntimeError)

#### 2. Schema Generation Errors (In `schema/utils.ts`)

**STI base not found** (line 88-92):
```typescript
if (!stiBase) {
  throw new Error(
    `STI strategy detected for '${className}' but no STI base class found. ` +
    `This should not happen - please report this bug.`
  );
}
```
- ✅ Detects: Registry corruption or configuration error
- ✅ Clear guidance to report bug
- ⚠️ Error type: Plain Error (should be ConfigurationError)

#### 3. Polymorphic Query Errors (In `collection.ts`)

**Class not found in registry** (line 777-781):
```typescript
if (!registeredClass) {
  throw new Error(
    `STI polymorphic query failed: Class '${className}' not found in ObjectRegistry. ` +
    `Ensure the class is registered with @smrt() decorator.`
  );
}
```
- ✅ Detects: Missing class registration
- ✅ Clear guidance on how to fix (add @smrt())
- ⚠️ Error type: Plain Error (should be ConfigurationError)

### ⚠️ Partially Implemented

#### Collection WHERE clause validation (lines 48-159):
- ✅ Validates field names exist
- ✅ Validates operators
- ✅ Validates operator-specific types (e.g., 'in' requires array)
- ✅ Adds STI fields to valid field set (_meta_type, _meta_data)
- ⚠️ **Missing**: Validate _meta_type values match registered class names
- ⚠️ **Missing**: Validate _meta_data structure when filtering

### ❌ Missing Error Scenarios

#### 1. Corrupted Metadata Errors
**NOT IMPLEMENTED**: What happens if `_meta_data` JSON is malformed?
```typescript
// Current code (line 398-403):
const metaData = typeof data._meta_data === 'string'
  ? JSON.parse(data._meta_data)  // ← Can throw SyntaxError!
  : data._meta_data;
```
- **Risk**: Unhandled JSON parsing errors during load
- **Impact**: May crash during data deserialization
- **Missing**: Try-catch with proper error message

#### 2. Circular Inheritance Detection
**NOT IMPLEMENTED**: What if someone creates circular STI hierarchy?
```typescript
// NOT CAUGHT:
@smrt({ tableStrategy: 'sti' })
class A extends B {}

@smrt()
class B extends A {}  // ← Circular! Not detected!
```
- **Risk**: Infinite recursion during schema generation or table setup
- **Missing**: Inheritance cycle detection in registry

#### 3. Mixed Strategy Violations
**NOT IMPLEMENTED**: What if parent uses CTI but child declares STI?
```typescript
@smrt({ tableStrategy: 'cti' })
class Parent extends SmrtObject {}

@smrt({ tableStrategy: 'sti' })
class Child extends Parent {}  // ← Conflicting strategies!
```
- **Risk**: Confused table layouts and failed queries
- **Missing**: Strategy compatibility validation during registration

#### 4. Inheritance Chain Length Limits
**NOT IMPLEMENTED**: No validation for deep STI hierarchies
```typescript
// NOT CAUGHT:
@smrt({ tableStrategy: 'sti' })
class Level1 extends SmrtObject {}

@smrt()
class Level2 extends Level1 {}

@smrt()
class Level3 extends Level2 {}

@smrt()
class Level4 extends Level3 {}  // ← How deep is too deep?
```
- **Risk**: Performance degradation with deep inheritance
- **Missing**: Warning/error for overly deep hierarchies

#### 5. Schema Mismatch on Load
**NOT IMPLEMENTED**: What if child class has new fields that don't exist in schema?
```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
}

@smrt()
class Meeting extends Event {
  location: string = '';  // ← Added after first save!
}
```
- **Risk**: Silent data loss if schema not updated
- **Missing**: Schema validation during load

#### 6. Missing Child Field Validation
**NOT IMPLEMENTED**: No validation that child classes properly declare meta fields
```typescript
@smrt()
class Meeting extends Event {
  // Meta field declared as regular field - confusing!
  location: string = '';  // Should be Meta<string>!
}
```
- **Risk**: Data saved in wrong column (_meta_data vs table column)
- **Missing**: Field type consistency check

#### 7. NULL/Undefined _meta_type Handling
**NOT IMPLEMENTED**: What happens with NULL vs missing vs undefined?
```typescript
// Database row with NULL _meta_type
{ id: '123', title: 'Event', _meta_type: null }

// Loading this would pass the "!== null" check
if (!data._meta_type) {  // ← This checks for falsy, null passes!
  throw new Error(...)
}
```
- **Risk**: Allows NULL which should not be allowed
- **Missing**: Explicit NULL check with descriptive error

#### 8. Base Class Not Registered
**NOT IMPLEMENTED**: What if base class not decorated with @smrt()?
```typescript
class Event extends SmrtObject {  // ← No @smrt()!
  title: string = '';
}

@smrt()
class Meeting extends Event {}
```
- **Risk**: Registry lookup fails for base class
- **Missing**: Clear error message about base class registration

#### 9. Collection Item Class Mismatch
**NOT IMPLEMENTED**: What if collection tries to use wrong base class?
```typescript
class EventCollection extends SmrtCollection<Meeting> {
  static readonly _itemClass = Meeting;  // Meeting, not Event!
}

// Trying to load Event type when collection expects Meeting
const event = await eventCollection.get(eventId);  // ← Wrong class!
```
- **Risk**: Silent type mismatch in polymorphic queries
- **Missing**: Type validation during createPolymorphic()

#### 10. Meta Field Access Before Load
**NOT IMPLEMENTED**: What if accessing meta field before database load completes?
```typescript
const meeting = new Meeting();  // Not loaded yet
console.log(meeting.location);  // Undefined? Empty string?
await meeting.loadFromId();
console.log(meeting.location);  // Now loaded
```
- **Risk**: Confusing behavior with uninitialized fields
- **Missing**: Clear documentation and warnings

---

## Part 2: Current Documentation Status

### ✅ Existing STI Documentation

#### In CLAUDE.md (packages/core/CLAUDE.md)
- **Coverage**: Minimal - only brief mentions in main SMRT docs
- **Location**: Generic framework documentation
- **Content**: Does not include STI-specific examples

#### In Code Comments
**object.ts**:
- Lines 363-407: Comments explain STI support in `loadDataFromDb()`
- Lines 520-542: Comments explain STI support in `toJSON()`
- Lines 740-776: Comments explain STI validation during save

**collection.ts**:
- Lines 68-75: Comments about STI discriminator field validation
- Lines 378-387: Comments about polymorphic hydration
- Lines 458-471: Comments about auto-filtering by _meta_type

**schema/utils.ts**:
- Lines 84-109: Comments about STI schema generation strategy

**Fields documentation** (fields/index.ts):
- Lines 123-145: Comments about Meta<T> type annotation
- Lines 600-650: Comments about meta() field helper

### ⚠️ Partial Documentation

#### In Tests (as usage examples)
**sti-polymorphic-queries.test.ts**:
- Demonstrates: Basic STI setup with 3 child classes
- Shows: Collection.list() returning polymorphic instances
- Shows: Filtering by _meta_type
- Missing: Error scenarios, edge cases

**sti-meta-integration.test.ts**:
- Demonstrates: Save/load cycle with meta fields
- Shows: Both Meta<T> annotation and meta() helper
- Missing: Validation errors, corruption handling

### ❌ Missing Documentation

#### 1. **Getting Started with STI**
- No basic tutorial for defining STI classes
- No step-by-step example
- No "when to use STI" guidance

#### 2. **STI Best Practices**
- No guidance on inheritance depth
- No performance considerations
- No schema design recommendations
- No when to use STI vs CTI comparison

#### 3. **Meta Fields Documentation**
- No clear explanation of when to use Meta<T> vs regular fields
- No performance impact documentation
- No documentation about _meta_data column structure

#### 4. **Migration Guides**
- No guidance on migrating from CTI to STI
- No data migration strategy documentation
- No backward compatibility considerations

#### 5. **Error Scenarios Documentation**
- No documented error messages and solutions
- No troubleshooting guide
- No common pitfalls section

#### 6. **API Reference**
- No documented @smrt({ tableStrategy: 'sti' }) option
- No Meta<T> type documentation
- No meta() field helper documentation in main README

#### 7. **Advanced Topics**
- No documentation on polymorphic queries
- No documentation on cross-class filtering
- No documentation on collection behavior differences (STI vs CTI)

---

## Part 3: Recommended Error Handling Improvements

### Priority 1: Critical Errors (Production Blocking)

#### Error Type Unification
**Problem**: Using plain `Error` instead of typed error classes
**Impact**: Error handling code can't distinguish error types

**Solution**: Use appropriate error classes from `errors.ts`:

```typescript
// Instead of:
throw new Error(`STI validation failed: Missing _meta_type...`);

// Use:
throw ValidationError.invalidValue(
  '_meta_type',
  undefined,
  'discriminator field required for STI'
);

// Or for schema errors:
throw DatabaseError.schemaError(
  tableName,
  'STI base class setup',
  new Error('STI base class not found in registry')
);
```

#### Meta Data Parsing Safety
**Problem**: Unhandled JSON parsing in loadDataFromDb() (line 402)
**Impact**: Crashes when _meta_data is corrupted

**Solution**:
```typescript
try {
  const metaData = typeof data._meta_data === 'string'
    ? JSON.parse(data._meta_data)
    : data._meta_data;
  Object.assign(data, metaData);
} catch (error) {
  throw DatabaseError.schemaError(
    tableName,
    'parsing _meta_data JSONB column',
    error instanceof Error ? error : new Error(String(error))
  );
}
```

#### Inheritance Cycle Detection
**Problem**: No detection of circular inheritance hierarchies
**Impact**: Infinite recursion possible during schema generation

**Solution**: In `ObjectRegistry.register()`:
```typescript
// Check for cycles in inheritance chain
const visited = new Set<string>();
let current = parentClass?.name;
while (current && !visited.has(current)) {
  visited.add(current);
  const parent = ObjectRegistry.getClass(current);
  if (!parent) break;
  current = parent.constructor.prototype.constructor.name;
}
if (current && visited.has(current)) {
  throw new ConfigurationError(
    `Circular inheritance detected: ${current} → ... → ${current}`,
    'CIRCULAR_INHERITANCE',
    { className, inheritanceChain: Array.from(visited) }
  );
}
```

#### Strategy Compatibility Validation
**Problem**: No validation that STI/CTI strategies match parent class
**Impact**: Child uses STI when parent uses CTI (or vice versa)

**Solution**: In `ObjectRegistry.register()`:
```typescript
const parentStrategy = ObjectRegistry.getTableStrategy(parent.name);
const childStrategy = options.tableStrategy || 'cti';

if (parentStrategy === 'cti' && childStrategy === 'sti') {
  throw new ConfigurationError(
    `Child class '${className}' uses STI but parent '${parent.name}' uses CTI. ` +
    `Inheritance must use same table strategy.`,
    'STRATEGY_MISMATCH',
    { className, parentClassName: parent.name, parentStrategy, childStrategy }
  );
}
```

### Priority 2: High Value Errors (Better UX)

#### NULL vs Missing _meta_type
**Problem**: Uses falsy check, treats NULL as missing
**Solution**:
```typescript
if (data._meta_type === null || data._meta_type === undefined) {
  throw ValidationError.requiredField('_meta_type', className);
}
if (typeof data._meta_type !== 'string') {
  throw ValidationError.invalidValue(
    '_meta_type',
    data._meta_type,
    'non-empty string'
  );
}
if (data._meta_type === '') {
  throw ValidationError.invalidValue(
    '_meta_type',
    data._meta_type,
    'non-empty string (got empty string)'
  );
}
```

#### Base Class Registration Validation
**Problem**: Doesn't validate that base class is registered
**Solution**: In `createPolymorphic()`:
```typescript
const registeredClass = ObjectRegistry.getClass(className);
if (!registeredClass) {
  // Check if base class itself is registered
  const stiBase = ObjectRegistry.getSTIBase(className);
  if (!stiBase) {
    throw ConfigurationError.missingConfiguration(
      `STI class '${className}'`,
      `Class '${className}' is not registered. Ensure it's decorated with @smrt() decorator.`
    );
  }
  // ...
}
```

#### WHERE Clause _meta_type Validation
**Problem**: Allows filtering by _meta_type without validating the value
**Solution** (in `convertWhereKeys()`):
```typescript
if (snakeFieldName === '_meta_type' && value && typeof value === 'string') {
  // Validate that the class name exists in registry
  if (!ObjectRegistry.getClass(value)) {
    throw ValidationError.invalidValue(
      '_meta_type',
      value,
      `registered class name (got '${value}')`
    );
  }
}
```

### Priority 3: Helpful Errors (Better Developer Experience)

#### Deep Inheritance Warning
**Problem**: No warning for complex inheritance hierarchies
**Solution**: Add check during registration:
```typescript
const depth = calculateInheritanceDepth(className);
if (depth > 5) {
  console.warn(
    `Warning: STI class '${className}' has inheritance depth of ${depth}. ` +
    `Consider flattening hierarchy for better performance.`
  );
}
```

#### Schema Mismatch Detection
**Problem**: Silent data loss if child class adds fields after parent creation
**Solution**: Add schema validation on load:
```typescript
const expectedFields = await fieldsFromClass(this.constructor);
const actualColumns = await getTableColumns(this.db, this.tableName);

const missing = Array.from(expectedFields.keys()).filter(
  f => !actualColumns.has(toSnakeCase(f))
);

if (missing.length > 0) {
  console.warn(
    `Schema mismatch for '${className}': Missing columns: ${missing.join(', ')}. ` +
    `Run migrations to add these columns to the shared STI table.`
  );
}
```

---

## Part 4: Recommended Documentation Structure

### 1. New Documentation Files Needed

#### `/packages/core/docs/STI.md` - Complete STI Guide
```
# Single Table Inheritance (STI)

## Overview
- What is STI
- When to use STI vs CTI
- STI vs Polymorphism trade-offs

## Quick Start
- Define base class with @smrt({ tableStrategy: 'sti' })
- Define child classes that extend base
- Use collections to query polymorphically

## Core Concepts
- _meta_type discriminator column
- _meta_data JSONB column for meta fields
- Shared table structure
- Polymorphic queries

## Field Types
- Regular fields (stored in table columns)
- Meta<T> fields (stored in _meta_data)
- When to use each

## Collections
- Base collection queries all types
- Child collection filters by _meta_type
- Polymorphic hydration

## Error Handling
- Common errors and solutions
- Validation errors
- Schema mismatches

## Best Practices
- Inheritance depth guidelines
- Performance optimization
- Schema design patterns

## Troubleshooting
- Common mistakes
- Debugging STI issues
- Migration guide from CTI
```

#### `/packages/core/docs/META-FIELDS.md` - Meta Field Guide
```
# Meta Fields in STI

## Overview
- Meta<T> type annotation syntax
- meta() field helper syntax
- Differences and when to use each

## Storage Strategy
- Regular fields: Stored in table columns
- Meta fields: Stored in _meta_data JSONB

## Examples
- Basic Meta<T> usage
- Complex nested types
- Arrays and objects

## Performance
- Query performance with meta fields
- Filtering and searching
- Index strategies

## Serialization
- toJSON() behavior
- loadDataFromDb() behavior
- JSON round-trip safety
```

#### `/packages/core/docs/STI-MIGRATION.md` - CTI to STI Migration
```
# Migrating from CTI to STI

## When to Migrate
- Recognizing when STI is better
- Analyzing your current schema

## Planning
- Choosing a base class
- Grouping related classes
- Schema design

## Implementation Steps
1. Define base class with STI
2. Convert existing child classes
3. Generate new schema
4. Migrate data
5. Update queries

## Data Migration Scripts
- Example migration for common patterns
- Handling schema changes
- Rollback procedures

## Verification
- Testing polymorphic behavior
- Verifying data integrity
- Performance testing
```

### 2. Updates to Existing Documentation

#### In `CLAUDE.md` - Add STI Section
```markdown
## Single Table Inheritance (STI)

### What is STI?
STI allows multiple related classes to share a single database table, 
differentiated by a `_meta_type` discriminator column.

### When to Use
- Related object types with shared base fields
- Polymorphic queries needed
- Space efficiency important

### Example
```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
  description: string = '';
}

@smrt()
class Meeting extends Event {
  location: string = '';
  attendees: Meta<string[]> = [];
}

@smrt()
class Conference extends Event {
  organizer: string = '';
  fee: Meta<number> = 0.0;
}
```

### Key Features
- All types share single `events` table
- `_meta_type` column identifies type (Meeting, Conference, etc)
- `_meta_data` JSONB column stores type-specific fields marked with Meta<T>

### Querying
```typescript
// Get all events (mixed types)
const allEvents = await eventCollection.list({});

// Get only meetings
const meetings = await meetingCollection.list({});

// Query with filters
const largeGatherings = await eventCollection.list({
  where: {
    _meta_type: 'Conference',
    'fee >': 1000
  }
});
```

### See Also
- [STI Complete Guide](./docs/STI.md)
- [Meta Fields Documentation](./docs/META-FIELDS.md)
```

#### In `README.md` - Add STI Section
Short introduction + link to full guide

### 3. Code Examples Repository

Create `/packages/core/examples/sti/`:

#### `basic.ts` - Minimal working example
```typescript
@smrt({ tableStrategy: 'sti' })
class Vehicle extends SmrtObject {
  brand: string = '';
  year: number = 2024;
}

@smrt()
class Car extends Vehicle {
  doors: number = 4;
  trunkSize: Meta<number> = 0.0;
}

@smrt()
class Motorcycle extends Vehicle {
  engineCC: number = 600;
  hasStorage: Meta<boolean> = false;
}
```

#### `advanced.ts` - Meta fields, queries, etc.

#### `migrations.ts` - CTI to STI migration example

#### `error-handling.ts` - Error scenarios and solutions

---

## Part 5: Suggested STI Examples for Documentation

### Example 1: Blog Content System
```typescript
// Base class
@smrt({ tableStrategy: 'sti' })
class Content extends SmrtObject {
  title: string = '';
  body: string = '';
  author: string = '';
  publishedAt: Date | null = null;
  tags: string[] = [];
}

// Blog post - regular fields mostly
@smrt()
class BlogPost extends Content {
  excerpt: string = '';
  featured: boolean = false;
}

// Video content - meta fields for flexible data
@smrt()
class Video extends Content {
  duration: Meta<number> = 0;
  videoUrl: Meta<string> = '';
  thumbnail: Meta<string> = '';
}

// Podcast - mixed regular and meta fields
@smrt()
class Podcast extends Content {
  host: string = '';  // Regular field
  episodeNumber: Meta<number> = 0;  // Meta field
  audioUrl: Meta<string> = '';
}
```

### Example 2: User Account Types
```typescript
@smrt({ tableStrategy: 'sti' })
class Account extends SmrtObject {
  email: string = '';
  name: string = '';
  createdAt: Date = new Date();
  status: string = 'active';
}

@smrt()
class FreeAccount extends Account {
  tier: string = 'free';
  storageLimit: Meta<number> = 1_000_000_000;  // 1GB
}

@smrt()
class PremiumAccount extends Account {
  tier: string = 'premium';
  storageLimit: Meta<number> = 100_000_000_000;  // 100GB
  billingEmail: Meta<string> = '';
  autoRenew: Meta<boolean> = true;
}

@smrt()
class TeamAccount extends Account {
  tier: string = 'team';
  seats: Meta<number> = 1;
  seatLimit: Meta<number> = 10;
  teamLead: string = '';
}
```

### Example 3: Event Management with Inheritance
```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
  description: string = '';
  startTime: Date = new Date();
  endTime: Date = new Date();
}

@smrt()
class Meeting extends Event {
  location: string = '';
  attendees: Meta<string[]> = [];
  duration: Meta<number> = 60;
}

@smrt()
class WebinarEvent extends Event {
  registerUrl: Meta<string> = '';
  capacity: Meta<number> = 0;
  panelists: Meta<string[]> = [];
}

@smrt()
class Conference extends Event {
  venue: string = '';
  tracks: Meta<string[]> = [];
  schedule: Meta<Record<string, string[]>> = {};
  sponsorships: Meta<string[]> = [];
}
```

### Example 4: E-commerce Products
```typescript
@smrt({ tableStrategy: 'sti' })
class Product extends SmrtObject {
  name: string = '';
  description: string = '';
  price: number = 0.0;
  sku: string = '';
  inStock: boolean = true;
}

@smrt()
class PhysicalProduct extends Product {
  weight: number = 0.0;
  dimensions: Meta<{ width: number, height: number, depth: number }> = {};
  shippingClass: string = '';
}

@smrt()
class DigitalProduct extends Product {
  downloadUrl: Meta<string> = '';
  fileSize: Meta<number> = 0;
  licenseType: Meta<string> = '';
}

@smrt()
class ServiceProduct extends Product {
  duration: Meta<number> = 0;
  capacity: Meta<number> = 0;
  consultants: Meta<string[]> = [];
}
```

---

## Part 6: Implementation Recommendations

### Immediate Actions (Phase 5a)

1. **Error Type Conversion** (High Priority)
   - Convert plain `Error` to typed error classes
   - Add proper error codes and details
   - Add error codes to error documentation

2. **Core Validation Additions** (High Priority)
   - Add JSON parse safety for _meta_data
   - Add inheritance cycle detection
   - Add strategy compatibility validation

3. **Documentation Creation** (High Priority)
   - Create STI guide (STI.md)
   - Create Meta fields guide (META-FIELDS.md)
   - Add STI examples to CLAUDE.md

### Secondary Actions (Phase 5b)

4. **Enhanced Error Scenarios** (Medium Priority)
   - Add base class registration validation
   - Add _meta_type value validation in WHERE clauses
   - Add deep inheritance warnings

5. **Additional Documentation** (Medium Priority)
   - Create migration guide (CTI to STI)
   - Create troubleshooting section
   - Create best practices guide

6. **Code Examples** (Medium Priority)
   - Create example projects
   - Create runnable test cases
   - Create documentation with inline comments

### Future Actions (Phase 5c)

7. **Schema Detection** (Low Priority, Future)
   - Detect schema mismatches on load
   - Suggest migrations
   - Add schema validation

8. **Performance Monitoring** (Low Priority, Future)
   - Warn about deep inheritance
   - Suggest query optimizations
   - Document performance characteristics

---

## Summary: Missing Error Scenarios by Category

| Scenario | Impact | Priority | Implementation |
|----------|--------|----------|-----------------|
| Corrupted _meta_data JSON | Crash on load | Critical | Try-catch + error |
| Circular inheritance | Infinite recursion | Critical | Cycle detection |
| Mixed STI/CTI strategies | Wrong table layout | Critical | Strategy validation |
| Missing base class registration | Polymorphic query fails | High | Registry check |
| Invalid _meta_type in filters | Wrong results or error | High | Value validation |
| NULL _meta_type | Silent data issues | High | Explicit NULL check |
| Deep inheritance hierarchies | Performance issues | Medium | Depth warning |
| Schema mismatches | Silent data loss | Medium | Mismatch detection |
| Meta field in wrong column | Data integrity | Medium | Type checking |
| Field access before load | Undefined behavior | Low | Documentation |

---

## Summary: Missing Documentation

| Topic | Gap | Audience | Priority |
|-------|-----|----------|----------|
| STI Getting Started | No basic tutorial | New users | Critical |
| STI Concepts | Scattered in code comments | All users | Critical |
| Meta Fields Guide | No dedicated documentation | Users defining STI classes | Critical |
| Error Messages | Not documented | Troubleshooting users | High |
| Best Practices | No guidance | Developers | High |
| CTI to STI Migration | No migration guide | Existing users | High |
| API Reference | Missing @smrt({ tableStrategy: 'sti' }) | Developers | High |
| Examples | Limited to tests | Learning users | Medium |
| Performance | No documentation | Production teams | Medium |
| Troubleshooting | No guide | Support/Debugging | Medium |

