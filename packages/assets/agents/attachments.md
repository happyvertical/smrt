# Native private attachments

Import `AttachmentPanel`, `AttachmentList`, `AttachmentUpload` and their named
Props types from `@happyvertical/smrt-assets/svelte`. Registry slots are
`attachment-panel`, `attachment-list`, and `attachment-upload`; the import
registers them. The Assets playground includes an interactive example.

```svelte
<script lang="ts">
  import { AttachmentPanel } from '@happyvertical/smrt-assets/svelte';
  let { data, form } = $props();
</script>
<AttachmentPanel
  attachments={data.authorizedAttachments}
  upload={{
    action: data.uploadAction,
    canUpload: data.mayUpload,
    fileField: 'receipt',
    description: form?.description ?? '',
    message: form?.message,
    fileError: form?.fileError,
    reselectFile: Boolean(form?.failedUpload),
    accept: 'application/pdf,image/jpeg,image/png',
    help: data.uploadPolicyLabel,
    hiddenFields: [
      { name: 'requestId', value: form?.requestId ?? data.requestId },
      { name: 'ownerId', value: data.ownerId },
    ],
  }}
/>
```

`AssetAttachmentVersion` projects existing Asset `name`, `mimeType` and optional
`version`, with `id`, caller-localized `recordedAtLabel`/`note`, and optional
`viewHref`/`downloadHref`. `AssetAttachment` adds a caller-localized `statusLabel`
and ordered `versions`. Adapt an Asset or owning join server-side, after access
checks. No storage URI is part of the UI contract. Missing links remain absent;
the UI never derives public URLs from `sourceUri`, ids, buckets or filenames.
Only HTTP(S) and relative navigation URLs render; other protocols are omitted.
Every supplied URL still needs an authenticated, authorized endpoint, such as an
application wrapper around the public `serveAsset` API. Capability props are
presentation only. Do not send unauthorized metadata to the browser at all.

`AttachmentUpload` uses POST with `multipart/form-data` and a native FilePicker.
Defaults are `file`, `description` and clicked submitter `intent=upload`; change
these with `fileField`, `descriptionField`, `intentField`, and `intent`.
`hiddenFields` preserves repeated names and exact values. The caller supplies
request identity; the component never creates or rotates tokens. Avoid field
name collisions. `children` adds application-specific request fields.
The caller validates actual bytes, size, MIME/type, ownership, quota, tenant,
request replay and mutations. `accept` is only a browser hint. No upload,
authorization, storage service, correction policy or financial review mutation
is implemented by these components.

For rejected/denied uploads, rerender description, field errors and hidden
request values from the submitted request. Native navigation clears file inputs
by browser design: set `reselectFile` to explain that the file must be chosen
again. Enhanced failures may retain the actual selected File; do not set this
flag unless reselection is needed. The component never claims to restore files
or auto-clears a form after failure. After an uncertain outcome, use your
application's established idempotent recovery policy, keeping the request
identity. `retryStatus` accepts the existing `smrt-ui/form-retry` controller's
status for in-flight/uncertain presentation; its transport/controller stays
caller-owned. `onsubmit` optionally enhances native transport.

`AttachmentList` keeps existing items during `loading`, accepts a load `message`,
and renders optional history in caller order. `canUpload=false` hides the whole
upload form; omit the panel's `upload` entirely when no upload surface is wanted.
Status labels do not grant or remove any authorization.

## Removing attachments

Remove is opt-in: nothing renders unless `onremove` or `removeAction` is given
to `AttachmentList` or `AttachmentPanel`. Each top-level attachment (not
history rows) then gets a "Remove <file name>" button that opens a smrt-ui
`ConfirmDialog`; nothing is removed before confirmation.

- `onremove(attachment)`: host handler, may return a promise. All remove
  buttons and the dialog stay disabled until it settles; a rejection shows a
  "Could not remove <name>" alert. Wins over `removeAction`.
- `removeAction`: native mode for server actions. After confirmation the list
  POSTs a form to that URL with `removeIdField` (default `attachmentId`, the
  attachment `id`), `removeIntentField`/`removeIntent` (default `intent=remove`)
  and verbatim `removeHiddenFields`. Requires JavaScript (the confirmation).
- `removePending`: caller-owned pending flag that disables the buttons.
- `AssetAttachment.canRemove=false` hides one item's button (presentation only).
- `density="touch"` gives the buttons touch-size targets; omit to inherit the
  ThemeProvider density.

The component never deletes anything: the endpoint or handler must authorize
and call the owner's `removeAsset()` or association detach.

Focused validation:

```sh
pnpm --filter @happyvertical/smrt-assets exec vitest run --config vitest.attachments.config.ts
pnpm --filter @happyvertical/smrt-assets exec playwright test -c e2e/attachments/playwright.config.ts
pnpm --filter @happyvertical/smrt-assets build
pnpm --filter @happyvertical/smrt-assets typecheck
```

`AttachmentUpload.showDescription=false` omits the description control and its error. Use this for file-only endpoints or immutable prepared descriptions shown outside the form. It does not silently submit description; a caller may explicitly supply an authorized fixed value through `hiddenFields`. Default true preserves existing behavior.

Composition validation: native Svelte SSR contracts cover defaults, omitted fields, retained malformed values, caller identity, no duplicate fixed inputs, correction/read-only/pending behavior. No persistence, transaction, tenant authority or external provider changes occur; those matrix dimensions are N/A for this presentation-only extension. Node26/Svelte5 native POST markup is the supported runtime edge.
