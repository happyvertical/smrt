# Planner product media (#38)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Product images use canonical asset links | Load sample products, add or remove an image | Deterministic thumbnails; selected file becomes Asset plus ProductAsset, ordered in gallery | Missing image displays a placeholder; removal leaves no product link | Visitor | Browser-local DataSource apply, one write plan | Browser / in-memory records | Asset and ProductAsset model ids | Unit and live UI | `pnpm exec vitest run tests/product-media.test.ts`; product page QA |
| Product gallery is configured in the cookbook | Add or remove the `assets.library` recipe | With the recipe, each product's images render in smrt-assets' canonical `AssetGrid` | Without it, the gallery is hidden but the smrt-ui `FilePicker` still adds images | Visitor | Cookbook recipes; no browser-local toggle | Browser | `assets.library` recipe id | Unit (SSR) | `pnpm exec vitest run tests/product-media.test.ts` |

Image selection uses browser-local data URIs in the demo. It does not upload files or change a remote asset service.
