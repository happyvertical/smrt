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

## Relay-visible metadata

Anything in the file header is readable by whoever holds the file, including a
relay that stores it without parsing it. It is: format version, kind (data root
or export bundle), key generation, snapshot sequence, key ID, random snapshot
ID, chunk size, chunk count, exact plaintext length, and the **producing device
ID**. The device ID is clear on purpose: a device lost with its laptop must not
take the knowledge of which device produced the file with it, and a new device
restores with only the file and the vault key. It is already visible to the
relay as the authenticated uploader. Account ID, plaintext and keys never
appear in this file header. `readSnapshotHeader` returns these fields without authenticating them,
and `snapshotReport` (backup and export output) prints the device ID next to
the sequence.

The relay is blind to **content**, not to metadata or account activity:

| Surface | Visible to the relay or storage operator |
| --- | --- |
| HVSF file | All clear fields above, record lengths/boundaries, encrypted record count, exact plaintext length and ciphertext length. Archived filenames, individual file sizes/counts, content and the plaintext digest stay encrypted. |
| Authenticated protocol | Account and device IDs, the device public key, request timestamps/nonces/signatures, snapshot sequences and upload IDs. The relay knows the account ID from authentication even though the HVSF file does not contain it. Storage keys and logs may use a derived account handle; hashing a handle does not hide linkage between that account's requests. |
| Upload/storage | Transport chunk size/count/index, uploaded and retained byte/count totals, ciphertext SHA-256 digests, creation/expiry/retention/deletion times, and which sequence is latest. Transport chunks are independent of HVSF's encrypted records. |
| Network/access | Request timing, sizes, frequency, download/delete activity, and any client network address/HTTP metadata exposed to the chosen deployment or its proxy. Devices and activity can be correlated within an account. |

No key material is sent to the relay. This format offers neither metadata
anonymity nor padding to hide lengths. Deployment logs must still follow the
relay's policy: no bodies, signatures, nonces or raw account IDs. Possession of
stored ciphertext alone does not reveal archived filenames or plaintext.

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

### Filesystem durability and capability

File contents are flushed before publication. A data-root restore flushes each
file (including empty files), then its directories from the leaves to the
candidate root before renaming the candidate. On POSIX, publication flushes the
containing directory after `link()` or `rename()` and also flushes the ancestor
entries created for a new destination parent. Destination ancestors must be
caller-controlled and stable during the operation; the filesystem and storage
must honor the OS flush requests. Tests check syscall completion order and
injected I/O failures, not a physical power cut.

Directory flushing in this implementation is POSIX-only. Windows retains
mandatory file flushes and the existing publication behavior, but success does
not promise crash-durable directory entries on Windows. POSIX file/directory
flush failures are reported, never silently accepted. A failure **after** a
successful link or rename leaves the complete verified artifact in place:
durability could not be confirmed, so the operation reports an error. Inspect
that artifact before retrying; an existing destination is still never replaced.
A crash may leave a private temporary name alongside a valid published file.

Publishing an encrypted file requires atomic hard links. exFAT and some network
mounts do not provide them; permission restrictions can also prevent them. The
operation then fails with an actionable error to check permissions or select a
filesystem/target supporting hard links, and removes its temporary file.
There is deliberately no copy-and-rename fallback: Node's portable rename can
replace an existing target, which would violate snapshot publication's
no-overwrite guarantee. Unexpected I/O errors retain their original cause.
