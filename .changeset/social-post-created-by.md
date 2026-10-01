---
'@happyvertical/smrt-social': minor
---

`SocialPost` records who posted it: a nullable `createdByUserId`
(crossPackageRef to smrt-users User, native uuid on PostgreSQL) that
`createDraft()` accepts. Publish-outcome helpers never change it; agent and
scheduled posts leave it null. **New column: run `smrt db:migrate`.**
