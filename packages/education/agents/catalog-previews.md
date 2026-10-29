# Publisher catalog previews

`CatalogSourceRecord.preview` and `CatalogResourceView.preview` are optional
`CatalogPreview` metadata. They describe a publisher image, not an acquired
original, cover guarantee, download permission, or learner access grant. The
public root exports `CatalogPreviewService`, `CatalogPreviewStore`,
`CatalogPreviewLoader`, `catalogPreviewFor`, and `normalizeCatalogPreview`.
`CatalogResource.getPreview()` reads the guarded persisted JSON. Deploy the normal
additive manifest migration for its nullable `preview` column before sync; legacy
rows have no preview. Sync retains the first retrieval timestamp on identical
revision retries and rejects changing an existing preview within that revision.
New revisions replace the current reference; old revision requests become 404.
The image hash participates in the IM page record's revision, so changed bytes
cannot silently reuse a preview revision.

The public IM first-edition adapter automatically selects at most one embedded
instructional diagram on a K–5 family-materials page. It requires that exact
page's CC BY 4.0 footer and attribution, an official ImageFile figure with an
empty caption, no separate credits or image-license notice in the instructional
content, a descriptive chart/diagram alt, and an exact official asset identifier.
Branding, photographs, credited or ambiguous images, other providers, unsupported
formats and missing metadata remain absent. This narrow page-scoped policy does
not grant a provider-wide image license. The source footer explicitly excludes
the name/logo and preserves third-party image licenses; never remove those
exclusions or apply this rule to arbitrary images. Existing teacher visibility
is retained, including family hierarchy records currently classified teacher.

Concrete publisher evidence, retrieved 2026-10-28:
[Grade 1 Unit 1 Family Materials](https://im.kendallhunt.com/k5/families/grade-1/unit-1/family-materials.html)
embeds ImageFile 38531, “Tally Chart. Turtle, tallies, 6. Dog, tallies, 2.
Rabbit, tallies, 12.” Its
[official PNG](https://cms-assets.illustrativemathematics.org/fd1cykl2wl4zyfc6vzfkl3x09pvr)
is 93,072 bytes, 1350 × 674. The licensed instructional fragment and PNG are
fixtures in `src/__tests__/fixtures/im-family-*`, attributed to © 2021
Illustrative Mathematics, CC BY 4.0. The image is unmodified. Captions or separate
attribution appearing in a future sync make the preview unavailable.

Enumeration performs metadata reads and at most one **preview image** GET per
page; it never GETs original PDFs/ZIPs. It accepts only official HTTPS origin and
opaque path, refuses redirects, and bounds the complete network/body operation
by the adapter deadline (20 seconds default, 60 maximum). PNG previews have a
2 MiB byte cap and 4096-pixel width/height cap. SVG, HTML, JPEG and other formats
are currently unavailable. This uses existing provider request bounds rather
than a general URL proxy. A preview failure leaves catalog metadata readable.
`CatalogReadService.search()` performs no image or content fetches.

Wire a host endpoint using only the published root API:

```ts
import {
  CatalogPreviewService,
  createPublicIllustrativeMathematicsFirstEditionAdapter,
} from '@happyvertical/smrt-education';

const previews = new CatalogPreviewService({
  // Both functions use your trusted active-session/tenant executor. Adapt your
  // persisted resource to CatalogSourceRecord, including row.getPreview().
  getResource: (id, actor) => catalogStore.getReadableResource(id, actor),
  authorize: (actor, resource) => catalogPolicy.canReadNow(actor, resource.id),
}, createPublicIllustrativeMathematicsFirstEditionAdapter());

// Inside GET /catalog/preview; actor is derived from the server session.
return previews.serve({ actor, resourceId, revision });
```

Render your own endpoint URL only when `view.preview` is present, using `alt`,
width/height and rights attribution. Never place `reference` or `sourceUrl` into
an image URL. The endpoint re-reads the current resource and checks active
host authorization, tenant/actor identity, teacher visibility, withdrawal,
revision and optional rights expiry on **every request**, including cache hits.
The host must check actor membership/active tenant, not merely trust strings in a
request. Do not expose an unscoped collection read as this adapter.

The per-service cache holds at most 16 MiB of verified public image bytes for at
most 60 seconds; reuse a service instance to benefit from it. Cache lookup occurs
after authorization. Changed length, dimensions or SHA-256, expiry, missing or
invalid metadata, upstream failures and access denial yield uniform 404 with
`Cache-Control: no-store`; successful responses are PNG, `nosniff`, sandboxed,
and `private, no-store`, so browsers cannot serve a revoked preview from cache.
No credential, upstream image URL, redirect or raw provider error reaches the
browser. Synchronize regularly to observe publisher withdrawal/license changes;
server byte caching never bypasses the durable current-resource decision.

Private asset previews and derivatives of acquired originals are unavailable in
this publisher-only contract. Use the asset authority and the separate acquired
original derivative capability (#4470), with authorization on every private
asset read. Possessing an asset, granting full-resource download/print, or being
able to view a publisher page never supplies preview permission here.
