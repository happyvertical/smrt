---
'@happyvertical/smrt-core': patch
---

A field typed UUID (`sqlType` or a reference) whose class initializer is `''`
no longer gets `DEFAULT ''`. PostgreSQL stored that default as
`(''::text)::uuid` without evaluating it, so every INSERT that omitted the
column failed with 22P02. This is a schema change: `smrt db:migrate` drops the
`''` default from existing uuid columns.
