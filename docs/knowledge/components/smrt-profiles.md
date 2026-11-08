---
type: "Component"
title: "@happyvertical/smrt-profiles"
description: "Profile management system with relationships, metadata, and reciprocal associations for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T08:43:50Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:5329256a4d988d1d82ed155f7b1841cbd396e592b816979293703886db9ae1c7"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/profiles/package.json"
    title: "@happyvertical/smrt-profiles package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/profiles/AGENTS.md"
    title: "@happyvertical/smrt-profiles packages/profiles/AGENTS.md"
---

# @happyvertical/smrt-profiles

## Package

- Directory: `packages/profiles`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/profiles/AGENTS.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./internal/oidc-provisioning`
- `./manifest`
- `./manifest.json`
- `./utils`

## Models

- `ApiKey` (collection `apikeys`, extends `SmrtObject`)
- `ApiKeyCollection` (collection `apikeys`, extends `SmrtCollection`)
- `AuditLog` (collection `auditlogs`, extends `SmrtObject`)
- `AuditLogCollection` (collection `auditlogs`, extends `SmrtCollection`)
- `Bot` (collection `profiles`, extends `Profile`, STI table)
- `MagicLinkToken` (collection `magiclinktokens`, extends `SmrtObject`)
- `MagicLinkTokenCollection` (collection `magiclinktokens`, extends `SmrtCollection`)
- `NostrIdentity` (collection `nostridentities`, extends `SmrtObject`)
- `NostrIdentityCollection` (collection `nostridentities`, extends `SmrtCollection`)
- `OidcIdentity` (collection `oidcidentities`, extends `SmrtObject`)
- `OidcIdentityCollection` (collection `oidcidentities`, extends `SmrtCollection`)
- `OidcProfileEmailReservation` (collection `oidcprofileemailreservations`, extends `SmrtObject`)
- `OidcProfileEmailReservationCollection` (collection `oidcprofileemailreservations`, extends `SmrtCollection`)
- `Organization` (collection `profiles`, extends `Profile`, STI table)
- `Person` (collection `profiles`, extends `Profile`, STI table)
- `Profile` (collection `profiles`, extends `SmrtObject`, STI table)
- `ProfileAsset` (collection `profileassets`, extends `SmrtObject`)
- `ProfileAssetCollection` (collection `profileassets`, extends `SmrtJunction`)
- `ProfileCollection` (collection `profiles`, extends `SmrtCollection`)
- `ProfileLink` (collection `profilelinks`, extends `SmrtObject`)
- `ProfileLinkCollection` (collection `profilelinks`, extends `SmrtCollection`)
- `ProfileMetadata` (collection `profilemetadatas`, extends `SmrtObject`, STI table)
- `ProfileMetadataCollection` (collection `profilemetadatas`, extends `SmrtCollection`)
- `ProfileMetafield` (collection `profilemetafields`, extends `SmrtObject`, STI table)
- `ProfileMetafieldCollection` (collection `profilemetafields`, extends `SmrtCollection`)
- `ProfileRelationship` (collection `profilerelationships`, extends `SmrtObject`, STI table)
- `ProfileRelationshipCollection` (collection `profilerelationships`, extends `SmrtCollection`)
- `ProfileRelationshipTerm` (collection `profilerelationshipterms`, extends `SmrtObject`, STI table)
- `ProfileRelationshipTermCollection` (collection `profilerelationshipterms`, extends `SmrtCollection`)
- `ProfileRelationshipType` (collection `profilerelationshiptypes`, extends `SmrtObject`, STI table)
- `ProfileRelationshipTypeCollection` (collection `profilerelationshiptypes`, extends `SmrtCollection`)
- `ProfileType` (collection `profiletypes`, extends `SmrtObject`, STI table)
- `ProfileTypeCollection` (collection `profiletypes`, extends `SmrtCollection`)

## MCP tools

- `apikey_get`: get on `@happyvertical/smrt-profiles:ApiKey`
- `apikey_list`: list on `@happyvertical/smrt-profiles:ApiKey`
- `bot_create`: create on `@happyvertical/smrt-profiles:Bot`
- `bot_get`: get on `@happyvertical/smrt-profiles:Bot`
- `bot_list`: list on `@happyvertical/smrt-profiles:Bot`
- `bot_update`: update on `@happyvertical/smrt-profiles:Bot`
- `nostridentity_get`: get on `@happyvertical/smrt-profiles:NostrIdentity`
- `nostridentity_list`: list on `@happyvertical/smrt-profiles:NostrIdentity`
- `oidcidentity_get`: get on `@happyvertical/smrt-profiles:OidcIdentity`
- `oidcidentity_list`: list on `@happyvertical/smrt-profiles:OidcIdentity`
- `organization_create`: create on `@happyvertical/smrt-profiles:Organization`
- `organization_get`: get on `@happyvertical/smrt-profiles:Organization`
- `organization_list`: list on `@happyvertical/smrt-profiles:Organization`
- `organization_update`: update on `@happyvertical/smrt-profiles:Organization`
- `person_create`: create on `@happyvertical/smrt-profiles:Person`
- `person_get`: get on `@happyvertical/smrt-profiles:Person`
- `person_list`: list on `@happyvertical/smrt-profiles:Person`
- `person_update`: update on `@happyvertical/smrt-profiles:Person`
- `profile_create`: create on `@happyvertical/smrt-profiles:Profile`
- `profile_get`: get on `@happyvertical/smrt-profiles:Profile`
- `profile_list`: list on `@happyvertical/smrt-profiles:Profile`
- `profile_update`: update on `@happyvertical/smrt-profiles:Profile`
- `profilemetadata_get`: get on `@happyvertical/smrt-profiles:ProfileMetadata`
- `profilemetadata_list`: list on `@happyvertical/smrt-profiles:ProfileMetadata`
- `profilemetafield_get`: get on `@happyvertical/smrt-profiles:ProfileMetafield`
- `profilemetafield_list`: list on `@happyvertical/smrt-profiles:ProfileMetafield`
- `profilerelationship_get`: get on `@happyvertical/smrt-profiles:ProfileRelationship`
- `profilerelationship_list`: list on `@happyvertical/smrt-profiles:ProfileRelationship`
- `profilerelationshipterm_get`: get on `@happyvertical/smrt-profiles:ProfileRelationshipTerm`
- `profilerelationshipterm_list`: list on `@happyvertical/smrt-profiles:ProfileRelationshipTerm`
- `profilerelationshiptype_get`: get on `@happyvertical/smrt-profiles:ProfileRelationshipType`
- `profilerelationshiptype_list`: list on `@happyvertical/smrt-profiles:ProfileRelationshipType`
- `profiletype_get`: get on `@happyvertical/smrt-profiles:ProfileType`
- `profiletype_list`: list on `@happyvertical/smrt-profiles:ProfileType`
