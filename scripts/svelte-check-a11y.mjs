#!/usr/bin/env node
/**
 * svelte-check-a11y — accessibility enforcement gate (Sweep S12, #1417).
 *
 * A drop-in wrapper around `svelte-check` that promotes Svelte's compiler
 * accessibility warnings to ERRORS (non-zero exit) via svelte-check's native
 * `--compiler-warnings` flag. Every UI package's `typecheck` script calls this
 * instead of bare `svelte-check`, so a11y regressions fail the existing
 * (required) typecheck CI gate — no separate build job, no new required check,
 * and each package's own codegen/tsconfig flow is reused unchanged.
 *
 * Usage (from a package directory, mirroring the original svelte-check call):
 *   node ../../scripts/svelte-check-a11y.mjs --tsconfig ./tsconfig.svelte.json
 *
 * The workspace runner scopes explicit diagnostic configs to sibling source and
 * uses the package-local checker. This wrapper also promotes the a11y rules
 * below through `--compiler-warnings`.
 *
 * Escape hatch: set SMRT_A11Y_ENFORCE=0 to run plain svelte-check without the
 * a11y promotion (local debugging only; CI always enforces).
 *
 * The canonical a11y warning-code list lives HERE as the single source of
 * truth. These are Svelte 5's `a11y_*` compiler warning codes
 * (https://svelte.dev/docs/svelte/compiler-warnings). A Svelte upgrade that
 * introduces a NEW a11y code will surface it as a plain warning (non-gating)
 * until it is added below — add new `a11y_*` codes here to enforce them.
 */
import { runSvelteCheck } from './svelte-check-workspace.mjs';

const A11Y_CODES = [
  'a11y_accesskey',
  'a11y_aria_activedescendant_has_tabindex',
  'a11y_aria_attributes',
  'a11y_autocomplete_valid',
  'a11y_autofocus',
  'a11y_click_events_have_key_events',
  'a11y_consider_explicit_label',
  'a11y_distracting_elements',
  'a11y_figcaption_index',
  'a11y_figcaption_parent',
  'a11y_hidden',
  'a11y_img_redundant_alt',
  'a11y_incorrect_aria_attribute_type',
  'a11y_incorrect_aria_attribute_type_boolean',
  'a11y_incorrect_aria_attribute_type_id',
  'a11y_incorrect_aria_attribute_type_idlist',
  'a11y_incorrect_aria_attribute_type_integer',
  'a11y_incorrect_aria_attribute_type_token',
  'a11y_incorrect_aria_attribute_type_tokenlist',
  'a11y_incorrect_aria_attribute_type_tristate',
  'a11y_interactive_supports_focus',
  'a11y_invalid_attribute',
  'a11y_label_has_associated_control',
  'a11y_media_has_caption',
  'a11y_misplaced_role',
  'a11y_misplaced_scope',
  'a11y_missing_attribute',
  'a11y_missing_content',
  'a11y_mouse_events_have_key_events',
  'a11y_no_abstract_role',
  'a11y_no_interactive_element_to_noninteractive_role',
  'a11y_no_noninteractive_element_interactions',
  'a11y_no_noninteractive_element_to_interactive_role',
  'a11y_no_noninteractive_tabindex',
  'a11y_no_redundant_roles',
  'a11y_no_static_element_interactions',
  'a11y_positive_tabindex',
  'a11y_role_has_required_aria_props',
  'a11y_role_supports_aria_props',
  'a11y_role_supports_aria_props_implicit',
  'a11y_unknown_aria_attribute',
  'a11y_unknown_role',
];

const enforce = process.env.SMRT_A11Y_ENFORCE !== '0';
const forwardedArgs = process.argv.slice(2);

if (enforce) {
  forwardedArgs.push(
    '--compiler-warnings',
    A11Y_CODES.map((code) => `${code}:error`).join(','),
  );
}

runSvelteCheck(forwardedArgs, 'svelte-check-a11y');
