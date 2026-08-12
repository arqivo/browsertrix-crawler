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
| 9 | Own behaviors bundle (3 autoscroll patches) | `behaviors.js`, `patches/`, `Dockerfile` | **High** — rebuild required on every behaviors version bump |

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

**Patched.** `behaviors.js` in the repo root is our own build — browsertrix-behaviors **v0.12.3**
plus `patches/000*.patch` — and the Dockerfile copies it over the stock bundle yarn installs.
Source of truth for the patches is the `arqivo-0.12.3` branch of
`~/Development/Arqivo/browsertrix-behaviors` (`upstream` remote = webrecorder).

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

### Carrying one through our chain

A behaviors patch is not a source change to this repo — the bundle is a dependency — so it needs
a home and a rebuild trigger of its own:

1. **The patch file lives in `patches/`**, as a `git format-patch` against the upstream behaviors
   repo. `patches/behaviors-0.12.2-autoscroll-scroll-listener.patch` is the current example
   (proposed upstream, not applied here). The filename carries the behaviors version it applies
   to, because that is the thing that invalidates it.
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
4. **Uncomment the `COPY behaviors.js` line**, build, and ship as `-dipN+1` through the five steps
   in `CLAUDE.md` → *Shipping a change to production*. A behaviors-only change still needs a new
   crawler tag, a runner bump and a release row: there is no path by which a bundle reaches a
   crawl server on its own.
5. **On the next upstream sync**, re-check whether the patch is still needed (the one-liner at
   the end of this section) before rebuilding the bundle. If upstream merged it, delete the file
   from `patches/` and re-comment the `COPY` line — a silently redundant patch is how forks rot.

### What the three patches fix

**`0001` — the scroll-listener gate never resolves.** Since behaviors 0.10.0, `hasScrollEL()` uses
`self["getEventListeners"]?.(obj).scroll`. That API only exists in the DevTools console, so the
optional call short-circuits to `undefined` instead of throwing into the fail-open `catch` —
`shouldScroll()` returns false at the first gate, and the iframe heuristic and scroll probe below
it never run. **Autoscroll never runs at all**, on any page, reproducible on stock
`webrecorder/browsertrix-crawler:1.14.0` with default arguments. Proposed upstream; drop this
patch once it lands.

**`0002` — the probe misses pages that lazy-load in place.** Upstream jumps to 98% of the page
with `behavior: "smooth"` and concludes the page reacts only if `scrollHeight` grew or the
autofetcher started fetching. Two problems: a smooth programmatic scroll is animated and gets
cancelled on sites setting `html { scroll-behavior: smooth }` (the page never moves), and "grew"
only describes infinite scroll — a page that reserves its height and fills boxes via
`IntersectionObserver` never grows. Patch: jump with `"auto"`, and accept "scrollY changed" as a
reaction too. Upstream used `"auto"` here until 0.9.x.

**`0003` — scroll increment 30px → 200px per 75ms tick.** The counterweight to `0002`: upstream's
400px/s assumes autoscroll only runs on infinite-scroll pages, and once it runs everywhere that
cost lands on every page of every crawl. Only `scrollDown()` changes; `scrollUp()` keeps upstream's
increment. Upstream issue #18 complains autoscroll is *too fast* already, so if content ever looks
half-captured on a slow-loading site, this constant is the first thing to try reverting.

### Measured effect

Fixture: a fixed-height page whose 10 images load via `IntersectionObserver` — the case `0002`
targets. One page, crawler 1.14.0, `--behaviors autoscroll`:

| bundle | lazy images captured | page wall-clock |
|---|---|---|
| stock 0.12.2 (what prod runs today) | **2 of 10** | 5.6s |
| 0.9.0 (what the 1.6.4 image shipped) | 10 of 10 | 4.3s |
| ours (0.12.3 + patches) | 10 of 10 | 7.2s |

So the 1.14 upgrade did cost real capture on pages of this shape, and this bundle restores it. It
is *not* what happened to site 234 — that site's iframes load without scrolling, and stock 1.12.3
vs stock 1.14 vs a patched 1.14 all produced identical WARCs there (307 records). Do not conflate
the two.

### Rebuilding after an upstream sync

```bash
cd ~/Development/Arqivo/browsertrix-behaviors
git fetch upstream --tags
git checkout -b arqivo-<newver> v<newver>
git am ~/Development/Arqivo/browsertrix-crawler/patches/000*.patch   # drop 0001 if merged upstream
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
