# Synthetic intent index (test fixture)

| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |
| --- | --- | --- | --- | --- |
| Background work and retries | [background-work](/intents/background-work.md) | [smrt-jobs](/components/smrt-jobs.md), [smrt-core](/components/smrt-core.md) | `withBackgroundJobs` | `import:bullmq`; `import:bee-queue`; `regex:FOR UPDATE SKIP LOCKED` |
| Scheduled and recurring runs | [scheduled-runs](/intents/scheduled-runs.md) | [smrt-jobs](/components/smrt-jobs.md), [smrt-agents](/components/smrt-agents.md) | `AgentSchedule` | `import:node-cron`; `call:setInterval`; `regex:cron\.schedule\(` |
| Outbound email, SMS, chat messages | [outbound-messages](/intents/outbound-messages.md) | [smrt-messages](/components/smrt-messages.md) | `PersonaMessagingService.send()` | `import:nodemailer`; `import:@sendgrid/mail` |
| Local credentials, device tokens and owner sign-in | [local-credentials-and-owner-signin](/intents/local-credentials-and-owner-signin.md) | [smrt-app-runtime](/components/smrt-app-runtime.md), [smrt-users](/components/smrt-users.md) | `openLocalMcpTokenStore()` (`smrt app token`), `claimOwner()` with the loopback `/setup` URL, `SessionService` | `import:keytar`; `import:@napi-rs/keyring`; `regex:security add-generic-password`; `regex:homedir\(\).*(token\|credential)s?[\w.-]*\.json`; `regex:~/\.[\w./-]*(token\|credential)`; `regex:expiresIn\s*:\s*['"]\d+\s*[smhd]['"]` |
