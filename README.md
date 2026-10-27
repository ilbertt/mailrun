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

```sh
bun run db:generate  # regenerate after SQL or migration changes
bun run check        # SQL coverage/freshness, strict TypeScript, behavioral tests
bun run build:local  # standalone executable for this machine
bun run smoke        # HTTP/auth/SSR/assets from an isolated working directory
bun run benchmark    # synthetic 10,001-message database benchmark
bun run build        # standalone Linux x64 executable: dist/mailrun
```

SQL migrations and the relay are embedded at build time. The final executable uses native embedded asset trees and ESM bytecode, following [bun-full-stack-starter](https://github.com/ilbertt/bun-full-stack-starter). It contains the compiled Start server and all frontend assets; it does not need `node_modules` or a source checkout. Bun is pinned in `package.json`; CI reads that file, and the type check verifies that workspace TypeScript matches Bun.

The benchmark measures repository/database calls including authorization. It does not measure browser interactions, network latency, cold starts, or prove improvement over the original application.

## nibrun

The launcher reads `PORT` and binds `0.0.0.0`. It stores its database at `${NIBRUN_DATA_DIR}/mailflare.sqlite` and files at `${NIBRUN_DATA_DIR}/blobs`. The legacy database filename is intentional.

Supply a private `SETUP_TOKEN` on the first deployment, then claim the owner account through setup. No Cloudflare credentials are required merely to boot the application.

```sh
nib run ./dist/mailrun --name mailrun-preview --env SETUP_TOKEN=YOUR_RANDOM_VALUE
```

Subsequent deployments must target the existing app with `--app`.

Normal startup registers three nibrun cron jobs: due sends every minute, maintenance every minute, and the backup schedule check at 02:00 UTC. Jobs are registered using the OS-backed form of `Bun.cron`. The compiled entrypoint dispatches its `--cron-title` argument before starting HTTP, then exits. Manual invocation also supports `jobs scheduled`, `jobs maintenance`, and `jobs backup`. Registration happens again after each deployment. Local development does not install cron jobs.

SQLite leases exclude overlapping runs. Scheduled work is queried by persisted due time; it does not depend on an in-process timer. Backup settings, retention, and daily/weekly/monthly eligibility are respected. The daily task also purges expired Drive/attachment trash and stale uploads, even when database backups are disabled.

## Current migration coverage

Implemented:

- Original personal/admin API-key, app-password credential, General and Activity screens. Personal and MCP credentials retain mailbox grants; administrative scopes stay separate and require the current primary administrator. Secrets are returned once, only bcrypt hashes persist, revocation cancels pending approvals, and authentication rechecks live key/user state after hash verification. General limits apply to attachment uploads and Drive quota reservations; login/logout activity retains source metadata.
- Original password-recovery screens and thirty-minute reset links sent through Cloudflare system mail without Sent copies or contacts. Redemption is atomic and single-use and revokes sessions plus pending MFA challenges. Public auth has local IP limits, optional server-validated Turnstile and source-compatible capability flags.
- Original domain screens with native Cloudflare zone preflight, public-DNS authentication checks, MX-confirmed receiving/sending setup, idempotent DNS repair and scoped cleanup. Original Mailflare per-address Worker rules migrate to the installed relay across all result pages; rollback restores previous rules and MX metadata. Relay setup checks the public app with a signed request before publication, provisions a missing workers.dev namespace and verifies the Worker before changing routing. DNS controls use the credentials saved during setup.
- Original account list/details/permissions/password/inbox screens and admin mailbox URL aliases. Native creation commits the user, primary inbox, explicit aliases and booking username together; seat limits and primary-admin transfers serialize under SQLite. Delegated admins retain their original limits, resets revoke sessions/challenges, account avatars follow the original management scope, and disabled accounts cannot sign in.
- Original Drive and public sharing screens with local streamed multipart uploads, three-day resume, atomic quota reservations, inherited view/edit permissions, owner-only sharing/moves/restores, folder breadcrumbs, search/type filters, previews/downloads, Range/HEAD support, trash and 30-day retention. Email attachments keep mailbox permissions and have independent trash/restore/delete actions. Upload leases and staged publication prevent an expired writer from replacing a completed file.
- Original Calendar and booking screens, recurring-series edits and occurrence moves, public booking pages at both original URL forms, time-zone/DST-aware availability and atomic multi-host reservations. Calendar invitations use local ICS attachments and durable outbound jobs; calendar API keys enforce read/write and send scopes.
- Original Mailflare dashboard and section layouts, navigation, list rows, split reader, rich composer, attachment viewer, contacts dialogs, account menu, login/MFA challenge screen and settings forms for Account, Inbox, Security, Mailboxes, aliases and routing rules. TanStack navigation replaces Next navigation; the components, styles and translations come from the source baseline.
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

- Remaining administration screens and optional Resend/SES provider integrations; import/export screens; public API, JMAP and MCP. App-password creation and key management are ported; mail-client protocol access remains pending.
- Agent configuration/chat/tools, approval workflows, automatic draft generation/recovery, webhooks/retries. The original assistant layout is present; its remaining endpoints are not yet ported.
- Remaining source routes and URL aliases, setup/onboarding screen parity, Gravatar imports, and a full browser/mobile interaction audit. Calendar, booking, Drive and Cloudflare domain setup were compared against the original on desktop; the current browser viewport override did not take effect, so phone layouts remain unverified. Account lists/details were also compared on desktop and a saved name change was verified after reload. Domain creation and DMARC setup were exercised against a local provider simulator, without live DNS changes. Key and General screens were compared on desktop, including a settings save.
- Real Cloudflare delivery checks, a full migration/restore rehearsal, original-app end-to-end performance comparison, nibrun restart/durability verification and production cutover.

Full parity remains the acceptance criterion. The preview is an incomplete migration checkpoint; visible source navigation includes features whose native handlers are still being ported. Missing jobs are not represented by no-op implementations.

## Data and backups

The original 65 Mailflare SQL migrations are retained under their original names. The runtime and code generator apply filename order; the `d1_migrations` ledger preserves the identity of already-applied migrations.

The additional migrations add installation configuration, expiring process leases, and draft revision/scheduling columns on the existing messages table. Installation configuration belongs to the system backup group. Process leases, migration bookkeeping, FTS tables and JMAP revision counters are internally managed or derived and are excluded from record backups.

Record backups preserve the `mailflare-database-backup` version 1 format. Older full backups that omit newly added tables remain restorable. File objects must be copied separately into `blobs/`, preserving their object keys. A nibrun export includes the persistent filesystem; keep recovery copies outside the app's disk.

## Source and license

Ported schema/authentication/backup code, UI primitives, recipient editor and email renderer comes from Mailflare commit `71aa49b`; see `NOTICE`. The combined application uses AGPL-3.0-or-later. The original Mailrun repository's public-domain dedication is retained in `LICENSE-MAILRUN`.

Optional Turnstile uses `NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build time and `TURNSTILE_SECRET_KEY` at runtime; leave both unset when it is not configured.
