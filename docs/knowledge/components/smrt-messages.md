---
type: "Component"
title: "@happyvertical/smrt-messages"
description: "Unified multi-channel messaging with STI-based hierarchies"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T12:20:01Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:daecc7b8b53b9fa44d951b5204d887468c9b08a84b61fe91e467dae67a1202ad"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/messages/package.json"
    title: "@happyvertical/smrt-messages package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/messages/AGENTS.md"
    title: "@happyvertical/smrt-messages packages/messages/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/messages/agents/notification-outbox.md"
    title: "@happyvertical/smrt-messages packages/messages/agents/notification-outbox.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/messages/agents/profile-recipients.md"
    title: "@happyvertical/smrt-messages packages/messages/agents/profile-recipients.md"
---

# @happyvertical/smrt-messages

## Package

- Directory: `packages/messages`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/messages/AGENTS.md`
- `packages/messages/agents/notification-outbox.md`
- `packages/messages/agents/profile-recipients.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-ledgers](/components/smrt-ledgers.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/email`
- `@happyvertical/encryption`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/messages`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./providers/all`
- `./providers/email`
- `./providers/slack`
- `./providers/twitter`
- `./svelte`
- `./ui`

## Models

- `Account` (collection `accounts`, extends `SmrtObject`, STI table)
- `AccountCollection` (collection `accounts`, extends `SmrtCollection`)
- `Attachment` (collection `attachments`, extends `SmrtObject`)
- `AttachmentCollection` (collection `attachments`, extends `SmrtCollection`)
- `Blacklist` (collection `blacklists`, extends `SmrtObject`)
- `BlacklistCollection` (collection `blacklists`, extends `SmrtCollection`)
- `Email` (collection `messages`, extends `Message`, STI table)
- `EmailAccount` (collection `accounts`, extends `Account`, STI table)
- `EmailAccountCollection` (collection `accounts`, extends `AccountCollection`)
- `EmailAttachment` (collection `emailattachments`, extends `Attachment`)
- `EmailAttachmentCollection` (collection `emailattachments`, extends `AttachmentCollection`)
- `EmailCollection` (collection `messages`, extends `MessageCollection`)
- `EmailFolder` (collection `emailfolders`, extends `SmrtObject`)
- `EmailFolderCollection` (collection `emailfolders`, extends `SmrtCollection`)
- `Message` (collection `messages`, extends `SmrtObject`, STI table)
- `MessageCollection` (collection `messages`, extends `SmrtCollection`)
- `MessagingEndpoint` (collection `messagingendpoints`, extends `SmrtObject`)
- `MessagingEndpointCollection` (collection `messagingendpoints`, extends `SmrtCollection`)
- `NotificationDelivery` (collection `notificationdeliveries`, extends `SmrtObject`)
- `NotificationDeliveryCollection` (collection `notificationdeliveries`, extends `SmrtCollection`)
- `NotificationOptOut` (collection `notificationoptouts`, extends `SmrtObject`)
- `NotificationOptOutCollection` (collection `notificationoptouts`, extends `SmrtCollection`)
- `PersonaMessageRoute` (collection `personamessageroutes`, extends `SmrtObject`)
- `PersonaMessageRouteCollection` (collection `personamessageroutes`, extends `SmrtCollection`)
- `SlackAccount` (collection `accounts`, extends `Account`, STI table)
- `SlackMessage` (collection `messages`, extends `Message`, STI table)
- `TelegramAccount` (collection `accounts`, extends `Account`, STI table)
- `Tweet` (collection `messages`, extends `Message`, STI table)
- `TwitterAccount` (collection `accounts`, extends `Account`, STI table)
- `UserNotification` (collection `usernotifications`, extends `SmrtObject`)
- `UserNotificationCollection` (collection `usernotifications`, extends `SmrtCollection`)
- `Whitelist` (collection `whitelists`, extends `SmrtObject`)
- `WhitelistCollection` (collection `whitelists`, extends `SmrtCollection`)
- `ZulipAccount` (collection `accounts`, extends `Account`, STI table)

## MCP tools

- `account_get`: get on `@happyvertical/smrt-messages:Account`
- `account_list`: list on `@happyvertical/smrt-messages:Account`
- `attachment_get`: get on `@happyvertical/smrt-messages:Attachment`
- `attachment_list`: list on `@happyvertical/smrt-messages:Attachment`
- `blacklist_create`: create on `@happyvertical/smrt-messages:Blacklist`
- `blacklist_delete`: delete on `@happyvertical/smrt-messages:Blacklist`
- `blacklist_get`: get on `@happyvertical/smrt-messages:Blacklist`
- `blacklist_list`: list on `@happyvertical/smrt-messages:Blacklist`
- `blacklist_matches`: matches on `@happyvertical/smrt-messages:Blacklist`
- `blacklist_update`: update on `@happyvertical/smrt-messages:Blacklist`
- `blacklistcollection_getmatchingentry`: getMatchingEntry on `@happyvertical/smrt-messages:BlacklistCollection`
- `blacklistcollection_isblacklisted`: isBlacklisted on `@happyvertical/smrt-messages:BlacklistCollection`
- `email_get`: get on `@happyvertical/smrt-messages:Email`
- `email_list`: list on `@happyvertical/smrt-messages:Email`
- `emailaccount_get`: get on `@happyvertical/smrt-messages:EmailAccount`
- `emailaccount_list`: list on `@happyvertical/smrt-messages:EmailAccount`
- `emailattachment_get`: get on `@happyvertical/smrt-messages:EmailAttachment`
- `emailattachment_list`: list on `@happyvertical/smrt-messages:EmailAttachment`
- `emailfolder_get`: get on `@happyvertical/smrt-messages:EmailFolder`
- `emailfolder_list`: list on `@happyvertical/smrt-messages:EmailFolder`
- `message_get`: get on `@happyvertical/smrt-messages:Message`
- `message_list`: list on `@happyvertical/smrt-messages:Message`
- `messagingendpoint_get`: get on `@happyvertical/smrt-messages:MessagingEndpoint`
- `messagingendpoint_list`: list on `@happyvertical/smrt-messages:MessagingEndpoint`
- `personamessageroute_get`: get on `@happyvertical/smrt-messages:PersonaMessageRoute`
- `personamessageroute_list`: list on `@happyvertical/smrt-messages:PersonaMessageRoute`
- `slackaccount_get`: get on `@happyvertical/smrt-messages:SlackAccount`
- `slackaccount_list`: list on `@happyvertical/smrt-messages:SlackAccount`
- `slackmessage_get`: get on `@happyvertical/smrt-messages:SlackMessage`
- `slackmessage_list`: list on `@happyvertical/smrt-messages:SlackMessage`
- `telegramaccount_get`: get on `@happyvertical/smrt-messages:TelegramAccount`
- `telegramaccount_list`: list on `@happyvertical/smrt-messages:TelegramAccount`
- `tweet_get`: get on `@happyvertical/smrt-messages:Tweet`
- `tweet_list`: list on `@happyvertical/smrt-messages:Tweet`
- `twitteraccount_get`: get on `@happyvertical/smrt-messages:TwitterAccount`
- `twitteraccount_list`: list on `@happyvertical/smrt-messages:TwitterAccount`
- `whitelist_create`: create on `@happyvertical/smrt-messages:Whitelist`
- `whitelist_delete`: delete on `@happyvertical/smrt-messages:Whitelist`
- `whitelist_get`: get on `@happyvertical/smrt-messages:Whitelist`
- `whitelist_list`: list on `@happyvertical/smrt-messages:Whitelist`
- `whitelist_matches`: matches on `@happyvertical/smrt-messages:Whitelist`
- `whitelist_update`: update on `@happyvertical/smrt-messages:Whitelist`
- `whitelistcollection_getbycategory`: getByCategory on `@happyvertical/smrt-messages:WhitelistCollection`
- `whitelistcollection_getmatchingentry`: getMatchingEntry on `@happyvertical/smrt-messages:WhitelistCollection`
- `whitelistcollection_iswhitelisted`: isWhitelisted on `@happyvertical/smrt-messages:WhitelistCollection`
- `zulipaccount_get`: get on `@happyvertical/smrt-messages:ZulipAccount`
- `zulipaccount_list`: list on `@happyvertical/smrt-messages:ZulipAccount`
