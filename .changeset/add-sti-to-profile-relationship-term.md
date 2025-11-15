---
"@happyvertical/smrt-profiles": patch
---

fix(profiles): add tableStrategy: 'sti' to ProfileRelationshipTerm

Enables Single Table Inheritance (STI) for ProfileRelationshipTerm subclasses by adding `tableStrategy: 'sti'` configuration. This allows child classes like `CouncilMemberTerm` to properly share the `profile_relationship_terms` table instead of creating their own separate tables.

Fixes #310

**Impact:**
- ProfileRelationshipTerm subclasses can now use STI properly
- Child classes share parent table instead of creating separate tables
- Resolves ConfigurationError when subclasses try to use STI

**Note:** ProfileRelationship already had STI configured, so only ProfileRelationshipTerm needed updating.
