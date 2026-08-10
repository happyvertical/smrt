---
id: field-policies
title: Field policy
sidebar_label: Field policy
---

# Field policy

Field policy lets an application adapt a form to an organization and to an
individual without changing the source model. It resolves a stable,
browser-safe field policy from the model’s code seed and sparse overrides.

Use it when the domain model is shared but the form should vary by tenant or
person: an organization may make a field advanced, set a default, change its
help text, or lock that choice; a member may then personalize only the fields
the organization leaves available.

## What is resolved

A resolved field contains:

- a default value, when one exists;
- a visibility tier: <code>basic</code>, <code>advanced</code>, or <code>hidden</code>;
- label, help, order, group, and lock state; and
- the field’s required state.

Resolution is low to high priority:

| Layer | Intended owner |
| --- | --- |
| Code seed | Application developer |
| App policy | Platform administrator |
| Tenant policy, from ancestor to current tenant | Organization administrator |
| User policy | Signed-in member |

A higher layer changes only the values it supplies. A <code>null</code> column on a policy
row inherits the lower value. Deleting a row resets that scope completely, so
future lower-layer changes flow through again.

## Start with the model

The model is still the authoritative field definition. Fields must be present
in the live object registry to be policy-addressable. Add clear descriptions
and UI hints where the model is declared:

~~~typescript
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ packageName: '@acme/billing' })
export class Invoice extends SmrtObject {
  @field({
    required: true,
    description: 'Shown on the customer invoice.',
    ui: { basic: true, group: 'billing', order: 1 },
  })
  title = '';

  @field({
    description: 'Visible only to invoice staff.',
    ui: { basic: false, group: 'billing', order: 2 },
  })
  internalNotes = '';
}
~~~

The seed has a few useful rules:

- With no <code>ui.basic: true</code> marker, every field initially appears in the basic
  view. Once any field is marked basic, unmarked fields initially become
  advanced. <code>basic: false</code> explicitly makes a field advanced.
- <code>description</code> seeds help text. <code>ui.group</code> and <code>ui.order</code> organize the form.
- <code>ui.locked: true</code> seeds an organization lock. App or tenant policy can
  subsequently set its effective lock state.
- A required field cannot resolve to <code>advanced</code> or <code>hidden</code> unless it has a
  usable default. The resolver forces a required, default-less field back to
  basic as a final safety net.

Code owns the definition, type, and security classification. Policy does not
make a system field, relationship pseudo-field, transient field, sensitive
field, or read-permission-gated field editable.

## Resolve in trusted server code

Use <code>resolveFieldPolicy()</code> where the server needs to render or apply an
effective policy. Server code can pass its already-authenticated tenant and
user identity explicitly:

~~~typescript
import { resolveFieldPolicy } from '@happyvertical/smrt-fields';

const policy = await resolveFieldPolicy(
  '@acme/billing:Invoice',
  {
    tenantId: requestTenant.id,
    userId: session.user.id,
    db,
  },
);

if (policy.fields.internalNotes.visibility === 'advanced') {
  // Render it behind the form’s advanced disclosure.
}
~~~

<code>resolveFieldPolicyExplained()</code> additionally returns the ordered
contributions used by the gear and settings UI. Use that result for an audit or
explanation instead of reimplementing precedence in an application.

The generated browser action is <code>resolveBatch({ objectRefs })</code>. It derives
the tenant and user solely from the authenticated ambient request context; the
request body cannot choose another identity. A host should pass only canonical
object refs it registered for that application—not arbitrary request input—and
keep the generated definition registry as its allowlist.

## Policy writes and reset

Policy rows are deliberately sparse. Each row identifies one object field and
one scope, and may provide any combination of default, visibility, help,
label, order, and lock. Use server code or generated actions within an
established authenticated tenancy context; a client must never send a target
tenant or user id.

~~~typescript
import { FieldPolicyCollection } from '@happyvertical/smrt-fields';

// Run inside a trusted tenant context for the administrator.
// The context supplies the tenant and principal attribution.
const policies = await FieldPolicyCollection.create({ db });

await policies.create({
  objectRef: '@acme/billing:Invoice',
  fieldName: 'internalNotes',
  scopeType: 'tenant',
  visibility: 'advanced',
  defaultValueRaw: 'Not visible to customers',
});
~~~

Use <code>defaultValueRaw</code> when calling server APIs with a normal JavaScript
value. The <code>defaultValue</code> property is the JSON-encoded wire channel, so a
string must be encoded (for example, <code>JSON.stringify('Net 30')</code>). The
browser gear handles this serialization for its generated write adapter.

To reset the whole customization at a scope, delete that scope’s row. To keep a
row while returning one property to the lower layer, set that property to
<code>null</code>.

### Permissions and scope

There are two permission slugs:

| Permission | Grants |
| --- | --- |
| <code>fields.policy.manage</code> | App- and tenant-scope policy administration |
| <code>fields.policy.personalize</code> | The current user’s user-scope policy only |

Permission is not a cross-scope selector. A tenant-context caller can operate
only in its own tenant, and a user policy always belongs to the current user.
A service or API-key context without a user identity cannot read or write the
personal tier. No ambient identity means writes fail closed. Hosts should
install and verify their authenticated principal-context middleware before
exposing generated Field Policy routes.

App and tenant scopes may set <code>locked</code>; the user scope may not. When an
organization lock resolves true, personal writes are rejected and existing
personal overrides are skipped. This is why a member’s form may change after an
administrator updates a policy.

## Headless Svelte adoption

The Svelte package is intentionally headless. A custom form owns layout and
controls while <code>FieldPolicyProvider</code> supplies resolved state and
<code>PolicyField</code> supplies policy behavior:

~~~svelte
<script lang="ts">
  import {
    FieldPolicyProvider,
    ModeSwitch,
    PolicyField,
  } from '@happyvertical/smrt-fields/svelte';

  let { policy, invoice = $bindable({}) } = $props();
</script>

<FieldPolicyProvider {policy}>
  <ModeSwitch />

  <PolicyField name="title">
    <input id="title" bind:value={invoice.title} />
  </PolicyField>

  <PolicyField name="internalNotes">
    <textarea id="internalNotes" bind:value={invoice.internalNotes}></textarea>
  </PolicyField>
</FieldPolicyProvider>
~~~

<code>PolicyField</code> applies labels, help, required state, basic/advanced visibility,
and defaults for new records. It does not overwrite a loaded record or a value
the user cleared. Outside a provider it degrades to rendering its children, so
an application can adopt it incrementally. Use its <code>render</code> snippet when a
custom layout needs the resolved field data directly.

### Provider-only compositions

Three optional compositions layer over the same form. <code>ModeSwitch</code>
toggles basic and advanced. <code>AdvancedFields</code> collapses advanced-tier
fields into a disclosure. <code>FormHelp</code> is a help toggle that lists the
object description and every visible field's label and help text, assembled from
the resolved policy and filtered by the current mode.

~~~svelte
<script lang="ts">
  import {
    FieldPolicyProvider,
    FormHelp,
    ModeSwitch,
    PolicyField,
  } from '@happyvertical/smrt-fields/svelte';

  let { policy, invoice = $bindable({}) } = $props();
</script>

<FieldPolicyProvider {policy}>
  <header>
    <h2>Invoice</h2>
    <FormHelp objectDescription="An invoice issued to a customer." />
  </header>

  <ModeSwitch />

  <PolicyField name="title">
    <input id="title" bind:value={invoice.title} />
  </PolicyField>
</FieldPolicyProvider>
~~~

Unlike <code>PolicyField</code>, these three do not degrade outside a provider. Each
derives its whole output from the resolved policy, so outside one they raise an
error naming <code>FieldPolicyProvider</code> rather than rendering an empty
control.

The provider contributes no markup, so it can wrap a page header as well as the
form when help belongs above the fields. Wrap once, though: each
<code>FieldPolicyProvider</code> owns its own mode state, and a nested provider
shadows the outer one for everything inside it. Two providers means an outer
<code>FormHelp</code> whose glossary does not follow the inner
<code>ModeSwitch</code>.

## Generated ObjectForm and source registry

<code>ObjectForm</code> renders the safe intersection of a generated browser field
definition and a resolved policy. It supports either direct SSR props or an
application-wide source registry.

For the registry path, add every generated collection definition the
application actually supports. The registry calls the generated
<code>resolveBatch</code> action, validates the response before it drives a form, and
fails closed with an accessible error when a definition or policy is missing.

~~~svelte
<script lang="ts">
  import {
    ObjectForm,
    ObjectFormSourceProvider,
    ObjectFormSourceRegistry,
  } from '@happyvertical/smrt-fields/svelte';

  import { collectionDefinitions, fieldPoliciesClient } from '$lib/generated';

  const source = new ObjectFormSourceRegistry(fieldPoliciesClient);
  for (const definition of Object.values(collectionDefinitions)) {
    source.register(definition);
  }

  let invoice = $state({});
</script>

<ObjectFormSourceProvider {source}>
  <ObjectForm
    objectRef="@acme/billing:Invoice"
    bind:value={invoice}
    showModeSwitch
  />
</ObjectFormSourceProvider>
~~~

<code>ObjectForm</code> creates its own <code>FieldPolicyProvider</code> around the
fields it renders, so it needs no outer provider and should not be given one.
It renders <code>ModeSwitch</code> with <code>showModeSwitch</code>; it does not
currently expose a seam for <code>FormHelp</code>.

The browser wire types are text, integer, decimal, boolean, datetime, JSON,
foreign-key, and cross-package-reference. There is no <code>select</code> wire type.
For a select-like UX, preserve the actual stored type and register a
field-specific component with <code>FieldInputRegistry.registerField()</code>.
Reference fields intentionally use identifier inputs until the host registers
a chooser.

Use <code>policyToVisibleColumnIds(policy, columns)</code> for a matching DataTable
view. It hides policy-hidden mapped fields while preserving computed and
action columns; a statically hidden column remains hidden.

## Gear, Focus, and the control panel

The field settings gear is the per-form editing experience:

1. Adapt the generated collection client’s <code>getEditorState</code>, create, update,
   and delete calls to <code>FieldPolicyGearProvider</code>.
2. Wrap a form in the provider.
3. Render <code>FieldPolicyGearButton</code>, or set <code>showPolicyGear</code> on
   <code>ObjectForm</code>.

The adapter has no tenant or user parameters. Identity remains server-derived.
The editor exposes only rows and layers the caller may edit; it does not reopen
general policy listing.

For an organization-wide destination, build the server payload with
<code>buildFieldPolicySettingsCatalog()</code> and render it with
<code>FieldPolicyControlPanel</code>. The host supplies its SettingsCatalog component,
route transport, confirmation handler, and real server-side route permission.
The control panel uses a bounded, permission-gated audit: it shows the current
tenant’s editable rows, app summaries, and per-field counts of member
overrides—not other members’ values.

<code>fieldPolicyControlPanelNavItem()</code> creates a tenant-navigation item only when
the caller has <code>fields.policy.manage</code>. Use
<code>registerFieldPolicyFocusTool(shell, objectRef, tool)</code> to attach a form’s
settings UI to an AdminShell-compatible Focus subject. Both are structural
integration seams: Fields does not assume a particular shell or client
transport.

## Security and privacy checklist

Before deploying a Field Policy UI, confirm all of the following:

- The host sets a trusted authenticated principal context before generated
  routes or server actions run.
- The host registers and allows only the object’s canonical <code>objectRef</code> and
  generated browser definition that it intends to serve.
- Browser requests do not supply tenant or user identity. Use context-derived
  generated actions for browser resolution and editing.
- Do not create defaults for sensitive, transient, or read-permission-gated
  fields. The package rejects them and omits those fields from browser policy
  responses.
- Reference defaults are UUID strings unless their field explicitly declares a
  text id type.
- Treat policy help, labels, and defaults as administrator-controlled content;
  render them as text rather than executable markup.
- Use reset and drift-prune confirmations in the control panel. They are
  deletions and therefore cannot be undone from that UI.

The package intentionally does not expose generated policy list or get
endpoints: unscoped reads could enumerate tenant or user preferences.

## Owner and member walkthrough

The [SMRT SaaS starter field-policy walkthrough](https://github.com/happyvertical/smrt-saas-starter/pull/51)
uses SMRT `0.40.61` and demonstrates a full host integration:

1. An owner or organization administrator opens the field settings destination
   and uses the gear or control panel to set organization defaults.
2. A member sees those resolved defaults in the generated form and may make a
   personal adjustment only when granted <code>fields.policy.personalize</code>.
3. If the owner locks a field, the member’s edit path closes and the
   organization policy takes effect immediately on the next resolution.

## Usage learning and suggestions

The optional learning loop turns recent, aggregated form usage into
administrator-reviewed organization suggestions. It is deliberately
suggestion-first: there is no automatic acceptance.

### Capture authenticated form usage

The server usage action is context-derived. Its bounded <code>entries</code> array contains
<code>{ objectRef, fieldName, value?, matchedDefault? }</code>; it returns
<code>{ accepted, dropped }</code>. The action requires both an ambient tenant
and an authenticated user. It has no identity selectors in its payload, and
anonymous/public forms do not contribute usage.

For browser forms, collect and report only after the host persistence handler
acknowledges success (returns or resolves <code>true</code>). The helper is
deliberately fire-and-forget: a telemetry failure must not make the saved
record look like a failed submission.

~~~typescript
import {
  collectFieldUsageEntries,
  reportFieldUsage,
} from '@happyvertical/smrt-fields/svelte';

const entries = collectFieldUsageEntries({
  objectRef: '@acme/billing:Invoice',
  values: invoice,
  fields: {
    title: 'text',
    internalNotes: 'text',
  },
  // `policy` is the resolved policy for this object.
  defaults: policy.fields,
});

reportFieldUsage(usageReporter, entries);
~~~

Manual hosts pass the optional <code>defaults</code> map from their resolved
policy. This lets a count-only field report <code>matchedDefault: true</code>
without sending its raw value. <code>ObjectForm</code> supplies that map
automatically.

<code>FieldUsageReporter</code> is a structural browser contract with
<code>reportUsage({ entries })</code>. <code>ObjectForm</code> accepts the same
<code>usageReporter</code> prop and reports its nonblank rendered basic and advanced
fields only after that success acknowledgement. Hosts own the authenticated
transport.

The server validates every entry against the live registry. Unknown or
unaddressable fields are dropped rather than trusting a stale client.
Sensitive and read-permission-gated fields remain count-only: their values are
not stored. The browser sends raw values only for low-cardinality boolean and
reference fields; text, numbers, dates, and JSON are count-only signals. The
server permits histograms only for those boolean/reference categories and, not
a client claim, resolves defaults and decides whether a supplied value is a
deviation.

### Review suggestions

Suggestion reads and decisions are manage-gated and context-derived: they
require <code>fields.policy.manage</code> in the ambient tenant. The browser
contract is <code>FieldPolicySuggestionAdapter</code> with
<code>pendingSuggestions({ objectRefs? })</code>, <code>acceptSuggestion({ id })</code>,
and <code>dismissSuggestion({ id })</code>. The host binds those methods to its
authenticated generated client and can render the transport-neutral
<code>FieldPolicySuggestionQueue</code>. Gear and control-panel hosts use the same
adapter rather than assuming a route or client implementation.

Pending suggestions are either:

- <code>promote</code>: make a field basic in the tenant policy; or
- <code>default</code>: apply the proposed default to the tenant policy.

Accepting applies the corresponding tenant policy through the normal policy
validation rails. Dismissing applies a 30-day cooldown by default; a host may
request a bounded cooldown from one hour to one year. Pending, accept, and
dismiss requests identify only the suggestion (and an optional dismiss
cooldown), never a tenant or user.

### Schedule deliberately

Call <code>ensureFieldUsageLearningSchedules({ db })</code> from trusted
deployment startup or migration code to install the two global schedules. The
installer creates them dormant by default; enablement is a deployment decision,
not an automatic side effect.

The default maintenance schedule runs daily at 02:30 and the suggestion run
every Monday at 03:00, both in the scheduler host’s local time. Maintenance
keeps usage counters for 90 days and at most 100,000 rows, and removes accepted
suggestions after 180 days. The suggestion window is 30 days: promotion needs
five distinct users, while a default needs 10 submissions with at least 80%
dominance. Hosts may configure these defaults when installing schedules.
