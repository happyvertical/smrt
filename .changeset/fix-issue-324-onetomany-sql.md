---
"@happyvertical/smrt-core": patch
---

fix(@oneToMany): exclude relationship fields from SQL INSERT/UPDATE statements

Fixes #324 where @oneToMany decorated fields were incorrectly included in SQL INSERT/UPDATE statements as database columns, causing SQLITE_ERROR: table has no column named <field>.

**Changes:**
- Added transient field filtering to `SchemaGenerator.generateColumns()` method
- Added explicit filtering for `oneToMany` and `manyToMany` relationship types
- Added filtering for `meta` field types (STI support)
- Exported `Meta<T>` type for STI meta field annotations

**Impact:**
- All CRUD operations now work correctly for models with @oneToMany relationships
- Inheritance hierarchies (e.g., Council extends Organization extends Profile) work as expected
- No breaking changes - only fixes incorrect behavior

**Testing:**
- Added comprehensive test suite in `issue-324-onetomany-sql.test.ts`
- Existing transient field tests continue to pass
