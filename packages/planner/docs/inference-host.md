# Inference modes and the host wire contract

The planner's assistant needs a language model. Where it runs is chosen at
runtime, so one build serves every deployment.

## Config: `planner.config.json`

Served at `${base}/planner.config.json` (next to the app; `base` is the
SvelteKit base path) and fetched once at startup. A missing file means the
defaults. A mounted `Planner` can pass the same object as its `inference` prop
(plus `onReply`); the prop overrides the file.

```json
{
  "inference": {
    "mode": "manual | browser | host | byo",
    "alternatives": ["browser"],
    "credentialPersistence": "memory | local",
    "host": { "endpoint": "/api/planner/chat" },
    "byo": { "presets": ["ollama", "openrouter", "openai", "custom"] }
  }
}
```

- `mode` defaults to `browser`.
- `alternatives` is an optional ordered list of other modes the visitor may
  select. A multi-mode policy also exposes **Manual planning**. Selection is
  always explicit: a provider error never changes mode or starts a download.
- `credentialPersistence` defaults to `local` for compatibility. `memory`
  keeps provider keys only in the current tab while endpoint/model preferences
  remain in `localStorage`; use it for a public hosted planner.
- `host.endpoint` is required for `host`: an `http(s)://` URL, or a path on the
  page's own origin. A cross-origin endpoint must answer CORS (see below).
- `byo.presets` is optional. Entries are built-in ids (`ollama`, `openrouter`,
  `openai`, `custom`) or full definitions
  `{ id, label, baseUrl, model?, keyless?, cors? }`. Default: all four.
- `kitchen` (a sibling of `inference`, optional) is set by `smrt kitchen`:
  `{ "endpoint": "/api/kitchen/cookbook" }`. With it the export panel shows
  **Send to kitchen** (Download stays as the secondary option) once the page
  also holds the one-time token, which is **never in this file**; see "Send to
  kitchen" below. A `token` in the file is ignored. Unusable values are ignored.
- Anything invalid (bad JSON, duplicate/unknown modes, `host` without a usable
  endpoint, malformed presets) fails closed to `manual` and shows a visible
  notice. It does not enable WebLLM. A 404 or an HTML fallback page is "no
  file", so the compatible standalone default remains `browser` without a
  notice.

| Mode | Where the model runs | Setup | Hear / Speak |
| --- | --- | --- | --- |
| `manual` | nowhere | none; edit, validate and export normally | in browser |
| `browser` | WebLLM in a worker (WebGPU) | download on the AI page | in browser |
| `host` | the host's server | none | in browser |
| `byo` | the visitor's OpenAI-compatible endpoint | AI page: preset, model, key, Test connection | in browser |

The Think indicator reads "In browser", "Server" or "Your model: <name>".

## Host mode wire contract (version 1)

The server owns the prompt. The client never sends the planner's system prompt
or response schema.

### Request

`POST <endpoint>`, `content-type: application/json`, `accept: application/json`.
Same-origin cookies are sent (the fetch default); the planner adds no
Authorization header.

```json
{
  "version": 1,
  "message": "I run a bakery",
  "snapshot": { "version": 1, "revision": 4, "recipes": [], "...": "..." },
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

- `message`: the visitor's text, at most 2000 characters.
- `snapshot`: the controller's compact `PlanSnapshot` (`./commands`, about 2.6
  to 4.8 KB): recipes, features, settings, theme, sections, focus, undo.
- `history`: optional, oldest first, at most 6 entries of at most 1000
  characters, roles `user` and `assistant` only (never `system`).
- The client gives up after 60 s. Cancelling a turn aborts the request.

### Response

`200` with a JSON object, the same turn shape the assistant reads from a model.
Every field but `reply` is optional:

```json
{
  "reply": "Added Sales and Invoicing.",
  "add": ["commerce.sales"],
  "remove": [],
  "settings": { "currency": "CAD", "taxRate": 13, "paymentTerms": "Net 30" },
  "theme": { "preset": "glass", "primary": "#00aa77", "colorScheme": "dark" },
  "commands": [
    { "name": "add_recipes", "input": { "ids": ["commerce.sales"] } }
  ]
}
```

- `reply`: the sentence shown (and read aloud when Speak is on), about 200
  characters at most.
- `add` / `remove`: recipe ids; unknown ids are dropped client-side.
- `settings.taxRate` is in percent. `theme` is tokens only, never CSS.
- `commands`: up to 8 planner commands (`commandTools` / `commandSchemas` in
  `./commands`), run in order through the controller, which validates each.
  The first refused one stops the rest and is reported in the chat. They apply
  only in host mode; a browser or bring-your-own model's `commands` are ignored.
- A non-JSON body is shown as the reply text. A non-2xx status shows "the model
  could not answer: the server answered <status>".
- Streaming is not part of version 1. A later version may add
  `accept: text/event-stream` with the same object as the final event; a server
  that ignores it and answers JSON stays valid.

CORS, for a cross-origin endpoint: allow the page's origin, methods `POST` and
`OPTIONS`, and header `content-type`.

### Stub

`tests/inference-host.test.ts` runs the client against a real HTTP stub server
(`tests/stub-server.ts`); copy it as a conformance starting point.

## Bring-your-own mode

The AI page offers Ollama (`http://localhost:11434/v1`), OpenRouter, OpenAI and
a custom OpenAI-compatible address. Each has a model field and, except Ollama,
a key field, plus **Test connection** (one tiny completion that exercises the
address, the model and the key).

- With `credentialPersistence: "memory"`, a key exists only in the running
  `ByoModel`. Reload requires re-entry. Endpoint/model preferences persist in
  `smrt-planner:inference:v1`; the key is absent from local/session storage,
  IndexedDB, URL/history, cookbook, plan snapshots, exports, config and logs.
  The compatible `local` policy stores keys separately at
  `smrt-planner:inference-key:v1`. In either policy the key is sent only as
  `Authorization: Bearer <key>` to the chosen address, never in a URL, body,
  message or log.
- A key is saved **with the origin it was entered for** (`{ origin, key }`):
  changing the address to another origin, or a config that reuses a preset id
  such as `openai` for another `baseUrl`, does not send the saved key there (the
  AI page says a key is saved for another address). A key saved without an
  origin is dropped. Locally persisted keys are per browser origin, not path.
- A key is only sent over `https`, or over `http` to this computer
  (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`). A keyless preset (Ollama
  on another machine) sends no key, so plain `http` is fine for it.
- The client builds the planner prompt itself (as in browser mode) and POSTs
  `${baseUrl}/chat/completions` with `response_format` JSON mode: the planner's
  `json_schema`, stepping down to `json_object` and then plain text when the
  endpoint answers 400 or 422.
- Browser access (CORS) per preset:
  - **Ollama**: start it with `OLLAMA_ORIGINS` set to the site's origin (for
    example `OLLAMA_ORIGINS=https://example.com ollama serve`; on macOS
    `launchctl setenv OLLAMA_ORIGINS https://example.com`, then restart).
  - **OpenRouter** and **OpenAI**: calls from web pages are accepted. Use a
    key with a low spending limit; anyone with access to the browser profile
    can read it.
  - **Custom**: answer the preflight for the page's origin, headers
    `authorization` and `content-type`, methods `POST` and `OPTIONS`.
- `@happyvertical/ai` was checked first: its root entry wraps the Node-first
  `openai`, Anthropic and AWS SDKs, and its browser-safe `./local` entry only
  has the WebLLM provider, so the client is a single `fetch`
  (`src/lib/inference/openai.ts`).

## Implementing the host in Node: `@happyvertical/smrt-planner/core`

`./commands` is Svelte source and cannot be imported by plain Node. `./core` is
the rune-free part (including `createHeadlessPlanner`, the command set over a
plain-object plan: see below), compiled to plain JavaScript, with no Vite and no Svelte
compiler involved. It has everything a server needs to speak this contract:

| Export | Use |
| --- | --- |
| `parseHostRequest(body)` | check the POST body: `{ ok, request }` or `{ ok: false, error }` |
| `buildHostPrompt({ message, snapshot, history?, catalog? })` | `{ system, messages }` for one chat call |
| `replySchema` / `buildReplySchema(catalog?)` | JSON Schema of the model's answer (ids are enums) |
| `parseHostReply(text, catalog?)` | `{ ok, reply, issues }`; `reply` is the response body |
| `commandTools`, `commandSchemas`, `checkSchema` | the 21 commands as tool definitions |
| `createHeadlessPlanner(cookbook?, { catalog? })` | one plan in plain Node: `run`, `batch`, `snapshot`, `cookbook`, `undo`, `subscribe` |
| `recipes`, `libraryCookbooks`, `defaultCatalog` | the catalog the prompt is built from |
| `PlanSnapshot`, `CommandInputs`, `HostRequest`, `HostReply` ... | types |

`buildHostPrompt` is the browser assistant's own prompt (same wording and worked
examples, focused on the recipes the message matches, with the snapshot's
settings, theme and recipes) plus a host-only section naming the `commands` and
the menu ids. `system` is separate, so it fits both API styles: OpenAI-style,
send `[{ role: 'system', content: system }, ...messages]`; Anthropic-style, pass
`system` and `messages` as they are.

### Holding a plan: `createHeadlessPlanner`

```js
import { createHeadlessPlanner } from '@happyvertical/smrt-planner/core';

const plan = createHeadlessPlanner();           // or (cookbookDocument, { catalog })
plan.run({ name: 'add_cookbook', input: { id: 'bakery' } }); // { ok, snapshot, receipt }
plan.snapshot();   // the same PlanSnapshot the browser controller returns
plan.cookbook();   // the plan as a cookbook document
plan.undo();       // undo the latest undoable change
```

It is smrt's cookbook command engine (`createCookbookEngine` from
`@happyvertical/smrt-core/cookbook/engine`) behind the planner's names plus
`focus`, which moves the planner's view and not the document. The commands,
input schemas, validation, error codes and receipts are the engine's: the
browser controller is the same adapter over the app's stores, and the parity
test runs one script through the browser controller, the headless planner and
a bare engine. State is a plain object, so any number of plans may coexist in
one process. It keeps no sample records, and a document's `overviews` (page
customisations) are dropped with a notice, because checking them needs
smrt-svelte's widget registry, which loads Svelte components. `catalog` limits
the recipe and cookbook ids a plan accepts. `plan.batch({ id?, commands })`
runs up to 50 commands all or nothing.

## Commands: what the engine changed

The planner's command set shipped as 19 commands with its own runner. Since
smrt 0.55.11 it is the engine's 20 plus `focus` (21). The names and input
schemas are unchanged unless listed here, so a host written against the old
set keeps working.

- **New**: `set_name` (name and describe the app) and `validate` (typed
  diagnostics, changes nothing). `batch` (atomic) and command `id`s (a
  repeated `id` returns the first result with `replayed: true`; the same `id`
  for a different command is `id_reuse`).
- **Commands carry `id` and `expectedRevision`**: `{ name, input, id?,
  expectedRevision? }`. The `run(command, { expectedRevision })` option still
  works.
- **Errors**: `unsupported` is gone (the engine always has every part of the
  app); `id_reuse` and `batch_failed` are new. `error` may carry `path` and
  `details`.
- **Receipts** gain `revisionBefore`, `revisionAfter`, `id` and `warnings`.
- **Undo is the whole document**, not one part of it. `apply_cookbook` and
  `import_cookbook` can now be undone (they had no undo). `undo` is a
  `conflict` while the plan differs from what that change left, unless
  `force: true`; the assistant's own theme Undo therefore never forces and falls
  back to putting the previous theme back, leaving later edits alone.
- **A manual edit in the app** (a store changed by the UI, not by a command)
  is adopted on the next call: the revision moves by one, and the undo ids
  issued before it answer `not_found`. Page customisations (`overviews`) are
  edited outside the plan and do not move the revision.
- **Snapshot**: `app.description` is new; everything else, `focus` included, is
  as before. Equal histories give equal revisions, and a command that changes
  nothing does not move it.
- **`import_cookbook`** runs the planner's own strict check first (its
  wording, old-id migration, page-customisation check) and then the engine's;
  the code and `path` of a refusal are the engine's.
- **Library cookbook with no theme** keeps the person's own look, in the same
  undoable step (a batch of `apply_cookbook` and `set_theme`).
- **Page customisations** (`overviews`) are edited outside the plan: `export_cookbook`
  and `cookbook()` carry the app's live ones, an apply or import without
  `replace` is refused when the app holds only those, and `undo` never touches
  them. Undoing an `apply_cookbook` restores the document but not the Cookbooks
  tab's "in use" note or the sample data (applying again, or a batch containing
  it, selects the cookbook and resets the sample data).
- **`focus`** is checked like the engine's commands (unknown keys, `id`,
  `expectedRevision`), but keeps no journal: a repeated `id` is not replayed.
- A **replayed** command (same `id`) returns the first result without its
  `undoId`; use the one the first answer carried. An undo id answers
  `not_found` once used, after a manual edit, or past the 20 the engine keeps.
- A page whose stored document the engine rejects does not throw: reads keep
  the last good plan and commands answer `failed` (naming the problem) until it
  is fixed. The first read of a freshly loaded page adopts the saved cookbook as
  one manual edit (the revision is 1, not 0).
- The **slice controller** (`createSliceController`, for hosts that only have a
  recipe store, settings and theme) writes back recipes, settings and the theme;
  the engine also accepts feature and menu commands there, but with no store to
  hold them they are not kept (they were `unsupported`).
- `apply_cookbook` with a library cookbook that sets no theme keeps the
  person's preset, brand colour and colour scheme (not the font).
- `@happyvertical/smrt-core` is now a runtime dependency of the package
  (it was a dev dependency); `./core` imports its engine entry.

### Minimal reference server

Any OpenAI-compatible endpoint works (`BASE_URL` such as
`http://localhost:11434/v1` for Ollama, `MODEL` its model name):

```js
import { createServer } from 'node:http';
import { buildHostPrompt, parseHostReply, parseHostRequest, replySchema }
  from '@happyvertical/smrt-planner/core';

const { BASE_URL, MODEL, API_KEY = '' } = process.env;

async function chat(req) {
  const { system, messages } = buildHostPrompt(req);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_schema', json_schema: { name: 'turn', schema: replySchema } },
    }),
  });
  if (!res.ok) throw new Error(`model answered ${res.status}`);
  return (await res.json()).choices[0].message.content;
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/planner/chat') {
    return res.writeHead(404).end();
  }
  let body = '';
  for await (const part of req) body += part;
  let parsed;
  try { parsed = parseHostRequest(JSON.parse(body)); } catch { parsed = { ok: false, error: 'bad JSON' }; }
  if (!parsed.ok) return res.writeHead(400).end(parsed.error);
  try {
    const { reply, issues } = parseHostReply(await chat(parsed.request));
    if (issues.length) console.warn('planner reply:', issues);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  } catch (error) {
    console.error(error);
    res.writeHead(502).end();
  }
}).listen(8787);
```

A model without `json_schema` support: drop `response_format` or use
`{ type: 'json_object' }`; `parseHostReply` still repairs prose, cut-off JSON
and unknown ids.

### Serving the planner app: `@happyvertical/smrt-planner/app`

`pnpm package` also builds the prerendered static app into the package's
`app/` directory. `appDir` from `@happyvertical/smrt-planner/app` remains its
absolute root-build path (Node only; `appFile('x')` resolves one file in it).
For a subpath deployment, `materializeApp` is the supported build contract:

```js
import { materializeApp } from '@happyvertical/smrt-planner/app';

materializeApp({
  outDir: '/deployment/build/plan',
  basePath: '/plan',
  config: {
    inference: {
      mode: 'byo',
      alternatives: ['browser'],
      credentialPersistence: 'memory',
      byo: { presets: ['ollama', 'openrouter', 'openai', 'custom'] }
    }
  }
});
```

- **Base path.** `basePath` is a leading-slash, no-trailing-slash prefix such as
  `/plan`. The output root is copied to that prefix by the consumer. Every
  prerendered route and the generated fallback retains the prefix; `_app/**`
  is requested under `/plan/_app/**` even from arbitrary-depth URLs.
- **`404.html`.** `materializeApp` rewrites the packaged root fallback's asset
  imports and SvelteKit runtime base in the owning package. A CDN may answer
  page-like `/plan/**` misses with that file while leaving file-like misses and
  every non-`/plan` miss as a real 404.
- **Config.** The API validates and writes `planner.config.json`; malformed
  policies, unsafe base paths, credential-shaped fields, credential-bearing
  endpoint URLs and non-empty destinations fail before a partial tree is
  exposed. Repeated calls with the same package/options produce the same file
  bytes. The standalone root app may still serve `appDir` and answer config
  itself:

  ```json
  { "inference": { "mode": "host", "host": { "endpoint": "/api/planner/chat" } } }
  ```

  `endpoint` is a path on the page's own origin. Without the file the app runs
  in the compatible single `browser` mode.
- The directory is about 70 MB (the on-device model runtime is most of it);
  serve it with compression and long-lived caching for `_app/immutable/`.

## Send to kitchen

`smrt kitchen` (the `smrt` CLI) serves this app on `127.0.0.1`, answers the host
contract above with the user's own AI provider, and announces itself with the
`kitchen` block of `planner.config.json` (the endpoint only). The page then
`POST`s the cookbook:

- `POST <endpoint>`, `content-type: application/json`, header
  `x-kitchen-token: <token>`, body = the cookbook JSON (`cookbook/v1`).
- `200 { "ok": true, "dir", "mode": "new" | "update", "installed", "added": [package names], "nextSteps": [commands] }`:
  the project was written. The CLI prints the same steps and exits.
- `4xx/5xx { "ok": false, "errors": [...] }`: nothing was applied; the CLI keeps
  listening, so the visitor can change the cookbook and send again.

### The token travels in the address fragment

The one-time token is **not in `planner.config.json`** (any local process that
sends the server's `Host` header could read it there). `smrt kitchen` opens and
prints

    http://127.0.0.1:<port>/#kitchen=<token>

A fragment is never sent to a server, so no endpoint can serve it. The page:

1. reads `location.hash` once, at startup, before the first URL rewrite
   (`readKitchenFragment`, `src/lib/kitchen/fragment.ts`; the token must be
   1 to 256 URL-safe characters, `A-Z a-z 0-9 . _ ~ -`, anything else is dropped);
2. keeps it in memory only (`kitchenState`): not in `localStorage`, not in the
   cookbook, not in any URL, and in no request but the cookbook POST's
   `x-kitchen-token` header;
3. removes the `kitchen` parameter from the address with a replacing
   navigation (`goto(..., { replaceState: true })`, not a bare
   `history.replaceState`, which would leave the token in SvelteKit's own copy
   of the address: `page.url` and the `pageurl` in the history state). Other
   fragment parameters are kept exactly as they were.

Opening the page without the fragment, or reloading after it was removed, leaves
the page with no token: the export panel says so ("Send to kitchen needs its
link") and offers Download. Reopen the address `smrt kitchen` printed.

An older `smrt` CLI (0.55.11 and earlier) still puts `token` in the config. The
planner never reads that value; it reports that the file carried one
(`ConfigResult.kitchen.tokenInConfig`) and Send to kitchen stays off with
"Send to kitchen is off, update the smrt CLI". Release the planner together
with, or after, the smrt release that carries happyvertical/smrt#3772; the CLI
finds the newest planner in the registry, so a planner older than this
contract (no fragment reading) shows no Send button at all.

The client is `src/lib/kitchen/client.ts` (`sendToKitchen`); the panel reads
`kitchenState`. Change the contract here and in the CLI's
`packages/cli/agents/kitchen.md` together.
