---
'@happyvertical/smrt-profiles': minor
---

Profiles can hold ordered web links. New `ProfileLink` model (`profile_links`:
`platform` from `PROFILE_LINK_PLATFORMS` — facebook, instagram, x, linkedin,
youtube, tiktok, website, other — a validated http(s) `url`, optional `label`,
`sortOrder`, tenant-scoped) with `profileId` declared `onDelete: 'CASCADE'`.
A link's slug is its id, never its address or label. `ProfileLinkCollection`
adds `listForProfile()`, `replaceForProfile()` (ordered add/keep/remove in one
transaction, new links take the profile's tenant) and `reorder()`; `Profile`
gets `getLinks()` / `setLinks()`. `Profile.isPublic` (boolean, default false)
is a new public-figure flag. Additive schema: one new table and one new
column; run `db:migrate`.
