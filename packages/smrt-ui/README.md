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

Use the focused subpaths (`/forms`, `/ui`, `/feedback`, `/data`, `/layout`,
`/themes`) to keep imports explicit. The package root remains a compatibility
barrel.

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
capabilities. Adapters can focus, reveal, highlight, explain, validate, stage,
apply, clear, or undo. Agent mutations are denied for secret/read-only controls
and require explicit confirmation before apply, clear, or undo. Staging is
separate so the UI can show a proposal before it changes user state.

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

`controller.snapshot()` returns the canonical JSON-safe version-2 `{ version,
modes, state }` envelope. `hydrateDataTableSnapshot()` accepts version 1 and
migrates it to version 2. The envelope contains no rows, callbacks, snippets,
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
