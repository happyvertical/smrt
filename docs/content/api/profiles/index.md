# @smrt/profiles

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Profile management system with relationships, metadata, and reciprocal associations for SMRT framework.

## Overview

The `@smrt/profiles` package provides a comprehensive profile management system built on the SMRT framework. It enables you to manage profiles of any type (people, organizations, robots) with flexible metadata, complex relationships, and time-based relationship tracking. The system supports reciprocal relationships, custom validation, and hierarchical profile types.

Key capabilities include:
- **Flexible Profile Types**: Define custom profile types with unique characteristics
- **Rich Metadata**: Attach validated metadata to profiles using a controlled vocabulary
- **Relationship Modeling**: Create directional or reciprocal relationships between profiles
- **Temporal Tracking**: Track relationship changes over time with term management
- **Custom Validation**: Define validation schemas for metadata fields
- **Reciprocal Handlers**: Automatic two-way relationship creation with custom logic

## Features

- **Profile Management**: Create and manage profiles of any type (human, organization, robot, etc.)
- **Type System**: Classify profiles with a flexible type hierarchy
- **Metadata System**: Attach arbitrary metadata with validation schemas
- **Relationship Engine**: Model complex relationships between profiles
- **Reciprocal Relationships**: Automatically create two-way associations (friend, spouse, colleague)
- **Temporal Relationships**: Track relationship terms with start and end dates
- **Context Profiles**: Support tertiary context in relationships (e.g., employer in employment relationships)
- **AI-Powered Methods**: Generate bios, match criteria using built-in AI capabilities
- **Auto-Generated APIs**: REST API, CLI, and MCP tools generated automatically
- **Type-Safe**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
# Install with pnpm (recommended for SMRT projects)
pnpm add @smrt/profiles

# Or with npm
npm install @smrt/profiles

# Or with bun
bun add @smrt/profiles
```

## Quick Start

### Creating Profile Types

```typescript
import { ProfileType } from '@smrt/profiles';

// Create a profile type for humans
const humanType = new ProfileType({
  name: 'Human',
  description: 'Individual person'
});
await humanType.save();

// Create a profile type for organizations
const orgType = new ProfileType({
  name: 'Organization',
  description: 'Company, nonprofit, or group'
});
await orgType.save();
```

### Creating Profiles

```typescript
import { Profile } from '@smrt/profiles';

// Create a person profile
const person = new Profile({
  typeId: humanType.id,
  name: 'Alice Johnson',
  email: 'alice@example.com',
  description: 'Software engineer and AI researcher'
});
await person.save();

// Or use the convenience method
await person.setTypeBySlug('human');
```

### Managing Metadata

```typescript
import { ProfileMetafield } from '@smrt/profiles';

// Define a metadata field with validation
const locationField = new ProfileMetafield({
  name: 'Location',
  description: 'Geographic location',
  validation: {
    type: 'string',
    minLength: 2,
    maxLength: 100
  }
});
await locationField.save();

// Add metadata to a profile
await person.addMetadata('location', 'San Francisco, CA');

// Get all metadata
const metadata = await person.getMetadata();
console.log(metadata); // { location: 'San Francisco, CA' }

// Update multiple metadata values
await person.updateMetadata({
  location: 'New York, NY',
  timezone: 'America/New_York'
});
```

### Creating Relationships

```typescript
import { ProfileRelationshipType } from '@smrt/profiles';

// Define a relationship type
const friendType = new ProfileRelationshipType({
  name: 'Friend',
  reciprocal: true // Two-way relationship
});
await friendType.save();

// Create another profile
const bob = new Profile({
  typeId: humanType.id,
  name: 'Bob Smith',
  email: 'bob@example.com'
});
await bob.save();

// Add a friendship (automatically creates reciprocal relationship)
await person.addRelationship(bob, 'friend');

// Get all relationships
const relationships = await person.getRelationships();

// Get related profiles
const friends = await person.getRelatedProfiles('friend');
console.log(friends.map(f => f.name)); // ['Bob Smith']
```

### Working with Relationship Terms

```typescript
// Add a time-based relationship with terms
const employeeType = new ProfileRelationshipType({
  name: 'Employee',
  reciprocal: false // One-way relationship
});
await employeeType.save();

const company = new Profile({
  typeId: orgType.id,
  name: 'Acme Corp'
});
await company.save();

// Create employment relationship
await person.addRelationship(company, 'employee');

// Get the relationship and add a term
const relationships = await person.getRelationships({ typeSlug: 'employee' });
const employment = relationships[0];

// Add employment term
await employment.addTerm(new Date('2020-01-01'));

// End the current term
await employment.endCurrentTerm(new Date('2023-12-31'));

// Add a new term (re-employment)
await employment.addTerm(new Date('2024-06-01'));
```

### Custom Validation

```typescript
import { ProfileMetafield } from '@smrt/profiles';

// Register a custom validator
ProfileMetafield.registerValidator('isEmail', (value) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(value);
});

// Create a metafield with custom validation
const emailField = new ProfileMetafield({
  name: 'Secondary Email',
  validation: {
    custom: 'isEmail',
    message: 'Invalid email address'
  }
});
await emailField.save();

// This will validate before saving
await person.addMetadata('secondary-email', 'invalid-email'); // Throws error
await person.addMetadata('secondary-email', 'valid@example.com'); // Succeeds
```

### Custom Reciprocal Handlers

```typescript
import { ProfileRelationshipType, type Profile } from '@smrt/profiles';

// Register a custom reciprocal handler for asymmetric relationships
ProfileRelationshipType.registerReciprocalHandler(
  'mentor',
  async (mentor: Profile, mentee: Profile) => {
    // When A mentors B, automatically create "B is mentee of A"
    await mentee.addRelationship(mentor, 'mentee');
  }
);

// Define the mentor relationship type
const mentorType = new ProfileRelationshipType({
  name: 'Mentor',
  reciprocal: true
});
await mentorType.save();

const menteeType = new ProfileRelationshipType({
  name: 'Mentee',
  reciprocal: false // Don't auto-reciprocate from mentee side
});
await menteeType.save();

// Create mentorship (automatically creates inverse mentee relationship)
await seniorEngineer.addRelationship(juniorEngineer, 'mentor');
```

### AI-Powered Features

```typescript
// Generate a professional bio using AI
const bio = await person.generateBio();
console.log(bio);
// "Alice Johnson is a seasoned software engineer and AI researcher based in
// San Francisco. With expertise in machine learning and distributed systems..."

// Check if profile matches criteria
const isEngineer = await person.matches('works in software engineering');
console.log(isEngineer); // true

const isMedical = await person.matches('works in healthcare');
console.log(isMedical); // false
```

### Using Collections

```typescript
import { ProfileCollection } from '@smrt/profiles';

// Get or create a profile collection
const profileCollection = await ProfileCollection.create();

// List all profiles with filtering
const engineers = await profileCollection.list({
  where: {
    description: { like: '%engineer%' }
  },
  limit: 10
});

// Search by email
const profile = await profileCollection.get({
  where: { email: 'alice@example.com' }
});

// Bulk operations
const profiles = await profileCollection.createMany([
  { typeId: humanType.id, name: 'Carol White', email: 'carol@example.com' },
  { typeId: humanType.id, name: 'Dave Black', email: 'dave@example.com' }
]);
```

## Data Model

The profiles package consists of seven core models:

### Profile
Central entity representing any profile with type, email, name, and description.

**Fields:**
- `id` (UUID): Unique identifier
- `typeId` (Foreign Key): References ProfileType
- `email` (Text, unique): Email address
- `name` (Text, required): Display name
- `description` (Text): Bio or description

**Relationships:**
- `metadata`: One-to-many ProfileMetadata
- `relationshipsFrom`: One-to-many ProfileRelationship (as source)
- `relationshipsTo`: One-to-many ProfileRelationship (as target)

### ProfileType
Lookup table defining profile types (human, org, robot, etc.).

**Fields:**
- `id` (UUID): Unique identifier
- `slug` (Text, unique): URL-safe identifier
- `name` (Text, required): Display name
- `description` (Text): Type description

### ProfileMetadata
Stores metadata values for profiles using controlled vocabulary.

**Fields:**
- `id` (UUID): Unique identifier
- `profileId` (Foreign Key): References Profile
- `metafieldId` (Foreign Key): References ProfileMetafield
- `value` (Text, required): Metadata value

### ProfileMetafield
Controlled vocabulary defining allowed metadata fields with validation.

**Fields:**
- `id` (UUID): Unique identifier
- `slug` (Text, unique): URL-safe identifier
- `name` (Text, required): Display name
- `description` (Text): Field description
- `validation` (JSON): Validation schema

### ProfileRelationship
Connects two profiles with a relationship type.

**Fields:**
- `id` (UUID): Unique identifier
- `fromProfileId` (Foreign Key): Source profile
- `toProfileId` (Foreign Key): Target profile
- `typeId` (Foreign Key): References ProfileRelationshipType
- `contextProfileId` (Foreign Key, optional): Tertiary context profile

**Relationships:**
- `terms`: One-to-many ProfileRelationshipTerm

### ProfileRelationshipType
Lookup table defining relationship types with reciprocal support.

**Fields:**
- `id` (UUID): Unique identifier
- `slug` (Text, unique): URL-safe identifier
- `name` (Text, required): Display name
- `reciprocal` (Boolean, default: true): Whether relationship is two-way

### ProfileRelationshipTerm
Tracks time periods for relationships with start and end dates.

**Fields:**
- `id` (UUID): Unique identifier
- `relationshipId` (Foreign Key): References ProfileRelationship
- `startedAt` (DateTime, required): Term start date
- `endedAt` (DateTime, optional): Term end date

## Advanced Usage

### Complex Relationship Queries

```typescript
// Get all relationships of a specific type
const employments = await person.getRelationships({
  typeSlug: 'employee',
  direction: 'from' // Only outgoing relationships
});

// Get all profiles related as employers
const employers = await person.getRelatedProfiles('employee');

// Get all relationship terms with history
for (const rel of employments) {
  const terms = await rel.getTerms();
  console.log(`Employment periods: ${terms.length}`);

  for (const term of terms) {
    console.log(`From ${term.startedAt} to ${term.endedAt || 'present'}`);
  }
}
```

### Validation Schemas

```typescript
// String validation
const nameField = new ProfileMetafield({
  name: 'Display Name',
  validation: {
    type: 'string',
    minLength: 2,
    maxLength: 50,
    pattern: '^[A-Za-z ]+$',
    message: 'Name must contain only letters and spaces'
  }
});

// Numeric validation
const ageField = new ProfileMetafield({
  name: 'Age',
  validation: {
    type: 'number',
    min: 0,
    max: 150,
    message: 'Age must be between 0 and 150'
  }
});

// Combined validation
const websiteField = new ProfileMetafield({
  name: 'Website',
  validation: {
    type: 'string',
    pattern: '^https?://.+',
    minLength: 10,
    maxLength: 200
  }
});
```

### Context Profiles in Relationships

```typescript
// Define a three-way relationship (employee-employer-role)
const role = new Profile({
  typeId: roleType.id,
  name: 'Senior Engineer'
});
await role.save();

// Add relationship with context
await person.addRelationship(company, 'employee', role);

// Query relationships with context
const employments = await person.getRelationships({
  typeSlug: 'employee'
});

for (const employment of employments) {
  const contextProfile = await employment.loadRelated('contextProfileId');
  console.log(`Role: ${contextProfile?.name}`);
}
```

### Batch Operations

```typescript
import {
  ProfileCollection,
  ProfileTypeCollection,
  ProfileMetafieldCollection
} from '@smrt/profiles';

// Initialize collections
const profileCollection = await ProfileCollection.create();
const typeCollection = await ProfileTypeCollection.create();
const metafieldCollection = await ProfileMetafieldCollection.create();

// Bulk create profile types
const types = await typeCollection.createMany([
  { name: 'Human', description: 'Individual person' },
  { name: 'Organization', description: 'Company or group' },
  { name: 'Bot', description: 'Automated agent' }
]);

// Bulk create metafields
const fields = await metafieldCollection.createMany([
  { name: 'Location', description: 'Geographic location' },
  { name: 'Website', description: 'Personal or company website' },
  { name: 'Phone', description: 'Contact phone number' }
]);

// Create profiles in batch
const profiles = await profileCollection.createMany([
  { typeId: types[0].id, name: 'Alice', email: 'alice@example.com' },
  { typeId: types[0].id, name: 'Bob', email: 'bob@example.com' },
  { typeId: types[1].id, name: 'Acme Corp', email: 'info@acme.com' }
]);
```

## TypeScript Support

The package is written in TypeScript and provides comprehensive type definitions:

```typescript
import type {
  Profile,
  ProfileType,
  ProfileMetadata,
  ProfileMetafield,
  ProfileRelationship,
  ProfileRelationshipType,
  ProfileRelationshipTerm,
  ProfileOptions,
  ProfileTypeOptions,
  ProfileMetadataOptions,
  ProfileMetafieldOptions,
  ProfileRelationshipOptions,
  ProfileRelationshipTypeOptions,
  ValidationSchema,
  ValidatorFunction,
  ReciprocalHandler
} from '@smrt/profiles';
```

## Auto-Generated Features

As a SMRT package, `@smrt/profiles` automatically generates:

### REST API Endpoints
- `GET /api/profiles` - List profiles
- `GET /api/profiles/:id` - Get profile
- `POST /api/profiles` - Create profile
- `PUT /api/profiles/:id` - Update profile
- `DELETE /api/profiles/:id` - Delete profile

Similar endpoints for all models (ProfileType, ProfileMetadata, etc.)

### CLI Commands
```bash
# List profiles
smrt profiles list

# Get profile by ID
smrt profiles get <id>

# Create new profile
smrt profiles create --name "John Doe" --email "john@example.com"

# Update profile
smrt profiles update <id> --name "Jane Doe"
```

### MCP Tools
- `profiles_list` - Query profiles
- `profiles_get` - Get profile details
- `profiles_create` - Create new profile
- `profiles_update` - Update profile data

## API Reference

For complete API documentation, see the generated TypeDoc documentation at `/api/profiles/globals`.

**Key Exports:**
- **Models**: `Profile`, `ProfileType`, `ProfileMetadata`, `ProfileMetafield`, `ProfileRelationship`, `ProfileRelationshipType`, `ProfileRelationshipTerm`
- **Collections**: `ProfileCollection`, `ProfileTypeCollection`, `ProfileMetadataCollection`, `ProfileMetafieldCollection`, `ProfileRelationshipCollection`, `ProfileRelationshipTypeCollection`, `ProfileRelationshipTermCollection`
- **Types**: `ValidationSchema`, `ValidatorFunction`, `ReciprocalHandler`

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](_media/LICENSE) file for details.
