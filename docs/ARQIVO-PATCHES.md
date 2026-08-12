# Arqivo patches vs upstream browsertrix-crawler

What this fork changes, why, and what to re-check when rebasing onto a new upstream release.

**Base:** upstream `v1.14.0` · **Branch:** `arqivo-1.14.0` · **Image:** `arqivo-browsertrix-crawler:1.14.0-dip1`

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

`landbouwbrabant.js` and `postLoad-levendigbrabant.ts` are stored alternates (pagination
clickers), activated historically by copying one over `postLoad.ts` and rebuilding. That is not
how per-site logic is done now: behaviour/pre-crawl scripts live in the `crawl_scripts` table and
are injected per crawl, no image rebuild. Keep the hook (cheap, occasionally useful for things a
page-context behavior cannot do), but do not add new site logic here.

### 6. undici assertion guard

`process.on("uncaughtException")` in `main.ts` swallows `ERR_ASSERTION` errors whose stack
mentions undici, and stays fatal for everything else. undici's HTTP/1 parser can trip
`assert(!this.paused)` when a server ends a socket mid-parse; the error escapes from a socket
event and would kill an entire crawl over one broken connection, while undici simply opens a new
connection for the next request.

This is the only difference between image tags `1.14.0` and `1.14.0-dip1`.

### 7–8. Dockerfile comments, deleted workflows

The Dockerfile carries the amd64/ECR and arm64/local build recipes as comments, plus the
commented `COPY behaviors.js` slot for testing a custom behaviors bundle. Upstream's CI, release,
dev-channel and docs-publish workflows are deleted so the fork does not run them.

---

## Behaviors

**Not patched today** — the image runs stock behaviors. This section exists because that is a
choice, and because the mechanism decides how a patch would be shipped if we reverse it.

### How the bundle gets into the image

1. `package.json` declares `"browsertrix-behaviors": "^0.12.2"`; `yarn.lock` pins **0.12.2**.
   The Dockerfile's `yarn install --frozen-lockfile` drops the prebuilt bundle at
   `/app/node_modules/browsertrix-behaviors/dist/behaviors.js`. We build no behaviors ourselves.
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
| Uncomment `COPY behaviors.js …` in the Dockerfile | rebuilds, not version bumps | carrying a fix until upstream merges |
| Point the `package.json` dependency at a git ref | rebuilds and bumps | a fix upstream will not take |

The pinned 0.9.0 bundle older forks carried via the `COPY` line was byte-identical to stock and
was dropped at 1.14.

### Known upstream defect: autoscroll never runs

Since behaviors 0.10.0, `hasScrollEL()` uses `self["getEventListeners"]?.(obj).scroll`. That API
only exists in the DevTools console, so the optional call short-circuits to `undefined` instead of
throwing into the fail-open `catch` — `shouldScroll()` returns false at the first gate, and the
iframe heuristic and scroll probe below it never run. Every page logs *"Skipping autoscroll, page
seems to not be responsive to scrolling events"*, reproducible on stock
`webrecorder/browsertrix-crawler:1.14.0` with default arguments.

**We deliberately carry no patch for this.** A/B on a genuinely scroll-lazy page (stock 1.14,
stock 1.12.3 with behaviors 0.9.8, and 1.14 with a fail-open bundle mounted) produced identical
WARCs — 307 records each. The crawler's viewport and autofetch already reach what scrolling would
trigger, so patching would add fork surface for no measured gain. Revisit if a site is found where
the A/B differs; the fix is `hasScrollEL` returning `true` (minified: `hasScrollEL(t){try{return!0}`).

On each rebase, check whether the behaviors version the new release depends on still has it:

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
