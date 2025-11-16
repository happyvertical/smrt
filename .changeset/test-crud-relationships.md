---
"@happyvertical/smrt-core": patch
---

test: add comprehensive CRUD tests for @oneToMany relationships

Adds extensive test coverage for basic database operations with relationship fields.

**Test Coverage:**
- CREATE operations with @oneToMany fields
- READ operations (by ID, list all)
- UPDATE operations
- DELETE operations
- Edge cases (minimal data, multiple saves)

**Impact:**
- Validates that relationship fields are correctly excluded from SQL operations
- Provides regression tests for issues #324 and #327
- Ensures CRUD operations work correctly with @oneToMany decorators

Related to #327, #324
