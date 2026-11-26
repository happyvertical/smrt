---
type: "Component"
title: "@happyvertical/smrt-profiles"
description: "Profile management system with relationships, metadata, and reciprocal associations for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-26T17:21:08Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:f170f312edeb408c78b7681652d37ca88c9eeeee05b1754d202f850f75654bb5"
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
- Object source: `manifest`
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

- `create_apikeys`: create on `@happyvertical/smrt-profiles:ApiKeyCollection`
- `create_auditlogs`: create on `@happyvertical/smrt-profiles:AuditLogCollection`
- `create_magiclinktokens`: create on `@happyvertical/smrt-profiles:MagicLinkToken`
- `create_magiclinktokens`: create on `@happyvertical/smrt-profiles:MagicLinkTokenCollection`
- `create_nostridentities`: create on `@happyvertical/smrt-profiles:NostrIdentityCollection`
- `create_oidcidentities`: create on `@happyvertical/smrt-profiles:OidcIdentityCollection`
- `create_profilemetadatas`: create on `@happyvertical/smrt-profiles:ProfileMetadataCollection`
- `create_profilemetafields`: create on `@happyvertical/smrt-profiles:ProfileMetafieldCollection`
- `create_profilerelationships`: create on `@happyvertical/smrt-profiles:ProfileRelationshipCollection`
- `create_profilerelationshipterms`: create on `@happyvertical/smrt-profiles:ProfileRelationshipTermCollection`
- `create_profilerelationshiptypes`: create on `@happyvertical/smrt-profiles:ProfileRelationshipTypeCollection`
- `create_profiles`: create on `@happyvertical/smrt-profiles:Bot`
- `create_profiles`: create on `@happyvertical/smrt-profiles:Organization`
- `create_profiles`: create on `@happyvertical/smrt-profiles:Person`
- `create_profiles`: create on `@happyvertical/smrt-profiles:Profile`
- `create_profiles`: create on `@happyvertical/smrt-profiles:ProfileCollection`
- `create_profiletypes`: create on `@happyvertical/smrt-profiles:ProfileTypeCollection`
- `delete_apikeys`: delete on `@happyvertical/smrt-profiles:ApiKeyCollection`
- `delete_auditlogs`: delete on `@happyvertical/smrt-profiles:AuditLogCollection`
- `delete_magiclinktokens`: delete on `@happyvertical/smrt-profiles:MagicLinkToken`
- `delete_magiclinktokens`: delete on `@happyvertical/smrt-profiles:MagicLinkTokenCollection`
- `delete_nostridentities`: delete on `@happyvertical/smrt-profiles:NostrIdentityCollection`
- `delete_oidcidentities`: delete on `@happyvertical/smrt-profiles:OidcIdentityCollection`
- `delete_profilemetadatas`: delete on `@happyvertical/smrt-profiles:ProfileMetadataCollection`
- `delete_profilemetafields`: delete on `@happyvertical/smrt-profiles:ProfileMetafieldCollection`
- `delete_profilerelationships`: delete on `@happyvertical/smrt-profiles:ProfileRelationshipCollection`
- `delete_profilerelationshipterms`: delete on `@happyvertical/smrt-profiles:ProfileRelationshipTermCollection`
- `delete_profilerelationshiptypes`: delete on `@happyvertical/smrt-profiles:ProfileRelationshipTypeCollection`
- `delete_profiles`: delete on `@happyvertical/smrt-profiles:Bot`
- `delete_profiles`: delete on `@happyvertical/smrt-profiles:Organization`
- `delete_profiles`: delete on `@happyvertical/smrt-profiles:Person`
- `delete_profiles`: delete on `@happyvertical/smrt-profiles:ProfileCollection`
- `delete_profiletypes`: delete on `@happyvertical/smrt-profiles:ProfileTypeCollection`
- `get_apikeys`: get on `@happyvertical/smrt-profiles:ApiKey`
- `get_apikeys`: get on `@happyvertical/smrt-profiles:ApiKeyCollection`
- `get_auditlogs`: get on `@happyvertical/smrt-profiles:AuditLog`
- `get_auditlogs`: get on `@happyvertical/smrt-profiles:AuditLogCollection`
- `get_magiclinktokens`: get on `@happyvertical/smrt-profiles:MagicLinkToken`
- `get_magiclinktokens`: get on `@happyvertical/smrt-profiles:MagicLinkTokenCollection`
- `get_nostridentities`: get on `@happyvertical/smrt-profiles:NostrIdentity`
- `get_nostridentities`: get on `@happyvertical/smrt-profiles:NostrIdentityCollection`
- `get_oidcidentities`: get on `@happyvertical/smrt-profiles:OidcIdentity`
- `get_oidcidentities`: get on `@happyvertical/smrt-profiles:OidcIdentityCollection`
- `get_profilemetadatas`: get on `@happyvertical/smrt-profiles:ProfileMetadata`
- `get_profilemetadatas`: get on `@happyvertical/smrt-profiles:ProfileMetadataCollection`
- `get_profilemetafields`: get on `@happyvertical/smrt-profiles:ProfileMetafield`
- `get_profilemetafields`: get on `@happyvertical/smrt-profiles:ProfileMetafieldCollection`
- `get_profilerelationships`: get on `@happyvertical/smrt-profiles:ProfileRelationship`
- `get_profilerelationships`: get on `@happyvertical/smrt-profiles:ProfileRelationshipCollection`
- `get_profilerelationshipterms`: get on `@happyvertical/smrt-profiles:ProfileRelationshipTerm`
- `get_profilerelationshipterms`: get on `@happyvertical/smrt-profiles:ProfileRelationshipTermCollection`
- `get_profilerelationshiptypes`: get on `@happyvertical/smrt-profiles:ProfileRelationshipType`
- `get_profilerelationshiptypes`: get on `@happyvertical/smrt-profiles:ProfileRelationshipTypeCollection`
- `get_profiles`: get on `@happyvertical/smrt-profiles:Bot`
- `get_profiles`: get on `@happyvertical/smrt-profiles:Organization`
- `get_profiles`: get on `@happyvertical/smrt-profiles:Person`
- `get_profiles`: get on `@happyvertical/smrt-profiles:Profile`
- `get_profiles`: get on `@happyvertical/smrt-profiles:ProfileCollection`
- `get_profiletypes`: get on `@happyvertical/smrt-profiles:ProfileType`
- `get_profiletypes`: get on `@happyvertical/smrt-profiles:ProfileTypeCollection`
- `list_apikeys`: list on `@happyvertical/smrt-profiles:ApiKey`
- `list_apikeys`: list on `@happyvertical/smrt-profiles:ApiKeyCollection`
- `list_auditlogs`: list on `@happyvertical/smrt-profiles:AuditLog`
- `list_auditlogs`: list on `@happyvertical/smrt-profiles:AuditLogCollection`
- `list_magiclinktokens`: list on `@happyvertical/smrt-profiles:MagicLinkToken`
- `list_magiclinktokens`: list on `@happyvertical/smrt-profiles:MagicLinkTokenCollection`
- `list_nostridentities`: list on `@happyvertical/smrt-profiles:NostrIdentity`
- `list_nostridentities`: list on `@happyvertical/smrt-profiles:NostrIdentityCollection`
- `list_oidcidentities`: list on `@happyvertical/smrt-profiles:OidcIdentity`
- `list_oidcidentities`: list on `@happyvertical/smrt-profiles:OidcIdentityCollection`
- `list_profilemetadatas`: list on `@happyvertical/smrt-profiles:ProfileMetadata`
- `list_profilemetadatas`: list on `@happyvertical/smrt-profiles:ProfileMetadataCollection`
- `list_profilemetafields`: list on `@happyvertical/smrt-profiles:ProfileMetafield`
- `list_profilemetafields`: list on `@happyvertical/smrt-profiles:ProfileMetafieldCollection`
- `list_profilerelationships`: list on `@happyvertical/smrt-profiles:ProfileRelationship`
- `list_profilerelationships`: list on `@happyvertical/smrt-profiles:ProfileRelationshipCollection`
- `list_profilerelationshipterms`: list on `@happyvertical/smrt-profiles:ProfileRelationshipTerm`
- `list_profilerelationshipterms`: list on `@happyvertical/smrt-profiles:ProfileRelationshipTermCollection`
- `list_profilerelationshiptypes`: list on `@happyvertical/smrt-profiles:ProfileRelationshipType`
- `list_profilerelationshiptypes`: list on `@happyvertical/smrt-profiles:ProfileRelationshipTypeCollection`
- `list_profiles`: list on `@happyvertical/smrt-profiles:Bot`
- `list_profiles`: list on `@happyvertical/smrt-profiles:Organization`
- `list_profiles`: list on `@happyvertical/smrt-profiles:Person`
- `list_profiles`: list on `@happyvertical/smrt-profiles:Profile`
- `list_profiles`: list on `@happyvertical/smrt-profiles:ProfileCollection`
- `list_profiletypes`: list on `@happyvertical/smrt-profiles:ProfileType`
- `list_profiletypes`: list on `@happyvertical/smrt-profiles:ProfileTypeCollection`
- `update_apikeys`: update on `@happyvertical/smrt-profiles:ApiKeyCollection`
- `update_auditlogs`: update on `@happyvertical/smrt-profiles:AuditLogCollection`
- `update_magiclinktokens`: update on `@happyvertical/smrt-profiles:MagicLinkToken`
- `update_magiclinktokens`: update on `@happyvertical/smrt-profiles:MagicLinkTokenCollection`
- `update_nostridentities`: update on `@happyvertical/smrt-profiles:NostrIdentityCollection`
- `update_oidcidentities`: update on `@happyvertical/smrt-profiles:OidcIdentityCollection`
- `update_profilemetadatas`: update on `@happyvertical/smrt-profiles:ProfileMetadataCollection`
- `update_profilemetafields`: update on `@happyvertical/smrt-profiles:ProfileMetafieldCollection`
- `update_profilerelationships`: update on `@happyvertical/smrt-profiles:ProfileRelationshipCollection`
- `update_profilerelationshipterms`: update on `@happyvertical/smrt-profiles:ProfileRelationshipTermCollection`
- `update_profilerelationshiptypes`: update on `@happyvertical/smrt-profiles:ProfileRelationshipTypeCollection`
- `update_profiles`: update on `@happyvertical/smrt-profiles:Bot`
- `update_profiles`: update on `@happyvertical/smrt-profiles:Organization`
- `update_profiles`: update on `@happyvertical/smrt-profiles:Person`
- `update_profiles`: update on `@happyvertical/smrt-profiles:Profile`
- `update_profiles`: update on `@happyvertical/smrt-profiles:ProfileCollection`
- `update_profiletypes`: update on `@happyvertical/smrt-profiles:ProfileTypeCollection`
