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

## Svelte helper controls

`HelperControlPanel` distinguishes a local draft from the applied server
snapshot. Selecting a gallery item, changing a control, or completing photo
setup creates an unsaved draft; only the snapshot returned by `save()` is
applied through `onchanged`. Photo setup returns to the settings panel, selects
the newly returned offering in the draft, and restores focus to its gallery
choice so the next action is explicit: **Save changes**.

Gallery choices use roving radio keyboard behavior (Arrow keys, Home, End).
Hosts should provide distinct safe offering labels, such as a user-provided
name with a saved timestamp, rather than raw duplicate filenames.

`FloatingAssistant` accepts an optional bottom-corner placement. Conversation
hosts pass the effective saved placement to keep the dock with its selected
helper. Opening listening mode may reveal the existing assistant surface, but
must never start microphone capture or audio playback; those remain explicit
user actions.

`FloatingAssistant.hideIdleControls` is opt-in and defaults to false for existing hosts.
The character listening workbench enables it to hide idle controls chrome while
keeping active runs, errors and confirmation surfaces reachable.
