# Populated original feature state

The new `source-features-capture.json` populates all 43 original backup tables,
with 54 linked records and 648 source fields. It complements the smaller historical
upload/retention fixture. The checked-in SQL seed runs against the unmodified
`71aa49b` schema, uploader, FileBucket and full-record exporter. Their pinned module
hashes and the seed hash are recorded. The original Node/Next server then supplies
24 actual GET responses over that database and its real bucket objects.

The fixture covers mailbox grants/aliases, contacts/avatars, scoped keys, sessions,
push/reset/MFA records, routing, webhook retries, backup history/settings, branding,
composer/legacy templates, calendar recurrence, booking availability, auto-reply
history, spam training, assistant history/jobs/drafts/approvals and Drive sharing.
A pending assistant approval has a valid attachment-backed source snapshot; the
original handler confirms it is not stale. Pending jobs are deferred to 2100.
No confirmation, mail delivery, push delivery, webhook delivery or model request
is triggered. Helper outbound requests are blocked; the source HTTP server also
runs with outbound fetches blocked. All credentials and addresses are synthetic.

## Imported state and exposed gaps

The standalone importer preserves every source table count and compared scalar
field before normal startup. Drive upload IDs/part ETags are the two documented
translations; the existing upload rehearsal independently exercises multipart
completion. All 12 ordinary objects and 26 files, including original sidecars and
a pending part, are captured. Restored Drive and historical backup downloads match
original contents; the assistant approval also independently validates its draft
attachment hash.

Restored feature checks exposed and corrected four response gaps:

- Mailbox lists now include the original creation time, disabled flag and
  use-all-domains flag. GET also repairs an account lacking any enabled owned
  personal mailbox, as the source does. It creates the account-address mailbox
  only when that domain exists and the address is unoccupied. An existing owned
  personal mailbox suppresses repair, even when its address is different. Atomic
  SQLite conditions avoid duplicate creation. Failure retains the current list;
  the domain relay resolves newly created addresses locally.
- Inbox rule responses return all original fields, including ownership, enabled
  state, name, scope, forwarding/retention options and match history.
- Draft responses include owner/status and complete attachment metadata. The
  migration-only body revision field is removed; native optimistic concurrency
  continues through its existing response headers. Agent revision/scheduling
  metadata remains independent and preserves the original values.
- Historical backup downloads retain the source's legacy `application/sql`
  content type and `.sql` fallback filename, while preserving the JSON record
  bytes. The stored filename takes precedence.

The original mailbox GET creates a new personal mailbox as a side effect, so its
random ID/time are normalized only for that new row. Original records and every
other field remain exact. A separate assertion checks one persisted personal
mailbox, a current creation time and stable identity on repeated listing. No
persisted table, schema migration or backup table/group list changes.

## Verification

```sh
bun scripts/capture-source-uploads.ts /path/to/original-71aa49b \
  tests/source-features-capture.json tests/source-feature-state.sql
bun test tests/source-feature-import.test.ts
bun run smoke:source-features dist/mailrun-local
```

The host executable imports into a new directory, compares all 43 tables and 648
fields, then matches the 24 original feature responses before and after restarting
(48 comparisons). Reads include restored session authentication, branding,
mailboxes/aliases, rules, webhook retries, backup inventory, composer templates,
calendar/booking, assistant settings/history/deferred jobs, a valid pending
approval, draft data, Drive sharing/content and a historical backup download.

A second native full-backup/restore roundtrip preserves every populated imported
record and the native upload metadata, comparing every backed-up table/field and
checking foreign keys. The source-owned comparisons remain 54 records/648 fields.
The existing original-upload rehearsal still passes its downloads, restarts,
single-use MIME claim, Drive completion, retention and unchanged-source-object
checks. The regular host HTTP/WebSocket suite and all 797 behavioral tests, SQL
coverage and strict TypeScript pass.

## Linux and remaining gates

Local Docker is unresponsive. Existing Ubuntu CI is therefore expanded to run the
compiled read/detail/upload/populated-feature rehearsals in addition to the full
suite and normal HTTP checks. Successful push runs retain the exact tested Linux
binary and checksum for one day; deployment can use that artifact. Linux results
and the preview update remain pending until this commit's CI completes.

This establishes a populated representative state for every original table; it
does not prove every value/combination, mutation or external integration. Restore
of historical source documents containing provider multipart IDs still needs a
separate object-state audit; downloading the preserved historical document does
not prove that restore workflow. Live R2 export/cutover, mobile/rendered previews,
external client interoperability, remaining permission/handler matrices and native
nibrun resource/cold-start gates remain open. The original draft-body visibility
choice is still pending.
