---
type: "Component"
title: "@happyvertical/smrt-ledgers"
description: "Double-entry accounting ledger for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T10:47:34Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:3135d405b699fc20ae591b603aecde79384d2c47b40941e4e5ce038efd7ef2ac"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ledgers/package.json"
    title: "@happyvertical/smrt-ledgers package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ledgers/AGENTS.md"
    title: "@happyvertical/smrt-ledgers packages/ledgers/AGENTS.md"
---

# @happyvertical/smrt-ledgers

## Package

- Directory: `packages/ledgers`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/ledgers/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `Account` (collection `accounts`, extends `SmrtHierarchical`)
- `Journal` (collection `journals`, extends `SmrtObject`)
- `JournalEntry` (collection `journalentries`, extends `SmrtObject`)
- `Ledger` (collection `ledgers`, extends `SmrtObject`)

## MCP tools

- `create_accounts`: create on `@happyvertical/smrt-ledgers:Account`
- `create_journals`: create on `@happyvertical/smrt-ledgers:Journal`
- `create_ledgers`: create on `@happyvertical/smrt-ledgers:Ledger`
- `get_accounts`: get on `@happyvertical/smrt-ledgers:Account`
- `get_journalentries`: get on `@happyvertical/smrt-ledgers:JournalEntry`
- `get_journals`: get on `@happyvertical/smrt-ledgers:Journal`
- `get_ledgers`: get on `@happyvertical/smrt-ledgers:Ledger`
- `list_accounts`: list on `@happyvertical/smrt-ledgers:Account`
- `list_journalentries`: list on `@happyvertical/smrt-ledgers:JournalEntry`
- `list_journals`: list on `@happyvertical/smrt-ledgers:Journal`
- `list_ledgers`: list on `@happyvertical/smrt-ledgers:Ledger`
