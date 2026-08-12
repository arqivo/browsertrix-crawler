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
| `arqivo-1.14.0` | **current**, base `v1.14.0`, builds `1.14.0-dip1` |
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
docker buildx build --platform linux/arm64 -f Dockerfile -t arqivo-browsertrix-crawler-1.14.0-dip1 .
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
`behaviorScript` lines, older ones do not. To test a modified behaviors bundle, mount it:
`-v $PWD/behaviors.js:/app/node_modules/browsertrix-behaviors/dist/behaviors.js`.

Note the tags in `docker image ls`: `webrecorder/browsertrix-crawler:*` are stock upstream and are
the control group for "is this us or upstream?" — a question worth answering before debugging our
patches.

## Traps

- **amd64 images will not run Chromium on an ARM Mac.** Use the arm64 local tag, or stock
  upstream, for local work.
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
- **Autoscroll never runs** on the behaviors version this image ships — upstream defect, no
  measured impact on our sites, details and A/B method in `docs/ARQIVO-PATCHES.md`.
