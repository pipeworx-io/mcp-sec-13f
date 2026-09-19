# @pipeworx/sec-13f

Institutional ownership from SEC Form 13F, asked **security-first**. Hosted, keyless to the caller.
Deltas are a first-class citizen here, not an afterthought: `manager_changes` and `security_flows`
answer "what changed" directly, because a static holdings snapshot isn't a newsletter — a change is.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `who_owns(security, limit?)` — which managers hold a security, ranked by position size. Accepts a
  company name, a ticker (resolved live through OpenFIGI — see "Ticker resolution" below) or a
  9-character CUSIP.
- `manager_portfolio(manager, limit?)` — every position one manager reported, largest first (current
  quarter only — see `manager_changes` for what changed).
- `manager_changes(manager, quarter?, compare_to?, limit?)` — what one manager NEW-ed, EXITED,
  INCREASED or DECREASED between two loaded quarters. Defaults to the manager's two most recent
  loaded quarters.
- `security_flows(security, limit?)` — total position value and holder count per loaded quarter for
  one security, plus which managers bought/sold/added/trimmed between the two most recent quarters.
- `manager_profile(manager)` — concentration (top-5/top-10 % of portfolio), turnover between the two
  most recent loaded quarters, and top positions. Does **not** include sector exposure — 13F carries
  no industry/sector field, and this pack does not fabricate one.
- `holdings_coverage()` — which SEC release windows and quarters are loaded, filings/holdings counts
  per quarter, and whether there's enough loaded to diff (`can_diff_quarters`).

## Ticker resolution — deliberately NOT a CUSIP↔ticker table

13F reports positions by CUSIP; there is no ticker column anywhere in the dataset. CUSIP identifiers
are proprietary to CUSIP Global Services, so this pack does not build, cache, or redistribute a bulk
CUSIP↔ticker crosswalk (same discipline as the paywalled-standards rule). Instead, a ticker-shaped
input (e.g. `"NVDA"`) is resolved **live, per call**, through OpenFIGI's public mapping API — openly
licensed Bloomberg FIGI — to get the security's canonical name, which is then matched against
`issuer_name` in our own already-ingested holdings, preferring the candidate with the largest
aggregate value (a real operating company's smallest institutional line still dwarfs a themed/
leveraged ETF's largest one). Every response that used this path reports `matched_on:
"ticker_via_openfigi"` and what it resolved to (`resolved_via.cusip`, `.figi`, `.issuer_name`) — never
silently. Before this, `who_owns("NVDA")` matched issuer_name `ILIKE '%NVDA%'` and returned "Direxion
Daily NVDA Bull 2X ETF" ranked alongside the real NVIDIA CORPORATION position — a silent wrong answer,
not a missing feature.

## Why this is hosted rather than proxied

The ingest program only accepts a local build when it makes a question possible that the upstream
cannot answer. This is the clean case: **the SEC publishes 13F manager-first, and so does every API
over it.** Our own `edgar_institutional_holdings` says so in its description — answering "which
funds hold $TICKER" means running it once per manager, a loop over ~8,000 filers. That is a shape
problem, not a rate-limit problem, and no upstream fixes it. One indexed query over the flat table
inverts it.

## What 13F does not tell you

Stated here and in every response, because 13F is routinely over-read:

- **Long US-listed equity only.** Shorts, cash, bonds and non-US holdings are excluded by rule. "How
  much does X own" is answerable only inside that universe.
- **Quarterly, and late.** Filed up to 45 days after the period end. It is a lagged snapshot, never a
  current position.
- **$100M floor.** A manager under that threshold does not file at all, so absence is not evidence.
- **No ticker column.** CUSIP is the only identifier of record; issuer names are as the filer typed
  them ("NVIDIA CORP"). A ticker search falls back to an issuer-name match and says so in
  `matched_on`.

## One thing the numbers depend on

A single manager can report the same security on several lines — different investment discretion, or
puts and calls alongside the common. `who_owns` **collapses lines per manager** before ranking.
Without that you get the largest *lines* rather than the largest *holders*, which is a different list
that looks equally plausible.

## Data + refresh

Source: `https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets` — one rolling
3-month ZIP carrying seven TSVs. Three are used: `SUBMISSION` (accession → CIK), `COVERPAGE`
(accession → manager) and `INFOTABLE` (the holdings, ~3.8M rows/release, 396MB uncompressed).

The filename encodes its window (`01mar2026-31may2026_form13f.zip`) and is **not derivable** —
releases do not land on calendar quarters. Both the worker config and the script read SEC's index
page for the newest link; a hardcoded quarter would ingest once and serve stale data forever.

- Standing path: `workers/data-pipeline` (`sec-13f-submissions`, `sec-13f-managers`,
  `sec-13f-holdings`).
- Backfill / recovery (needs a Supabase service key or linked `supabase` CLI):
  `node scripts/ingest-sec-13f.mjs --only holdings`.
- Backfill via the gateway's admin route (needs only `PIPEWORX_INTERNAL_SECRET`, the credential every
  fleet session already carries — no raw DB key): `node scripts/ingest-sec-13f-admin.mjs --url
  https://www.sec.gov/files/structureddata/data/form-13f-data-sets/<window>_form13f.zip`. Posts
  through `POST /admin/sec13f_load` on the gateway (table-allowlisted, ≤3,000 rows/call, same ceiling
  as every other hosted ingest here). This is how the second quarter (fleet #339, needed so
  `manager_changes`/`security_flows` have something real to diff) was loaded.
- Freshness: registered in `shared/src/freshness.ts` at a 200-day SLA — release cadence plus the
  ~45-day filing lag, so a *missed* release trips it within a quarter.

Schema and indexes: `supabase/migrations/061_sec_13f.sql`. The `(cusip, value_usd DESC)` index is
what makes the inversion viable; without it this is a 3.8M-row sequential scan and the build
is slower than the API it replaced.

## Multi-quarter backfill — throughput, resume, and what degrades at depth

Measured 2026-09-04 loading quarters 3-8 (fleet #1245, going from 2 quarters to 8 for
`manager_changes`/`security_flows` to have a real trend to show):

- **~870 rows/sec through the admin route**, so one quarter's ~2.8-3.8M holdings rows takes
  **~1-2 hours**, not minutes. Size 8 quarters of wall-clock time accordingly.
- **The loader is resumable, not all-or-nothing.** Every write uses
  `Prefer: resolution=merge-duplicates` keyed to the table's real unique id (`infotable_sk` for
  holdings, `accession_number` for managers/submissions), and `scripts/ingest-sec-13f-admin.mjs`
  ships `--skip-rows N` for exactly this. If a load dies mid-quarter, **do not delete and
  reload** — get the exact committed count (`count(*)`, not `pg_class.reltuples`, which is
  stale until the next autovacuum), subtract the pre-load baseline, and resume with
  `--skip-rows <delta>`. Batches are atomic per POST (≤3,000 rows), so the delta is always a
  clean multiple of the batch size — there is no partial-row corruption to clean up.
  **Do not run this loader unwatched by a Monitor/log-tail you might later tear down.** A
  Monitor and a `run_in_background` loader can share a process group in the harness, so calling
  `TaskStop` on the Monitor can kill the sibling loader with zero error output — the log just
  stops mid-line. If that happens, it looks exactly like a silent crash; check for it before
  assuming a DB-side failure.
- **`sec.gov` shares one egress IP across the whole fleet and rate-limits by IP.** Running this
  loader's ZIP fetch at the same time as any other lane's SEC bulk pull (Form 4/insider, EDGAR
  full-text, XBRL) tripped a 429 from SEC's Akamai front end with an extendable 10-minute
  timeout. Coordinate before starting a bulk `sec.gov` fetch — see CLAUDE.md's Cross-Project
  Rules.
- **Depth degrades `who_owns` on the ILIKE/ticker path — the index isn't the problem, the heap
  is.** `resolveTicker()`'s `issuer_name ILIKE '%name%' ORDER BY value_usd DESC LIMIT 50` (which
  runs on *every* plain-ticker call before any cusip lookup) does use the
  `sec_13f_holdings_issuer_trgm_idx` GIN trigram index — `EXPLAIN (ANALYZE, BUFFERS)` at ~10.1M
  rows / 1.8GB heap showed the index step taking 87ms. The other 5.16 of a 5.27s cold execution
  was the **Bitmap Heap Scan** fetching ~28K matched rows' table pages, most of which are not
  resident in Supabase's 512MB `shared_buffers`. A warm re-run of the same predicate came back
  in 107ms. This cost scales with table size, not with what the index can do — at 8 quarters
  (~9.7GB heap) expect cold ticker lookups to cost more than the ~5-20s measured at quarter 3,
  and it will keep growing with every future quarter added. A resolver-table follow-up (caching
  ticker→CUSIP so `resolveTicker()`'s scan runs once per security ever, not once per cold call)
  is tracked separately rather than blocking this backfill.
  *(Resolved: migration 154 built that resolver table — 8,510ms -> 2.1ms.)*
- **`who_owns` sums in the DB, and the reason is round-trip COUNT, not any one plan (fleet
  #1254, migration 156).** Two plan fixes landed first — 154 above, and 155 for
  `windowQuarterMap` — and neither moved `who_owns`, which stayed at 28-30s for a mega-cap.
  What it was actually paying: MSFT has 10,729 holdings rows and 6,801 accessions in the latest
  window, so one call made **103 sequential PostgREST requests** — 11 Range pages, then 46+46
  chunks of 150 to join submissions and managers — and returned 25 managers. The fix is
  `sec_13f_who_owns()`, which does the window scoping, amendment dedupe, manager join and
  group-by server-side in ONE request: 29.81s -> 11.75s for MSFT, 27.78s -> 9.68s for AAPL,
  with every manager total unchanged.
  **It is deliberately NOT a smaller fetch** — see the split-lines note above; capping rows is
  the #427 bug, where a manager's own total silently shrinks. Verify with
  `node scripts/sec13f-who-owns-bench.mjs before|after|--diff`, which fails on any changed
  manager total rather than on wall-clock alone.
  Responses carry `aggregated_in_db`. If it is `false`, the pack fell back to the old 103-trip
  path because the RPC 404'd — i.e. a deploy landed ahead of migration 156. That is correct but
  slow, and it is the one thing to check before re-diagnosing a slow `who_owns` from scratch.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-13f": {
      "url": "https://gateway.pipeworx.io/sec-13f/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-13f/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/who_owns \
  -H 'Content-Type: application/json' \
  -d '{"security":"NVIDIA","limit":25}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/who_owns`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sec-13f": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec-13f"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sec-13f
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec 13f data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
