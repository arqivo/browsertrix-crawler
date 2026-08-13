# Stored post-load actions

Per-site variants of `src/actions/postLoad.ts`, kept for reference rather than
use. Both are pagination clickers from the era when per-site logic meant
copying one of these over `postLoad.ts` and rebuilding the image.

That is no longer how it is done: behaviour and pre-crawl scripts live in the
`crawl_scripts` table and are injected per crawl, with no image rebuild. See
`docs/ARQIVO-PATCHES.md`, patch 5.

They live outside `src/` because they are not imported, not compiled and not
linted — inside `src/` they only ever failed the pre-commit hook.
