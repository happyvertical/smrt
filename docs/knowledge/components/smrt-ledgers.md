---
type: "Component"
title: "@happyvertical/smrt-ledgers"
description: "Double-entry accounting ledger for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T08:43:50Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:878d4b24e297a7d957516c553d8c729e6aa8496e63c5a45b21737fe57a18c8f2"
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
- Object source: `domain-artifact`
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
- `AccountCollection` (collection `accounts`, extends `SmrtCollection`)
- `Journal` (collection `journals`, extends `SmrtObject`)
- `JournalCollection` (collection `journals`, extends `SmrtCollection`)
- `JournalEntry` (collection `journalentries`, extends `SmrtObject`)
- `JournalEntryCollection` (collection `journalentries`, extends `SmrtCollection`)
- `Ledger` (collection `ledgers`, extends `SmrtObject`)
- `LedgerCollection` (collection `ledgers`, extends `SmrtCollection`)

## MCP tools

- `account_create`: create on `@happyvertical/smrt-ledgers:Account`
- `account_get`: get on `@happyvertical/smrt-ledgers:Account`
- `account_list`: list on `@happyvertical/smrt-ledgers:Account`
- `journal_create`: create on `@happyvertical/smrt-ledgers:Journal`
- `journal_get`: get on `@happyvertical/smrt-ledgers:Journal`
- `journal_list`: list on `@happyvertical/smrt-ledgers:Journal`
- `journalentry_get`: get on `@happyvertical/smrt-ledgers:JournalEntry`
- `journalentry_list`: list on `@happyvertical/smrt-ledgers:JournalEntry`
- `ledger_create`: create on `@happyvertical/smrt-ledgers:Ledger`
- `ledger_get`: get on `@happyvertical/smrt-ledgers:Ledger`
- `ledger_list`: list on `@happyvertical/smrt-ledgers:Ledger`
