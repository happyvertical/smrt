---
type: "Component"
title: "@happyvertical/smrt-messages"
description: "Unified multi-channel messaging with STI-based hierarchies"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:daef08363674da93e920342a62859d34eda6cdb76749e31f6ddfb82c8eaf04f8"
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
---

# @happyvertical/smrt-messages

## Package

- Directory: `packages/messages`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/messages/AGENTS.md`
- `packages/messages/agents/notification-outbox.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-ledgers](/components/smrt-ledgers.md)
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

- `create_accounts`: create on `@happyvertical/smrt-messages:AccountCollection`
- `create_accounts`: create on `@happyvertical/smrt-messages:EmailAccountCollection`
- `create_attachments`: create on `@happyvertical/smrt-messages:AttachmentCollection`
- `create_blacklists`: create on `@happyvertical/smrt-messages:Blacklist`
- `create_blacklists`: create on `@happyvertical/smrt-messages:BlacklistCollection`
- `create_emailattachments`: create on `@happyvertical/smrt-messages:EmailAttachment`
- `create_emailattachments`: create on `@happyvertical/smrt-messages:EmailAttachmentCollection`
- `create_emailfolders`: create on `@happyvertical/smrt-messages:EmailFolderCollection`
- `create_messages`: create on `@happyvertical/smrt-messages:EmailCollection`
- `create_messages`: create on `@happyvertical/smrt-messages:MessageCollection`
- `create_messagingendpoints`: create on `@happyvertical/smrt-messages:MessagingEndpointCollection`
- `create_personamessageroutes`: create on `@happyvertical/smrt-messages:PersonaMessageRouteCollection`
- `create_whitelists`: create on `@happyvertical/smrt-messages:Whitelist`
- `create_whitelists`: create on `@happyvertical/smrt-messages:WhitelistCollection`
- `delete_accounts`: delete on `@happyvertical/smrt-messages:AccountCollection`
- `delete_accounts`: delete on `@happyvertical/smrt-messages:EmailAccountCollection`
- `delete_attachments`: delete on `@happyvertical/smrt-messages:AttachmentCollection`
- `delete_blacklists`: delete on `@happyvertical/smrt-messages:Blacklist`
- `delete_blacklists`: delete on `@happyvertical/smrt-messages:BlacklistCollection`
- `delete_emailattachments`: delete on `@happyvertical/smrt-messages:EmailAttachment`
- `delete_emailattachments`: delete on `@happyvertical/smrt-messages:EmailAttachmentCollection`
- `delete_emailfolders`: delete on `@happyvertical/smrt-messages:EmailFolderCollection`
- `delete_messages`: delete on `@happyvertical/smrt-messages:EmailCollection`
- `delete_messages`: delete on `@happyvertical/smrt-messages:MessageCollection`
- `delete_messagingendpoints`: delete on `@happyvertical/smrt-messages:MessagingEndpointCollection`
- `delete_personamessageroutes`: delete on `@happyvertical/smrt-messages:PersonaMessageRouteCollection`
- `delete_whitelists`: delete on `@happyvertical/smrt-messages:Whitelist`
- `delete_whitelists`: delete on `@happyvertical/smrt-messages:WhitelistCollection`
- `get_accounts`: get on `@happyvertical/smrt-messages:Account`
- `get_accounts`: get on `@happyvertical/smrt-messages:AccountCollection`
- `get_accounts`: get on `@happyvertical/smrt-messages:EmailAccount`
- `get_accounts`: get on `@happyvertical/smrt-messages:EmailAccountCollection`
- `get_accounts`: get on `@happyvertical/smrt-messages:SlackAccount`
- `get_accounts`: get on `@happyvertical/smrt-messages:TelegramAccount`
- `get_accounts`: get on `@happyvertical/smrt-messages:TwitterAccount`
- `get_accounts`: get on `@happyvertical/smrt-messages:ZulipAccount`
- `get_attachments`: get on `@happyvertical/smrt-messages:Attachment`
- `get_attachments`: get on `@happyvertical/smrt-messages:AttachmentCollection`
- `get_blacklists`: get on `@happyvertical/smrt-messages:Blacklist`
- `get_blacklists`: get on `@happyvertical/smrt-messages:BlacklistCollection`
- `get_emailattachments`: get on `@happyvertical/smrt-messages:EmailAttachment`
- `get_emailattachments`: get on `@happyvertical/smrt-messages:EmailAttachmentCollection`
- `get_emailfolders`: get on `@happyvertical/smrt-messages:EmailFolder`
- `get_emailfolders`: get on `@happyvertical/smrt-messages:EmailFolderCollection`
- `get_messages`: get on `@happyvertical/smrt-messages:Email`
- `get_messages`: get on `@happyvertical/smrt-messages:EmailCollection`
- `get_messages`: get on `@happyvertical/smrt-messages:Message`
- `get_messages`: get on `@happyvertical/smrt-messages:MessageCollection`
- `get_messages`: get on `@happyvertical/smrt-messages:SlackMessage`
- `get_messages`: get on `@happyvertical/smrt-messages:Tweet`
- `get_messagingendpoints`: get on `@happyvertical/smrt-messages:MessagingEndpoint`
- `get_messagingendpoints`: get on `@happyvertical/smrt-messages:MessagingEndpointCollection`
- `get_personamessageroutes`: get on `@happyvertical/smrt-messages:PersonaMessageRoute`
- `get_personamessageroutes`: get on `@happyvertical/smrt-messages:PersonaMessageRouteCollection`
- `get_whitelists`: get on `@happyvertical/smrt-messages:Whitelist`
- `get_whitelists`: get on `@happyvertical/smrt-messages:WhitelistCollection`
- `list_accounts`: list on `@happyvertical/smrt-messages:Account`
- `list_accounts`: list on `@happyvertical/smrt-messages:AccountCollection`
- `list_accounts`: list on `@happyvertical/smrt-messages:EmailAccount`
- `list_accounts`: list on `@happyvertical/smrt-messages:EmailAccountCollection`
- `list_accounts`: list on `@happyvertical/smrt-messages:SlackAccount`
- `list_accounts`: list on `@happyvertical/smrt-messages:TelegramAccount`
- `list_accounts`: list on `@happyvertical/smrt-messages:TwitterAccount`
- `list_accounts`: list on `@happyvertical/smrt-messages:ZulipAccount`
- `list_attachments`: list on `@happyvertical/smrt-messages:Attachment`
- `list_attachments`: list on `@happyvertical/smrt-messages:AttachmentCollection`
- `list_blacklists`: list on `@happyvertical/smrt-messages:Blacklist`
- `list_blacklists`: list on `@happyvertical/smrt-messages:BlacklistCollection`
- `list_emailattachments`: list on `@happyvertical/smrt-messages:EmailAttachment`
- `list_emailattachments`: list on `@happyvertical/smrt-messages:EmailAttachmentCollection`
- `list_emailfolders`: list on `@happyvertical/smrt-messages:EmailFolder`
- `list_emailfolders`: list on `@happyvertical/smrt-messages:EmailFolderCollection`
- `list_messages`: list on `@happyvertical/smrt-messages:Email`
- `list_messages`: list on `@happyvertical/smrt-messages:EmailCollection`
- `list_messages`: list on `@happyvertical/smrt-messages:Message`
- `list_messages`: list on `@happyvertical/smrt-messages:MessageCollection`
- `list_messages`: list on `@happyvertical/smrt-messages:SlackMessage`
- `list_messages`: list on `@happyvertical/smrt-messages:Tweet`
- `list_messagingendpoints`: list on `@happyvertical/smrt-messages:MessagingEndpoint`
- `list_messagingendpoints`: list on `@happyvertical/smrt-messages:MessagingEndpointCollection`
- `list_personamessageroutes`: list on `@happyvertical/smrt-messages:PersonaMessageRoute`
- `list_personamessageroutes`: list on `@happyvertical/smrt-messages:PersonaMessageRouteCollection`
- `list_whitelists`: list on `@happyvertical/smrt-messages:Whitelist`
- `list_whitelists`: list on `@happyvertical/smrt-messages:WhitelistCollection`
- `update_accounts`: update on `@happyvertical/smrt-messages:AccountCollection`
- `update_accounts`: update on `@happyvertical/smrt-messages:EmailAccountCollection`
- `update_attachments`: update on `@happyvertical/smrt-messages:AttachmentCollection`
- `update_blacklists`: update on `@happyvertical/smrt-messages:Blacklist`
- `update_blacklists`: update on `@happyvertical/smrt-messages:BlacklistCollection`
- `update_emailattachments`: update on `@happyvertical/smrt-messages:EmailAttachment`
- `update_emailattachments`: update on `@happyvertical/smrt-messages:EmailAttachmentCollection`
- `update_emailfolders`: update on `@happyvertical/smrt-messages:EmailFolderCollection`
- `update_messages`: update on `@happyvertical/smrt-messages:EmailCollection`
- `update_messages`: update on `@happyvertical/smrt-messages:MessageCollection`
- `update_messagingendpoints`: update on `@happyvertical/smrt-messages:MessagingEndpointCollection`
- `update_personamessageroutes`: update on `@happyvertical/smrt-messages:PersonaMessageRouteCollection`
- `update_whitelists`: update on `@happyvertical/smrt-messages:Whitelist`
- `update_whitelists`: update on `@happyvertical/smrt-messages:WhitelistCollection`
