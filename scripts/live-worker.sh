#!/bin/sh
# Runs the testing worker on this machine, in its container, for a deployed site.
#
#   pnpm worker:live token [site-url]   create the worker's settings and copy its token
#   pnpm worker:live up                 start the worker
#   pnpm worker:live status             is it running, and does the site accept its token
#   pnpm worker:live logs               follow what it is doing
#   pnpm worker:live down               stop it
#
# The token is generated here and is never printed. The same value has to be set
# on the site as WORKER_TOKEN; until it is, the worker waits and keeps trying.
set -eu
cd "$(dirname "$0")/.."

FILE=.env.worker.live
compose() { docker compose -p 905finance-live --env-file "$FILE" --profile worker "$@"; }
setting() { sed -n "s/^$1=//p" "$FILE"; }
need_settings() {
  if [ ! -f "$FILE" ]; then
    echo "There are no worker settings yet. Run: pnpm worker:live token"
    exit 1
  fi
}

case "${1:-}" in
  token)
    if [ ! -f "$FILE" ]; then
      site="${2:-https://905finance.vercel.app}"
      case "$site" in
        https://*) ;;
        *) echo "The site address must start with https://"; exit 1 ;;
      esac
      (
        umask 077
        printf 'WORKER_TOKEN=%s\nWORKER_APP_URL=%s\nWORKER_ID=live-worker-%s\n' \
          "$(openssl rand -hex 32)" "${site%/}" "$(hostname -s | tr -c 'A-Za-z0-9\n' '-')" > "$FILE"
      )
      echo "Created $FILE for $(setting WORKER_APP_URL). Git ignores it."
    else
      echo "Using the existing $FILE for $(setting WORKER_APP_URL)."
    fi
    if command -v pbcopy >/dev/null 2>&1; then
      printf '%s' "$(setting WORKER_TOKEN)" | pbcopy
      echo "The token is on your clipboard. Paste it as WORKER_TOKEN in the site's"
      echo "environment variables (Production, Sensitive), then redeploy the site."
    else
      echo "Copy the WORKER_TOKEN value from $FILE into the site's environment"
      echo "variables (Production, Sensitive), then redeploy the site."
    fi
    ;;
  up)
    need_settings
    compose up -d --build worker
    echo "Started. Check it with: pnpm worker:live status"
    ;;
  status)
    need_settings
    compose ps worker
    site="$(setting WORKER_APP_URL)"
    # An empty check-in claims nothing: the site only says whether it accepts the token.
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $(setting WORKER_TOKEN)" \
      -d '{}' "$site/api/worker/claim" || true)"
    case "$code" in
      503) echo "$site has no WORKER_TOKEN yet, or has not been redeployed since it was set." ;;
      401) echo "$site has a different WORKER_TOKEN from this worker's." ;;
      400|422) echo "$site accepts this worker's token." ;;
      *) echo "$site answered $code, which was not expected." ;;
    esac
    ;;
  logs)
    need_settings
    compose logs -f --tail 50 worker
    ;;
  down)
    need_settings
    compose rm -sf worker
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
