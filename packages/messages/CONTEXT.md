# Messaging context

This context covers outbound and inbound communication between SMRT actors and
people. Inter-agent coordination remains the `DispatchBus`; chat-room
conversation remains `smrt-chat`.

## Language

- **Channel**: the human communication medium (`email`, `zulip`, `telegram`,
  `sms`). It is stable across vendors.
- **Provider**: the implementation used for a channel (`smtp`, `gmail`,
  `zulip`, `telegram`, eventually `twilio`). Provider ids are registry keys.
- **Account**: tenant-owned sending identity and provider configuration. Its
  credentials are an opaque `smrt-secrets` reference.
- **Endpoint**: tenant-owned, write-only destination address for a person or
  group. Generated APIs expose metadata, never the address payload.
- **Persona route**: the permission boundary joining one `AgentPersona` to one
  account and endpoint for a named purpose. An agent never supplies account,
  endpoint, credential, or persona ids as model-controlled arguments.
- **Message**: persisted delivery record. Outbound messages record persona,
  endpoint, correlation, status, and provider result.

## Invariants

1. Channel and provider are separate fields.
2. Credential values are written through `Account.setCredentials()` and stored
   in `smrt-secrets`; public setup descriptors contain field definitions only.
   Account generated surfaces are read-only; setup writes go through
   `MessagingSettingsService`.
3. Endpoint addresses are sensitive JSON and are only returned to settings UI
   as a masked display value.
4. Account, endpoint, route, persona, and executing principal must resolve to
   the same tenant. The host supplies `resolvePersonaTenantId` to the settings
   service because `smrt-messages` intentionally has no runtime dependency on
   `smrt-personas`.
5. A route's account and endpoint must have the same channel.
6. `messages.send` gates delivery; `messages.manage-routes` gates endpoints and
   routes; `messages.manage-credentials` gates account credentials.
7. Provider additions implement the registry contract. SMS is a reserved
   channel until a concrete provider registers it.

See the system decision in
[`docs/adr/0001-persona-scoped-messaging.md`](../../docs/adr/0001-persona-scoped-messaging.md).
