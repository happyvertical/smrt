---
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-events": patch
"@happyvertical/smrt-places": patch
"@happyvertical/smrt-tags": patch
"@happyvertical/smrt-content": patch
"@happyvertical/smrt-products": patch
"@happyvertical/smrt-profiles": patch
---

feat(all): add tableStrategy: 'sti' to all SMRT framework classes

Enables Single Table Inheritance (STI) across all SMRT packages by adding `tableStrategy: 'sti'` to all @smrt() decorated classes. This allows subclasses to properly share parent tables instead of creating separate tables for each subclass.

**Packages updated (17 classes total):**

**assets** (3 classes):
- AssetStatus
- AssetType
- AssetMetafield

**events** (3 classes):
- EventSeries
- EventType
- EventParticipant

**places** (1 class):
- PlaceType

**tags** (1 class):
- TagAlias

**content** (3 classes):
- Article (STI subclass - now explicit)
- ContentDocument (STI subclass - now explicit)
- Mirror (STI subclass - now explicit)

**products** (1 class):
- Category

**profiles** (7 classes):
- ProfileType
- ProfileMetafield
- ProfileMetadata
- ProfileRelationshipType
- Person (STI subclass - now explicit)
- Organization (STI subclass - now explicit)
- Bot (STI subclass - now explicit)

**Impact:**
- All base classes now support STI for subclasses
- STI subclasses now explicitly declare `tableStrategy: 'sti'` for clarity
- Consistent STI support across entire SMRT framework
- Enables proper inheritance hierarchies throughout the ecosystem

**Related issues:**
- #310 - ProfileRelationshipTerm missing STI
- #298 - STI subclass table creation issues
- #301 - AST Scanner STI discovery

This change provides a foundation for consistent STI usage across all SMRT-based applications and ensures subclasses can properly leverage single-table inheritance patterns.
