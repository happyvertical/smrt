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

## Themes

`@happyvertical/smrt-ui/themes` is the canonical theme API and includes the
Material, Glass, Studio, and s-m-r-t presets. The old `/theme` path forwards to the
same provider and context for compatibility.

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
