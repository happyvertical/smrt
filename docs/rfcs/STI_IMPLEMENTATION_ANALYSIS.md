# Implementation Feasibility Analysis for STI Proposal

Analysis of GitHub Discussion #269: "standardizing data layer strategy"

## Current State: Class Table Inheritance (CTI)

The framework currently implements **one table per class** with field inheritance:

```typescript
@smrt()
class Event extends SmrtObject {
  title: string = '';
  startTime: Date = new Date();
}

@smrt()
class Meeting extends Event {
  roomId = foreignKey(Room);
}

@smrt()
class HockeyGame extends Event {
  homeTeamId = foreignKey(Team);
  arenaName: string = '';
}
```

**Creates three separate tables:**
- `events`: (id, title, start_time, created_at, updated_at)
- `meetings`: (id, title, start_time, room_id, created_at, updated_at)
- `hockey_games`: (id, title, start_time, home_team_id, arena_name, created_at, updated_at)

Each child table **duplicates all inherited fields**.

## Proposed: STI as Optional Feature

Making STI **opt-in** keeps the change non-breaking while enabling the benefits where needed:

```typescript
// Set strategy once on base class
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
  startTime: Date = new Date();
}

// Children automatically inherit strategy
@smrt()
class Meeting extends Event {
  roomId = foreignKey(Room);
}

@smrt()
class HockeyGame extends Event {
  homeTeamId = foreignKey(Team);
  awayTeamId = foreignKey(Team);
  arenaName = meta();  // Explicit JSONB storage
}
```

**Creates one shared table:**
```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  context TEXT NOT NULL,
  type TEXT NOT NULL,           -- Discriminator
  meta JSON,                    -- Flexible storage

  -- Common fields
  title TEXT NOT NULL,
  start_time TIMESTAMP,

  -- Union of all FK columns (nullable)
  room_id TEXT,                 -- Meeting
  home_team_id TEXT,            -- HockeyGame
  away_team_id TEXT,            -- HockeyGame

  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,

  UNIQUE(slug, context, type)
);

CREATE INDEX idx_events_type ON events(type);
```

## Implementation Plan: 4-5 Weeks

### Week 1: Foundation
- Add `tableStrategy` to decorator config with inheritance
- Implement base class detection
- Add `getDescendants()`, `getSTIBase()` registry methods

### Week 2: Schema Generation
- Add conditional `generateSTISchema()` path
- Aggregate fields from descendants
- Generate discriminator + meta columns
- Make all FK columns nullable

### Week 3: Serialization
- Add `meta()` field helper for explicit JSONB storage
- Conditional serialization in `toJSON()`
- Conditional deserialization in `loadDataFromDb()`
- Fail-fast validation (throw if type missing, schema invalid, etc.)

### Week 4: Query Logic
- Auto-inject type filters in all queries
- Update table name resolution
- Update CRUD operations

### Week 5: Testing & Polish
- Comprehensive test coverage
- Documentation
- Examples

## Strategy Inheritance Behavior

```typescript
// Set once on base
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject { }

// Automatically inherits 'sti'
@smrt()
class Meeting extends Event { }

// Can explicitly override if needed
@smrt({ tableStrategy: 'cti' })
class SpecialEvent extends Event { }  // Opts back to CTI
```

Implementation:
```typescript
static getTableStrategy(className: string): 'cti' | 'sti' {
  const registered = this.classes.get(className);

  // Explicit config wins
  if (registered?.decorator?.tableStrategy) {
    return registered.decorator.tableStrategy;
  }

  // Inherit from ancestors
  const chain = this.getInheritanceChain(className);
  for (const ancestor of chain) {
    const ancestorConfig = this.classes.get(ancestor)?.decorator;
    if (ancestorConfig?.tableStrategy) {
      return ancestorConfig.tableStrategy;
    }
  }

  return 'cti';  // Default
}
```

## Key Differences from Current

| Aspect | Current (CTI) | Proposed (STI) |
|--------|---------------|----------------|
| Tables | One per class | One per base |
| Discriminator | None | `type` column |
| Field storage | All columns | Columns + JSONB |
| FK columns | Required | Nullable union |
| Queries | Direct table | Base + type filter |
| Schema changes | Add table | Alter shared table |

## Meta Storage Strategy

Two approaches for JSONB `meta` column:

### Option A: Explicit opt-in (recommended)
```typescript
class HockeyGame extends Event {
  homeTeamId = foreignKey(Team);  // Column
  arenaName = meta();              // JSONB
}
```

### Option B: Auto-classification
- `foreignKey()` → column
- `indexed: true` → column
- `searchable: true` → column
- Everything else → meta

Recommend starting with **Option A** for predictability.

## Benefits of Optional Approach

1. **Zero breaking changes** - CTI remains default
2. **Gradual adoption** - use STI where beneficial (events, polymorphic hierarchies)
3. **Easy comparison** - can benchmark both strategies
4. **Clear migration** - opt-in per hierarchy
5. **Coexistence** - both strategies work simultaneously

## Use Cases for STI

### Good fits:
- Event hierarchies (Meeting, Concert, Game)
- Polymorphic queries ("all events this week")
- Agent-driven schema evolution
- Frequently changing subclasses

### Better with CTI:
- Stable hierarchies
- No polymorphic queries needed
- Different performance characteristics per type

## Fail-Fast Validation Strategy

**Philosophy**: Throw descriptive errors early. Developer fixes schema, not the framework.

### Validation Points

```typescript
// 1. Schema generation - verify STI base has descendants
generateSTISchema(objectDef) {
  const descendants = ObjectRegistry.getDescendants(baseClass);
  if (descendants.length === 0) {
    throw new Error(
      `STI configured on '${baseClass}' but no descendant classes found. ` +
      `Either add child classes or remove tableStrategy: 'sti'.`
    );
  }

  // Generate schema...
}

// 2. Save - verify type is set
async save() {
  if (strategy === 'sti') {
    const data = this.toJSON();

    if (!data.type) {
      throw new Error(
        `STI class '${this.constructor.name}' missing 'type' discriminator. ` +
        `This should be auto-set but wasn't. Check toJSON() implementation.`
      );
    }

    await this.db.upsert(this.tableName, data);
  }
}

// 3. Load - verify type matches
async loadDataFromDb(record) {
  if (strategy === 'sti') {
    if (!record.type) {
      throw new Error(
        `STI record missing 'type' field. ` +
        `Schema may be corrupted or table created without STI support.`
      );
    }

    if (record.type !== this.constructor.name) {
      throw new Error(
        `Type mismatch: expected '${this.constructor.name}' but got '${record.type}'. ` +
        `This record belongs to a different class.`
      );
    }

    // Load data...
  }
}

// 4. Schema validation - verify table has required columns
static validateSTITable(db, tableName) {
  const columns = await db.describeTable(tableName);

  if (!columns.includes('type')) {
    throw new Error(
      `STI table '${tableName}' missing 'type' discriminator column. ` +
      `Drop and recreate table or add column manually: ` +
      `ALTER TABLE ${tableName} ADD COLUMN type TEXT NOT NULL;`
    );
  }

  if (!columns.includes('meta')) {
    throw new Error(
      `STI table '${tableName}' missing 'meta' column for flexible storage. ` +
      `Add column: ALTER TABLE ${tableName} ADD COLUMN meta JSON;`
    );
  }
}
```

### Error Messages

Clear, actionable errors guide developers to fix:
- **Missing descendants**: "No child classes found"
- **Missing type**: "Add type column or disable STI"
- **Type mismatch**: "Record belongs to different class"
- **Schema corruption**: "Table structure invalid, recreate"

## Questions for Discussion

1. **Meta classification**: Explicit `meta()` or auto-detect?
2. **Polymorphic queries**: Should `collection.list()` support loading mixed types?
3. **Index strategy**: Partial indexes for FK columns?
4. **Migration tooling**: Provide CTI → STI converter?
5. **Validation strictness**: Fail on save or lazily on first query?

## Bottom Line

This is **feasible in 4-5 weeks** with no production concerns. The optional approach gives maximum flexibility while maintaining backward compatibility.

## Files Affected

### Core Changes:
- `packages/core/src/registry.ts` - Add `getTableStrategy()`, `getSTIBase()`, `getDescendants()`
- `packages/core/src/schema/generator.ts` - Add `generateSTISchema()` path
- `packages/core/src/object.ts` - Conditional serialization for meta
- `packages/core/src/collection.ts` - Type filtering in queries
- `packages/core/src/fields/index.ts` - Add `meta()` field helper

### Testing:
- `packages/core/src/__tests__/sti-schema-generation.test.ts` (new)
- `packages/core/src/__tests__/sti-save-load.test.ts` (new)
- `packages/core/src/__tests__/sti-queries.test.ts` (new)
- `packages/core/src/__tests__/sti-inheritance.test.ts` (new)

### Documentation:
- `packages/core/CLAUDE.md` - Add STI section
- `packages/core/README.md` - Usage examples
- `CLAUDE.md` - Update architecture overview
