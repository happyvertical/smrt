# STI Implementation Decisions

Answers to open questions from STI_IMPLEMENTATION_ANALYSIS.md

## 1. Meta Classification: Explicit `meta()` ✅

**Decision**: Start with explicit `meta()` field helper (Option A)

**Rationale**:
- Clear, predictable behavior
- Developer controls what goes in JSONB vs columns
- Easier to debug and reason about
- Can add auto-detection in v2 if needed

**Usage**:
```typescript
@smrt({ tableStrategy: 'sti' })
class HockeyGame extends Event {
  homeTeamId = foreignKey(Team);  // → Column (FK always column)
  arenaName = meta();              // → JSONB meta field
  capacity: number = 0;            // → Column (normal field)
}
```

## 2. Polymorphic Queries: Yes! ✅

**Decision**: Base class collections return all subtypes, properly hydrated

**Rationale**:
- This is the primary benefit of STI
- Enables queries like "all events this week" regardless of type
- Each instance hydrated as its actual class (Meeting, HockeyGame, etc.)

**Behavior**:
```typescript
const events = await eventCollection.list(); // Returns Meeting[], HockeyGame[], etc.

// Each instance is correct type
events.forEach(event => {
  if (event instanceof Meeting) {
    console.log(event.roomId);  // Type-safe!
  }
});
```

**Implementation**: `Collection.list()` uses discriminator to instantiate correct class.

## 3. Index Strategy: Partial Indexes ✅

**Decision**: Generate partial indexes for FK columns in STI tables

**Rationale**:
- FK columns are nullable (union of all child FKs)
- Partial indexes only index non-null values for specific types
- Efficient queries without wasting space on nulls

**Example**:
```sql
-- Only index room_id for Meeting rows
CREATE INDEX idx_events_room_id
  ON events(room_id)
  WHERE type = 'Meeting';

-- Only index home_team_id for HockeyGame rows
CREATE INDEX idx_events_home_team_id
  ON events(home_team_id)
  WHERE type = 'HockeyGame';
```

## 4. Migration Tooling: Not for v1 ❌

**Decision**: No automatic CTI → STI migration in initial release

**Rationale**:
- Get core STI working first
- Migration is complex (data reshaping, FK handling)
- Document manual migration steps instead
- Can add tooling in v2 based on user feedback

**Manual Migration Path**:
1. Create new STI hierarchy alongside CTI
2. Copy data with transformations
3. Update application code
4. Drop old CTI tables
5. Document in guide

## 5. Validation Strictness: Fail-Fast ✅

**Decision**: Fail immediately on save, not lazily on query

**Rationale**:
- Catch problems at the source (when saving)
- Clear error messages guide developers to fix
- Prevents corrupted data from entering database
- Better developer experience

**Validation Points**:
- Schema generation: Verify base has descendants
- Save: Verify `type` is set before INSERT/UPDATE
- Load: Verify `type` matches class being instantiated
- Startup: Optionally validate table structure

## Summary

| Question | Decision | Priority |
|----------|----------|----------|
| Meta classification | Explicit `meta()` | Week 3 |
| Polymorphic queries | Yes, full support | Week 4 |
| Index strategy | Partial indexes | Week 2 |
| Migration tooling | Not in v1 | Post-launch |
| Validation strictness | Fail-fast on save | Week 3 |

## Implementation Notes

### Field Classification Rules

When `tableStrategy: 'sti'`:
1. `foreignKey()` → Always column (for joins)
2. `meta()` → Always JSONB meta field
3. Everything else → Column (default)

### Schema Generation

```typescript
generateSTISchema(baseClass) {
  const fields = aggregateFieldsFromDescendants(baseClass);

  return `
    CREATE TABLE ${tableName} (
      -- Core columns
      id, slug, context, type, meta,

      -- Common fields (from base)
      ${baseFields},

      -- Union of FK columns (all nullable)
      ${fkFields.map(f => `${f.name} TEXT`).join(',\n')},

      -- Timestamps
      created_at, updated_at,

      UNIQUE(slug, context, type)
    );

    -- Partial indexes for each FK
    ${fkFields.map(f => `
      CREATE INDEX idx_${tableName}_${f.name}
        ON ${tableName}(${f.name})
        WHERE type = '${f.sourceClass}';
    `).join('\n')}
  `;
}
```

## Open Questions for Future

1. Should `meta()` support typed access? `meta<{ capacity: number }>()`
2. Should we support STI across multiple inheritance levels? (Event → SportingEvent → HockeyGame)
3. Should we provide a schema validation CLI command?
4. Should polymorphic queries be opt-in or default?

---

**Status**: Decisions finalized, ready for implementation
**Created**: 2025-01-10
