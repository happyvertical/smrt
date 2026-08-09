# @happyvertical/smrt-fields

`@happyvertical/smrt-fields` lets an application adjust an object's form
defaults, labels, help, order, visibility, and locks without changing the
object's source. Policies layer organization and personal choices over the
code-authored field definition.

For the complete application and operator guide, see the
[field policy guide](https://happyvertical.github.io/smrt/field-policies).

## Install

```bash
pnpm add @happyvertical/smrt-fields
```

The package includes `@happyvertical/smrt-users` because policy writes and
operator actions use its permission and tenant context services.

## Define a safe code seed

The decorated model remains the definition of a field. Use its description
and `ui` hints to supply a useful first form before any policy row exists.

```typescript
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ packageName: '@acme/billing' })
export class Invoice extends SmrtObject {
  @field({
    required: true,
    description: 'Shown on the customer invoice.',
    ui: { basic: true, group: 'billing', order: 1 },
  })
  title = '';

  @field({ ui: { basic: false, group: 'billing', order: 2 } })
  internalNotes = '';
}
```

If no field has `ui.basic: true`, fields start in the basic view. Once at
least one field is marked basic, unmarked fields start advanced. `group` and
`order` are code-owned hints; `locked: true` seeds a lock that can prevent a
personal override.

## Resolve on the server

Use the resolver in trusted server code when rendering SSR or applying a
server-owned workflow. It merges code → app → tenant ancestry → user.

```typescript
import { resolveFieldPolicy } from '@happyvertical/smrt-fields';

const policy = await resolveFieldPolicy(
  '@acme/billing:Invoice',
  { tenantId: requestTenant.id, userId: session.user.id, db },
);

const title = policy.fields.title;
```

The client-facing generated `resolveBatch` action derives the tenant and user
from the authenticated request context. Do not accept those identifiers from a
browser request. It returns only fields that are safe to expose; sensitive,
transient, and read-permission-gated fields are omitted.

## Use policy-aware Svelte forms

For a custom form, provide a resolved policy with `FieldPolicyProvider` and
wrap each input in `PolicyField`. The wrapper applies visibility, labels, help,
and new-record defaults while preserving your markup and input component.

```svelte
<script lang="ts">
  import {
    FieldPolicyProvider,
    PolicyField,
  } from '@happyvertical/smrt-fields/svelte';

  let { policy, invoice = $bindable({}) } = $props();
</script>

<FieldPolicyProvider {policy}>
  <PolicyField name="title">
    <input id="title" bind:value={invoice.title} />
  </PolicyField>
</FieldPolicyProvider>
```

For generated forms, register the application's generated collection
definitions once in an `ObjectFormSourceRegistry`, place it in an
`ObjectFormSourceProvider`, then render an `ObjectForm` by canonical
`objectRef`. The registry validates both the generated field definition and
the `resolveBatch` response before rendering. See the guide for the complete
setup, including field-specific input renderers and policy-aware tables.

## Administration and personal settings

Use `FieldPolicyGearProvider` with an adapter to the generated
`getEditorState`, create, update, and delete actions. It derives identity on
the server; adapter methods intentionally do not accept tenant or user ids.
Use `FieldPolicyGearButton` or `showPolicyGear` on `ObjectForm` to expose
the editor.

For a settings destination, the server builds data with
`buildFieldPolicySettingsCatalog()` and the browser renders it through
`FieldPolicyControlPanel`. Hosts supply route, transport, confirmation, and
AdminShell adapters. `fieldPolicyControlPanelNavItem()` and
`registerFieldPolicyFocusTool()` are structural seams, so Fields does not
take a dependency on a particular application shell.

`fields.policy.manage` permits app and tenant administration.
`fields.policy.personalize` permits only the current user's personal choices.
The host must still establish a trusted authenticated principal context and
enforce the route permission before rendering an operator destination.

## Important behavior

- A policy row is sparse: `null` means inherit the lower layer. Delete a row
  to reset that scope completely.
- `defaultValue` is the JSON-encoded wire channel. Server code with a plain
  value should use `defaultValueRaw` or `setDefaultValue()`.
- Required fields cannot be hidden or moved to advanced without a usable
  resolved default. Resolution forces a required, default-less field back to
  basic as a safety net.
- App and tenant rows may lock a field. While the resolved organization policy
  is locked, personal writes are rejected and old personal rows do not apply.
- Defaults are rejected for sensitive, transient, and read-permission-gated
  fields. Reference defaults must use a valid UUID unless that reference
  declares a text id type.

## Usage learning

Optional usage capture records bounded, aggregated submissions from
authenticated tenant members and turns qualified patterns into
administrator-reviewed tenant-policy suggestions. It never auto-applies a
suggestion. `ObjectForm` reports only after its host confirms persistence;
browser values transit only for low-cardinality boolean and reference fields,
and telemetry failures never affect the saved submit.

Operators enable the dormant maintenance and suggestion schedules explicitly
with `ensureFieldUsageLearningSchedules({ db })`. The learning loop retains
aggregates and uses conservative thresholds; its accepted/dismissed suggestion
queue is restricted to `fields.policy.manage`. See the
[field policy guide](https://happyvertical.github.io/smrt/field-policies#usage-learning-and-suggestions)
for the capture, privacy, retention, and schedule contract.

## Example application

The [SMRT SaaS starter field-policy walkthrough](https://github.com/happyvertical/smrt-saas-starter/pull/51)
uses SMRT `0.40.61` and shows the owner/admin controls and the member-facing
personal form flow in a working application.
