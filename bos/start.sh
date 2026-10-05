#!/bin/sh
# Mirrors the `cron` service in docker-compose.yml, calling the local server.
tick() { # path interval
  sleep 120
  while true; do
    wget -q -O /dev/null --header "Authorization: Bearer ${CRON_SECRET}" "http://127.0.0.1:3000$1" \
      || echo "[cron] $1 failed"
    sleep "$2"
  done
}
if [ -n "${CRON_SECRET}" ]; then
  tick /api/cron/scheduled-actions 900 &
  tick /api/cron/automation-jobs 900 &
  tick /api/follow-up-reminders 3600 &
  tick /api/resend/digest/all 1800 &
  tick /api/meeting-briefs 900 &
  tick /api/watch/all 21600 &
fi
# Serve the platform's private Redis (REDIS_URL) over HTTP for the Upstash client
# the app uses. Only when the app was not pointed at an HTTP Redis of its own.
if [ -n "${REDIS_URL}" ] && [ -z "${REDIS_HTTP_URL}" ]; then
  REDIS_HTTP_PORT="${REDIS_HTTP_PORT:-8079}"
  REDIS_HTTP_URL="http://127.0.0.1:${REDIS_HTTP_PORT}"
  # A token nobody has to manage: it only guards loopback inside this container.
  if [ -z "${REDIS_HTTP_TOKEN}" ]; then REDIS_HTTP_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  export REDIS_HTTP_URL REDIS_HTTP_TOKEN REDIS_HTTP_PORT
  (
    while true; do
      node /app/bos-redis-http.mjs
      code=$?
      if [ "$code" -eq 78 ]; then echo "[redis-http] off until its settings are corrected"; break; fi
      echo "[redis-http] stopped (exit $code); restarting"
      sleep 5
    done
  ) &
fi
# Fetch Gmail notifications over an outbound connection (see bos/README.md).
# The fetcher exits quietly when its settings are absent; otherwise keep it alive.
if [ -n "${GOOGLE_PUBSUB_PULL_SUBSCRIPTION}" ] && [ -n "${GOOGLE_PUBSUB_PULL_KEY}" ]; then
  (
    sleep 60
    while true; do
      node /app/bos-pull.mjs
      code=$?
      # 78 = a setting is wrong; retrying cannot fix it, a redeploy with corrected settings will.
      if [ "$code" -eq 78 ]; then echo "[pull] fetcher is off until its settings are corrected"; break; fi
      echo "[pull] fetcher stopped (exit $code); restarting"
      sleep 15
    done
  ) &
fi
exec /app/docker/scripts/start.sh
