# Keychain vault key store

`src/keychain-vault-key-store.ts` seals vault items under a key held in the OS
keychain. The desktop wrapper opts in with `SMRT_DESKTOP_KEYCHAIN=1`;
otherwise `secretMasterKey()` uses the file store.

- Fails closed: when sealed items exist without a readable keychain key it
  throws. It never falls back to the file store and never generates a new key
  over existing sealed items.
- Tests use fakes only (`keychain-vault-key-store.test.ts`); never touch the
  real keychain.
