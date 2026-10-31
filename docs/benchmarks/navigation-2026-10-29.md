# Inbox/Sent navigation comparison

The [session-recheck comparison](navigation-session-recheck-2026-10-30.md)
supersedes this report for the current build. This historical optimized build had
a stale session guard; its roughly 34 ms figure omitted the original's required
per-path authentication/role recheck.

The optimized build reuses document preferences instead of fetching locale,
translations and branding on every route change. Internal links preload on
pointer intent, keyboard focus or touch. The original initial loading transition
and page-loading bar remain present. The checked-in [measurements](navigation-2026-10-29.json)
cover this specific warm navigation flow; they are not a full performance gate.

| Production build | Median | p95 |
| --- | ---: | ---: |
| Mailflare `71aa49b`, supported Node/Next runtime | 340.40 ms | 357.10 ms |
| Mailrun `93a18c2`, before this change | 140.55 ms | 146.80 ms |
| Mailrun with this change | 34.10 ms | 41.60 ms |

All three applications used clones of the same synthetic SQLite database:
10,001 received messages and 100 sent messages. The host was macOS arm64 with
Bun 1.4.4, using the Codex in-app browser. Each proxied HTTP request received
100 ms of artificial delay; bandwidth was not throttled. Normal browser and
application caching remained enabled. Each application completed 31 alternating
Inbox/Sent navigations; the first 11 warmed caches and were discarded. No
measured request failed. The optimized application included the restored source
loading transition, rather than hiding that UI to improve the result.

The observer starts on the actual link click and finishes when the destination
heading and its deterministic first message are visible, followed by two
animation frames. Median averages the two middle samples; p95 uses nearest rank.
The result therefore includes rendering and transitions, not only API latency.
Hover/focus preloading may complete work before a click, as it does in ordinary
use. No data-loading requests are replaced by measurement stubs.

The preceding Mailrun build made 20 document server-function requests during the
20 measured navigations, transferring 2,511,300 uncompressed response bytes. The
optimized build made none. Initial HTML was 136,410 bytes before and 36,187 after;
both counts include the same measurement observer. The original Node/Next HTML
was 24,230 bytes. These byte counts do not include transport compression and do
not establish cold-load latency. Other application/API requests still occur.

## Reproduce

1. Prepare a separate original Mailflare checkout at `71aa49b`, install its
   dependencies and run its `npm run build:node`. This produces `.next-node` and
   `dist/server.mjs`; the harness requires Node for that supported runtime.
2. Build a host executable from Mailrun `93a18c2` in a separate checkout with
   `BUILD_TARGET=host bun run build`. Preserve `dist/mailrun-local` as the before
   binary. Build the current checkout with the same command for the after binary.
3. Run the harness from the current checkout, supplying absolute paths:

   ```sh
   bun run benchmark:navigation --reference /path/to/original \
     --before /path/to/before/mailrun-local --after ./dist/mailrun-local \
     --port 4400 --delay 100 --output /private/tmp/navigation-results
   ```

4. Open the three printed loopback URLs in a real browser. Let each initial
   loading transition finish, then alternate normal sidebar Sent/Inbox clicks
   31 times per application. Wait for each destination to settle before clicking
   again. Do not reload during a run: sequence IDs intentionally reject reloads.
5. Stop the harness with SIGINT. It saves metrics and shuts down the child
   servers, then deletes the temporary synthetic databases. Produce the report:

   ```sh
   bun run benchmark:navigation:report --input /private/tmp/navigation-results \
     --output /private/tmp/navigation-report.json
   ```

The harness generates a temporary session, filters inherited provider credentials,
and uses only synthetic data. It does not send email or deploy any resources.
Binary hashes, platform, runtime version and sorted individual timings are in the
report. The reporting script rejects incomplete or unmatched navigation samples.

## Scope still open

This comparison uses Mailflare's supported Node/Next production runtime. It does
not measure its primary Vinext/Cloudflare Worker deployment. It also does not
measure nibrun cold starts, initial sign-in, other screens, mobile interaction,
concurrent ingestion/cron work or peak memory in the 256 MiB guest. Those checks,
alongside the remaining feature/data migration audit, remain required for full
parity and production cutover.
