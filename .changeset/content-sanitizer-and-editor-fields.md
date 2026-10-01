---
'@happyvertical/smrt-content': minor
---

- **Security:** body HTML is allowlist-sanitized with a real HTML parser
  (`sanitize-html`, the same result in SSR, prerender and the browser).
  Single-pass regexes let nested input reassemble into a live `<script>`
  (stored XSS on public pages rendering bodies with `{@html}`). Scripts,
  handlers, `javascript:` URLs, iframes, SVG/MathML, forms, media, classes, ids
  and other CSS are removed; links, images (never SVG), tables and the editor's
  `data-smrt-*` markers are kept. Thumbnail `src` swaps work on the parsed
  attribute. Images whose only source is refused are dropped; refused hrefs
  are removed rather than rewritten to `#`.
- Agent-ready editor fields: `ContentTitleField`, `ContentStatusFields`,
  `ContentMetadataFields` and `ContentBodyEditor` name and label every control,
  so they register with the form control registry and agents can propose
  edits for review. `mode: 'simple' | 'full'` (and a `fields` allow-list) hides
  advanced fields for everyday editors.
- `ContentBodyEditor`: an `imagePanel` snippet above the story, thumbnail
  placement helpers (`placeThumbnailInBody`, `removeThumbnailFromBody`,
  `bodyHasThumbnail`, `thumbnailPlacementForSize`), even toolbar icons, and
  44px toolbar and review-status buttons on touch screens.
