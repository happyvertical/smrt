# Helper preferences server contract

`HelperPreferencesService` is presentation policy, never an identity, persona,
tool, or authorization authority. A host creates `HelperContext` from its
authenticated request and supplies `authorize`, `resolvePolicy`, registered
`styleIds`, and `validateOffering`. Browser payloads never supply those values.

Use `createHelperProfilePreferenceStore({ db, applicationId, metafieldSlug })` only with an
already provisioned, application-scoped ProfileMetafield. The adapter checks
the context profile and tenant on every operation, fails duplicate rows, and
persists one complete versioned preference value. `clear()` writes the explicit
`{ version: 1, cleared: true }` marker. Its durable guarantee is complete
last-successful-write-wins values **only when the host serializes writes for a
profile/application across instances**; it does not offer distributed locking
or compare-and-swap. Hosts requiring either must supply their own store adapter.

The service re-resolves policy and validates saved values on each load, save,
and reset. Invalid old values produce a recoverable snapshot without silently
overwriting metadata. Owner-assigned policies ignore personal state and deny
save/reset. An offering validator must re-check saved asset ownership, tenant,
relationship, and payload before it can become effective.

When an editable policy has no valid effective helper but can preserve its
locked baseline fields while selecting an offered replacement, the snapshot
contains `recoveryDraft`. It is an edit candidate only: UI must submit it to
`save()` and wait for the returned snapshot before applying it.
