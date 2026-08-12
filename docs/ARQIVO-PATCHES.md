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
| 9 | Own behaviors bundle (1 autoscroll patch) | `behaviors.js`, `patches/`, `Dockerfile` | **High** — rebuild required on every behaviors version bump |

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

The Dockerfile carries the amd64/ECR and arm64/local build recipes as comments. Upstream's CI,
release, dev-channel and docs-publish workflows are deleted so the fork does not run them.

---

## Behaviors

**Patched.** `behaviors.js` in the repo root is our own build — browsertrix-behaviors **v0.12.3**
plus `patches/0001-*.patch` — and the Dockerfile copies it over the stock bundle yarn installs.
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
   repo. `patches/0001-*.patch` is applied and built into `behaviors.js`; anything under
   `patches/not-applied/` is kept for its reasoning but deliberately not shipped.
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

### What the patch fixes

**`0001` — the scroll-listener gate never resolves.** Since behaviors 0.10.0, `hasScrollEL()` uses
`self["getEventListeners"]?.(obj).scroll`. That API only exists in the DevTools console, so the
optional call short-circuits to `undefined` instead of throwing into the fail-open `catch` —
`shouldScroll()` returns false at the first gate, and the iframe heuristic and scroll probe below
it never run. **Autoscroll never runs at all**, on any page, reproducible on stock
`webrecorder/browsertrix-crawler:1.14.0` with default arguments. Proposed upstream; drop this
patch once it lands.

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
git am ~/Development/Arqivo/browsertrix-crawler/patches/0001-*.patch   # drop it once merged upstream
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
