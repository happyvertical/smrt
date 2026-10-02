# Form retry: exactly-once form submissions

A tablet on bad Wi-Fi, a double tap, or a reload after a lost response should
never record the same thing twice, and should never throw away what the
person typed. SMRT splits this into two halves that are designed to be used
together:

| Half | Where | What it owns |
| --- | --- | --- |
| Server | `runOnce()` in `@happyvertical/smrt-core` | An insert-only claim, written in the same transaction as the record, so a retry carrying the same claim replays the first result instead of writing again. |
| Browser | `createFormRetry()` in `@happyvertical/smrt-ui/form-retry` (also exported from `@happyvertical/smrt-ui/forms`) | Where the claim's key comes from, how it survives the failure it exists for, and what happens to what the person typed. |

The full server contract is in
[`runOnce`](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/run-once.md)
(core README section "Run an action exactly once per submission"). This page
shows the two halves side by side.

## The claim: key plus content

`runOnce()` derives its claim from the tenant, the actor, the **submission
key** the browser sends, and a **digest of the content** being written. The
key alone is never the claim: a retry of the SAME submission (same key, same
content) replays, while a DIFFERENT submission through the same key — the
person corrected a field before resending — is a new claim and is recorded.
Keying on the key alone silently collapsed two genuinely different
submissions in the first hand-rolled version of this pattern, and digesting a
`FormData` as `{}` did the same thing again (smrt#3136).

That rule is what lets the browser half be simple: it keeps one key per
filled-in form and never has to decide whether two submits "are the same" —
the content digest does that on the server.

## Server: the form action

```ts
// src/routes/reports/+page.server.ts
import { error, fail } from '@sveltejs/kit';
import { runOnce, RunOnceClaimError } from '@happyvertical/smrt-core';

export const actions = {
  create: async ({ request, locals }) => {
    const formData = await request.formData();
    const token = formData.get('submissionKey');
    if (typeof token !== 'string' || token === '') {
      return fail(400, { message: 'Missing submission key' });
    }
    try {
      const id = await runOnce(
        {
          db: locals.db,
          tenantId: locals.tenantId,
          actor: locals.userId,
          token,
          // The whole FormData: digested by its ordered entries. The key field
          // inside it is harmless — it is the same on every retry.
          content: formData,
        },
        async (tx) => createReport(tx, formData), // must return JSON-serializable data
      );
      return { id };
    } catch (cause) {
      if (cause instanceof RunOnceClaimError) {
        // In flight or unresolvable: nothing definite to report, and safe to
        // retry with the same key and content. An `error` result keeps the
        // key, the typed values and the restore draft in the browser.
        error(409, 'Still saving — send it again in a moment.');
      }
      throw cause;
    }
  },
};
```

## Browser: the form

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import { createFormRetry } from '@happyvertical/smrt-ui/form-retry';

  let { data } = $props();

  const retry = createFormRetry({
    form: 'report', // one slot per FORM; add `scope` for a form rendered per record
    restore: { owner: `${data.tenantId}:${data.userId}` }, // opt-in, see below
  });
</script>

<form method="POST" action="?/create" use:enhance={retry.enhance()} {@attach retry.attach}>
  <input name="title" required />
  <textarea name="description"></textarea>
  <button type="submit">Send</button>

  {#if $retry.status === 'busy'}
    <p role="status">Still sending the last one — wait for it before sending another.</p>
  {:else if $retry.status === 'transport-error'}
    <p role="alert">That did not reach the server. Send it again without changing anything.</p>
  {:else if $retry.status === 'files-required'}
    <p role="alert">Choose {$retry.filesToReselect.join(', ')} again before sending.</p>
  {/if}
</form>
```

- `use:enhance={retry.enhance()}` is SvelteKit's own `enhance`; the helper
  supplies its submit function. smrt-ui does not depend on `@sveltejs/kit` —
  the helper is typed against the `SubmitFunction` shape structurally.
- `{@attach retry.attach}` keeps a hidden `submissionKey` field in the form
  and puts a restored draft back. Prefer `use:retry.action` if you are not on
  attachments; or render the field yourself:
  `<input type="hidden" name="submissionKey" value={$retry.token} />`. The key
  is written into the outgoing `FormData` either way, so the body is right
  even if a hidden field is stale.
- `$retry` works because the controller implements the Svelte store contract;
  the module itself imports neither Svelte nor SvelteKit.
- To run your own logic too, pass your submit function:
  `retry.enhance(({ formData, cancel }) => { ... return async ({ result, update }) => { ... } })`.
  It runs after the retry gate (it sees the key) and may still `cancel()`; its
  `update()` defaults to the safe reset described below. Transport errors and
  late results never reach it — watch `$retry.status`.

## What happens to one submit

| Moment | Key | Form | Draft (restore on) |
| --- | --- | --- | --- |
| A submit is already in flight | kept | kept; this submit is **refused** (`busy`) and nothing is sent | — |
| A restored file has not been chosen again | kept | kept; submit **refused** (`files-required`) | kept |
| `error` result — network drop, lost response, thrown server error | kept | kept, and `update()` is **not** called (it would apply the error and can unmount the form) | kept |
| `failure` result (`fail(...)`, validation) | kept — nothing was written | kept | dropped |
| `success`, fields unchanged since submit | **rotated** | reset | dropped |
| `success`, person typed the next entry meanwhile | kept | **not** reset — the new entry survives | dropped |
| `redirect` | kept (rotated with `redirectConfirmsWrite: true`) | as SvelteKit does | kept (dropped when confirmed) |
| A late answer to a submit already settled | unchanged | unchanged | unchanged |

Why the key is kept when a confirmed write leaves content on screen: the form
still shows something. If it is what was recorded, resubmitting it is the same
claim and collapses onto the existing row; if it is new, its content differs
and it is recorded. Only an emptied form has nothing left to reconcile, so only
then does the next fill get a new key.

## Storage, private windows and shared hardware

- The key lives in `sessionStorage` (per tab, gone when the tab closes), never
  `localStorage`: tablets and kiosks are shared hardware.
- Every storage access is guarded. In a private window or webview that refuses
  storage, the key falls back to memory and still survives a remount for the
  life of the page (`$retry.persistent` is `false`); only a full reload loses
  it, which is less idempotent, never wrong.
- During SSR nothing is shared: no module memory and not Node's process-wide
  `sessionStorage` global. The browser reads the real key on hydration.
- Inject `storage` for tests or a custom store; `storage: null` keeps
  everything in memory. Migrating from a hand-rolled helper? Pass
  `storageKey` (and `restore.storageKey`) with the old names — renaming
  silently loses every unresolved key, and the next retry records a duplicate.

## Restore after a reload (opt-in)

A reload keeps the key but not, by itself, the form. With `restore`, the
submitted values are kept beside the key and put back after the reload, so the
retry is byte-identical and is the same claim.

- Restored only under the key it was saved with, only for the same `owner`
  (never for an empty one, and no draft is stored without one), and only
  while fresh (`maxAgeMs`, default one day, or your own `fresh(savedAt, now)`
  rule such as "same business day").
- Password inputs and names in `restore.exclude` are never written to storage.
  Hidden fields are not restored; carry their source state through `values`.
- `restore.values` keeps state that is not a form field — an uploaded asset's
  id, a signature capture key — so it is not captured twice:
  `values: { capture: (formData) => ({ photoKeys }), restore: (v) => { photoKeys = parsePhotoKeys(v) } }`.
  `restore` receives data from storage; validate it.
- For state-driven forms, `retry.restored` exposes the draft (`fields`,
  `files`, `values`, `savedAt`) to read yourself instead of attaching.
- `retry.discard()` is the "start over" control: it drops the draft and
  rotates the key.

### Files

A native file input cannot be restored from script. The draft records each
chosen file's name, type and size (never its bytes); after a reload
`$retry.filesToReselect` names the fields, and a submit without them is
refused rather than silently sent without the file. Re-choosing the same file
reproduces the same digest — `runOnce()` digests a `File` by name, type and
size — so the retry is still the same claim.

The reset after a confirmed write empties every file field. `FileUpload`
(smrt-svelte) and the smrt-ui `CameraCapture` / `SignaturePad` follow their
form's `reset` event, so their list, photo or signature empties with it and
the next submit never posts an empty field behind a file still on screen.

"Unchanged since submit" compares the visible fields plus every file the form
would post, read from `new FormData(form)` (which fires `formdata`, as a real
submit does) by name, type, size and modification time. A capture field on the
`formdata`-event fallback keeps its file in no element, so a photo or signature
taken or replaced while the submit is in flight still counts as an edit and
survives the success.

## Computing the digest in the browser

`digestSubmissionContent(content)` returns the exact content digest
`runOnce()` will compute, using Web Crypto (`crypto.subtle`, secure contexts
only). Pairing with `runOnce()` does not need it — the server digests the
content itself. Use it when the browser needs the same identity: to tell a
person whether the retry is unchanged, to key a client-side record of an
attempt, or to log a correlatable identity without logging content. A `File`
entry digests by name, type and size; shared test vectors in core and smrt-ui
keep the two implementations byte-identical.

## SMRT `Form`

The helper works with any `<form method="POST" use:enhance>`. Using it with
smrt-ui's `Form` component needs `Form` to accept `use:enhance` / expose its
element, which is smrt#3265.
