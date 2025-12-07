# Data Organization & Compartmentalization

This guide covers techniques for organizing data across multi-agent SMRT applications.

## Options Overview

| Approach | Complexity | Use Case |
|----------|------------|----------|
| Single Database | Simple | Solo dev, single agent |
| Per-Agent Databases | Medium | Data isolation by agent |
| Shared + Private | Complex | Multi-agent organizations |

---

## Option 1: Single Database (Default)

All agents share one database. Simplest setup.

```typescript
// smrt.config.js
export default {
  persistence: {
    type: 'sqlite',
    url: './data.db'
  }
};
```

**Pros**: Simple, all data queryable together
**Cons**: No isolation between agents

---

## Option 2: Per-Agent Databases

Each agent gets its own database via manual routing.

```typescript
// In your application
const praecoDb = await sql({ url: './praeco.db' });
const caelusDb = await sql({ url: './caelus.db' });

// Praeco uses its database
const praeco = new Praeco({
  db: praecoDb,
  // ...
});

// Caelus uses its database
const caelus = new Caelus({
  db: caelusDb,
  // ...
});
```

### How it works

ObjectRegistry caches collections by db instance ID. Different db objects = different cache entries = isolated collections.

```typescript
// From registry.ts:1352-1368
let dbId: number | undefined;
if (options.db && typeof options.db === 'object') {
  if (!ObjectRegistry.dbInstanceIds.has(options.db)) {
    ObjectRegistry.dbInstanceIds.set(options.db, ObjectRegistry.nextDbId++);
  }
  dbId = ObjectRegistry.dbInstanceIds.get(options.db);
}

const cacheKey = `${className}:${JSON.stringify({
  persistence: options.persistence,
  db: dbId !== undefined ? `db:${dbId}` : undefined,
  ai: options.ai ? 'present' : undefined,
})}`;
```

**Pros**: Complete data isolation
**Cons**: Can't query across agents, duplicate shared models

---

## Option 3: Shared + Private (Recommended for Organizations)

Use a remote database (sqld/libsql) for shared data, local databases for private agent data.

### Architecture

```
┌─────────────────────────────────────────┐
│           blindmanpress.com             │
│         (Organization Host)             │
├─────────────────────────────────────────┤
│  sqld remote DB (shared)                │
│  - profiles (Person, Organization)      │
│  - events (shared base table)           │
│  - places (shared base table)           │
│  - content (shared base table)          │
└──────────────┬──────────────────────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────┴─────┐     ┌─────┴─────┐
│  Praeco   │     │  Caelus   │
│  Agent    │     │  Agent    │
├───────────┤     ├───────────┤
│ Local DB: │     │ Local DB: │
│ - drafts  │     │ - cache   │
│ - scrapes │     │ - forecasts│
└───────────┘     └───────────┘
```

### Configuration

```typescript
// blindmanpress.com/smrt.config.js
import { sql } from '@happyvertical/sql';

// Shared database for organization-wide data
const sharedDb = await sql({
  type: 'libsql',
  url: 'libsql://blindmanpress-db.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Agent-specific local databases
const praecoLocalDb = await sql({ url: './data/praeco-local.db' });
const caelusLocalDb = await sql({ url: './data/caelus-local.db' });

export default {
  // Default shared database
  persistence: { db: sharedDb },

  // Per-module overrides
  modules: {
    praeco: {
      // Praeco uses shared for profiles/events, local for drafts
      collections: {
        Meeting: { db: sharedDb },
        Council: { db: sharedDb },
        MeetingDraft: { db: praecoLocalDb }
      }
    },
    caelus: {
      collections: {
        ForecastLocation: { db: sharedDb },
        WeatherCache: { db: caelusLocalDb }
      }
    }
  }
};
```

---

## STI Schema with Multiple Agents

When your host application has multiple agents as dependencies, STI tables aggregate fields from ALL descendants.

### Example

`blindmanpress.com` depends on both `praeco` and `caelus`:

```json
// package.json
{
  "dependencies": {
    "@happyvertical/praeco": "^0.1.0",
    "@happyvertical/caelus": "^0.1.0"
  }
}
```

If both define STI children:
- `praeco`: `Meeting extends Event`, `MeetingLocation extends Place`
- `caelus`: `Forecast extends Event`, `ForecastLocation extends Place`

The generated `events` table includes fields from BOTH:

```sql
CREATE TABLE events (
  -- Base Event fields
  id TEXT PRIMARY KEY,
  title TEXT,
  startDate DATETIME,

  -- STI discriminator
  _meta_type TEXT NOT NULL,

  -- Child fields stored in JSONB
  _meta_data JSONB
);
```

The `_meta_data` column stores child-specific fields:
- For `Meeting`: `{ councilId, agendaUrl, minutesUrl }`
- For `Forecast`: `{ forecastZone, temperature, humidity }`

### Why this works

`generateSTISchemaFromRegistry` calls `ObjectRegistry.getDescendants(baseClassName)` which returns ALL registered descendants, regardless of which package they came from:

```typescript
// From schema/generator.ts:608-617
const descendants = ObjectRegistry.getDescendants(baseClassName);
const allClassNames = [baseClassName, ...descendants];

for (const className of allClassNames) {
  const classFields = await ObjectRegistry.getAllFields(className);
  // Adds columns for each field
}
```

---

## Key Mechanisms

### 1. Collection Caching by DB Instance

Pass different `db` objects to get isolated collection instances. The ObjectRegistry assigns unique IDs to each db instance and uses them in the cache key.

### 2. STI Descendant Aggregation

All imported packages' STI children contribute to shared tables. The schema generator walks the entire inheritance tree at build time.

---

## Best Practices

1. **Start simple**: Use single database until you need isolation
2. **Shared profiles**: Keep Person/Organization in shared DB for cross-agent deduplication
3. **Local caches**: Agent-specific caches/drafts belong in local databases
4. **STI for polymorphic queries**: Use when you need to query across event/content types
5. **Host aggregates schema**: The host application should depend on all agents to generate complete STI schemas
