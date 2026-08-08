# @happyvertical/smrt-fields

Layered field policy for SMRT objects: personalize per-field defaults,
visibility tiers (basic/advanced/hidden), help text, labels, ordering, and
org locks at app, tenant, and user scope — over the code-authored
`@field({ ui })` seed.

```typescript
import {
  FieldPolicy,
  FieldPolicyCollection,
  resolveFieldPolicy,
  resolveFieldPolicyExplained,
} from '@happyvertical/smrt-fields';

// An org (tenant) demotes an optional field and sets a default
const policies = await FieldPolicyCollection.create({ db });
await policies.create({
  objectRef: '@happyvertical/smrt-content:Article',
  fieldName: 'summary',
  scopeType: 'tenant',
  tenantId,
  visibility: 'advanced',
  defaultValue: JSON.stringify('TBD'),
});

// Resolve the effective policy for a user in that tenant
const resolved = await resolveFieldPolicy(
  '@happyvertical/smrt-content:Article',
  { tenantId, userId, db },
);
resolved.fields.summary.visibility; // 'advanced'

// Explain variant: per-layer contributions for admin/gear UIs
const explained = await resolveFieldPolicyExplained(
  '@happyvertical/smrt-content:Article',
  { tenantId, userId, db },
);
```

Resolution layers (low → high): code seed → app rows → tenant rows
(hierarchy walk via the users tenant loader, or a flat fallback when an
injected hierarchy provider cannot resolve the tenant) → user rows. A NULL column inherits
from the lower layer; resetting a customization is a row delete.

`@happyvertical/smrt-users` is a required runtime dependency: Field Policy
uses its permission catalog and operation guard for every write and gear
action. The hierarchy fallback concerns tenant ancestry only; it is not a
users-authorization fallback.

Writes are validated against the live `ObjectRegistry`: unknown
objects/fields are rejected, defaults are type-checked, and defaults on
`transient`/`sensitive`/`readPermission`-gated fields are refused. Required
fields can only be demoted from `basic` when a usable default resolves —
and the resolver re-enforces that invariant at read time.

See `AGENTS.md` for the full architecture notes.

## Svelte ObjectForm

`@happyvertical/smrt-fields/svelte` provides provider-free generated forms.
Pass only the generated browser field definitions and the matching resolved
policy; `ObjectForm` renders their safe intersection, honors policy visibility
and ordering, and keeps form state transport-neutral.

```svelte
<script lang="ts">
  import { ObjectForm, createFieldInputRegistry } from '@happyvertical/smrt-fields/svelte';

  const inputRegistry = createFieldInputRegistry();
  // inputRegistry.registerField(objectRef, 'body', RichTextInput);
</script>

<ObjectForm {objectRef} fields={collectionDefinition.fields} {policy}
  bind:value={record} {inputRegistry} />
```

An app can register all of its generated collection definitions once and put
the `resolveBatch` custom-action client behind an `ObjectFormSourceProvider`.
Then forms need only their canonical object reference; the registry validates
the generated definition and the untyped custom-action response before it is
rendered, failing closed with an accessible error state on a missing or
mismatched response.

```svelte
<script lang="ts">
  import {
    ObjectForm,
    ObjectFormSourceProvider,
    ObjectFormSourceRegistry,
  } from '@happyvertical/smrt-fields/svelte';

  const source = new ObjectFormSourceRegistry(fieldPoliciesClient);
  for (const definition of Object.values(collectionDefinitions)) source.register(definition);
</script>

<ObjectFormSourceProvider {source}>
  <ObjectForm objectRef="@happyvertical/smrt-products:Product" bind:value={record} />
</ObjectFormSourceProvider>
```

The built-ins support text, integer, decimal, boolean, datetime, JSON, and
reference identifiers. `FieldInputRegistry` is per app: a field-specific
renderer takes precedence over a wire-type renderer. SMRT has no `select` wire
type: keep the persisted wire type (normally `text`) and register a
field-specific select-like renderer with `registerField(objectRef, fieldName,
component)`. Reference fields deliberately remain provider-free identifier
inputs unless an app registers its own chooser. `policyToVisibleColumnIds`
adapts the same resolved policy to `DataTable` without hiding unmapped action or
computed columns; static `column.hidden` remains authoritative.

When a mounted create form starts another record, replace the bound record with
an empty object or change `createSessionKey`; both begin a new default-prefill
session without reapplying defaults after an in-form user clear.

## Policy settings gear

`FieldPolicyGearProvider` makes the context-derived `editor-state` action
available to any policy-aware form without choosing a client transport. Pass an
adapter around the generated collection client's `getEditorState`, `create`,
`update`, and `delete` calls; it must not accept tenant or user identifiers.
Use `FieldPolicyGearButton` where the form wants its affordance, or set
`showPolicyGear` on `ObjectForm`. `registerFieldPolicyFocusTool(shell,
objectRef, tool)` is a structural AdminShell seam: it registers the required
`{ type: 'object-form', id: objectRef }` subject and returns the shell's
disposer without making Fields depend on `smrt-svelte`.
