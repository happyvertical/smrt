---
type: Index
title: "Developer-intent index"
description: "What to reach for in smrt before hand-rolling infrastructure, keyed by what you are about to write."
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/AGENTS.md
    path: AGENTS.md
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "AGENTS.md"
---

# Developer-intent index

Read this before writing queues, schedulers, mailers, uploaders, tenant filters, money fields, flags, audit tables, secrets handling, approvals, webhooks, search, auth, token stores or prompts. Each page names the smrt package and entry point, one verified reason not to hand-roll it, and the generated component page. The last column lists import, call and regex signals that suggest a hand-rolled equivalent.

| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |
| --- | --- | --- | --- | --- |
| Background work and retries | [background-work](/intents/background-work.md) | [smrt-jobs](/components/smrt-jobs.md), [smrt-core](/components/smrt-core.md) | `withBackgroundJobs` (`bg()`/`background()`), `SmrtJob`, `TaskRunner` | `import:bullmq`; `import:bull`; `import:bee-queue`; `import:pg-boss`; `import:kue`; `regex:FOR UPDATE SKIP LOCKED` |
| Durable inference design runs | [background-work](/intents/background-work.md) | [smrt-design-runs](/components/smrt-design-runs.md), [smrt-inference](/components/smrt-inference.md), [smrt-jobs](/components/smrt-jobs.md) | `createDesignRunJobs`, `forOwner`, `start`, `resume`, `continueAfterApproval` | `regex:installDesignRunExecutor`; `regex:authorizeRelease` |
| Scheduled and recurring runs | [scheduled-runs](/intents/scheduled-runs.md) | [smrt-jobs](/components/smrt-jobs.md), [smrt-agents](/components/smrt-agents.md) | `AgentSchedule` + `createScheduleRunner()`/`ScheduleRunner` | `import:node-cron`; `import:cron`; `import:node-schedule`; `import:agenda`; `import:croner`; `call:setInterval`; `regex:cron\.schedule\(` |
| Outbound email, SMS, chat messages | [outbound-messages](/intents/outbound-messages.md) | [smrt-messages](/components/smrt-messages.md), [smrt-tenancy](/components/smrt-tenancy.md) | `PersonaMessagingService.send()`, `EmailSender`/`SlackSender`/`TelegramSender`/`ZulipSender`, `UserNotificationService` | `import:nodemailer`; `import:@sendgrid/mail`; `import:twilio`; `import:@slack/web-api`; `import:resend`; `import:postmark`; `import:mailgun.js` |
| File and asset upload, storage backends | [file-and-asset-storage](/intents/file-and-asset-storage.md) | [smrt-assets](/components/smrt-assets.md), [smrt-assets-local](/components/smrt-assets-local.md), [smrt-assets-ergot](/components/smrt-assets-ergot.md) | `AssetStore`, `createAssetRuntime()`, `serveAsset()`/`resolveAssetForServing()` | `import:multer`; `import:busboy`; `import:formidable`; `import:@aws-sdk/client-s3` |
| Tenant scoping and cross-tenant reads | [tenant-scoping](/intents/tenant-scoping.md) | [smrt-tenancy](/components/smrt-tenancy.md), [smrt-core](/components/smrt-core.md) | `@TenantScoped` + `@tenantId`, `withTenant()`, `enableTenancy()`, `allowCrossTenant` | `regex:WHERE\s+tenant_id`; `regex:tenant_?[iI]d\s*=\s*\?`; `regex:tenantId\s*[!=]==` |
| Money, rates, confidence fields | [money-and-rates](/intents/money-and-rates.md) | [smrt-core](/components/smrt-core.md), [smrt-subscriptions](/components/smrt-subscriptions.md) | `amount = 0` (integer minor units), `rate = 0.0` (decimal), `@field({ ui: { format } })` | `regex:\.toFixed\(2\)`; `regex:price\w*\s*=\s*0\.0`; `regex:DECIMAL\(\d+,\s*2\)`; `decimal-field:*_cents`; `decimal-field:*_amount` |
| Feature flags and entitlements | [feature-flags-and-entitlements](/intents/feature-flags-and-entitlements.md) | [smrt-features](/components/smrt-features.md), [smrt-subscriptions](/components/smrt-subscriptions.md) | `FeatureResolver.isEnabled()`, `SubscriptionResolver`, `TenantUsageMeter` | `import:launchdarkly-node-server-sdk`; `import:unleash-client`; `import:flagsmith-nodejs`; `import:@growthbook/growthbook`; `regex:FEATURE_[A-Z_]+`; `regex:plan\s*===` |
| Audit trail and change feed | [audit-trail](/intents/audit-trail.md) | [smrt-core](/components/smrt-core.md), [smrt-dev-mcp](/components/smrt-dev-mcp.md) | `@smrt({ audit: true })` + `withAuditContext()`, `getChangesSince()`, `recent-changes` tool | `regex:audit_?log`; `regex:audit_?trail`; `regex:CREATE TABLE\s+\w*audit` |
| Secrets and config | [secrets-and-config](/intents/secrets-and-config.md) | [smrt-secrets](/components/smrt-secrets.md), [smrt-config](/components/smrt-config.md) | `SecretService.create()` + `store()`, `loadConfig()`, `getModuleConfig()`, `defineConfig()` | `import:dotenv`; `import:node-vault`; `import:cosmiconfig`; `import:convict`; `regex:process\.env\.\w*SECRET`; `regex:createCipheriv\(` |
| Human approval steps | [human-approvals](/intents/human-approvals.md) | [smrt-approvals](/components/smrt-approvals.md) | `ApprovalService` (`requestApproval()`, `decide()`, `consume()`), `defineApprovalKind()` | `regex:approved_by`; `regex:status\s*=\s*['"]approved['"]`; `regex:require_?[aA]pproval` |
| Inbound and outbound webhooks | [webhooks-and-events](/intents/webhooks-and-events.md) | [smrt-webhooks](/components/smrt-webhooks.md), [smrt-core](/components/smrt-core.md), [smrt-jobs](/components/smrt-jobs.md), [smrt-events](/components/smrt-events.md) | `WebhookDispatcher`, `WebhookAdminService`, `registerWebhookRuntime()`; core `createDispatchBus()` | `import:svix`; `regex:createHmac\(`; `regex:x-[a-z-]*signature` |
| Search, facts, extracted knowledge | [search-facts-knowledge](/intents/search-facts-knowledge.md) | [smrt-facts](/components/smrt-facts.md), [smrt-content](/components/smrt-content.md), [smrt-ingestion](/components/smrt-ingestion.md), [smrt-core](/components/smrt-core.md) | `FactCollection.reconcile()`, `collection.semanticSearch()`, smrt-ingestion models and `/server` services | `import:@pinecone-database/pinecone`; `import:pgvector`; `import:minisearch`; `import:flexsearch`; `import:lunr`; `regex:cosine_?[sS]imilarity` |
| Auth, users, sessions | [auth-and-users](/intents/auth-and-users.md) | [smrt-users](/components/smrt-users.md), [smrt-tenancy](/components/smrt-tenancy.md) | `SessionService`, `PasswordCredentialService`, `PermissionResolver`, `LoginAttemptLimiter`, `/sveltekit` handlers | `import:bcrypt`; `import:bcryptjs`; `import:argon2`; `import:jsonwebtoken`; `import:passport`; `import:express-session`; `import:lucia` |
| Prompts and AI operations | [prompts-and-ai-operations](/intents/prompts-and-ai-operations.md) | [smrt-prompts](/components/smrt-prompts.md), [smrt-core](/components/smrt-core.md), [smrt-agents](/components/smrt-agents.md) | `definePrompt()` + `resolvePrompt()`, `PromptOverrideService`, `@smrt({ ai: { callable } })`, `SmrtObject.is()/do()/describe()` | `import:openai`; `import:@anthropic-ai/sdk`; `import:langchain`; `regex:You are an? [a-z ]+`; `regex:role:\s*['"]system['"]` |
| Polymorphic links, junctions, trees | [relationships-and-trees](/intents/relationships-and-trees.md) | [smrt-core](/components/smrt-core.md) | `SmrtJunction`/`SmrtJunctionBase`, `SmrtHierarchical`, `SmrtPolymorphicAssociation` | `regex:parent_?[iI]d\s*[:=]`; `regex:WITH RECURSIVE`; `regex:entity_?type` |
| Local credentials, device tokens and owner sign-in | [local-credentials-and-owner-signin](/intents/local-credentials-and-owner-signin.md) | [smrt-app-runtime](/components/smrt-app-runtime.md), [smrt-users](/components/smrt-users.md) | `openLocalMcpTokenStore()` (`smrt app token`), `claimOwner()` with the loopback `/setup` URL, `SessionService` | `import:keytar`; `import:@napi-rs/keyring`; `regex:security add-generic-password`; `regex:homedir\(\).*(token\|credential)s?[\w.-]*\.json`; `regex:~/\.[\w./-]*(token\|credential)`; `regex:expiresIn\s*:\s*['"]\d+\s*[smhd]['"]` |
