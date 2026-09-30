# browsertrix-crawler — Arqivo fork

Fork of [webrecorder/browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler).
Builds the crawler image every Arqivo crawl runs in. Upstream's own docs and code layout apply;
this file covers what is different here.

**Read `docs/ARQIVO-PATCHES.md` before touching `src/` or rebasing** — it lists every deviation
from upstream, why it exists, and what to re-check after a sync.

## Where this sits

`arqivo-api` → `arqivo-task-host` → `arqivo-task-runner` → **this image** (one container per
crawl) → WARCs to S3, records to Elasticsearch.

The runner picks the image in `arqivo-task-runner/app/Services/HarvestService.php`
(`$browsertrixImage`, and `browsertrixImageOptions()` for the local arm64 tag). Changing the
image without bumping that constant changes nothing in production.

## Branches

| Branch | What |
|---|---|
| `arqivo-1.14.0` | **current**, base `v1.14.0`, builds `1.14.0-dip3` |
| `arqivo-1.7.0`, `arqivo-1.6.4`, `arqivo-1.2.1`, `arqivo` | previous bases, kept for reference |
| `main` | upstream tracking |

One branch per upstream base, patches rebased onto the new tag — not merged. `upstream` remote is
webrecorder, `origin` is arqivo.

> `arqivo-1.14.0` is **not pushed to origin**: production runs an image built from a local-only
> branch. Push it before relying on anything here being recoverable from another machine.

## Build and deploy

All builds run in Docker (never on the host). Recipes are also in the Dockerfile header.

```bash
# production (amd64, ECR)
docker buildx build --platform linux/amd64 -f Dockerfile -t arqivo-browsertrix-crawler .
docker tag arqivo-browsertrix-crawler:latest 851725346735.dkr.ecr.eu-central-1.amazonaws.com/arqivo-browsertrix-crawler:<version>
aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin 851725346735.dkr.ecr.eu-central-1.amazonaws.com
docker push 851725346735.dkr.ecr.eu-central-1.amazonaws.com/arqivo-browsertrix-crawler:<version>

# local dev (arm64) — tag must match browsertrixImageOptions()
docker buildx build --platform linux/arm64 -f Dockerfile -t arqivo-browsertrix-crawler-1.14.0-dip3 .
```

Pushing to ECR and bumping the runner is a production change: get explicit approval first.

## Shipping a change to production

A new crawler image does **not** reach a crawl by existing. Five steps, in order:

1. **Tag it `<upstream>-dipN`.** `N` increments per fork patch level, so a release row pins the
   exact patch level and upstream's own tag is never shadowed. `1.14.0-dip1` = v1.14.0 + the
   undici guard. Tags are immutable — never re-push an existing one; that breaks rollback.
2. **Point the runner at it** — `arqivo-task-runner`, three places:
   `HarvestService::$browsertrixImage` (prod), `browsertrixImageOptions()` (the arm64 tag used
   when `APP_ENV=local`), and `AgentRunnerService` (same pair, for agent runs).
3. **Build/push the runner image and add a `task_runner_releases` row.** Put the crawler image in
   that row's `image_dependencies` (comma-separated) next to `worker_image`. This is what makes
   the image *arrive*: `arqivo-task-host` does `loginToECR()` and pre-pulls every dependency for
   the release before running a task. Forget it and the crawl server has no credentialed pull.
4. **Canary before default.** `CrawlService` takes the newest `task_runner_releases` row with
   `enabled = 1` as default, unless the site has `sites.forceReleaseId` set. So: insert the row
   with `enabled = 0`, set `forceReleaseId` on one or two sites, let them crawl, then enable the
   row. `forceReleaseId` has no API or UI — it is SQL-only, like `crawl_rules`.
5. **Roll back by disabling the row** (`enabled = 0`); the previous newest enabled row becomes
   default again on the next scheduling pass. No image work, no revert commit.

The crawl record stores `releaseId` and `crawlerImage`, so "which image ran this crawl" is
answerable after the fact — but check the task log's `Starting crawler with config` line when
they disagree: the log is what actually ran.

## Testing a change

Run a real crawl rather than reasoning about it — a one-page crawl takes seconds:

```bash
docker run --rm -v $PWD/out:/crawls <image> \
  crawl --url https://example.com/ --limit 1 --logging stats,behaviors,behaviors-debug,jserrors
```

Behavior yields only appear with `--logging behaviors`; production task logs from 1.14 include
`behaviorScript` lines, older ones do not.

## Behaviors

Two different things both called "behaviors" — keep them apart:

| | Path in container | Comes from | Selected by |
|---|---|---|---|
| **Built-in** (autoscroll, autofetch, autoplay, site-specific) | `/app/node_modules/browsertrix-behaviors/dist/behaviors.js` | **our `behaviors.js`**, copied over the npm one at build | `--behaviors` |
| **Per-site** | `/app/behaviors/<name>.js` | `crawl_scripts` rows, written per crawl by the runner | `--customBehaviors` |

The built-in bundle is read from disk by `crawler.ts` at process start — not compiled in — so
mounting over that path swaps it with **no rebuild**, which is how to A/B a behaviors change:

```bash
docker run --rm -v <vol>:/crawls -v $PWD/behaviors.js:/app/node_modules/browsertrix-behaviors/dist/behaviors.js:ro \
  <image> crawl --url <url> --limit 1 --behaviors autoscroll --logging stats,behaviors
```

`--customBehaviors` is additive — it cannot fix a built-in, but a custom behavior whose
`isMatch()` matches wins over autoscroll for that page via `selectMainBehavior()`. It is a yargs
array option that does **not** split commas: a comma-joined value is `stat()`ed as one path and
the crawl exits `fatal(17)` with more than one behavior.

Editing the bundle means editing `~/Development/Arqivo/browsertrix-behaviors` (branch
`arqivo-0.12.3`), rebuilding, and copying `dist/behaviors.js` here — full recipe and the reason
each patch exists in `docs/ARQIVO-PATCHES.md`. Never hand-edit `behaviors.js`: it is generated.

Note the tags in `docker image ls`: `webrecorder/browsertrix-crawler:*` are stock upstream and are
the control group for "is this us or upstream?" — a question worth answering before debugging our
patches.

## Traps

- **amd64 images on an ARM Mac run under emulation** — slow, and historically Chromium would not
  start at all. A one-page crawl with `:1.14.0-dip2` did work (2026-08-12), but use the arm64 local
  tag for anything longer.
- **Dedupe index must live in db 1** of the per-crawl redis, not db 0: the crawler gates its
  commit on `dedupeRedisUrl !== redisUrl` as a *string compare*. Same URL ⇒ index built, never
  committed, and nothing says so.
- **`--id` must be unique per crawl** (`{collectionName}-{crawlId}`), never chain-wide —
  resolution walks `alldupes[hash] → crawlId` then `h:{crawlId}[hash]`.
- **`--diskUtilization` clamps to 90 outside 0..99.** Our old `99,999` was silently 90 for years,
  and hosts above 90% disk aborted crawls that were then published as complete.
- **Counting after 1.14:** cross-crawl dedupe turns repeated identical responses into revisits, so
  response counts, `statusCounts` and per-day ES record counts all drop while coverage is
  unchanged. Compare **distinct URLs** across the 2026-08-07 boundary, never response counts.
- **Autoscroll never runs on stock behaviors 0.10+** (upstream defect). Our bundle fixes it from
  `-dip2`; a stock image is the wrong control when testing scroll-dependent capture. Details and
  A/B method in `docs/ARQIVO-PATCHES.md`.
- **Rate limiting is answered from `-dip3` on** — a refusal pauses every worker, and repeats raise
  the per-page floor then drop workers. If a crawl looks mysteriously slow, check the log for
  `Rate limited, backing off` / `Rate limit hold, pausing worker`: it carries `seconds`, `until`,
  `level` and `allowedWorkers`, and slow is the correct answer to a host refusing us.
- **The pre-commit hook must stay green.** It was failing on 35 pre-existing errors, so everything
  was committed with `--no-verify` and it caught nothing; that is fixed, keep it that way.

## Delivery (infra-ops)

- **One image per commit**: `.github/workflows/image.yml` builds every pushed commit on every branch, pushes `ghcr.io/arqivo/browsertrix-crawler:<sha>` (+ `<sha7>`, `<branch>`) and reports it to the InfraOps plane as a build of application `browsertrix-crawler` (`POST /v2/applications/browsertrix-crawler/builds`; variable `INFRAOPS_URL`, secret `INFRAOPS_DEPLOY_TOKEN`; unset = skipped with a warning). Production images are still built and pushed to ECR by hand (above); a GHCR build does not reach a crawl until a `task_runner_releases` row names it.
- **`version.json`** `{"commit", "build", "manifest"}` is baked into the image (at `/version.json` in the image filesystem); `build` is the workflow's run number, the same number reported to the plane.
- **Image mode** (`compose.image.yml`, used by validation benches): pulls `BROWSERTRIX_CRAWLER_IMAGE`; arqivo-task-host hands it to the runners as `BROWSERTRIX_IMAGE`.
