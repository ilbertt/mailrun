# Original JMAP identities and submissions

Mailflare `71aa49b` (v0.5.2) submits a draft through its shared sender, creates an
independent Sent/failed copy and removes the original draft only after success.
A later cleanup failure does not turn successful delivery into a failed
submission. The previous native JMAP path used a separate payload and changed
the original draft's status before transport, adding observable revision writes.

## Reference evidence

`tests/source-jmap-submission-contracts.json` captures 80 executions of the
unmodified original JMAP HTTP route, authenticator, processor and sender through
the original SQLite adapter and FileBucket. API keys use genuine bcrypt checks.
Synthetic mail/queue bindings record bytes and provider failures; Gravatar
returns 404, and other external fetches fail. One object-store delete failure
and one SQLite trigger failure exercise the original post-send cleanup path.
Original module hashes include authentication, JMAP identity/state/revision/ID
logic, shared send/attachment/cleanup code and both storage adapters.

Cases cover owner and all known sharing grants, unknown legacy grant metadata,
disabled mailboxes/accounts, personal/shared ownership, licensing, Bearer/Basic
and invalid credentials, mixed/wildcard/missing scopes, explicit/empty/unrestricted
mailbox grants and MCP-kind keys with a legacy flag off. Method cases cover
Identity get/filter/changes/forbidden mutations, Submission get/query/changes,
invalid/missing identities and drafts, aliases, account boundaries, duplicate
submissions, creation references, multiple methods and implicit Email/set results.

Draft/file cases cover missing/trashed objects, recorded versus actual size,
attachment count/outgoing limits, filename/MIME/CID handling, raw MIME cleanup,
assistant metadata, foreign drafts/mailboxes, status/direction, null/blank/long
subjects, bare/single-label/empty recipients, empty/HTML bodies, threading and
deduplication. Provider failure and a first-failure/second-success batch verify
editable originals, independent failed copies and successful cleanup.

The initial 78-case baseline matched 33 and differed on 45. The expanded 80 cases
compare HTTP responses, exact revision tokens, source message/job/file/contact/
audit fields, provider wire data, complete object keys/hashes and key usage.
Generated IDs normalize as in the existing send captures; current sendAt values
are checked against the request time window before normalizing. Other revision,
thread, body, error, permission and object fields remain observable.

```sh
bun scripts/capture-source-jmap-submission.ts /path/to/original-71aa49b
bun test tests/source-jmap-submission.test.ts tests/jmap-submission-guards.test.ts tests/submission-draft-backups.test.ts
bun scripts/smoke-jmap-submission.ts dist/mailrun-local
```

## Native behavior and durable cleanup

JMAP uses the shared source-compatible publication service. It preserves the
original payload, sender/recipient/thread/contact behavior, safe stored names,
submitted transport metadata and actual file bytes. The service accepts header
lists and nullable threading fields supplied by protocol callers. It applies
the original 998-character subject bound before contact updates. Bare legacy
recipient strings follow the original service behavior; public/session request
schemas still apply, and CR/LF header guards remain.

The original draft remains unchanged while sending. Migration 0071 adds
`mailrun_submission_drafts(job_id,draft_id,draft_revision)`, keeping reservation
and cleanup intent outside the original transport payload and message revision
counters. Publication atomically checks current keys/grants and draft revision,
creates the independent message/job/files and records their draft association.
Existing draft leases and JMAP/UI/assistant mutation guards protect both copies
while the operation is active. Competing transport claims remain atomic.

Delivery records provider acknowledgement and completes its normal audit work
before cleaning the original. Cleanup removes attachment objects, then MIME,
then the matching draft, following source failure ordering. Newer draft
revisions and keys still referenced by other storage owners are retained.
Cleanup failure preserves the sent job and its successful JMAP response. If
another cron process claimed the job, the request waits for its recorded outcome
instead of assuming an unclaimed delivery succeeded.

Scheduled cron also recovers acknowledged submissions with completed audit
evidence, without calling transport again. An abandoned post-ack association
without audit evidence retains its original draft; after 180 seconds and expiry
of its active draft lease, recovery releases that reservation for review. It
does not resend or erase the draft. Earlier Bun-only job envelopes retain their
existing compatibility and cleanup path.

Unknown historical grants can expose source identity/state metadata. Body,
query, thread and download access still require a recognized read grant; the
legacy owner fallback cannot bypass an unknown mailbox grant. Author-only draft
body/file access remains in place.

## Backup and restore

The new ledger is durable intent and belongs in backups. `BACKUP_TABLES` places
it after its `outbound_jobs` parent, `BACKUP_TABLE_GROUPS` includes it exactly once
in Mail, and `DatabaseBackupTable` includes its name. `INTERNAL_TABLES` was
reviewed; the ledger is not excluded because its association cannot be derived
from the source-format payload. No draft foreign key is used, so recovery can
finish when that draft was already removed. Deleting a job cascades its ledger.

Tests restore old full documents both before and after 0071, round-trip native
pending/orphan associations, verify parent-first order and single group coverage,
and check foreign keys and deletion behavior. Existing 0070 backup tests and
migration rollback/concurrent-upgrade/permission tests still pass. The compiled
source-outbound rehearsal now verifies original-schema startup through 0071 and
is explicitly included in CI.

## Verification and remaining scope

All 1,995 host tests, generated SQL/coverage and TypeScript pass. The production
host build passes. Compiled HTTP comparison passes all 80 original outcomes,
including an actual filesystem permission failure for cleanup, then verifies
queued submission delivery after HTTP restart/key revocation, acknowledged
cleanup recovery and replay without duplicate provider calls. These recovery
fixtures represent persisted interruption states; they are not a new proof of
all process-kill timing windows. Ten guards cover mid-copy key/mailbox/revision
changes, audit-backed recovery, incomplete audit/active-lease behavior, newer
edits, shared objects and unknown-grant body/file denial under both key scopes.

The compiled 72 public-send, 83 session-send/cancel and 51 queued-worker
comparisons also pass, along with original source-job upgrade/cron/replay and
original full-record restore, relay preservation, JMAP downloads and Drive
completion across restart. One new guard initially expected a plain-text 401;
the existing JMAP controller returns JSON. Its expected response was corrected,
retaining every publication, object and original-draft assertion.

[Native Ubuntu CI 41625247338](https://github.com/ilbertt/mailrun/actions/runs/41625247338)
and independent PR run 41625255487 pass all 1,995 tests, generated SQL/coverage,
TypeScript and every configured compiled rehearsal. The 80-case JMAP HTTP and
restart/recovery checks, original source-schema upgrade through 0071, record
restore and existing public/session/worker contracts pass natively on Linux.
The selected one-CPU/256-MiB/no-swap rule workload reports 114,823,168-byte cgroup
peak and zero OOM kills; it does not prove whole-guest cold/concurrent capacity.

A fresh pre-0071 full recovery export was saved in the previously approved private
folder as `before-jmap-submission-0071.tar.gz` (53,597,904 bytes, mode 0600,
directory 0700). Its private database copy passes integrity and foreign-key
checks and contains one account/five messages with 0071 and the ledger absent.
Query-only validation used local read/write access for WAL bookkeeping; the
archive remains unchanged. The archived executable also matches the previously
verified source `391d6c3` binary, and the environment is present without secret
values being displayed. A later post-interruption check found this temporary
directory absent; that local archive is no longer available. A fresh current
export, `before-identifier-parity.tar.gz` (53,609,521 bytes, mode 0600), now
exists in the same approved private location. Its executable matches this
release, environment is included privately, and its query-only database copy
passes integrity/foreign-key checks with one account/five messages, 0071 applied
and an empty ledger. This current copy is after the JMAP upgrade; it does not
replace the missing pre-upgrade snapshot.

Source `51b0a91` was deployed on November 3 through the nibrun CLI to the existing
preview, deployment `01a1a129-4227-72d3-9d7f-bcb3029c6dbe`. The complete local
Linux ELF download matches its CI manifest: 119,424,992 bytes, SHA-256
`bd9a291066afaf1b4363a28ace6135822ef7bc6eaf55c7b581e55a94e907b462`.
Artifact 13225966299 has archive SHA-256
`75418c69d312462f602090c521d1861fba88d2afc5acc5a99cd1dda84be72102`;
the CLI uses that digest for verified server-side archive fetch. Deployment
started after local download/checksum verification completed.

Pre-release checks found zero queued/sending jobs and active domain operations,
with one account/five messages. Post-release checks verify those data totals,
ready installation, 0071 applied once, an empty submission ledger, complete
linked transport snapshots and active ilbert.dev routing/sending. Login/setup
return HTTP 200, the existing Cloudflare Worker returns HTTP 200 with a successful
signed callback, and all three UTC cron registrations belong to the new
deployment. These release checks used no live email, mailbox/message mutation,
credential/provider edit or restore/reset. The only live schema change is the
additive, tested ledger migration.

Generated identifier format was an app-wide gap at this checkpoint: the original common ID
helper uses NanoID, while the former native helper used UUIDs and some
prefixes differed. The captures' generated-ID normalization does not prove format
or prefix parity. The later [identifier audit](identifiers-2026-11-03.md) adds format checks to
these captures and corrects the common generator and identified writer prefixes.

Assistant/calendar and other producer matrices, wider protocol/allowed-handler
and wire/MIME/provider cases, successful external client interoperability,
rendered/mobile/keyboard flows, original-data cutover, whole-guest cold/peak/
concurrent capacity and the original Vinext/Cloudflare performance baseline
remain open. Historical missing transport/provider metadata requires its frozen
source counterpart. The owner's shared-draft-body permission decision remains
pending. This audit does not establish full parity.
