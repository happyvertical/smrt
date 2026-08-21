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

`controller.snapshot()` returns a canonical JSON-safe `{ version, modes,
state }` envelope. It contains no rows, callbacks, snippets, storage handles,
tenant/principal data, query objects, or authority. URL and saved-view adapters
remain application-owned: persist the snapshot (normally excluding selection
and expansion IDs), validate it with `hydrateDataTableSnapshot`, and feed the
state into a new controller or `replaceState`. `smrt-ui` does not read or write
the URL, browser storage, or a database.

### Controlled and migration use

Pass `state` plus `onStateChange` for controlled state. A controlled controller
emits a candidate and waits for the host to call `replaceState`; an
uncontrolled controller owns the state initialized by `initialState`.

The existing Svelte bindables remain supported during migration:

| Existing prop | Controller state |
| --- | --- |
| `bind:sort` | first entry of ordered `sorting` (single-sort compatibility) |
| `bind:page`, `pageSize` | `page`, `pageSize` |
| `bind:selected`, `bind:expanded` | canonical `selectedRowIds`, `expandedRowIds` arrays |
| `visibleColumnIds` | `columnVisibility` intersected with static `column.hidden` |
| `manualSorting`, `manualPagination` | sorting/pagination entries in `modes` |
| `filterFn` | local-only legacy predicate; never serialized |

An explicit `controller` takes precedence over `state` and legacy bindables.
Without one, the component creates an internal controller and maps the legacy
props. Multi-column sorting and persisted layouts use the controller state;
the legacy `SortState` remains intentionally single-column.

Use a stable `rowKey` when selected or expanded state can survive a sort,
filter, refresh, or page change. The historical index fallback remains only
for local presentational compatibility; it is not portable across remote data
or persisted/agent-controlled views. Select-all means the currently rendered
page. Query-wide "all matching" selection belongs to the data-surface layer.

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
the last page or render misleading pagination controls.

Changing search, filters, sorting, or page size resets the page to 1 only when
the value changes. Data or total changes clamp an out-of-range page but do not
otherwise reset it; empty known totals normalize to page 1. Column layout,
selection, and expansion never change the page.

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
