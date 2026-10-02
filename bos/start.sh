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
exec /app/docker/scripts/start.sh
