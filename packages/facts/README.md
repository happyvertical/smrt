# @happyvertical/smrt-facts

Knowledge base with semantic deduplication, provenance tracking, and confidence scoring for the SMRT framework. Facts evolve through chains, are tagged and sourced, and undergo 3-zone reconciliation to prevent duplicates.

## Installation

```bash
pnpm add @happyvertical/smrt-facts
```

## Usage

```typescript
import {
  Fact, FactCollection,
  FactSource, FactSourceCollection,
  FactSubject, FactSubjectCollection,
  calculateConfidence, normalizeText
} from '@happyvertical/smrt-facts';

// Create a fact
const facts = new FactCollection(db);
const fact = await facts.create({
  content: 'The Eiffel Tower is 330 meters tall',
  type: 'measurement',
  status: 'verified',
  confidence: 0.95,
});
await fact.save();

// Attach a source
const sources = new FactSourceCollection(db);
await sources.create({
  factId: fact.id,
  url: 'https://example.com/eiffel-tower',
  name: 'Tourism Board',
});

// Attach a subject
const subjects = new FactSubjectCollection(db);
await subjects.create({
  factId: fact.id,
  name: 'Eiffel Tower',
  role: 'primary',
});

// Utility functions
const normalized = normalizeText('  The Eiffel Tower  ');
const confidence = calculateConfidence(fact);
```

## API

### Models

| Export | Description |
|--------|------------|
| `Fact` | Knowledge fact with type, status, confidence, and evolution chain |
| `FactContent` | Content variant of a fact |
| `FactSource` | Provenance record linking a fact to its source |
| `FactSubject` | Subject entity referenced by a fact |
| `FactTag` | Tag association for a fact |

### Collections

`FactCollection`, `FactContentCollection`, `FactSourceCollection`, `FactSubjectCollection`, `FactTagCollection`

### Functions

| Export | Description |
|--------|------------|
| `calculateConfidence` | Compute confidence score for a fact |
| `normalizeText` | Normalize text for deduplication comparison |

### Key Types

`FactType`, `FactStatus`, `EvolutionType`, `SubjectRole`, `ReconcileAction`, `ReconcileOptions`, `ReconcileResult`, `EntityBriefing`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
