---
type: "Component"
title: "@happyvertical/smrt-ledgers"
description: "Double-entry accounting ledger for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:bf4db82d40ede2bfce56ff43d844421d3aa2f49d2f2b487a004642763a3a1b81"
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

- Version: `0.60.8`
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
