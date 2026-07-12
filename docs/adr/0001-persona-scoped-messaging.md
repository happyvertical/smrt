# ADR 0001: Persona-scoped messaging and settings

- Status: accepted
- Date: 2026-07-10

## Context

SMRT already had email, Slack, and Twitter account/message STI models, encrypted
account credentials, persona identity, principal execution, and custom agent UI
slots. It did not have a durable relationship between a persona, its sending
credentials, and a user's destination; nor a safe agent tool or a generic
settings contract. Adding Zulip, Telegram, and later SMS independently would
otherwise repeat those decisions and expose provider details to agents.

## Decision

Use `AgentPersona.id` as the durable owner id for persona settings while
retaining `Agent.id` as the legacy owner for non-persona agents. Runtime
`instanceKey` remains an execution concern and may be null for a default
persona; it is not the settings identity.

Represent human messaging as:

```text
AgentPersona -> PersonaMessageRoute -> Account
                              \-----> MessagingEndpoint
Account -> smrt-secrets credential payload
Message -> persona + account + endpoint + delivery lifecycle
```

`Account` owns a tenant's sending identity, non-secret provider configuration,
and an opaque secret reference. `MessagingEndpoint` owns a write-only
provider-specific destination. `PersonaMessageRoute` authorizes a persona to
use one account/end-point pair for a named purpose and priority. Accounts may be
deliberately reused, but every persona gets explicit routes and cannot discover
or select unbound accounts.

Separate the stable channel from the provider implementation. Providers
register public configuration, credential, and endpoint field schemas plus an
optional sender factory. Credential values are never part of descriptors.
Email, Zulip, and Telegram are available providers; SMS is a reserved channel
whose first concrete provider can be added without changing the route model.

Offer agents a `messages.send` `PrincipalTool` fixed to a persona by trusted
server code. The model may supply body, subject, channel, and purpose only.
Delivery also requires the executing principal to hold `messages.send`.
Management uses the independent `messages.manage-routes` and
`messages.manage-credentials` permissions.

The messaging package does not depend back on personas. Its settings service
therefore requires a host-supplied `resolvePersonaTenantId` boundary and refuses
to save a route unless that resolver proves same-tenant persona ownership.

For app settings, an agent UI slot may provide a versioned `settingsSchema` and
`scope` (`agent` or `persona`). Hosts render the generic
`AgentSettingsForm` unless a custom component is registered. Messaging uses a
specialized but provider-schema-driven `MessagingSettingsPanel` because it must
preserve write-only credential and address semantics.

Within a settings slot, database values override deployment/file defaults.
`scope: 'persona'` selects `AgentOptions.personaId`; `scope: 'agent'` selects the
persisted Agent row id. An unspecified scope preserves backward-compatible
automatic behavior (persona id when present, otherwise Agent id). Trusted run
configuration may layer above settings but must not widen the live principal's
RBAC or the persona's allowed-tool ceiling.

## Consequences

- Existing singleton agents retain their Agent-row configuration identity.
- A default persona can keep a null `instanceKey` without losing its settings.
- Adding a provider does not require a new route or settings model.
- Credentials and destination values require server callbacks; generated read
  APIs deliberately cannot round-trip them.
- Delivery is persisted before the provider call and uses the existing message
  send/retry lifecycle. Queue scheduling can wrap the same service later.
