# Original queued delivery and sender snapshots

Mailflare `71aa49b` (v0.5.2) authorizes the sender during submission and stores
the resulting sender in the job. Its queue worker uses that approved snapshot;
it does not reload a profile name or re-authorize mailbox/alias grants later.
The previous native worker changed those semantics, updated contacts again at
delivery and treated missing attachment objects differently.

## Reference evidence

`tests/source-queued-delivery-contracts.json` captures 51 executions of the
unmodified original `sendEmail`, record exporter and `processOutboundQueue`.
The original sender authorizer runs during actual enqueue. A deterministic
clock then advances and controlled changes are applied before the original
worker runs. The original full backup and object identities taken after enqueue
are retained for each case; native tests restore those records and exact bytes.
No queued job shape or authorization result is invented by a native producer.
Source module hashes, original queue-event counts and original failure details
are recorded. Mail/queue/Gravatar bindings are synthetic; external fetches fail.

Cases cover renamed profiles/mailboxes/delegated actors, disabled or demoted
accounts, revoked/downgraded shares, removed/retargeted aliases, expired licenses,
changed mailbox ownership, disabled/deleted mailboxes, deleted/edited messages,
nonqueued/missing jobs, current domain/provider state, future and millisecond
boundaries, provider failure and post-send audit failure. Attachment cases cover
inline/CID rules, missing/trashed/renamed objects, actual versus recorded size,
large-file links, valid/expired link reuse and failure after link preparation.

Comparison includes original message/job/attachment/contact/audit/link fields,
provider wire data and every object key/size/hash. Queue timestamps are fixed;
new audit/link IDs are normalized. Binary content is compared by byte length and
SHA-256 rather than embedding repeated multi-megabyte base64 strings. The
original failed-audit SQL text is retained as provenance; driver-specific audit
foreign-key error strings normalize to one logical post-send failure marker.
No ordinary provider/configuration error is normalized that way.

The initial 49-case comparison matched seven cases and failed 42. The expanded
51-case comparison now passes directly and through the compiled cron worker.

```sh
bun scripts/capture-source-queued-delivery.ts /path/to/original-71aa49b
bun test tests/source-queued-delivery.test.ts tests/queued-snapshot-guards.test.ts tests/outbound-snapshot-backups.test.ts
bun scripts/smoke-queued-delivery.ts dist/mailrun-local
```

## Native behavior

- Original-format jobs carry the source `userId`/`mailboxId` envelope. Their
  approved `from`, recipients, content and headers remain fixed after submission.
  Renaming or removing a later sender grant does not rewrite an approved send.
  Explicit cancellation/removal or a nonqueued job status prevents claiming.
- Delivery verifies the envelope author matches the job and preserves the exact
  stored deadline, including milliseconds. The currently selected provider and
  transport credentials still apply. As in the original binding path, local
  cached Cloudflare readiness flags do not override the transport attempt.
- Contacts retain submission-time data and later manual changes. Success sets
  the thread from the submitted thread or provider Message-ID, preserving the
  source message fields rather than reformatting/rebuilding them from live data.
- Missing objects are skipped for source-format jobs; trashed rows are excluded.
  Actual object size controls inline/link decisions, and CID/disposition output
  follows the source rules. Large-link preparation updates stored bodies before
  transport, even when the provider fails, and retains the original snippet.
- Record provider acknowledgement before audit/follow-up work. The original can
  send successfully and then fail an audit foreign key after mailbox/message
  deletion; the captured failure state retains provider/thread acknowledgement.
  Native now retains that evidence too. It does not retry a failed/sending/sent
  job automatically.
- Older Bun-only envelopes without the original identity fields retain their
  compatibility path and live sender checks. Producer/protocol migration and
  wider temporal matrices remain required before claiming every send path is
  identical. This is not a replacement policy for original-format jobs.

## Durable transport identity and backups

Migration `0070_outbound_transport_snapshots.sql` adds
`mailrun_outbound_snapshots(job_id,message_id)`. Cloudflare queue events retain a
message ID after the database link is set to NULL; cron needs that same durable
identity in SQLite. Existing linked jobs are backfilled, new jobs capture it in
an insertion trigger, and deleting a job cascades its snapshot. The message ID
intentionally has no message foreign key, so deleting a message cannot erase
the transport identity.

The table is backed up immediately after `outbound_jobs`, belongs exactly once
to the Mail group, and is in `DatabaseBackupTable`. `INTERNAL_TABLES` was reviewed;
the snapshot is not excluded because it stops being derivable after deletion.
Older full documents restore before and after the migration. Insertion capture
reconstructs missing snapshot tables from linked old jobs; explicit native rows,
including an explicit empty table, remain authoritative during restore.

Tests cover migration backfill, old full documents, native round trips after
message deletion, explicit native override/empty state, foreign-key checks and
single group membership. Existing migration rollback/concurrent-upgrade tests
include 0070. A historical orphan job whose original queue message ID is already
absent from both records and transport metadata cannot have that ID recreated;
such historical cutover state needs retained source queue information.

## Verification and remaining scope

All 51 direct source outcomes and the compiled cron state/wire/object comparisons
pass. Compiled tests restore original queued records, stop HTTP entirely, execute
independent cron processes and replay again without duplicate transport. Four
guards check both cancellation/claim winners, mismatched author rejection and
legacy Bun envelope checks. Existing source-send/cancel and imported source-job
cron rehearsals pass; their tests now advance the logical clock rather than
rewriting the original schedule to pretend it is due.

All 1,826 host tests, generated SQL/coverage, TypeScript and the production
build pass. The compiled original-record restore also passes relay preservation,
relogin, nine JMAP downloads, cross-user denial and Drive completion across
restart. Final native Linux and release evidence follows below. A fresh recovery export is saved at the
previously authorized private snapshot location as
`before-queued-delivery-0070.tar.gz` (53,589,528 bytes, file mode 0600, directory
0700). Its private database copy passes integrity/foreign-key checks and retains
one account/five messages with migration 0070 absent. SQLite query-only checking
used local read/write access solely to initialize WAL bookkeeping; the archive
remains unchanged. No credentials or message contents were displayed.


[Ubuntu CI 41531390753](https://github.com/ilbertt/mailrun/actions/runs/41531390753)
and independent PR run 41531401902 pass all 1,826 tests, generated SQL/coverage,
TypeScript and every compiled rehearsal. The 51 queued outcomes, concurrent
cron/replay, original send/cancel, first-start source-schema upgrade and record
restore all pass. The selected one-CPU/256-MiB/no-swap rule workload still passes
with 114,733,056-byte cgroup peak and zero OOM kills. This does not establish
whole-guest cold/concurrent capacity.

Source `0614ddb` was deployed on November 2 through the nibrun CLI's verified
archive fetch. The archive digest was checked during deployment; the separately
downloaded executable also matches its CI checksum. Executable SHA-256:
`ed8fd549ec089c7eedd758bc941836325c9e56375f86c55f7a2ddd26d75f456b`;
119,392,224 bytes. Archive artifact 13181129623 has SHA-256
`c19756bd4ea81aa9a1e367e6b7b113eea7a8815098fc9b534298a8f1bdcd3cba`.
Deployment `01a19e41-d494-7abf-9226-60005b6a437b` is running.

Pre-upgrade checks found no active send/domain operation or queued job with a
missing message link. Post-upgrade checks verify migration 0070 applied once,
zero linked jobs without a transport snapshot, ready installation, one account
and five messages retained, active ilbert.dev routing/sending, login/setup HTTP
200, email relay HTTP 200 with successful signed callback, and all three UTC
cron registrations. A memory sample reports 44,994,560 bytes in use; it is not a
peak measurement. Release checks used read-only queries and health requests,
with no live email, mailbox/message mutation, credential/provider edit or data
restore/reset. The only live schema change is the tested additive migration.

Original worker platform framing and transport timing, other provider/protocol
producer matrices, successful external interoperability, historical missing
transport metadata, full original-data cutover, paired rendered/mobile/keyboard
states and whole-guest cold/concurrent resource limits remain open. Native
shared-draft body protection remains pending the existing explicit owner choice.
Selected matching outcomes do not establish full parity.
