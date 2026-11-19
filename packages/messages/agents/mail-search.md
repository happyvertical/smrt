# Mail search and private correspondents (#5132)

- `MailSearchService({ db, tenantId, principal })` searches only accounts from
  `listAccounts()` with the `read` scope (owner, grant, tenant ceiling, host
  scope/account ceilings; fail closed). `accountIds` only narrows. Local reads
  are bound to those ids in SQL (`accountId in`), then run under
  `runWithMailSystemAccess` because the decision was made here with the explicit
  principal. Unowned accounts are not listed, so they are not searched.
- `search()`: keyword filters (text, from, to, subject, label, date, flags,
  attachment) are matched case-insensitively in memory over a bounded
  newest-first scan (5000 rows per call; `truncated`/`nextCursor` say more
  exist). SQL `like` is not used for user text (no escaping, case differs
  between SQLite and PostgreSQL). `mode: 'semantic'` ranks with
  `EmailCollection.semanticMatches()` (core `semanticSearchIds`, `where` applied
  before ranking); `Email` embeddings are opt-in (`autoGenerate: false`, hosts
  generate them) and an empty or unavailable ranking falls back to keyword.
- `searchProvider()` asks each readable account's server through the SDK
  `search()` (needs `@happyvertical/smrt-messages/providers/email`) and falls
  back to the local index per account (`fallbackAccounts` says why). Synced
  provider hits carry `emailId`.
- `Correspondent` (`correspondents`, tenant-required, generated surfaces off) is
  owner-private: unique `(tenant, owner_user_id, address)`, only `address` is
  required. `CorrespondentService.refresh()` recomputes counts, latest name and
  first/last contact from the mail the owner can read (the owner's own account
  addresses are skipped); it never creates or links a `Profile`.
  `list`/`suggest`/`get` only return rows seen in an account the owner can
  still read, so revoking access hides them before the next refresh.
  `linkProfile`/`unlinkProfile` are the owner's explicit choice (profile must
  exist in the tenant). `RecipientInput` takes a host `suggest` callback
  (typically `CorrespondentService.suggest()` for the signed-in user).
  New table: consumers run `db:migrate`.
