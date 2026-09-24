# Arqivo patches vs upstream browsertrix-crawler

What this fork changes, why, and what to re-check when rebasing onto a new upstream release.

**Base:** upstream `v1.14.0` · **Branch:** `arqivo-1.14.0` · **Image:** `arqivo-browsertrix-crawler:1.14.0-dip3`

Regenerate this view at any time:

```bash
git diff --stat v1.14.0..arqivo-1.14.0
git log --oneline v1.14.0..arqivo-1.14.0
```

## The patches

| # | Patch | Files | Rebase risk |
|---|---|---|---|
| 1 | Per-URL live progress log in redis | `src/util/state.ts`, `src/util/worker.ts`, `src/crawler.ts` | **High** — hunks sit in upstream's hot paths |
| 2 | Drop `{crawlId}:*` redis keys when a crawl finishes | `src/util/logger.ts`, `src/util/state.ts` | Medium |
| 3 | `--writePageInfo` flag | `src/util/argParser.ts`, `src/util/worker.ts` | Low |
| 4 | `--enableJavascript` flag | `src/util/argParser.ts`, `src/crawler.ts` | Low |
| 5 | Per-site post-load actions hook | `src/actions/*`, `src/crawler.ts` | Low (hook is a no-op today) |
| 6 | undici assertion guard | `src/main.ts` | Low |
| 7 | Build/push documentation | `Dockerfile` | None (comments only) |
| 8 | Upstream CI/release workflows deleted | `.github/workflows/*` | None |
| 9 | Own behaviors bundle (2 autoscroll patches) | `behaviors.js`, `patches/`, `Dockerfile` | **High** — rebuild required on every behaviors version bump |
| 10 | Rate-limit response: pause, then prevent | `src/crawler.ts`, `src/util/{state,worker,argParser,constants}.ts` | **High** — touches the worker loop and the page-timeout budget |
| 11 | Fork made lint-clean | `src/actions/*`, `src/main.ts`, `src/util/state.ts`, `examples/` | Low |
| 12 | Spill-file purge that cannot kill the crawl | `src/util/recorder.ts` | Low — two call sites plus one private method; drop if upstream awaits `purge()` and warcio ends the stream first |

---

### 1. Per-URL live progress log in redis

`RedisCrawlState.logUrlStart()` / `logUrlFinish()` write `{crawlId}:urllog` (hash, url →
`{started, finished, status, retry}`) and `{crawlId}:urllog:order` (list, first attempts only).

**Why:** the crawler's own `pages.jsonl` only lands when the crawl ends, so without this the
runner can say nothing about a crawl in flight — exactly when someone asks. Consumed by the
runner's `CrawlPageTracker`, surfaced as live page counts in dip-ops.

**Call sites, and why they are the risky part:**
- `src/util/worker.ts` — `logUrlStart` just before the page-load race in `timedCrawlPage`
- `src/crawler.ts` — `logUrlFinish` in the success path (after `markFinished`) *and* in the
  give-up path (after `writePage`, when `retry < 0`)

Upstream edits `crawler.ts`'s finish/failure paths regularly. After a rebase, confirm **both**
`logUrlFinish` calls survived and that the failure-path one is still inside the `retry < 0`
branch — if it moves out, retried URLs get logged as finished on every attempt.

### 2. Redis cleanup on crawl done

`Logger.setStatus("done")` calls `crawlState.cleanupRedis()`, which registers a Lua
`deleteWithPrefix` command and deletes `{crawlId}:*`.

**Why:** the redis instance is per-task and its RDB dump is carried forward to the next crawl in
the chain, so un-cleaned keys accumulate for the life of a site.

**Do not widen the prefix.** Dedupe state lives outside `{crawlId}:*` and is precisely what the
chain carries forward; deleting it silently disables cross-crawl dedupe (the crawl still runs, it
just stops deduping — no error anywhere). Note the code comment names `allhashes`, while the key
that actually matters in 1.14 is `alldupes`; treat the comment as stale, not the behaviour.

### 3. `--writePageInfo` (default `true`)

Gates `recorder.writePageInfoRecord()` in `worker.ts`. Pageinfo records are the live half of
harvest verification, so this stays on in normal operation; the flag exists for runs where the
records are unwanted noise.

### 4. `--enableJavascript` (default `true`)

Gates the `behaviorOpts` block in `crawler.ts` — when false, behaviors are skipped.

**Caveat worth knowing:** despite the name, nothing calls `page.setJavaScriptEnabled(false)`.
The flag only suppresses behaviors; JavaScript still executes. Either rename it or implement the
disable if a site ever genuinely needs JS off.

### 5. Per-site post-load actions

`Actions.runPostLoad(url, page, logger, logDetails, crawler, data)` runs at the end of
`pageFinished`. `src/actions/index.ts` imports **only** `./postLoad.js`, whose `run()` is an
empty stub — so in the shipped image this hook does nothing.

The stored alternates (`landbouwbrabant.js`, `postLoad-levendigbrabant.ts`) now live in
`examples/actions/`, outside the compiled and linted tree — they are not imported, and inside
`src/` they did nothing but fail the pre-commit hook. They were activated historically by copying
one over `postLoad.ts` and rebuilding. That is not how per-site logic is done now: behaviour and
pre-crawl scripts live in the `crawl_scripts` table and are injected per crawl, no image rebuild.
Keep the hook (cheap, occasionally useful for what a page-context behavior cannot do), but do not
add new site logic here.

### 6. undici assertion guard

`process.on("uncaughtException")` in `main.ts` swallows `ERR_ASSERTION` errors whose stack
mentions undici, and stays fatal for everything else. undici's HTTP/1 parser can trip
`assert(!this.paused)` when a server ends a socket mid-parse; the error escapes from a socket
event and would kill an entire crawl over one broken connection, while undici simply opens a new
connection for the next request.

This is the only difference between image tags `1.14.0` and `1.14.0-dip1`. `-dip2` adds the
behaviors bundle below; `-dip3` adds patch 10.

### 10. Rate-limit response: pause, then prevent

Upstream counts rate-limited pages and, past `--rateLimitInterruptCount`, kills the crawl. In
between it does nothing: the refused page is requeued, the worker takes the next one ~200ms later,
and `rateLimitMaxRetries` (4) re-requests each refused page. `Retry-After` is parsed and used only
as a counter TTL — never waited on. So the crawl's answer to "you are going too fast" was to go
faster. www.amsterdam.nl was refused three pages a second; allemaaloisterwijk.nl collected **5.002**
rate-limited responses in one crawl and earned an IP ban that also took out onsmoergestel.nl behind
the same address.

Neither `--pageExtraDelay` nor `--postLoadDelay` can help: both live on the success path, and the
rate-limit branch `throw`s before either runs.

Two mechanisms, deliberately separate — conflating them was the first draft's mistake:

**Pause** — waits out the limit in force. Length is the host's to state (`Retry-After`, else
`--rateLimitPause`, 20s). Held as a TTL key in the per-crawl redis so *every* worker waits,
including ones idle when the refusal arrived. Longest window wins; capped at
`MAX_RATE_BACKOFF_SECS` (300) because `Retry-After` is occasionally hours. It does **not** grow
with repetition: waiting longer does not clear a limit sooner.

**Prevention** — every repeat says the pace we resumed at is still too fast. A shared level
(`{crawlId}:rateBackoffLevel`, TTL `RATE_BACKOFF_LEVEL_TTL_SECS` = 600) raises `--minPageDuration`
by `--rateLimitPaceStep` per rung up to `--rateLimitPaceMax`, and past
`--rateLimitWorkerThreshold` rungs drops one worker per further rung, never below
`--rateLimitMinWorkers`. The level expiring is how a crawl that settles returns to full speed.

Pacing is a **floor, not a tax**: `--minPageDuration` tops a page up to a minimum and adds nothing
to a page that already took longer — a 300ms page fetched back to back trips limiters, a 10s page
does not. The learned penalty lives in `crawler.rateLimitExtraDelay`, never in
`params.pageExtraDelay`, so configuration keeps meaning configuration and the penalty stays
reportable on its own.

| Flag | Default | |
|---|---|---|
| `--rateLimitPause` | 20 | wait-out length when no `Retry-After`; 0 disables pausing |
| `--rateLimitPauseAmbiguous` | false | count 403/503 without `Retry-After` as rate limiting |
| `--rateLimitPaceStep` | 1 | seconds added to the floor per rung; 0 disables |
| `--rateLimitPaceMax` | 10 | ceiling for the added floor |
| `--rateLimitWorkerThreshold` | 2 | rungs tolerated before dropping a worker |
| `--rateLimitMinWorkers` | 1 | concurrency floor |
| `--minPageDuration` | **1** | changed from upstream's implicit 0 |

**Four things that will break if moved, all learned the hard way:**

1. The hold sits in `worker.ts`'s loop **before `nextFromQueue()`**. Inside `crawlPage` it runs
   within the `timedRun(maxPageTime)` budget, so a long pause times the page out — a rate limit
   converted into failed pages — and the claimed page goes stale in redis meanwhile.
2. The hold has **three** release conditions: crawl stopping, no work left
   (`queueSize() === 0 && numPending() === 0`), hold expired. Drop the middle one and a parked
   worker sits out its window while the others drain the queue; the concurrency cap has no TTL of
   its own, so without it a capped worker waits forever and the crawl never finishes.
3. `maxPageTime` grows with the floor, and `worker.ts` reads `crawler.maxPageTime` **live** rather
   than the value snapshotted at worker construction. Otherwise slowing down starts timing pages
   out.
4. Only the page's own response counts. `recorder.ts` reaches `markRateLimited()` solely from
   `blockPageResponse()`, guarded by `url === this.pageUrl` — a third-party subresource returning
   403 can never pause a crawl. Upstream's guard; keep it that way.

**Evidence.** Token-bucket fixture (40 linked pages, 3 requests per 10s, half the 429s carrying
`Retry-After: 8`), 4 workers, dip3:

| Level | Pause | Source | Floor | Workers |
|---|---|---|---|---|
| 1–2 | 8s | `Retry-After` | +1s, +2s | 4 |
| 3 | 20s | configured | +3s | 3 |
| 4 | 8s | `Retry-After` | +4s | 2 |
| 5+ | 8/20s | mixed | +5s … +10s (cap) | 1 (floor) |

Refusals per minute at the host fell **18 → 6 → 3 → 0** and stayed at 0 for the last four minutes;
all 40 pages captured, `failed: 0`, exit 0 with workers parked. Not yet tested against a real host.

### 11. Fork made lint-clean

The pre-commit hook (`yarn format:fix && eslint src/ tests/*.ts --fix`) had been failing on 35
errors that all predated this work, so every commit needed `--no-verify` and the hook could catch
nothing. Fixed: a stray `await` on the synchronous `redis.defineCommand`, an unvoided
`logger.fatal` in the undici guard, and the `any`-typed actions hook. The two unreferenced
per-site action variants moved to `examples/actions/` — not imported, not compiled, and inside
`src/` they only ever failed the hook.

Keep it clean: a hook that always fails is the same as no hook.

### 12. Spill-file purge that cannot kill the crawl

A response larger than `MAX_BROWSER_DEFAULT_FETCH_SIZE` (5,000,000 bytes) is spilled by warcio's
`TempFileBuffer` to a temp file. Upstream purges that buffer with a **fire-and-forget**
`serializer.externalBuffer?.purge()` in two places, and warcio 2.4.11's `purge()` unlinks the file
**without ending the write stream that creates it**, clearing `filename` only after the unlink
resolves. So the unlink can run before the stream has created the file, or twice. It rejects with
`ENOENT`, nothing holds the promise, and the process-level handler turns the unhandled rejection
into `Uncaught exception. Quitting` — fatal, exit 17, the whole crawl lost.

The **dedupe** path triggers it every night on sites with large static files: an unchanged file
over the threshold is spilled, found to be a duplicate, and purged at once.
gemeentemaastricht.nl (static 5.8–7.9 MB election PDFs) crashed on every first attempt from 20
to 24 Sep 2026, and Deventer's IP block in August came from the retries this crash causes.

Reproduced deterministically against the warcio shipped in `1.14.0-dip4` (spill, then purge the
way the recorder does):

```
upstream:  unhandled rejections = 1 | temp file left behind = true
patch 12:  unhandled rejections = 0 | temp file left behind = false
```

The second column is a separate upstream bug the fix also closes: when the unlink loses the race,
the stream creates the file *afterwards* and nothing ever deletes it, so even crawls that survive
leak every large duplicate into the container's `/tmp`.

`Recorder.purgeSpillBuffer()` ends the stream first — **bounded** at 10 s via `timedRun`, because
`'finish'` never fires on a stream that has already ended or errored and an unbounded wait would
hang the recorder — then awaits `purge()` and tolerates the `ENOENT` it can still raise. Anything
else is logged as a warning, never thrown.

**Rebase check:** if upstream starts awaiting `purge()` and warcio ends the stream inside
`purge()`, drop this patch.

### 7–8. Dockerfile comments, deleted workflows

The Dockerfile carries the amd64/ECR and arm64/local build recipes as comments. Upstream's CI,
release, dev-channel and docs-publish workflows are deleted so the fork does not run them.

---

## Behaviors

**Patched.** `behaviors.js` in the repo root is our own build — browsertrix-behaviors **v0.12.3**
plus `patches/000*.patch` (two) — and the Dockerfile copies it over the stock bundle yarn installs.
Source of truth for the patches is the `arqivo-0.12.3` branch of
`~/Development/Arqivo/browsertrix-behaviors` (`upstream` remote = webrecorder).

### How the bundle gets into the image

1. `package.json` declares `"browsertrix-behaviors": "^0.12.2"`; `yarn.lock` pins **0.12.2**.
   The Dockerfile's `yarn install --frozen-lockfile` drops the prebuilt bundle at
   `/app/node_modules/browsertrix-behaviors/dist/behaviors.js` — and our `COPY behaviors.js`
   then overwrites it, which is why the installed version is not the version that runs.
2. `src/crawler.ts` reads that file at module load —
   `const btrixBehaviors = fs.readFileSync("../node_modules/browsertrix-behaviors/dist/behaviors.js")`.
   It is read from disk at process start; `tsc` does **not** bundle it into `dist/crawler.js`.
3. Per page: `browser.addInitScript(page, btrixBehaviors)`, then an init script runs
   `self.__bx_behaviors.init(behaviorOpts, false)` + `selectMainBehavior()`, and later
   `self.__bx_behaviors.run()`.

Because of step 2, **replacing that one file changes behavior with no rebuild**:

```bash
docker run -v $PWD/behaviors.js:/app/node_modules/browsertrix-behaviors/dist/behaviors.js <image> crawl ...
```

That is how upstream's own behaviors CI tests a build, and the cheapest way to A/B a suspected
behaviors problem against stock. Note `--customBehaviors` is a *different* channel: it `load()`s
extra behaviors alongside the built-ins and does not replace autoscroll — though a custom
behavior whose `isMatch()` matches wins over autoscroll for that page via `selectMainBehavior()`,
which is what our `crawl_scripts` use.

Three ways to ship a patch, in increasing durability:

| Way | Survives | Use for |
|---|---|---|
| Mount over the path at `docker run` | nothing | testing, one-off diagnosis |
| `COPY behaviors.js …` in the Dockerfile (**what we do**) | rebuilds, not version bumps | carrying a fix until upstream merges |
| Point the `package.json` dependency at a git ref | rebuilds and bumps | a fix upstream will not take |

The `:1.6.4` image used the same `COPY` slot to ship a stock **0.9.0** bundle (byte-identical to
npm, despite its `package.json` saying 0.8.5) — which is why autoscroll worked before 1.14. The
slot was emptied at 1.14 and is now in use again.

### Carrying one through our chain

A behaviors patch is not a source change to this repo — the bundle is a dependency — so it needs
a home and a rebuild trigger of its own:

1. **The patch file lives in `patches/`**, as a `git format-patch` against the upstream behaviors
   repo. `patches/000*.patch` are applied and built into `behaviors.js`; anything under
   `patches/not-applied/` is kept for its reasoning but deliberately not shipped (named A, B … so
   the applied series keeps unambiguous numbering).
2. **Build the bundle in a container**, apply the patch, keep the result out of git (it is
   generated):
   ```bash
   git clone --branch v0.12.2 https://github.com/webrecorder/browsertrix-behaviors.git /tmp/btb
   cd /tmp/btb && git apply /path/to/patches/<file>.patch
   docker run --rm -v /tmp/btb:/w -w /w node:22 sh -c "yarn install --frozen-lockfile && yarn build"
   cp /tmp/btb/dist/behaviors.js ./behaviors.js   # next to the Dockerfile, for the COPY line
   ```
3. **A/B it before believing it** — mount both bundles against the same URL and diff the WARC
   record counts, not the logs. A behaviors change that logs differently but captures identically
   is not worth a fork patch (that is exactly what the autoscroll A/B showed).
4. **Refresh `behaviors.js`**, build, and ship as `-dipN+1` through the five steps
   in `CLAUDE.md` → *Shipping a change to production*. A behaviors-only change still needs a new
   crawler tag, a runner bump and a release row: there is no path by which a bundle reaches a
   crawl server on its own.
5. **On the next upstream sync**, re-check whether the patch is still needed (the one-liner below)
   before rebuilding. If upstream merged it, delete the file from `patches/` and drop the `COPY`
   line — a silently redundant patch is how forks rot.

### What the patches fix

**`0001` — the scroll-listener gate never resolves.** Since behaviors 0.10.0, `hasScrollEL()` uses
`self["getEventListeners"]?.(obj).scroll`. That API only exists in the DevTools console, so the
optional call short-circuits to `undefined` instead of throwing into the fail-open `catch` —
`shouldScroll()` returns false at the first gate, and the iframe heuristic and scroll probe below
it never run. **Autoscroll never runs at all**, on any page, reproducible on stock
`webrecorder/browsertrix-crawler:1.14.0` with default arguments. Proposed upstream; drop this
patch once it lands.

**`0002` — the scroll message is logged ~13 times a second.** `Scrolling down by N pixels` is
yielded from inside the scroll loop, which turns every 75ms, and the `segments === 1` branch it
sits in holds for the entire scroll of any page that does not grow. One production crawl of a
1.500-page site logged **5.600** identical lines — most of that log. The branch has always carried
the comment *"only print this the first time"*; this adds the flag that makes it true, for both
`scrollDown` and `scrollUp`. Scrolling itself is unchanged: same pages, same captures, 86 lines to
1 on a scrolling fixture.

### Measured effect

Fixtures: fixed-height pages whose 10 images load via `IntersectionObserver`, one of them also
setting `html { scroll-behavior: smooth }`. One page each, crawler 1.14.0, `--behaviors autoscroll`:

| bundle | lazy-load fixture | + smooth-scroll fixture | wall-clock |
|---|---|---|---|
| stock 0.12.2 (prod today) | **2 of 10** | **2 of 10** | 4.4s |
| 0.9.0 (what the 1.6.4 image shipped) | 10 of 10 | — | 4.3s |
| **ours: 0.12.3 + `0001`** | 10 of 10 | 10 of 10 | 3.9s |

The 1.14 upgrade did cost real capture on pages of this shape, and `0001` alone restores it.

Note *how*, because it bounds the claim: with `0001` the behavior still logs `Skipping autoscroll`
on these fixtures — `shouldScroll()`'s probe jumps to 98% of the page and back before deciding, and
that jump alone fires the observers and loads everything. The gate previously returned false
*before* the probe ran, so no scroll happened at all and only the first viewport was captured. The
win is the probe executing, not `scrollDown()`.

Consequence: a page needing *gradual* scrolling — content that only loads when an element dwells in
the viewport, or that appends in steps — can still be under-captured with `0001` alone, because the
probe will conclude "no reaction" and skip. That is the case `not-applied/0002` was written for, and
the case to look for before dismissing it.

This is *not* what happened to site 234: those iframes load without scrolling, and stock 1.12.3,
stock 1.14 and a patched 1.14 produced identical WARCs there (307 records). Do not conflate them.

### `patches/not-applied/` — kept, not shipped

Two patches from the June 2024 work on behaviors 0.6.1, rebased onto 0.12.3 and then set aside
because measurement did not support them. Source branch `arqivo-autoscroll-aggressive`.

- **`0002`** — probe with `behavior: "auto"` instead of `"smooth"` and accept "scrollY changed" as
  a reaction, so pages that lazy-load in place are never classified as ignoring scroll. Sound
  reasoning, no measured gain over `0001`: both fixtures already reach 10 of 10 without it. Its
  cost is blast radius — it makes autoscroll run on essentially every scrollable page.
- **`0003`** — scroll step 30px → 200px per 75ms tick. Only exists to pay for `0002`'s extra
  scrolling; with `0002` applied the same page took 6.0s vs 3.9s. Upstream issue #18 says
  autoscroll is *too fast* for some sites already.

Revisit `0002` if a site turns up where content below the fold is missing and `0001` alone does not
fix it — that is the evidence it currently lacks. Apply both together, never `0002` alone.

### Rebuilding after an upstream sync

```bash
cd ~/Development/Arqivo/browsertrix-behaviors
git fetch upstream --tags
git checkout -b arqivo-<newver> v<newver>
git am ~/Development/Arqivo/browsertrix-crawler/patches/000*.patch   # drop 0001 once merged upstream
docker run --rm -v "$PWD:/w" -w /w node:22 sh -c "yarn install --frozen-lockfile && yarn lint:check && yarn run build"
cp dist/behaviors.js ~/Development/Arqivo/browsertrix-crawler/behaviors.js
git format-patch v<newver>..HEAD -o ~/Development/Arqivo/browsertrix-crawler/patches/
```

Then re-run the A/B before trusting it — mount the old and new bundle over the same image and
compare captured records, not log lines:

```bash
docker run --rm -v <vol>:/crawls -v $PWD/behaviors.js:/app/node_modules/browsertrix-behaviors/dist/behaviors.js:ro \
  webrecorder/browsertrix-crawler:<ver> crawl --url <url> --limit 1 --behaviors autoscroll --logging stats,behaviors
```

Check whether `0001` is still needed:

```bash
docker run --rm <image> sh -c 'grep -c "getEventListeners?" /app/node_modules/browsertrix-behaviors/dist/behaviors.js'
```

## Rebasing onto a new upstream release

1. `git fetch upstream --tags`, branch `arqivo-<version>` off the new tag, cherry-pick or rebase
   the commits from `git log v1.14.0..arqivo-1.14.0`.
2. Walk this document top to bottom and confirm each patch still applies **and still sits in the
   right place** — patch 1 in particular is placement-sensitive, not just content-sensitive.
3. Re-read the behaviors section: check whether the autoscroll defect is fixed upstream in the
   version the new release depends on.
4. Build and smoke-test before pushing to ECR:

```bash
docker buildx build --platform linux/arm64 -f Dockerfile -t arqivo-browsertrix-crawler-<version> .
docker run --rm -v $PWD/out:/crawls arqivo-browsertrix-crawler-<version> \
  crawl --url https://example.com/ --limit 2 --writePageInfo true --logging stats,behaviors
```

Verify: pageinfo records present in the WARC · `{crawlId}:urllog` written during the run and gone
after · dedupe keys still present after the run · exit code 0.

5. Bump `$browsertrixImage` in the runner's `HarvestService.php` (and the arm64 tag in
   `browsertrixImageOptions()` / `AgentRunnerService.php`) in the same change.
