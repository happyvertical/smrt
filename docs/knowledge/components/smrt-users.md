---
type: "Component"
title: "@happyvertical/smrt-users"
description: "Multi-tenant user management for the SMRT framework - users, tenants, roles, permissions, groups"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-26T18:24:00Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:388153cdca4dd0236094875671443ca275268866ef0ef4b4d621e01a2dd4bb07"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/package.json"
    title: "@happyvertical/smrt-users package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/AGENTS.md"
    title: "@happyvertical/smrt-users packages/users/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/family-invitations.md"
    title: "@happyvertical/smrt-users packages/users/agents/family-invitations.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/mobile-auth.md"
    title: "@happyvertical/smrt-users packages/users/agents/mobile-auth.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/oauth-authorization.md"
    title: "@happyvertical/smrt-users packages/users/agents/oauth-authorization.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/oidc-provisioning.md"
    title: "@happyvertical/smrt-users packages/users/agents/oidc-provisioning.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/permissions.md"
    title: "@happyvertical/smrt-users packages/users/agents/permissions.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/retention.md"
    title: "@happyvertical/smrt-users packages/users/agents/retention.md"
  - id: "agents-8"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/service-principals.md"
    title: "@happyvertical/smrt-users packages/users/agents/service-principals.md"
  - id: "agents-9"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/terminal-auth-testing.md"
    title: "@happyvertical/smrt-users packages/users/agents/terminal-auth-testing.md"
---

# @happyvertical/smrt-users

## Package

- Directory: `packages/users`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/users/AGENTS.md`
- `packages/users/agents/family-invitations.md`
- `packages/users/agents/mobile-auth.md`
- `packages/users/agents/oauth-authorization.md`
- `packages/users/agents/oidc-provisioning.md`
- `packages/users/agents/permissions.md`
- `packages/users/agents/retention.md`
- `packages/users/agents/service-principals.md`
- `packages/users/agents/terminal-auth-testing.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-mobile-contract](/components/smrt-mobile-contract.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`

## Exports

- `.`
- `./app-contract`
- `./manifest`
- `./manifest.json`
- `./operator`
- `./permission-registry`
- `./playground`
- `./postgres-policies`
- `./postgres-settings`
- `./step-up`
- `./svelte`
- `./sveltekit`

## Models

- `AccessRequest` (collection `accessrequests`, extends `SmrtObject`)
- `Group` (collection `groups`, extends `SmrtObject`)
- `GroupMember` (collection `groupmembers`, extends `SmrtObject`)
- `GroupRole` (collection `grouproles`, extends `SmrtObject`)
- `LegalMember` (collection `legalmembers`, extends `SmrtObject`)
- `LegalMemberCollection` (collection `legalmembercollections`, extends `SmrtCollection`)
- `LegalMemberReference` (collection `legalmemberreferences`, extends `SmrtObject`)
- `LegalMemberReferenceCollection` (collection `legalmemberreferencecollections`, extends `SmrtCollection`)
- `LegalMemberStatusHistory` (collection `legalmemberstatushistories`, extends `SmrtObject`)
- `LegalMemberStatusHistoryCollection` (collection `legalmemberstatushistorycollections`, extends `SmrtCollection`)
- `MemberClass` (collection `memberclasses`, extends `SmrtObject`)
- `MemberClassCollection` (collection `memberclasscollections`, extends `SmrtCollection`)
- `MemberEligibilitySnapshot` (collection `membereligibilitysnapshots`, extends `SmrtObject`)
- `MemberEligibilitySnapshotCollection` (collection `membereligibilitysnapshotcollections`, extends `SmrtCollection`)
- `MemberOfficerAppointment` (collection `memberofficerappointments`, extends `SmrtObject`)
- `MemberOfficerAppointmentCollection` (collection `memberofficerappointmentcollections`, extends `SmrtCollection`)
- `Membership` (collection `memberships`, extends `SmrtObject`)
- `MembershipOverride` (collection `membershipoverrides`, extends `SmrtObject`)
- `Permission` (collection `permissions`, extends `SmrtObject`)
- `ResourceGrant` (collection `resourcegrants`, extends `SmrtObject`)
- `Role` (collection `roles`, extends `SmrtObject`)
- `RolePermission` (collection `rolepermissions`, extends `SmrtObject`)
- `Session` (collection `sessions`, extends `SmrtObject`)
- `Tenant` (collection `tenants`, extends `SmrtObject`, STI table)
- `TenantIntegration` (collection `tenantintegrations`, extends `SmrtObject`)
- `TenantPermissionOverride` (collection `tenantpermissionoverrides`, extends `SmrtObject`)
- `User` (collection `users`, extends `SmrtObject`)
- `UsersCliAuthApproveLimit` (collection `userscliauthapprovelimits`, extends `SmrtObject`)
- `UsersCliAuthRequest` (collection `userscliauthrequests`, extends `SmrtObject`)
- `UsersLoginAttempt` (collection `usersloginattempts`, extends `SmrtObject`)
- `UsersLoginAuditEvent` (collection `usersloginauditevents`, extends `SmrtObject`)
- `UsersMagicLinkToken` (collection `usersmagiclinktokens`, extends `SmrtObject`)
- `UsersOAuthAccessTokenRevocation` (collection `usersoauthaccesstokenrevocations`, extends `SmrtObject`)
- `UsersOAuthAuthorization` (collection `usersoauthauthorizations`, extends `SmrtObject`)
- `UsersOAuthAuthorizationCode` (collection `usersoauthauthorizationcodes`, extends `SmrtObject`)
- `UsersOAuthClient` (collection `usersoauthclients`, extends `SmrtObject`)
- `UsersOAuthRefreshFamily` (collection `usersoauthrefreshfamilies`, extends `SmrtObject`)
- `UsersOAuthRefreshGrant` (collection `usersoauthrefreshgrants`, extends `SmrtObject`)
- `UsersPasskeyChallenge` (collection `userspasskeychallenges`, extends `SmrtObject`)
- `UsersPasskeyCredential` (collection `userspasskeycredentials`, extends `SmrtObject`)
- `UsersPasswordCredential` (collection `userspasswordcredentials`, extends `SmrtObject`)
- `UsersPinCredential` (collection `userspincredentials`, extends `SmrtObject`)

## MCP tools

- `get_groupmembers`: get on `@happyvertical/smrt-users:GroupMember`
- `get_grouproles`: get on `@happyvertical/smrt-users:GroupRole`
- `get_groups`: get on `@happyvertical/smrt-users:Group`
- `get_membershipoverrides`: get on `@happyvertical/smrt-users:MembershipOverride`
- `get_memberships`: get on `@happyvertical/smrt-users:Membership`
- `get_permissions`: get on `@happyvertical/smrt-users:Permission`
- `get_rolepermissions`: get on `@happyvertical/smrt-users:RolePermission`
- `get_roles`: get on `@happyvertical/smrt-users:Role`
- `get_tenantintegrations`: get on `@happyvertical/smrt-users:TenantIntegration`
- `get_tenantpermissionoverrides`: get on `@happyvertical/smrt-users:TenantPermissionOverride`
- `get_tenants`: get on `@happyvertical/smrt-users:Tenant`
- `get_users`: get on `@happyvertical/smrt-users:User`
- `list_groupmembers`: list on `@happyvertical/smrt-users:GroupMember`
- `list_grouproles`: list on `@happyvertical/smrt-users:GroupRole`
- `list_groups`: list on `@happyvertical/smrt-users:Group`
- `list_membershipoverrides`: list on `@happyvertical/smrt-users:MembershipOverride`
- `list_memberships`: list on `@happyvertical/smrt-users:Membership`
- `list_permissions`: list on `@happyvertical/smrt-users:Permission`
- `list_rolepermissions`: list on `@happyvertical/smrt-users:RolePermission`
- `list_roles`: list on `@happyvertical/smrt-users:Role`
- `list_tenantintegrations`: list on `@happyvertical/smrt-users:TenantIntegration`
- `list_tenantpermissionoverrides`: list on `@happyvertical/smrt-users:TenantPermissionOverride`
- `list_tenants`: list on `@happyvertical/smrt-users:Tenant`
- `list_users`: list on `@happyvertical/smrt-users:User`
