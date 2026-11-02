# Original mailbox lifecycle, lists and sharing

Mailflare `71aa49b` (v0.5.2) is the reference. Native creation imposed extra
username/normalized-address restrictions, changed duplicate errors and rejected
some source-supported owners. Collection order and sender-address order also
differed. Sharing combined distinct administrator/license errors, checked
mailboxes before invalid input, and prevented managing disabled shared inboxes.
Deletion changed existing outbound-job state and blocked some source deletions.

## Original evidence

`tests/source-mailbox-management-contracts.json` records 133 calls to unmodified
original collection, detail/delete and sharing handlers, authenticated with real
Bearer sessions against the original SQLite/FileBucket adapters. Manual zones
avoid external provider operations. The harness traps unused cookie fallback
and fails on any external request; it does not invent an authenticated user.
Handler, auth, validator, access, address and resolver hashes are pinned.

Each case compares response status/body, complete mailbox/access/alias/folder/
rule/attachment/job/license rows, original message columns, retained audit and
calendar rows, automatic-reply records and object keys/hashes. Five original
resolver probes after each mutation/list call provide 665 target observations.
Dynamic IDs, license-instance IDs and current timestamps are normalized. Native
internal cache/lease/protocol metadata is outside the source-column comparison.

Cases include ordinary/shared/personal creation, literal case conversion and
source-accepted username/display-name spellings, validation shapes, literal
mailbox-versus-alias duplicate errors, normalized distinct spellings and their
delivery selection, delegated/foreign/missing/disabled owners, inactive domains,
license tiers/expiry and privilege flags. Lists cover owned/borrowed insertion
order, primary markers, sender-domain/alias order, disabled reservations,
legacy unknown grants, personal-box repair and missing license initialization.
Sharing covers roles, all permission values, current/disabled/foreign members,
validation order, update/revoke behavior and disabled/missing/foreign inboxes.
Deletion covers ownership/management rights, disabled/personal inboxes and
retained queued/sending/failed job state plus related data.

```sh
bun scripts/capture-source-mailbox-management.ts /path/to/original-71aa49b
bun test tests/source-mailbox-management.test.ts tests/mailbox-management-guards.test.ts
bun scripts/smoke-mailbox-management.ts dist/mailrun-local
```

## Native changes

- Create mailboxes with the original schema, lowercase conversion, owner/domain
  rules and distinct literal-address conflict responses. Do not add a second
  username validator or conflate dot/plus spellings. The already installed
  domain relay resolves these local rows without per-mailbox Cloudflare state.
- Return source collection order, primary markers and sender-address order.
  Share the address collector with sender/profile identity handling. Queries
  remain batched and scoped to relevant domain owners and explicit mailboxes,
  including foreign explicit aliases and all relevant disabled reservations.
  Initialize missing license state as the original collection does.
- Retain legacy permission strings in collection metadata. Authorized mailbox
  readers filter to recognized grants and validate the resulting permissions;
  metadata visibility never grants message access to an unknown permission.
- Match sharing's role/Pro-or-Team/Team checks, exact errors, validation order,
  owner-only shared-inbox management, eligible members and upsert/revoke fields.
  Disabled inboxes remain administratively manageable as in the source.
- Apply creation, sharing and deletion under typed SQLite write transactions
  with current actor/ownership/license checks. Mailbox and alias reservation
  share a write fence. The independent-process guard initially observed a 500
  for the competing reservation; both writer paths now produce one success and
  the source conflict status, with exactly one stored address.
- Delete through the original foreign-key behavior: remove mailbox-specific
  configuration, retain messages/MIME/attachments and audit/calendar records
  with nullable links, remove reply-throttle rows, and leave existing outbound
  job state unchanged. The pre-delete sending veto and queued-job cancellation
  were extra native behavior and are removed from this endpoint.

No table, migration, backup list/group or backup format changes. UI components,
styles and route templates are unchanged.

## Verification and remaining scope

All 133 direct source comparisons pass. Five additional guards check unknown
metadata/body denial, administrator/license/management-right changes at
publication and mailbox-versus-alias reservation across independent Bun
processes. The latter repeats four actual process races.

The compiled rehearsal compares all 133 contracts over real HTTP and checks the
resolver observations against the same database. Target probes invoke the current
resolver code; the following signed intake exercises the compiled resolver. It
then creates a shared inbox, grants a child read access, receives signed MIME, verifies shared body access and write denial,
restarts, revokes access and checks immediate body denial, deletes the inbox,
then restarts again and verifies retained message/MIME data. No external email
is sent. The separate 58-contract compiled alias comparison also passes.

The expanded fixture explicitly resets primary address/domain ownership between
cases; earlier fixture leakage is excluded from verification counts. The
133-case dataset also checks retained calendar/audit records and missing-license
initialization. All 1,769 host tests, generated SQL/coverage, TypeScript and the
production build pass, together with the 133-case compiled lifecycle and
171-case preference/restart rehearsals.

[Ubuntu CI 41514503670](https://github.com/ilbertt/mailrun/actions/runs/41514503670)
and independent PR run 41514516976 both pass all 1,769 tests, generated SQL,
TypeScript and every compiled rehearsal. This includes the 133 lifecycle cases,
665 targets, full shared-inbox restart journey, 171 preferences and 45 automatic
replies. The selected one-CPU/256-MiB/no-swap rule workload passes with
114,970,624-byte cgroup peak and zero OOM kills; this is not full-guest
cold/concurrent resource proof.

Source `a468797` was deployed on November 2 through the nibrun CLI's
checksum-verified archive fetch to the existing preview. The CI executable was
also downloaded privately and verified against its manifest. Executable SHA:
`4e0a6e53697c694408d1d458ed5553833348455c3f58fdfbaf82eace061dc67d`;
119,371,744 bytes. Archive artifact 13174233485 has SHA-256
`3ff49cce6222cfa904fa0828a46d3ddce4aa848b27facaa612f91dbf5324266a`.
Deployment `01a19dde-e672-740c-9b75-26baccbcb4ea` is running.

Post-release checks confirm public login/setup HTTP 200, one account and five
messages retained, ready installation, active ilbert.dev routing/sending,
email-relay HTTP 200 with a successful signed callback, and three UTC cron
registrations against this deployment. A status sample reports 71,319,552 bytes
in use; this is not a peak measurement. Release checks used read-only queries
and health requests, with no live mailbox/message mutation, real email,
credential/provider change, restore or reset. The approved private recovery
export remains retained without a new download.

This compares deletion's immediate persisted state. Native queued delivery still
rechecks current sender rights; original scheduled-worker authorization and
post-deletion/revocation outcomes need a separate temporal comparison before
claiming queue/permission parity. No change to those delivery guards is included
here. The existing owner-only draft protection likewise remains pending the
owner's explicit permission decision.

Source framework error framing, malformed JSON/cookie/origin combinations,
provider-side route failure handling, other linked feature/protocol states,
full source-data cutover, rendered/mobile/keyboard workflows and whole-guest
cold/concurrent capacity remain open. Selected matching contracts do not prove
full parity.
