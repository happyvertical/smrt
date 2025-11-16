---
"@happyvertical/smrt-core": patch
---

fix(core): STI save operations now work for multi-level inheritance hierarchies

Fixes two critical bugs preventing multi-level STI (Single Table Inheritance) hierarchies from working correctly:

**1. toJSON() not using inherited fields (object.ts:577)**
- **Problem**: `toJSON()` only serialized fields from the immediate class, missing parent fields in inheritance hierarchies
- **Fix**: Use cached `inheritedFields` when available (populated by `getAllFields()` during schema generation)
- **Impact**: Multi-level STI classes like Council → Organization → Profile now serialize ALL inherited fields correctly

**2. collection.create() always instantiating base class (collection.ts:833)**
- **Problem**: `create()` ignored `_meta_type` parameter and always instantiated the collection's `_itemClass`
- **Fix**: Added polymorphic instantiation check - if `tableStrategy === 'sti'` and `_meta_type` is provided, call `createPolymorphic()`
- **Impact**: Creating subclass instances via base collection now works: `profiles.create({ _meta_type: 'Council', ... })` correctly instantiates a Council instance

**Changes:**
- `packages/core/src/object.ts`: Use `ObjectRegistry.findClass().inheritedFields` in toJSON()
- `packages/core/src/collection.ts`: Add polymorphic instantiation logic to create()
- `packages/core/src/__tests__/sti-multilevel.test.ts`: Comprehensive test suite for multi-level STI

**Testing:**
- Added 6 integration tests covering CREATE, READ, UPDATE, DELETE, and polymorphic queries
- Validates Council → Organization → Profile → SmrtObject hierarchy

**Fixes #332**
