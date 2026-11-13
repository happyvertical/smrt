# Optional native image processing

Importing image models, pure rig assembly or the photo-cutout profile store must
not initialize Sharp. PNG validation loads Sharp inside the existing async
`assertPngMatchesRig` operation, after signature validation. Its dimension,
format and canvas checks remain unchanged; saving a valid rig still uses the
real codec. No processor, model or persistence implementation is duplicated.

| Invariant | Trigger / positive | Negative / failure | Context / executor / runtime / contract | Level / validation |
| --- | --- | --- | --- | --- |
| No native processors at import | Import the published root; model and profile-store exports remain callable | Fresh process refuses resolution of Sharp and the image SDK | Plain Node >=26, no DB; existing public exports | `sharp-backend.test.ts`; full package test |
| Deferred PNG validation | Save/load a real Sharp-generated PNG and rig | Existing malformed PNG, dimensions, canvas, authorization and ownership refusals | Existing fake store unit tests and real SQLite/assets integration fixture; persistence unchanged | Profile-store unit/integration and full package suites |

The import guard fails against the original package. Existing native image
processing and persistence assertions are retained. Reuse check: MCP package
review; intent index; `rg` by processor/Sharp/image import and thumbnail purpose
in images, content, core, chat and UI. This uses the same dynamic-import pattern
already used by `ImageEditor`, `ImageMetadataExtractor` and `applyImageAdjustments`.
