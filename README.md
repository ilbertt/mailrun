# Mailrun

Mailrun is a runtime port of [Mailflare](https://github.com/ilbertt/mailflare) to TanStack Start and Bun. Mailflare’s existing UI, URLs, workflows, permissions and feature behavior are the specification. This is not a redesign or a reduced feature set.

**This branch is incomplete. The preview does not yet have full Mailflare parity and must not replace an existing production installation.**

The source baseline is Mailflare `71aa49b` (version 0.5.2). Reuse its components and business behavior; adapt framework navigation, typed data access and infrastructure boundaries. Preserve desktop/mobile layouts, persistent preferences, dialogs and interactions. Replacing a source screen with an approximation does not count as migration.

## Architecture

- TanStack Start handles typed navigation, server functions, and HTTP routes.
- TanStack Query coordinates route preloading, SSR hydration, caching, and optimistic updates.
- Bun SQL talks to local SQLite. `bun-sqlgen` validates every named application query against the migrations and generates its result types.
- Raw MIME, attachments, and backups live on local disk under `DATA_DIR`.
- nibrun cron invokes task commands in the same compiled binary. It wakes the app for due work.
- Cloudflare provides Email Routing, a small relay Worker, and Email Sending. Setup deploys the relay through the Cloudflare API. There are no R2, D1, Cloudflare Queue, or Cloudflare Cron dependencies.

## Run locally

Requires Bun 1.4.3 or later.

```sh
bun install --frozen-lockfile
cp .env.example .env
# Set SETUP_TOKEN in .env to a random value of at least 16 characters.
# For example, generate a value using: openssl rand -hex 32
bun run dev
```

Open `http://localhost:3000/setup` and use that token to create the first administrator. `SETUP_TOKEN` protects the first account claim; it is not an administrator password.

To connect email, the app needs a public HTTPS URL (`APP_URL`, or nibrun's supplied hostname). The authenticated setup page accepts the Cloudflare account ID, domain, API token and initial mailbox. The token needs Worker deployment permissions and the appropriate zone/DNS/email permissions.

Setup persists a unique Worker name and signing secret, uploads the bundled relay, and checks signed connectivity back to the application. Routing is activated only when explicitly selected in the form. Existing foreign MX records are not automatically removed. A retry reuses the installation's Worker and secret.

The relay signs the envelope addresses, timestamp and MIME bytes. Incoming messages are parsed and persisted in the request, with deterministic delivery IDs for duplicate handling. For forwarding, the relay forwards within the original Cloudflare email event and confirms the outcome to Mailrun with a signed request when a copy is needed. Failed forwarding preserves a local copy when the rule has a destination mailbox; otherwise delivery fails. Files are written locally; SQLite records are committed before a store result is returned.

## Checks and builds

TLS fixture tests use OpenSSL to generate temporary certificates; the deployed server uses Bun's built-in TLS and needs no OpenSSL executable.

```sh
bun run db:generate  # regenerate after SQL or migration changes
bun run check        # SQL coverage/freshness, strict TypeScript, behavioral tests
bun run build:local  # standalone executable for this machine
bun run smoke        # HTTP/auth/SSR/assets from an isolated working directory
bun run smoke:agent  # HTTPS fixture, streamed tools, approvals and cron recovery
bun run benchmark    # synthetic 10,001-message database benchmark
bun run build        # standalone Linux x64 executable: dist/mailrun
```

SQL migrations and the relay are embedded at build time. The final executable uses native embedded asset trees and ESM bytecode, following [bun-full-stack-starter](https://github.com/ilbertt/bun-full-stack-starter). It contains the compiled Start server and all frontend assets; it does not need `node_modules` or a source checkout. Bun is pinned in `package.json`; CI reads that file, and the type check verifies that workspace TypeScript matches Bun.

The benchmark measures repository/database calls including authorization and a single streamed MBOX export. The export index removes repeated mailbox scans/sorts; the 10,001-message local fixture completes in about 150 ms. This is a local synthetic measurement of the current implementation. It does not measure browser interactions, network latency, cold starts, or prove improvement over the original application.

## nibrun

The launcher reads `PORT` and binds `0.0.0.0`. It stores its database at `${NIBRUN_DATA_DIR}/mailflare.sqlite` and files at `${NIBRUN_DATA_DIR}/blobs`. The legacy database filename is intentional.

Supply a private `SETUP_TOKEN` on the first deployment, then claim the owner account through setup. No Cloudflare credentials are required merely to boot the application.

```sh
nib run ./dist/mailrun --name mailrun-preview --env SETUP_TOKEN=YOUR_RANDOM_VALUE
```

Subsequent deployments must target the existing app with `--app`.

Normal startup registers three nibrun cron jobs: due sends every minute, maintenance every minute, and the backup schedule check at 02:00 UTC. Maintenance includes webhook retries and recovery of pending deliveries. An eager dispatcher handles new events while the server is awake; cron remains the recovery path when the app sleeps or restarts. Webhook delivery is at least once, and receivers can deduplicate using the stable `X-Email-Platform-Delivery` header. Jobs are registered using the OS-backed form of `Bun.cron`. The compiled entrypoint dispatches its `--cron-title` argument before starting HTTP, then exits. Manual invocation also supports `jobs scheduled`, `jobs maintenance`, and `jobs backup`. Registration happens again after each deployment. Local development does not install cron jobs.

SQLite leases exclude overlapping runs. Scheduled work is queried by persisted due time; it does not depend on an in-process timer. Backup settings, retention, and daily/weekly/monthly eligibility are respected. The daily task also purges expired Drive/attachment trash and stale uploads, even when database backups are disabled.

## Current migration coverage

Implemented:

- Original Agent configuration, mailbox preferences, conversations, streamed chat, tool/reasoning activity, human action approvals, automatic reply drafts and AI Usage screens. The source AI SDK and compatible-provider adapter preserve model calls and NDJSON events; provider keys remain masked and errors are redacted. Conversation ownership, selected-email context and current permissions are checked. Organize-action approval and its mail mutation commit together; full pending proposals remain valid JSON. Eligible inbound mail and its automatic job commit together, then a shared dispatcher and cron recover persisted work. Mailbox serialization, UTC daily limits, retry dates, source/reviewer/settings checks and fenced publication prevent stale or duplicate drafts. Graceful interruption releases work without spending its retry budget.
- The original MCP server SDK, tool names and schemas at `/mcp`: scoped email/calendar tools and creator-limited administrative tools, stateless legacy and per-request transports, Bearer-only enabled credentials, host/origin validation and the source rate limit. Assistant drafts preserve prose formatting, reply recipients/threading, revision conflicts, local attachment copies and human-edit protection. Send requests produce the original non-admin review screen; only a user session can confirm delivery. Approval snapshots hash attachment bytes, queue immutable copies atomically, retain review history and prevent competing sends. Expiry, stalled claims and scheduled delivery use existing nibrun maintenance/send jobs; provider failures require reconciliation.
- Source-compatible JMAP discovery/session, scoped Basic/Bearer credentials, mailbox/folder management, recursive email queries, headers/body values, threads/snippets, draft creation/import, local uploads/downloads, submission and state events. Typed static SQLite queries retain original filter/sort behavior. Upload claims and draft/attachment writes commit atomically; submissions reserve and queue the original draft together, protect pending sends from competing UI/protocol mutations and restore drafts on provider failure. Long-lived contexts refresh key, user and mailbox grants. Private drafts stay author-scoped.
- Public v1 message/read/send, account, mailbox, domain/DNS and local-storage APIs. Bearer keys retain source scopes and creator-limited administrative inventories. Trusted key principals recheck current grants inside writes without granting UI permissions; delegated legacy keys retain their original powers. Mailbox grants filter reads before pagination, private drafts stay private, sends retain the 2 MiB body/40 MiB request contracts and scheduled jobs, and storage health includes write/read/delete. Large JSON spools to private temporary files, decoded attachment buffers are released between writes, and the final Cloudflare wire body is checked against its API limit.
- Original import/export screens and legacy URL aliases. EML/MBOX/MBX imports retain dates, bodies, raw MIME, attachments, threading, contacts and destination sections/folders, with transactional duplicate checks and atomic file publication. Native IMAP discovers folders and imports batches over TCP/TLS, validates and pins DNS addresses, verifies the original hostname, keeps credentials transient and cleans staging on failure, cancellation or HTTP restart. Batches spool to local files instead of retaining every MIME body in memory. MBOX exports retain the original header/body format and stream a consistent read snapshot without holding the normal database queue; private drafts remain scoped to their author. File uploads retain the source's 25 MiB request and 100-message limits. Oversized and malformed responses release the import form instead of leaving its promise pending.
- Original webhook management and delivery-history screens, endpoint creation, event subscriptions, enable/disable, one-time signing secrets, rotation, test delivery and manual retry. Inbound/outbound/failure events commit with the mail transaction, then an eager Bun dispatcher sends them outside the request context. Pending work survives restarts; nibrun maintenance runs persisted retry dates with the source backoff and attempt limits. Shared per-delivery leases exclude competing HTTP/cron processes; stale attempts cannot overwrite newer results.
- Original backup, branding, license and administrative routing screens, plus the audit-log URL alias. Manual backups stream SQLite snapshots to private local files; download, restore, delete, group selection, UTC schedules and retention use the source contracts. Manual operations and cron share a renewable SQLite lease; failed restores roll back atomically, interrupted backups become visible failures and cleanup preserves files still referenced elsewhere.
- Original personal/admin API-key, app-password credential, General and Activity screens. Personal and MCP credentials retain mailbox grants; administrative scopes stay separate and require the current primary administrator. Secrets are returned once, only bcrypt hashes persist, revocation cancels pending approvals, and authentication rechecks live key/user state after hash verification. General limits apply to attachment uploads and Drive quota reservations; login/logout activity retains source metadata.
- Original password-recovery screens and thirty-minute reset links sent through Cloudflare system mail without Sent copies or contacts. Redemption is atomic and single-use and revokes sessions plus pending MFA challenges. Public auth has local IP limits, optional server-validated Turnstile and source-compatible capability flags.
- Original domain screens with native Cloudflare zone preflight, public-DNS authentication checks, MX-confirmed receiving/sending setup, idempotent DNS repair and scoped cleanup. Original Mailflare per-address Worker rules migrate to the installed relay across all result pages; rollback restores previous rules and MX metadata. Relay setup checks the public app with a signed request before publication, provisions a missing workers.dev namespace and verifies the Worker before changing routing. DNS controls use the credentials saved during setup.
- Original administration overview and update card, with nibrun binary redeploy instructions, primary-only migration status/application, and admin search-index maintenance. Migration application serializes with active SQLite callbacks and commits each schema change with its ledger entry; parallel processes skip already-applied changes. The overview and update-card layout were compared against the original on desktop.
- Original account list/details/permissions/password/inbox screens and admin mailbox URL aliases. Native creation commits the user, primary inbox, explicit aliases and booking username together; seat limits and primary-admin transfers serialize under SQLite. Delegated admins retain their original limits, resets revoke sessions/challenges, account avatars follow the original management scope, and disabled accounts cannot sign in.
- Original Drive and public sharing screens with local streamed multipart uploads, three-day resume, atomic quota reservations, inherited view/edit permissions, owner-only sharing/moves/restores, folder breadcrumbs, search/type filters, previews/downloads, Range/HEAD support, trash and 30-day retention. Email attachments keep mailbox permissions and have independent trash/restore/delete actions. Upload leases and staged publication prevent an expired writer from replacing a completed file.
- Original Calendar and booking screens, recurring-series edits and occurrence moves, public booking pages at both original URL forms, time-zone/DST-aware availability and atomic multi-host reservations. Calendar invitations use local ICS attachments and durable outbound jobs; calendar API keys enforce read/write and send scopes.
- Original Mailflare dashboard and section layouts, navigation, list rows, split reader, rich composer, attachment viewer, contacts dialogs, account menu, login/MFA challenge screen and settings forms for Account, Inbox, Security, Mailboxes, aliases and routing rules. TanStack navigation replaces Next navigation; the components, styles and translations come from the source baseline.
- A checked-in inventory of all 165 original HTTP routes preserves automatic OPTIONS/Allow, GET-backed HEAD, empty 405 responses before authentication, and trailing-slash redirects. The compiled smoke suite checks every route’s method boundary and compares representative wire responses with captures from the original server. This does not imply that all allowed provider handlers are migrated.
- Native source-compatible REST contracts for mail lists/counts/navigation, grouped pagination, Gmail-style search operators, read/star/snooze/move/delete actions, drafts, attachments, templates, contacts/avatars, mailbox configuration/sharing/aliases, routing rules, account preferences, password/MFA management, browser account switching, licenses and branding.
- Owner/shared-mailbox permissions, private drafts, disabled-account checks and the original Team-sharing entitlement. Domain ownership does not grant access to another account's mailbox contents.
- MIME parsing, quote-aware snippets, References-based threading, original local spam analysis/training/reputation, contact updates and loop-safe, rate-limited auto-replies. Raw MIME and attachments remain on local disk.
- Rich drafts with revision conflicts, To/Cc/Bcc, send-as/on-behalf identities, reply/reply-all/forward and independent attachment copies. Closing the composer waits for saves; failed saves keep the content visible. Send failures restore editable drafts.
- Immediate and nibrun-scheduled Cloudflare sends. Small attachments are embedded; large files use expiring local links. Platform-controlled Message-ID is omitted, and threading headers respect Cloudflare's size limit.
- Bun WebSocket revision checks/live notifications, the original notification popup, Web Push encryption/subscriptions, packaged PWA assets and local fonts. Notification delivery rechecks active sessions and mailbox access.
- Normalized exact/explicit/cross-domain aliases, domain rules/catch-all routing, forwarding with keep-copy/failure fallback and loop protection. Setup deploys and verifies the Cloudflare relay.
- Local backups and older full-backup restore, internal lease exclusion, atomic restore rollback, and owner-configured Trash/Spam retention. Object cleanup preserves files still referenced by other records.
- Native builds, an isolated compiled HTTP/WebSocket smoke check including managed-account login/reset revocation and a 192 MiB streamed Drive file, SQL generation/coverage checks and behavioral tests. The benchmark exercises the restored UI's list query rather than the obsolete route-loader query.

Still to migrate before production cutover:

- Optional Resend/SES provider integrations. App-password creation, key management, JMAP, MCP and the administration overview are ported.
- Remaining allowed-handler and URL-alias audit, setup/onboarding screen parity, Gravatar imports, and a full browser/mobile interaction audit. Calendar, booking, Drive and Cloudflare domain setup were compared against the original on desktop; the complete phone comparison remains unverified. Backup, branding, license and routing screens were also compared on desktop; native manual backup, backup settings save and branding save were verified. A disposable 390×844 iframe harness renders the native inbox, navigation drawer and reader; the reference mobile comparison and touch testing remain open. Account lists/details were also compared on desktop and a saved name change was verified after reload. Domain creation and DMARC setup were exercised against a local provider simulator, without live DNS changes. Key and General screens were compared on desktop, including a settings save. Import/export and IMAP forms were compared on desktop; a local EML was imported, its MBOX downloaded and checked, and an oversized upload was rejected without keeping the form busy. Native IMAP protocol tests use local TCP/TLS fixtures, including certificate/hostname rejection and cancellation; real provider checks and larger MIME memory tests remain open. Early hydration interactions also need audit: an automated source selection immediately after hard navigation was not replayed. Original webhook list/history layouts were compared; endpoint creation, a failed test and successful manual retry were verified against a disposable localhost receiver.
- Real Cloudflare delivery checks, a full migration/restore rehearsal, original-app end-to-end performance comparison, nibrun restart/durability verification and production cutover.

Full parity remains the acceptance criterion. The preview is an incomplete migration checkpoint; visible source navigation includes features whose native handlers are still being ported. Missing jobs are not represented by no-op implementations.

## Public API

Create mail keys in Settings → API keys and administrative keys in Admin → API keys. The v1 endpoints accept Bearer keys; session cookies and HTTP Basic credentials do not authenticate them. Administrative inventories include the caller and accounts they created, and retain the original license and primary-admin restrictions.

| Endpoint | Scope |
| --- | --- |
| `GET /api/v1/messages` | `read` |
| `POST /api/v1/send` | `send` |
| `/api/v1/accounts` and `/:id` | `accounts` |
| `/api/v1/mailboxes` and `/:id` | `mailboxes` |
| `/api/v1/domains`, `/:id`, `/:id/dns`, `/:id/dns/setup` | `domains` |
| `GET/POST /api/v1/storage` | `storage` |

Mail reads use the original query, direction and limit fields. Sending supports To/Cc/Bcc, threading, base64 attachments and scheduled delivery. Large request bodies use temporary files under the persistent data directory; they are removed after parsing and abandoned staging is cleared on HTTP startup. The expanded local smoke check exercises a 32 MB JSON request with 24 MB of scheduled attachments. Linux guest memory still needs deployment validation.

## Assistant and automatic drafts

The original Agent screen stores compatible-provider presets, endpoint, API key, model IDs and per-model rates. Mailbox settings retain reviewer selection, writing preferences, model choice, automatic drafting and daily limits. Environment fallback supports `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`. Like the original self-hosted runtime, no Workers AI binding is available; Cloudflare remains email-only. Provider secrets are never returned to ordinary clients, and streamed errors omit credentials and raw request bodies.

Chat keeps the source NDJSON conversation, text, reasoning, reclassification, tool and completion events, with seven steps and the original output-token limits. Histories and proposals stay in local SQLite. Human mail actions commit with their recorded approval result, so a restart cannot strand a half-applied action. Assistant drafts still require a separate user-session review before email delivery. Model tools and conversation data respect current mailbox access and private drafts.

Automatic drafting never sends mail. Its durable job is inserted with eligible inbound mail, excluding automatic/list mail, own identities, routed folders, spam and failed spam analysis. HTTP startup creates a dispatcher outside the rendering request context; cron remains the recovery path. A shared dispatch lease bounds automatic inference across HTTP/cron processes, while per-job attempts/leases fence publication. Draft creation, metadata and job completion commit together after current settings, reviewer, source thread and daily limit are rechecked. Expired workers release recoverable work, and graceful interruption preserves the retry budget. Legacy Reply-To fallback streams just the MIME header block; model thread input loads bounded text instead of whole message bodies.

The original and native provider settings, assistant panel, streamed replies and usage charts were compared on the same disposable fixture. Provider rates and mailbox preferences were saved, history survived navigation, an assistant reply opened in the original composer/review dialog, and a human mail-action approval persisted. No external email or paid model request was made. The compiled assistant smoke uses a private HTTPS model fixture and verifies model discovery, chat/tools, masked credentials, usage, signed ingress, eager drafting and recovery through the actual cron command.

## MCP clients and assistant draft reviews

The original MCP endpoint is `/mcp`. Enable MCP access when creating a credential in the existing key settings. Personal keys use the six `mcp:*` scopes and explicit mailbox grants; calendar-only keys can omit mailboxes. Administrative MCP credentials expose only the administrative tools selected by their scopes and retain the v1 APIs' license and creator limits. Mixed personal/administrative scopes, legacy credentials without MCP enabled, HTTP Basic and browser session cookies cannot authenticate MCP.

The server uses the source SDK version and supports its stateless legacy and per-request protocol envelopes. Origin and configured-host checks run before authentication, and the original 120-request minute rate limit is enforced locally. Writes recheck current key/user state, mailbox grants and actual mailbox permissions inside SQLite transactions. Metadata pages and cursors avoid loading email bodies. Email body, attachment and revision reads share a SQLite snapshot, so a concurrent edit cannot pair an old body with a newer edit revision. The SDK loads on protocol use, and response-scoped abort listeners are released after completion or cancellation.

Draft tools never dispatch mail. `request_send` returns `/agent/review/:id`, using the original review dialog in the dashboard for administrators and ordinary users. A logged-in human reviews the exact recipients, body, schedule and attachment snapshot before confirming. MCP credentials cannot authenticate that confirmation endpoint. Human edits advance the assistant revision atomically; changed or expired snapshots cannot dispatch. Approved copies and jobs commit together, and ambiguous provider failures retain the draft and block another approval until reconciliation. Approved future sends use nibrun's persisted cron path and can be cancelled back to drafts.

The review and schedule dialogs were compared with the original against a shared disposable fixture. A non-admin scheduled confirmation and its resulting Scheduled row were verified in the browser, without external email delivery. Native HTTP checks cover protocol initialization, scoped reads, draft/review creation, human/API-key isolation and ownership. External MCP-client interoperability and final Linux resource checks remain part of cutover verification. A local compiled run of 100 MCP discovery requests on reused connections levelled off around 119 MiB RSS after login SSR. An expanded local large-send/Drive smoke finished around 175 MiB RSS, with the large JSON send peaking around 231 MiB. Local RSS varies; the combined Linux guest and cron memory budget remains unverified. A direct local MCP comparison against the reference server was rejected by its configured-host guard; its review UI comparison succeeded.

## JMAP mail clients

Create an app password with the `jmap` scope in Settings → App passwords, selecting its mailboxes. Discovery is `/.well-known/jmap`; the session endpoint is `/jmap/session`. Clients can use the key as a Bearer token or an HTTP Basic password. The key sees one JMAP account containing its accessible mailboxes, system sections and custom folders. Browser session cookies do not authenticate this protocol.

Uploads and API requests retain the original 10 MiB limit. MIME imports create drafts and consume their upload atomically; structured drafts can reference uploaded attachments. A successful submission creates the sent message and removes the original draft; provider failure preserves an editable draft. As in the original, change-history methods report `cannotCalculateChanges`, clients resynchronize with get/query, and Email/copy and Email/parse remain unsupported. This preserves Mailflare's protocol contract rather than claiming complete RFC coverage.

The synthetic 10,001-message benchmark includes JMAP inbox and nested boolean-filter calls. It excludes API-key password hashing, HTTP, browser rendering and deployment behavior. Real external mail-client interoperability and Linux resource limits still require validation before cutover.

## Data and backups

The original 65 Mailflare SQL migrations are retained under their original names. The runtime and code generator apply filename order; the `d1_migrations` ledger preserves the identity of already-applied migrations.

The additional migrations add installation configuration, expiring process leases, draft revision/scheduling columns on the existing messages table, an index for streaming mailbox exports, and local JMAP upload metadata. Upload metadata belongs to the mail backup group and follows its user dependency; blob files remain separate. The index is derived and does not change backup table coverage. Installation configuration belongs to the system backup group. Process leases, migration bookkeeping, FTS tables and JMAP revision counters are internally managed or derived and are excluded from record backups.

The HTTP restore form currently accepts backup files up to 30 MiB, subject to the overall request limit. Larger database restores and memory use still need migration verification before production cutover.

Record backups preserve the `mailflare-database-backup` version 1 format. Older full backups that omit newly added tables remain restorable. File objects must be copied separately into `blobs/`, preserving their object keys. A source R2 export must also preserve pending JMAP uploads’ content types and filenames when populating the new upload metadata table; this is part of the outstanding migration rehearsal. A nibrun export includes the persistent filesystem; keep recovery copies outside the app's disk.

## Source and license

Ported schema/authentication/backup code, UI primitives, recipient editor and email renderer comes from Mailflare commit `71aa49b`; see `NOTICE`. The combined application uses AGPL-3.0-or-later. The original Mailrun repository's public-domain dedication is retained in `LICENSE-MAILRUN`.

Optional Turnstile uses `NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build time and `TURNSTILE_SECRET_KEY` at runtime; leave both unset when it is not configured.
