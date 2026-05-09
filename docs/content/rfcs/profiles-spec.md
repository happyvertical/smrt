# @have/profiles

## Package Overview

The `@have/profiles` package provides a comprehensive, flexible system for managing profiles, relationships, and metadata. It is designed as a **SMRT-specific module** (similar to `@have/content` and `@have/products`), excluded from the main SDK build pipeline but deeply integrated with the SMRT framework and other SDK packages.

**Package Type**: SMRT-specific module
**Location**: `packages/profiles/`
**Build Tool**: Vite with smrtPlugin
**Target**: Node.js only
**Dependencies**: `@have/smrt`, `@have/utils`, and potentially extends `@have/sql`

## Design Notes

This document outlines the database schema for the `@have/profiles` package. The architecture is designed to be flexible, consistent, and extensible.

The key architectural decisions are:

1.  **A Central `profiles` Table**: A single table holds all primary entities, linked to a `profile_types` table to define their nature.

2.  **Controlled EAV for Metadata**: We use a controlled Entity-Attribute-Value model. The `profile_metafields` table defines a vocabulary of allowed keys, ensuring data consistency, while the `profile_metadata` table stores the values. This balances flexibility with integrity.

3.  **Primary Key Strategy**: UUID-based primary keys with unique slug fields (standard SmrtObject pattern)
    - All tables use UUID `id` as the primary key
    - Lookup tables (ProfileType, ProfileMetafield, ProfileRelationshipType) have unique `slug` fields for human-readable lookups
    - Convenience methods provided for slug-based access (e.g., `ProfileType.getBySlug()`)
    - **Future Enhancement**: Slug-based primary keys tracked in issue #129

4.  **Configurable Reciprocal Relationships**: The relationship system allows developers to define custom reciprocal handlers for different relationship types. Built-in handlers provided for common patterns (friend, spouse, colleague), with ability to register custom handlers per application needs.

5.  **Contextual & Temporal Relationships**: Relationships can have a `context_profile_id` for creating tertiary links (e.g., two colleagues linked via a company). The `profile_relationship_terms` table adds a time dimension, crucial for tracking employment history, memberships, etc.

6.  **Multi-Layer API**: Comprehensive API design with instance methods, static methods, utility functions, and collection methods to avoid code duplication while providing flexibility.

7.  **Lightweight Validation**: Basic validation structure (type checking, regex, min/max) with extensibility points for applications to add custom validators via `ProfileMetafield.validation` JSON field.

---

## Usage Examples

Below are examples of how to model common scenarios. Note that slugs like `'org'`, `'human'`, `'job-title'`, and `'age'` are assumed to be predefined in the `profile_types` and `profile_metafields` tables.

### Example 1: Modeling an Organization

```javascript
// 1. Create the organization profile
const acmeInc = await createProfile({ typeSlug: 'org', name: 'ACME Inc.' });

// 2. Create profiles for two employees
const john = await createProfile({ typeSlug: 'human', name: 'John Doe', email: 'john.d@acme.inc' });
const jane = await createProfile({ typeSlug: 'human', name: 'Jane Smith', email: 'jane.s@acme.inc' });

// 3. Add metadata to the employees using the metafield slug
await setMetadata(john.id, 'job-title', 'Senior Engineer');
await setMetadata(jane.id, 'job-title', 'Product Manager');

// 4. Define the 'employee' relationship (directional)
await addRelationship(john.id, acmeInc.id, 'employee');
await addRelationship(jane.id, acmeInc.id, 'employee');

// 5. Define a 'colleague' relationship (reciprocal) between John and Jane,
// using the organization as the context.
await addRelationship(john.id, jane.id, 'colleague', acmeInc.id);
```

### Example 2: Modeling a Family

```javascript
// 1. Create profiles for the family members
const dad = await createProfile({ typeSlug: 'human', name: 'Homer Simpson' });
const mom = await createProfile({ typeSlug: 'human', name: 'Marge Simpson' });
const child = await createProfile({ typeSlug: 'human', name: 'Bart Simpson' });

// 2. Add metadata using the metafield slugs
await setMetadata(dad.id, 'age', 39);
await setMetadata(mom.id, 'age', 36);
await setMetadata(child.id, 'age', 10);

// 3. Define the parent-child relationships (directional)
await addRelationship(dad.id, child.id, 'father');
await addRelationship(mom.id, child.id, 'mother');

// 4. Define the spouse relationship (reciprocal)
await addRelationship(dad.id, mom.id, 'spouse');
```

---

## SMRT Integration

The `@have/profiles` data model can be seamlessly integrated with the `@have/smrt` framework. By modeling the schema as `SmrtObject`s, we can leverage AI-powered operations, automatic code generation, and a rich object-oriented interface.

### SMRT Object Definitions

Here's how the core tables can be represented as `SmrtObject` classes using UUID primary keys:

```typescript
import { SmrtObject, SmrtCollection } from '@have/smrt';
import { text, foreignKey, oneToMany, boolean, datetime, json } from '@have/smrt/fields';

// Represents the profile_types table
class ProfileType extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  slug = text({ unique: true, required: true });  // Unique slug for lookups
  name = text({ required: true });
  description = text();

  // Convenience method for slug-based lookup
  static async getBySlug(slug: string): Promise<ProfileType | null> {
    const collection = await ProfileTypeCollection.create();
    return await collection.get({ slug });
  }
}

// Represents the profile_metafields table
class ProfileMetafield extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  slug = text({ unique: true, required: true });  // Unique slug for lookups
  name = text({ required: true });
  description = text();
  validation = json();  // JSON validation schema

  // Convenience method for slug-based lookup
  static async getBySlug(slug: string): Promise<ProfileMetafield | null> {
    const collection = await ProfileMetafieldCollection.create();
    return await collection.get({ slug });
  }
}

// Represents the profiles table
class Profile extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  typeId = foreignKey(ProfileType, { required: true });  // References ProfileType.id
  email = text({ unique: true });
  name = text({ required: true });
  description = text();

  // Relationships
  metadata = oneToMany(ProfileMetadata);
  relationshipsFrom = oneToMany(ProfileRelationship, { foreignKey: 'fromProfileId' });
  relationshipsTo = oneToMany(ProfileRelationship, { foreignKey: 'toProfileId' });

  // Convenience method to get type slug
  async getTypeSlug(): Promise<string> {
    const type = await this.loadRelated('typeId');
    return type?.slug || '';
  }

  // Convenience method to set type by slug
  async setTypeBySlug(slug: string): Promise<void> {
    const type = await ProfileType.getBySlug(slug);
    if (!type) throw new Error(`Profile type '${slug}' not found`);
    this.typeId = type.id;
  }

  // AI-powered methods
  async isMatch(criteria: string) {
    return await this.is(criteria);
  }

  async generateBio() {
    return await this.do('Write a short, professional bio for this person.');
  }
}

// Represents the profile_metadata table
class ProfileMetadata extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  profileId = foreignKey(Profile, { required: true });
  metafieldId = foreignKey(ProfileMetafield, { required: true });
  value = text({ required: true });
}

// Represents the profile_relationship_types table
class ProfileRelationshipType extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  slug = text({ unique: true, required: true });  // Unique slug for lookups
  name = text({ required: true });
  reciprocal = boolean({ default: true });

  // Convenience method for slug-based lookup
  static async getBySlug(slug: string): Promise<ProfileRelationshipType | null> {
    const collection = await ProfileRelationshipTypeCollection.create();
    return await collection.get({ slug });
  }
}

// Represents the profile_relationships table
class ProfileRelationship extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  fromProfileId = foreignKey(Profile, { required: true });
  toProfileId = foreignKey(Profile, { required: true });
  typeId = foreignKey(ProfileRelationshipType, { required: true });
  contextProfileId = foreignKey(Profile);  // Optional tertiary context
  terms = oneToMany(ProfileRelationshipTerm);
}

// Represents the profile_relationship_terms table
class ProfileRelationshipTerm extends SmrtObject {
  // id: UUID (auto-generated by SmrtObject)
  relationshipId = foreignKey(ProfileRelationship, { required: true });
  startedAt = datetime({ required: true });
  endedAt = datetime();
}
```

### SMRT Collection Classes

We can define `SmrtCollection` classes to manage these objects:

```typescript
class ProfileCollection extends SmrtCollection<Profile> {
  static readonly _itemClass = Profile;
}

class ProfileTypeCollection extends SmrtCollection<ProfileType> {
  static readonly _itemClass = ProfileType;
}

// ... and so on for other objects
```

### Benefits of SMRT Integration

- **Object-Oriented API**: Interact with profiles as objects with methods, not just database rows.
- **AI Capabilities**: Use `is()` and `do()` methods on profiles for advanced matching and content generation.
- **Code Generation**: Automatically generate CLIs, REST APIs, and MCP servers for the entire profile system.
- **Simplified Queries**: Use the `SmrtCollection` query interface instead of writing raw SQL.
- **Data Validation**: Leverage the `smrt` field system for automatic data validation.

---

## Core Tables

### `profile_types`

A lookup table that defines the nature of a profile.

-   `slug`: (String, Primary Key) - A unique, human-readable identifier (e.g., 'human', 'org', 'robot').
-   `name`: (String) - A user-friendly display name (e.g., 'Human', 'Organization').
-   `description`: (Text, Nullable) - A brief explanation of the profile type.

### `profile_metafields`

A lookup table that defines the controlled vocabulary for metadata keys.

-   `slug`: (String, Primary Key) - A unique, human-readable identifier (e.g., 'job-title', 'age').
-   `name`: (String) - A user-friendly display name (e.g., 'Job Title', 'Age').
-   `description`: (Text, Nullable) - A brief explanation of the field.
-   `validation`: (JSON, Nullable) - Rules for validating the field's value (e.g., regex, min/max). For example, for an 'age' metafield, the validation might be `{"type": "integer", "min": 0}`.

### `profiles`

Stores the core information for any entity.

-   `id`: (UUID, Primary Key) - The unique identifier for the profile.
-   `type_slug`: (String, Foreign Key to `profile_types.slug`) - The type of entity this profile represents.
-   `email`: (String, Nullable, Unique) - The primary email address.
-   `name`: (String) - The display name for the profile.
-   `description`: (Text, Nullable) - A short bio or description.
-   `created_at`: (Datetime)
-   `updated_at`: (Datetime)

### `profile_metadata`

Stores the actual metadata values for each profile, linked to a defined metafield.

-   `id`: (UUID, Primary Key) - The unique identifier for the metadata entry.
-   `profile_id`: (UUID, Foreign Key to `profiles.id`) - The profile this metadata belongs to.
-   `metafield_slug`: (String, Foreign Key to `profile_metafields.slug`) - The metadata key.
-   `value`: (Text) - The metadata value.
-   `created_at`: (Datetime)
-   `updated_at`: (Datetime)

---

## Relationship Tables

### `profile_relationship_types`

A lookup table that defines the kinds of relationships that can exist.

-   `slug`: (String, Primary Key) - A unique, human-readable identifier (e.g., 'friend', 'father', 'employee').
-   `name`: (String, Unique) - A user-friendly display name (e.g., 'Friend', 'Father').
-   `reciprocal`: (Boolean, Default: true) - `true` for two-way relationships ('friend'), `false` for one-way ('father').

### `profile_relationships`

Connects two profiles together under a specific relationship type.

-   `id`: (UUID, Primary Key) - The unique identifier for the relationship instance.
-   `from_profile_id`: (UUID, Foreign Key to `profiles.id`) - The origin profile.
-   `to_profile_id`: (UUID, Foreign Key to `profiles.id`) - The target profile.
-   `type_slug`: (String, Foreign Key to `profile_relationship_types.slug`) - The type of relationship.
-   `context_profile_id`: (UUID, Foreign Key to `profiles.id`, Nullable) - The context for a tertiary relationship.
-   `created_at`: (Datetime)

### `profile_relationship_terms`

Defines the duration or terms of a specific relationship.

-   `id`: (UUID, Primary Key) - The unique identifier for the term.
-   `relationship_id`: (UUID, Foreign Key to `profile_relationships.id`) - The relationship this term applies to.
-   `started_at`: (Datetime)
-   `ended_at`: (Datetime, Nullable)
-   `created_at`: (Datetime)
-   `updated_at`: (Datetime)

---

## Data Integrity and Performance

To ensure data consistency and optimal query performance, the following considerations should be implemented:

-   **Cascading Deletes**: Foreign key constraints should be configured with `ON DELETE CASCADE`. For instance, if a profile is deleted, all its associated metadata, relationships, and relationship terms should be automatically removed from the database. This maintains referential integrity.

-   **Uniqueness Constraints**:
    -   In the `profile_metadata` table, a unique constraint should be placed on the combination of `(profile_id, metafield_slug)` to ensure that each profile has only one value for a given metafield.
    -   In the `profile_relationships` table, a unique constraint on `(from_profile_id, to_profile_id, type_slug, context_profile_id)` is recommended to prevent the creation of duplicate relationships.

-   **Indexing**: For faster data retrieval, indexes should be created on all foreign key columns. This includes `type_slug` in `profiles`, `profile_id` and `metafield_slug` in `profile_metadata`, and the various ID columns in the relationship tables.

---

## Core Functions

### Metadata Functions

-   `getMetadata(profileId)`: Retrieves all metadata for a given profile as a key-value object.
-   `setMetadata(profileId, metafieldSlug, value)`: Creates or updates a single metadata value for a profile.
-   `updateMetadata(profileId, metadataObject)`: Updates multiple metadata values from an object where keys are metafield slugs.
-   `findProfilesByMeta(metafieldSlug, value)`: Finds all profiles with a specific metadata key-value pair.

### Relationship Functions

-   `addRelationship(fromProfileId, toProfileId, relationshipSlug, contextProfileId=None)`: Creates a relationship. If the relationship type is reciprocal, the system automatically creates the corresponding inverse relationship (i.e., from `toProfileId` to `fromProfileId`).
-   `removeRelationship(fromProfileId, toProfileId, relationshipSlug)`: Removes a relationship. If the relationship is reciprocal, the inverse relationship is also automatically removed.
-   `getRelationships(profileId, direction='all')`: Retrieves all relationships for a profile.
-   `getRelatedProfiles(profileId, relationshipSlug=None)`: Retrieves profiles that have a specific relationship with the given profile.
	
### Relationship Term Functions

-   `addTermToRelationship(relationshipId, startedAt, endedAt=None)`: Adds a term to a relationship.
-   `endRelationshipTerm(termId, endedAt)`: Ends an active relationship term.
-   `getRelationshipHistory(relationshipId)`: Retrieves all terms for a relationship.

---

## Reciprocal Relationship System

The `@have/profiles` package provides a flexible system for handling reciprocal (two-way) relationships. Each `ProfileRelationshipType` can define whether it's reciprocal, and optionally specify a custom handler function for creating the inverse relationship.

### Handler Function Interface

```typescript
interface ReciprocalHandler {
  (
    from: Profile,
    to: Profile,
    context?: Profile,
    options?: any
  ): Promise<void>;
}
```

### Built-in Reciprocal Handlers

The package provides default handlers for common relationship patterns:

```typescript
const DEFAULT_HANDLERS: Record<string, ReciprocalHandler> = {
  // Symmetric relationships (same type in both directions)
  friend: async (from, to, context) => {
    await to.addRelationship(from, 'friend', context);
  },

  spouse: async (from, to) => {
    await to.addRelationship(from, 'spouse');
  },

  partner: async (from, to, context) => {
    await to.addRelationship(from, 'partner', context);
  },

  colleague: async (from, to, context) => {
    await to.addRelationship(from, 'colleague', context);
  },

  sibling: async (from, to) => {
    await to.addRelationship(from, 'sibling');
  },
};
```

### Custom Handler Registration

Applications can register custom reciprocal handlers:

```typescript
import { ProfileRelationshipType } from '@have/profiles';

// Register a custom handler
ProfileRelationshipType.registerReciprocalHandler(
  'business-partner',
  async (from, to, context) => {
    // Custom logic for creating inverse relationship
    await to.addRelationship(from, 'business-partner', context);

    // Additional business logic (e.g., create contract record)
    await createPartnershipContract(from, to);
  }
);
```

### Asymmetric Reciprocal Relationships

For relationships with different inverse types (e.g., mentor/mentee, parent/child):

```typescript
ProfileRelationshipType.registerReciprocalHandler(
  'mentor',
  async (from, to, context) => {
    // When A mentors B, B is mentee of A
    await to.addRelationship(from, 'mentee', context);
  }
);

ProfileRelationshipType.registerReciprocalHandler(
  'parent',
  async (from, to) => {
    // When A is parent of B, B is child of A
    await to.addRelationship(from, 'child');
  }
);
```

---

## API Layer Architecture

The package provides a comprehensive, multi-layer API to avoid code duplication while offering maximum flexibility.

### 1. Instance Methods

Direct manipulation on profile objects:

```typescript
const profile = await profiles.get({ id: 'profile-123' });

// Metadata operations
await profile.addMetadata('job-title', 'Senior Engineer');
const metadata = await profile.getMetadata(); // { 'job-title': 'Senior Engineer', ... }
await profile.updateMetadata({ 'job-title': 'Lead Engineer', 'department': 'Engineering' });
await profile.removeMetadata('department');

// Relationship operations
const colleague = await profiles.get({ id: 'profile-456' });
const company = await profiles.get({ id: 'org-789' });
await profile.addRelationship(colleague, 'colleague', company);
const relationships = await profile.getRelationships({ typeSlug: 'colleague' });
const relatedProfiles = await profile.getRelatedProfiles('colleague');
await profile.removeRelationship(colleague, 'colleague');

// AI-powered operations
const bio = await profile.generateBio();
const isEngineer = await profile.matches('works as a software engineer');
```

### 2. Static Methods

Class-level queries:

```typescript
// Find profiles by metadata
const engineers = await Profile.findByMetadata('job-title', 'Senior Engineer');

// Find by profile type
const organizations = await Profile.findByType('org');

// Find related profiles
const colleagues = await Profile.findRelated('profile-123', 'colleague');

// Search by email
const user = await Profile.searchByEmail('john@example.com');

// Relationship type utilities
const isReciprocal = await ProfileRelationshipType.getReciprocal('friend'); // true
ProfileRelationshipType.registerReciprocalHandler('custom', handlerFn);
```

### 3. Utility Functions

Standalone helpers in `utils.ts`:

```typescript
import {
  getProfileMetadata,
  setProfileMetadata,
  findProfilesByMeta,
  createReciprocalRelationship,
  validateMetadataValue,
} from '@have/profiles/utils';

// Metadata utilities
const metadata = await getProfileMetadata('profile-123');
await setProfileMetadata('profile-123', 'age', 35);
const profiles = await findProfilesByMeta('department', 'Engineering');

// Relationship utilities
await createReciprocalRelationship(profileA, profileB, 'friend', context);

// Validation utilities
const isValid = await validateMetadataValue(metafield, value);
```

### 4. Collection Methods

Extended batch operations:

```typescript
const profiles = await ProfileCollection.create({ db: { url: 'sqlite:./profiles.db' } });

// Batch operations
const engineers = await profiles.findByType('human');
const metadata = await profiles.batchGetMetadata(['id1', 'id2', 'id3']);
await profiles.batchUpdateMetadata([
  { profileId: 'id1', data: { 'job-title': 'Engineer' } },
  { profileId: 'id2', data: { 'job-title': 'Designer' } },
]);

// Relationship queries
const related = await profiles.findRelated('profile-123', 'colleague');
const network = await profiles.getRelationshipNetwork('profile-123', { maxDepth: 2 });
```

---

## Validation System

The package provides a lightweight validation system with clear extension points for applications.

### Validation Schema Structure

The `ProfileMetafield.validation` JSON field supports the following structure:

```typescript
interface ValidationSchema {
  // Type constraint
  type?: 'string' | 'number' | 'boolean' | 'date' | 'json';

  // String constraints
  pattern?: string;      // Regex pattern
  minLength?: number;
  maxLength?: number;

  // Numeric constraints
  min?: number;
  max?: number;

  // Custom validator reference
  custom?: string;       // Name of registered custom validator function

  // Error message
  message?: string;      // Custom validation error message
}
```

### Built-in Validation

Basic validation is performed automatically:

```typescript
// Type validation
const ageField = await ProfileMetafield.create({
  slug: 'age',
  name: 'Age',
  validation: { type: 'number', min: 0, max: 150 }
});

await profile.addMetadata('age', 35);     // ✓ Valid
await profile.addMetadata('age', 'old');  // ✗ ValidationError: Expected number
await profile.addMetadata('age', -5);     // ✗ ValidationError: Value below minimum
await profile.addMetadata('age', 200);    // ✗ ValidationError: Value above maximum

// Pattern validation
const emailField = await ProfileMetafield.create({
  slug: 'email',
  name: 'Email',
  validation: {
    type: 'string',
    pattern: '^[^@]+@[^@]+\\.[^@]+$',
    message: 'Invalid email format'
  }
});

await profile.addMetadata('email', 'john@example.com');  // ✓ Valid
await profile.addMetadata('email', 'invalid-email');     // ✗ ValidationError: Invalid email format
```

### Custom Validator Registration

Applications can register custom validation functions:

```typescript
import { ProfileMetadata } from '@have/profiles';

// Register a custom validator
ProfileMetadata.registerValidator('us-phone', (value: any) => {
  const phoneRegex = /^\d{3}-\d{3}-\d{4}$/;
  return phoneRegex.test(value);
});

// Use in metafield definition
const phoneField = await ProfileMetafield.create({
  slug: 'phone',
  name: 'Phone Number',
  validation: {
    type: 'string',
    custom: 'us-phone',
    message: 'Phone must be in format XXX-XXX-XXXX'
  }
});
```

---

## Dependencies & SDK Integration

The `@have/profiles` package maximizes integration with existing SDK packages while potentially extending them for specialized needs.

### Core Dependencies

#### @have/smrt (Required)
- **Purpose**: Core SMRT framework
- **Usage**:
  - `SmrtObject` base class for all profile models
  - `SmrtCollection` for collection management
  - `@smrt()` decorator for API/MCP/CLI generation
  - Field definitions (`text()`, `foreignKey()`, `boolean()`, etc.)
  - AI-powered methods (`do()`, `is()`)
  - Automatic schema generation and database triggers

#### @have/utils (Required)
- **Purpose**: Shared utilities
- **Usage**:
  - `makeSlug()` for generating URL-friendly identifiers
  - `generateId()` for UUID generation (if needed)
  - Type utilities and helper functions

#### @have/sql (Potential Extension)
- **Purpose**: Database operations
- **Potential Extensions**:
  - Enhanced query builders for complex relationship queries
  - Graph traversal utilities for relationship networks
  - Optimized batch operations for metadata updates
  - Recursive CTE helpers for hierarchical relationships

**Proposed Extensions**:
```typescript
// Potential additions to @have/sql
export function buildGraphQuery(
  fromTable: string,
  relationshipTable: string,
  maxDepth: number
): string {
  // Recursive CTE for relationship traversal
}

export function buildBatchUpsert(
  table: string,
  records: any[],
  uniqueKeys: string[]
): string {
  // Efficient batch upsert for metadata updates
}
```

#### @have/ai (Indirect)
- **Purpose**: AI model interactions
- **Usage**: Inherited via `SmrtObject` for AI-powered profile operations:
  - `profile.generateBio()` - Generate professional bios
  - `profile.matches(criteria)` - Semantic profile matching
  - `profile.analyzeSentiment()` - Analyze profile description sentiment
  - Custom AI-powered profile analysis methods

### Optional Integration Points

#### @have/files
- **Use Case**: Profile avatar/photo management
- **Potential Features**:
  - Upload and store profile photos
  - Generate thumbnails
  - Manage document attachments (resumes, portfolios)

#### @have/content
- **Use Case**: Profile content management
- **Potential Features**:
  - Rich-text profile descriptions
  - Blog posts or articles by profiles
  - Activity feeds and timeline content

---

## Package Structure

```
packages/profiles/
├── src/
│   ├── models/
│   │   ├── Profile.ts                    # Main profile model
│   │   ├── ProfileType.ts                # Profile type lookup
│   │   ├── ProfileMetafield.ts           # Metadata field definitions
│   │   ├── ProfileMetadata.ts            # Metadata values
│   │   ├── ProfileRelationship.ts        # Relationship instances
│   │   ├── ProfileRelationshipType.ts    # Relationship type lookup
│   │   ├── ProfileRelationshipTerm.ts    # Temporal relationship data
│   │   ├── __tests__/
│   │   │   ├── Profile.test.ts
│   │   │   ├── ProfileMetadata.test.ts
│   │   │   └── ProfileRelationship.test.ts
│   │   └── index.ts
│   ├── collections/
│   │   ├── ProfileCollection.ts
│   │   ├── ProfileTypeCollection.ts
│   │   ├── ProfileMetafieldCollection.ts
│   │   ├── ProfileMetadataCollection.ts
│   │   ├── ProfileRelationshipCollection.ts
│   │   ├── ProfileRelationshipTypeCollection.ts
│   │   ├── ProfileRelationshipTermCollection.ts
│   │   └── index.ts
│   ├── utils.ts                          # Utility functions
│   ├── utils.test.ts
│   ├── types.ts                          # TypeScript type definitions
│   └── index.ts                          # Main package export
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── SPEC.md                               # This file
├── CLAUDE.md                             # Package documentation for AI agents
└── README.md                             # User-facing documentation
```

---

## Implementation Phases

### Phase 1: Foundation
- Package infrastructure (package.json, build configs)
- Core model definitions with SMRT decorators
- Basic collection classes

### Phase 2: Core Functionality
- Instance methods for metadata and relationship management
- Static query methods
- Utility functions

### Phase 3: Advanced Features
- Reciprocal relationship handler system
- Validation framework with custom validators
- AI-powered profile methods

### Phase 4: Testing & Documentation
- Comprehensive test coverage
- CLAUDE.md package documentation
- README.md user guide
- Integration tests with other SDK packages

---

## Implementation Decision: UUID Primary Keys

After evaluation, we've decided to use **UUID-based primary keys** (standard SmrtObject pattern) for the initial implementation. This provides:

✅ Full compatibility with existing SMRT framework
✅ No special handling or framework modifications required
✅ Proven, stable implementation
✅ Allows profiles package to launch immediately

**Slug-based convenience methods** will be provided for human-readable lookups:

```typescript
class ProfileType extends SmrtObject {
  id = text();                         // UUID PK (auto-generated)
  slug = text({ unique: true });       // Unique slug for lookups
  name = text({ required: true });
  description = text();

  // Convenience method for slug-based lookup
  static async getBySlug(slug: string): Promise<ProfileType | null> {
    const collection = await ProfileTypeCollection.create();
    return await collection.get({ slug });
  }
}

class Profile extends SmrtObject {
  typeId = foreignKey(ProfileType, { required: true });  // References UUID
  email = text({ unique: true });
  name = text({ required: true });
  description = text();

  // Convenience method to get type slug
  async getTypeSlug(): Promise<string> {
    const type = await this.loadRelated('typeId');
    return type?.slug || '';
  }

  // Convenience method to set type by slug
  async setTypeBySlug(slug: string): Promise<void> {
    const type = await ProfileType.getBySlug(slug);
    if (!type) throw new Error(`Profile type '${slug}' not found`);
    this.typeId = type.id;
  }
}
```

**Future Enhancement**: Native slug-based primary key support is tracked in [issue #129](https://github.com/happyvertical/sdk/issues/129). The package can be migrated to use slug PKs once that feature is implemented in the SMRT framework.
