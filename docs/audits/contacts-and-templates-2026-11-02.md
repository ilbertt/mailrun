# Original contacts, identity updates and saved templates

Mailflare `71aa49b` (v0.5.2) is the reference. Native contact responses omitted
persisted fields, manual renames overwrote last-seen timestamps, and blocking
checked only its deterministic rule ID. Cross-domain personal-identity lookup
also ignored normalized claims by other mailboxes and aliases. Template
validation differed and deletion left attachments and raw MIME files behind.

## Reference evidence

`tests/source-contacts-templates-contracts.json` captures 115 unmodified original
handler calls with genuine Bearer-session authentication and the original
SQLite/FileBucket adapters. Handler and supporting source hashes are pinned.
The harness supplies only environment bindings and a synthetic Gravatar 404;
all other external requests fail. No real mailbox, provider credential or
external service participates.

Each case compares the status/body, all contact/rule/attachment rows, original
message columns, account and mailbox identity fields, and complete remaining
object keys and hashes. Dynamic message IDs and current timestamps are
normalized. Native queue/cache/revision metadata is internal and outside these
source-column snapshots.

Cases include all shared grant levels and unshared/unknown roles, disabled or
personal mailboxes and inactive team licensing; missing/blank/normalized and
non-email contact strings; manual/new contacts and unchanged timestamps;
primary/secondary identities, explicit/cross-domain aliases, active domains and
normalized mailbox/alias claims including disabled claims; owner-only identity
changes; equivalent existing blocking rules with different IDs, disabled rules
and domain-scoped rules; template validation/truncation, sender grants, list
ordering and the 200-item limit, author/status isolation, and deletion including
active/trashed attachments and raw MIME.

```sh
bun scripts/capture-source-contacts-templates.ts /path/to/original-71aa49b
bun test tests/source-contacts-templates.test.ts tests/contact-template-guards.test.ts
bun scripts/smoke-contacts-templates.ts dist/mailrun-local
```

This captures original handler behavior, rather than Next's outer error framing.
Malformed scalar/object field types, cookie/origin combinations, successful
Gravatar import and the full rendered workflows are outside this comparison.

## Native changes

- Return original persisted contact fields, timestamps and identity overlays.
  Missing contacts retain their original smaller fallback response. Use the
  first query parameter value and source validation/permission errors.
- Rename existing contacts without changing their timestamps. New manual and
  profile-sync contacts retain NULL last-seen values. Identity sync updates the
  primary mailbox and preserves secondary mailbox names/avatars.
- Use one typed address-claim resolver for personal identity lookup and sync.
  Normalized dot/plus claims by other mailboxes and aliases reserve their domain
  even when disabled. Explicit aliases remain explicit and cross-domain names
  require an active domain belonging to the primary domain owner.
- Reuse an equivalent email/exact/trash rule for the selected mailbox, as the
  original does, without changing its enabled/scope/priority metadata. The
  original and native rule scope both default to `mailbox`.
- Match template content/title validation order, 200-character truncation,
  required sender errors, persisted values, owner-only lists and source order.
  Deletion removes all associated file rows and unreferenced objects, including
  trashed attachments and raw MIME.

Mutation transactions fence current grants and identity/contact/rule writes.
Template sender lookup, current account name and permission-based formatting run
in that same write transaction; a grant change cannot leave an earlier send-as
identity on a newly saved template.
Avatar fetching stays in the native local background dispatcher. A focused
failure guard rejects rule publication and proves the contact and avatar job
roll back together. A second guard proves deletion retains objects referenced
by another imported message. A publication-boundary permission downgrade guard
checks that the sender uses the current on-behalf permission and account name. The existing shared-object guard is
intentionally retained rather than deleting another message's data.

No persisted table, migration, backup table/group or backup format changes.
Original components, styles and route templates are unchanged by this patch.

## Verification and remaining scope

All 115 direct source comparisons pass, as do the three native failure/object
retention/permission guards. The compiled local server matches all 115 over real HTTP
with genuine session auth, checks restart and performs no external delivery.
SQL generation/checking, TypeScript and the local production build pass.

The first restricted full-suite run could not start four local TCP/IMAP
fixtures; it was rerun with local socket access. A new shared-object test fixture
initially violated the attachment-key uniqueness constraint; it now uses valid
cross-message raw-object references and passes. The final complete
host suite passes all 1,410 tests (67 files), SQL checks and TypeScript. The
compiled avatar dispatcher rehearsal also passes automatic import, MIME/cache,
preview/conditional responses, shared access, live refresh, private-contact
isolation and maintenance recovery against isolated providers. Native Linux
and deployment results follow when available.

The first push CI run (41465985204) passed 1,409 tests, including every new
contact/template comparison, but failed the existing MCP concurrent-draft
fixture's multiple-observed-revisions assertion. Its timing-dependent read loop
observed only one revision; the independent PR run passed. The
fixture now keeps the independent writer active and acknowledges a committed
checkpoint between read batches. It retains all 60 body/revision coherence
assertions and the multiple-version assertion. Twelve repetitions pass on the
host and in a network-isolated Linux Bun container; this changes test
coordination only.

Push CI 41467456024 passes all 1,410 tests, SQL/types and every compiled
rehearsal, including the 115 HTTP contact/template cases. Its independent PR
run timed out the existing setup retry/cleanup fixture at the default five
seconds; the unfinished registration then interfered with the next fixture.
That test deliberately exercises the real bounded relay-health retry/backoff.
Its test budget is now 15 seconds, matching other provisioning tests, with
all behavior assertions and production retry timing unchanged. Retry cleanup
and the following serialized registration pass together on host and isolated
Linux. Final release verification follows below.


[Final Ubuntu CI 41472303212](https://github.com/ilbertt/mailrun/actions/runs/41472303212)
and the independent PR run 41472316710 both pass. All 1,410 tests, generated
SQL/coverage, TypeScript and every compiled HTTP/WebSocket/parity rehearsal pass,
including all 115 contact/template cases and restart. The selected one-CPU,
256-MiB/no-swap rule workload still passes: 116,609,024-byte cgroup peak and zero
OOM kills. This is not whole-guest cold/concurrent resource proof.

Source `2538828` was deployed on November 2 to the existing preview through the
nibrun CLI's checksum-verified archive fetch. The artifact from final CI was
also downloaded privately and its executable checksum verified before release.
Executable SHA-256:
`c29487079ed64ea2a100275c32dd764fff683e038c67f5a5fd357ce62c9b784a`;
119,338,976 bytes. Artifact archive 13156730432 has digest
`fd151f6babb8a671b2fbd149b4193ae1bb6fd696846d5fc70f7e01c60ecd2ddf`.
Deployment `01a19ce8-576d-7639-a38d-e7cc44b19884` is running.

Post-deployment checks confirm login/setup HTTP 200; one account and five
messages intact; ready installation and active ilbert.dev routing/sending;
email relay HTTP 200 with a successful signed callback; and all three UTC cron
jobs registered against this deployment. A status sample reports 42,369,024
bytes in use; this is not a peak measurement. Release checks used read-only
queries and health requests, with no live send, mailbox mutation, credential
change, restore or reset. The previously approved private recovery export was
retained without another download.

Broader source/provider/client and cookie/origin/malformed-input matrices,
rendered/mobile/keyboard workflows, full data cutover, and whole-guest
cold/concurrent memory/capacity verification remain open. Native author-only
draft protections remain pending the existing owner's permission choice.
Selected matching captures do not establish full parity.
