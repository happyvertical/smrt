# @happyvertical/smrt-ui

The domain-agnostic Svelte 5 component foundation for s-m-r-t. Components use the
shared `--smrt-*` design tokens, render without a s-m-r-t Provider, and can be used
by any package or application without pulling domain dependencies into the UI
layer.

```bash
pnpm add @happyvertical/smrt-ui
```

```svelte
<script lang="ts">
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { Form, FormGroup, Input, Switch } from '@happyvertical/smrt-ui/forms';
</script>

<ThemeProvider preset="material" colorScheme="system">
  <Form formId="profile">
    <FormGroup label="Display name"><Input name="displayName" /></FormGroup>
    <Switch name="updates" label="Product updates" />
    <Button type="submit">Save</Button>
  </Form>
</ThemeProvider>
```

## Foundation catalog

| Area | Components |
| --- | --- |
| Fields | `Form`, `Field`/`FormGroup`, `Fieldset`, `InputGroup`, `ErrorSummary` |
| Text and structured input | `Input`, `Textarea`, `Select`, `Combobox`, `Listbox`, `MultiSelect`, `TagsInput` |
| Choices | `Checkbox`, `RadioGroup`/`Radio`, `Switch`, `Toggle`, `ToggleButton`, `SegmentedControl` |
| Values and files | `Slider`, `RangeSlider`, `DatePicker`, `TimePicker`, `FilePicker` |
| Actions and display | `Button`, `Dropdown`/`Menu`, `Badge`, `Chip`, `Avatar`, `Card`, `Skeleton`, `Tooltip`, `Tree` |
| Disclosure and overlays | `Popover`, `Disclosure`, `Accordion`/`AccordionItem`, `Modal`, `Drawer`/`Sheet`, `ConfirmDialog` |
| Feedback | `Alert`, `ToastViewport`, `Progress`, `Meter`, `Spinner`, `LoadingOverlay` |
| Collections | `CollectionToolbar`, `CollectionList`/`ContentList`, `DataTable`, `Pagination` |
| Layout and navigation | `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState`, `Tabs`, `FilterChips` |

Use the focused subpaths (`/forms`, `/ui`, `/feedback`, `/data`,
`/data-surface`, `/layout`, `/themes`) to keep imports explicit. The
Svelte-free `/data-surface` entry exposes the registry contracts and shared
protocol limits for server adapters. The package root remains a compatibility
barrel.

### Currency display

`CurrencyDisplay` accepts ISO 4217 codes as a public `string` prop so persisted
Commerce currency fields can be passed directly. Codes are trimmed and
uppercased before `Intl.NumberFormat` formatting; the default remains CAD.
Malformed or unsupported codes render an accessible inline error instead of
throwing and interrupting a surrounding collection render.
With the default historical `unit="cents"` setting, amounts are interpreted as
the selected currency's ISO minor units (for example, 0 digits for JPY and 3
for BHD); `unit="dollars"` means the value is already in major units.

```svelte
<script lang="ts">
  import { CurrencyDisplay } from '@happyvertical/smrt-ui';
  let invoiceCurrency: string = 'eur';
</script>

<CurrencyDisplay amount={12345} currency={invoiceCurrency} />
```

## Component standard

Foundation components follow one contract:

- Native HTML semantics first, with labelled controls, keyboard interaction,
  focus-visible states, disabled/read-only handling, and reduced-motion rules.
- Svelte 5 bindable state plus explicit change callbacks for controlled use.
- SSR-safe IDs from `$props.id()` and stable `name`-based interaction identity.
- Styling only through semantic `--smrt-*` tokens; no component owns a theme.
- Loading, empty, invalid, indeterminate, and disabled states are visible and
  announced where applicable.
- Provider-free implementation and no domain imports.
- Focused interaction tests and axe checks for composed controls.

Application-specific editors, maps, charts, media workbenches, and domain
records remain composites built from this foundation rather than generic base
components.

## Agent-addressable forms

`Form` can expose its controls to a chat, voice, tutorial, or test adapter
without coupling controls to a transport:

```svelte
<script lang="ts">
  import {
    Form,
    FormGroup,
    Input,
    createControlInteractionRegistry,
  } from '@happyvertical/smrt-ui/forms';

  const registry = createControlInteractionRegistry();

  async function proposeName() {
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'profile', controlId: 'displayName' },
        value: 'Ada Lovelace',
      },
      { source: 'agent' },
    );
  }
</script>

<Form formId="profile" interactionRegistry={registry}>
  <FormGroup label="Display name">
    <Input name="displayName" />
  </FormGroup>
</Form>
```

Controls publish serializable metadata, constraints, options, sensitivity, and
capabilities. Adapters can focus, reveal, highlight, explain, validate, and
stage reviewable proposals. Agents cannot apply, discard, clear, or undo;
those value-changing actions require a trusted local gesture handled by the
framework review surface. Secret/read-only controls reject agent mutations.
Staging remains separate so proposals never change user state before review.
Custom local review controls can call `executeLocalControlCommand` or
`executeLocalControlBatch` synchronously from their DOM handlers; the registry
requires the event to still be actively dispatching, snapshots the complete
command, and consumes the gesture before authorizing a value-changing command.
Retaining an event for later use is rejected even when it remains trusted.
Serialized or programmatic `source: 'user', confirmed: true` input is never
confirmation. Sensitive and secret values, validation details, failures, and
events remain redacted from every public surface.
The shared review surface marks its complete edited Apply value with
`reviewedValueIsCanonical: true`. That marker carries no authority: the registry
honors it only for a current staged entry after validating the exact command
under an actively dispatching local gesture. Controls with non-idempotent
proposal preparation can implement `prepareReviewedValue(value)` to validate or
canonicalize the complete displayed value without re-applying proposal-relative
behavior. Controls without that hook route marked edits through their ordinary
`prepareValue`, so a generic marker never bypasses custom normalization or
rejection. An unchanged value exactly equal to the stored staged canonical value
uses that trusted stored value directly.
Registries expose optional `refresh(formId)` notification for hosts whose live
metadata or runtime-state getters change without a registration event; it
updates subscribers without discarding an internal staged proposal.
`executeBatch` is an additive optional registry method; Forms fall back to
ordered `execute` calls for older injected registries. Factory-created
registries retain the framework's private, one-shot gesture proof, while an
older custom registry remains responsible for its pre-existing execution
policy and accepts review actions only from a trusted browser event.
Custom controls whose clear operation is intentionally idempotent should return
`true` from `clear()` to affirm that the unchanged cleared value was accepted.
Async custom setters and clear handlers are rolled back when they reject. A
control that permits direct edits while an async mutation is pending can expose
`getUserEditSnapshot()` and update its revision and value only for direct user
edits so rollback restores newer human input even if the handler mutates again
before rejecting. A fallible async setter should also expose `restoreValue()` as
an infallible state restoration path that does not repeat the external workflow.
Async policy, validation, setter, clear, and restoration hooks receive an
optional final `ControlExtensionContext`. Hooks that need to issue another
control command should use `extension.execute()`; it rejects a mutation of the
same control immediately, while commands from independent callers remain in
the normal ordered queue regardless of how long the hook takes. Existing hooks
that omit the additional argument remain compatible. Setters retain their exact
legacy `setValue(value)` invocation; a setter that needs this context implements
the additive `setValueWithContext(value, extension)` hook instead. A hook must
not await a same-control mutation through a captured registry reference: that
call is indistinguishable from an independent caller in browser runtimes and,
like any hook that never settles, can hold the ordered queue indefinitely.

## DataTable controller

`DataTable` can share one headless `DataTableController` between rendered
controls and a programmatic adapter. Search, declarative filters, ordered
multi-column sorting, pagination, columns, selection, and expansion all become
plain-data commands; a header click and `controller.dispatch()` take the same
transition path.

```svelte
<script lang="ts">
  import {
    createDataTableController,
    DataTable,
    type DataTableColumn,
  } from '@happyvertical/smrt-ui/data';

  const controller = createDataTableController({
    columnIds: ['name', 'status'],
    initialState: {
      pageSize: 25,
      sorting: [{ columnId: 'name', direction: 'asc' }],
    },
  });

  controller.dispatch({
    type: 'setFilters',
    filters: [{ columnId: 'status', operator: 'equals', value: 'active' }],
  });
</script>

<DataTable {controller} data={rows} {columns} rowKey="id" sortable selectable />
```

`controller.snapshot()` returns the canonical JSON-safe version-3 `{ version,
modes, state }` envelope. `hydrateDataTableSnapshot()` accepts versions 1, 2,
and 3 and normalizes them to version 3. The envelope contains no rows, callbacks, snippets,
storage handles, tenant/principal data, query objects, or authority. URL and
saved-view adapters remain application-owned: persist the snapshot (normally
excluding selection and expansion IDs), validate it with
`hydrateDataTableSnapshot`, and feed the state into a new controller or
`replaceState`. `smrt-ui` does not read or write the URL, browser storage, or a
database.

### Controlled and migration use

Pass `state` plus `onStateChange` for controlled state. A controlled controller
emits a candidate and waits for the host to call `replaceState`; an
uncontrolled controller owns the state initialized by `initialState`.

The existing Svelte bindables remain supported during migration:

| Existing prop | Controller state |
| --- | --- |
| `bind:sort` | first entry of ordered `sorting` (single-sort compatibility) |
| `bind:page`, `pageSize` | `page`, `pageSize` |
| `bind:selected`, `bind:expanded` | legacy explicit `selectedRowIds`, canonical `selection` and `expandedRowIds` |
| `visibleColumnIds` | `columnVisibility` intersected with static `column.hidden` |
| `manualSorting`, `manualPagination` | sorting/pagination entries in `modes` |
| `filterFn` | local-only legacy predicate; never serialized |

An explicit `controller` takes precedence over `state` and legacy bindables.
Without one, the component creates an internal controller and maps the legacy
props. Multi-column sorting and persisted layouts use the controller state;
the legacy `SortState` remains intentionally single-column.

### Public surface and supported combinations

`DataTable` supports the following contracts. These are intentionally composed
through the controller rather than through a separate report or remote-table
component.

| Need | Public API | Important constraint |
| --- | --- | --- |
| Stable row interaction | `rowKey`, `selectable`, `expanded`, `onRowClick`, `agentAddressable` | `rowKey` is mandatory whenever a row has durable or remote identity. |
| Declarative view state | `controller`, `state`, `initialState`, `onStateChange` | A supplied `controller` wins over controlled state and legacy bindables. |
| Local or remote transformations | `modes`, `manualSorting`, `manualPagination`, `filterFn`, `totalRows` | A manual stage never runs locally; never mix a local transform with an already transformed remote result. |
| Query lifecycle | `loading`, `refreshing`, `stale`, `partialResults`, `error`, `onRetry` | The caller owns request cancellation and revision checks; the table only presents the supplied result state. |
| Report layout | column `headerPath`, `resizable`, `role`, `responsive`; `structuralRows`; controller widths/pinning | Group structure follows final visible leaf columns. Structural rows are never selectable or virtualized. |
| Narrow screens | `visibleColumnIds` and responsive column metadata | The table preserves its semantic columns behind a named, keyboard-scrollable horizontal overflow region; it does not silently collapse content. |
| Continuous browsing | `virtualization` | Requires `rowKey` and a fixed-height body. Expanded rows deliberately use the normal semantic body. |

The interactive workbench's **Data Table** entry contains a release conformance
fixture for each row in this table: local interaction, manual query lifecycle,
responsive overflow, report layout, and virtualization.

### Row identity and selection

`rowKey` is required for selectable, expandable, manual/server, and
`agentAddressable` tables. Its values must be unique non-empty strings or finite
numbers. This fails closed before a renderer can reuse the wrong row after a
sort, refresh, or server-page change. The historical source-index fallback
exists only for local presentational tables with no durable row state.

The controller stores a `selection` union alongside the deprecated
`selectedRowIds` shorthand:

| Scope | Stored value | Lifecycle |
| --- | --- | --- |
| `page` | IDs from the current rendered page | Cleared when page, page size, search, filters, or sorting changes. |
| `explicit` | Explicit stable IDs across pages | Persists across page and query navigation until changed by the caller. |
| `allMatching` | `queryFingerprint`, `queryRevision`, and `expectedCount` only | Never stores loaded IDs; query-shape changes clear it. |

The built-in header checkbox explicitly means **Select all rows on this page**.
For query-wide selection, dispatch `selectAllMatching` with the caller-owned
query fingerprint, revision, and expected count. A destructive domain action
must call `assertDataTableSelectionCurrent(selection, currentQuery)` immediately
before applying it; a mismatched fingerprint or revision throws rather than
acting on stale results.

`index` passed to row callbacks, cells, expansion snippets, and `rowClass` is
the zero-based display index on the currently rendered page. The source index
is the zero-based position in the supplied `data` array and is used only by the
non-durable fallback. It must never be saved, sent to an agent, or used as a
remote identity.

### Transformation ownership and page rules

`modes` makes each stage explicit. A `manual` stage renders caller-supplied
results and bypasses that local stage, so rows are never double-filtered,
double-sorted, or double-paged.

| Filtering | Sorting | Pagination | Renderer behavior |
| --- | --- | --- | --- |
| `local` | `local` | `local` | filter → ordered multi-sort → slice |
| `manual` | `local` | `local` | sort and slice supplied rows |
| `local` | `manual` | `local` | filter and slice supplied rows |
| `local` | `local` | `manual` | filter and sort supplied page; never slice it |
| `manual` | `manual` | `manual` | render supplied rows unchanged |

Every combination follows the same rule per column in the table: each local
stage runs once and each manual stage runs zero times. For manual pagination,
`totalRows` supplies the total; when it is unknown the component does not guess
the last page or render misleading pagination controls. A supplied `totalRows`
must be a non-negative integer and is rejected unless pagination mode is
`manual`.

Changing search, filters, sorting, or page size resets the page to 1 only when
the value changes. Data or total changes clamp an out-of-range page but do not
otherwise reset it; empty known totals normalize to page 1. Column layout,
selection, and expansion never change the page.

### Manual query, retry, and race contract

When any stage is `manual`, the host owns the request and result lifecycle. On
each query-shape change, derive a stable `queryFingerprint` from every
server-owned input (search, filters, sort rules, page, and page size) and a
monotonically increasing `queryRevision`; start the request, retain the
currently displayed rows with `refreshing`/`stale` as appropriate, and only
commit a response when both values still match. A late response is discarded by
the host, not merged by `DataTable`.

```ts
const queryFingerprint = JSON.stringify({ search, filters, sorting, page, pageSize });
const query = { queryFingerprint, queryRevision: String(revision) };
const result = await loadRows(query);

if (query.queryRevision === String(revision) && query.queryFingerprint === currentQueryFingerprint()) {
  rows = result.rows;
  totalRows = result.totalRows;
}
```

Set `error` without clearing a usable page, and make `onRetry` create a new
revision. For query-wide actions, dispatch `selectAllMatching` with the same
fingerprint/revision and call `assertDataTableSelectionCurrent` directly before
the destructive request. This gives ContentList, reporting, admin, and agent
surfaces the same stale-result and selection guardrail.

### Saved layout and report guidance

Use `headerPath` on every leaf that belongs to a grouped heading; matching IDs
at a given depth form a column group after visibility and restored column order
are applied. Keep report totals in `structuralRows` or `footer`, not in the
data array. Persist `controller.snapshot()` only after removing tenant-specific
selection and expansion IDs, then hydrate it before creating the next
controller. The version-3 snapshot includes `columnOrder`,
`columnVisibility`, `columnWidths`, and `columnPinning`, so a report can safely
restore layout without persisting row data or query authority.

### Scale boundaries and virtualization

`DATA_TABLE_SCALE_THRESHOLDS` publishes the measured operating boundaries used
by the reproducible DataTable benchmark:

| Work | Boundary | Use after the boundary |
| --- | --- | --- |
| Ordinary local rendering | 250 rows / 5,000 cells | Page or virtualize the body. |
| Local filtering and sorting | 1,000 rows / 20,000 cells | Move the transform to the caller or server. |
| Manual/server paging | 100 supplied rows per page | Keep `totalRows` server-owned and bounded. |

Run `pnpm --filter @happyvertical/smrt-ui bench:data-table` to measure the
250-row local render, 1,000-row client-transform, and 100-row manual-paging
fixtures. The fixture data has deterministic `rowKey` values so a browser or
renderer comparison does not depend on array-arrival identity.

`virtualization` is opt-in and requires `rowKey`. It virtualizes only a
fixed-height data body; table headers (including grouped headers) and the
`footer` summary remain normal semantic table sections and do not count toward
the window. The virtual scroll region keeps captions and headers sticky, is
keyboard-scrollable, and reports the full row count plus each rendered row's
logical row index. Supplying `expandedContent` makes data-row height variable,
so the component deliberately falls back to the full semantic body and does
not emit virtual scroll callbacks. Use controlled `scrollTop`/
`onScrollTopChange` for scroll restoration, and pair `focusedRowId` with
`onFocusedRowIdChange` to restore DOM focus to a stable row after a data
refresh. A measured footer extends the virtual scroll range, so keyboard End
and a controlled scroll position can still reveal the summary. Selection and
expansion continue to be controller state keyed by `rowKey`, never by a
rendered window index. With manual pagination, `totalRows` and the current page
set that full row count and each rendered row's global index.
## Mounted data-surface registry

`createDataSurfaceRegistry()` is the transport-neutral sibling of the form
interaction registry. A mounted table, list, or report supplies serializable
discovery metadata, a revisioned view snapshot, and a small handler for its
declared visible controls. The registry rejects duplicate identities, validates
JSON-safe data, requires an `expectedRevision`, records monotonic event
sequences, serializes commands per mounted identity, and returns a cached
acknowledgement when the same `commandId` is replayed. The replay cache retains
only the 100 most recently used command IDs per mounted surface.

Visible-command and preview/apply-action envelopes are capped at 100,000 UTF-8
bytes (`DATA_SURFACE_MAX_REQUEST_BYTES`). JSON values reject prototype keys and
have fixed nesting and container-size bounds, so every browser-facing request
remains safe to normalize before host policy evaluates it.

```ts
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';

const registry = createDataSurfaceRegistry();
let revision = 0;
let search = '';

registry.register({
  descriptor: {
    version: 1,
    identity: { surfaceId: 'content-library', kind: 'table' },
    schemaVersion: 1,
    label: 'Content library',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read', 'project'] },
      { id: 'title', label: 'Title', capabilities: ['read', 'search'] },
    ],
    query: { modes: ['rows', 'count'], projectableColumnIds: ['id', 'title'] },
    controls: [{ id: 'set-search', label: 'Search' }],
    actions: [],
    limits: { maxQueryRows: 100, maxQueryBytes: 100_000, maxSelectionSize: 100 },
  },
  getSnapshot: () => ({ revision, state: { search } }),
  execute: (command) => {
    if (command.controlId === 'set-search') {
      search = String((command.payload as { search?: string }).search ?? '');
      revision += 1;
    }
  },
});
```

`inspect()` and command results are deterministic `{ version, descriptor,
revision, state, selection }` envelopes; neither includes a timestamp, rows,
functions, authority fields, tenant/principal data, SQL, or a transport handle.
The registry rejects those boundary keys from both default and redacted snapshot
state. An optional registration `redact()` hook can remove sensitive view state
before it leaves the mounted host, but cannot alter the identity or revision.

The registry validates bounded projection/count/facet query envelopes (including
the UTF-8 byte length of their normalized JSON form) and preview/apply action
envelopes, but it does not execute either. Canonical query semantics belong to
the query protocol, browser command acknowledgement belongs to a transport
adapter, and authentication, tenancy, confirmation-token verification, and
durable actions remain server-side. URL state and saved views also remain
application-owned persistence adapters.

### DataTable and CollectionToolbar integration

Registration is opt-in. Pass `dataSurface` with an explicit descriptor and a
registry; existing `DataTable` and `CollectionToolbar` consumers do not
register or change behavior. Registration follows reactive `dataSurface` and
controller prop replacement, so registry commands never retain a prior mounted
instance. A DataTable descriptor must only name effective, visible columns,
except for its stable `rowKey`, which may remain non-rendered. Mounted tables
always require that `rowKey` to be an explicit string field; the index fallback
and functional key callbacks are never addressable across pages or refreshes.

```svelte
<script lang="ts">
  import { DataTable, createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';

  const registry = createDataSurfaceRegistry();
  const dataSurface = {
    registry,
    descriptor: {
      // descriptor omitted: give this mounted instance a stable identity,
      // policy-visible columns, controls, query limits, and action descriptors
    },
  };
</script>

<DataTable {dataSurface} data={rows} {columns} rowKey="id" />
```

Declared controller controls include search, filters, multi-sort, page/page
size, column layout, selection, expansion, reset, focus/reveal/highlight, and
optional refresh/retry callbacks. The component maps controller controls to the
same `DataTableController.dispatch()` path used by buttons and checkboxes. A
controlled table supplies `applyControlledState(candidate, command)`; the
registry acknowledges only after that callback settles the candidate state.

`CollectionToolbar` accepts the same opt-in registration and an optional
`controller`. Its `set-search` control shares that table controller; `set-view`
remains toolbar-local. Descriptors may advertise row/bulk action contracts, but
smrt-ui does not execute durable actions—the later authenticated action adapter
owns preview, confirmation, authorization, and persistence.

Toolbar snapshots also advance their revision when the host updates exposed
uncontrolled `search` or `view` props, so a command based on an earlier view is
rejected as stale instead of overwriting host state.

DataSurface columns may also carry domain-neutral policy metadata (`fieldName`,
`visibility`, `order`, `role`, `responsivePriority`, `readable`, and per-column
operator allowlists). Domain packages such as `@happyvertical/smrt-fields`
apply their effective policy above this package; `smrt-ui` validates and
serializes the metadata without owning field authorization or policy rules.

## Themes

`@happyvertical/smrt-ui/themes` is the canonical theme API and includes the
Material, Glass, Studio, s-m-r-t, and HappyVertical ("Day Shift") presets. The
old `/theme` path forwards to the same provider and context for compatibility.

Day Shift is the HappyVertical brand identity: a calm instrument panel with an
enamel ground, faceplate panels on hairline bezels, and a single amber accent
that also serves as the focus ring. Both its light and dark schemes are
hand-authored, and every text pairing clears WCAG AA.

```svelte
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/all.css';
  import '@happyvertical/smrt-ui/themes/styles/fonts.css';
</script>

<ThemeProvider preset="smrt" colorScheme="dark">
  {@render children()}
</ThemeProvider>
```

Run the shared playground to inspect the full catalog under every preset and
light/dark scheme.

## Development

```bash
pnpm check
pnpm test
pnpm build
pnpm verify:pack
```
