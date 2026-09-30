#!/usr/bin/env bash
# Report a pushed image to the InfraOps plane as a build of its application
# (POST /v2/applications/{application}/builds, infra-ops plan-changes C0).
#
# Env: INFRAOPS_URL (repository variable), INFRAOPS_DEPLOY_TOKEN (secret: the
# application's deploy token), APPLICATION, IMAGE (repository, no tag),
# DIGEST (sha256:…), BUILD_NUMBER, COMMIT_SHA, BRANCH, RUN_URL, REPOSITORY,
# WORKFLOW. Either of the first two empty → a warning, nothing sent.
# A build number the plane already has (a re-run built a new digest) → sent
# again without one, and the plane numbers it.
set -euo pipefail

if [ -z "${INFRAOPS_URL:-}" ] || [ -z "${INFRAOPS_DEPLOY_TOKEN:-}" ]; then
  echo "::warning::INFRAOPS_URL (variable) or INFRAOPS_DEPLOY_TOKEN (secret) is not set: build not reported to the plane"
  exit 0
fi

case "$DIGEST" in sha256:*) ;; *) echo "::error::no image digest to report (got '$DIGEST')"; exit 1 ;; esac

url="${INFRAOPS_URL%/}/v2/applications/${APPLICATION}/builds"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

payload() {
  jq -n \
    --arg image "${IMAGE}@${DIGEST}" \
    --arg digest "$DIGEST" \
    --arg number "${1:-}" \
    --arg sha "$COMMIT_SHA" \
    --arg branch "$BRANCH" \
    --arg built "$built_at" \
    --arg repo "$REPOSITORY" \
    --arg run "$RUN_URL" \
    --arg workflow "$WORKFLOW" \
    '{image: $image, digest: $digest, commit_sha: $sha, branch: $branch, built_at: $built,
      metadata: {repository: $repo, run_url: $run, workflow: $workflow}}
     + (if $number == "" then {} else {build_number: ($number | tonumber)} end)'
}

post() {
  curl -sS --retry 3 --retry-all-errors --max-time 30 \
    -o /tmp/infraops-build.json -w '%{http_code}' \
    -X POST "$url" \
    -H "Authorization: Bearer ${INFRAOPS_DEPLOY_TOKEN}" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    --data "$1"
}

code="$(post "$(payload "$BUILD_NUMBER")")"
if [ "$code" = "422" ] && grep -q 'never reused' /tmp/infraops-build.json; then
  echo "::warning::build #${BUILD_NUMBER} is taken by another artifact on the plane; reporting without a number"
  code="$(post "$(payload "")")"
fi

cat /tmp/infraops-build.json; echo
case "$code" in
  200|201) echo "reported ${IMAGE}@${DIGEST} to ${APPLICATION} (HTTP $code)" ;;
  *) echo "::error::the plane answered HTTP $code to the build report"; exit 1 ;;
esac
