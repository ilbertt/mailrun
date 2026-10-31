# Original record restore with local object state

A restore of an original `71aa49b` full record document reproduced two failures
on an already migrated app: the three uploaded JMAP blobs lost their native
metadata, and a pending Drive upload reverted to provider identifiers that could
not address the migrated parts. Drive completion returned 409. A separate test
also showed the restore deleting native email relay configuration, which the
original app keeps in deployment bindings outside its database.

## Original evidence

`tests/source-record-restore-capture.json` comes from the unmodified original
uploader, full exporter/restorer and FileBucket. Their pinned hashes are recorded.
The capture creates uploads and a pending multipart part, exports records, then
restores those records into a second original database. It uses a separate copy
of the bucket to read all three blobs and complete the pending upload. The MIME,
content types, names and byte hashes survive; completed Drive content is `abc`.
The frozen source bucket remains unchanged. No external request or email is sent.

```sh
bun scripts/capture-source-uploads.ts /path/to/original-71aa49b \
  tests/source-record-restore-capture.json --restore
```

## Changes

Original documents omit the native `mailrun_jmap_uploads` table because the source
keeps this metadata beside its objects. Before a legacy restore, committed native
upload metadata is copied to private per-object sidecars under
`restore-object-metadata/`. Reads use 500-row pages. Restore streams those sidecars
into the missing table inside the same SQLite transaction as the record restore,
without buffering the entire upload catalog. Only restored account IDs with a
matching object namespace and an existing file of the expected size are eligible.
Metadata for an account omitted by one restore can be reused when a later original
document restores that account, provided the object still exists. An explicit
native upload table, including an empty one, remains authoritative.

The source importer also records the original-to-native pending Drive identifiers
and part tags in `source.json` beside each migrated upload's active parts. A
historical document can reapply those exact mappings. Identity, owner, object key,
size, part size and original part tags must match. Unknown mappings fail before
replacing records; normal native backups keep their own identifiers unchanged.
Completion still verifies actual part hashes. Completion, abort and expiry remove
the active part tree and its mapping together; deleted parts are not resurrected.

Original documents also omit the native relay installation. Restore retains the
current installation in that case and carries forward only known domain bindings
for the same owner/hostname/zone and ready Worker. Older native documents with a
ready primary installation but no binding columns use the same exact-primary-zone
rule as migration 0068. Explicit native empty installation data or explicit null
bindings remain authoritative. Imported routing flags alone do not establish a
new relay connection. No provider resources are changed by restore.

The generic record parser still validates table names. An optional missing-table
row provider joins the existing parent-first transaction; late metadata errors
roll back users, mail and the rest of the restore. No schema migration, persisted
table, backup table/group list or format version changes. Object sidecars belong
to the persistent volume alongside the objects; a records-only file does not
contain or replace those bytes.

## Verification

```sh
bun test tests/source-record-restore.test.ts
bun run smoke:source-record-restore dist/mailrun-local
```

Focused checks cover legacy object retention, account removal/reintroduction,
explicit native empty snapshots, mismatched Drive tags, invalid cross-user object
metadata with full transaction rollback, relay credential/binding retention,
old-primary-only inference, explicit unverified bindings and a 504-upload catalog
crossing the page boundary.

The standalone rehearsal uses the compiled importer and actual multipart
`/api/backups/restore` request. It verifies the old session is invalidated, signs
in again, creates fresh client keys, performs nine original blob downloads across
two restarts, checks cross-user denial, completes Drive and verifies its content
before/after restart, retains seeded relay settings, and checks every frozen
source file's hash. It uses synthetic accounts and credentials exclusively.

The full host suite passed 807 tests before the added paging regression; all 11
focused restore cases, strict TypeScript and SQL checks pass. Existing standalone
upload/retention, populated-feature and normal HTTP/WebSocket rehearsals also pass.
The added compiled restore rehearsal runs in Ubuntu CI before artifact upload.
Linux results and deployment are pending for this checkpoint.

## Limits and remaining scope

Mappings are created by the updated source importer. A previous import that did
not retain the original Drive mapping needs the matching frozen source metadata
before its provider-tagged historical records can be translated safely. Metadata
already lost by a previous broken restore cannot be recreated from database
records alone. Both object metadata and bytes must accompany a volume recovery.
Restoring records cannot recover parts already completed/aborted/deleted in the
source or native store. These limits are separate from ordinary native full
backup restore, which preserves its explicit upload records.

The broader goal remains open: live R2 materialization/cutover, remaining
permission/handler/mutation combinations, rendered/mobile UI and client
interoperability, and native guest resource/cold-start gates are not proved by
this restore rehearsal. The original shared draft-body permission choice is
still pending.
