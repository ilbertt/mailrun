# Mailrun

Mailrun is the performance-focused migration of [Mailflare](https://github.com/ilbertt/mailflare) to TanStack Start and Bun.

**This branch is a working migration preview, not a replacement for an existing production installation yet. Use a test domain.**

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

The relay signs the envelope addresses, timestamp and MIME bytes. Incoming messages are parsed and persisted in the request, with deterministic delivery IDs for duplicate handling. Files are written locally; SQLite records are committed before success is returned.

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

Normal startup registers three nibrun cron jobs: due sends every minute, maintenance every five minutes, and the backup schedule check at 02:00 UTC. Jobs are registered using the OS-backed form of `Bun.cron`. The compiled entrypoint dispatches its `--cron-title` argument before starting HTTP, then exits. Manual invocation also supports `jobs scheduled`, `jobs maintenance`, and `jobs backup`. Registration happens again after each deployment. Local development does not install cron jobs.

SQLite leases exclude overlapping runs. Scheduled work is queried by persisted due time; it does not depend on an in-process timer. Backup settings, retention, and daily/weekly/monthly eligibility are respected.

## Current migration coverage

Implemented:

- Owner bootstrap, login, logout, existing password hashes and TOTP/recovery-code verification.
- Session isolation, disabled-account checks, owner/domain-owner/shared-mailbox reads, and write-permission checks.
- Mailbox selection, basic folder views, paginated message lists, FTS text search, conversation reading, read/star/archive/trash mutations.
- Local incoming MIME/attachment storage, duplicate delivery handling, authenticated original/attachment downloads.
- Plain-text compose, Cloudflare sending, and scheduled plain-text delivery.
- Setup-driven relay deployment and signed connectivity checks, optional routing activation and sending-domain setup.
- Local scheduled backups, old full-backup restore, internal lease exclusion, and atomic restore rollback.
- Maintenance for expired sessions/challenges, expired/stalled assistant approvals, and old assistant conversations.
- Native binary builds, isolated HTTP smoke test, SQL coverage checks, and CI.

Still to migrate before production cutover:

- Full incoming routing/aliases, forwarding, folder rules, spam checks, auto-replies, and contact updates. The preview currently receives exact configured mailbox addresses.
- Rich compose, attachment sending, drafts, reply-all/thread headers, complete conversation grouping/pagination, search operators, counts, snooze/custom folders, and all existing URL aliases.
- WebSocket/push notifications, webhook retry processing, AI generation/recovery, mail/Drive retention.
- Calendar/booking, Drive, account/settings/admin screens, password reset/MFA management, translations, branding/PWA, API keys, public API, JMAP and MCP.
- Live Cloudflare delivery verification and complete deployment/restart tests on nibrun.
- Original-app/browser performance baseline, full data migration rehearsal, and production cutover.

The cron launcher and persistent job state are in place, but the remaining handlers above are not silently represented by no-op jobs. Existing scheduled messages with attachments are explicitly rejected by the preview sender rather than delivered without their files.

## Data and backups

The original 65 Mailflare SQL migrations are retained under their original names. The runtime and code generator apply filename order; the `d1_migrations` ledger preserves the identity of already-applied migrations.

The additional migration adds installation configuration and expiring process leases. Installation configuration belongs to the system backup group. Process leases, migration bookkeeping, FTS tables and JMAP revision counters are internally managed or derived and are excluded from record backups.

Record backups preserve the `mailflare-database-backup` version 1 format. Older full backups that omit newly added tables remain restorable. File objects must be copied separately into `blobs/`, preserving their object keys. A nibrun export includes the persistent filesystem; keep recovery copies outside the app's disk.

## Source and license

Ported schema/authentication/backup code comes from Mailflare commit `71aa49b`; see `NOTICE`. The combined application uses AGPL-3.0-or-later. The original Mailrun repository's public-domain dedication is retained in `LICENSE-MAILRUN`.
