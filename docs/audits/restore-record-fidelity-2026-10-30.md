# Restore and original-record fidelity

A restore regression exposed corruption in both native backups and the offline
source importer. The original exported Trash timestamp `123` and an explicit
null Spam timestamp were replaced by the current time. SQLite's
`messages_trashed_at_ai` trigger initializes newly inserted Trash/Spam rows; plain
record insertion therefore treated historical records as new arrivals.

Restore now reapplies an explicitly exported `trashed_at` value inside the same
transaction, after inserting a Trash/Spam row. Bound values preserve both numbers
and null. Unchanged values do not cause a second update, and ordinary Inbox/Sent
rows need no repair query. All triggers remain enabled for search, revisions and
validation. Backups lacking the field retain the insertion default. A late invalid
foreign key rolls back the repair together with the rest of the restore.

No format version, migration, persisted table, column or backup table/group list
changes. Existing before/after-migration and older full-document restore checks
continue to pass.

## Expanded original export

The existing `tests/source-uploads-capture.json` is regenerated using the unmodified
`71aa49b` / 0.5.2 uploader, FileBucket and full-record exporter. Their pinned hashes
remain unchanged. The fixture now also includes historical Trash, unknown-age
Spam, a folder, valid original raw MIME and a stored attachment. Its source owner
has a 30-day retention preference.

The migration verifier checks all 43 source-exported table counts. Its 13 populated
records contain 207 compared fields across ten populated tables; the remaining
tables are empty. Source-owned values are compared before app startup or test
mutations. Only the documented Drive upload-ID/part-ETag conversion is excluded
from scalar equality, and actual multipart completion independently verifies its
native representation. Additional native-only columns/tables are not original
fields and are checked by the existing feature tests.

The released `b3789d7` executable reproduces the `messages` mismatch when importing
this exact source export. The corrected standalone host and Linux x64 executables
both pass the expanded rehearsal:

- Original table counts and populated scalar fields survive migration.
- Historical raw MIME and attachment downloads match source bytes.
- All three pending JMAP uploads retain their blob IDs, metadata and user scope.
- Restarts preserve downloads; MIME claim is single-use and retains original bytes.
- The original multipart Drive upload completes with its original fingerprint/data.
- Running the actual compiled maintenance job purges expired Trash and its raw MIME
  and attachment, while retaining explicit-null-age Spam and its raw MIME.
- Every frozen source object remains byte-identical after target maintenance.

The capture blocks external requests. Standalone Linux verification runs with
external networking disabled. No real mailbox or credential is used and no
external email is sent.

## Reproduction and limits

```sh
bun scripts/capture-source-uploads.ts /path/to/original-71aa49b \
  tests/source-uploads-capture.json
bun run smoke:source-uploads dist/mailrun-local
```

Use the Linux x64 executable on Linux. This check runs the actual compiled
`migrate-source`, HTTP server, restart and `jobs maintenance` entrypoints against
private disposable directories. Ordinary builds use the checked-in capture.

All 600 behavioral tests, generated SQL/coverage and strict TypeScript pass.
Normal host/Linux HTTP/WebSocket suites and 21 focused Linux backup/import tests
pass. Regressions cover explicit ages/nulls, legacy missing-field defaults, active
search/retention triggers rollback after a late reference failure and full documents on both sides of migration 0053.

This is a selected original-state rehearsal, not the complete original-data/R2
cutover. Most source tables remain empty in this fixture; branding, booking,
security, webhook, assistant and other populated-state combinations still require
the broader cutover audit. Mobile, interoperability, full permission/URL matrices
and native guest resource gates also remain open.
