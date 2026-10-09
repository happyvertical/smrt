# @happyvertical/smrt-comments

Record discussions attach to arbitrary records through `Comment`'s inherited
`metaType` and `metaId`; preserve these as a qualified polymorphic pair and
never replace them with a text foreign key. `CommentService` owns persistence
and invokes the optional mention adapter only after the comment is saved.

The package must not depend on `smrt-messages`: hosts compose
`CommentMentionNotificationAdapter` with `UserNotificationService` and retain
their own notification delivery policy. The Svelte surface receives authorized
comment projections and callbacks; it does not fetch or authorize records.

Run `pnpm --filter @happyvertical/smrt-comments test`, `typecheck`, and
`npx --yes @biomejs/biome@2.5.2 check packages/comments` after changes.
