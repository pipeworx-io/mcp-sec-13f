interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * SEC 13F — institutional ownership, asked security-first.
 *
 * THE POINT OF HOSTING THIS. The SEC publishes 13F manager-first, and so does
 * every API over it, ours included: `edgar_institutional_holdings` says in its
 * own description that answering "which funds hold $TICKER" means running it
 * per manager — a loop over ~8,000 filers. That is not a rate-limit problem, it
 * is a shape problem, and no upstream can fix it. Holding the flat table lets
 * one indexed query answer it.
 *
 * Bruce's use case (fleet #339) is deltas, not snapshots: "figure out what
 * people invest in, to drive custom newsletters." A newsletter is made of what
 * CHANGED — new positions, exits, adds, trims — so manager_changes and
 * security_flows are first-class tools here, not something a caller assembles
 * by diffing two who_owns calls themselves.
 *
 * Data: SEC's rolling-3-month release. Loaded by
 * scripts/ingest-sec-13f.mjs / scripts/ingest-sec-13f-admin.mjs (or the
 * data-pipeline worker for submissions/managers). Two windows are loaded as of
 * fleet #339 so the diff tools have something real to diff; holdings_coverage
 * reports exactly which quarters and how many rows.
 *
 * TICKER RESOLUTION (fleet #339). 13F has NO ticker column — CUSIP is the only
 * identifier of record — so a naive `who_owns("NVDA")` had nothing to key off
 * except issuer_name ILIKE '%NVDA%', which matches "Direxion Daily NVDA Bull 2X
 * ETF" and "YIELDMAX NVDA OPTION INCOME STRATEGY ETF" right alongside the real
 * NVIDIA CORPORATION position and ranks them together. That's a silent
 * wrong-answer bug. CUSIP is proprietary to CUSIP Global Services, so this
 * pack does NOT build or cache a bulk CUSIP<->ticker table (the same
 * discipline as the paywalled-standards rule) — instead, a ticker-shaped
 * input is resolved LIVE through OpenFIGI's public mapping API (Bloomberg
 * FIGI, openly licensed) to get the security's canonical name, which is then
 * matched against issuer_name in OUR OWN already-ingested data, preferring the
 * candidate with the largest aggregate value (a real operating company's
 * long-equity position dwarfs any option/leveraged-ETF wrapper's largest
 * single line). Every response says what it resolved to.
 *
 * WHAT THIS CANNOT TELL YOU, stated because 13F is routinely over-read:
 *  - It is LONG US-EQUITY ONLY, quarterly, and filed up to 45 days after the
 *    period end. It is a snapshot of the past, not a position today.
 *  - Shorts, cash, bonds and non-US holdings are absent by rule, so "how much
 *    does X own" is answerable only within that universe.
 *  - Only managers over $100M in 13F securities file at all.
 * Every response carries an as-of quarter and this caveat rather than leaving
 * the inference to the caller.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEC 13f');
}


interface Cfg { url: string; key: string }

const HOLDINGS = 'sec_13f_holdings';
const MANAGERS = 'sec_13f_managers';
const SUBMISSIONS = 'sec_13f_submissions';
// The narrow (cusip, issuer_name) resolve table — 243k rows behind the 10.1M
// in HOLDINGS, and it does not grow with history depth (migration 154).
const SECURITIES = 'sec_13f_securities';
// Dominant report_quarter per release window, aggregated in the DB (migration 155).
const WINDOW_QUARTERS = 'sec_13f_window_quarters';

async function pg<T>(cfg: Cfg, table: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`data query ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// PostgREST's own db-max-rows server setting silently CLAMPS every response to
// 1000 rows, regardless of what `limit=` a query asks for — measured live: a
// popular security's holdings query asked for limit=20000 and got exactly 1000
// rows back with no error, no truncation signal, just a 200. That undercounted
// one loaded quarter's holder count for TSLA from ~500 real holders down to 20
// (fleet #339) — the same "limit=200000 silently meant 1000 rows" failure class
// CLAUDE.md already tracks elsewhere in this fleet. Anywhere a result CAN
// plausibly exceed 1000 rows (a whole table, or a popular security/manager's
// full holdings) must page with Range headers instead of trusting `limit=`.
// `query` must NOT include its own `limit=` — Range headers own paging here.
const PG_PAGE = 1000;
async function pgAll<T>(cfg: Cfg, table: string, query: string, maxRows = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxRows; offset += PG_PAGE) {
    const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Range-Unit': 'items',
        Range: `${offset}-${offset + PG_PAGE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`data query ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < PG_PAGE) break;
  }
  return out;
}

// POST to a Postgres function. Used only where the ANSWER is an aggregate:
// PostgREST can filter and page, but it cannot GROUP BY, so any tool that ends
// in a sum has to choose between summing 10k rows on this side (N round-trips)
// or summing them in the DB (one). See sec_13f_who_owns, migration 156.
//
// `recoverable` names the two failures the caller can survive by taking the
// slow road instead, and NOTHING else:
//
//   404 / PGRST202  the function isn't there — the window between a gateway
//                   deploy and its migration being applied.
//   57014           Postgres cancelled it on statement_timeout. Aggregating
//                   server-side trades N statements for one, and one statement
//                   has to fit the budget alone; the paged path's 103 requests
//                   never could hit this. Measured live on 594918104 after
//                   migration 156, which is why 157/158 exist.
//
// Every other status still throws. The point is not to be forgiving — it is
// that these two have a correct answer available at a worse price, and the
// caller reports which price it paid (`aggregated_in_db`).
async function rpc<T>(
  cfg: Cfg, fn: string, body: Record<string, unknown>, recoverable = false,
): Promise<T | null> {
  const res = await pwFetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json() as Promise<T>;
  if (recoverable) {
    if (res.status === 404) return null;
    // clone(): httpError below reads the body too, and a Response body can
    // only be consumed once — reading it here without cloning would turn a
    // real error into an empty message.
    const detail = await res.clone().text().catch(() => '');
    if (/57014|statement timeout/i.test(detail)) return null;
  }
  throw await httpError(res, `data query ${fn}`);
}

// A single `accession_number=in.("a","b",...)` query string grows without
// bound with the id list — and fixing pgAll's row clamp above means that list
// can now legitimately be a security's full accession count instead of
// whatever fit in the first 1000 holdings rows. Live measured: a popular
// security has 1,000+ distinct accessions across 2 quarters, and building one
// IN-list from all of them 431'd ("Request Header Fields Too Large") instead
// of the truncated-but-200 result the unfixed pgAll used to mask this behind.
// Chunk any id-driven IN lookup rather than trusting one request to carry it.
async function pgByIds<T>(
  cfg: Cfg, table: string, selectAndFilter: string, idColumn: string, ids: string[], chunk = 150,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const rows = await pg<T[]>(
      cfg, table,
      `${selectAndFilter}&${idColumn}=in.(${batch.map((a) => `"${a}"`).join(',')})`,
    );
    out.push(...rows);
  }
  return out;
}

const CAVEAT =
  '13F covers long US-listed equity positions only, is filed quarterly up to 45 days after the period end, and only by managers holding over $100M in 13F securities. Shorts, cash, bonds and non-US holdings are excluded by rule — this is a lagged snapshot of one slice of a portfolio, not a current position.';

const AMENDMENT_NOTE =
  'Where a manager filed more than once for the same quarter (a 13F-HR plus one or more 13F-HR/A amendments), each security position is counted from the latest filing that reports that security — so a restatement replaces the original and a new-holdings amendment adds to it, without double-counting. Known limit: the SEC structured data does not say which kind an amendment is, so a position REMOVED by a restatement (rare — an error correction) can still be counted from the earlier filing it appeared in.';

const tools: McpToolExport['tools'] = [
  {
    name: 'who_owns',
    description:
      'Which institutional managers hold a given US-listed security, ranked by position size — the reverse of every 13F API, which requires you to name the manager first. Give a company name, ticker (e.g. "NVDA") or 9-character CUSIP. Ticker input is resolved through OpenFIGI, not a bulk symbol table. Returns each manager, the value of their position in USD, share count, and the reporting quarter. Answers "who owns NVDA", "which funds hold the most Apple", "institutional ownership of Tesla". Sourced from SEC Form 13F. Where a manager amended a quarter (13F-HR/A), each position is counted once, from the latest filing that reports it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        security: {
          type: 'string',
          description: 'Company name, ticker or 9-character CUSIP — e.g. "NVIDIA", "NVDA", "67066G104".',
        },
        limit: { type: 'number', description: 'How many managers to return, 1-100 (default 25).' },
      },
      required: ['security'],
    },
  },
  {
    name: 'manager_portfolio',
    description:
      'Every 13F position reported by one institutional manager, largest first — the classic manager-first view, over the same indexed data. Give the manager name ("Berkshire Hathaway", "Pershing Square"). Returns each holding with value and share count, plus the reported quarter. For what CHANGED since the prior quarter use manager_changes instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        manager: { type: 'string', description: 'Filing manager name or a distinctive fragment of it.' },
        limit: { type: 'number', description: 'How many positions to return, 1-200 (default 50).' },
      },
      required: ['manager'],
    },
  },
  {
    name: 'manager_changes',
    description:
      'What one institutional manager NEW-ed, EXITED, INCREASED or DECREASED between two 13F quarters — the newsletter primitive: a portfolio snapshot is not news, a change is. Give the manager name; optionally the two report quarters to compare (YYYY-MM-DD, e.g. "2026-03-31"), defaulting to the two most recent quarters loaded for that manager. Returns four ranked lists (new positions, exits, adds, trims) each with issuer, CUSIP, value in both quarters and the dollar delta.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        manager: { type: 'string', description: 'Filing manager name or a distinctive fragment of it.' },
        quarter: { type: 'string', description: 'The later ("to") quarter, e.g. "2026-03-31". Defaults to the manager\'s most recent loaded quarter.' },
        compare_to: { type: 'string', description: 'The earlier ("from") quarter. Defaults to the manager\'s next-most-recent loaded quarter.' },
        limit: { type: 'number', description: 'Max rows per bucket (new/exited/increased/decreased), 1-100 (default 25).' },
      },
      required: ['manager'],
    },
  },
  {
    name: 'security_flows',
    description:
      'Net institutional buying or selling of one security across the loaded 13F quarters — total position value and holder count per quarter, plus which managers newly bought, sold out, added to or trimmed that security between the two most recent quarters. Give a company name, ticker or CUSIP. Use for "is institutional ownership of NVDA growing", "who has been buying/selling Tesla".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        security: { type: 'string', description: 'Company name, ticker or 9-character CUSIP.' },
        limit: { type: 'number', description: 'Max managers per bucket in the mover lists, 1-100 (default 25).' },
      },
      required: ['security'],
    },
  },
  {
    name: 'manager_profile',
    description:
      'A profile of one institutional manager\'s 13F book: portfolio concentration (share of value in the top 5 / top 10 positions), turnover between the two most recent loaded quarters, and top positions. Use to characterize a manager\'s style before targeting them (e.g. for a newsletter) — concentrated vs. diversified, high vs. low turnover. Does NOT include sector/industry exposure: 13F carries no such field, and this pack does not fabricate one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        manager: { type: 'string', description: 'Filing manager name or a distinctive fragment of it.' },
      },
      required: ['manager'],
    },
  },
  {
    name: 'holdings_coverage',
    description:
      'What this 13F dataset currently covers: which SEC release windows and reporting quarters are loaded, how many filings and holdings rows are in each, and total size. Use to check freshness and to know which quarters manager_changes/security_flows can actually compare before relying on an ownership answer.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

/** PostgREST value escaping for the `in`/`eq`/`ilike` operators. */
const esc = (s: string) => s.replace(/[(),*]/g, ' ').trim();

interface HoldingRow {
  accession_number: string;
  issuer_name: string | null;
  cusip: string | null;
  class_title: string | null;
  value_usd: number | null;
  shares_or_principal: number | null;
  put_call: string | null;
  source_window: string | null;
}

interface ManagerRow {
  accession_number: string;
  manager_name: string | null;
  report_quarter: string | null;
  source_window?: string | null;
}

interface SubmissionRow {
  accession_number: string;
  cik: string | null;
  filing_date: string | null;
  period_of_report: string | null;
}

// A manager who amends files more than once for one quarter — a 13F-HR plus
// 13F-HR/A amendment(s), all inside the same release window, all carrying the
// same report_quarter — so neither the window scope nor the report_quarter
// re-check separates them, and every aggregation summed them all (fleet #427:
// who_owns NVDA reported cik 0002100119 at 3,077,100,764 shares, exactly 2x
// its real 1,538,550,382, ranking a mid-size filer above BlackRock).
//
// "Keep only the latest filing" is NOT the fix, because an amendment comes in
// two kinds and that rule is catastrophically wrong for one of them —
// verified on EDGAR for that same filer's 2026-03-31 chain: 001306 original,
// then 001311 (amendmentType RESTATEMENT, 3,982 holdings, the whole book)
// and 001313 (amendmentType NEW HOLDINGS, 80 holdings, additions only) BOTH
// filed 2026-05-15. Latest-filing-wins would report that manager's $4.0T
// book as the 80-position $47B addendum. Our ingested tables carry
// is_amendment but not amendmentType, so instead dedupe at the SECURITY
// level: within a (cik, period_of_report) chain, each security's position is
// taken from the latest filing that MENTIONS that security (filing_date,
// tie-broken on accession_number since amendments can share a date). A
// restatement re-reports everything it keeps, so it wins for every security
// it carries; a new-holdings amendment is disjoint, so it adds. The one
// shape this cannot catch — a restatement that silently REMOVES a security —
// stays counted from the earlier filing; AMENDMENT_NOTE says so.
async function submissionMeta(cfg: Cfg, accessions: string[]): Promise<Map<string, SubmissionRow>> {
  if (accessions.length <= 1) return new Map();
  const subs = await pgByIds<SubmissionRow>(
    cfg, SUBMISSIONS, 'select=accession_number,cik,filing_date,period_of_report', 'accession_number', accessions,
  );
  return new Map(subs.map((s) => [s.accession_number, s]));
}

function dedupeAmendedRows<T extends HoldingRow>(
  rows: T[], subs: Map<string, SubmissionRow>,
): { rows: T[]; superseded: number } {
  if (!subs.size) return { rows, superseded: 0 };
  // Winner per (chain, security): the accession that mentions this security
  // latest. A row with no submissions meta or no cik has nothing to chain on
  // and forms its own group, i.e. is kept as-is rather than silently dropped.
  const secKey = (r: T, s: SubmissionRow | undefined) => {
    const chain = s?.cik ? `${s.cik}|${s.period_of_report ?? ''}` : r.accession_number;
    return `${chain}|${r.cusip ?? r.issuer_name ?? ''}|${r.put_call ?? ''}`;
  };
  const winner = new Map<string, { acc: string; date: string }>();
  for (const r of rows) {
    const s = subs.get(r.accession_number);
    const date = s?.filing_date ?? '';
    const k = secKey(r, s);
    const w = winner.get(k);
    if (!w || (date.localeCompare(w.date) || r.accession_number.localeCompare(w.acc)) > 0) {
      winner.set(k, { acc: r.accession_number, date });
    }
  }
  const kept = rows.filter((r) => winner.get(secKey(r, subs.get(r.accession_number)))?.acc === r.accession_number);
  return { rows: kept, superseded: rows.length - kept.length };
}

// ── quarter bookkeeping ─────────────────────────────────────────────

// PostgREST has no SELECT DISTINCT; sec_13f_managers is small enough (tens of
// thousands of rows across however many windows are loaded) to pull a
// generous slice and dedupe client-side. Paged via pgAll (see its comment) —
// a plain limit=50000 here silently clamped to 1000 rows server-side, which
// happened to still compute the right mode with 2 windows loaded but was one
// more window away from picking a mode off a window it never even sampled.
//
// Each release window is DOMINATED by one report_quarter but not exclusive to
// it — a manager can file a 13F-HR/A inside this window that amends a filing
// from years earlier, and that stray row carries the OLD report_quarter. The
// first-row-wins version of this function picked whichever quarter PostgREST
// happened to return first for a window, which could be a single amendment
// rather than the ~11,000-filing quarter the window is actually for. Taking
// the MODE (most common report_quarter per window) is what makes windows
// resistant to that noise.
async function windowQuarterMap(cfg: Cfg): Promise<Map<string, string>> {
  // ONE round-trip returning one row per release window (~8), not up to FIFTY
  // returning up to 50,000 manager rows we then throw away (fleet #1251,
  // migration 155). This function is called by every who_owns / manager_changes
  // / manager_profile / security_flows call, and at PG_PAGE = 1000 the old
  // pgAll(…, 50000) was the dominant cost of all of them — measured at 30.0s
  // for a who_owns that skipped resolveTicker entirely. The dominant-quarter
  // logic it used to do in JS now lives in the view.
  const rows = await pg<Array<{ source_window: string | null; report_quarter: string | null }>>(
    cfg, WINDOW_QUARTERS, 'select=source_window,report_quarter',
  ).catch(() => []);
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.source_window && r.report_quarter) m.set(r.source_window, r.report_quarter);
  }
  return m;
}

// The set of report_quarter values that correspond to an ACTUALLY LOADED
// release (the dominant quarter of some window), as opposed to a report_quarter
// that only appears because a stray amendment referenced it. manager_changes /
// manager_profile / security_flows all filter to this set so a single 2018
// amendment inside the 2026 window can't masquerade as a loaded 2018 quarter.
async function loadedTargetQuarters(cfg: Cfg): Promise<Set<string>> {
  return new Set((await windowQuarterMap(cfg)).values());
}

// ── coverage ─────────────────────────────────────────────────────────

async function coverage(cfg: Cfg) {
  const wq = await windowQuarterMap(cfg);
  const windows = [...wq.keys()];
  // Returns null (never a silent 0) when the count itself failed — e.g. a
  // `count=exact` scan on an unindexed filter blowing PostgREST's statement
  // timeout (57014, 8s authenticated / 3s anon), which used to come back as a
  // bare 500 with no content-range header and get coerced through `?? 0` into
  // a clean-looking "holdings: 0" for a table that actually holds millions of
  // rows — the exact silent-success shape this fleet tracks. sec_13f_holdings
  // now has an index on source_window (migration 078) so this path is fast in
  // practice; null stays as the honest answer if a count ever fails again for
  // any other reason.
  const count = async (table: string, filter: string): Promise<number | null> => {
    const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${filter}&select=accession_number&limit=1`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
    });
    if (!res.ok) return null;
    const total = res.headers.get('content-range')?.split('/')[1];
    return total === undefined ? null : Number(total);
  };
  const perWindow = await Promise.all(
    windows.map(async (w) => ({
      release_window: w,
      report_quarter: wq.get(w) ?? null,
      filings: await count(SUBMISSIONS, `source_window=eq.${encodeURIComponent(w)}`),
      holdings: await count(HOLDINGS, `source_window=eq.${encodeURIComponent(w)}`),
    })),
  );
  perWindow.sort((a, b) => (b.report_quarter ?? '').localeCompare(a.report_quarter ?? ''));
  const countsIncomplete = perWindow.some((w) => w.filings === null || w.holdings === null);
  const totalHoldings = perWindow.reduce((s, w) => s + (w.holdings ?? 0), 0);
  const totalFilings = perWindow.reduce((s, w) => s + (w.filings ?? 0), 0);
  return {
    source: 'SEC Form 13F structured data',
    quarters_loaded: perWindow.length,
    quarters: perWindow,
    total_filings: totalFilings,
    total_holdings: totalHoldings,
    counts_incomplete: countsIncomplete,
    ...(countsIncomplete
      ? { counts_incomplete_note: 'One or more row counts above failed (e.g. a statement timeout) and are reported as null, not 0 — total_filings/total_holdings undercount by whatever those windows hold. Retry holdings_coverage; this is a query failure, not evidence of missing data.' }
      : {}),
    can_diff_quarters: perWindow.length >= 2,
    caveat: CAVEAT,
  };
}

// ── ticker resolution (OpenFIGI, live — no bulk CUSIP<->ticker table) ──

const OPENFIGI_BASE = 'https://api.openfigi.com/v3';
const OPENFIGI_UA = 'pipeworx-mcp-sec13f/1.0 (+https://pipeworx.io)';

const isCusip = (s: string) => /^[A-Za-z0-9]{9}$/.test(s);
const isTickerShape = (s: string) => /^[A-Za-z]{1,6}(\.[A-Za-z]{1,2})?$/.test(s);

// Wrapper/derivative products whose issuer_name mentions the underlying
// ticker but which are NOT the underlying — a leveraged/option ETF, not the
// stock. Excluded when picking which CUSIP a ticker resolves to.
const NOISE_RE = /\b(ETF|FUND|TRUST|OPTION|OPTIONS|STRATEGY|LEVERAGED|BULL|BEAR|INVERSE|SWAP|NOTES?|WARRANTS?|UNITS?|2X|3X)\b/i;

const SUFFIX_RE = /\b(CORPORATION|CORP|INCORPORATED|INC|COMPANY|CO|LTD|LIMITED|PLC|GROUP|HOLDINGS?|CLASS\s+[A-Z])\b\.?/g;

function canonicalToken(name: string): string {
  const cleaned = name.toUpperCase().replace(SUFFIX_RE, '').replace(/[.,]/g, '').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens[0] === 'THE') tokens.shift();
  return tokens[0] ?? name;
}

async function openfigiMapTicker(ticker: string): Promise<{ figi: string; ticker: string; name: string } | null> {
  try {
    const res = await pwFetch(`${OPENFIGI_BASE}/mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': OPENFIGI_UA },
      body: JSON.stringify([{ idType: 'TICKER', idValue: ticker.toUpperCase(), exchCode: 'US' }]),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ data?: Array<{ figi: string; ticker: string; name: string; securityType?: string }> }>;
    const hits = body?.[0]?.data ?? [];
    const hit = hits.find((d) => (d.securityType ?? '').toLowerCase().includes('common stock')) ?? hits[0];
    if (!hit) return null;
    return { figi: hit.figi, ticker: hit.ticker, name: hit.name };
  } catch {
    return null;
  }
}

interface SecurityRow { cusip: string | null; issuer_name: string | null; max_value_usd: number | null }
interface ResolvedSecurity { cusip: string; issuer_name: string; figi: string; ticker: string }

/**
 * Ticker -> CUSIP, entirely without a bulk CUSIP<->ticker table: resolve the
 * canonical company name via OpenFIGI, then find the CUSIP among OUR OWN
 * already-ingested securities whose issuer_name matches that name and which has
 * the largest reported position (a real mega-cap's smallest individual
 * position still dwarfs a themed ETF's largest, so the top-value row is
 * reliably the underlying, not the wrapper). Returns null (never throws) so
 * callers fall back to the existing issuer_name search on any failure.
 *
 * THIS READS sec_13f_securities, NOT sec_13f_holdings (fleet #1251). The same
 * query against the holdings heap cost 5,246 ms of Bitmap Heap Scan for the
 * ~27,700 rows a trigram token matches at 10.1M rows — five seconds spent
 * resolving, to then run a 160 ms CUSIP lookup. sec_13f_securities holds one
 * row per (cusip, issuer_name), 243k of them, and stays cached; crucially it
 * does not grow when quarters are added, so this stops being a function of
 * history depth. Ranking is unchanged: max_value_usd per security orders
 * candidates exactly as ORDER BY value_usd DESC over individual rows did.
 */
async function resolveTicker(cfg: Cfg, raw: string): Promise<ResolvedSecurity | null> {
  const fig = await openfigiMapTicker(raw);
  if (!fig) return null;
  const token = canonicalToken(fig.name);
  if (!token || token.length < 2) return null;
  const rows = await pg<SecurityRow[]>(
    cfg, SECURITIES,
    `select=cusip,issuer_name,max_value_usd&issuer_name=ilike.*${encodeURIComponent(token)}*&order=max_value_usd.desc&limit=50`,
  ).catch(() => [] as SecurityRow[]);
  const best = rows.find((r) => r.cusip && !NOISE_RE.test(r.issuer_name ?? '')) ?? rows.find((r) => r.cusip);
  if (!best?.cusip) return null;
  return { cusip: best.cusip, issuer_name: best.issuer_name ?? fig.name, figi: fig.figi, ticker: fig.ticker || raw.toUpperCase() };
}

// ── who_owns ─────────────────────────────────────────────────────────

interface Holder {
  manager: string;
  value_usd: number;
  shares: number;
  lines: number;
  quarter: string | null;
  derivative: boolean;
}

/** Everything who_owns needs about the holdings themselves, however it got it. */
interface OwnershipRollup {
  /** Which path produced this. Reported to the caller, because the fallback
   *  below is otherwise INVISIBLE: a who_owns that quietly took the 103-
   *  round-trip road answers correctly and slowly, which is indistinguishable
   *  from a database having a bad day. One field turns "why is this 30s again"
   *  from a bisect into a look. */
  aggregated_in_db: boolean;
  /** Rows the security matched BEFORE dedupe. 0 — and only 0 — is found:false.
   *  Not derived from `holders`: a security can match rows that the
   *  report_quarter re-check then drops, and that is an empty answer about a
   *  security we hold, not an unknown security. Conflating the two is how a
   *  "no such CUSIP" hint gets shown for a CUSIP we demonstrably have. */
  row_count: number;
  holders: Holder[];
  total_holders: number;
  issuer_names: string[];
  release_window: string | null;
  superseded: number;
}

/**
 * The aggregate, computed in the DB (migration 156). ONE round-trip.
 *
 * Returns null on the two failures the paged path can still answer through —
 * the function missing (deploy ahead of migration) and a statement timeout —
 * because a pack that 500s is a worse outcome than a slow one. Every other
 * failure throws, and the path taken is reported either way: a silently
 * degraded path that never announces itself is how a "fix" gets reported on a
 * call that quietly took the old road the whole time.
 */
async function ownershipAggregated(
  cfg: Cfg, cusip: string | null, issuerPattern: string | null, limit: number,
): Promise<OwnershipRollup | null> {
  interface AggRow {
    row_count: number; deduped_count: number; superseded: number; total_holders: number;
    release_window: string | null; issuer_names: string[] | null; holders: Holder[] | null;
  }
  const agg = await rpc<AggRow>(
    cfg, 'sec_13f_who_owns', { p_cusip: cusip, p_issuer: issuerPattern, p_limit: limit }, true,
  );
  if (agg === null) return null;
  if (agg.holders === null) {
    return { aggregated_in_db: true, row_count: 0, holders: [], total_holders: 0, issuer_names: [], release_window: null, superseded: 0 };
  }
  return {
    aggregated_in_db: true,
    row_count: agg.row_count,
    holders: (agg.holders ?? []).map((h) => ({ ...h, value_usd: Number(h.value_usd), shares: Number(h.shares) })),
    total_holders: agg.total_holders,
    issuer_names: agg.issuer_names ?? [],
    release_window: agg.release_window,
    superseded: agg.superseded,
  };
}

async function whoOwns(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.security ?? '').trim();
  if (!raw) throw new Error('user_error: `security` is required — a company name, ticker or CUSIP.');
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 25));

  let filter: string;
  let matchedOn: string;
  let resolved: ResolvedSecurity | null = null;
  // The same two lookups the PostgREST `filter` encodes, in the form the RPC
  // takes. Kept side by side deliberately: the fallback below still needs the
  // filter string, and the two must never drift apart.
  let cusipArg: string | null = null;
  let issuerArg: string | null = null;

  if (isCusip(raw)) {
    filter = `cusip=eq.${esc(raw.toUpperCase())}`;
    cusipArg = raw.toUpperCase();
    matchedOn = 'cusip';
  } else if (isTickerShape(raw)) {
    resolved = await resolveTicker(cfg, raw);
    if (resolved) {
      filter = `cusip=eq.${esc(resolved.cusip)}`;
      cusipArg = resolved.cusip;
      matchedOn = 'ticker_via_openfigi';
    } else {
      filter = `issuer_name=ilike.*${encodeURIComponent(esc(raw))}*`;
      issuerArg = `%${raw}%`;
      matchedOn = 'issuer_name';
    }
  } else {
    filter = `issuer_name=ilike.*${encodeURIComponent(esc(raw))}*`;
    issuerArg = `%${raw}%`;
    matchedOn = 'issuer_name';
  }

  const rollup = (await ownershipAggregated(cfg, cusipArg, issuerArg, limit))
    ?? (await ownershipPaged(cfg, filter, limit));

  if (!rollup.row_count) {
    return {
      found: false,
      security: raw,
      matched_on: matchedOn,
      resolved_via: resolved ? { cusip: resolved.cusip, ticker: resolved.ticker, figi: resolved.figi } : null,
      reason: 'no_13f_positions',
      hint: isCusip(raw)
        ? `No 13F holding reports CUSIP ${raw.toUpperCase()} in loaded quarters. Check the CUSIP, or search by company name instead.`
        : `No 13F issuer name contains "${raw}" in loaded quarters. 13F has no ticker column — issuers are named as the filer typed them ("NVIDIA CORP", "APPLE INC"); a ticker is resolved live through OpenFIGI, so an unrecognised or delisted symbol will land here too.`,
      caveat: CAVEAT,
    };
  }

  return {
    found: true,
    security: raw,
    matched_on: matchedOn,
    resolved_via: resolved ? { cusip: resolved.cusip, ticker: resolved.ticker, figi: resolved.figi, issuer_name: resolved.issuer_name } : null,
    issuer_names_matched: rollup.issuer_names,
    release_window: rollup.release_window,
    reporting_quarter: rollup.holders[0]?.quarter ?? null,
    total_holders: rollup.total_holders,
    returned: rollup.holders.length,
    holders: rollup.holders,
    amended_rows_superseded: rollup.superseded,
    aggregated_in_db: rollup.aggregated_in_db,
    amendment_note: AMENDMENT_NOTE,
    caveat: CAVEAT,
  };
}

/**
 * The pre-156 path, kept as the fallback for a deploy that lands before its
 * migration. 103 sequential PostgREST round-trips for a mega-cap, measured on
 * MSFT 2026-09-05: 11 Range pages over 10,729 holdings rows, then 92 chunks of
 * 150 over 6,801 accessions (submissions, then managers). That is the whole
 * reason 156 exists — but it is CORRECT, and correct-and-slow beats a 500.
 */
async function ownershipPaged(cfg: Cfg, filter: string, limit: number): Promise<OwnershipRollup> {
  // Scope to the single most-recent loaded quarter's release window(s) BEFORE
  // fetching. With more than one quarter loaded, a manager who filed in both
  // would otherwise get its two quarters' dollar values silently SUMMED into
  // one blended, wrong number — exactly the "returned a plausible number that
  // was wrong" failure class, not a crash. Window-scoping at the query also
  // means `limit` rows ordered by value are actually the top holders of THIS
  // quarter, not crowded out by a differently-priced older quarter.
  const wq = await windowQuarterMap(cfg);
  const latestQuarter = [...wq.values()].sort().pop() ?? null;
  const latestWindows = latestQuarter ? [...wq.entries()].filter(([, q]) => q === latestQuarter).map(([w]) => w) : [];
  const windowFilter = latestWindows.length ? `&source_window=in.(${latestWindows.map((w) => `"${w}"`).join(',')})` : '';

  // ALL of the security's rows in the window, not a top-value slice: a big
  // manager reports one position as many lines (voting/discretion splits),
  // and a `limit*3` fetch cut the smaller lines off, shrinking that
  // manager's total with the caller's `limit` — live measured on NVDA,
  // BlackRock summed 1.807B shares at the default limit vs its real 1.90B
  // (fleet #427). Paged via pgAll; ordered so Range paging is deterministic.
  const rows = await pgAll<HoldingRow>(
    cfg, HOLDINGS,
    `select=accession_number,issuer_name,cusip,class_title,value_usd,shares_or_principal,put_call,source_window` +
      `&${filter}${windowFilter}&order=value_usd.desc`,
    20000,
  );

  if (!rows.length) {
    return { aggregated_in_db: false, row_count: 0, holders: [], total_holders: 0, issuer_names: [], release_window: null, superseded: 0 };
  }

  const accessions = [...new Set(rows.map((r) => r.accession_number))];
  // Drop superseded amendment-chain rows (original + amendment for the same
  // cik/quarter both pass the window scope AND the report_quarter re-check
  // below — see dedupeAmendedRows) BEFORE aggregating, or an amending
  // manager's position doubles.
  const subs = await submissionMeta(cfg, accessions);
  const { rows: dedupedRows, superseded } = dedupeAmendedRows(rows, subs);
  const keptAccessions = [...new Set(dedupedRows.map((r) => r.accession_number))];
  const managers = await pgByIds<ManagerRow>(
    cfg, MANAGERS, 'select=accession_number,manager_name,report_quarter', 'accession_number', keptAccessions,
  );
  const byAccession = new Map(managers.map((m) => [m.accession_number, m]));

  const byManager = new Map<string, Holder>();
  for (const r of dedupedRows) {
    const m = byAccession.get(r.accession_number);
    // Defensive re-check: the window filter above scopes to the latest
    // quarter's release window(s), but an amendment filed IN that window can
    // still carry an OLDER report_quarter — exclude it rather than blend it
    // into this quarter's totals.
    if (latestQuarter && m?.report_quarter && m.report_quarter !== latestQuarter) continue;
    const name = m?.manager_name ?? '(unknown filer)';
    const cur = byManager.get(name) ?? { manager: name, value_usd: 0, shares: 0, lines: 0, quarter: m?.report_quarter ?? null, derivative: false };
    cur.value_usd += Number(r.value_usd ?? 0);
    cur.shares += Number(r.shares_or_principal ?? 0);
    cur.lines += 1;
    if (r.put_call) cur.derivative = true;
    byManager.set(name, cur);
  }
  const holders = [...byManager.values()].sort((a, b) => b.value_usd - a.value_usd).slice(0, limit);

  return {
    aggregated_in_db: false,
    row_count: rows.length,
    holders,
    total_holders: byManager.size,
    issuer_names: [...new Set(dedupedRows.map((r) => r.issuer_name))].slice(0, 5).filter((n): n is string => n !== null),
    release_window: dedupedRows[0]?.source_window ?? null,
    superseded,
  };
}

// ── manager_portfolio ────────────────────────────────────────────────

async function managerAccessions(cfg: Cfg, raw: string, limit = 50): Promise<ManagerRow[]> {
  return pg<ManagerRow[]>(
    cfg, MANAGERS,
    `select=accession_number,manager_name,report_quarter&manager_name=ilike.*${encodeURIComponent(esc(raw))}*&limit=${limit}`,
  );
}

async function managerPortfolio(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.manager ?? '').trim();
  if (!raw) throw new Error('user_error: `manager` is required — the filing manager name, e.g. "Berkshire Hathaway".');
  const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 50));

  const [managers, targetQuarters] = await Promise.all([managerAccessions(cfg, raw, 25), loadedTargetQuarters(cfg)]);
  if (!managers.length) {
    return {
      found: false,
      manager: raw,
      reason: 'no_such_filer',
      hint: `No 13F filer name contains "${raw}" in loaded quarters. Names are as filed ("BERKSHIRE HATHAWAY INC", "PERSHING SQUARE CAPITAL MANAGEMENT, L.P."), and a manager under $100M in 13F securities does not file at all.`,
      caveat: CAVEAT,
    };
  }
  // Most-recent quarter this manager filed, so a manager present in more than
  // one loaded window still gets the current portfolio, not a blend of both.
  //
  // Restricted to loadedTargetQuarters — the majority-vote-verified set every
  // other tool here already filters through (coverage/whoOwns/manager_changes/
  // manager_profile) — rather than a raw max() over this manager's own
  // report_quarter values. COVERPAGE's REPORTCALENDARORQUARTER is filer-typed
  // and unclamped; one mistyped filing (e.g. a 2027 date meant to say 2025)
  // would otherwise become "the manager's latest quarter" outright and pull
  // whatever accession happens to carry it — the same silent-corruption shape
  // fleet #1240 found in the sibling insider pack's coverage tool, just via a
  // different field. (fleet #1245)
  const quartersFiled = managers.map((m) => m.report_quarter).filter((q): q is string => !!q && targetQuarters.has(q));
  const latestQuarter = [...quartersFiled].sort((a, b) => b.localeCompare(a))[0];
  if (!latestQuarter) {
    return {
      found: false,
      manager: raw,
      reason: 'no_positions_in_loaded_quarters',
      hint: `"${raw}" matched a filer, but none of its report_quarter values fall inside a release we actually loaded — likely a stale or off-window filing. Loaded quarters: ${[...targetQuarters].sort().reverse().join(', ') || '(none)'}.`,
      caveat: CAVEAT,
    };
  }
  const accessions = managers.filter((m) => m.report_quarter === latestQuarter).map((m) => m.accession_number);
  // The WHOLE chain, not a top-value slice: amendment dedup needs every row
  // (a top-N fetch per filing could keep a superseded line whose restated
  // replacement ranked below N), and an original + its amendments all carry
  // latestQuarter, so without dedupeAmendedRows every amended position
  // doubles (fleet #427).
  const allRows = await pgAll<HoldingRow>(
    cfg, HOLDINGS,
    `select=issuer_name,cusip,class_title,value_usd,shares_or_principal,put_call,accession_number,source_window` +
      `&accession_number=in.(${accessions.map((a) => `"${a}"`).join(',')})&order=value_usd.desc`,
    20000,
  );
  const { rows: dedupedRows, superseded } = dedupeAmendedRows(allRows, await submissionMeta(cfg, accessions));
  const rows = dedupedRows.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0)).slice(0, limit);
  return {
    found: true,
    manager: raw,
    filers_matched: [...new Set(managers.map((m) => m.manager_name))].slice(0, 10),
    reporting_quarter: latestQuarter ?? null,
    release_window: rows[0]?.source_window ?? null,
    total_positions: dedupedRows.length,
    returned: rows.length,
    positions: rows.map((r) => ({
      issuer_name: r.issuer_name,
      cusip: r.cusip,
      class_title: r.class_title,
      value_usd: r.value_usd,
      shares_or_principal: r.shares_or_principal,
      put_call: r.put_call,
    })),
    amended_rows_superseded: superseded,
    amendment_note: AMENDMENT_NOTE,
    caveat: CAVEAT,
  };
}

// ── generic quarter-over-quarter diff (shared by manager_changes and
//    security_flows — same shape, different key: cusip for one manager,
//    manager for one security) ────────────────────────────────────────

interface Position { key: string; label: string; value_usd: number; shares: number; extra?: Record<string, unknown> }

function diffPositions(fromRows: Position[], toRows: Position[]) {
  const fromMap = new Map(fromRows.map((p) => [p.key, p]));
  const toMap = new Map(toRows.map((p) => [p.key, p]));
  const newPositions: Array<Record<string, unknown>> = [];
  const increased: Array<Record<string, unknown>> = [];
  const decreased: Array<Record<string, unknown>> = [];
  let unchangedCount = 0;

  for (const [key, t] of toMap) {
    const f = fromMap.get(key);
    if (!f) { newPositions.push({ ...t.extra, label: t.label, value_usd: t.value_usd, shares: t.shares }); continue; }
    const delta = t.value_usd - f.value_usd;
    const base = Math.max(Math.abs(f.value_usd), 1);
    if (Math.abs(delta) / base < 0.01) { unchangedCount++; continue; }
    const row = { ...t.extra, label: t.label, value_usd_from: f.value_usd, value_usd_to: t.value_usd, delta_usd: delta, shares_from: f.shares, shares_to: t.shares };
    (delta > 0 ? increased : decreased).push(row);
  }
  const exited: Array<Record<string, unknown>> = [];
  for (const [key, f] of fromMap) {
    if (!toMap.has(key)) exited.push({ ...f.extra, label: f.label, value_usd: f.value_usd, shares: f.shares });
  }

  newPositions.sort((a, b) => (b.value_usd as number) - (a.value_usd as number));
  exited.sort((a, b) => (b.value_usd as number) - (a.value_usd as number));
  increased.sort((a, b) => (b.delta_usd as number) - (a.delta_usd as number));
  decreased.sort((a, b) => (a.delta_usd as number) - (b.delta_usd as number));
  return { newPositions, exited, increased, decreased, unchangedCount };
}

// ── manager_changes ──────────────────────────────────────────────────

function normalizeQuarterArg(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return s || undefined;
}

async function managerChanges(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.manager ?? '').trim();
  if (!raw) throw new Error('user_error: `manager` is required — the filing manager name, e.g. "Berkshire Hathaway".');
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 25));

  const [managers, targetQuarters] = await Promise.all([managerAccessions(cfg, raw, 100), loadedTargetQuarters(cfg)]);
  if (!managers.length) {
    return {
      found: false, manager: raw, reason: 'no_such_filer',
      hint: `No 13F filer name contains "${raw}" in loaded quarters.`,
      caveat: CAVEAT,
    };
  }
  // Restrict to quarters an actual release was loaded for — a lone amendment
  // referencing an old, unloaded quarter must not look like a second quarter
  // to diff against.
  const quartersAvailable = [...new Set(managers.map((m) => m.report_quarter).filter((q): q is string => !!q && targetQuarters.has(q)))]
    .sort((a, b) => b.localeCompare(a));
  if (quartersAvailable.length < 2) {
    return {
      found: false, manager: raw, reason: 'only_one_quarter_loaded',
      quarters_available: quartersAvailable,
      hint: `Only ${quartersAvailable.length} quarter(s) of 13F data are loaded for this manager, so there is nothing to diff yet. Loaded quarters: ${quartersAvailable.join(', ') || '(none)'}.`,
      caveat: CAVEAT,
    };
  }

  const toQuarter = normalizeQuarterArg(args.quarter) ?? quartersAvailable[0];
  const toIdx = quartersAvailable.indexOf(toQuarter);
  const fromQuarter = normalizeQuarterArg(args.compare_to) ?? quartersAvailable[toIdx >= 0 ? toIdx + 1 : 1];

  if (!quartersAvailable.includes(toQuarter) || !fromQuarter || !quartersAvailable.includes(fromQuarter)) {
    return {
      found: false, manager: raw, reason: 'quarter_not_loaded',
      quarters_available: quartersAvailable,
      hint: `Requested quarter not among the loaded quarters for this manager (${quartersAvailable.join(', ')}).`,
      caveat: CAVEAT,
    };
  }

  const accessionsFor = (q: string) => managers.filter((m) => m.report_quarter === q).map((m) => m.accession_number);
  let superseded = 0;
  const fetchPositions = async (accessions: string[]): Promise<Position[]> => {
    if (!accessions.length) return [];
    // pgAll: a single large manager (Vanguard, BlackRock, State Street) routinely
    // files several thousand distinct positions in one quarter — well past
    // PostgREST's 1000-row response clamp, which `limit=5000` did not protect
    // against (fleet #339; see pgAll's comment for the measured failure).
    const allRows = await pgAll<HoldingRow>(
      cfg, HOLDINGS,
      `select=issuer_name,cusip,value_usd,shares_or_principal,put_call,accession_number&accession_number=in.(${accessions.map((a) => `"${a}"`).join(',')})`,
      20000,
    );
    // Amendment dedup (dedupeAmendedRows) — an original + its amendments all
    // land in accessionsFor(q) and the diff would sum both sides (fleet #427).
    const dedup = dedupeAmendedRows(allRows, await submissionMeta(cfg, accessions));
    superseded += dedup.superseded;
    const rows = dedup.rows;
    const byKey = new Map<string, Position>();
    for (const r of rows) {
      if (!r.cusip) continue;
      const key = `${r.cusip}|${r.put_call ?? ''}`;
      const cur = byKey.get(key) ?? { key, label: r.issuer_name ?? r.cusip, value_usd: 0, shares: 0, extra: { cusip: r.cusip, put_call: r.put_call } };
      cur.value_usd += Number(r.value_usd ?? 0);
      cur.shares += Number(r.shares_or_principal ?? 0);
      byKey.set(key, cur);
    }
    return [...byKey.values()];
  };

  const [fromPositions, toPositions] = await Promise.all([
    fetchPositions(accessionsFor(fromQuarter)),
    fetchPositions(accessionsFor(toQuarter)),
  ]);

  const diff = diffPositions(fromPositions, toPositions);
  const shape = (rows: Array<Record<string, unknown>>) => rows.slice(0, limit).map((r) => ({ issuer_name: r.label, cusip: r.cusip, ...r, label: undefined }));

  return {
    found: true,
    manager: raw,
    filers_matched: [...new Set(managers.map((m) => m.manager_name))].slice(0, 10),
    from_quarter: fromQuarter,
    to_quarter: toQuarter,
    new: shape(diff.newPositions),
    exited: shape(diff.exited),
    increased: shape(diff.increased),
    decreased: shape(diff.decreased),
    unchanged_count: diff.unchangedCount,
    counts: { new: diff.newPositions.length, exited: diff.exited.length, increased: diff.increased.length, decreased: diff.decreased.length },
    amended_rows_superseded: superseded,
    amendment_note: AMENDMENT_NOTE,
    caveat: CAVEAT,
  };
}

// ── security_flows ───────────────────────────────────────────────────

async function securityFlows(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.security ?? '').trim();
  if (!raw) throw new Error('user_error: `security` is required — a company name, ticker or CUSIP.');
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 25));

  let cusip: string | null = null;
  let resolved: ResolvedSecurity | null = null;
  let matchedOn: string;
  if (isCusip(raw)) {
    cusip = raw.toUpperCase();
    matchedOn = 'cusip';
  } else {
    resolved = isTickerShape(raw) ? await resolveTicker(cfg, raw) : null;
    if (resolved) { cusip = resolved.cusip; matchedOn = 'ticker_via_openfigi'; }
    else {
      // Name-only fallback: find the dominant CUSIP for this name the same
      // way ticker resolution would, without going through OpenFIGI.
      const candidates = await pg<HoldingRow[]>(
        cfg, HOLDINGS,
        `select=cusip,issuer_name,value_usd&issuer_name=ilike.*${encodeURIComponent(esc(raw))}*&order=value_usd.desc&limit=50`,
      ).catch(() => [] as HoldingRow[]);
      const best = candidates.find((r) => r.cusip);
      cusip = best?.cusip ?? null;
      matchedOn = 'issuer_name';
    }
  }

  if (!cusip) {
    return {
      found: false, security: raw, matched_on: 'none', reason: 'no_13f_positions',
      hint: `Could not resolve "${raw}" to a CUSIP held in loaded 13F quarters.`,
      caveat: CAVEAT,
    };
  }

  // pgAll, not pg: a popular security's holdings across 2+ quarters routinely
  // exceeds PostgREST's 1000-row response clamp — live measured, TSLA alone is
  // 14,034 rows across the 2 loaded quarters. A plain `limit=20000` call here
  // silently came back with exactly 1000 rows and no error, undercounting the
  // older quarter's holder count from ~500 real holders to 20 (fleet #339).
  const rows = await pgAll<HoldingRow & { accession_number: string }>(
    cfg, HOLDINGS,
    `select=accession_number,issuer_name,cusip,value_usd,shares_or_principal,put_call,source_window&cusip=eq.${esc(cusip)}`,
    20000,
  );
  if (!rows.length) {
    return {
      found: false, security: raw, matched_on: matchedOn, cusip,
      resolved_via: resolved ? { ticker: resolved.ticker, figi: resolved.figi } : null,
      reason: 'no_13f_positions',
      hint: `CUSIP ${cusip} has no holdings in loaded quarters.`,
      caveat: CAVEAT,
    };
  }

  const accessions = [...new Set(rows.map((r) => r.accession_number))];
  const [managers, targetQuarters, subs] = await Promise.all([
    pgByIds<ManagerRow>(
      cfg, MANAGERS, 'select=accession_number,manager_name,report_quarter', 'accession_number', accessions,
    ),
    loadedTargetQuarters(cfg),
    submissionMeta(cfg, accessions),
  ]);
  const byAccession = new Map(managers.map((m) => [m.accession_number, m]));
  // Amendment dedup (dedupeAmendedRows) — an amending manager otherwise
  // counts double in both the per-quarter totals and the mover diff, and its
  // phantom "delta" pollutes increased/decreased (fleet #427).
  const dedup = dedupeAmendedRows(rows, subs);
  const dedupedRows = dedup.rows;

  // Group by report_quarter (via the joined manager row, not source_window —
  // an amendment can carry a different window than the quarter it amends).
  // Restricted to targetQuarters: a lone amendment inside a loaded window can
  // reference a quarter years earlier, and without this filter that one row
  // rendered as a full "quarter" of NVDA ownership with holder_count: 1.
  const byQuarter = new Map<string, { total_value_usd: number; total_shares: number; holders: Set<string> }>();
  const perManagerPerQuarter = new Map<string, Map<string, Position>>(); // quarter -> manager -> position
  for (const r of dedupedRows) {
    const m = byAccession.get(r.accession_number);
    const q = m?.report_quarter;
    if (!q || !targetQuarters.has(q)) continue;
    const bucket = byQuarter.get(q) ?? { total_value_usd: 0, total_shares: 0, holders: new Set<string>() };
    bucket.total_value_usd += Number(r.value_usd ?? 0);
    bucket.total_shares += Number(r.shares_or_principal ?? 0);
    const managerName = m?.manager_name ?? '(unknown filer)';
    bucket.holders.add(managerName);
    byQuarter.set(q, bucket);

    const mgrMap = perManagerPerQuarter.get(q) ?? new Map<string, Position>();
    const key = managerName;
    const cur = mgrMap.get(key) ?? { key, label: managerName, value_usd: 0, shares: 0 };
    cur.value_usd += Number(r.value_usd ?? 0);
    cur.shares += Number(r.shares_or_principal ?? 0);
    mgrMap.set(key, cur);
    perManagerPerQuarter.set(q, mgrMap);
  }

  const quarters = [...byQuarter.keys()].sort((a, b) => b.localeCompare(a));
  const byQuarterOut = quarters.map((q) => {
    const b = byQuarter.get(q)!;
    return { report_quarter: q, total_value_usd: b.total_value_usd, total_shares: b.total_shares, holder_count: b.holders.size };
  });

  let movers: ReturnType<typeof diffPositions> | null = null;
  let fromQ: string | null = null, toQ: string | null = null;
  if (quarters.length >= 2) {
    toQ = quarters[0]; fromQ = quarters[1];
    const toPositions = [...(perManagerPerQuarter.get(toQ) ?? new Map()).values()];
    const fromPositions = [...(perManagerPerQuarter.get(fromQ) ?? new Map()).values()];
    movers = diffPositions(fromPositions, toPositions);
  }

  return {
    found: true,
    security: raw,
    matched_on: matchedOn,
    cusip,
    resolved_via: resolved ? { ticker: resolved.ticker, figi: resolved.figi, issuer_name: resolved.issuer_name } : null,
    issuer_names_matched: [...new Set(dedupedRows.map((r) => r.issuer_name))].slice(0, 5),
    by_quarter: byQuarterOut,
    net_flow: movers
      ? {
          from_quarter: fromQ, to_quarter: toQ,
          delta_total_value_usd: (byQuarter.get(toQ!)?.total_value_usd ?? 0) - (byQuarter.get(fromQ!)?.total_value_usd ?? 0),
          delta_holder_count: (byQuarter.get(toQ!)?.holders.size ?? 0) - (byQuarter.get(fromQ!)?.holders.size ?? 0),
          new_buyers: movers.newPositions.slice(0, limit).map((r) => ({ manager: r.label, value_usd: r.value_usd })),
          exited_holders: movers.exited.slice(0, limit).map((r) => ({ manager: r.label, value_usd: r.value_usd })),
          increased_positions: movers.increased.slice(0, limit).map((r) => ({ manager: r.label, value_usd_from: r.value_usd_from, value_usd_to: r.value_usd_to, delta_usd: r.delta_usd })),
          decreased_positions: movers.decreased.slice(0, limit).map((r) => ({ manager: r.label, value_usd_from: r.value_usd_from, value_usd_to: r.value_usd_to, delta_usd: r.delta_usd })),
        }
      : { note: 'Only one quarter loaded for this security — nothing to diff yet.' },
    amended_rows_superseded: dedup.superseded,
    amendment_note: AMENDMENT_NOTE,
    caveat: CAVEAT,
  };
}

// ── manager_profile ──────────────────────────────────────────────────

async function managerProfile(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.manager ?? '').trim();
  if (!raw) throw new Error('user_error: `manager` is required — the filing manager name, e.g. "Berkshire Hathaway".');

  const [managers, targetQuarters] = await Promise.all([managerAccessions(cfg, raw, 100), loadedTargetQuarters(cfg)]);
  if (!managers.length) {
    return {
      found: false, manager: raw, reason: 'no_such_filer',
      hint: `No 13F filer name contains "${raw}" in loaded quarters.`,
      caveat: CAVEAT,
    };
  }
  const quartersAvailable = [...new Set(managers.map((m) => m.report_quarter).filter((q): q is string => !!q && targetQuarters.has(q)))]
    .sort((a, b) => b.localeCompare(a));
  const latestQuarter = quartersAvailable[0];
  const priorQuarter = quartersAvailable[1] ?? null;

  let superseded = 0;
  const fetchPositions = async (q: string): Promise<Position[]> => {
    const accessions = managers.filter((m) => m.report_quarter === q).map((m) => m.accession_number);
    if (!accessions.length) return [];
    // pgAll — same reasoning as managerChanges' fetchPositions: a large
    // manager's position count routinely exceeds PostgREST's 1000-row clamp.
    const allRows = await pgAll<HoldingRow>(
      cfg, HOLDINGS,
      `select=issuer_name,cusip,value_usd,shares_or_principal,put_call,accession_number&accession_number=in.(${accessions.map((a) => `"${a}"`).join(',')})`,
      20000,
    );
    // Amendment dedup — otherwise portfolio value, concentration and turnover
    // all double-count an amending manager (fleet #427).
    const dedup = dedupeAmendedRows(allRows, await submissionMeta(cfg, accessions));
    superseded += dedup.superseded;
    const rows = dedup.rows;
    const byKey = new Map<string, Position>();
    for (const r of rows) {
      if (!r.cusip) continue;
      const key = `${r.cusip}|${r.put_call ?? ''}`;
      const cur = byKey.get(key) ?? { key, label: r.issuer_name ?? r.cusip, value_usd: 0, shares: 0, extra: { cusip: r.cusip } };
      cur.value_usd += Number(r.value_usd ?? 0);
      cur.shares += Number(r.shares_or_principal ?? 0);
      byKey.set(key, cur);
    }
    return [...byKey.values()].sort((a, b) => b.value_usd - a.value_usd);
  };

  const latestPositions = await fetchPositions(latestQuarter);
  const totalValue = latestPositions.reduce((s, p) => s + p.value_usd, 0);
  const top5 = latestPositions.slice(0, 5);
  const top10 = latestPositions.slice(0, 10);
  const top5Value = top5.reduce((s, p) => s + p.value_usd, 0);
  const top10Value = top10.reduce((s, p) => s + p.value_usd, 0);

  let turnover: Record<string, unknown> | null = null;
  if (priorQuarter) {
    const priorPositions = await fetchPositions(priorQuarter);
    const priorValue = priorPositions.reduce((s, p) => s + p.value_usd, 0);
    const diff = diffPositions(priorPositions, latestPositions);
    const turnoverValue =
      diff.newPositions.reduce((s, r) => s + (r.value_usd as number), 0) +
      diff.exited.reduce((s, r) => s + (r.value_usd as number), 0) +
      diff.increased.reduce((s, r) => s + Math.abs(r.delta_usd as number), 0) +
      diff.decreased.reduce((s, r) => s + Math.abs(r.delta_usd as number), 0);
    const avgValue = (totalValue + priorValue) / 2;
    turnover = {
      from_quarter: priorQuarter,
      to_quarter: latestQuarter,
      turnover_pct: avgValue > 0 ? Math.round((turnoverValue / avgValue) * 10000) / 100 : null,
      new_positions: diff.newPositions.length,
      exited_positions: diff.exited.length,
      increased_positions: diff.increased.length,
      decreased_positions: diff.decreased.length,
    };
  }

  return {
    found: true,
    manager: raw,
    filers_matched: [...new Set(managers.map((m) => m.manager_name))].slice(0, 10),
    as_of_quarter: latestQuarter,
    quarters_loaded_for_manager: quartersAvailable,
    total_portfolio_value_usd: totalValue,
    num_positions: latestPositions.length,
    concentration: {
      top5_pct_of_portfolio: totalValue > 0 ? Math.round((top5Value / totalValue) * 10000) / 100 : null,
      top10_pct_of_portfolio: totalValue > 0 ? Math.round((top10Value / totalValue) * 10000) / 100 : null,
    },
    turnover: turnover ?? { note: `Only one quarter (${latestQuarter}) loaded for this manager — turnover needs a second quarter to diff against.` },
    sector_exposure: null,
    sector_exposure_note: '13F carries no industry/sector classification field. This pack does not infer or fabricate one — sector data would need a separate, explicitly-sourced dataset.',
    top_positions: top5.map((p) => ({ issuer_name: p.label, cusip: p.extra?.cusip, value_usd: p.value_usd, pct_of_portfolio: totalValue > 0 ? Math.round((p.value_usd / totalValue) * 10000) / 100 : null })),
    amended_rows_superseded: superseded,
    amendment_note: AMENDMENT_NOTE,
    caveat: CAVEAT,
  };
}

// ── dispatch ─────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('sec-13f is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  const cfg: Cfg = { url, key };

  switch (name) {
    case 'who_owns': return whoOwns(cfg, args);
    case 'manager_portfolio': return managerPortfolio(cfg, args);
    case 'manager_changes': return managerChanges(cfg, args);
    case 'security_flows': return securityFlows(cfg, args);
    case 'manager_profile': return managerProfile(cfg, args);
    case 'holdings_coverage': return coverage(cfg);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
