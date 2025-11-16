---
"@happyvertical/smrt-core": patch
---

fix(toJSON): exclude @oneToMany/@manyToMany fields from serialization

Completes fix from #325 by updating toJSON() to filter out relationship fields.

**Changes:**
- Updated toJSON() to use field._meta instead of deprecated field.options
- Added explicit filtering for oneToMany and manyToMany field types
- Added cross-reference comments between toJSON() and SchemaGenerator

**Impact:**
- CRUD operations now work correctly for models with @oneToMany relationships
- Fixes SQLITE_ERROR: table has no column named <field> in save() operations
- Both schema generation AND serialization now filter relationship fields consistently

Fixes #327
