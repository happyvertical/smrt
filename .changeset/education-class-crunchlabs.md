---
'@happyvertical/smrt-education': minor
---

Class CrunchLabs source: `buildClassCrunchLabsBundle` reads a unit download (a folder or Drive zip parts; `folderClassCrunchLabsSource`) into manifest v2 bundle parts with roles and audiences, mission-log pages and YouTube references matched from an injected course playlist. `createClassCrunchLabsCatalogAdapter` lists units under Science as an operator-only provider (new `operator` catalog visibility via `CatalogPolicy({ operatorTenantIds })`, licence "free curriculum, permission pending") until the operator sets the single `publicListing` switch; `addClassCrunchLabsUnit` runs the import into the family's course. Files are never hosted.
