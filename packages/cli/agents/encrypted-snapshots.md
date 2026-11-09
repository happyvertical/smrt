# Encrypted snapshots (HVSF v1, #4797)

`smrt app backup --encrypted` and `smrt app export --encrypted` write one
encrypted snapshot file so a backup can leave the machine (a file, the user's
Drive, the vault) without the target reading it. Plaintext stays the default.
Source: `src/app/snapshot-framing.ts` (framing, `writeEncryptedSnapshot`,
`verifySnapshot`, `decryptSnapshot`) and `src/app/snapshot-archive.ts` (the
data-root archive). Both are exported from `@happyvertical/smrt-cli/app`.

## Keys

Keys come only from an injected `SnapshotKeyProvider`
(`AppCommandDependencies.snapshotKeys`; the vault key lifecycle, #4785,
supplies it). `sealingKey()` returns account, device, key generation, key ID,
a 32-byte key and a fresh snapshot sequence; `openingKey({ accountId,
generation, keyId })` returns the key for any retained generation, so
snapshots sealed before a rotation stay readable. The framing takes ownership
of returned key bytes and zeroes them. No provider means `--encrypted` fails
closed. Keys never appear in arguments, environment, output or errors.
A provider whose host owns the sequence counter may add
`advanceSealingSequence(above)` (`createLifecycleSnapshotKeys` offers it when
given `advanceSequence`); `restore-latest` calls it with the relay head so a
restored device's next seal is above it.

The raw vault data key is never used to seal or open an envelope. Each
operation derives one purpose subkey, `HKDF-SHA256(dataKey, salt = empty, info =
"smrt-hvsf-v1", 32 bytes)` (`deriveSnapshotSubkey`), uses it for every record
and zeroes it. An HVSF envelope therefore does not authenticate under the raw
data key, under another HKDF label, or for any other consumer of the same data
key; the key ID in the envelope still names the data key.

## Format

```text
header (72 bytes fixed + device ID, clear)
  "HVSF" | version 1 | kind (1 data-root, 2 export-bundle)
  | device ID length u16 (1 to 255)
  generation u64 | sequence u64 | key ID (16) | snapshot ID (16, random)
  chunk size u32 | chunk count u32 | total length u64
  producing device ID (UTF-8, no control characters)
record × (chunk count + 1): length u32 | SDK v1 vault envelope
```

Every envelope uses the SDK v1 envelope (`@happyvertical/encryption/
vault-snapshot`, no compression), sealed with the HKDF subkey above, with context `{ accountId, deviceId,
sequence }`. Its payload is a copy of the 72-byte fixed header (which includes
the device ID length; the device ID itself is authenticated by the envelope
context), record type (1 chunk,
2 manifest), record index u32, then the chunk bytes or, for the manifest,
total length u64 and the SHA-256 of the plaintext. All chunks except the last
are exactly the chunk size. Integers are big-endian.

`data-root` plaintext is an HVSA v1 archive: `"HVSA" 0x01`, then entries
`type u8 (1 dir, 2 file) | path length u16 | UTF-8 relative path |
(file) size u64 | bytes`, ending with type 0. Only directories and regular
files; a symbolic link, special file, or a name restore would refuse (a
backslash, or invalid UTF-8) fails the backup up front, so every successful
backup is restorable. All writes loop until complete and the written size is
checked before publication.
`export-bundle` plaintext is the logical bundle JSON.

## Clear header metadata

Anything in the file header is readable by whoever holds the file, including a
relay that stores it without parsing it. It is: format version, kind (data root
or export bundle), key generation, snapshot sequence, key ID, random snapshot
ID, chunk size, chunk count, exact plaintext length, and the **producing device
ID**. The device ID is clear on purpose: a device lost with its laptop must not
take the knowledge of which device produced the file with it, and a new device
restores with only the file and the vault key. It is already visible to the
relay as the authenticated uploader. Account ID, plaintext and keys never
appear. `readSnapshotHeader` returns these fields without authenticating them,
and `snapshotReport` (backup and export output) prints the device ID next to
the sequence.

## Limits

Chunk size 4 KiB to 8 MiB − 77 bytes (default 4 MiB); total plaintext at
most 1 TiB; chunk count at most 2³² − 1. Memory is one chunk plus one envelope.
The data-root archive streams, so encrypted backups avoid the logical export's
512 MB bundle and 256 MB asset limits; an encrypted export still builds the
bundle in memory under those limits.

## Restore and failure modes

`decryptSnapshot({ source, destination, context, keys, minimumGeneration?,
expectedKind? })` requires the account ID (it selects the vault key). Device ID
and sequence are optional in `context`: omit them to restore on a new device
from the file and the vault key alone (they are then taken from the header and
authenticated by every envelope), or pass them, for example to enforce
rollback protection from trusted state, and the file must match exactly.
Before any key lookup or allocation it checks the header bounds, sequence,
optional generation floor and kind, and that the file length equals the exact
length the header implies. Each record must have its exact expected length,
the header's key ID, authenticate under the expected context, carry an
identical header copy, and the expected type and index; the manifest must
match the count, length and digest, with no trailing bytes. So truncation,
reordering, duplication, cross-snapshot splicing, wrong context, header edits
and key generation substitution all fail.

Plaintext is staged in an owner-only sibling (`.<name>.<pid>.<random>.partial`)
and published only after the manifest verifies: a `data-root` snapshot becomes
a new 0700 candidate directory (0600 files), an `export-bundle` a new 0600
file. Any failure removes the staging path; `destination` is never replaced and
the live state root is never swapped (restore-latest is a later slice).
Encrypted bundles cannot be passed to `smrt app import` yet; decrypt first.
Writing uses an owner-only ciphertext temp file published with `link()` and
removed on success or failure. Snapshot length is public; callers needing
rollback protection track accepted sequences in trusted state.
