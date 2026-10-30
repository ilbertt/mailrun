# Constrained server and cron check

The [updated artifact](server-cron-memory-2026-10-30.json) and
[released `0d84611` baseline](server-cron-memory-baseline-2026-10-30.json)
both complete the selected workload with one CPU, 256 MiB and no swap.
The test driver runs on the host, outside the server's memory cgroup. Each
container has only synthetic data and explicitly supplied non-secret settings.

`scripts/smoke-memory.ts` warms seven document routes and embedded JS/CSS/fonts,
then submits three future scheduled sends. Each send contains three distinct
8,000,000-byte attachments, encoded into approximately 32 MiB of JSON. Scheduled
and maintenance CLI commands launch with each request. No outbound job is due,
so the cron check covers coincident startup/maintenance, not provider delivery of
another large queued message. The normal authenticated metadata endpoint and
local file SHA-256 hashes verify all nine attachments. No email is dispatched.

| Observation | Released baseline | Updated artifact |
| --- | ---: | ---: |
| Successful large sends | 3 | 3 |
| Verified bytes per send | 24,000,000 | 24,000,000 |
| Kernel cgroup peak | 256 MiB | 256 MiB |
| Final cgroup current usage | 154 MiB | 165 MiB |
| Kernel OOM / OOM-kill events | 0 / 0 | 0 / 0 |

Both runs record kernel reclaim pressure (`memory.events:max` is nonzero).
The final current-usage samples vary with allocation and file-cache state; they
do not establish an improvement. In particular, the previous unconstrained
275 MiB RSS observation alone did not prove that this workload OOMs at 256 MiB.
The final Linux HTTP smoke also remains an unconstrained functional check, not
a guest-memory guarantee.

The implementation now defers HTTP handler initialization until HTTP startup.
CLI jobs load only their selected branch. An empty scheduled queue does not load
the sender; automatic-draft recovery loads its processor only after finding due
work; trash retention loads deletion code only when it finds expired messages.
Typed SQL, leases, retry/expiry behavior, scheduling and side effects are retained.
Cron registration still receives the original compiled entrypoint. No table,
migration, backup group, request format or JSON-parser dependency is added.

Reproduce after building the Linux executable:

```sh
bun scripts/smoke-memory.ts --binary dist/mailrun --memory 256 \
  --output /private/tmp/mailrun-memory.json
```

Docker must support Linux amd64 and cgroup v2. The default image is
`oven/bun:1.4.4-slim`; `--image` may select an equivalent installed image.
`--jobs none` isolates the HTTP workload. Startup, requests, files, cron commands
and all OOM counters must succeed; an OOM event fails the script even if a request
appeared to finish. The container and data directory are removed afterward.
Binary hashes and cumulative phase samples are in the linked JSON files.

A stricter 192 MiB headroom run still OOMs with concurrent cron startup. This is
an additional diagnostic, not nibrun's configured allocation. The whole nibrun
guest, concurrent signed ingress, active provider delivery, restores/backups,
large MIME and other combinations remain open resource gates. This selected
container check does not establish full production readiness or full parity.

Validation for the loading change: all 445 behavioral tests, generated SQL and
strict TypeScript pass. Compiled Linux HTTP/WebSocket checks, host setup/restart,
original queued-job delivery/replay and assistant eager/cron recovery pass.
All providers in these suites are private fixtures.
