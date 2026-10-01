---
'@happyvertical/smrt-ui': minor
'@happyvertical/smrt-svelte': patch
---

An agent never moves the person's keyboard focus. A `focus` command from
`source: 'agent'` on the control-interaction registry now reveals and
highlights the control instead of focusing it; a user-sourced `focus` is
unchanged. The `smrt_ui_execute_form_control` tool description says so.
