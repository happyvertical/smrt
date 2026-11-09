---
type: "Component"
title: "@happyvertical/smrt-cli"
description: "Developer CLI for SMRT framework - introspection, testing, and project management"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T03:14:53Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:80fe6993f4bdfbc10efb64e622b6454b7068735d8017e041ecb78dbc7dc1ec67"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/cli/package.json"
    title: "@happyvertical/smrt-cli package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/cli/AGENTS.md"
    title: "@happyvertical/smrt-cli packages/cli/AGENTS.md"
---

# @happyvertical/smrt-cli

## Package

- Directory: `packages/cli`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/cli/AGENTS.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-assets](/components/smrt-assets.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-desktop](/components/smrt-desktop.md)
- [smrt-dev-mcp](/components/smrt-dev-mcp.md)
- [smrt-inference](/components/smrt-inference.md)
- [smrt-ledgers](/components/smrt-ledgers.md)
- [smrt-playground](/components/smrt-playground.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-users](/components/smrt-users.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./app`

## Models

- `CliWritablePolicyRow` (collection `cliwritablepolicyrows`, extends `SmrtObject`)
- `CliWritablePolicyRows` (collection `cliwritablepolicyrows`, extends `SmrtCollection`)
- `Issue3460CliEntry` (collection `issue3460clientries`, extends `SmrtObject`)
- `Issue3460CliRecord` (collection `issue3460clirecords`, extends `SmrtObject`)
- `Issue3460CliRecords` (collection `issue3460clirecords`, extends `SmrtCollection`)
- `StiUpgradeAsset` (collection `stiupgradeassets`, extends `SmrtObject`, STI table)
- `StiUpgradeCustomIdentity` (collection `stiupgradecustomidentities`, extends `SmrtObject`, STI table)
- `StiUpgradeImage` (collection `stiupgradeassets`, extends `StiUpgradeAsset`, STI table)
- `TnkCode` (collection `tnkcodes`, extends `SmrtObject`)
- `TnkLeague` (collection `tnkleagues`, extends `SmrtObject`)
- `TnkTag` (collection `tnktags`, extends `SmrtObject`)

## MCP tools

- `create_cliwritablepolicyrows`: create on `@happyvertical/smrt-cli:CliWritablePolicyRow`
- `create_cliwritablepolicyrows`: create on `@happyvertical/smrt-cli:CliWritablePolicyRows`
- `create_issue3460clientries`: create on `@happyvertical/smrt-cli:Issue3460CliEntry`
- `create_issue3460clirecords`: create on `@happyvertical/smrt-cli:Issue3460CliRecord`
- `create_issue3460clirecords`: create on `@happyvertical/smrt-cli:Issue3460CliRecords`
- `create_stiupgradeassets`: create on `@happyvertical/smrt-cli:StiUpgradeAsset`
- `create_stiupgradeassets`: create on `@happyvertical/smrt-cli:StiUpgradeImage`
- `create_stiupgradecustomidentities`: create on `@happyvertical/smrt-cli:StiUpgradeCustomIdentity`
- `create_tnkcodes`: create on `@happyvertical/smrt-cli:TnkCode`
- `create_tnkleagues`: create on `@happyvertical/smrt-cli:TnkLeague`
- `create_tnktags`: create on `@happyvertical/smrt-cli:TnkTag`
- `delete_cliwritablepolicyrows`: delete on `@happyvertical/smrt-cli:CliWritablePolicyRow`
- `delete_cliwritablepolicyrows`: delete on `@happyvertical/smrt-cli:CliWritablePolicyRows`
- `delete_issue3460clientries`: delete on `@happyvertical/smrt-cli:Issue3460CliEntry`
- `delete_issue3460clirecords`: delete on `@happyvertical/smrt-cli:Issue3460CliRecord`
- `delete_issue3460clirecords`: delete on `@happyvertical/smrt-cli:Issue3460CliRecords`
- `delete_stiupgradeassets`: delete on `@happyvertical/smrt-cli:StiUpgradeAsset`
- `delete_stiupgradeassets`: delete on `@happyvertical/smrt-cli:StiUpgradeImage`
- `delete_stiupgradecustomidentities`: delete on `@happyvertical/smrt-cli:StiUpgradeCustomIdentity`
- `delete_tnkcodes`: delete on `@happyvertical/smrt-cli:TnkCode`
- `delete_tnkleagues`: delete on `@happyvertical/smrt-cli:TnkLeague`
- `delete_tnktags`: delete on `@happyvertical/smrt-cli:TnkTag`
- `get_cliwritablepolicyrows`: get on `@happyvertical/smrt-cli:CliWritablePolicyRow`
- `get_cliwritablepolicyrows`: get on `@happyvertical/smrt-cli:CliWritablePolicyRows`
- `get_issue3460clientries`: get on `@happyvertical/smrt-cli:Issue3460CliEntry`
- `get_issue3460clirecords`: get on `@happyvertical/smrt-cli:Issue3460CliRecord`
- `get_issue3460clirecords`: get on `@happyvertical/smrt-cli:Issue3460CliRecords`
- `get_stiupgradeassets`: get on `@happyvertical/smrt-cli:StiUpgradeAsset`
- `get_stiupgradeassets`: get on `@happyvertical/smrt-cli:StiUpgradeImage`
- `get_stiupgradecustomidentities`: get on `@happyvertical/smrt-cli:StiUpgradeCustomIdentity`
- `get_tnkcodes`: get on `@happyvertical/smrt-cli:TnkCode`
- `get_tnkleagues`: get on `@happyvertical/smrt-cli:TnkLeague`
- `get_tnktags`: get on `@happyvertical/smrt-cli:TnkTag`
- `list_cliwritablepolicyrows`: list on `@happyvertical/smrt-cli:CliWritablePolicyRow`
- `list_cliwritablepolicyrows`: list on `@happyvertical/smrt-cli:CliWritablePolicyRows`
- `list_issue3460clientries`: list on `@happyvertical/smrt-cli:Issue3460CliEntry`
- `list_issue3460clirecords`: list on `@happyvertical/smrt-cli:Issue3460CliRecord`
- `list_issue3460clirecords`: list on `@happyvertical/smrt-cli:Issue3460CliRecords`
- `list_stiupgradeassets`: list on `@happyvertical/smrt-cli:StiUpgradeAsset`
- `list_stiupgradeassets`: list on `@happyvertical/smrt-cli:StiUpgradeImage`
- `list_stiupgradecustomidentities`: list on `@happyvertical/smrt-cli:StiUpgradeCustomIdentity`
- `list_tnkcodes`: list on `@happyvertical/smrt-cli:TnkCode`
- `list_tnkleagues`: list on `@happyvertical/smrt-cli:TnkLeague`
- `list_tnktags`: list on `@happyvertical/smrt-cli:TnkTag`
- `update_cliwritablepolicyrows`: update on `@happyvertical/smrt-cli:CliWritablePolicyRow`
- `update_cliwritablepolicyrows`: update on `@happyvertical/smrt-cli:CliWritablePolicyRows`
- `update_issue3460clientries`: update on `@happyvertical/smrt-cli:Issue3460CliEntry`
- `update_issue3460clirecords`: update on `@happyvertical/smrt-cli:Issue3460CliRecord`
- `update_issue3460clirecords`: update on `@happyvertical/smrt-cli:Issue3460CliRecords`
- `update_stiupgradeassets`: update on `@happyvertical/smrt-cli:StiUpgradeAsset`
- `update_stiupgradeassets`: update on `@happyvertical/smrt-cli:StiUpgradeImage`
- `update_stiupgradecustomidentities`: update on `@happyvertical/smrt-cli:StiUpgradeCustomIdentity`
- `update_tnkcodes`: update on `@happyvertical/smrt-cli:TnkCode`
- `update_tnkleagues`: update on `@happyvertical/smrt-cli:TnkLeague`
- `update_tnktags`: update on `@happyvertical/smrt-cli:TnkTag`
