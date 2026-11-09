---
type: "Component"
title: "@happyvertical/smrt-users"
description: "Multi-tenant user management for the SMRT framework - users, tenants, roles, permissions, groups"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T18:13:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:badb40d7019471807d1fbe3458932cc7b6ed0dc815d6b28fa362722964bb0d27"
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
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/oidc-provisioning.md"
    title: "@happyvertical/smrt-users packages/users/agents/oidc-provisioning.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/permissions.md"
    title: "@happyvertical/smrt-users packages/users/agents/permissions.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/retention.md"
    title: "@happyvertical/smrt-users packages/users/agents/retention.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/users/agents/terminal-auth-testing.md"
    title: "@happyvertical/smrt-users packages/users/agents/terminal-auth-testing.md"
---

# @happyvertical/smrt-users

## Package

- Directory: `packages/users`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/users/AGENTS.md`
- `packages/users/agents/family-invitations.md`
- `packages/users/agents/mobile-auth.md`
- `packages/users/agents/oidc-provisioning.md`
- `packages/users/agents/permissions.md`
- `packages/users/agents/retention.md`
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
- `./step-up`
- `./svelte`
- `./sveltekit`

## Models

- `AccessRequest` (collection `accessrequests`, extends `SmrtObject`)
- `AccessRequestCollection` (collection `accessrequests`, extends `SmrtCollection`)
- `Group` (collection `groups`, extends `SmrtObject`)
- `GroupCollection` (collection `groups`, extends `SmrtCollection`)
- `GroupMember` (collection `groupmembers`, extends `SmrtObject`)
- `GroupMemberCollection` (collection `groupmembers`, extends `SmrtCollection`)
- `GroupRole` (collection `grouproles`, extends `SmrtObject`)
- `GroupRoleCollection` (collection `grouproles`, extends `SmrtCollection`)
- `LegalMember` (collection `legalmembers`, extends `SmrtObject`)
- `LegalMemberCollection` (collection `legalmembers`, extends `SmrtCollection`)
- `LegalMemberReference` (collection `legalmemberreferences`, extends `SmrtObject`)
- `LegalMemberReferenceCollection` (collection `legalmemberreferences`, extends `SmrtCollection`)
- `LegalMemberStatusHistory` (collection `legalmemberstatushistories`, extends `SmrtObject`)
- `LegalMemberStatusHistoryCollection` (collection `legalmemberstatushistories`, extends `SmrtCollection`)
- `MemberClass` (collection `memberclasses`, extends `SmrtObject`)
- `MemberClassCollection` (collection `memberclasses`, extends `SmrtCollection`)
- `MemberEligibilitySnapshot` (collection `membereligibilitysnapshots`, extends `SmrtObject`)
- `MemberEligibilitySnapshotCollection` (collection `membereligibilitysnapshots`, extends `SmrtCollection`)
- `MemberOfficerAppointment` (collection `memberofficerappointments`, extends `SmrtObject`)
- `MemberOfficerAppointmentCollection` (collection `memberofficerappointments`, extends `SmrtCollection`)
- `Membership` (collection `memberships`, extends `SmrtObject`)
- `MembershipCollection` (collection `memberships`, extends `SmrtCollection`)
- `MembershipOverride` (collection `membershipoverrides`, extends `SmrtObject`)
- `MembershipOverrideCollection` (collection `membershipoverrides`, extends `SmrtCollection`)
- `Permission` (collection `permissions`, extends `SmrtObject`)
- `PermissionCollection` (collection `permissions`, extends `SmrtCollection`)
- `ResourceGrant` (collection `resourcegrants`, extends `SmrtObject`)
- `ResourceGrantCollection` (collection `resourcegrants`, extends `SmrtCollection`)
- `Role` (collection `roles`, extends `SmrtObject`)
- `RoleCollection` (collection `roles`, extends `SmrtCollection`)
- `RolePermission` (collection `rolepermissions`, extends `SmrtObject`)
- `RolePermissionCollection` (collection `rolepermissions`, extends `SmrtCollection`)
- `Session` (collection `sessions`, extends `SmrtObject`)
- `SessionCollection` (collection `sessions`, extends `SmrtCollection`)
- `Tenant` (collection `tenants`, extends `SmrtObject`, STI table)
- `TenantCollection` (collection `tenants`, extends `SmrtCollection`)
- `TenantIntegration` (collection `tenantintegrations`, extends `SmrtObject`)
- `TenantIntegrationCollection` (collection `tenantintegrations`, extends `SmrtCollection`)
- `TenantPermissionOverride` (collection `tenantpermissionoverrides`, extends `SmrtObject`)
- `TenantPermissionOverrideCollection` (collection `tenantpermissionoverrides`, extends `SmrtCollection`)
- `User` (collection `users`, extends `SmrtObject`)
- `UserCollection` (collection `users`, extends `SmrtCollection`)
- `UsersCliAuthApproveLimit` (collection `userscliauthapprovelimits`, extends `SmrtObject`)
- `UsersCliAuthApproveLimitCollection` (collection `userscliauthapprovelimits`, extends `SmrtCollection`)
- `UsersCliAuthRequest` (collection `userscliauthrequests`, extends `SmrtObject`)
- `UsersCliAuthRequestCollection` (collection `userscliauthrequests`, extends `SmrtCollection`)
- `UsersLoginAttempt` (collection `usersloginattempts`, extends `SmrtObject`)
- `UsersLoginAttemptCollection` (collection `usersloginattempts`, extends `SmrtCollection`)
- `UsersLoginAuditEvent` (collection `usersloginauditevents`, extends `SmrtObject`)
- `UsersLoginAuditEventCollection` (collection `usersloginauditevents`, extends `SmrtCollection`)
- `UsersMagicLinkToken` (collection `usersmagiclinktokens`, extends `SmrtObject`)
- `UsersMagicLinkTokenCollection` (collection `usersmagiclinktokens`, extends `SmrtCollection`)
- `UsersOAuthAccessTokenRevocation` (collection `usersoauthaccesstokenrevocations`, extends `SmrtObject`)
- `UsersOAuthAccessTokenRevocationCollection` (collection `usersoauthaccesstokenrevocations`, extends `SmrtCollection`)
- `UsersOAuthAuthorization` (collection `usersoauthauthorizations`, extends `SmrtObject`)
- `UsersOAuthAuthorizationCode` (collection `usersoauthauthorizationcodes`, extends `SmrtObject`)
- `UsersOAuthAuthorizationCodeCollection` (collection `usersoauthauthorizationcodes`, extends `SmrtCollection`)
- `UsersOAuthAuthorizationCollection` (collection `usersoauthauthorizations`, extends `SmrtCollection`)
- `UsersOAuthClient` (collection `usersoauthclients`, extends `SmrtObject`)
- `UsersOAuthClientCollection` (collection `usersoauthclients`, extends `SmrtCollection`)
- `UsersOAuthRefreshFamily` (collection `usersoauthrefreshfamilies`, extends `SmrtObject`)
- `UsersOAuthRefreshFamilyCollection` (collection `usersoauthrefreshfamilies`, extends `SmrtCollection`)
- `UsersOAuthRefreshGrant` (collection `usersoauthrefreshgrants`, extends `SmrtObject`)
- `UsersOAuthRefreshGrantCollection` (collection `usersoauthrefreshgrants`, extends `SmrtCollection`)
- `UsersPasskeyChallenge` (collection `userspasskeychallenges`, extends `SmrtObject`)
- `UsersPasskeyChallengeCollection` (collection `userspasskeychallenges`, extends `SmrtCollection`)
- `UsersPasskeyCredential` (collection `userspasskeycredentials`, extends `SmrtObject`)
- `UsersPasskeyCredentialCollection` (collection `userspasskeycredentials`, extends `SmrtCollection`)
- `UsersPasswordCredential` (collection `userspasswordcredentials`, extends `SmrtObject`)
- `UsersPasswordCredentialCollection` (collection `userspasswordcredentials`, extends `SmrtCollection`)
- `UsersPinCredential` (collection `userspincredentials`, extends `SmrtObject`)
- `UsersPinCredentialCollection` (collection `userspincredentials`, extends `SmrtCollection`)

## MCP tools

- `group_get`: get on `@happyvertical/smrt-users:Group`
- `group_list`: list on `@happyvertical/smrt-users:Group`
- `groupmember_get`: get on `@happyvertical/smrt-users:GroupMember`
- `groupmember_list`: list on `@happyvertical/smrt-users:GroupMember`
- `grouprole_get`: get on `@happyvertical/smrt-users:GroupRole`
- `grouprole_list`: list on `@happyvertical/smrt-users:GroupRole`
- `membership_get`: get on `@happyvertical/smrt-users:Membership`
- `membership_list`: list on `@happyvertical/smrt-users:Membership`
- `membershipoverride_get`: get on `@happyvertical/smrt-users:MembershipOverride`
- `membershipoverride_list`: list on `@happyvertical/smrt-users:MembershipOverride`
- `permission_get`: get on `@happyvertical/smrt-users:Permission`
- `permission_list`: list on `@happyvertical/smrt-users:Permission`
- `role_get`: get on `@happyvertical/smrt-users:Role`
- `role_list`: list on `@happyvertical/smrt-users:Role`
- `rolepermission_get`: get on `@happyvertical/smrt-users:RolePermission`
- `rolepermission_list`: list on `@happyvertical/smrt-users:RolePermission`
- `tenant_get`: get on `@happyvertical/smrt-users:Tenant`
- `tenant_list`: list on `@happyvertical/smrt-users:Tenant`
- `tenantintegration_get`: get on `@happyvertical/smrt-users:TenantIntegration`
- `tenantintegration_list`: list on `@happyvertical/smrt-users:TenantIntegration`
- `tenantpermissionoverride_get`: get on `@happyvertical/smrt-users:TenantPermissionOverride`
- `tenantpermissionoverride_list`: list on `@happyvertical/smrt-users:TenantPermissionOverride`
- `user_get`: get on `@happyvertical/smrt-users:User`
- `user_list`: list on `@happyvertical/smrt-users:User`
